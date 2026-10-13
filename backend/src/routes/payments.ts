/**
 * PAY-01..08 — payments, allocations and receipts (API_CONTRACTS §3.6, BILLING_ENGINE §11).
 *
 * The whole file follows one rule: **only an owner moves money, and only in a documented
 * order.** Concretely:
 *
 *  - Nothing here writes `invoices.paid_minor`, `payments.allocated_minor` or a row of
 *    `payment_allocations` directly. Every path goes through `applyAllocations` /
 *    `reverseAllocations` (`money-helpers`), which take the locks in the order T2/T3/T4
 *    prescribe — payment first, then invoices **ascending id** — so two confirmations that
 *    touch the same invoice cannot deadlock or double-spend it.
 *  - **Confirming is the one action that changes a balance** (ADR-013/ADR-020). Recording,
 *    updating, rejecting and reversing change a payment's own record; they never confirm
 *    anything, and a proof never does either. `PAY-04` is owner-only and is never reachable
 *    from an automation (the PRF-04 checks are advisory — see `proofs.ts`).
 *  - **Amount and method are immutable** (PAY-03.update): a mistake is corrected by
 *    reversing and recording again, so the audit trail keeps the original figures.
 *
 * Amounts are integers throughout; `pg` returns `bigint` as a string, and `money-serialize`
 * is the single place that converts one.
 */
import type { PoolClient } from "pg";
import { withTransaction } from "../db/pool.js";
import { asViewer } from "../http/context.js";
import { withIdempotency } from "../http/idempotency.js";
import { ApiError, errors } from "../errors.js";
import { isPgError, mapPgError } from "../db/pg-errors.js";
import * as audit from "../audit.js";
import { uuidv7 } from "../ids.js";
import type { Handler, HandlerResult } from "../http/router.js";
import { viewerAudit } from "./auth.js";
import {
  PAYMENT_SELECT,
  applyAllocations,
  guardianCreditMinor,
  issueReceipt,
  loadPayment,
  loadPaymentDetail,
  loadPaymentForUpdate,
  reverseAllocations,
  suggestAllocations,
  type AllocationInput,
} from "./money-helpers.js";
import { serializePayment, type PaymentRow } from "./money-serialize.js";

/** The contract's ceiling for an amount input (BILLING_ENGINE §15). */
const MAX_AMOUNT_MINOR = 10_000_000_000;
/** A payment may not be dated more than a day ahead of the academy's clock. */
const MAX_FUTURE_MS = 24 * 60 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Sort allow-list (PAY-01). Anything else is INVALID_SORT, never interpolated SQL. */
const SORT_COLUMNS: Record<string, string> = {
  receivedAt: "pm.received_at",
  amountMinor: "pm.amount_minor",
};

function orderBy(sort: string | undefined): string {
  const parts: string[] = [];
  if (sort) {
    for (const token of sort.split(",")) {
      const trimmed = token.trim();
      if (!trimmed) continue;
      const direction = trimmed.startsWith("-") ? "desc" : "asc";
      const field = trimmed.replace(/^-/, "");
      const column = SORT_COLUMNS[field];
      if (!column) throw new ApiError("INVALID_SORT", `Unknown sort field "${field}".`);
      parts.push(`${column} ${direction}`);
    }
  } else {
    // Default: most recently received first — the order an owner works through.
    parts.push("pm.received_at desc");
  }
  // Stable tiebreak so paging cannot repeat or skip rows (API_CONTRACTS §1).
  parts.push("pm.id desc");
  return `order by ${parts.join(", ")}`;
}

