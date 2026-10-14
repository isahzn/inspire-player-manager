/**
 * Invoice PDFs — building, hashing, storing and flagging (FILES_AND_PDF §4).
 *
 * The shape of this file follows three rules from the spec:
 *
 *  1. **The document is rendered from the snapshot, never from live settings.** The input is
 *     assembled from `invoices` + `invoice_items` + `snapshot` (ADR-014), so regenerating an
 *     old invoice cannot silently adopt this year's address or phone number.
 *  2. **A wrong total is never written.** `buildInvoicePdf` re-checks the arithmetic before a
 *     byte is produced; this file turns that into `PDF_TOTAL_MISMATCH`, leaves `pdf_stale`
 *     set, and writes no file. Nothing here "fixes" a total.
 *  3. **Identical input ⇒ no new file.** `pdf_input_hash` is a SHA-256 of the canonical input,
 *     so a regeneration that changes nothing is a no-op rather than a second copy of the same
 *     PDF.
 *
 * Where the document *goes* is `storage.ts`: this file only decides the key
 * (`invoices/{yyyy}/{invoiceId}/{hash12}.pdf`) and records the `files` row.
 */
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { uuidv7 } from "../ids.js";
import { readStoredFile, writeStoredFile } from "../files/storage.js";
import { buildInvoicePdf } from "../files/pdf/invoice.js";
import { buildReceiptPdf } from "../files/pdf/receipt.js";
import type {
  InvoicePdfInput,
  InvoicePdfItem,
  PdfAcademy,
  ReceiptPdfInput,
} from "../files/pdf/types.js";
import { loadAcademyBrand } from "./academy-brand.js";

/** The snapshot blocks M6 added. Older rows may not have them — see `completeSnapshot`. */
interface InvoiceSnapshot {
  ageGroupId?: string;
  ageGroupName?: string;
  manualDescription?: string;
  academy?: PdfAcademy;
  player?: { fullName: string; registrationNo: string; ageGroupName: string | null };
  guardian?: { fullName: string; phone: string | null } | null;
  [key: string]: unknown;
}

interface InvoicePdfRow {
  id: string;
  invoice_number: string;
  kind: "periodic" | "manual";
  status: InvoicePdfInput["status"];
  issue_date: string;
  due_date: string;
  period_start: string | null;
  period_end: string | null;
  currency: string;
  subtotal_minor: string;
  adjustments_minor: string;
  total_minor: string;
  paid_minor: string;
  balance_minor: string;
  void_reason: string | null;
  voided_at: string | null;
  snapshot: InvoiceSnapshot | null;
  pdf_file_id: string | null;
  pdf_input_hash: string | null;
  pdf_stale: boolean;
  player_full_name: string;
  player_registration_no: string;
  guardian_full_name: string | null;
  guardian_phone: string | null;
  timezone: string;
}

const INVOICE_PDF_SELECT = `select i.id, i.invoice_number, i.kind, i.status,
         i.issue_date::text as issue_date, i.due_date::text as due_date,
         i.period_start::text as period_start, i.period_end::text as period_end,
         i.currency, i.subtotal_minor::text as subtotal_minor,
         i.adjustments_minor::text as adjustments_minor, i.total_minor::text as total_minor,
         i.paid_minor::text as paid_minor, i.balance_minor::text as balance_minor,
         i.void_reason, i.voided_at::text as voided_at, i.snapshot,
         i.pdf_file_id, i.pdf_input_hash, i.pdf_stale,
         p.full_name as player_full_name, p.registration_no as player_registration_no,
         g.full_name as guardian_full_name, g.phone_e164 as guardian_phone,
         a.timezone
    from invoices i
    join players p on p.id = i.player_id
    left join guardians g on g.id = i.guardian_id
    cross join academy_settings a
   where i.id = $1`;

async function loadInvoicePdfRow(client: PoolClient, invoiceId: string): Promise<InvoicePdfRow | null> {
  const result = await client.query<InvoicePdfRow>(INVOICE_PDF_SELECT, [invoiceId]);
  return result.rows[0] ?? null;
}

/**
 * Fills in the snapshot blocks an invoice issued **before** M6 recorded them.
 *
 * Every invoice issued from M6 on carries `academy`/`player`/`guardian` in its snapshot. A row
 * written earlier does not, and rendering it from live settings would be exactly the silent
 * rewrite ADR-014 forbids. So the missing blocks are composed once from the live rows and
 * **persisted**, which makes the document stable from that point on instead of drifting every
 * time it is rendered. It only ever adds keys that were never present.
 */
