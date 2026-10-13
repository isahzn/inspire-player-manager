/**
 * Serializers for the money surface (API_CONTRACTS §2, BILLING_ENGINE §11).
 *
 * Three rules the shapes here encode:
 *
 *  - **Money is an integer.** `bigint` columns come back from `pg` as strings; every amount
 *    is converted exactly once, here, with `Number()` — LKR amounts stay far below
 *    `Number.MAX_SAFE_INTEGER` (the contract caps an input at 1e10 minor units), so no
 *    float arithmetic is ever performed on an amount.
 *  - **A proof never becomes a payment state.** `proofVerification` is a *derived rollup* of
 *    the findings, computed on read. It is deliberately worded as advice — a passing check
 *    is reported as `passed`, never as "verified" or "paid", and the payment stays whatever
 *    its own `status` says (ADR-020/ADR-021).
 *  - **`unallocatedMinor` is credit, not change.** It is the part of a confirmed payment no
 *    invoice is holding; it is never auto-applied (OPEN-007).
 */
import { dateStr } from "./people-serialize.js";

function money(value: string | number): number {
  return Number(value);
}

// ---------------------------------------------------------------------------
// Row shapes. They live here (not beside the queries) so `money-helpers` can import the
// types it reads rows into without the two files importing each other — the same split
// `attendance-serialize`/`attendance-helpers` uses.
// ---------------------------------------------------------------------------
export interface PaymentRow {
  id: string;
  amount_minor: string;
  currency: string;
  method_code: string;
  method_label: string;
  requires_reference: boolean;
  method_is_active: boolean;
  reference: string | null;
  received_at: Date;
  payer_guardian_id: string | null;
  payer_guardian_name: string | null;
  payer_name: string | null;
  status: "pending" | "confirmed" | "rejected" | "reversed";
  confirmed_at: Date | null;
  rejected_at: Date | null;
  rejected_reason: string | null;
  reversed_at: Date | null;
  reversed_reason: string | null;
  notes: string | null;
  allocated_minor: string;
  version: number;
  created_at: Date;
}

export interface AllocationRow {
  id: string;
  payment_id: string;
  invoice_id: string;
  invoice_number: string;
  amount_minor: string;
  allocated_at: Date;
  reversed_at: Date | null;
}

export interface ProofRow {
  id: string;
  payment_id: string;
  file_id: string;
  uploaded_by: string;
  uploaded_by_name: string;
  note: string | null;
  doc_kind: "bank_receipt_pdf" | "bank_receipt_image" | "other";
  verification: RawVerification | null;
  checked_at: Date | null;
  created_at: Date;
  deleted_at: Date | null;
  storage_key: string;
  mime_type: string;
  size_bytes: string;
  sha256: string;
  original_name: string | null;
}

export interface ReceiptRow {
  id: string;
  receipt_number: string;
  payment_id: string;
  issued_at: Date;
  file_id: string | null;
  voided_at: Date | null;
}

export interface InvoiceRow {
  id: string;
  invoice_number: string;
  kind: "periodic" | "manual";
  player_id: string;
  player_name: string;
  registration_no: string;
  guardian_id: string | null;
  guardian_name: string | null;
  period_start: Date | null;
  period_end: Date | null;
  issue_date: Date;
  due_date: Date;
  status: "issued" | "partially_paid" | "paid" | "void";
  currency: string;
  subtotal_minor: string;
  adjustments_minor: string;
  total_minor: string;
  paid_minor: string;
  balance_minor: string;
  version: number;
  voided_at: Date | null;
  void_reason: string | null;
}

/**
 * The invoice projection the INV-* surface reads — wider than `InvoiceRow`, which the
 * allocation paths deliberately keep narrow.
 *
 * The group is read from `snapshot` and never from the player's current history (ADR-014):
 * an invoice billed under U12 must still say U12 after a transfer to U14.
 */
export interface InvoiceFullRow {
  id: string;
  invoice_number: string;
  kind: "periodic" | "manual";
  status: "issued" | "partially_paid" | "paid" | "void";
  player_id: string;
  player_name: string;
  registration_no: string;
  guardian_id: string | null;
  guardian_name: string | null;
  period_start: Date | null;
  period_end: Date | null;
  issue_date: Date;
  due_date: Date;
  currency: string;
  subtotal_minor: string;
  adjustments_minor: string;
  total_minor: string;
  paid_minor: string;
  balance_minor: string;
  version: number;
  voided_at: Date | null;
  void_reason: string | null;
  pdf_file_id: string | null;
  snapshot: { ageGroupId?: string; ageGroupName?: string } | null;
  overdue: boolean;
  days_overdue: number;
}

export interface InvoiceItemRow {
  id: string;
  invoice_id: string;
  line_no: number;
  item_type: "fee" | "adjustment";
  description: string;
  quantity: number;
  unit_amount_minor: string;
  amount_minor: string;
  reason: string | null;
}

export interface BillingRunRow {
  id: string;
  run_key: string;
  status: "issued" | "partial" | "failed";
  target_date: Date;
  invoices_created: number;
  invoices_skipped: number;
  started_at: Date;
  completed_at: Date | null;
  invoice_ids: string[];
}