/** `ILIKE` with the wildcards escaped: a search for `100%` must not match everything. */
function likePattern(value: string): string {
  return `%${value.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/**
 * Loads a payment's full detail and serializes it — the shape PAY-02/03/04/06/07 return.
 * A missing row is a 404 rather than an empty object, so a caller cannot mistake one for
 * the other.
 */
async function paymentResponse(client: PoolClient, paymentId: string) {
  const row = await loadPayment(client, paymentId);
  if (!row) throw errors.notFound();
  const detail = await loadPaymentDetail(client, paymentId);
  return serializePayment(row, detail);
}

/**
 * The method (and the academy's money settings) in one round trip.
 *
 * A bank transfer requires a `reference`: without it there is nothing to reconcile the
 * statement against, so a missing one is a validation error rather than a stored payment
 * nobody can match.
 */
async function loadMethod(
  client: PoolClient,
  methodCode: string,
): Promise<{
  code: string;
  label: string;
  requires_reference: boolean;
  is_active: boolean;
  allow_fractional_money: boolean;
} | null> {
  const result = await client.query<{
    code: string;
    label: string;
    requires_reference: boolean;
    is_active: boolean;
    allow_fractional_money: boolean;
  }>(
    `select m.code, m.label, m.requires_reference, m.is_active, a.allow_fractional_money
       from payment_methods m
       cross join academy_settings a
      where m.code = $1 and a.id = 1`,
    [methodCode],
  );
  return result.rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// PAY-01 — list
// ---------------------------------------------------------------------------
export const pay01List: Handler = async ({ viewer, query }): Promise<HandlerResult> => {
  const { page, pageSize, status, methodCode, guardianId, playerId, from, to, q, hasCredit, sort } =
    query as {
      page: number;
      pageSize: number;
      status?: "pending" | "confirmed" | "rejected" | "reversed";
      methodCode?: string;
      guardianId?: string;
      playerId?: string;
      from?: string;
      to?: string;
      q?: string;
      hasCredit?: boolean;
      sort?: string;
    };
  const order = orderBy(sort);

  const values: unknown[] = [];
  const filters: string[] = [];
  if (status) {
    values.push(status);
    filters.push(`pm.status = $${values.length}`);
  }
  if (methodCode) {
    values.push(methodCode);
    filters.push(`pm.method_code = $${values.length}`);
  }
  if (guardianId) {
    values.push(guardianId);
    filters.push(`pm.payer_guardian_id = $${values.length}`);
  }
  if (playerId) {
    // Every payment whose payer is linked to this player — a sibling's transfer counts.
    values.push(playerId);
    filters.push(`exists (
      select 1 from player_guardians pg
       where pg.guardian_id = pm.payer_guardian_id and pg.player_id = $${values.length}
    )`);
  }
  if (from) {
    values.push(from);
    filters.push(`pm.received_at >= $${values.length}::timestamptz`);
  }
  if (to) {
    values.push(to);
    filters.push(`pm.received_at <= $${values.length}::timestamptz`);
  }
  if (q) {
    values.push(likePattern(q));
    filters.push(`(pm.reference ilike $${values.length} escape '\\'
                   or pm.payer_name ilike $${values.length} escape '\\'
                   or g.full_name ilike $${values.length} escape '\\')`);
  }
  if (hasCredit === true) {
    filters.push("pm.amount_minor > pm.allocated_minor");
  }
  const where = filters.length ? `where ${filters.join(" and ")}` : "";

  const result = await asViewer(viewer, async (client) => {
    const countResult = await client.query<{ total: string }>(
      `select count(*)::text as total
         from payments pm
         left join guardians g on g.id = pm.payer_guardian_id
        ${where}`,
      values,
    );
    const pageResult = await client.query<PaymentRow>(
      `${PAYMENT_SELECT} ${where} ${order}
         limit $${values.length + 1} offset $${values.length + 2}`,
      [...values, pageSize, (page - 1) * pageSize],
    );
    return { total: Number(countResult.rows[0]?.total ?? 0), rows: pageResult.rows };
  });

  return {
    status: 200,
    body: {
      // A list row carries no allocations or proofs: the detail is PAY-03.read's job.
      data: result.rows.map((row) => serializePayment(row)),
      meta: {
        page,
        pageSize,
        total: result.total,
        totalPages: pageSize > 0 ? Math.ceil(result.total / pageSize) : 0,
      },
    },
  };
};

// ---------------------------------------------------------------------------
// PAY-02 — record a payment
// ---------------------------------------------------------------------------
const pay02CreateInner: Handler = async ({ ctx, viewer, body }): Promise<HandlerResult> => {
  const input = body as {
    amountMinor: number;
    methodCode: string;
    reference?: string;
    receivedAt: string;
    payerGuardianId?: string;
    payerName?: string;
    notes?: string;
    status: "confirmed" | "pending";
    allocations?: { invoiceId: string; amountMinor: number }[];
  };

  const receivedAt = new Date(input.receivedAt);
  if (Number.isNaN(receivedAt.getTime())) {
    throw errors.validation([{ field: "receivedAt", issue: "That is not a valid instant." }]);
  }
  if (receivedAt.getTime() > Date.now() + MAX_FUTURE_MS) {
    throw errors.validation([
      { field: "receivedAt", issue: "A payment cannot be dated more than a day ahead." },
    ]);
  }

  try {
    return await withTransaction({ userId: viewer.userId, role: viewer.role }, async (client) => {
      const method = await loadMethod(client, input.methodCode);
      if (!method) throw errors.notFound();
      if (!method.is_active) {
        throw errors.validation([
          { field: "methodCode", issue: "That payment method is not active." },
        ]);
      }
      if (input.amountMinor > MAX_AMOUNT_MINOR) {
        throw errors.validation([
          { field: "amountMinor", issue: "That amount is larger than the contract allows." },
        ]);
      }
      // Whole-rupee amounts only unless the academy has turned fractional money on
      // (BILLING_ENGINE §15) — the UI parses the decimal string, this is the backstop.
      if (!method.allow_fractional_money && input.amountMinor % 100 !== 0) {
        throw errors.validation([
          { field: "amountMinor", issue: "Amounts are recorded in whole rupees." },
        ]);
      }
      const reference = input.reference?.trim() || null;
      if (method.requires_reference && !reference) {
        throw errors.validation([
          {
            field: "reference",
            issue: `${method.label} payments need the bank reference so they can be checked.`,
          },
        ]);
      }

      const id = uuidv7();
      const confirmed = input.status === "confirmed";
      try {
        await client.query(
          `insert into payments
             (id, amount_minor, method_code, reference, received_at, payer_guardian_id,
              payer_name, status, confirmed_at, confirmed_by, notes, created_by)
           values ($1, $2, $3, $4, $5::timestamptz, $6, $7, $8,
                   case when $8 = 'confirmed' then now() else null end,
                   case when $8 = 'confirmed' then $9::uuid else null end,
                   $10, $9)`,
          [
            id,
            input.amountMinor,
            input.methodCode,
            reference,
            input.receivedAt,
            input.payerGuardianId ?? null,
            input.payerName?.trim() || null,
            input.status,
            viewer.userId,
            input.notes?.trim() || null,
          ],
        );
      } catch (err) {
        // The partial unique index on (method, lower(reference)) is the duplicate guard.
        if (isPgError(err) && err.code === "23505") {
          throw new ApiError(
            "PAYMENT_DUPLICATE_REFERENCE",
            "A payment with that reference is already recorded.",
          );
        }
        throw err;
      }

      // Allocations may only accompany a confirmed payment. `applyAllocations` enforces it
      // (409 PAYMENT_NOT_CONFIRMED) so the rule holds even if this handler changed.
      if (input.allocations?.length) {
        await applyAllocations(client, {
          paymentId: id,
          allocations: input.allocations satisfies AllocationInput[],
          userId: viewer.userId,
        });
      }

      // A payment recorded straight as confirmed — the owner checked the bank statement, or the
      // cash is in hand — is confirmed *here*, so its receipt is issued here too: "a receipt
      // exists only for a confirmed payment" cuts both ways (BILLING_ENGINE §11). Leaving this
      // to PAY-04 would mean a receipt that only exists if someone later re-confirmed it.
      if (confirmed) {
        await issueReceipt(client, { paymentId: id, timezone: viewer.academy.timezone });
      }

      const serialized = await paymentResponse(client, id);
      await audit.record(client, viewerAudit(viewer, ctx), {
        action: "payment.create",
        entityType: "payment",
        entityId: id,
        after: serialized,
      });
      return { status: 201, body: serialized };
    });
  } catch (err) {
    mapPgError(err);
  }
};

/** Idempotent: a retried recording with the same key replays instead of paying twice. */
export const pay02Create: Handler = withIdempotency(pay02CreateInner);

// ---------------------------------------------------------------------------
// PAY-03.read — one payment with allocations, proofs and receipt
// ---------------------------------------------------------------------------
export const pay03Read: Handler = async ({ viewer, params }): Promise<HandlerResult> => {
  const { id } = params as { id: string };
  const body = await asViewer(viewer, (client) => paymentResponse(client, id));
  return { status: 200, body };
};

// ---------------------------------------------------------------------------
// PAY-03.update — the non-financial fields only
// ---------------------------------------------------------------------------
export const pay03Update: Handler = async ({ ctx, viewer, params, body }): Promise<HandlerResult> => {
  const { id } = params as { id: string };
  const input = body as {
    reference?: string;
    notes?: string;
    receivedAt?: string;
    version: number;
  };
  if (input.receivedAt !== undefined && Number.isNaN(new Date(input.receivedAt).getTime())) {
    throw errors.validation([{ field: "receivedAt", issue: "That is not a valid instant." }]);
  }

  try {
    return await withTransaction({ userId: viewer.userId, role: viewer.role }, async (client) => {
      // Load under lock: the version check and the write must not race another owner.
      const before = await loadPaymentForUpdate(client, id);
      if (!before) throw errors.notFound();
      if (before.version !== input.version) throw errors.versionConflict();

      try {
        // `amount_minor` and `method_code` are deliberately absent: correcting either is a
        // reversal plus a new payment (BILLING_ENGINE §11), never an edit.
        await client.query(
          `update payments
              set reference = case when $3::boolean then $4::text else reference end,
                  notes = case when $5::boolean then $6::text else notes end,
                  received_at = coalesce($7::timestamptz, received_at)
            where id = $1 and version = $2`,
          [
            id,
            input.version,
            input.reference !== undefined,
            input.reference?.trim() || null,
            input.notes !== undefined,
            input.notes?.trim() || null,
            input.receivedAt ?? null,
          ],
        );
      } catch (err) {
        if (isPgError(err) && err.code === "23505") {
          throw new ApiError(
            "PAYMENT_DUPLICATE_REFERENCE",
            "A payment with that reference is already recorded.",
          );
        }
        throw err;
      }

      const serialized = await paymentResponse(client, id);
      await audit.record(client, viewerAudit(viewer, ctx), {
        action: "payment.update",
        entityType: "payment",
        entityId: id,
        before: serializePayment(before),
        after: serialized,
      });
      return { status: 200, body: serialized };
    });
  } catch (err) {
    mapPgError(err);
  }
};

// ---------------------------------------------------------------------------
// PAY-04 — confirm (the only action that changes a balance)
// ---------------------------------------------------------------------------
const pay04ConfirmInner: Handler = async ({ ctx, viewer, params, body }): Promise<HandlerResult> => {
  const { id } = params as { id: string };
  const input = body as {
    allocations?: { invoiceId: string; amountMinor: number }[];
    version: number;
  };

  try {
    return await withTransaction({ userId: viewer.userId, role: viewer.role }, async (client) => {
      // T2: lock the payment, flip it, allocate, write the receipt, audit — one transaction.
      const before = await loadPaymentForUpdate(client, id);
      if (!before) throw errors.notFound();
      if (before.status !== "pending") {
        throw new ApiError(
          "INVALID_STATE_TRANSITION",
          `Only a pending payment can be confirmed (this one is ${before.status}).`,
        );
      }
      if (before.version !== input.version) throw errors.versionConflict();

      await client.query(
        `update payments
            set status = 'confirmed', confirmed_at = now(), confirmed_by = $2
          where id = $1`,
        [id, viewer.userId],
      );

      if (input.allocations?.length) {
        await applyAllocations(client, {
          paymentId: id,
          allocations: input.allocations satisfies AllocationInput[],
          userId: viewer.userId,
        });
      }

      // The receipt goes with the confirmation, in this same transaction (T2).
      await issueReceipt(client, { paymentId: id, timezone: viewer.academy.timezone });

      const serialized = await paymentResponse(client, id);
      await audit.record(client, viewerAudit(viewer, ctx), {
        action: "payment.confirm",
        entityType: "payment",
        entityId: id,
        before: serializePayment(before),
        after: serialized,
      });
      return { status: 200, body: serialized };
    });
  } catch (err) {
    mapPgError(err);
  }
};

export const pay04Confirm: Handler = withIdempotency(pay04ConfirmInner);

// ---------------------------------------------------------------------------
// PAY-05 — reject
// ---------------------------------------------------------------------------
const pay05RejectInner: Handler = async ({ ctx, viewer, params, body }): Promise<HandlerResult> => {
  const { id } = params as { id: string };
  const input = body as { reason: string; version: number };

  try {
    return await withTransaction({ userId: viewer.userId, role: viewer.role }, async (client) => {
      const before = await loadPaymentForUpdate(client, id);
      if (!before) throw errors.notFound();
      if (before.status !== "pending") {
        throw new ApiError(
          "INVALID_STATE_TRANSITION",
          `Only a pending payment can be rejected (this one is ${before.status}).`,
        );
      }
      if (before.version !== input.version) throw errors.versionConflict();
      if (input.reason.trim().length < 5) {
        throw new ApiError("REASON_REQUIRED", "Give a reason of at least 5 characters.");
      }

      // Nothing is allocated and no receipt is created: rejecting closes a proof that does
      // not check out without touching a single balance (T-FIN-09).
      await client.query(
        `update payments
            set status = 'rejected', rejected_at = now(), rejected_by = $2, rejected_reason = $3
          where id = $1`,
        [id, viewer.userId, input.reason.trim()],
      );

      const serialized = await paymentResponse(client, id);
      await audit.record(client, viewerAudit(viewer, ctx), {
        action: "payment.reject",
        entityType: "payment",
        entityId: id,
        before: serializePayment(before),
        after: serialized,
        reason: input.reason.trim(),
      });
      return { status: 200, body: serialized };
    });
  } catch (err) {
    mapPgError(err);
  }
};

export const pay05Reject: Handler = withIdempotency(pay05RejectInner);

// ---------------------------------------------------------------------------
// PAY-06 — allocate credit (T3: same locks as T2, no status change)
// ---------------------------------------------------------------------------
const pay06AllocateInner: Handler = async ({
  ctx,
  viewer,
  params,
  body,
}): Promise<HandlerResult> => {
  const { id } = params as { id: string };
  const input = body as {
    allocations: { invoiceId: string; amountMinor: number }[];
    version: number;
  };

  try {
    return await withTransaction({ userId: viewer.userId, role: viewer.role }, async (client) => {
      const before = await loadPaymentForUpdate(client, id);
      if (!before) throw errors.notFound();
      if (before.status !== "confirmed") {
        throw new ApiError(
          "INVALID_STATE_TRANSITION",
          `Only a confirmed payment has credit to allocate (this one is ${before.status}).`,
        );
      }
      if (before.version !== input.version) throw errors.versionConflict();

      await applyAllocations(client, {
        paymentId: id,
        allocations: input.allocations satisfies AllocationInput[],
        userId: viewer.userId,
      });

      const serialized = await paymentResponse(client, id);
      await audit.record(client, viewerAudit(viewer, ctx), {
        action: "payment.allocate",
        entityType: "payment",
        entityId: id,
        before: serializePayment(before),
        after: serialized,
      });
      return { status: 200, body: serialized };
    });
  } catch (err) {
    mapPgError(err);
  }
};

export const pay06Allocate: Handler = withIdempotency(pay06AllocateInner);

// ---------------------------------------------------------------------------
// PAY-07 — reverse (the correction path; the row is never edited away)
// ---------------------------------------------------------------------------
const pay07ReverseInner: Handler = async ({ ctx, viewer, params, body }): Promise<HandlerResult> => {
  const { id } = params as { id: string };
  const input = body as { reason: string; version: number };

  try {
    return await withTransaction({ userId: viewer.userId, role: viewer.role }, async (client) => {
      const before = await loadPaymentForUpdate(client, id);
      if (!before) throw errors.notFound();
      if (before.status !== "confirmed") {
        throw new ApiError(
          "INVALID_STATE_TRANSITION",
          `Only a confirmed payment can be reversed (this one is ${before.status}).`,
        );
      }
      if (before.version !== input.version) throw errors.versionConflict();
      if (input.reason.trim().length < 5) {
        throw new ApiError("REASON_REQUIRED", "Give a reason of at least 5 characters.");
      }

      // T4: release the allocations and recompute the invoices they were holding, then mark
      // the payment reversed, then void the receipt.
      await reverseAllocations(client, {
        paymentId: id,
        userId: viewer.userId,
        reason: input.reason.trim(),
      });

      await client.query(
        `update payments
            set status = 'reversed', reversed_at = now(), reversed_by = $2, reversed_reason = $3
          where id = $1`,
        [id, viewer.userId, input.reason.trim()],
      );

      // A reversed payment's receipt is void; a regenerated PDF carries the watermark.
      //
      // `pdf_stale = true` is what makes that reachable: the watermark is applied when the
      // document is *rebuilt* (FILES_AND_PDF §3), so without this flag RCT-02 would keep
      // serving the pre-reversal PDF — the exact copy a guardian would still be holding.
      await client.query(
        `update receipts set voided_at = now(), pdf_stale = true
          where payment_id = $1 and voided_at is null`,
        [id],
      );

      const serialized = await paymentResponse(client, id);
      await audit.record(client, viewerAudit(viewer, ctx), {
        action: "payment.reverse",
        entityType: "payment",
        entityId: id,
        before: serializePayment(before),
        after: serialized,
        reason: input.reason.trim(),
      });
      return { status: 200, body: serialized };
    });
  } catch (err) {
    mapPgError(err);
  }
};

export const pay07Reverse: Handler = withIdempotency(pay07ReverseInner);

// ---------------------------------------------------------------------------
// PAY-08 — allocation suggestion (read-only; nothing here writes)
// ---------------------------------------------------------------------------
export const pay08Suggestion: Handler = async ({ viewer, params, query }): Promise<HandlerResult> => {
  const { id } = params as { id: string };
  const { guardianId } = query as { guardianId: string };

  const body = await asViewer(viewer, async (client) => {
    // CONTRACT GAP (recorded in the Step 5 frontend handoff §4): the path carries a payment
    // id while the suggestion is keyed by guardian and needs no payment — so the record-
    // payment screen calls this with the literal `new`, which is accepted here as "no
    // payment yet" rather than turned into a 500 by a uuid cast.
    const payment = UUID_RE.test(id) ? await loadPayment(client, id) : null;

    const availableMinor = payment
      ? Number(payment.amount_minor) - Number(payment.allocated_minor)
      : await guardianCreditMinor(client, guardianId);

    return suggestAllocations(client, { guardianId, availableMinor });
  });

  return { status: 200, body };
};

export type { PaymentRow };
