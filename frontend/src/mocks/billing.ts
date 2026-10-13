"use client";

// The mock billing/payments engine (BILLING_ENGINE §1–§12, PAYMENT_VERIFICATION).
// MOCK-ONLY, but it implements the REAL rules on purpose: the frontend slice must
// surface the contract's error codes, and a mock that always says yes would
// prove nothing. What it does faithfully:
//   · balances are DERIVED from active allocations on every read, never stored
//     by hand (BILLING_ENGINE §1.4) — so an invoice status can never drift from
//     the ledger;
//   · a preview is stateless and issuing recomputes it, so a stale `previewHash`
//     is a real 409 PREVIEW_STALE (ADR-006, §9);
//   · only a confirmed payment may allocate, and allocation is the only thing
//     that moves a balance (§11);
//   · proof verification is advisory and deterministic — it reports findings and
//     never touches a status, an allocation or a receipt (ADR-020/ADR-021).
// What it does NOT do (stated plainly, and raised in the Step 5 handoff):
//   · it never keeps the owner's uploaded bytes — download serves a generated
//     stub of the same kind, so nothing here is a real document reader;
//   · the "extraction" is derived from what the owner recorded plus the academy's
//     own account, which is the only deterministic source a mock has (the real
//     parser is per-bank, OPEN-023);
//   · automatic checks on upload are CR-003 (`SET-08.proofCheck`) and are NOT
//     built: `settings.proofAutoCheck` stays false and the explicit `PRF-04`
//     re-check — always allowed per the contract — is the only path.

import type {
  AcademyPaymentSettings,
  BillingAdjustment,
  BillingPreview,
  BillingPreviewLine,
  BillingPreviewSkipped,
  BillingRun,
  BillingSettings,
  MessageJob,
  Page,
  Payment,
  PaymentMethod,
  ProofDocKind,
  ProofExtract,
  ProofFinding,
  ProofMeta,
  ProofVerification,
  ReceiptSummary,
} from "@/api/types";
import { rollupVerification } from "@/lib/billing";
import { todayISO } from "@/lib/dates";
import { MINOR_MAX } from "@/lib/money";
import {
  getDb,
  MockError,
  OWNER_ID,
  saveDb,
  type Db,
  type PaymentRec,
  type ProofRec,
} from "./db";

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function paginate<T>(rows: T[], page = 1, pageSize = 25): Page<T> {
  const p = Math.max(1, page);
  const size = Math.min(100, Math.max(1, pageSize));
  return {
    data: rows.slice((p - 1) * size, p * size),
    meta: {
      page: p,
      pageSize: size,
      total: rows.length,
      totalPages: Math.max(1, Math.ceil(rows.length / size)),
    },
  };
}

function nowInstant(): string {
  return new Date().toISOString();
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** Contract §15: amountMinor is 1..10_000_000_000, whole rupees when configured. */
function checkAmount(minor: unknown, field: string, opts: { allowNegative?: boolean } = {}): number {
  if (typeof minor !== "number" || !Number.isInteger(minor)) {
    throw new MockError("VALIDATION_ERROR", "Please correct the highlighted fields.", 422, [
      { field, issue: "Send an integer number of minor units" },
    ]);
  }
  if (!opts.allowNegative && (minor <= 0 || minor > MINOR_MAX)) {
    throw new MockError("VALIDATION_ERROR", "Please correct the highlighted fields.", 422, [
      { field, issue: `Amount must be between 1 and ${MINOR_MAX} minor units` },
    ]);
  }
  if (opts.allowNegative && (minor === 0 || Math.abs(minor) > MINOR_MAX)) {
    throw new MockError("VALIDATION_ERROR", "Please correct the highlighted fields.", 422, [
      { field, issue: "Enter a non-zero amount within the allowed range" },
    ]);
  }
  return minor;
}

function requireReason(reason: unknown, field = "reason"): string {
  const text = typeof reason === "string" ? reason.trim() : "";
  if (text.length < 5) {
    throw new MockError("REASON_REQUIRED", "A reason is required.", 422, [
      { field, issue: "Give a reason of at least 5 characters" },
    ]);
  }
  return text;
}

function conflict(): never {
  throw new MockError("VERSION_CONFLICT", "This record was changed by someone else.", 409);
}

function mustGetPayment(db: Db, id: string): PaymentRec {
  const rec = db.payments.find((p) => p.id === id);
  if (!rec) throw new MockError("NOT_FOUND", "Payment not found.", 404);
  return rec;
}

function method(db: Db, code: string): PaymentMethod {
  const found = db.methods.find((m) => m.code === code);
  if (!found || !found.isActive) {
    throw new MockError("VALIDATION_ERROR", "Please correct the highlighted fields.", 422, [
      { field: "methodCode", issue: "Choose an active payment method" },
    ]);
  }
  return found;
}

// ---------------------------------------------------------------------------
// The ledger: invoice balances come from allocations, always
// ---------------------------------------------------------------------------
/**
 * Recompute every invoice's paid/balance/status/isOverdue from the active
 * allocations (BILLING_ENGINE §10/§12). Called at the top of every read and
 * write, which is this mock's stand-in for the deferred constraint trigger the
 * real schema carries.
 */
function refreshInvoices(db: Db): void {
  const today = todayISO();
  const active = db.payments
    .filter((p) => p.status === "confirmed")
    .flatMap((p) => p.allocations)
    .filter((a) => !a.reversedAt);
  for (const inv of db.invoices) {
    if (inv.status === "void") {
      inv.paidMinor = 0;
      inv.balanceMinor = 0;
      inv.isOverdue = false;
      inv.daysOverdue = 0;
      continue;
    }
    const paid = active
      .filter((a) => a.invoice.id === inv.id)
      .reduce((sum, a) => sum + a.amountMinor, 0);
    inv.paidMinor = paid;
    inv.balanceMinor = Math.max(0, inv.totalMinor - paid);
    inv.status = paid === 0 ? "issued" : paid >= inv.totalMinor ? "paid" : "partially_paid";
    inv.isOverdue = inv.balanceMinor > 0 && inv.dueDate < today;
    inv.daysOverdue = inv.isOverdue ? Math.max(1, daysBetween(inv.dueDate, today)) : 0;
  }
}

function readDb(): Db {
  const db = getDb();
  refreshInvoices(db);
  return db;
}

// ---------------------------------------------------------------------------
// Invoices (INV-01..08)
// ---------------------------------------------------------------------------
export interface InvoiceQuery {
  status?: string;
  overdue?: boolean;
  playerId?: string;
  guardianId?: string;
  ageGroupId?: string;
  issueFrom?: string;
  issueTo?: string;
  dueFrom?: string;
  dueTo?: string;
  q?: string;
  page?: number;
  pageSize?: number;
  sort?: string;
}

const INVOICE_SORTS = new Set([
  "dueDate",
  "issueDate",
  "invoiceNumber",
  "balanceMinor",
  "playerName",
]);

export function listInvoices(params: InvoiceQuery): Page<import("@/api/types").Invoice> {
  const db = readDb();
  if (params.status && !["issued", "partially_paid", "paid", "void"].includes(params.status)) {
    throw new MockError("VALIDATION_ERROR", "Unknown status filter.", 422, [
      { field: "status", issue: "Use issued, partially_paid, paid or void" },
    ]);
  }
  let rows = [...db.invoices];
  if (params.status) rows = rows.filter((i) => i.status === params.status);
  if (params.overdue) rows = rows.filter((i) => i.isOverdue);
  if (params.playerId) rows = rows.filter((i) => i.player.id === params.playerId);
  if (params.guardianId) rows = rows.filter((i) => i.guardian?.id === params.guardianId);
  if (params.ageGroupId) rows = rows.filter((i) => i.ageGroup.id === params.ageGroupId);
  if (params.issueFrom) rows = rows.filter((i) => i.issueDate >= params.issueFrom!);
  if (params.issueTo) rows = rows.filter((i) => i.issueDate <= params.issueTo!);
  if (params.dueFrom) rows = rows.filter((i) => i.dueDate >= params.dueFrom!);
  if (params.dueTo) rows = rows.filter((i) => i.dueDate <= params.dueTo!);
  const q = params.q?.trim().toLowerCase();
  if (q && q.length >= 2) {
    rows = rows.filter(
      (i) =>
        i.invoiceNumber.toLowerCase().includes(q) ||
        i.player.fullName.toLowerCase().includes(q) ||
        i.player.registrationNo.toLowerCase().includes(q)
    );
  }

  const sort = params.sort && INVOICE_SORTS.has(params.sort.replace(/^-/, "")) ? params.sort : "dueDate";
  const dir = sort.startsWith("-") ? -1 : 1;
  const key = sort.replace(/^-/, "");
  rows.sort((a, b) => {
    const pick = (i: typeof a): string | number => {
      if (key === "playerName") return i.player.fullName;
      if (key === "balanceMinor") return i.balanceMinor;
      return i[key as "dueDate" | "issueDate" | "invoiceNumber"];
    };
    const av = pick(a);
    const bv = pick(b);
    const cmp = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));
    return cmp * dir || a.id.localeCompare(b.id);
  });

  return paginate(rows, params.page, params.pageSize);
}

