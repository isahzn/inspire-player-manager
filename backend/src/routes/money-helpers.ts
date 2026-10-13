/**
 * Shared money logic for PAY-01..08, PRF-03/04 and RCT-01 (BILLING_ENGINE §11, DATABASE §8).
 *
 * The **lock order is the reason this file exists**. T2/T3/T4 all say the same thing:
 * *lock the payment, then the invoices in ascending id order*. Two owners confirming two
 * payments that touch the same invoice must not deadlock, and neither may read a balance
 * that another transaction is about to change — so every path that moves money goes through
 * `applyAllocations`/`reverseAllocations` here rather than writing its own UPDATE.
 *
 * Everything else is deliberately boring: amounts are integers, the invoice's own status is
 * *derived* from `paid_minor`/`total_minor` (never guessed from the caller's intent), and the
 * database's deferred triggers re-check the arithmetic at commit (0012). If a number here and
 * the number in the trigger disagree, the transaction fails rather than committing quietly.
 */
import type { PoolClient } from "pg";
import { ApiError, errors } from "../errors.js";
import { uuidv7 } from "../ids.js";
import type {
  AllocationRow,
  InvoiceFullRow,
  InvoiceItemRow,
  InvoiceRow,
  PaymentRow,
  ProofRow,
  RawVerification,
  ReceiptRow,
} from "./money-serialize.js";

/**
 * The invoice projection the allocation paths read.
 *
 * It deliberately carries **no age group**: `invoices` has no `age_group_id` column, because
 * the group an invoice was billed under is part of its `snapshot` (DATABASE §4), written by the
 * billing run that issued it. The `INV-*` serializers are the ones that read the snapshot; the
 * money paths here need the invoice's identity, its balance and its status, and guessing the
 * group from the player's current history would report a group the invoice was never billed
 * under. `for update of i` is used so a lock is taken on `invoices` alone.
 */
export const INVOICE_SELECT = `select i.id, i.invoice_number, i.kind, i.player_id,
          p.full_name as player_name, p.registration_no,
          i.guardian_id, g.full_name as guardian_name,
          i.period_start, i.period_end, i.issue_date, i.due_date, i.status, i.currency,
          i.subtotal_minor::text, i.adjustments_minor::text, i.total_minor::text,
          i.paid_minor::text, i.balance_minor::text, i.version,
          i.voided_at, i.void_reason
     from invoices i
     join players p on p.id = i.player_id
     left join guardians g on g.id = i.guardian_id`;

/**
 * The **full** invoice projection the INV-* surface reads.
 *
 * It is wider than `INVOICE_SELECT` above, and deliberately so: that one is the narrow shape
 * the allocation paths lock and recompute, while this one carries the snapshot, the PDF flag
 * and the derived `overdue` pair (ADR-010: measured against the academy's own today, never
 * stored). Keeping both here is what stops a second, drifting definition of "an invoice"
 * appearing in the route files.
 */
export const INVOICE_FULL_SELECT = `select i.id, i.invoice_number, i.kind, i.status, i.player_id,
          p.full_name as player_name, p.registration_no,
          i.guardian_id, g.full_name as guardian_name,
          i.period_start, i.period_end, i.issue_date, i.due_date, i.currency,
          i.subtotal_minor::text, i.adjustments_minor::text, i.total_minor::text,
          i.paid_minor::text, i.balance_minor::text, i.version,
          i.voided_at, i.void_reason, i.pdf_file_id, i.snapshot,
          (i.status in ('issued','partially_paid') and i.due_date < a.today) as overdue,
          case when i.status in ('issued','partially_paid') and i.due_date < a.today
               then (a.today - i.due_date) else 0 end as days_overdue
     from invoices i
     join players p on p.id = i.player_id
     left join guardians g on g.id = i.guardian_id
     cross join lateral (select (now() at time zone timezone)::date as today
                           from academy_settings where id = 1) a`;

export async function loadInvoiceFull(
  client: PoolClient,
  id: string,
): Promise<InvoiceFullRow | null> {
  const result = await client.query<InvoiceFullRow>(`${INVOICE_FULL_SELECT} where i.id = $1`, [id]);
  return result.rows[0] ?? null;
}

