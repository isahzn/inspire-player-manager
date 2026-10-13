/**
 * API_CONTRACTS §3.6 — billing runs, invoices, payments, allocations, proofs, receipts.
 *
 * The money rules these endpoints must never break (CLAUDE.md §3, BILLING_ENGINE §11):
 *  - integers in minor units only, no float ever reaches a money field;
 *  - issued invoices are immutable snapshots — only void or a negative adjustment;
 *  - proof is evidence, not payment: **no** automated path may confirm a payment
 *    (ADR-013/ADR-020/ADR-021), so PRF-04 is explicitly advisory;
 *  - allocation happens only on a confirmed payment, never on a pending one;
 *  - void stays blocked while allocations exist unless they are released.
 */
import { endpoint, section, res, z, type Section } from "../registry.js";
import {
  Allocation,
  BillingAdjustment,
  BillingPreview,
  BillingRun,
  DateStr,
  Id,
  Instant,
  Invoice,
  MessageJob,
  Payment,
  PaymentMethod,
  ProofMeta,
  ProofVerification,
  ReceiptSummary,
  pageOf,
  pageQuery,
  qParam,
  sortParam,
} from "../components.js";

const idParam = z.object({ id: Id });
const proofParam = z.object({ id: Id, fileId: Id });
const invoiceStatus = z.enum(["issued", "partially_paid", "paid", "void"]);