async function completeSnapshot(
  client: PoolClient,
  row: InvoicePdfRow,
): Promise<InvoiceSnapshot> {
  const snapshot: InvoiceSnapshot = row.snapshot ?? {};
  const missingAcademy = !snapshot.academy;
  const missingPlayer = !snapshot.player;
  const missingGuardian = !("guardian" in snapshot);

  if (!missingAcademy && !missingPlayer && !missingGuardian) return snapshot;

  let brand:
    | {
        name: string;
        address: string | null;
        phone: string | null;
        email: string | null;
        payment_instructions: string | null;
        logo_file_id: string | null;
      }
    | undefined;
  if (missingAcademy) {
    brand = (
      await client.query<{
        name: string;
        address: string | null;
        phone: string | null;
        email: string | null;
        payment_instructions: string | null;
        logo_file_id: string | null;
      }>(
        `select name, address, phone, email, payment_instructions, logo_file_id
           from academy_settings where id = 1`,
      )
    ).rows[0];
  }

  const completed: InvoiceSnapshot = {
    ...snapshot,
    ...(brand
      ? {
          academy: {
            name: brand.name,
            address: brand.address,
            phone: brand.phone,
            email: brand.email,
            paymentInstructions: brand.payment_instructions,
            logoFileId: brand.logo_file_id,
            currency: row.currency,
          },
        }
      : {}),
    ...(missingPlayer
      ? {
          player: {
            fullName: row.player_full_name,
            registrationNo: row.player_registration_no,
            ageGroupName: snapshot.ageGroupName ?? null,
          },
        }
      : {}),
    ...(missingGuardian
      ? {
          guardian: row.guardian_full_name
            ? { fullName: row.guardian_full_name, phone: row.guardian_phone }
            : null,
        }
      : {}),
  };

  await client.query(`update invoices set snapshot = $2::jsonb where id = $1`, [
    row.id,
    JSON.stringify(completed),
  ]);
  return completed;
}

async function loadItems(client: PoolClient, invoiceId: string): Promise<InvoicePdfItem[]> {
  const result = await client.query<{
    line_no: number;
    description: string;
    quantity: number;
    unit_amount_minor: string;
    amount_minor: string;
    reason: string | null;
  }>(
    `select line_no, description, quantity, unit_amount_minor::text as unit_amount_minor,
            amount_minor::text as amount_minor, reason
       from invoice_items
      where invoice_id = $1
      order by line_no asc`,
    [invoiceId],
  );
  return result.rows.map((row) => ({
    lineNo: row.line_no,
    description: row.description,
    quantity: row.quantity,
    unitAmountMinor: row.unit_amount_minor,
    amountMinor: row.amount_minor,
    reason: row.reason,
  }));
}

/**
 * The canonical input for the invoice's PDF.
 *
 * This is both what the renderer is given and what `pdf_input_hash` covers, which is the point:
 * a hash over a different object than the renderer sees could not tell "nothing changed" from
 * "something changed".
 */
export async function buildInvoicePdfInput(
  client: PoolClient,
  invoiceId: string,
  timezoneFallback: string,
): Promise<{ input: InvoicePdfInput; row: InvoicePdfRow } | null> {
  const row = await loadInvoicePdfRow(client, invoiceId);
  if (!row) return null;

  const snapshot = await completeSnapshot(client, row);
  const items = await loadItems(client, invoiceId);

  const academy: PdfAcademy = snapshot.academy ?? {
    name: "Inspire Academy",
    address: null,
    phone: null,
    email: null,
    paymentInstructions: null,
    logoFileId: null,
    currency: row.currency,
  };

  const input: InvoicePdfInput = {
    invoiceNumber: row.invoice_number,
    kind: row.kind,
    status: row.status,
    issueDate: row.issue_date,
    dueDate: row.due_date,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    manualDescription: snapshot.manualDescription ?? null,
    currency: row.currency,
    subtotalMinor: row.subtotal_minor,
    adjustmentsMinor: row.adjustments_minor,
    totalMinor: row.total_minor,
    paidMinor: row.paid_minor,
    balanceMinor: row.balance_minor,
    voidReason: row.void_reason,
    voidedAt: row.voided_at,
    academy,
    player: snapshot.player ?? {
      fullName: row.player_full_name,
      registrationNo: row.player_registration_no,
      ageGroupName: snapshot.ageGroupName ?? null,
    },
    guardian: snapshot.guardian ?? null,
    items,
    timezone: row.timezone || timezoneFallback,
  };

  return { input, row };
}