/** An invoice's lines, in the order they were appended. */
export async function invoiceItems(
  client: PoolClient,
  invoiceId: string,
): Promise<InvoiceItemRow[]> {
  const result = await client.query<InvoiceItemRow>(
    `select id, invoice_id, line_no, item_type, description, quantity,
            unit_amount_minor::text, amount_minor::text, reason
       from invoice_items where invoice_id = $1 order by line_no asc`,
    [invoiceId],
  );
  return result.rows;
}

/**
 * Every allocation pointing at one invoice, reversed ones included.
 *
 * Reversed rows are kept in the response because a reversal is part of the invoice's history
 * (DATABASE §3.3): hiding it would make the payment's own record and the invoice's disagree.
 */
export async function allocationsForInvoice(
  client: PoolClient,
  invoiceId: string,
): Promise<AllocationRow[]> {
  const result = await client.query<AllocationRow>(
    `select a.id, a.payment_id, a.invoice_id, i.invoice_number,
            a.amount_minor::text, a.allocated_at, a.reversed_at
       from payment_allocations a
       join invoices i on i.id = a.invoice_id
      where a.invoice_id = $1
      order by a.allocated_at asc, a.id asc`,
    [invoiceId],
  );
  return result.rows;
}

/** A payment projection with its method row and payer name already joined. */
export const PAYMENT_SELECT = `select pm.id, pm.amount_minor::text, pm.currency,
          pm.method_code, m.label as method_label,
          m.requires_reference, m.is_active as method_is_active,
          pm.reference, pm.received_at, pm.payer_guardian_id,
          g.full_name as payer_guardian_name, pm.payer_name, pm.status,
          pm.confirmed_at, pm.rejected_at, pm.rejected_reason,
          pm.reversed_at, pm.reversed_reason, pm.notes,
          pm.allocated_minor::text, pm.version, pm.created_at
     from payments pm
     join payment_methods m on m.code = pm.method_code
     left join guardians g on g.id = pm.payer_guardian_id`;

export const PROOF_SELECT = `select pp.id, pp.payment_id, pp.file_id, pp.uploaded_by,
          u.full_name as uploaded_by_name, pp.note, pp.doc_kind, pp.verification,
          pp.checked_at, pp.created_at, pp.deleted_at,
          f.storage_key, f.mime_type, f.size_bytes::text, f.sha256, f.original_name
     from payment_proofs pp
     join files f on f.id = pp.file_id
     join users u on u.id = pp.uploaded_by`;

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------
export async function loadPayment(client: PoolClient, id: string): Promise<PaymentRow | null> {
  const result = await client.query<PaymentRow>(`${PAYMENT_SELECT} where pm.id = $1`, [id]);
  return result.rows[0] ?? null;
}

export async function loadPaymentForUpdate(
  client: PoolClient,
  id: string,
): Promise<PaymentRow | null> {
  const result = await client.query<PaymentRow>(
    `${PAYMENT_SELECT} where pm.id = $1 for update of pm`,
    [id],
  );
  return result.rows[0] ?? null;
}

export async function loadInvoice(client: PoolClient, id: string): Promise<InvoiceRow | null> {
  const result = await client.query<InvoiceRow>(`${INVOICE_SELECT} where i.id = $1`, [id]);
  return result.rows[0] ?? null;
}

/**
 * Locks every named invoice **in ascending id order** — the order T2/T3/T4 prescribe, and
 * the one thing that keeps concurrent confirmations from deadlocking.
 */
export async function lockInvoices(
  client: PoolClient,
  invoiceIds: string[],
): Promise<Map<string, InvoiceRow>> {
  const ids = [...new Set(invoiceIds)].sort();
  if (ids.length === 0) return new Map();
  const result = await client.query<InvoiceRow>(
    `${INVOICE_SELECT} where i.id = any ($1::uuid[]) order by i.id for update of i`,
    [ids],
  );
  return new Map(result.rows.map((row) => [row.id, row]));
}

