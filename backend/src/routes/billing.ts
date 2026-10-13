/**
 * BIL-01..03 — billing runs (API_CONTRACTS §3.6, BILLING_ENGINE §4/§9).
 *
 * The shape of this file is the preview/run pair:
 *
 *  - **BIL-01 stores nothing.** It is the only place the owner can see what a run *would* do
 *    — who is skipped and why, what each invoice would say, and which fees are behind. It
 *    writes an audit row (the contract marks it audited) and nothing else.
 *  - **BIL-02 recomputes that preview** rather than trusting the one it is handed, and
 *    compares hashes. That is what makes a stale preview a 409 `PREVIEW_STALE` instead of a
 *    run that bills a fee the owner never saw (T-FIN-18).
 *  - Both share `billing-engine`, so a preview and the run it describes cannot disagree.
 */
import { withTransaction } from "../db/pool.js";
import { asViewer } from "../http/context.js";
import { withIdempotency } from "../http/idempotency.js";
import { ApiError, errors } from "../errors.js";
import { mapPgError } from "../db/pg-errors.js";
import * as audit from "../audit.js";
import type { Handler, HandlerResult } from "../http/router.js";
import { viewerAudit } from "./auth.js";
import {
  buildPreview,
  hashPreview,
  issueRun,
  loadBillingContext,
  type BillingAdjustment,
} from "./billing-engine.js";
import { serializeBillingRun, type BillingRunRow } from "./money-serialize.js";

interface PreviewBody {
  targetDate: string;
  ageGroupIds?: string[];
  playerIds?: string[];
}

interface RunBody extends PreviewBody {
  previewHash: string;
  adjustments?: BillingAdjustment[];
  queueWhatsApp?: boolean;
}

/** The run's invoice ids, read from the invoices themselves (the run row does not store them). */
const RUN_SELECT = `select r.id, r.run_key, r.status, r.target_date, r.invoices_created,
          r.invoices_skipped, r.started_at, r.completed_at,
          coalesce(
            (select array_agg(i.id order by i.invoice_number)
               from invoices i where i.billing_run_id = r.id),
            '{}'::uuid[]
          ) as invoice_ids
     from billing_runs r`;

// ---------------------------------------------------------------------------
// BIL-01 — preview
// ---------------------------------------------------------------------------
export const bil01Preview: Handler = async ({ ctx, viewer, body }): Promise<HandlerResult> => {
  const input = body as PreviewBody;

  try {
    return await asViewer(viewer, async (client) => {
      const billing = await loadBillingContext(client);
      const preview = await buildPreview(client, billing, input);
      const serialized = {
        previewHash: hashPreview(preview),
        targetDate: preview.targetDate,
        frequency: preview.config.frequency,
        mode: preview.config.mode,
        lines: preview.lines,
        skipped: preview.skipped,
        totals: {
          count: preview.lines.length,
          totalMinor: preview.lines.reduce((sum, line) => sum + line.feeMinor, 0),
        },
      };
      // Audited because it names every player's fee — but nothing is stored: the preview is a
      // question, and the answer belongs to the request that asked it.
      await audit.record(client, viewerAudit(viewer, ctx), {
        action: "billing.preview",
        entityType: "billing_run",
        entityId: null,
        after: { targetDate: input.targetDate, previewHash: serialized.previewHash },
      });
      return { status: 200, body: serialized };
    });
  } catch (err) {
    mapPgError(err);
  }
};

// ---------------------------------------------------------------------------
// BIL-02 — issue the run
// ---------------------------------------------------------------------------
/**
 * Validates the adjustments the owner attached to a run (BILLING_ENGINE §10/§15).
 *
 * Every refusal here is a 422 rather than a database error, because each one is a mistake in
 * the request and the owner can fix it: an adjustment must be **negative** (an increase is a
 * void plus reissue), it may not exceed the fee it discounts, and it must name a player the
 * preview actually contains — otherwise it would silently vanish.
 */
function validateAdjustments(
  adjustments: BillingAdjustment[],
  preview: { lines: { playerId: string; feeMinor: number }[] },
): void {
  const seen = new Set<string>();
  const byPlayer = new Map(preview.lines.map((line) => [line.playerId, line.feeMinor]));
  for (const adjustment of adjustments) {
    if (seen.has(adjustment.playerId)) {
      throw errors.validation([
        { field: "adjustments", issue: "A player can carry only one adjustment per run." },
      ]);
    }
    seen.add(adjustment.playerId);

    const fee = byPlayer.get(adjustment.playerId);
    if (fee === undefined) {
      throw errors.validation([
        {
          field: "adjustments",
          issue: "That player is not part of this run, so the adjustment cannot be applied.",
          meta: { playerId: adjustment.playerId },
        },
      ]);
    }
    if (!Number.isInteger(adjustment.amountMinor) || adjustment.amountMinor >= 0) {
      throw errors.validation([
        { field: "adjustments", issue: "An adjustment must be a negative amount." },
      ]);
    }
    if (-adjustment.amountMinor > fee) {
      throw errors.validation([
        {
          field: "adjustments",
          issue: "An adjustment cannot be larger than the fee it discounts.",
          meta: { playerId: adjustment.playerId, feeMinor: fee },
        },
      ]);
    }
    const reason = adjustment.reason.trim();
    if (reason.length < 5 || reason.length > 200) {
      throw errors.validation([
        { field: "adjustments", issue: "Give a reason of 5 to 200 characters." },
      ]);
    }
    adjustment.reason = reason;
  }
}

