/**
 * INV-01..05 — invoices (API_CONTRACTS §3.6, BILLING_ENGINE §10).
 *
 * An issued invoice is a **snapshot** (ADR-014), so this file has exactly two ways to change
 * one and both are appends:
 *
 *  - **void** (INV-04) — the invoice stops counting. It keeps its number and its row, the
 *    period stays occupied unless the owner asked to reissue, and money already allocated to
 *    it is either refused (`INVOICE_HAS_ALLOCATIONS`) or handed back to the payments as
 *    credit through the payment paths' own lock order.
 *  - **a negative adjustment** (INV-05) — the only post-issue correction allowed. It is a new
 *    line, never an edit of an old one, and it may not exceed the outstanding balance.
 *
 * Two things this file deliberately does **not** do: it never recomputes a total from today's
 * settings (the snapshot and the lines are the record), and it never writes `paid_minor` —
 * that column belongs to the allocations (`recomputeInvoice`).
 *
 * The version check and the write it guards are **one statement** wherever possible
 * (`where id = $1 and version = $2 and …`). A read-then-write across two statements is what
 * lets a concurrent confirmation and a void both pass their own checks; here the loser of the
 * race changes no rows and is answered with the documented error.
 */
import { withTransaction } from "../db/pool.js";
import { asViewer } from "../http/context.js";
import { withIdempotency } from "../http/idempotency.js";
import { ApiError, errors } from "../errors.js";
import { mapPgError } from "../db/pg-errors.js";
import * as audit from "../audit.js";
import { uuidv7 } from "../ids.js";
import type { Handler, HandlerResult } from "../http/router.js";
import { viewerAudit } from "./auth.js";
import { loadAcademyBrand } from "./academy-brand.js";
import {
  INVOICE_FULL_SELECT,
  allocationsForInvoice,
  invoiceItems,
  loadInvoiceFull,
  nextDocumentNumber,
  releaseAllocationsForInvoice,
} from "./money-helpers.js";
import {
  serializeInvoice,
  type InvoiceFullRow,
} from "./money-serialize.js";

/** Sort allow-list (INV-01). Anything else is INVALID_SORT, never interpolated SQL. */
const SORT_COLUMNS: Record<string, string> = {
  dueDate: "i.due_date",
  issueDate: "i.issue_date",
  invoiceNumber: "i.invoice_number",
  balanceMinor: "i.balance_minor",
  playerName: "p.full_name",
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
    // Default: what the owner works through — the oldest debt first, ties by number.
    parts.push("i.due_date asc", "i.invoice_number asc");
  }
  parts.push("i.id desc");
  return `order by ${parts.join(", ")}`;
}