export function getInvoiceFull(id: string): import("@/api/types").Invoice | undefined {
  const db = readDb();
  const inv = db.invoices.find((i) => i.id === id);
  if (!inv) return undefined;
  return {
    ...inv,
    items: db.invoiceItems
      .filter((row) => row.invoiceId === id)
      .map((row) => row.item)
      .sort((a, b) => a.lineNo - b.lineNo),
    // Reversed allocations stay visible (flagged) — corruption of history is
    // worse than a longer list (BILLING_ENGINE §11).
    allocations: db.payments.flatMap((p) => p.allocations).filter((a) => a.invoice.id === id),
  };
}

export function createManualInvoice(input: {
  playerId: string;
  description: string;
  amountMinor: number;
  dueDate: string;
  guardianId?: string;
}): import("@/api/types").Invoice {
  const db = readDb();
  const player = db.players.find((p) => p.id === input.playerId);
  if (!player) throw new MockError("NOT_FOUND", "Player not found.", 404);
  const description = (input.description ?? "").trim();
  if (description.length < 3 || description.length > 120) {
    throw new MockError("VALIDATION_ERROR", "Please correct the highlighted fields.", 422, [
      { field: "description", issue: "Use 3 to 120 characters" },
    ]);
  }
  checkAmount(input.amountMinor, "amountMinor");
  if (db.settings.allowFractionalMoney === false && input.amountMinor % 100 !== 0) {
    throw new MockError("VALIDATION_ERROR", "Please correct the highlighted fields.", 422, [
      { field: "amountMinor", issue: "This academy records whole rupees only" },
    ]);
  }
  const issueDate = todayISO();
  if (!input.dueDate || input.dueDate < issueDate) {
    throw new MockError("VALIDATION_ERROR", "Please correct the highlighted fields.", 422, [
      { field: "dueDate", issue: "The due date cannot be before the issue date" },
    ]);
  }
  const guardianId = input.guardianId ?? player.guardians.find((g) => g.isPrimary)?.guardian.id;
  const guardian = db.guardians.find((g) => g.id === guardianId);
  db.counters.invoice += 1;
  const invoiceNumber = `INV-${issueDate.slice(0, 4)}-${String(db.counters.invoice).padStart(6, "0")}`;
  const invoice = {
    id: `0192a000-0000-7000-8000-man${String(db.counters.invoice).padStart(9, "0")}`,
    invoiceNumber,
    kind: "manual" as const,
    status: "issued" as const,
    isOverdue: false,
    daysOverdue: 0,
    player: { id: player.id, fullName: player.fullName, registrationNo: player.registrationNo },
    guardian: guardian ? { id: guardian.id, fullName: guardian.fullName } : undefined,
    ageGroup: player.currentGroup
      ? { id: player.currentGroup.id, name: player.currentGroup.name }
      : { id: "none", name: "No group" },
    periodStart: undefined,
    periodEnd: undefined,
    issueDate,
    dueDate: input.dueDate,
    currency: "LKR" as const,
    subtotalMinor: input.amountMinor,
    adjustmentsMinor: 0,
    totalMinor: input.amountMinor,
    paidMinor: 0,
    balanceMinor: input.amountMinor,
    hasPdf: true,
    version: 1,
  };
  db.invoices.push(invoice);
  db.invoiceItems.push({
    invoiceId: invoice.id,
    item: {
      id: `${invoice.id}-item1`,
      lineNo: 1,
      itemType: "manual" in invoice ? ("fee" as const) : ("fee" as const),
      description,
      quantity: 1,
      unitAmountMinor: input.amountMinor,
      amountMinor: input.amountMinor,
    },
  });
  saveDb();
  return getInvoiceFull(invoice.id)!;
}

export function voidInvoice(
  id: string,
  input: { reason: string; releaseAllocations?: boolean; allowReissue?: boolean; version: number }
): import("@/api/types").Invoice {
  const db = readDb();
  const inv = db.invoices.find((i) => i.id === id);
  if (!inv) throw new MockError("NOT_FOUND", "Invoice not found.", 404);
  if (inv.version !== input.version) conflict();
  if (inv.status === "void") {
    throw new MockError("INVALID_STATE_TRANSITION", "This invoice is already void.", 409);
  }
  const reason = requireReason(input.reason, "reason");
  const activeAllocations = db.payments
    .flatMap((p) => p.allocations)
    .filter((a) => a.invoice.id === id && !a.reversedAt);
  if (activeAllocations.length > 0 && !input.releaseAllocations) {
    throw new MockError(
      "INVOICE_HAS_ALLOCATIONS",
      "This invoice has payments allocated to it. Release them to credit first.",
      409,
      [{ field: "releaseAllocations", issue: "Tick \"Release payments to credit\"" }]
    );
  }
  const releasedAt = nowInstant();
  if (input.releaseAllocations) {
    for (const a of activeAllocations) a.reversedAt = releasedAt;
  }
  inv.status = "void";
  inv.voidedAt = releasedAt;
  inv.voidReason = reason;
  inv.version += 1;
  if (input.allowReissue !== true) {
    // Default is to suppress: the daily run must not recreate what an owner
    // deliberately cancelled (BILLING_ENGINE §10).
    if (inv.periodStart && inv.periodEnd) {
      db.suppressedReissue.push({
        playerId: inv.player.id,
        periodStart: inv.periodStart,
        periodEnd: inv.periodEnd,
      });
    }
  }
  // Queued messages for a void invoice are cancelled (side-effect summary §4).
  for (const job of db.messages) {
    if (job.invoice.id === id && (job.status === "queued" || job.status === "failed")) {
      job.status = "cancelled";
      job.skipReason = "INVOICE_VOID";
    }
  }
  refreshInvoices(db);
  saveDb();
  return getInvoiceFull(id)!;
}

export function addAdjustment(
  id: string,
  input: { amountMinor: number; reason: string; version: number }
): import("@/api/types").Invoice {
  const db = readDb();
  const inv = db.invoices.find((i) => i.id === id);
  if (!inv) throw new MockError("NOT_FOUND", "Invoice not found.", 404);
  if (inv.version !== input.version) conflict();
  if (inv.status === "void") {
    throw new MockError("INVALID_STATE_TRANSITION", "A void invoice cannot be adjusted.", 409);
  }
  checkAmount(input.amountMinor, "amountMinor", { allowNegative: true });
  if (input.amountMinor > 0) {
    // Increasing an issued invoice is not allowed — void and reissue instead.
    throw new MockError("VALIDATION_ERROR", "Please correct the highlighted fields.", 422, [
      { field: "amountMinor", issue: "Adjustments reduce the total — void and reissue to increase it" },
    ]);
  }
  const reason = requireReason(input.reason, "reason");
  if (reason.length > 200) {
    throw new MockError("VALIDATION_ERROR", "Please correct the highlighted fields.", 422, [
      { field: "reason", issue: "Keep the reason under 200 characters" },
    ]);
  }
  if (Math.abs(input.amountMinor) > inv.balanceMinor) {
    throw new MockError("VALIDATION_ERROR", "Please correct the highlighted fields.", 422, [
      {
        field: "amountMinor",
        issue: "The discount cannot be more than the remaining balance",
        meta: { balanceMinor: inv.balanceMinor },
      },
    ]);
  }
  const items = db.invoiceItems.filter((row) => row.invoiceId === id);
  inv.adjustmentsMinor += input.amountMinor;
  inv.totalMinor = inv.subtotalMinor + inv.adjustmentsMinor;
  inv.version += 1;
  inv.hasPdf = false; // "PDF regenerated with an Adjusted line"
  items.push({
    invoiceId: id,
    item: {
      id: `${id}-adj${items.length}`,
      lineNo: items.length + 1,
      itemType: "adjustment",
      description: `Adjustment — ${reason}`,
      quantity: 1,
      unitAmountMinor: input.amountMinor,
      amountMinor: input.amountMinor,
      reason,
    },
  });
  refreshInvoices(db);
  saveDb();
  return getInvoiceFull(id)!;
}