/**
 * `Invoice`.
 *
 * `items` and `allocations` are attached only by INV-02, so a list row never implies an empty
 * invoice. `isOverdue` is the *derived* predicate (ADR-010) and it is computed in the query
 * against the academy's own today — an invoice is overdue by the calendar the academy bills
 * on, not by the server's timezone.
 */
export function serializeInvoice(row: InvoiceFullRow, detail: InvoiceDetail = {}) {
  return {
    id: row.id,
    invoiceNumber: row.invoice_number,
    kind: row.kind,
    status: row.status,
    isOverdue: row.overdue,
    daysOverdue: row.days_overdue,
    player: { id: row.player_id, fullName: row.player_name, registrationNo: row.registration_no },
    ...(row.guardian_id && row.guardian_name
      ? { guardian: { id: row.guardian_id, fullName: row.guardian_name } }
      : {}),
    // A manual invoice whose player had no group on the issue date stores no group; the
    // contract has no "no group" case, so this cannot be reached — INV-03 refuses that input.
    ageGroup: {
      id: row.snapshot?.ageGroupId ?? "",
      name: row.snapshot?.ageGroupName ?? "",
    },
    ...(row.period_start ? { periodStart: dateStr(row.period_start) } : {}),
    ...(row.period_end ? { periodEnd: dateStr(row.period_end) } : {}),
    issueDate: dateStr(row.issue_date)!,
    dueDate: dateStr(row.due_date)!,
    currency: row.currency.trim(),
    subtotalMinor: money(row.subtotal_minor),
    adjustmentsMinor: money(row.adjustments_minor),
    totalMinor: money(row.total_minor),
    paidMinor: money(row.paid_minor),
    balanceMinor: money(row.balance_minor),
    ...(detail.items ? { items: detail.items.map(serializeInvoiceItem) } : {}),
    ...(detail.allocations
      ? { allocations: detail.allocations.map(serializeAllocation) }
      : {}),
    hasPdf: row.pdf_file_id !== null,
    ...(row.voided_at ? { voidedAt: row.voided_at.toISOString() } : {}),
    ...(row.void_reason ? { voidReason: row.void_reason } : {}),
    version: row.version,
  };
}

export interface InvoiceDetail {
  items?: InvoiceItemRow[];
  allocations?: AllocationRow[];
}

/**
 * An invoice line. `amountMinor` is negative for an adjustment — the sign is the meaning
 * (BILLING_ENGINE §10): only a negative line may follow an issue.
 */
export function serializeInvoiceItem(row: InvoiceItemRow) {
  return {
    id: row.id,
    lineNo: row.line_no,
    itemType: row.item_type,
    description: row.description,
    quantity: row.quantity,
    unitAmountMinor: money(row.unit_amount_minor),
    amountMinor: money(row.amount_minor),
    ...(row.reason ? { reason: row.reason } : {}),
  };
}

/** `BillingRun`. `invoiceIds` is read from the invoices the run created, never stored twice. */
export function serializeBillingRun(row: BillingRunRow) {
  return {
    id: row.id,
    runKey: row.run_key,
    status: row.status,
    targetDate: dateStr(row.target_date)!,
    invoicesCreated: row.invoices_created,
    invoicesSkipped: row.invoices_skipped,
    invoiceIds: row.invoice_ids ?? [],
    startedAt: row.started_at.toISOString(),
    ...(row.completed_at ? { completedAt: row.completed_at.toISOString() } : {}),
  };
}

// ---------------------------------------------------------------------------
// Proofs (PRF-01..04)
// ---------------------------------------------------------------------------
export interface RawFinding {
  code: string;
  level: 1 | 2 | 3;
  result: "pass" | "warn" | "fail" | "unknown";
  detail: string;
  meta?: Record<string, unknown>;
}

export interface RawVerification {
  status: "not_run" | "checked" | "unverifiable" | "failed";
  findings?: RawFinding[];
  extracted?: Record<string, unknown>;
  parserVersion?: string;
}

export function serializeProofVerification(
  docKind: ProofRow["doc_kind"],
  verification: RawVerification | null,
  checkedAt: Date | null,
) {
  if (!verification) {
    return { docKind, status: "not_run" as const, findings: [] };
  }
  return {
    docKind,
    status: verification.status,
    findings: verification.findings ?? [],
    ...(verification.extracted ? { extracted: verification.extracted } : {}),
    ...(verification.parserVersion ? { parserVersion: verification.parserVersion } : {}),
    ...(checkedAt ? { checkedAt: checkedAt.toISOString() } : {}),
  };
}

/**
 * `ProofMeta` — the file's facts plus the advisory verification result.
 *
 * `fileId` is the **proof's own id**, which is also what the contract's `{fileId}` path parameter
 * means on PRF-02/03/04. One id, used both ways, because that is the only arrangement a client
 * can complete a round trip with: it reads a proof from `PAY-03` and hands the same value back to
 * download, delete or re-check it. `files.id` — the stored object's identity — is an internal
 * detail and is deliberately not exposed; the proof is what a caller is referring to.
 */