export const billingPaymentsSection: Section = section("3.6 Billing, invoices, payments", [
  // -------------------------------------------------------------------------
  // Billing (BIL-01..03)
  // -------------------------------------------------------------------------
  endpoint({
    id: "BIL-01",
    method: "post",
    path: "/billing/previews",
    auth: "owner",
    permission: "billing:manage",
    mutating: true,
    audit: "billing.preview",
    summary: "Preview a billing run",
    description:
      "Read-only: nothing is stored. The response carries `previewHash`, which BIL-02 must echo — a mismatch means the world moved (another run, a fee change) and answers 409 `PREVIEW_STALE` instead of issuing stale invoices (T-FIN-18).",
    tags: ["Billing"],
    body: z.strictObject({
      targetDate: DateStr,
      ageGroupIds: z.array(Id).optional(),
      playerIds: z.array(Id).optional(),
    }),
    responses: [res.json(200, BillingPreview, "What a run at this date would issue")],
    milestone: "m5",
  }),

  endpoint({
    id: "BIL-02",
    method: "post",
    path: "/billing/runs",
    auth: "owner",
    permission: "billing:manage",
    idempotent: true,
    mutating: true,
    audit: "billing.run",
    summary: "Run billing and issue invoices",
    description:
      "One transaction per run (T1), guarded by the unique `run_key` so a scheduler re-run or a double click cannot issue twice (T-FIN-01/02). `adjustments` are negative only. The optional WhatsApp queueing happens after commit through the message queue, never inside the money transaction.",
    tags: ["Billing"],
    body: z.strictObject({
      targetDate: DateStr,
      previewHash: z.string(),
      ageGroupIds: z.array(Id).optional(),
      playerIds: z.array(Id).optional(),
      adjustments: z.array(BillingAdjustment).optional(),
      queueWhatsApp: z.boolean().optional(),
    }),
    responses: [res.json(201, BillingRun, "The run and the invoices it created")],
    errors: ["PREVIEW_STALE", "ALREADY_INVOICED", "VALIDATION_ERROR"],
    milestone: "m5",
  }),

  endpoint({
    id: "BIL-03",
    operationId: "BIL-03.list",
    method: "get",
    path: "/billing/runs",
    auth: "owner",
    permission: "billing:manage",
    summary: "List billing runs",
    tags: ["Billing"],
    query: pageQuery,
    responses: [res.json(200, pageOf(BillingRun), "One page of runs")],
    milestone: "m5",
  }),

  endpoint({
    id: "BIL-03",
    operationId: "BIL-03.read",
    method: "get",
    path: "/billing/runs/{id}",
    auth: "owner",
    permission: "billing:manage",
    summary: "Read a billing run",
    tags: ["Billing"],
    params: idParam,
    responses: [res.json(200, BillingRun, "The run")],
    milestone: "m5",
  }),

  // -------------------------------------------------------------------------
  // Invoices (INV-01..08)
  // -------------------------------------------------------------------------
  endpoint({
    id: "INV-01",
    method: "get",
    path: "/invoices",
    auth: "owner",
    permission: "billing:manage",
    scope: "No coach policy exists on invoices — RLS denies the role entirely",
    summary: "List invoices",
    description:
      "List responses omit `items` and `allocations` (INV-02 only). `overdue` filters on the *derived* predicate (`due_date` vs academy-local today) — overdue is never stored (ADR-010).",
    tags: ["Billing"],
    query: pageQuery.extend({
      status: invoiceStatus.optional(),
      overdue: z.coerce.boolean().optional(),
      playerId: Id.optional(),
      guardianId: Id.optional(),
      ageGroupId: Id.optional(),
      issueFrom: DateStr.optional(),
      issueTo: DateStr.optional(),
      dueFrom: DateStr.optional(),
      dueTo: DateStr.optional(),
      q: qParam,
      sort: sortParam.describe("dueDate | issueDate | invoiceNumber | balanceMinor | playerName"),
    }),
    responses: [res.json(200, pageOf(Invoice), "One page of invoices")],
    errors: ["INVALID_SORT"],
    milestone: "m5",
  }),

  endpoint({
    id: "INV-02",
    method: "get",
    path: "/invoices/{id}",
    auth: "owner",
    permission: "billing:manage",
    summary: "Read an invoice with its lines",
    description:
      "Includes `items` and `allocations` (reversed allocations stay visible, flagged). Totals come from the invoice row and its snapshot, never from live settings or current fees (ADR-014).",
    tags: ["Billing"],
    params: idParam,
    responses: [res.json(200, Invoice, "The invoice with items and allocations")],
    milestone: "m5",
  }),

  endpoint({
    id: "INV-03",
    method: "post",
    path: "/invoices",
    auth: "owner",
    permission: "billing:manage",
    idempotent: true,
    mutating: true,
    audit: "invoice.create_manual",
    summary: "Issue a one-off (manual) invoice",
    description:
      "Creates a `kind='manual'` invoice with no billing period. Numbered from `document_counters` in the issuing transaction, so numbers stay sequential under concurrency (T-FIN-16).",
    tags: ["Billing"],
    body: z.strictObject({
      playerId: Id,
      description: z.string().min(2).max(200),
      amountMinor: z.number().int().positive(),
      dueDate: DateStr,
      guardianId: Id.optional(),
    }),
    responses: [res.json(201, Invoice, "Issued invoice")],
    errors: ["VALIDATION_ERROR"],
    milestone: "m5",
  }),

  endpoint({
    id: "INV-04",
    method: "post",
    path: "/invoices/{id}/void",
    auth: "owner",
    permission: "billing:manage",
    idempotent: true,
    mutating: true,
    audit: "invoice.void",
    summary: "Void an invoice",
    description:
      "Voiding revokes the public link tokens and cancels that invoice's unsent messages inside the same transaction (T5). Allocations block a void unless `releaseAllocations` returns them to the payment as credit; the scheduler will not recreate the period unless `allowReissue`.",
    tags: ["Billing"],
    params: idParam,
    body: z.strictObject({
      reason: z.string().min(5).max(200),
      releaseAllocations: z.boolean().optional(),
      allowReissue: z.boolean().optional(),
      version: z.number().int(),
    }),
    responses: [res.json(200, Invoice, "Voided invoice")],
    errors: [
      "INVOICE_HAS_ALLOCATIONS",
      "VERSION_CONFLICT",
      "REASON_REQUIRED",
      "INVALID_STATE_TRANSITION",
    ],
    milestone: "m5",
  }),

  endpoint({
    id: "INV-05",
    method: "post",
    path: "/invoices/{id}/adjustments",
    auth: "owner",
    permission: "billing:manage",
    idempotent: true,
    mutating: true,
    audit: "invoice.adjust",
    summary: "Append a negative adjustment",
    description:
      "The only post-issue change permitted (ADR-014). The amount must be negative and no larger in absolute value than the outstanding balance; the invoice's totals, `paid_minor` invariant and PDF staleness are updated in one transaction (T5-adjacent).",
    tags: ["Billing"],
    params: idParam,
    body: z.strictObject({
      amountMinor: z.number().int().negative(),
      reason: z.string().min(5).max(200),
      version: z.number().int(),
    }),
    responses: [res.json(200, Invoice, "Adjusted invoice")],
    errors: ["VERSION_CONFLICT", "REASON_REQUIRED", "INVOICE_VOID"],
    milestone: "m5",
  }),

  endpoint({
    id: "INV-06",
    method: "get",
    path: "/invoices/{id}/pdf",
    auth: "owner",
    permission: "files:read_sensitive",
    audit: "invoice.pdf.read",
    summary: "Download an invoice PDF",
    description:
      "A sensitive read, so it is audited (SECURITY §3 item 9). While the PDF is stale or absent the endpoint answers 409 `PDF_NOT_READY` with a `Retry-After` header rather than blocking; generation happens in the PDF worker after commit.",
    tags: ["Billing"],
    params: idParam,
    responses: [
      res.pdf("The invoice PDF", 200),
      {
        status: 409,
        description: "PDF_NOT_READY — request again after the `Retry-After` delay.",
      },
    ],
    errors: ["PDF_NOT_READY"],
    milestone: "m6",
  }),

  endpoint({
    id: "INV-07",
    method: "post",
    path: "/invoices/{id}/pdf/regenerate",
    auth: "owner",
    permission: "files:read_sensitive",
    mutating: true,
    audit: "invoice.pdf.regenerate",
    summary: "Regenerate an invoice PDF",
    description:
      "Rebuilds from the stored snapshot and items only — never from live settings or fees. Identical input ⇒ the same `pdf_input_hash` and no new file.",
    tags: ["Billing"],
    params: idParam,
    responses: [res.empty(202, "Queued for regeneration")],
    milestone: "m6",
  }),

  endpoint({
    id: "INV-08",
    method: "post",
    path: "/invoices/{id}/send",
    auth: "owner",
    permission: "messaging:manage",
    idempotent: true,
    mutating: true,
    audit: "invoice.send",
    summary: "Send an invoice over WhatsApp",
    description:
      "Enqueues `invoice_delivery` jobs (202). This is an explicit owner action, so the per-automation `invoiceDelivery` switch does not block it — master pause, provider health and per-guardian consent still do. Skipped jobs carry a `skipReason` instead of failing.",
    tags: ["Messaging"],
    params: idParam,
    body: z.strictObject({ guardianIds: z.array(Id).optional() }),
    responses: [
      res.json(202, z.object({ messageJobs: z.array(MessageJob) }), "Enqueued jobs"),
    ],
    errors: ["INVOICE_VOID", "IDEMPOTENCY_KEY_REUSED"],
    milestone: "m7",
  }),

  // -------------------------------------------------------------------------
  // Payments, allocations (PAY-01..08)
  // -------------------------------------------------------------------------
  endpoint({
    id: "PAY-01",
    method: "get",
    path: "/payments",
    auth: "owner",
    permission: "payments:manage",
    scope: "No coach policy — RLS denies the role entirely (T-DB-RLS-01)",
    summary: "List payments",
    tags: ["Billing"],
    query: pageQuery.extend({
      status: z.enum(["pending", "confirmed", "rejected", "reversed"]).optional(),
      methodCode: z.string().optional(),
      guardianId: Id.optional(),
      playerId: Id.optional(),
      from: Instant.optional(),
      to: Instant.optional(),
      q: qParam,
      hasCredit: z.coerce.boolean().optional(),
      sort: sortParam.describe("receivedAt | amountMinor"),
    }),
    responses: [res.json(200, pageOf(Payment), "One page of payments")],
    errors: ["INVALID_SORT"],
    milestone: "m5",
  }),

  endpoint({
    id: "PAY-02",
    method: "post",
    path: "/payments",
    auth: "owner",
    permission: "payments:manage",
    idempotent: true,
    mutating: true,
    audit: "payment.create",
    summary: "Record a payment",
    description:
      "Cash is recorded directly `confirmed`; a bank transfer is recorded `pending` until the owner confirms it — proof never confirms anything (ADR-013). `reference` is required when the method requires it and must be unique among pending/confirmed payments. Allocations may only accompany a confirmed payment: with `status:'pending'` they are refused 409 `PAYMENT_NOT_CONFIRMED`.",
    tags: ["Billing"],
    body: z.strictObject({
      amountMinor: z.number().int().positive(),
      methodCode: z.string().min(2).max(40),
      reference: z.string().max(120).optional(),
      receivedAt: Instant,
      payerGuardianId: Id.optional(),
      payerName: z.string().max(120).optional(),
      notes: z.string().max(1000).optional(),
      status: z.enum(["confirmed", "pending"]),
      allocations: z
        .array(z.strictObject({ invoiceId: Id, amountMinor: z.number().int().positive() }))
        .optional(),
    }),
    responses: [res.json(201, Payment, "Recorded payment")],
    errors: [
      "PAYMENT_DUPLICATE_REFERENCE",
      "PAYMENT_NOT_CONFIRMED",
      "ALLOCATION_EXCEEDS_BALANCE",
      "ALLOCATION_EXCEEDS_PAYMENT",
      "INVOICE_VOID",
      "VALIDATION_ERROR",
    ],
    milestone: "m5",
  }),

  endpoint({
    id: "PAY-03",
    operationId: "PAY-03.read",
    method: "get",
    path: "/payments/{id}",
    auth: "owner",
    permission: "payments:manage",
    summary: "Read a payment",
    tags: ["Billing"],
    params: idParam,
    responses: [res.json(200, Payment, "The payment with allocations and proofs")],
    milestone: "m5",
  }),

  endpoint({
    id: "PAY-03",
    operationId: "PAY-03.update",
    method: "patch",
    path: "/payments/{id}",
    auth: "owner",
    permission: "payments:manage",
    mutating: true,
    audit: "payment.update",
    summary: "Update a payment's non-financial fields",
    description:
      "`amountMinor` and the method are immutable: correcting either means reverse and re-record (PAY-07), so a mistake never silently rewrites history.",
    tags: ["Billing"],
    params: idParam,
    body: z.strictObject({
      reference: z.string().max(120).optional(),
      notes: z.string().max(1000).optional(),
      receivedAt: Instant.optional(),
      version: z.number().int(),
    }),
    responses: [res.json(200, Payment, "Updated payment")],
    errors: ["VERSION_CONFLICT", "PAYMENT_DUPLICATE_REFERENCE"],
    milestone: "m5",
  }),

  endpoint({
    id: "PAY-04",
    method: "post",
    path: "/payments/{id}/confirm",
    auth: "owner",
    permission: "payments:manage",
    idempotent: true,
    mutating: true,
    audit: "payment.confirm",
    summary: "Confirm a pending payment",
    description:
      "THE only action that changes a balance (ADR-013/ADR-020). Runs T2: lock the payment, set `confirmed`, write allocations, update invoice `paid_minor`/status (locks taken payment → invoices ascending id), create the receipt row and audit — one transaction. **Never called by an automation**: proof checks (PRF-04) are advisory and cannot reach this path.",
    tags: ["Billing"],
    params: idParam,
    body: z.strictObject({
      allocations: z
        .array(z.strictObject({ invoiceId: Id, amountMinor: z.number().int().positive() }))
        .optional(),
      version: z.number().int(),
    }),
    responses: [res.json(200, Payment, "Confirmed payment with receipt")],
    errors: [
      "INVALID_STATE_TRANSITION",
      "ALLOCATION_EXCEEDS_BALANCE",
      "ALLOCATION_EXCEEDS_PAYMENT",
      "INVOICE_VOID",
      "VERSION_CONFLICT",
    ],
    milestone: "m5",
  }),

  endpoint({
    id: "PAY-05",
    method: "post",
    path: "/payments/{id}/reject",
    auth: "owner",
    permission: "payments:manage",
    idempotent: true,
    mutating: true,
    audit: "payment.reject",
    summary: "Reject a pending payment",
    description:
      "From `pending` only; nothing is allocated and no receipt is created. Rejection is how a proof that does not check out is closed without touching any balance (T-FIN-09).",
    tags: ["Billing"],
    params: idParam,
    body: z.strictObject({
      reason: z.string().min(5).max(200),
      version: z.number().int(),
    }),
    responses: [res.json(200, Payment, "Rejected payment")],
    errors: ["INVALID_STATE_TRANSITION", "VERSION_CONFLICT", "REASON_REQUIRED"],
    milestone: "m5",
  }),

  endpoint({
    id: "PAY-06",
    method: "post",
    path: "/payments/{id}/allocate",
    auth: "owner",
    permission: "payments:manage",
    idempotent: true,
    mutating: true,
    audit: "payment.allocate",
    summary: "Allocate a confirmed payment's credit",
    description:
      "T3: same lock order as T2 without a status change. The sum of active allocations may never exceed the payment amount (surplus stays credit) nor an invoice's outstanding balance (T-FIN-06/07).",
    tags: ["Billing"],
    params: idParam,
    body: z.strictObject({
      allocations: z
        .array(z.strictObject({ invoiceId: Id, amountMinor: z.number().int().positive() }))
        .min(1),
      version: z.number().int(),
    }),
    responses: [res.json(200, Payment, "Payment with updated allocations")],
    errors: [
      "INVALID_STATE_TRANSITION",
      "ALLOCATION_EXCEEDS_BALANCE",
      "ALLOCATION_EXCEEDS_PAYMENT",
      "INVOICE_VOID",
      "VERSION_CONFLICT",
    ],
    milestone: "m5",
  }),

  endpoint({
    id: "PAY-07",
    method: "post",
    path: "/payments/{id}/reverse",
    auth: "owner",
    permission: "payments:manage",
    idempotent: true,
    mutating: true,
    audit: "payment.reverse",
    summary: "Reverse a confirmed payment",
    description:
      "T4: the payment becomes `reversed`, its active allocations are reversed, the affected invoices are recomputed and the receipt is voided — all in one transaction. Reversal is the correction path (never an edit of the original row).",
    tags: ["Billing"],
    params: idParam,
    body: z.strictObject({
      reason: z.string().min(5).max(200),
      version: z.number().int(),
    }),
    responses: [res.json(200, Payment, "Reversed payment")],
    errors: ["INVALID_STATE_TRANSITION", "VERSION_CONFLICT", "REASON_REQUIRED"],
    milestone: "m5",
  }),

  endpoint({
    id: "PAY-08",
    method: "get",
    path: "/payments/{id}/allocation-suggestion",
    auth: "owner",
    permission: "payments:manage",
    summary: "Suggest allocations oldest-due-first",
    description:
      "Read-only helper for the record-payment screen. CONTRACT GAP: the path carries a payment id while the suggestion is keyed by guardian and needs no existing payment, so the frontend calls it with the literal `new` when recording (recorded in the Step 5 handoff §4); `{id}` is therefore a **plain string here, not a uuid** — a real id means the payment's own unallocated remainder is on offer, anything else (the literal `new`) means the guardian's credit. `{id}` is documented as open until Claude resolves the path.",
    tags: ["Billing"],
    // Deliberately not `idParam`: the documented `new` literal must reach the handler. The
    // handler decides from the value, so a uuid cast here would turn the contract's own
    // recorded gap into a 422.
    params: z.object({ id: z.string().min(1) }),
    query: z.object({ guardianId: Id }),
    responses: [
      res.json(
        200,
        z.object({
          suggested: z.array(z.object({ invoiceId: Id, amountMinor: z.number().int().positive() })),
          creditMinor: z.number().int(),
        }),
        "Suggested allocations and available credit",
      ),
    ],
    milestone: "m5",
  }),

  // -------------------------------------------------------------------------
  // Proofs (PRF-01..04) — evidence, never payment
  // -------------------------------------------------------------------------
  endpoint({
    id: "PRF-01",
    method: "post",
    path: "/payments/{id}/proofs",
    auth: "owner",
    permission: "payments:manage",
    scope: "Owner only; RLS denies coaches entirely — extracted values are proof-class PII",
    mutating: true,
    audit: "payment.proof.upload",
    summary: "Upload a payment proof",
    description:
      "multipart/form-data with a `file` part (and optional `note`). PDF/JPEG/PNG/WebP ≤ 5 MB, at most 5 per payment; the type is decided by sniffed magic bytes, not the extension. For a bank transfer the bank's **PDF e-receipt** is what can be verified: an image is stored as `docKind='bank_receipt_image'` as supporting evidence only and can never produce a passing check (PAYMENT_VERIFICATION §1). Uploading never changes the payment's status or any balance.",
    tags: ["Billing"],
    params: idParam,
    bodyContentType: "multipart/form-data",
    body: z.strictObject({
      file: z.string().openapi({ format: "binary" }).describe("PDF/JPEG/PNG/WebP, ≤ 5 MB"),
      note: z.string().max(500).optional(),
    }),
    responses: [res.json(201, ProofMeta, "Stored proof metadata")],
    errors: ["FILE_TOO_LARGE", "UNSUPPORTED_FILE_TYPE"],
    milestone: "m6",
  }),

  endpoint({
    id: "PRF-02",
    method: "get",
    path: "/payments/{id}/proofs/{fileId}/download",
    auth: "owner",
    permission: "files:read_sensitive",
    audit: "payment.proof.read",
    summary: "Get a short-lived proof URL",
    description:
      "Returns a signed URL valid for at most 5 minutes (never a public bucket URL). The read is audited, because the file contains the guardian's bank details.",
    tags: ["Billing"],
    params: proofParam,
    responses: [
      res.json(
        200,
        z.object({ url: z.string(), expiresAt: Instant }),
        "Signed private URL",
      ),
    ],
    errors: ["DEPENDENCY_UNAVAILABLE"],
    milestone: "m6",
  }),

  endpoint({
    id: "PRF-03",
    method: "delete",
    path: "/payments/{id}/proofs/{fileId}",
    auth: "owner",
    permission: "payments:manage",
    mutating: true,
    audit: "payment.proof.delete",
    summary: "Delete a proof",
    description:
      "Only while the payment is `pending`; the metadata row is kept with `deleted_at` so the audit trail of what was submitted survives (DATABASE §6).",
    tags: ["Billing"],
    params: proofParam,
    responses: [res.empty(204, "Deleted")],
    errors: ["INVALID_STATE_TRANSITION"],
    milestone: "m5",
  }),

  endpoint({
    id: "PRF-04",
    method: "post",
    path: "/payments/{id}/proofs/{fileId}/verify",
    auth: "owner",
    permission: "payments:manage",
    mutating: true,
    audit: "payment.proof.verify",
    summary: "Re-run the deterministic receipt checks",
    description:
      "Runs the sandboxed L1/L2 extraction + cross-check (no rendering, no network, bounded CPU/memory) and stores findings with a parser version. **Advisory only:** a receipt that checks out perfectly leaves the payment exactly as it was — `pending` stays `pending`, `PAY-04` remains the owner's decision, and no balance, allocation, receipt or invoice status changes (T-VER-04). Allowed even when `SET-08.proofCheck` is off, because that switch governs automatic checking on upload.",
    tags: ["Billing"],
    params: proofParam,
    responses: [res.json(200, ProofVerification, "Findings, extracted values and parser version")],
    errors: ["INVALID_STATE_TRANSITION", "UNSUPPORTED_FILE_TYPE"],
    milestone: "m5",
  }),

  // -------------------------------------------------------------------------
  // Receipts (RCT-01..02) and the public invoice link (PUB-01)
  // -------------------------------------------------------------------------
  endpoint({
    id: "RCT-01",
    method: "get",
    path: "/receipts",
    auth: "owner",
    permission: "payments:manage",
    summary: "List receipts",
    tags: ["Billing"],
    query: pageQuery.extend({
      paymentId: Id.optional(),
      from: Instant.optional(),
      to: Instant.optional(),
    }),
    responses: [res.json(200, pageOf(ReceiptSummary), "One page of receipts")],
    milestone: "m5",
  }),

  endpoint({
    id: "RCT-02",
    operationId: "RCT-02.download",
    method: "get",
    path: "/receipts/{id}/pdf",
    auth: "owner",
    permission: "files:read_sensitive",
    audit: "receipt.pdf.read",
    summary: "Download a receipt PDF",
    description: "A receipt exists only for a confirmed payment (T-FIL-13); a reversal watermarks it on regeneration.",
    tags: ["Billing"],
    params: idParam,
    responses: [res.pdf("The receipt PDF")],
    errors: ["PDF_NOT_READY"],
    milestone: "m6",
  }),

  endpoint({
    id: "RCT-02",
    operationId: "RCT-02.regenerate",
    method: "post",
    path: "/receipts/{id}/pdf/regenerate",
    auth: "owner",
    permission: "files:read_sensitive",
    mutating: true,
    audit: "receipt.pdf.regenerate",
    summary: "Regenerate a receipt PDF",
    tags: ["Billing"],
    params: idParam,
    responses: [res.empty(202, "Queued for regeneration")],
    milestone: "m6",
  }),

  endpoint({
    id: "PUB-01",
    method: "get",
    path: "/public/invoices/{token}/pdf",
    auth: "public",
    summary: "Fetch an invoice PDF with a capability URL",
    description:
      "The guardian-facing link. The token is validated by SHA-256 hash, expiry and revocation; **every** failure kind (unknown, expired, revoked, voided invoice) answers an identical 404 so nothing can be enumerated, and the response carries `Cache-Control: no-store` and `Referrer-Policy: no-referrer`. Rate-limited per IP; each successful use increments `use_count`. A void invoice revokes its tokens.",
    tags: ["Public"],
    params: z.object({ token: z.string().min(20).max(200) }),
    rateLimit: "public_invoice",
    responses: [
      res.pdf("The invoice PDF"),
      { status: 404, description: "NOT_FOUND — uniform for every failure kind." },
    ],
    errors: ["RATE_LIMITED"],
    milestone: "m6",
  }),
]);