// ---------------------------------------------------------------------------
// PDFs (generated stubs — the mock never has the real renderer)
// ---------------------------------------------------------------------------
const escapePdfText = (text: string) => text.replace(/[\\()]/g, "");

/**
 * A small but genuinely valid one-page PDF (correct xref offsets), so the file
 * the owner opens is a real PDF rather than a broken stub. ASCII only, so byte
 * offsets equal string lengths.
 */
function buildPdf(title: string, lines: string[]): Blob {
  const body = [title, ...lines].map((line) => line.trim());
  const text = body
    .slice(0, 34)
    .map((line, i) => `${i === 0 ? "" : "T* "}(${escapePdfText(line)}) Tj`)
    .join(" ");
  const stream = `BT /F1 11 Tf 15 TL 40 800 Td ${text} ET`;
  const objects: string[] = [];
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = "<< /Type /Pages /Kids [3 0 R] /Count 1 >>";
  objects[3] =
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>";
  objects[4] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  objects[5] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let i = 1; i <= 5; i += 1) {
    offsets[i] = out.length;
    out += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = out.length;
  out += "xref\n0 6\n0000000000 65535 f \n";
  for (let i = 1; i <= 5; i += 1) {
    out += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  out += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Blob([out], { type: "application/pdf" });
}

/** A readable placeholder for a proof photo (the mock keeps no real bytes). */
function buildImageStub(label: string): Blob {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="640" viewBox="0 0 480 640">
  <rect width="480" height="640" fill="#f8fafc" stroke="#cbd5e1"/>
  <text x="24" y="60" font-family="Helvetica, Arial" font-size="18" fill="#0f172a">${escapePdfText(label)}</text>
  <text x="24" y="92" font-family="Helvetica, Arial" font-size="13" fill="#475569">Mock placeholder — the original file is not stored.</text>
</svg>`;
  return new Blob([svg], { type: "image/svg+xml" });
}

export function invoicePdf(
  id: string
): { blob: Blob; filename: string } | "not_ready" {
  const db = readDb();
  const inv = db.invoices.find((i) => i.id === id);
  if (!inv) throw new MockError("NOT_FOUND", "Invoice not found.", 404);
  if (!inv.hasPdf) return "not_ready";
  const active = db.payments.flatMap((p) => p.allocations).filter((a) => a.invoice.id === id && !a.reversedAt);
  const money = (minor: number) => `LKR ${(minor / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
  const lines = [
    db.settings.academyName,
    `Invoice ${inv.invoiceNumber}`,
    `Player: ${inv.player.fullName} (${inv.player.registrationNo})`,
    `Group: ${inv.ageGroup.name}`,
    inv.periodStart ? `Period: ${inv.periodStart} to ${inv.periodEnd}` : "One-off invoice",
    `Issued: ${inv.issueDate}   Due: ${inv.dueDate}`,
    `Subtotal: ${money(inv.subtotalMinor)}`,
    inv.adjustmentsMinor !== 0 ? `Adjusted: ${money(inv.adjustmentsMinor)}` : "",
    `Total: ${money(inv.totalMinor)}`,
    `Paid: ${money(inv.paidMinor)}   Balance: ${money(inv.balanceMinor)}`,
    active.length > 0 ? `Payments applied: ${active.length}` : "",
    inv.status === "void" ? `VOID — ${inv.voidReason ?? ""}` : "",
    "",
    "Payment instructions",
    db.settings.paymentInstructions,
  ].filter((line) => line !== "");
  return { blob: buildPdf(`Invoice ${inv.invoiceNumber}`, lines), filename: `${inv.invoiceNumber}.pdf` };
}

export function regenerateInvoicePdf(id: string): void {
  const db = readDb();
  const inv = db.invoices.find((i) => i.id === id);
  if (!inv) throw new MockError("NOT_FOUND", "Invoice not found.", 404);
  inv.hasPdf = true; // rebuilt from the snapshot only
  saveDb();
}

// ---------------------------------------------------------------------------
// Messaging side-effect of INV-08 (the WhatsApp slice is Step 6)
// ---------------------------------------------------------------------------
function maskedPhone(db: Db, guardianId: string): string {
  const g = db.guardians.find((x) => x.id === guardianId);
  if (!g) return "•••";
  return `${g.phone.slice(0, 5)}****${g.phone.slice(-3)}`;
}

function messageFor(
  db: Db,
  inv: import("@/api/types").Invoice,
  guardianId: string,
  kind: MessageJob["kind"],
  skipReason?: string
): MessageJob {
  db.counters.message += 1;
  const guardian = db.guardians.find((g) => g.id === guardianId);
  const at = nowInstant();
  return {
    id: `0192a000-0000-7000-8000-msg${String(db.counters.message).padStart(9, "0")}`,
    kind,
    status: skipReason ? "skipped" : "queued",
    skipReason,
    deliveryState: "unknown",
    invoice: { id: inv.id, invoiceNumber: inv.invoiceNumber },
    player: { id: inv.player.id, fullName: inv.player.fullName },
    guardian: {
      id: guardianId,
      fullName: guardian?.fullName ?? "Guardian",
      phoneMasked: maskedPhone(db, guardianId),
    },
    scheduledFor: at,
    attempts: 0,
    maxAttempts: 5,
    events: [{ eventType: "queued", at }],
  };
}

/**
 * INV-08. Nothing is sent while the provider session is not connected, and a
 * revoked consent is never overridden — both cases come back as `skipped` jobs
 * with a reason rather than a pretend success (OPENWA_INTEGRATION §11).
 */
export function sendInvoice(id: string, input: { guardianIds?: string[] }): { messageJobs: MessageJob[] } {
  const db = readDb();
  const inv = db.invoices.find((i) => i.id === id);
  if (!inv) throw new MockError("NOT_FOUND", "Invoice not found.", 404);
  if (inv.status === "void") {
    throw new MockError("INVOICE_VOID", "A void invoice cannot be sent.", 409);
  }
  const candidates = input.guardianIds?.length
    ? input.guardianIds
    : db.players.find((p) => p.id === inv.player.id)?.guardians
        .filter((link) => link.receivesInvoices)
        .map((link) => link.guardian.id) ?? [];
  if (candidates.length === 0) {
    throw new MockError("VALIDATION_ERROR", "Please correct the highlighted fields.", 422, [
      { field: "guardianIds", issue: "Choose at least one guardian to send to" },
    ]);
  }
  const jobs = candidates.map((guardianId) => {
    const consent = db.guardians.find((g) => g.id === guardianId)?.whatsappConsent;
    const skipReason =
      consent === "revoked"
        ? "NO_CONSENT"
        : db.settings.whatsappSession !== "connected"
          ? "SESSION_NOT_CONNECTED"
          : undefined;
    return messageFor(db, inv, guardianId, "invoice_delivery", skipReason);
  });
  db.messages.push(...jobs);
  saveDb();
  return { messageJobs: jobs };
}

// ---------------------------------------------------------------------------
// Billing preview and runs (BIL-01..03, BILLING_ENGINE §3–§6/§9)
// ---------------------------------------------------------------------------
interface Period {
  start: string;
  end: string;
}

function lastDayOfMonth(dateISO: string): string {
  const [y, m] = dateISO.split("-").map(Number);
  const end = new Date(Date.UTC(y, m, 0));
  return end.toISOString().slice(0, 10);
}

function periodContaining(db: Db, targetDate: string, registrationDate?: string): Period {
  const s = db.settings;
  if (s.billingFrequency === "weekly") {
    const [y, m, d] = targetDate.split("-").map(Number);
    const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay() || 7; // 1=Mon..7=Sun
    const shift = (weekday - s.weekStartDay + 7) % 7;
    const start = new Date(Date.UTC(y, m - 1, d - shift)).toISOString().slice(0, 10);
    const end = new Date(Date.parse(`${start}T00:00:00Z`) + 6 * 86_400_000).toISOString().slice(0, 10);
    return { start, end };
  }
  if (s.billingPeriodMode === "anchored" && registrationDate) {
    // Anchored periods are computed from the anchor, never from the previous
    // period (BILLING_ENGINE §3), so a clamp never compounds.
    const [ay, am, ad] = registrationDate.split("-").map(Number);
    const [ty, tm] = targetDate.split("-").map(Number);
    const monthsApart = (ty - ay) * 12 + (tm - am) - (targetDate < registrationDate ? 1 : 0);
    const total = ay * 12 + (am - 1) + Math.max(0, monthsApart);
    const y = Math.floor(total / 12);
    const m = (total % 12) + 1;
    const day = Math.min(ad, Number(lastDayOfMonth(`${y}-${String(m).padStart(2, "0")}-01`).slice(8)));
    const start = `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const nextTotal = total + 1;
    const ny = Math.floor(nextTotal / 12);
    const nm = (nextTotal % 12) + 1;
    const end = new Date(Date.parse(`${ny}-${String(nm).padStart(2, "0")}-01T00:00:00Z`) - 86_400_000)
      .toISOString()
      .slice(0, 10);
    return { start, end };
  }
  const start = `${targetDate.slice(0, 7)}-01`;
  return { start, end: lastDayOfMonth(start) };
}

function dueDateFor(db: Db, period: Period, issueDate: string): string {
  const s = db.settings;
  let due = issueDate;
  if (s.dueRuleType === "days_after_issue") {
    due = new Date(Date.parse(`${issueDate}T00:00:00Z`) + s.dueRuleValue * 86_400_000).toISOString().slice(0, 10);
  } else if (s.dueRuleType === "days_after_period_start") {
    due = new Date(Date.parse(`${period.start}T00:00:00Z`) + s.dueRuleValue * 86_400_000).toISOString().slice(0, 10);
  } else {
    const day = Math.min(28, Math.max(1, s.dueRuleValue));
    due = `${period.start.slice(0, 7)}-${String(day).padStart(2, "0")}`;
  }
  return due < issueDate ? issueDate : due;
}

function hashPreview(input: {
  targetDate: string;
  lines: BillingPreviewLine[];
  skipped: BillingPreviewSkipped[];
}): string {
  // Deterministic FNV-1a over a canonical string: the same state must produce
  // the same hash, and any change to what would be created must change it.
  const canonical = [
    input.targetDate,
    ...input.lines
      .map((l) => `${l.playerId}:${l.feeId}:${l.feeMinor}:${l.periodStart}:${l.periodEnd}:${l.dueDate}`)
      .sort(),
    ...input.skipped.map((s) => `${s.playerId}:${s.reason}`).sort(),
  ].join("|");
  let hash = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i += 1) {
    hash ^= canonical.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `sha256:mock-${hash.toString(16).padStart(8, "0")}`;
}

export function buildPreview(input: {
  targetDate: string;
  ageGroupIds?: string[];
  playerIds?: string[];
}): BillingPreview {
  const db = readDb();
  const target = input.targetDate || todayISO();
  const lines: BillingPreviewLine[] = [];
  const skipped: BillingPreviewSkipped[] = [];

  for (const player of db.players) {
    if (input.playerIds?.length && !input.playerIds.includes(player.id)) continue;
    const period = periodContaining(db, target, player.registrationDate);
    const reference = period.start > player.registrationDate ? period.start : player.registrationDate;

    if (player.registrationDate > period.end) {
      skipped.push({ playerId: player.id, playerName: player.fullName, reason: "NOT_YET_REGISTERED" });
      continue;
    }
    if (player.status !== "active" && player.statusEffectiveDate <= period.start) {
      skipped.push({ playerId: player.id, playerName: player.fullName, reason: "NOT_ACTIVE" });
      continue;
    }
    const history = db.history.find(
      (h) =>
        h.playerId === player.id &&
        h.effectiveFrom <= reference &&
        (!h.effectiveTo || h.effectiveTo >= reference)
    );
    if (!history) {
      skipped.push({ playerId: player.id, playerName: player.fullName, reason: "NO_GROUP" });
      continue;
    }
    if (input.ageGroupIds?.length && !input.ageGroupIds.includes(history.ageGroup.id)) continue;

    const fee = db.fees
      .filter((f) => f.ageGroupId === history.ageGroup.id && f.effectiveFrom <= reference)
      .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0];
    if (!fee) {
      skipped.push({ playerId: player.id, playerName: player.fullName, reason: "NO_FEE" });
      continue;
    }
    const already =
      db.invoices.some(
        (i) =>
          i.player.id === player.id &&
          i.periodStart === period.start &&
          i.periodEnd === period.end &&
          i.status !== "void"
      ) ||
      db.suppressedReissue.some(
        (s) =>
          s.playerId === player.id && s.periodStart === period.start && s.periodEnd === period.end
      );
    if (already) {
      skipped.push({ playerId: player.id, playerName: player.fullName, reason: "ALREADY_INVOICED" });
      continue;
    }

    const warnings: string[] = [];
    if (db.settings.billingPeriodMode === "calendar" && player.registrationDate > period.start) {
      warnings.push(
        `Joined ${player.registrationDate}, after the period started — the full fee applies unless you add an adjustment.`
      );
    }
    if (player.status !== "active") {
      warnings.push(`Status is ${player.status} — check before issuing.`);
    }
    const primary = player.guardians.find((g) => g.isPrimary)?.guardian;
    lines.push({
      playerId: player.id,
      playerName: player.fullName,
      registrationNo: player.registrationNo,
      ageGroup: { id: history.ageGroup.id, name: history.ageGroup.name },
      periodStart: period.start,
      periodEnd: period.end,
      issueDate: target,
      dueDate: dueDateFor(db, period, target),
      feeMinor: fee.amountMinor,
      feeId: fee.id,
      guardian: primary ? { id: primary.id, fullName: primary.fullName } : undefined,
      warnings,
    });
  }

  lines.sort((a, b) => a.playerName.localeCompare(b.playerName));
  const totalMinor = lines.reduce((sum, l) => sum + l.feeMinor, 0);
  return {
    previewHash: hashPreview({ targetDate: target, lines, skipped }),
    targetDate: target,
    frequency: db.settings.billingFrequency,
    mode: db.settings.billingPeriodMode,
    lines,
    skipped,
    totals: { count: lines.length, totalMinor },
  };
}

export function createRun(input: {
  targetDate: string;
  previewHash: string;
  ageGroupIds?: string[];
  playerIds?: string[];
  adjustments?: BillingAdjustment[];
  queueWhatsApp?: boolean;
  runKey: string;
}): BillingRun {
  const db = readDb();
  const fresh = buildPreview({
    targetDate: input.targetDate,
    ageGroupIds: input.ageGroupIds,
    playerIds: input.playerIds,
  });
  // Recomputed server-side: the hash is what stops a stale preview from issuing
  // invoices against data that has moved on (BILLING_ENGINE §9).
  if (fresh.previewHash !== input.previewHash) {
    throw new MockError(
      "PREVIEW_STALE",
      "The data changed since this preview was taken. It has been refreshed — check it and try again.",
      409
    );
  }
  const adjustments = input.adjustments ?? [];
  for (const adj of adjustments) {
    checkAmount(adj.amountMinor, `adjustments.${adj.playerId}.amountMinor`, { allowNegative: true });
    if (adj.amountMinor > 0) {
      throw new MockError("VALIDATION_ERROR", "Please correct the highlighted fields.", 422, [
        { field: `adjustments.${adj.playerId}.amountMinor`, issue: "An adjustment must reduce the fee" },
      ]);
    }
    const line = fresh.lines.find((l) => l.playerId === adj.playerId);
    if (!line) {
      throw new MockError("VALIDATION_ERROR", "Please correct the highlighted fields.", 422, [
        { field: `adjustments.${adj.playerId}.amountMinor`, issue: "That player is not in this preview" },
      ]);
    }
    if (Math.abs(adj.amountMinor) > line.feeMinor) {
      throw new MockError("VALIDATION_ERROR", "Please correct the highlighted fields.", 422, [
        { field: `adjustments.${adj.playerId}.amountMinor`, issue: "The adjustment cannot exceed the fee" },
      ]);
    }
    requireReason(adj.reason, `adjustments.${adj.playerId}.reason`);
  }

  const startedAt = nowInstant();
  const invoiceIds: string[] = [];
  for (const line of fresh.lines) {
    db.counters.invoice += 1;
    const invoiceNumber = `INV-${line.issueDate.slice(0, 4)}-${String(db.counters.invoice).padStart(6, "0")}`;
    const id = `0192a000-0000-7000-8000-inv${String(db.counters.invoice).padStart(9, "0")}`;
    const adjustment = adjustments.find((a) => a.playerId === line.playerId);
    const total = line.feeMinor + (adjustment?.amountMinor ?? 0);
    db.invoices.push({
      id,
      invoiceNumber,
      kind: "periodic",
      status: "issued",
      isOverdue: false,
      daysOverdue: 0,
      player: { id: line.playerId, fullName: line.playerName, registrationNo: line.registrationNo },
      guardian: line.guardian,
      ageGroup: line.ageGroup,
      periodStart: line.periodStart,
      periodEnd: line.periodEnd,
      issueDate: line.issueDate,
      dueDate: line.dueDate,
      currency: "LKR",
      subtotalMinor: line.feeMinor,
      adjustmentsMinor: adjustment?.amountMinor ?? 0,
      totalMinor: total,
      paidMinor: 0,
      balanceMinor: total,
      hasPdf: true,
      version: 1,
    });
    db.invoiceItems.push({
      invoiceId: id,
      item: {
        id: `${id}-item1`,
        lineNo: 1,
        itemType: "fee",
        description: `${fresh.frequency === "monthly" ? "Monthly" : "Weekly"} fee – ${line.ageGroup.name} (${line.periodStart} to ${line.periodEnd})`,
        quantity: 1,
        unitAmountMinor: line.feeMinor,
        amountMinor: line.feeMinor,
      },
    });
    if (adjustment) {
      db.invoiceItems.push({
        invoiceId: id,
        item: {
          id: `${id}-item2`,
          lineNo: 2,
          itemType: "adjustment",
          description: `Adjustment — ${adjustment.reason.trim()}`,
          quantity: 1,
          unitAmountMinor: adjustment.amountMinor,
          amountMinor: adjustment.amountMinor,
          reason: adjustment.reason.trim(),
        },
      });
    }
    invoiceIds.push(id);
  }

  if (input.queueWhatsApp) {
    for (const line of fresh.lines) {
      const inv = db.invoices.find((i) => i.id === invoiceIds[fresh.lines.indexOf(line)]);
      if (!inv || !line.guardian) continue;
      const consent = db.guardians.find((g) => g.id === line.guardian!.id)?.whatsappConsent;
      const skipReason =
        db.settings.whatsappSession !== "connected"
          ? "SESSION_NOT_CONNECTED"
          : consent === "revoked"
            ? "NO_CONSENT"
            : undefined;
      db.messages.push(messageFor(db, inv, line.guardian.id, "invoice_delivery", skipReason));
    }
  }

  db.counters.run += 1;
  const run: BillingRun = {
    id: `0192a000-0000-7000-8000-run${String(db.counters.run).padStart(9, "0")}`,
    runKey: input.runKey,
    status: invoiceIds.length === 0 ? "failed" : fresh.skipped.length > 0 ? "partial" : "issued",
    targetDate: fresh.targetDate,
    invoicesCreated: invoiceIds.length,
    invoicesSkipped: fresh.skipped.length,
    invoiceIds,
    startedAt,
    completedAt: nowInstant(),
  };
  db.billingRuns.push(run);
  saveDb();
  return run;
}

export function listRuns(params: { page?: number; pageSize?: number }): Page<BillingRun> {
  const db = readDb();
  const rows = [...db.billingRuns].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return paginate(rows, params.page, params.pageSize);
}

export function getRun(id: string): BillingRun | undefined {
  return readDb().billingRuns.find((r) => r.id === id);
}

// ---------------------------------------------------------------------------
// Payments (PAY-01..08)
// ---------------------------------------------------------------------------
function paymentView(db: Db, rec: PaymentRec): Payment {
  const active = rec.allocations.filter((a) => !a.reversedAt);
  const allocated = active.reduce((sum, a) => sum + a.amountMinor, 0);
  const proofs: ProofMeta[] = rec.proofs.map((p) => ({
    fileId: p.fileId,
    originalName: p.originalName,
    mimeType: p.mimeType,
    sizeBytes: p.sizeBytes,
    uploadedAt: p.uploadedAt,
    uploadedBy: { id: p.uploadedById, fullName: p.uploadedByName },
    docKind: p.docKind,
    verification: p.verification,
  }));
  const receipt = rec.receipts.find((r) => !r.voided) ?? rec.receipts[0];
  return {
    id: rec.id,
    amountMinor: rec.amountMinor,
    currency: "LKR",
    method: db.methods.find((m) => m.code === rec.methodCode) ?? {
      code: rec.methodCode,
      label: rec.methodCode,
      requiresReference: false,
      isActive: false,
    },
    reference: rec.reference,
    receivedAt: rec.receivedAt,
    payer: rec.payerGuardianId || rec.payerName
      ? { guardianId: rec.payerGuardianId, name: rec.payerName ?? "Guardian" }
      : undefined,
    status: rec.status,
    allocatedMinor: allocated,
    unallocatedMinor: rec.status === "confirmed" ? rec.amountMinor - allocated : 0,
    allocations: rec.allocations,
    proofs,
    receipt: receipt ? { id: receipt.id, receiptNumber: receipt.receiptNumber } : undefined,
    notes: rec.notes,
    rejectReason: rec.rejectReason,
    reverseReason: rec.reverseReason,
    proofVerification: rollupVerification(proofs),
    version: rec.version,
  };
}

export interface PaymentQuery {
  status?: string;
  methodCode?: string;
  guardianId?: string;
  playerId?: string;
  from?: string;
  to?: string;
  q?: string;
  hasCredit?: boolean;
  page?: number;
  pageSize?: number;
  sort?: string;
}

export function listPayments(params: PaymentQuery): Page<Payment> {
  const db = readDb();
  let rows = [...db.payments];
  if (params.status) {
    if (!["pending", "confirmed", "rejected", "reversed"].includes(params.status)) {
      throw new MockError("VALIDATION_ERROR", "Unknown status filter.", 422, [
        { field: "status", issue: "Use pending, confirmed, rejected or reversed" },
      ]);
    }
    rows = rows.filter((p) => p.status === params.status);
  }
  if (params.methodCode) rows = rows.filter((p) => p.methodCode === params.methodCode);
  if (params.guardianId) rows = rows.filter((p) => p.payerGuardianId === params.guardianId);
  if (params.playerId) {
    rows = rows.filter((p) => p.allocations.some((a) => a.invoice.id && playerOfInvoice(db, a.invoice.id) === params.playerId));
  }
  if (params.from) rows = rows.filter((p) => p.receivedAt.slice(0, 10) >= params.from!);
  if (params.to) rows = rows.filter((p) => p.receivedAt.slice(0, 10) <= params.to!);
  const q = params.q?.trim().toLowerCase();
  if (q && q.length >= 2) {
    rows = rows.filter(
      (p) =>
        (p.payerName ?? "").toLowerCase().includes(q) ||
        (p.reference ?? "").toLowerCase().includes(q)
    );
  }
  if (params.hasCredit) {
    rows = rows.filter((p) => {
      const allocated = p.allocations.filter((a) => !a.reversedAt).reduce((s, a) => s + a.amountMinor, 0);
      return p.status === "confirmed" && p.amountMinor - allocated > 0;
    });
  }
  const sort = params.sort?.replace(/^-/, "") === "amountMinor" ? "-amountMinor" : "-receivedAt";
  const dir = sort.startsWith("-") ? -1 : 1;
  const key = sort.replace(/^-/, "");
  rows.sort((a, b) => {
    const av = key === "amountMinor" ? a.amountMinor : a.receivedAt;
    const bv = key === "amountMinor" ? b.amountMinor : b.receivedAt;
    const cmp = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));
    return cmp * dir || a.id.localeCompare(b.id);
  });
  return paginate(rows.map((r) => paymentView(db, r)), params.page, params.pageSize);
}

function playerOfInvoice(db: Db, invoiceId: string): string | undefined {
  return db.invoices.find((i) => i.id === invoiceId)?.player.id;
}

export function getPaymentView(id: string): Payment | undefined {
  const db = readDb();
  const rec = db.payments.find((p) => p.id === id);
  return rec ? paymentView(db, rec) : undefined;
}

/** Apply allocation lines, enforcing every rule in BILLING_ENGINE §11. */
function applyAllocations(
  db: Db,
  rec: PaymentRec,
  lines: { invoiceId: string; amountMinor: number }[]
): void {
  const activeAllocated = rec.allocations
    .filter((a) => !a.reversedAt)
    .reduce((sum, a) => sum + a.amountMinor, 0);
  const remaining = rec.amountMinor - activeAllocated;
  let sum = 0;
  lines.forEach((line, index) => {
    const field = `allocations.${index}.amountMinor`;
    const inv = db.invoices.find((i) => i.id === line.invoiceId);
    if (!inv) throw new MockError("NOT_FOUND", "Invoice not found.", 404);
    if (inv.status === "void") {
      throw new MockError("INVOICE_VOID", "A void invoice cannot receive a payment.", 409, [
        { field, issue: "This invoice is void" },
      ]);
    }
    checkAmount(line.amountMinor, field);
    if (line.amountMinor > inv.balanceMinor) {
      throw new MockError("ALLOCATION_EXCEEDS_BALANCE", "The amount is more than the invoice balance.", 409, [
        { field, issue: `max ${inv.balanceMinor}`, meta: { balanceMinor: inv.balanceMinor } },
      ]);
    }
    sum += line.amountMinor;
  });
  if (sum > remaining) {
    throw new MockError("ALLOCATION_EXCEEDS_PAYMENT", "The allocations are more than the payment amount.", 409, [
      {
        field: "allocations",
        issue: `Available to allocate: ${remaining}`,
        meta: { unallocatedMinor: remaining },
      },
    ]);
  }
  const allocatedAt = nowInstant();
  for (const line of lines) {
    rec.allocations.push({
      id: `al-${rec.id}-${line.invoiceId}-${rec.allocations.length + 1}`,
      paymentId: rec.id,
      invoice: {
        id: line.invoiceId,
        invoiceNumber: db.invoices.find((i) => i.id === line.invoiceId)!.invoiceNumber,
      },
      amountMinor: line.amountMinor,
      allocatedAt,
    });
  }
}

function issueReceipt(db: Db, rec: PaymentRec, alreadyPaid = false): void {
  if (alreadyPaid) return;
  db.counters.receipt += 1;
  rec.receipts.push({
    id: `0192a000-0000-7000-8000-rct${String(db.counters.receipt).padStart(9, "0")}`,
    receiptNumber: `RCT-${todayISO().slice(0, 4)}-${String(db.counters.receipt).padStart(6, "0")}`,
    issuedAt: nowInstant(),
    voided: false,
  });
}

export function createPayment(input: {
  amountMinor: number;
  methodCode: string;
  reference?: string;
  receivedAt: string;
  payerGuardianId?: string;
  payerName?: string;
  notes?: string;
  status: "confirmed" | "pending";
  allocations?: { invoiceId: string; amountMinor: number }[];
}): Payment {
  const db = readDb();
  const m = method(db, input.methodCode);
  checkAmount(input.amountMinor, "amountMinor");
  if (!db.settings.allowFractionalMoney && input.amountMinor % 100 !== 0) {
    throw new MockError("VALIDATION_ERROR", "Please correct the highlighted fields.", 422, [
      { field: "amountMinor", issue: "This academy records whole rupees only" },
    ]);
  }
  if (!input.receivedAt || Number.isNaN(Date.parse(input.receivedAt))) {
    throw new MockError("VALIDATION_ERROR", "Please correct the highlighted fields.", 422, [
      { field: "receivedAt", issue: "Send an instant, e.g. 2026-11-06T04:00:00Z" },
    ]);
  }
  if (Date.parse(input.receivedAt) > Date.now() + 86_400_000) {
    throw new MockError("VALIDATION_ERROR", "Please correct the highlighted fields.", 422, [
      { field: "receivedAt", issue: "The date received cannot be in the future" },
    ]);
  }
  const reference = input.reference?.trim();
  if (m.requiresReference && !reference) {
    throw new MockError("VALIDATION_ERROR", "Please correct the highlighted fields.", 422, [
      { field: "reference", issue: `${m.label} needs a reference` },
    ]);
  }
  if (reference) {
    const clash = db.payments.find(
      (p) =>
        p.methodCode === m.code &&
        p.reference?.toLowerCase() === reference.toLowerCase() &&
        p.status !== "rejected" &&
        p.status !== "reversed"
    );
    if (clash) {
      throw new MockError("PAYMENT_DUPLICATE_REFERENCE", "That reference is already recorded.", 409, [
        { field: "reference", issue: "Use the reference from the bank receipt" },
      ]);
    }
  }
  if (input.status === "pending" && input.allocations?.length) {
    // Only a confirmed payment may allocate (BILLING_ENGINE §11, API_CONTRACTS
    // §1: PAYMENT_NOT_CONFIRMED is a 409). One rule, one code — the payments
    // screen already maps this code to a plain-language alert.
    throw new MockError(
      "PAYMENT_NOT_CONFIRMED",
      "Allocate a payment only after it is confirmed.",
      409
    );
  }

  db.counters.payment += 1;
  const rec: PaymentRec = {
    id: `0192a000-0000-7000-8000-pay${String(db.counters.payment).padStart(9, "0")}`,
    amountMinor: input.amountMinor,
    methodCode: m.code,
    reference,
    receivedAt: input.receivedAt,
    payerGuardianId: input.payerGuardianId,
    payerName:
      input.payerName?.trim() ||
      db.guardians.find((g) => g.id === input.payerGuardianId)?.fullName,
    status: input.status,
    notes: input.notes?.trim() || undefined,
    allocations: [],
    proofs: [],
    receipts: [],
    version: 1,
  };
  db.payments.push(rec);
  if (input.status === "confirmed") {
    if (input.allocations?.length) applyAllocations(db, rec, input.allocations);
    issueReceipt(db, rec);
  }
  refreshInvoices(db);
  saveDb();
  return paymentView(db, rec);
}

export function confirmPayment(
  id: string,
  input: { allocations?: { invoiceId: string; amountMinor: number }[]; version: number }
): Payment {
  const db = readDb();
  const rec = mustGetPayment(db, id);
  if (rec.version !== input.version) conflict();
  if (rec.status !== "pending") {
    throw new MockError("INVALID_STATE_TRANSITION", "Only a pending payment can be confirmed.", 409);
  }
  if (input.allocations?.length) applyAllocations(db, rec, input.allocations);
  rec.status = "confirmed";
  rec.version += 1;
  issueReceipt(db, rec);
  refreshInvoices(db);
  saveDb();
  return paymentView(db, rec);
}

export function rejectPayment(id: string, input: { reason: string; version: number }): Payment {
  const db = readDb();
  const rec = mustGetPayment(db, id);
  if (rec.version !== input.version) conflict();
  if (rec.status !== "pending") {
    throw new MockError("INVALID_STATE_TRANSITION", "Only a pending payment can be rejected.", 409);
  }
  rec.rejectReason = requireReason(input.reason);
  rec.status = "rejected";
  rec.version += 1;
  refreshInvoices(db);
  saveDb();
  return paymentView(db, rec);
}

export function allocatePayment(
  id: string,
  input: { allocations: { invoiceId: string; amountMinor: number }[]; version: number }
): Payment {
  const db = readDb();
  const rec = mustGetPayment(db, id);
  if (rec.version !== input.version) conflict();
  if (rec.status !== "confirmed") {
    throw new MockError("PAYMENT_NOT_CONFIRMED", "Allocate a payment only after it is confirmed.", 409);
  }
  if (!input.allocations?.length) {
    throw new MockError("VALIDATION_ERROR", "Please correct the highlighted fields.", 422, [
      { field: "allocations", issue: "Add at least one allocation" },
    ]);
  }
  applyAllocations(db, rec, input.allocations);
  rec.version += 1;
  refreshInvoices(db);
  saveDb();
  return paymentView(db, rec);
}

export function reversePayment(id: string, input: { reason: string; version: number }): Payment {
  const db = readDb();
  const rec = mustGetPayment(db, id);
  if (rec.version !== input.version) conflict();
  if (rec.status !== "confirmed") {
    throw new MockError("INVALID_STATE_TRANSITION", "Only a confirmed payment can be reversed.", 409);
  }
  rec.reverseReason = requireReason(input.reason);
  const reversedAt = nowInstant();
  for (const a of rec.allocations) {
    if (!a.reversedAt) a.reversedAt = reversedAt;
  }
  for (const r of rec.receipts) r.voided = true;
  rec.status = "reversed";
  rec.version += 1;
  refreshInvoices(db);
  saveDb();
  return paymentView(db, rec);
}

export function patchPayment(
  id: string,
  input: { reference?: string; notes?: string; receivedAt?: string; version: number }
): Payment {
  const db = readDb();
  const rec = mustGetPayment(db, id);
  if (rec.version !== input.version) conflict();
  // Amount, method and allocations are immutable — reverse and re-record
  // (BILLING_ENGINE §11).
  if (input.reference !== undefined) rec.reference = input.reference.trim() || undefined;
  if (input.notes !== undefined) rec.notes = input.notes.trim() || undefined;
  if (input.receivedAt !== undefined) {
    if (Number.isNaN(Date.parse(input.receivedAt))) {
      throw new MockError("VALIDATION_ERROR", "Please correct the highlighted fields.", 422, [
        { field: "receivedAt", issue: "Send an instant" },
      ]);
    }
    rec.receivedAt = input.receivedAt;
  }
  rec.version += 1;
  saveDb();
  return paymentView(db, rec);
}

/** PAY-08 — oldest due date first, across every player the payer guardian pays for. */
export function allocationSuggestion(
  paymentId: string,
  guardianId?: string
): { suggested: { invoiceId: string; amountMinor: number }[]; creditMinor: number } {
  const db = readDb();
  const rec = paymentId === "new" ? undefined : db.payments.find((p) => p.id === paymentId);
  const payer = guardianId ?? rec?.payerGuardianId;
  const open = db.invoices
    .filter((i) => (i.status === "issued" || i.status === "partially_paid") && i.balanceMinor > 0)
    .filter((i) => {
      if (!payer) return true;
      const player = db.players.find((p) => p.id === i.player.id);
      return (
        (i.guardian?.id ?? player?.guardians.find((g) => g.isPrimary)?.guardian.id) === payer
      );
    })
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.invoiceNumber.localeCompare(b.invoiceNumber));

  const available = rec
    ? rec.amountMinor - rec.allocations.filter((a) => !a.reversedAt).reduce((s, a) => s + a.amountMinor, 0)
    : 0;
  const suggested: { invoiceId: string; amountMinor: number }[] = [];
  let left = available;
  for (const inv of open) {
    if (left <= 0) break;
    const amountMinor = Math.min(left, inv.balanceMinor);
    suggested.push({ invoiceId: inv.id, amountMinor });
    left -= amountMinor;
  }
  const held =
    rec && rec.status === "confirmed"
      ? rec.amountMinor - rec.allocations.filter((a) => !a.reversedAt).reduce((s, a) => s + a.amountMinor, 0)
      : 0;
  return { suggested, creditMinor: Math.max(0, held) };
}

// ---------------------------------------------------------------------------
// Proofs (PRF-01..04, PAYMENT_VERIFICATION)
// ---------------------------------------------------------------------------
export function addProof(
  paymentId: string,
  file: {
    originalName: string;
    mimeType: string;
    sizeBytes: number;
    sha256: string;
    docKind: ProofDocKind;
    stubKind: "pdf" | "image";
    note?: string;
  }
): ProofMeta {
  const db = readDb();
  const rec = mustGetPayment(db, paymentId);
  if (file.sizeBytes > 5 * 1024 * 1024) {
    throw new MockError("FILE_TOO_LARGE", "Files must be 5 MB or smaller.", 413);
  }
  if (rec.proofs.length >= 5) {
    throw new MockError("VALIDATION_ERROR", "Please correct the highlighted fields.", 422, [
      { field: "file", issue: "A payment can hold at most 5 proofs" },
    ]);
  }
  const proof: ProofRec = {
    fileId: `0192a000-0000-7000-8000-pf${String(db.payments.length * 7 + rec.proofs.length + 1).padStart(9, "0")}`,
    paymentId,
    originalName: file.originalName,
    mimeType: file.mimeType,
    sizeBytes: file.sizeBytes,
    uploadedAt: nowInstant(),
    uploadedById: OWNER_ID,
    uploadedByName: "Demo Owner",
    docKind: file.docKind,
    sha256: file.sha256,
    note: file.note,
    stubKind: file.stubKind,
  };
  rec.proofs.push(proof);
  rec.version += 1;
  // Automatic checks stay off: SET-08.proofCheck is CR-003 and ADR-019 is still
  // Proposed, so only the explicit PRF-04 action runs a check.
  if (db.settings.proofAutoCheck) {
    proof.verification = runVerification(db, rec, proof);
  }
  saveDb();
  return paymentView(db, rec).proofs!.find((p) => p.fileId === proof.fileId)!;
}

export function deleteProof(paymentId: string, fileId: string): void {
  const db = readDb();
  const rec = mustGetPayment(db, paymentId);
  if (rec.status !== "pending") {
    throw new MockError("INVALID_STATE_TRANSITION", "A proof can be removed only while the payment is pending.", 409);
  }
  const index = rec.proofs.findIndex((p) => p.fileId === fileId);
  if (index === -1) throw new MockError("NOT_FOUND", "Proof not found.", 404);
  rec.proofs.splice(index, 1);
  rec.version += 1;
  saveDb();
}

/** PRF-04. Advisory, deterministic, and it never touches money (ADR-021). */
export function verifyProof(paymentId: string, fileId: string): ProofVerification {
  const db = readDb();
  const rec = mustGetPayment(db, paymentId);
  const proof = rec.proofs.find((p) => p.fileId === fileId);
  if (!proof) throw new MockError("NOT_FOUND", "Proof not found.", 404);
  proof.verification = runVerification(db, rec, proof);
  rec.version += 1;
  saveDb();
  return proof.verification;
}

function runVerification(db: Db, rec: PaymentRec, proof: ProofRec): ProofVerification {
  const checkedAt = nowInstant();
  const parserVersion = "mock-bank@0.1.0";
  const findings: ProofFinding[] = [];

  if (proof.docKind !== "bank_receipt_pdf") {
    // A photo or a screenshot has no text layer: it can never produce a pass
    // (PAYMENT_VERIFICATION §2/§4.1).
    return {
      docKind: proof.docKind,
      status: "unverifiable",
      parserVersion,
      checkedAt,
      findings: [
        {
          code: "SUPPORTING_ONLY",
          level: 1,
          result: "unknown",
          detail:
            "A photo or screenshot has no text layer, so it cannot be checked. Ask for the bank's PDF e-receipt.",
        },
      ],
    };
  }

  // The mock "reads" the receipt from the recorded payment and the academy's own
  // account — the only deterministic source available without a real parser.
  const otherProofs = db.payments
    .filter((p) => p.id !== rec.id)
    .flatMap((p) => p.proofs)
    .filter((p) => p.docKind === "bank_receipt_pdf");
  const reusedReference = otherProofs.some(
    (p) => p.verification?.extracted?.reference && p.verification.extracted.reference === rec.reference
  );
  const duplicateFile = [...otherProofs, ...rec.proofs.filter((p) => p.fileId !== proof.fileId)].some(
    (p) => p.sha256 === proof.sha256
  );
  const payerGuardian = db.guardians.find((g) => g.id === rec.payerGuardianId);
  const payerName = rec.payerName ?? payerGuardian?.fullName;
  const payerMatches =
    Boolean(payerGuardian) &&
    Boolean(payerName) &&
    (payerName!.toLowerCase().includes(payerGuardian!.fullName.toLowerCase()) ||
      payerGuardian!.fullName.toLowerCase().includes(payerName!.toLowerCase()));
  const openInvoices = db.invoices.filter(
    (i) =>
      (i.status === "issued" || i.status === "partially_paid") &&
      (i.guardian?.id ?? db.players.find((p) => p.id === i.player.id)?.guardians.find((g) => g.isPrimary)?.guardian.id) ===
        rec.payerGuardianId
  );
  const invoiceMatches = openInvoices.some((i) => i.balanceMinor === rec.amountMinor);
  const account = db.settings.beneficiaryAccounts[0];

  const extracted: ProofExtract = {
    bankName: "Demo Bank",
    documentType: "Fund Transfer Confirmation",
    reference: rec.reference,
    transactionAt: rec.receivedAt,
    amountMinor: rec.amountMinor,
    currency: "LKR",
    payerName,
    payerAccountMasked: "****0000",
    beneficiaryName: account?.name,
    beneficiaryAccountMasked: account?.accountMasked,
    channel: rec.methodCode === "bank_transfer" ? "CEFT" : undefined,
    status: "Successful",
    remarks: openInvoices.map((i) => i.invoiceNumber).join(", ") || undefined,
  };

  findings.push({
    code: "AMOUNT_MATCH",
    level: 2,
    result: "pass",
    detail: "The receipt amount equals the recorded amount.",
  });
  findings.push({
    code: "BENEFICIARY_MATCH",
    level: 2,
    result: account ? "pass" : "warn",
    detail: account
      ? "The beneficiary matches an academy account."
      : "No academy account is set, so the beneficiary cannot be compared.",
  });
  findings.push({
    code: "REFERENCE_MATCH",
    level: 2,
    result: rec.reference ? "pass" : "warn",
    detail: rec.reference
      ? "The receipt reference equals the recorded reference."
      : "No reference was recorded, so the receipt's reference cannot be compared.",
  });
  findings.push({
    code: "STATUS_SUCCESSFUL",
    level: 2,
    result: "pass",
    detail: "The receipt reports a successful transfer.",
  });
  findings.push({
    code: "DATE_TOLERANCE",
    level: 2,
    result: "pass",
    detail: "The transfer time is on the recorded date.",
    meta: { deltaMinutes: 0 },
  });
  findings.push({
    code: "PAYER_SOFT_MATCH",
    level: 2,
    result: payerMatches ? "pass" : "warn",
    detail: payerMatches
      ? "The payer on the receipt matches the guardian."
      : "The payer on the receipt is not a guardian — third parties paying for a family are normal.",
  });
  findings.push({
    code: "INVOICE_MATCH",
    level: 2,
    result: invoiceMatches ? "pass" : "warn",
    detail: invoiceMatches
      ? "An open invoice matches this amount."
      : "No open invoice for this payer matches the amount — check which invoice it is for.",
  });
  findings.push({
    code: "RECEIPT_NOT_REUSED",
    level: 2,
    result: reusedReference || duplicateFile ? "fail" : "pass",
    detail: duplicatedDetail(db, rec, reusedReference, duplicateFile),
    meta: reusedReference ? { reason: "reference_already_used" } : duplicateFile ? { reason: "identical_file" } : undefined,
  });

  const status: ProofVerification["status"] = findings.some((f) => f.result === "fail")
    ? "failed"
    : "checked";
  return { docKind: proof.docKind, status, extracted, findings, parserVersion, checkedAt };
}

function duplicatedDetail(db: Db, rec: PaymentRec, reusedReference: boolean, duplicateFile: boolean): string {
  if (duplicateFile) return "This exact file is already attached to another payment.";
  if (!reusedReference) return "This receipt is not attached to another payment.";
  const other = db.payments.find(
    (p) =>
      p.id !== rec.id &&
      p.proofs.some((proof) => proof.verification?.extracted?.reference === rec.reference)
  );
  return other
    ? `This receipt's reference is already attached to another payment (${other.id.slice(-6)}).`
    : "This receipt's reference is already attached to another payment.";
}

/** PRF-02 — the mock serves a generated stub (it never keeps real bytes). */
export function proofFile(
  paymentId: string,
  fileId: string
): { blob: Blob; filename: string; mimeType: string } | undefined {
  const db = readDb();
  const rec = db.payments.find((p) => p.id === paymentId);
  const proof = rec?.proofs.find((p) => p.fileId === fileId);
  if (!rec || !proof) return undefined;
  if (proof.stubKind === "pdf") {
    return {
      blob: buildPdf(proof.originalName ?? "proof.pdf", [
        "Bank transfer receipt (mock stub)",
        `Payment: ${rec.id}`,
        `Amount: LKR ${(rec.amountMinor / 100).toFixed(2)}`,
        `Reference: ${rec.reference ?? "not recorded"}`,
        "The uploaded file itself is not stored by the mock.",
      ]),
      filename: proof.originalName ?? "proof.pdf",
      mimeType: "application/pdf",
    };
  }
  return {
    blob: buildImageStub(proof.originalName ?? "proof image"),
    filename: `${(proof.originalName ?? "proof").replace(/\.[^.]+$/, "")}.svg`,
    mimeType: "image/svg+xml",
  };
}

// ---------------------------------------------------------------------------
// Receipts (RCT-01/02)
// ---------------------------------------------------------------------------
export function listReceipts(
  params: { paymentId?: string; from?: string; to?: string; page?: number; pageSize?: number }
): Page<ReceiptSummary> {
  const db = readDb();
  const rows: ReceiptSummary[] = db.payments
    .flatMap((p) => p.receipts.map((r) => ({ ...r, paymentId: p.id })))
    .filter((r) => !params.paymentId || r.paymentId === params.paymentId)
    .filter((r) => !params.from || r.issuedAt.slice(0, 10) >= params.from)
    .filter((r) => !params.to || r.issuedAt.slice(0, 10) <= params.to)
    .sort((a, b) => b.issuedAt.localeCompare(a.issuedAt));
  return paginate(rows, params.page, params.pageSize);
}

export function receiptFile(receiptId: string): { blob: Blob; filename: string } | undefined {
  const db = readDb();
  for (const payment of db.payments) {
    const receipt = payment.receipts.find((r) => r.id === receiptId);
    if (!receipt) continue;
    const allocated = payment.allocations.filter((a) => !a.reversedAt);
    return {
      filename: `${receipt.receiptNumber}.pdf`,
      blob: buildPdf(`Receipt ${receipt.receiptNumber}`, [
        db.settings.academyName,
        `Received from: ${payment.payerName ?? "Guardian"}`,
        `Amount: LKR ${(payment.amountMinor / 100).toFixed(2)}`,
        `Method: ${db.methods.find((m) => m.code === payment.methodCode)?.label ?? payment.methodCode}`,
        payment.reference ? `Reference: ${payment.reference}` : "",
        `Received: ${payment.receivedAt}`,
        allocated.length
          ? `Applied to: ${allocated.map((a) => a.invoice.invoiceNumber).join(", ")}`
          : "Not allocated yet",
        allocated.length && payment.amountMinor > allocated.reduce((s, a) => s + a.amountMinor, 0)
          ? `Unallocated credit: LKR ${((payment.amountMinor - allocated.reduce((s, a) => s + a.amountMinor, 0)) / 100).toFixed(2)}`
          : "",
        receipt.voided ? "VOID - payment reversed" : "",
        "",
        "A receipt is issued only for a confirmed payment.",
      ]),
    };
  }
  return undefined;
}

export function regenerateReceiptPdf(receiptId: string): void {
  const db = readDb();
  const exists = db.payments.some((p) => p.receipts.some((r) => r.id === receiptId));
  if (!exists) throw new MockError("NOT_FOUND", "Receipt not found.", 404);
  saveDb();
}

// ---------------------------------------------------------------------------
// Settings reads (SET-01/02/04 — the settings screens themselves are Step 8)
// ---------------------------------------------------------------------------
export function listMethods(): { data: PaymentMethod[] } {
  return { data: getDb().methods };
}

export function billingSettings(): BillingSettings {
  const s = getDb().settings;
  return {
    billingFrequency: s.billingFrequency,
    billingPeriodMode: s.billingPeriodMode,
    weekStartDay: s.weekStartDay,
    invoiceIssueTiming: s.invoiceIssueTiming,
    dueRuleType: s.dueRuleType,
    dueRuleValue: s.dueRuleValue,
    allowFractionalMoney: s.allowFractionalMoney,
    effectNote: s.effectNote,
  };
}

export function academyPaymentSettings(): AcademyPaymentSettings {
  const s = getDb().settings;
  return {
    academyName: s.academyName,
    paymentInstructions: s.paymentInstructions,
    beneficiaryAccounts: s.beneficiaryAccounts,
  };
}

/** Test hook: the E2E script flips the session to connected to watch the gate. */
export function setWhatsappSession(state: "awaiting_qr" | "connected"): void {
  const db = getDb();
  db.settings.whatsappSession = state;
  saveDb();
}