/** `ILIKE` with the wildcards escaped (same rule as PAY-01). */
function likePattern(value: string): string {
  return `%${value.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/** The full invoice (with its lines) as every INV-* write returns it. */
async function invoiceDetail(
  client: Parameters<typeof invoiceItems>[0],
  invoice: InvoiceFullRow,
) {
  const [items, allocations] = await Promise.all([
    invoiceItems(client, invoice.id),
    allocationsForInvoice(client, invoice.id),
  ]);
  return serializeInvoice(invoice, { items, allocations });
}

// ---------------------------------------------------------------------------
// INV-01 — list
// ---------------------------------------------------------------------------
interface InvoiceListQuery {
  page: number;
  pageSize: number;
  status?: "issued" | "partially_paid" | "paid" | "void";
  overdue?: boolean;
  playerId?: string;
  guardianId?: string;
  ageGroupId?: string;
  issueFrom?: string;
  issueTo?: string;
  dueFrom?: string;
  dueTo?: string;
  q?: string;
  sort?: string;
}

export const inv01List: Handler = async ({ viewer, query }): Promise<HandlerResult> => {
  const {
    page,
    pageSize,
    status,
    overdue,
    playerId,
    guardianId,
    ageGroupId,
    issueFrom,
    issueTo,
    dueFrom,
    dueTo,
    q,
    sort,
  } = query as InvoiceListQuery;
  const order = orderBy(sort);

  const values: unknown[] = [];
  const filters: string[] = [];
  if (status) {
    values.push(status);
    filters.push(`i.status = $${values.length}`);
  }
  if (overdue === true) {
    // The documented predicate, spelled out because it is a filter and not only a field.
    filters.push(`(i.status in ('issued','partially_paid') and i.due_date < a.today)`);
  }
  if (playerId) {
    values.push(playerId);
    filters.push(`i.player_id = $${values.length}`);
  }
  if (guardianId) {
    values.push(guardianId);
    filters.push(`i.guardian_id = $${values.length}`);
  }
  if (ageGroupId) {
    // The group an invoice was billed under lives in its snapshot (ADR-014), not in the
    // player's current history: filtering by today's group would return an invoice billed
    // under a group the player has since left.
    values.push(ageGroupId);
    filters.push(`i.snapshot ->> 'ageGroupId' = $${values.length}`);
  }
  if (issueFrom) {
    values.push(issueFrom);
    filters.push(`i.issue_date >= $${values.length}::date`);
  }
  if (issueTo) {
    values.push(issueTo);
    filters.push(`i.issue_date <= $${values.length}::date`);
  }
  if (dueFrom) {
    values.push(dueFrom);
    filters.push(`i.due_date >= $${values.length}::date`);
  }
  if (dueTo) {
    values.push(dueTo);
    filters.push(`i.due_date <= $${values.length}::date`);
  }
  if (q) {
    values.push(likePattern(q));
    filters.push(`(i.invoice_number ilike $${values.length} escape '\\'
                   or p.full_name ilike $${values.length} escape '\\'
                   or p.registration_no ilike $${values.length} escape '\\')`);
  }
  const where = filters.length ? `where ${filters.join(" and ")}` : "";

  const result = await asViewer(viewer, async (client) => {
    const count = await client.query<{ total: string }>(
      `select count(*)::text as total
         from invoices i
         join players p on p.id = i.player_id
         cross join lateral (select (now() at time zone timezone)::date as today
                               from academy_settings where id = 1) a
        ${where}`,
      values,
    );
    const rows = await client.query<InvoiceFullRow>(
      `${INVOICE_FULL_SELECT} ${where} ${order}
         limit $${values.length + 1} offset $${values.length + 2}`,
      [...values, pageSize, (page - 1) * pageSize],
    );
    return { total: Number(count.rows[0]?.total ?? 0), rows: rows.rows };
  });

  return {
    status: 200,
    body: {
      // No `items`/`allocations` in a list row: INV-02 owns the detail.
      data: result.rows.map((row) => serializeInvoice(row)),
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
// INV-02 — read, with lines and allocations
// ---------------------------------------------------------------------------
export const inv02Read: Handler = async ({ viewer, params }): Promise<HandlerResult> => {
  const { id } = params as { id: string };
  const body = await asViewer(viewer, async (client) => {
    const invoice = await loadInvoiceFull(client, id);
    if (!invoice) throw errors.notFound();
    return invoiceDetail(client, invoice);
  });
  return { status: 200, body };
};

// ---------------------------------------------------------------------------
// INV-03 — a one-off (manual) invoice
// ---------------------------------------------------------------------------
interface ManualInvoiceBody {
  playerId: string;
  description: string;
  amountMinor: number;
  dueDate: string;
  guardianId?: string;
}

const inv03CreateInner: Handler = async ({ ctx, viewer, body }): Promise<HandlerResult> => {
  const input = body as ManualInvoiceBody;
  if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) {
    throw errors.validation([
      { field: "amountMinor", issue: "An invoice amount must be a positive whole number." },
    ]);
  }

  try {
    return await withTransaction({ userId: viewer.userId, role: viewer.role }, async (client) => {
      const settings = await client.query<{
        today: string;
        currency: string;
        timezone: string;
        allow_fractional_money: boolean;
      }>(
        `select (now() at time zone timezone)::date::text as today, currency, timezone,
                allow_fractional_money
           from academy_settings where id = 1`,
      );
      const academy = settings.rows[0]!;
      if (!academy.allow_fractional_money && input.amountMinor % 100 !== 0) {
        throw errors.validation([
          { field: "amountMinor", issue: "Amounts are recorded in whole rupees." },
        ]);
      }

      const player = await client.query<{
        id: string;
        full_name: string;
        registration_no: string;
      }>(`select id, full_name, registration_no from players where id = $1`, [input.playerId]);
      if (player.rowCount === 0) throw errors.notFound();

      // The group on the issue date, written into the snapshot: the contract's `Invoice`
      // always carries an `ageGroup`, and an invoice nobody can attribute to a group is one
      // the owner cannot explain later. A player with no group is therefore refused rather
      // than invoiced anonymously.
      const group = await client.query<{ id: string; name: string }>(
        `select g.id, g.name
           from player_group_history h
           join age_groups g on g.id = h.age_group_id
          where h.player_id = $1
            and h.effective_from <= $2::date
            and (h.effective_to is null or h.effective_to >= $2::date)
          limit 1`,
        [input.playerId, academy.today],
      );
      const ageGroup = group.rows[0];
      if (!ageGroup) {
        throw errors.validation([
          {
            field: "playerId",
            issue: "That player has no group on the issue date, so an invoice cannot be attributed.",
          },
        ]);
      }

      // Billed-to guardian: the one the owner named (which must be linked to the player, or
      // the invoice would chase a stranger), else whoever receives invoices.
      let guardianId: string | null = null;
      if (input.guardianId) {
        const link = await client.query(
          `select 1 from player_guardians where player_id = $1 and guardian_id = $2`,
          [input.playerId, input.guardianId],
        );
        if (link.rowCount === 0) {
          throw errors.validation([
            { field: "guardianId", issue: "That guardian is not linked to this player." },
          ]);
        }
        guardianId = input.guardianId;
      } else {
        const primary = await client.query<{ id: string }>(
          `select g.id
             from player_guardians pg
             join guardians g on g.id = pg.guardian_id
            where pg.player_id = $1
            order by pg.receives_invoices desc, pg.is_primary desc
            limit 1`,
          [input.playerId],
        );
        guardianId = primary.rows[0]?.id ?? null;
      }

      // The branding block and the billed-to guardian's name and number are snapshotted with
      // the invoice (FILES_AND_PDF §2): the PDF is rendered from `snapshot` alone, so a
      // regenerated invoice still prints what was true when it was issued.
      const brand = await loadAcademyBrand(client);
      const guardianRow = guardianId
        ? (
            await client.query<{ full_name: string; phone_e164: string }>(
              `select full_name, phone_e164 from guardians where id = $1`,
              [guardianId],
            )
          ).rows[0] ?? null
        : null;

      const invoiceId = uuidv7();
      await client.query(
        `insert into invoices
           (id, invoice_number, kind, player_id, guardian_id, period_start, period_end,
            issue_date, due_date, status, currency, subtotal_minor, adjustments_minor,
            total_minor, paid_minor, snapshot, created_by)
         values ($1, $2, 'manual', $3, $4, null, null, $5::date, $6::date, 'issued', $7,
                 $8, 0, $8, 0, $9::jsonb, $10)`,
        [
          invoiceId,
          await nextDocumentNumber(client, "invoice", academy.timezone),
          input.playerId,
          guardianId,
          academy.today,
          input.dueDate,
          academy.currency,
          input.amountMinor,
          JSON.stringify({
            ageGroupId: ageGroup.id,
            ageGroupName: ageGroup.name,
            manualDescription: input.description,
            academy: brand,
            player: {
              fullName: player.rows[0]!.full_name,
              registrationNo: player.rows[0]!.registration_no,
              ageGroupName: ageGroup.name,
            },
            guardian: guardianRow
              ? { fullName: guardianRow.full_name, phone: guardianRow.phone_e164 }
              : null,
          }),
          viewer.userId,
        ],
      );
      await client.query(
        `insert into invoice_items
           (id, invoice_id, line_no, item_type, description, quantity, unit_amount_minor,
            amount_minor, created_by)
         values ($1, $2, 1, 'fee', $3, 1, $4, $4, $5)`,
        [uuidv7(), invoiceId, input.description, input.amountMinor, viewer.userId],
      );

      const created = await loadInvoiceFull(client, invoiceId);
      const serialized = await invoiceDetail(client, created!);
      await audit.record(client, viewerAudit(viewer, ctx), {
        action: "invoice.create_manual",
        entityType: "invoice",
        entityId: invoiceId,
        after: serialized,
      });
      return { status: 201, body: serialized };
    });
  } catch (err) {
    mapPgError(err);
  }
};

export const inv03Create: Handler = withIdempotency(inv03CreateInner);

// ---------------------------------------------------------------------------
// INV-04 — void
// ---------------------------------------------------------------------------
interface VoidBody {
  reason: string;
  releaseAllocations?: boolean;
  allowReissue?: boolean;
  version: number;
}

const inv04VoidInner: Handler = async ({ ctx, viewer, params, body }): Promise<HandlerResult> => {
  const { id } = params as { id: string };
  const input = body as VoidBody;

  try {
    return await withTransaction({ userId: viewer.userId, role: viewer.role }, async (client) => {
      const before = await loadInvoiceFull(client, id);
      if (!before) throw errors.notFound();
      const snapshot = serializeInvoice(before);

      if (before.status === "void") {
        throw new ApiError(
          "INVALID_STATE_TRANSITION",
          "That invoice is already void — releasing it again would change nothing.",
        );
      }
      // The caller's version is checked here so a stale screen is answered with
      // VERSION_CONFLICT; the *write* below re-checks it atomically.
      if (before.version !== input.version) throw errors.versionConflict();

      const active = await client.query<{ total: string; count: string }>(
        `select coalesce(sum(amount_minor), 0)::text as total, count(*)::text as count
           from payment_allocations where invoice_id = $1 and reversed_at is null`,
        [id],
      );
      const allocated = Number(active.rows[0]?.total ?? 0);
      if (allocated > 0) {
        if (!input.releaseAllocations) {
          throw new ApiError(
            "INVOICE_HAS_ALLOCATIONS",
            "Payments are allocated to this invoice. Void it with releaseAllocations to " +
              "return them to the payments as credit.",
            [
              {
                field: "releaseAllocations",
                issue: `${allocated} minor units are allocated across ${active.rows[0]!.count} payment(s).`,
              },
            ],
          );
        }
        // Locks payments (ascending id) and then this invoice — the order T2/T3/T4 prescribe,
        // so a void and a confirmation cannot deadlock. The invoice's cache and status are
        // recomputed as each allocation is released, which is why nothing below trusts the
        // snapshot read above.
        await releaseAllocationsForInvoice(client, {
          invoiceId: id,
          userId: viewer.userId,
          reason: `invoice void: ${input.reason.trim()}`,
        });
      }

      // One statement does the whole guard: still not void, still at the version the client
      // saw *before* the release above (which the release itself moved), and now carrying no
      // active allocation. `suppress_reissue = NOT allowReissue` is §10's default: a voided
      // period is not silently recreated by the next scheduler run.
      const voided = await client.query(
        `update invoices i
            set status = 'void', voided_at = now(), voided_by = $2, void_reason = $3,
                suppress_reissue = $4, pdf_stale = true
          where i.id = $1
            and i.status <> 'void'
            and not exists (
              select 1 from payment_allocations a
               where a.invoice_id = i.id and a.reversed_at is null
            )
          returning i.id`,
        [id, viewer.userId, input.reason.trim(), input.allowReissue !== true],
      );
      if (voided.rowCount === 0) {
        // Something moved between the checks and the write. Say which one, from the row as the
        // database now holds it.
        const now = await loadInvoiceFull(client, id);
        if (!now) throw errors.notFound();
        if (now.status === "void") {
          throw new ApiError("INVALID_STATE_TRANSITION", "That invoice is already void.");
        }
        const stillAllocated = await client.query<{ count: string }>(
          `select count(*)::text as count from payment_allocations
            where invoice_id = $1 and reversed_at is null`,
          [id],
        );
        if (Number(stillAllocated.rows[0]?.count ?? 0) > 0) {
          throw new ApiError(
            "INVOICE_HAS_ALLOCATIONS",
            "A payment was allocated to this invoice while it was being voided. Try again.",
          );
        }
        throw errors.versionConflict();
      }

      const after = await loadInvoiceFull(client, id);
      const serialized = await invoiceDetail(client, after!);
      await audit.record(client, viewerAudit(viewer, ctx), {
        action: "invoice.void",
        entityType: "invoice",
        entityId: id,
        before: snapshot,
        after: serialized,
        reason: input.reason.trim(),
      });
      return { status: 200, body: serialized };
    });
  } catch (err) {
    mapPgError(err);
  }
};

/**
 * NOTE (M6/M7): §10 also has voiding cancel that invoice's `queued` messages and revoke its
 * public access tokens in the same transaction. Neither table exists yet — `message_jobs`
 * arrives with M7 and `invoice_access_tokens` with M6 — so there is nothing to write here.
 * Recorded in the M5 handoff rather than faked with a table that is not there.
 */
export const inv04Void: Handler = withIdempotency(inv04VoidInner);

// ---------------------------------------------------------------------------
// INV-05 — append a negative adjustment
// ---------------------------------------------------------------------------
interface AdjustmentBody {
  amountMinor: number;
  reason: string;
  version: number;
}

const inv05AdjustInner: Handler = async ({ ctx, viewer, params, body }): Promise<HandlerResult> => {
  const { id } = params as { id: string };
  const input = body as AdjustmentBody;
  if (!Number.isInteger(input.amountMinor) || input.amountMinor >= 0) {
    throw errors.validation([
      { field: "amountMinor", issue: "An adjustment must be a negative amount." },
    ]);
  }

  try {
    return await withTransaction({ userId: viewer.userId, role: viewer.role }, async (client) => {
      const before = await loadInvoiceFull(client, id);
      if (!before) throw errors.notFound();
      if (before.status === "void") {
        throw new ApiError("INVOICE_VOID", "A voided invoice cannot be adjusted.");
      }
      if (before.version !== input.version) throw errors.versionConflict();

      const balance = Number(before.balance_minor);
      if (-input.amountMinor > balance) {
        throw errors.validation([
          {
            field: "amountMinor",
            issue: `The invoice still owes ${balance} minor units — an adjustment cannot be larger.`,
          },
        ]);
      }

      // The status is re-derived from the new paid/total pair in the same statement
      // (BILLING_ENGINE §10): an adjustment that clears the balance *is* the payment that
      // clears it, and `invoices_status_shape` would refuse anything else at commit.
      const updated = await client.query(
        `update invoices i
            set adjustments_minor = i.adjustments_minor + $3,
                total_minor = i.total_minor + $3,
                status = case
                  when i.paid_minor = i.total_minor + $3 then 'paid'
                  when i.paid_minor > 0 then 'partially_paid'
                  else 'issued'
                end,
                pdf_stale = true
          where i.id = $1 and i.version = $2 and i.status <> 'void'
          returning i.id`,
        [id, input.version, input.amountMinor],
      );
      if (updated.rowCount === 0) throw errors.versionConflict();

      const nextLine = await client.query<{ line_no: number }>(
        `select coalesce(max(line_no), 0) + 1 as line_no from invoice_items where invoice_id = $1`,
        [id],
      );
      await client.query(
        `insert into invoice_items
           (id, invoice_id, line_no, item_type, description, quantity, unit_amount_minor,
            amount_minor, reason, created_by)
         values ($1, $2, $3, 'adjustment', $4, 1, $5, $5, $4, $6)`,
        [
          uuidv7(),
          id,
          nextLine.rows[0]!.line_no,
          input.reason.trim(),
          input.amountMinor,
          viewer.userId,
        ],
      );

      const after = await loadInvoiceFull(client, id);
      const serialized = await invoiceDetail(client, after!);
      await audit.record(client, viewerAudit(viewer, ctx), {
        action: "invoice.adjust",
        entityType: "invoice",
        entityId: id,
        before: serializeInvoice(before),
        after: serialized,
        reason: input.reason.trim(),
      });
      return { status: 200, body: serialized };
    });
  } catch (err) {
    mapPgError(err);
  }
};

export const inv05Adjust: Handler = withIdempotency(inv05AdjustInner);