const bil02RunInner: Handler = async ({ ctx, req, viewer, body }): Promise<HandlerResult> => {
  const input = body as RunBody;
  const adjustments = input.adjustments ?? [];

  // Queueing WhatsApp is M7's: `message_jobs` does not exist yet, so the flag is refused
  // rather than accepted and dropped on the floor.
  if (input.queueWhatsApp === true) {
    throw new ApiError(
      "VALIDATION_ERROR",
      "Queuing invoice messages is not available yet: the message queue arrives with M7.",
      [{ field: "queueWhatsApp", issue: "Not supported in this build." }],
    );
  }

  // The run key is the documented one: a manual run is keyed by its Idempotency-Key, so the
  // same retried request can never open a second run row (§9).
  const headerKey = req.headers["idempotency-key"];
  const runKey = `manual:${typeof headerKey === "string" ? headerKey.trim() : "unknown"}`;

  try {
    return await withTransaction({ userId: viewer.userId, role: viewer.role }, async (client) => {
      const billing = await loadBillingContext(client);

      // The world is re-read, not trusted: a fee change, a transfer or another run since the
      // preview changes what this run would issue, and that is a stale preview, not a run.
      const preview = await buildPreview(client, billing, input);
      if (hashPreview(preview) !== input.previewHash) {
        throw new ApiError(
          "PREVIEW_STALE",
          "The preview is out of date — something changed since it was produced. Preview again.",
        );
      }
      validateAdjustments(adjustments, preview);

      const run = await issueRun(client, {
        ctx: billing,
        preview,
        adjustments,
        runKey,
        triggeredBy: "owner",
        userId: viewer.userId,
      });

      const read = await client.query<BillingRunRow>(`${RUN_SELECT} where r.id = $1`, [run.runId]);
      const serialized = serializeBillingRun(read.rows[0]!);
      await audit.record(client, viewerAudit(viewer, ctx), {
        action: "billing.run",
        entityType: "billing_run",
        entityId: run.runId,
        after: serialized,
      });
      return { status: 201, body: serialized };
    });
  } catch (err) {
    mapPgError(err);
  }
};

/**
 * Idempotent, and the failure is stored like the success: a retried run must not issue twice.
 * The unique `billing_runs.run_key` is the second lock — two requests that reach the database
 * with the same key cannot both insert, and the loser is answered with `ALREADY_INVOICED`.
 */
export const bil02Run: Handler = withIdempotency(bil02RunInner);

// ---------------------------------------------------------------------------
// BIL-03 — list and read the runs
// ---------------------------------------------------------------------------
interface RunListQuery {
  page: number;
  pageSize: number;
}

export const bil03List: Handler = async ({ viewer, query }): Promise<HandlerResult> => {
  const { page, pageSize } = query as RunListQuery;

  const result = await asViewer(viewer, async (client) => {
    const count = await client.query<{ total: string }>(
      `select count(*)::text as total from billing_runs`,
    );
    const rows = await client.query<BillingRunRow>(
      `${RUN_SELECT} order by r.target_date desc, r.started_at desc, r.id desc
         limit $1 offset $2`,
      [pageSize, (page - 1) * pageSize],
    );
    return { total: Number(count.rows[0]?.total ?? 0), rows: rows.rows };
  });

  return {
    status: 200,
    body: {
      data: result.rows.map(serializeBillingRun),
      meta: {
        page,
        pageSize,
        total: result.total,
        totalPages: pageSize > 0 ? Math.ceil(result.total / pageSize) : 0,
      },
    },
  };
};

export const bil03Read: Handler = async ({ viewer, params }): Promise<HandlerResult> => {
  const { id } = params as { id: string };
  const row = await asViewer(viewer, async (client) => {
    const result = await client.query<BillingRunRow>(`${RUN_SELECT} where r.id = $1`, [id]);
    return result.rows[0] ?? null;
  });
  if (!row) throw errors.notFound();
  return { status: 200, body: serializeBillingRun(row) };
};