export function serializeProof(row: ProofRow) {
  return {
    fileId: row.id,
    ...(row.original_name ? { originalName: row.original_name } : {}),
    mimeType: row.mime_type,
    sizeBytes: money(row.size_bytes),
    uploadedAt: row.created_at.toISOString(),
    uploadedBy: { id: row.uploaded_by, fullName: row.uploaded_by_name },
    docKind: row.doc_kind,
    ...(row.verification
      ? {
          verification: serializeProofVerification(
            row.doc_kind,
            row.verification,
            row.checked_at,
          ),
        }
      : {}),
  };
}

/**
 * The payment-level rollup (`Payment.proofVerification`).
 *
 * Order matters, and so does the third branch: `passed` requires that **every** check ran and
 * none of them failed or warned. A single `unknown` finding (a field the receipt simply does
 * not carry, or a check that could not run) makes the rollup `unverifiable`, because a check
 * that did not happen must never render as "Ready to confirm — checks passed"
 * (PAYMENT_VERIFICATION §5). With no proofs at all the rollup is omitted rather than sent as
 * a misleading all-clear.
 */
export function proofVerificationRollup(proofs: ProofRow[]) {
  const live = proofs.filter((proof) => !proof.deleted_at && proof.verification);
  if (live.length === 0) return undefined;

  const findings = live.flatMap((proof) => proof.verification?.findings ?? []);
  const status = findings.some((finding) => finding.result === "fail")
    ? ("failed" as const)
    : findings.some((finding) => finding.result === "warn")
      ? ("warned" as const)
      : live.every((proof) => proof.verification?.status === "checked") &&
          !findings.some((finding) => finding.result === "unknown")
        ? ("passed" as const)
        : ("unverifiable" as const);

  const checkedAt = live
    .map((proof) => proof.checked_at)
    .filter((value): value is Date => value instanceof Date)
    .sort((a, b) => b.getTime() - a.getTime())[0];

  return {
    status,
    ...(checkedAt ? { checkedAt: checkedAt.toISOString() } : {}),
  };
}

// ---------------------------------------------------------------------------
// Payments, allocations, receipts (PAY-01..08, RCT-01)
// ---------------------------------------------------------------------------
export function serializeAllocation(row: AllocationRow) {
  return {
    id: row.id,
    paymentId: row.payment_id,
    invoice: { id: row.invoice_id, invoiceNumber: row.invoice_number },
    amountMinor: money(row.amount_minor),
    allocatedAt: row.allocated_at.toISOString(),
    ...(row.reversed_at ? { reversedAt: row.reversed_at.toISOString() } : {}),
  };
}

export function serializeReceiptSummary(row: ReceiptRow) {
  return {
    id: row.id,
    receiptNumber: row.receipt_number,
    paymentId: row.payment_id,
    issuedAt: row.issued_at.toISOString(),
    voided: row.voided_at !== null,
  };
}

export interface PaymentDetail {
  allocations?: AllocationRow[];
  proofs?: ProofRow[];
  receipt?: ReceiptRow | null;
}

/**
 * `Payment`. `allocations`, `proofs` and `receipt` are only attached when the caller loaded
 * them (PAY-03.read does; the list does not), so a list row never implies an empty proof set.
 */
export function serializePayment(row: PaymentRow, detail: PaymentDetail = {}) {
  const payerName = row.payer_name ?? row.payer_guardian_name ?? undefined;
  const rollup = detail.proofs ? proofVerificationRollup(detail.proofs) : undefined;

  return {
    id: row.id,
    amountMinor: money(row.amount_minor),
    currency: row.currency.trim(),
    method: {
      code: row.method_code,
      label: row.method_label,
      requiresReference: row.requires_reference,
      isActive: row.method_is_active,
    },
    ...(row.reference ? { reference: row.reference } : {}),
    receivedAt: row.received_at.toISOString(),
    ...(row.payer_guardian_id || payerName
      ? {
          payer: {
            ...(row.payer_guardian_id ? { guardianId: row.payer_guardian_id } : {}),
            name: payerName ?? "",
          },
        }
      : {}),
    status: row.status,
    allocatedMinor: money(row.allocated_minor),
    unallocatedMinor: money(row.amount_minor) - money(row.allocated_minor),
    ...(detail.allocations
      ? { allocations: detail.allocations.map(serializeAllocation) }
      : {}),
    ...(detail.proofs ? { proofs: detail.proofs.map(serializeProof) } : {}),
    ...(detail.receipt
      ? { receipt: { id: detail.receipt.id, receiptNumber: detail.receipt.receipt_number } }
      : {}),
    ...(row.notes ? { notes: row.notes } : {}),
    ...(row.rejected_reason ? { rejectReason: row.rejected_reason } : {}),
    ...(row.reversed_reason ? { reverseReason: row.reversed_reason } : {}),
    ...(rollup ? { proofVerification: rollup } : {}),
    version: row.version,
  };
}