/**
 * A stable digest of everything the document prints.
 *
 * Key order is fixed by building the object explicitly — `JSON.stringify` follows insertion
 * order, so a hash over a spread would change the moment a field moved, and every invoice would
 * look "changed" and be rebuilt.
 */
export function invoicePdfInputHash(input: InvoicePdfInput): string {
  const canonical = {
    invoiceNumber: input.invoiceNumber,
    kind: input.kind,
    status: input.status,
    issueDate: input.issueDate,
    dueDate: input.dueDate,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    manualDescription: input.manualDescription,
    currency: input.currency,
    subtotalMinor: input.subtotalMinor,
    adjustmentsMinor: input.adjustmentsMinor,
    totalMinor: input.totalMinor,
    paidMinor: input.paidMinor,
    balanceMinor: input.balanceMinor,
    voidReason: input.voidReason,
    academy: {
      name: input.academy.name,
      address: input.academy.address,
      phone: input.academy.phone,
      email: input.academy.email,
      paymentInstructions: input.academy.paymentInstructions,
      logoFileId: input.academy.logoFileId,
    },
    player: input.player,
    guardian: input.guardian,
    items: input.items.map((item) => ({
      lineNo: item.lineNo,
      description: item.description,
      quantity: item.quantity,
      unitAmountMinor: item.unitAmountMinor,
      amountMinor: item.amountMinor,
      reason: item.reason,
    })),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/** Reads the logo bytes, or `null` — a missing logo degrades to the wordmark, never a failure. */
async function loadLogo(client: PoolClient, logoFileId: string | null): Promise<Uint8Array | null> {
  if (!logoFileId) return null;
  const result = await client.query<{ storage_key: string }>(
    `select storage_key from files where id = $1 and deleted_at is null`,
    [logoFileId],
  );
  const key = result.rows[0]?.storage_key;
  if (!key) return null;
  return readStoredFile(key);
}

export type GenerateInvoicePdfResult =
  | { outcome: "ready"; fileId: string; hash: string; pages: number; reused: boolean }
  | { outcome: "not_found" }
  | { outcome: "mismatch"; message: string }
  | { outcome: "storage_failed" };

/**
 * Renders the invoice's PDF if it is missing or stale, and records it.
 *
 * `force` regenerates even when the hash is unchanged, which is what the owner's Regenerate
 * action (INV-07) means. Without it, an unchanged document is left alone (rule 3) — the same
 * hash means the same bytes, so a second copy would only be a file to clean up.
 *
 * On any failure the row keeps `pdf_stale = true`, so the document stays visibly pending rather
 * than appearing to be up to date. Nothing about the invoice's money changes here.
 */
export async function generateInvoicePdf(
  client: PoolClient,
  args: {
    invoiceId: string;
    /** `null` for the background sweeper: `files.uploaded_by` allows it and no person did this. */
    userId: string | null;
    force: boolean;
    timezoneFallback: string;
    now?: Date;
  },
): Promise<GenerateInvoicePdfResult> {
  const built = await buildInvoicePdfInput(client, args.invoiceId, args.timezoneFallback);
  if (!built) return { outcome: "not_found" };
  const { input, row } = built;

  const hash = invoicePdfInputHash(input);
  if (!args.force && row.pdf_file_id && row.pdf_input_hash === hash && !row.pdf_stale) {
    return { outcome: "ready", fileId: row.pdf_file_id, hash, pages: 0, reused: true };
  }

  const logo = await loadLogo(client, input.academy.logoFileId);

  let rendered;
  try {
    rendered = await buildInvoicePdf(input, { logo, generatedAt: args.now ?? new Date() });
  } catch (err) {
    // A total that does not add up is a data fault to fix, not a document to guess at (§4).
    return { outcome: "mismatch", message: (err as Error).message };
  }

  const storageKey = `invoices/${input.issueDate.slice(0, 4)}/${row.id}/${hash.slice(0, 12)}.pdf`;
  if (!(await writeStoredFile(storageKey, rendered.bytes))) {
    return { outcome: "storage_failed" };
  }

  const fileId = uuidv7();
  const sha256 = createHash("sha256").update(rendered.bytes).digest("hex");
  await client.query(
    `insert into files
       (id, kind, storage_key, mime_type, size_bytes, sha256, original_name, uploaded_by)
     values ($1, 'invoice_pdf', $2, 'application/pdf', $3, $4, $5, $6)`,
    [
      fileId,
      storageKey,
      rendered.bytes.byteLength,
      sha256,
      `${input.invoiceNumber}.pdf`,
      args.userId,
    ],
  );
  await client.query(
    `update invoices
        set pdf_file_id = $2, pdf_input_hash = $3, pdf_generated_at = now(), pdf_stale = false
      where id = $1`,
    [row.id, fileId, hash],
  );

  return { outcome: "ready", fileId, hash, pages: rendered.pages, reused: false };
}

/** The bytes of a stored document, or `null` when the object is missing (§8). */
export async function readInvoicePdfBytes(
  client: PoolClient,
  fileId: string,
): Promise<Uint8Array | null> {
  const result = await client.query<{ storage_key: string }>(
    `select storage_key from files where id = $1 and deleted_at is null`,
    [fileId],
  );
  const key = result.rows[0]?.storage_key;
  if (!key) return null;
  return readStoredFile(key);
}

// ---------------------------------------------------------------------------
// Receipts (RCT-02)
// ---------------------------------------------------------------------------

interface ReceiptPdfRow {
  id: string;
  receipt_number: string;
  payment_id: string;
  issued_at: string;
  file_id: string | null;
  pdf_input_hash: string | null;
  pdf_stale: boolean;
  voided_at: string | null;
  amount_minor: string;
  currency: string;
  reference: string | null;
  payer_name: string | null;
  received_at: string;
  method_label: string;
  guardian_name: string | null;
  timezone: string;
}

const RECEIPT_PDF_SELECT = `select r.id, r.receipt_number, r.payment_id,
         r.issued_at::text as issued_at, r.file_id, r.pdf_input_hash, r.pdf_stale,
         r.voided_at::text as voided_at,
         p.amount_minor::text as amount_minor, p.currency, p.reference, p.payer_name,
         (p.received_at at time zone a.timezone)::date::text as received_at,
         pm.label as method_label, g.full_name as guardian_name, a.timezone
    from receipts r
    join payments p on p.id = r.payment_id
    join payment_methods pm on pm.code = p.method_code
    left join guardians g on g.id = p.payer_guardian_id
    cross join academy_settings a
   where r.id = $1`;

/**
 * The canonical input for a receipt's PDF.
 *
 * Unlike an invoice, a receipt has no `snapshot`: it is not a priced document whose terms must
 * be frozen (FILES_AND_PDF §3 prints the same branding block, then only the payment's own
 * facts). The method label is read through the payment's `method_code`, so a later rename of a
 * payment method cannot relabel history — the code is immutable (`SET-04`).
 */
export async function buildReceiptPdfInput(
  client: PoolClient,
  receiptId: string,
  timezoneFallback: string,
): Promise<{ input: ReceiptPdfInput; row: ReceiptPdfRow } | null> {
  const result = await client.query<ReceiptPdfRow>(RECEIPT_PDF_SELECT, [receiptId]);
  const row = result.rows[0];
  if (!row) return null;

  const allocations = await client.query<{
    invoice_number: string;
    player_name: string;
    amount_minor: string;
    invoice_total: string;
    invoice_paid: string;
  }>(
    `select i.invoice_number, pl.full_name as player_name, a.amount_minor::text as amount_minor,
            i.total_minor::text as invoice_total, i.paid_minor::text as invoice_paid
       from payment_allocations a
       join invoices i on i.id = a.invoice_id
       join players pl on pl.id = i.player_id
      where a.payment_id = $1 and a.reversed_at is null
      order by a.allocated_at asc, a.id asc`,
    [row.payment_id],
  );

  // Read live: a receipt prints the academy as it is, not as it was (see the doc comment).
  const brand: PdfAcademy = {
    ...(await loadAcademyBrand(client)),
    currency: row.currency,
  };

  const allocated = allocations.rows.reduce((total, a) => total + BigInt(a.amount_minor), 0n);
  const input: ReceiptPdfInput = {
    receiptNumber: row.receipt_number,
    paymentMethodLabel: row.method_label,
    paymentReference: row.reference,
    payerName: row.payer_name ?? row.guardian_name,
    amountMinor: row.amount_minor,
    unallocatedMinor: (BigInt(row.amount_minor) - allocated).toString(),
    currency: row.currency,
    receivedAt: row.received_at,
    issuedAt: row.issued_at.slice(0, 10),
    allocations: allocations.rows.map((a) => ({
      invoiceNumber: a.invoice_number,
      playerName: a.player_name,
      appliedMinor: a.amount_minor,
      // "The invoice's balance after this payment" (§3). Derived from the invoice's own
      // totals rather than stored per allocation, so it cannot disagree with the invoice.
      invoiceBalanceAfterMinor: (BigInt(a.invoice_total) - BigInt(a.invoice_paid)).toString(),
    })),
    reversedAt: row.voided_at ? row.voided_at.slice(0, 10) : null,
    academy: brand,
    timezone: row.timezone || timezoneFallback,
  };

  return { input, row };
}

/** A stable digest of what the receipt prints; same rule as the invoice's. */
export function receiptPdfInputHash(input: ReceiptPdfInput): string {
  const canonical = {
    receiptNumber: input.receiptNumber,
    paymentMethodLabel: input.paymentMethodLabel,
    paymentReference: input.paymentReference,
    payerName: input.payerName,
    amountMinor: input.amountMinor,
    unallocatedMinor: input.unallocatedMinor,
    currency: input.currency,
    receivedAt: input.receivedAt,
    issuedAt: input.issuedAt,
    allocations: input.allocations,
    reversedAt: input.reversedAt,
    academy: input.academy,
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export type GenerateReceiptPdfResult =
  | { outcome: "ready"; fileId: string; hash: string; pages: number; reused: boolean }
  | { outcome: "not_found" }
  | { outcome: "mismatch"; message: string }
  | { outcome: "storage_failed" };

/**
 * Renders the receipt's PDF if it is missing or stale. The invoice path's rules apply
 * unchanged: identical input ⇒ no new file, and a failure leaves `pdf_stale` set.
 */
export async function generateReceiptPdf(
  client: PoolClient,
  args: {
    receiptId: string;
    /** `null` for the background sweeper — see `generateInvoicePdf`. */
    userId: string | null;
    timezoneFallback: string;
    now?: Date;
  },
): Promise<GenerateReceiptPdfResult> {
  const built = await buildReceiptPdfInput(client, args.receiptId, args.timezoneFallback);
  if (!built) return { outcome: "not_found" };
  const { input, row } = built;

  const hash = receiptPdfInputHash(input);
  if (row.file_id && row.pdf_input_hash === hash && !row.pdf_stale) {
    return { outcome: "ready", fileId: row.file_id, hash, pages: 0, reused: true };
  }

  const logo = await loadLogo(client, input.academy.logoFileId);

  let rendered;
  try {
    rendered = await buildReceiptPdf(input, { logo, generatedAt: args.now ?? new Date() });
  } catch (err) {
    return { outcome: "mismatch", message: (err as Error).message };
  }

  const storageKey = `receipts/${input.receivedAt.slice(0, 4)}/${row.id}/${hash.slice(0, 12)}.pdf`;
  if (!(await writeStoredFile(storageKey, rendered.bytes))) {
    return { outcome: "storage_failed" };
  }

  const fileId = uuidv7();
  const sha256 = createHash("sha256").update(rendered.bytes).digest("hex");
  await client.query(
    `insert into files
       (id, kind, storage_key, mime_type, size_bytes, sha256, original_name, uploaded_by)
     values ($1, 'receipt_pdf', $2, 'application/pdf', $3, $4, $5, $6)`,
    [fileId, storageKey, rendered.bytes.byteLength, sha256, `${input.receiptNumber}.pdf`, args.userId],
  );
  await client.query(
    `update receipts
        set file_id = $2, pdf_input_hash = $3, pdf_generated_at = now(), pdf_stale = false
      where id = $1`,
    [row.id, fileId, hash],
  );

  return { outcome: "ready", fileId, hash, pages: rendered.pages, reused: false };
}