/** All allocations of a payment, active and reversed, with the invoice number attached. */
export async function allocationsForPayment(
  client: PoolClient,
  paymentId: string,
): Promise<AllocationRow[]> {
  const result = await client.query<AllocationRow>(
    `select a.id, a.payment_id, a.invoice_id, i.invoice_number,
            a.amount_minor::text, a.allocated_at, a.reversed_at
       from payment_allocations a
       join invoices i on i.id = a.invoice_id
      where a.payment_id = $1
      order by a.allocated_at asc, a.id asc`,
    [paymentId],
  );
  return result.rows;
}

/** Proofs of a payment. Deleted rows are metadata the audit trail keeps (PRF-03). */
export async function proofsForPayment(
  client: PoolClient,
  paymentId: string,
  opts: { includeDeleted?: boolean } = {},
): Promise<ProofRow[]> {
  const result = await client.query<ProofRow>(
    `${PROOF_SELECT}
      where pp.payment_id = $1 ${opts.includeDeleted ? "" : "and pp.deleted_at is null"}
      order by pp.created_at asc, pp.id asc`,
    [paymentId],
  );
  return result.rows;
}

export async function loadReceiptForPayment(
  client: PoolClient,
  paymentId: string,
): Promise<ReceiptRow | null> {
  const result = await client.query<ReceiptRow>(
    `select id, receipt_number, payment_id, issued_at, file_id, voided_at
       from receipts where payment_id = $1`,
    [paymentId],
  );
  return result.rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Balances (PLY-11, GDN-06 — BILLING_ENGINE §12)
// ---------------------------------------------------------------------------
/**
 * Outstanding and overdue across a set of players' **open** invoices.
 *
 * `outstanding` is `Σ balance_minor` over `issued`/`partially_paid` — void invoices never
 * count (§10), and a paid one has a zero balance anyway. `overdue` is the same sum limited to
 * the derived predicate (`due_date < today` in the academy's own timezone, §12) — measured as
 * of *now*, never stored (ADR-010).
 */
export async function playerBalanceTotals(
  client: PoolClient,
  playerIds: string[],
): Promise<{ outstandingMinor: number; overdueMinor: number }> {
  if (playerIds.length === 0) return { outstandingMinor: 0, overdueMinor: 0 };
  const result = await client.query<{ outstanding: string; overdue: string }>(
    `select coalesce(sum(i.balance_minor), 0)::text as outstanding,
            coalesce(sum(i.balance_minor) filter (where i.due_date < a.today), 0)::text as overdue
       from invoices i
       cross join lateral (select (now() at time zone timezone)::date as today
                             from academy_settings where id = 1) a
      where i.player_id = any ($1::uuid[])
        and i.status in ('issued', 'partially_paid')`,
    [playerIds],
  );
  const row = result.rows[0]!;
  return { outstandingMinor: Number(row.outstanding), overdueMinor: Number(row.overdue) };
}

/**
 * Credit held by a set of guardians (BILLING_ENGINE §11): the unallocated remainder of every
 * **confirmed** payment they made. It is never netted into an outstanding figure (T-RPT-02) —
 * the caller reports it separately — and it is never auto-applied (OPEN-007).
 */
export async function creditForGuardians(
  client: PoolClient,
  guardianIds: string[],
): Promise<number> {
  if (guardianIds.length === 0) return 0;
  const result = await client.query<{ credit: string }>(
    `select coalesce(sum(p.amount_minor - p.allocated_minor), 0)::text as credit
       from payments p
      where p.status = 'confirmed' and p.payer_guardian_id = any ($1::uuid[])`,
    [guardianIds],
  );
  return Number(result.rows[0]!.credit);
}

export interface PaymentDetail {
  allocations: AllocationRow[];
  proofs: ProofRow[];
  receipt: ReceiptRow | null;
}

/**
 * Everything PAY-03.read returns, in three queries rather than one per row.
 *
 * Proofs that were deleted are **left out**: keeping the row is what preserves the audit trail
 * of what was submitted (PRF-03, DATABASE §6), but a deleted proof must not reappear in the
 * owner's list. `allocationsForPayment` does include reversed ones, because a reversal is part
 * of the payment's history rather than something to hide.
 */
export async function loadPaymentDetail(
  client: PoolClient,
  paymentId: string,
): Promise<PaymentDetail> {
  const [allocations, proofs, receipt] = await Promise.all([
    allocationsForPayment(client, paymentId),
    proofsForPayment(client, paymentId),
    loadReceiptForPayment(client, paymentId),
  ]);
  return { allocations, proofs, receipt };
}

// ---------------------------------------------------------------------------
// Document numbers (`INV-2026-000123`, `RCT-2026-000045`)
// ---------------------------------------------------------------------------
export type DocumentName = "invoice" | "receipt";

/**
 * Allocates the next gapless number for the academy-local year.
 *
 * `UPDATE … RETURNING` on `document_counters` takes the row lock, so two concurrent
 * confirmations cannot mint the same number; the counter is only advanced inside the caller's
 * transaction, so a rolled-back receipt does not burn a number.
 */
export async function nextDocumentNumber(
  client: PoolClient,
  name: DocumentName,
  timezone: string,
): Promise<string> {
  const result = await client.query<{ year: number; value: string }>(
    `with y as (select extract(year from (now() at time zone $2))::int as year),
          bumped as (
            insert into document_counters (name, year, next_value)
            select $1, y.year, 2 from y
            on conflict (name, year) do update
              set next_value = document_counters.next_value + 1
            returning year, next_value - 1 as value
          )
     select year, value::text from bumped`,
    [name, timezone],
  );
  const row = result.rows[0]!;
  const prefix = name === "invoice" ? "INV" : "RCT";
  return `${prefix}-${row.year}-${row.value.padStart(6, "0")}`;
}

/**
 * Issues a payment's receipt — **in the transaction that confirmed the payment**, never
 * afterwards (T2, BILLING_ENGINE §11).
 *
 * Two things follow from that and both matter: a payment can never be confirmed without a
 * receipt existing for it, and a rolled-back confirmation burns no number (the counter moves
 * inside the caller's transaction). `on conflict (payment_id) do nothing` makes it safe to
 * call from either confirmation path; the receipt's PDF is M6's job (RCT-02), so `file_id`
 * stays null and `pdf_stale` keeps its default of true.
 */
export async function issueReceipt(
  client: PoolClient,
  args: { paymentId: string; timezone: string },
): Promise<void> {
  await client.query(
    `insert into receipts (id, receipt_number, payment_id)
     values ($1, $2, $3)
     on conflict (payment_id) do nothing`,
    [uuidv7(), await nextDocumentNumber(client, "receipt", args.timezone), args.paymentId],
  );
}

// ---------------------------------------------------------------------------
// Invoice state
// ---------------------------------------------------------------------------
/**
 * Recomputes an invoice from its **active allocations** and writes the result.
 *
 * The status is a pure function of `paid_minor` and `total_minor` (BILLING_ENGINE §10), so it
 * is derived here rather than passed in — a caller cannot mark an invoice paid by saying so.
 * `pdf_stale` is set in the same statement: the invoice's PDF now shows the wrong balance.
 */
export async function recomputeInvoice(client: PoolClient, invoiceId: string): Promise<void> {
  await client.query(
    `with active as (
       select coalesce(sum(amount_minor), 0) as paid
         from payment_allocations
        where invoice_id = $1 and reversed_at is null
     )
     update invoices i
        set paid_minor = least(active.paid, i.total_minor),
            status = case
              when i.status = 'void' then 'void'
              when least(active.paid, i.total_minor) = i.total_minor then 'paid'
              when active.paid > 0 then 'partially_paid'
              else 'issued'
            end,
            pdf_stale = true
       from active
      where i.id = $1`,
    [invoiceId],
  );
}

// ---------------------------------------------------------------------------
// Allocations — T2 (confirm) and T3 (allocate credit)
// ---------------------------------------------------------------------------
export interface AllocationInput {
  invoiceId: string;
  amountMinor: number;
}

export interface ApplyAllocationsArgs {
  paymentId: string;
  allocations: AllocationInput[];
  userId: string;
  /** When given, the payment must still be at this version (optimistic locking). */
  expectedVersion?: number;
}

/**
 * Writes allocations and recomputes every invoice they touch — one transaction, in the
 * documented lock order (payment → invoices ascending id).
 *
 * Refusals are the contract's own codes, and each one is checked **before** anything is
 * written, so a rejected request leaves no partial allocation behind:
 *  - a `pending` payment cannot carry allocations (409 `PAYMENT_NOT_CONFIRMED`);
 *  - a `rejected`/`reversed` one is a dead end (409 `INVALID_STATE_TRANSITION`);
 *  - more than the payment's remaining credit (409 `ALLOCATION_EXCEEDS_PAYMENT`);
 *  - more than an invoice's balance (409 `ALLOCATION_EXCEEDS_BALANCE`);
 *  - an invoice that was voided (409 `INVOICE_VOID`).
 */
export async function applyAllocations(
  client: PoolClient,
  args: ApplyAllocationsArgs,
): Promise<void> {
  if (args.allocations.length === 0) return;

  // 1. Lock the payment first — always this order, or two confirmations deadlock.
  const payment = await loadPaymentForUpdate(client, args.paymentId);
  if (!payment) throw errors.notFound();
  if (args.expectedVersion !== undefined && payment.version !== args.expectedVersion) {
    throw errors.versionConflict();
  }
  if (payment.status === "pending") {
    throw new ApiError(
      "PAYMENT_NOT_CONFIRMED",
      "Confirm the payment before allocating it to invoices.",
    );
  }
  if (payment.status === "rejected" || payment.status === "reversed") {
    throw new ApiError(
      "INVALID_STATE_TRANSITION",
      `A ${payment.status} payment cannot be allocated.`,
    );
  }

  const requested = args.allocations.reduce((sum, a) => sum + a.amountMinor, 0);
  const remaining = Number(payment.amount_minor) - Number(payment.allocated_minor);
  if (requested > remaining) {
    throw new ApiError(
      "ALLOCATION_EXCEEDS_PAYMENT",
      "The allocations are more than this payment has left to allocate.",
      [
        {
          field: "allocations",
          issue: `Requested ${requested} minor units but only ${remaining} are unallocated.`,
        },
      ],
    );
  }

  // 2. Then the invoices, in ascending id order.
  const locked = await lockInvoices(
    client,
    args.allocations.map((allocation) => allocation.invoiceId),
  );

  const activeNow = new Map<string, number>();
  const existing = await client.query<{ invoice_id: string; paid: string }>(
    `select invoice_id, coalesce(sum(amount_minor), 0)::text as paid
       from payment_allocations
      where invoice_id = any ($1::uuid[]) and reversed_at is null
      group by invoice_id`,
    [[...locked.keys()]],
  );
  for (const row of existing.rows) {
    activeNow.set(row.invoice_id, Number(row.paid));
  }

  for (const allocation of args.allocations) {
    const invoice = locked.get(allocation.invoiceId);
    if (!invoice) {
      throw new ApiError("NOT_FOUND", "That invoice does not exist.");
    }
    if (invoice.status === "void") {
      throw new ApiError("INVOICE_VOID", "A voided invoice cannot receive money.");
    }
    const alreadyPaid = activeNow.get(allocation.invoiceId) ?? 0;
    const balance = Number(invoice.total_minor) - alreadyPaid;
    if (allocation.amountMinor > balance) {
      throw new ApiError(
        "ALLOCATION_EXCEEDS_BALANCE",
        "The allocation is more than the invoice still owes.",
        [
          {
            field: "allocations",
            issue:
              `Invoice ${invoice.invoice_number} has a balance of ${balance} minor units ` +
              `but ${allocation.amountMinor} were allocated.`,
          },
        ],
      );
    }
  }

  // 3. Write, then reconcile both sides. The allocation must be visible to the cache update,
  //    so the inserts come first and the two UPDATEs read the rows back.
  for (const allocation of args.allocations) {
    await client.query(
      `insert into payment_allocations
         (id, payment_id, invoice_id, amount_minor, allocated_by)
       values ($1, $2, $3, $4, $5)`,
      [uuidv7(), args.paymentId, allocation.invoiceId, allocation.amountMinor, args.userId],
    );
  }

  await client.query(
    `update payments p
        set allocated_minor = (
          select coalesce(sum(a.amount_minor), 0)
            from payment_allocations a
           where a.payment_id = p.id and a.reversed_at is null
        )
      where p.id = $1`,
    [args.paymentId],
  );

  for (const invoiceId of locked.keys()) {
    await recomputeInvoice(client, invoiceId);
  }
}

export interface ReverseAllocationsArgs {
  paymentId: string;
  userId: string;
  reason: string;
}

/**
 * T4: stamps every active allocation as reversed, recomputes the invoices it releases and
 * resets the payment's cache to zero. Returns the invoice ids that changed, so the caller can
 * report exactly what it moved.
 *
 * Rows are **never deleted** (DATABASE §3.3): a reversed allocation is part of the record.
 */
export async function reverseAllocations(
  client: PoolClient,
  args: ReverseAllocationsArgs,
): Promise<string[]> {
  const payment = await loadPaymentForUpdate(client, args.paymentId);
  if (!payment) throw errors.notFound();

  const active = await allocationsForPayment(client, args.paymentId);
  const invoiceIds = [...new Set(active.filter((a) => !a.reversed_at).map((a) => a.invoice_id))];
  await lockInvoices(client, invoiceIds);

  await client.query(
    `update payment_allocations
        set reversed_at = now(), reversed_by = $2, reverse_reason = $3
      where payment_id = $1 and reversed_at is null`,
    [args.paymentId, args.userId, args.reason],
  );

  await client.query(
    `update payments p
        set allocated_minor = (
          select coalesce(sum(a.amount_minor), 0)
            from payment_allocations a
           where a.payment_id = p.id and a.reversed_at is null
        )
      where p.id = $1`,
    [args.paymentId],
  );

  for (const invoiceId of invoiceIds) {
    await recomputeInvoice(client, invoiceId);
  }
  return invoiceIds;
}

/**
 * Releases every active allocation **of one invoice**, returning the money to the payments as
 * credit — the mirror of `reverseAllocations`, and what INV-04's `releaseAllocations` does.
 *
 * The lock order is the same one T2/T3/T4 prescribe, and it is taken in the same direction:
 * the affected **payments** (ascending id) first, then the invoices (ascending id, this one
 * among them). Starting from an invoice does not license locking the invoices first — two
 * transactions that did that in opposite orders would deadlock.
 *
 * Returns the payments it freed money on, so the caller can say what actually moved.
 */
export async function releaseAllocationsForInvoice(
  client: PoolClient,
  args: { invoiceId: string; userId: string; reason: string },
): Promise<{ paymentIds: string[]; releasedMinor: number }> {
  const active = await client.query<{ payment_id: string; amount_minor: string }>(
    `select payment_id, amount_minor::text from payment_allocations
      where invoice_id = $1 and reversed_at is null
      order by payment_id asc`,
    [args.invoiceId],
  );
  if (active.rows.length === 0) return { paymentIds: [], releasedMinor: 0 };

  const paymentIds = [...new Set(active.rows.map((row) => row.payment_id))].sort();
  for (const paymentId of paymentIds) {
    const locked = await loadPaymentForUpdate(client, paymentId);
    if (!locked) throw errors.notFound();
  }
  // …then this invoice. (`lockInvoices` sorts and de-duplicates; here there is only one, and
  // it is deliberately the *last* lock taken so the order stays payment → invoices.)
  await lockInvoices(client, [args.invoiceId]);

  await client.query(
    `update payment_allocations
        set reversed_at = now(), reversed_by = $2, reverse_reason = $3
      where invoice_id = $1 and reversed_at is null`,
    [args.invoiceId, args.userId, args.reason],
  );

  for (const paymentId of paymentIds) {
    await client.query(
      `update payments p
          set allocated_minor = (
            select coalesce(sum(a.amount_minor), 0)
              from payment_allocations a
             where a.payment_id = p.id and a.reversed_at is null
          )
        where p.id = $1`,
      [paymentId],
    );
  }
  await recomputeInvoice(client, args.invoiceId);

  return {
    paymentIds,
    releasedMinor: active.rows.reduce((sum, row) => sum + Number(row.amount_minor), 0),
  };
}

// ---------------------------------------------------------------------------
// PAY-08 — allocation suggestion
// ---------------------------------------------------------------------------
export interface AllocationSuggestion {
  suggested: { invoiceId: string; amountMinor: number }[];
  creditMinor: number;
}

/**
 * Oldest `due_date` first, then `invoice_number`, across every open invoice of the payer
 * guardian's players (BILLING_ENGINE §11). Greedy: each invoice takes what it still owes
 * until the money runs out, and anything left over is reported as credit.
 *
 * Read-only — nothing here writes, and the owner may edit the result before submitting.
 */
export async function suggestAllocations(
  client: PoolClient,
  args: { guardianId: string; availableMinor: number },
): Promise<AllocationSuggestion> {
  const open = await client.query<{ id: string; balance_minor: string }>(
    `select i.id, i.balance_minor::text
       from invoices i
      where i.status in ('issued','partially_paid')
        and i.balance_minor > 0
        -- Every open invoice of this guardian: the ones billed to them and the ones for
        -- players they are linked to (siblings pay on one transfer — BILLING_ENGINE §11).
        and (i.guardian_id = $1
             or i.player_id in (select player_id from player_guardians where guardian_id = $1))
      order by i.due_date asc, i.invoice_number asc`,
    [args.guardianId],
  );

  const suggested: { invoiceId: string; amountMinor: number }[] = [];
  let left = args.availableMinor;
  for (const invoice of open.rows) {
    if (left <= 0) break;
    const balance = Number(invoice.balance_minor);
    const take = Math.min(left, balance);
    if (take > 0) {
      suggested.push({ invoiceId: invoice.id, amountMinor: take });
      left -= take;
    }
  }
  return { suggested, creditMinor: left };
}

/** Credit held for a guardian: the unallocated remainder of every confirmed payment. */
export async function guardianCreditMinor(
  client: PoolClient,
  guardianId: string,
): Promise<number> {
  const result = await client.query<{ credit: string }>(
    `select coalesce(sum(amount_minor - allocated_minor), 0)::text as credit
       from payments
      where payer_guardian_id = $1 and status = 'confirmed'`,
    [guardianId],
  );
  return Number(result.rows[0]?.credit ?? 0);
}

// ---------------------------------------------------------------------------
// PRF-04 support
// ---------------------------------------------------------------------------
/** Proofs whose extracted reference already claims this one — the reuse check (L2). */
export async function referenceAlreadyClaimed(
  client: PoolClient,
  args: { reference: string; paymentId: string },
): Promise<boolean> {
  const result = await client.query<{ claimed: boolean }>(
    `select exists (
       select 1
         from payment_proofs pp
        where pp.payment_id <> $2
          and pp.deleted_at is null
          and lower(pp.verification -> 'extracted' ->> 'reference') = lower($1)
     ) or exists (
       select 1
         from payments p
        where p.id <> $2
          and p.reference is not null
          and lower(p.reference) = lower($1)
          and p.status in ('pending','confirmed')
     ) as claimed`,
    [args.reference, args.paymentId],
  );
  return result.rows[0]?.claimed ?? false;
}

/** True when another live proof already stores the same bytes (identical file sha256). */
export async function fileAlreadyStored(
  client: PoolClient,
  args: { sha256: string; proofId: string },
): Promise<boolean> {
  const result = await client.query<{ claimed: boolean }>(
    `select exists (
       select 1
         from payment_proofs pp
         join files f on f.id = pp.file_id
        where pp.id <> $2 and pp.deleted_at is null and f.sha256 = $1
     ) as claimed`,
    [args.sha256, args.proofId],
  );
  return result.rows[0]?.claimed ?? false;
}
