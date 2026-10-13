/**
 * SES-01..04 — training sessions (API_CONTRACTS §3.5, M4).
 *
 * Three rules shape this file:
 *
 *  - **A coach's scope is filtered in the query, not after it.** The predicate is an
 *    assignment held on *each session's own date*, so an assignment that ended last month
 *    cannot leak next month's session (SES-01, AUTH §6). RLS enforces the same thing, so
 *    an out-of-scope row is invisible and SES-03.read can answer 404 without confirming
 *    existence.
 *  - **`session_date` is a business date, derived in SQL.** It is
 *    `(starts_at at time zone <academy timezone>)::date`, so no JavaScript offset can
 *    shift a session into the wrong day (DATABASE §1).
 *  - **The database owns the duplicate rules.** The two partial unique indexes on
 *    `sessions` raise `23505`, which is translated into the documented 409
 *    `SESSION_DUPLICATE` rather than surfacing as a 500.
 *
 * `version`/`updated_at` are trigger-maintained (migration 0010), so nothing here writes
 * them; optimistic locking compares `version` in the WHERE clause.
 */
import type { PoolClient } from "pg";
import { withTransaction } from "../db/pool.js";
import { asViewer } from "../http/context.js";
import { errors, ApiError } from "../errors.js";
import { isPgError, mapPgError } from "../db/pg-errors.js";
import * as audit from "../audit.js";
import { uuidv7 } from "../ids.js";
import type { Handler, HandlerResult } from "../http/router.js";
import { viewerAudit } from "./auth.js";
import { todayInTimeZone } from "./people-helpers.js";
import { attendanceSummaries } from "./attendance-helpers.js";
import {
  serializeSession,
  type SessionAttendanceSummary,
  type SessionRow,
} from "./attendance-serialize.js";

/** The joined projection every response uses: the group's name and the lead coach's. */
export const SESSION_SELECT = `select s.id, s.age_group_id, g.name as age_group_name, s.schedule_id,
                               s.session_date, s.starts_at, s.ends_at, s.venue, s.status,
                               s.cancel_reason, s.lead_coach_user_id,
                               u.full_name as lead_coach_name, s.version
                          from sessions s
                          join age_groups g on g.id = s.age_group_id
                          left join users u on u.id = s.lead_coach_user_id`;

/** Columns a RETURNING clause must repeat so the CTE below can join on them. */
const SESSION_RETURNING = `id, age_group_id, schedule_id, session_date, starts_at, ends_at,
                           venue, status, cancel_reason, lead_coach_user_id, version`;

/** Wraps an updated/inserted row so the group and coach names come back with it. */
function joinedFromCte(cte: string): string {
  return `with ${cte} as (
            <statement>
          )
          select r.id, r.age_group_id, g.name as age_group_name, r.schedule_id,
                 r.session_date, r.starts_at, r.ends_at, r.venue, r.status,
                 r.cancel_reason, r.lead_coach_user_id,
                 u.full_name as lead_coach_name, r.version
            from ${cte} r
            join age_groups g on g.id = r.age_group_id
            left join users u on u.id = r.lead_coach_user_id`;
}

/**
 * Attach `attendanceSummary` to a batch of sessions in **one** round trip.
 *
 * A session a caller cannot see never reaches here (RLS), and the cohort behind each count
 * comes from the same roster rule as ATT-01 (`attendance-helpers`), so the number on a
 * session row and the sheet it links to cannot disagree.
 */
export async function withSummaries(
  client: PoolClient,
  rows: SessionRow[],
): Promise<{ row: SessionRow; summary?: SessionAttendanceSummary }[]> {
  const summaries = await attendanceSummaries(
    client,
    rows.map((row) => row.id),
  );
  return rows.map((row) => ({ row, summary: summaries.get(row.id) }));
}

/** Sort allow-list (SES-01). Anything else is INVALID_SORT, never interpolated SQL. */
const SORT_COLUMNS: Record<string, string> = {
  startsAt: "s.starts_at",
  sessionDate: "s.session_date",
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
  }
  // Stable tiebreak so paging cannot repeat or skip rows (API_CONTRACTS §1).
  parts.push("s.starts_at asc", "s.id asc");
  return `order by ${parts.join(", ")}`;
}

// ---------------------------------------------------------------------------
// SES-01 — list
// ---------------------------------------------------------------------------
export const ses01List: Handler = async ({ viewer, query }): Promise<HandlerResult> => {
  const { page, pageSize, from, to, ageGroupId, status, sort } = query as {
    page: number;
    pageSize: number;
    from?: string;
    to?: string;
    ageGroupId?: string;
    status?: "scheduled" | "completed" | "cancelled";
    sort?: string;
  };
  const order = orderBy(sort);
  const isCoach = viewer.role === "coach";

  // The default window is today → +14 days. `from` is always $1, so the upper bound can
  // default to `$1::date + 14` in SQL and no date arithmetic happens in JavaScript.
  const values: unknown[] = [from ?? todayInTimeZone(viewer.academy.timezone)];
  const filters: string[] = ["s.session_date >= $1::date"];
  if (to) {
    values.push(to);
    filters.push(`s.session_date <= $${values.length}::date`);
  } else {
    filters.push("s.session_date <= $1::date + 14");
  }
  if (ageGroupId) {
    values.push(ageGroupId);
    filters.push(`s.age_group_id = $${values.length}`);
  }
  if (status) {
    values.push(status);
    filters.push(`s.status = $${values.length}`);
  }
  if (isCoach) {
    // Scope: an assignment held on the session's own date.
    values.push(viewer.userId);
    filters.push(`exists (
      select 1
        from coach_group_assignments a
       where a.coach_user_id = $${values.length}
         and a.age_group_id = s.age_group_id
         and a.assigned_from <= s.session_date
         and (a.assigned_to is null or a.assigned_to >= s.session_date)
    )`);
  }
  const where = `where ${filters.join(" and ")}`;

  const result = await asViewer(viewer, async (client) => {
    const countResult = await client.query<{ total: string }>(
      `select count(*)::text as total from sessions s ${where}`,
      values,
    );
    const pageResult = await client.query<SessionRow>(
      `${SESSION_SELECT} ${where} ${order}
         limit $${values.length + 1} offset $${values.length + 2}`,
      [...values, pageSize, (page - 1) * pageSize],
    );
    return {
      total: Number(countResult.rows[0]?.total ?? 0),
      rows: await withSummaries(client, pageResult.rows),
    };
  });

  return {
    status: 200,
    body: {
      data: result.rows.map(({ row, summary }) => serializeSession(row, summary)),
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
// SES-02 — create a one-off session
// ---------------------------------------------------------------------------
export const ses02Create: Handler = async ({ ctx, viewer, body }): Promise<HandlerResult> => {
  const input = body as {
    ageGroupId: string;
    startsAt: string;
    endsAt: string;
    venue?: string;
    leadCoachUserId?: string;
  };

  // Comparing two ISO instants is absolute, not a timezone calculation.
  if (
    Number.isNaN(new Date(input.startsAt).getTime()) ||
    Number.isNaN(new Date(input.endsAt).getTime()) ||
    new Date(input.endsAt).getTime() <= new Date(input.startsAt).getTime()
  ) {
    throw errors.validation([
      { field: "endsAt", issue: "The end time must be after the start time." },
    ]);
  }

  try {
    return await withTransaction({ userId: viewer.userId, role: viewer.role }, async (client) => {
      const group = await client.query("select 1 from age_groups where id = $1", [input.ageGroupId]);
      if (!group.rows[0]) throw errors.notFound();

      const id = uuidv7();
      const inserted = await client.query<SessionRow>(
        joinedFromCte("ins").replace(
          "<statement>",
          `insert into sessions
             (id, age_group_id, session_date, starts_at, ends_at, venue, status,
              lead_coach_user_id, created_by)
           values ($1, $2, ($3::timestamptz at time zone $8)::date, $3::timestamptz,
                   $4::timestamptz, $5, 'scheduled', $6, $7)
           returning ${SESSION_RETURNING}`,
        ),
        [
          id,
          input.ageGroupId,
          input.startsAt,
          input.endsAt,
          input.venue ?? null,
          input.leadCoachUserId ?? null,
          viewer.userId,
          viewer.academy.timezone,
        ],
      );
      const [withSummary] = await withSummaries(client, [inserted.rows[0]!]);
      const { row, summary } = withSummary!;
      await audit.record(client, viewerAudit(viewer, ctx), {
        action: "session.create",
        entityType: "session",
        entityId: id,
        after: serializeSession(row),
      });
      return { status: 201, body: serializeSession(row, summary) };
    });
  } catch (err) {
    if (isPgError(err) && err.code === "23505") {
      throw new ApiError(
        "SESSION_DUPLICATE",
        "Another session for this group already starts at that time.",
      );
    }
    mapPgError(err);
  }
};

// ---------------------------------------------------------------------------
// SES-03.read — read one session
// ---------------------------------------------------------------------------
export const ses03Read: Handler = async ({ viewer, params }): Promise<HandlerResult> => {
  const { id } = params as { id: string };
  const loaded = await asViewer(viewer, async (client) => {
    const result = await client.query<SessionRow>(`${SESSION_SELECT} where s.id = $1`, [id]);
    const found = result.rows[0];
    if (!found) return null;
    const [withSummary] = await withSummaries(client, [found]);
    return withSummary!;
  });
  // An out-of-scope session matches no policy, so it is invisible here: 404 is the honest
  // answer and existence is not confirmed (T-AUTH-04).
  if (!loaded) throw errors.notFound();
  return { status: 200, body: serializeSession(loaded.row, loaded.summary) };
};

// ---------------------------------------------------------------------------
// SES-03.update — owner edit
// ---------------------------------------------------------------------------
export const ses03Update: Handler = async ({ ctx, viewer, params, body }): Promise<HandlerResult> => {
  const { id } = params as { id: string };
  const input = body as {
    startsAt?: string;
    endsAt?: string;
    venue?: string;
    leadCoachUserId?: string;
    version: number;
  };

  if (
    input.startsAt !== undefined &&
    input.endsAt !== undefined &&
    new Date(input.endsAt).getTime() <= new Date(input.startsAt).getTime()
  ) {
    throw errors.validation([
      { field: "endsAt", issue: "The end time must be after the start time." },
    ]);
  }

  try {
    return await withTransaction({ userId: viewer.userId, role: viewer.role }, async (client) => {
      const beforeResult = await client.query<SessionRow>(`${SESSION_SELECT} where s.id = $1`, [id]);
      const before = beforeResult.rows[0];
      if (!before) throw errors.notFound();

      const updated = await client.query<SessionRow>(
        joinedFromCte("upd").replace(
          "<statement>",
          `update sessions
              set starts_at = coalesce($3::timestamptz, starts_at),
                  ends_at = coalesce($4::timestamptz, ends_at),
                  session_date = case
                    when $3::timestamptz is null then session_date
                    else ($3::timestamptz at time zone $9)::date
                  end,
                  venue = case when $5::boolean then $6::text else venue end,
                  lead_coach_user_id = case
                    when $7::boolean then $8::uuid else lead_coach_user_id
                  end
            where id = $1 and version = $2
            returning ${SESSION_RETURNING}`,
        ),
        [
          id,
          input.version,
          input.startsAt ?? null,
          input.endsAt ?? null,
          input.venue !== undefined,
          input.venue?.trim() ?? null,
          input.leadCoachUserId !== undefined,
          input.leadCoachUserId ?? null,
          viewer.academy.timezone,
        ],
      );
      const updatedRow = updated.rows[0];
      if (!updatedRow) throw errors.versionConflict();

      const [withSummary] = await withSummaries(client, [updatedRow]);
      const { row, summary } = withSummary!;
      await audit.record(client, viewerAudit(viewer, ctx), {
        action: "session.update",
        entityType: "session",
        entityId: id,
        before: serializeSession(before),
        after: serializeSession(row),
      });
      return { status: 200, body: serializeSession(row, summary) };
    });
  } catch (err) {
    if (isPgError(err) && err.code === "23505") {
      throw new ApiError(
        "SESSION_DUPLICATE",
        "Another session for this group already starts at that time.",
      );
    }
    mapPgError(err);
  }
};

// ---------------------------------------------------------------------------
// SES-04 — cancel
// ---------------------------------------------------------------------------
export const ses04Cancel: Handler = async ({ ctx, viewer, params, body }): Promise<HandlerResult> => {
  const { id } = params as { id: string };
  const { reason } = body as { reason: string };

  try {
    return await withTransaction({ userId: viewer.userId, role: viewer.role }, async (client) => {
      // Lock the row so two cancels cannot interleave into a lost update.
      const existing = await client.query<{ id: string; status: string }>(
        "select id, status from sessions where id = $1 for update",
        [id],
      );
      const found = existing.rows[0];
      if (!found) throw errors.notFound();
      if (found.status === "cancelled") {
        throw new ApiError("INVALID_STATE_TRANSITION", "This session is already cancelled.");
      }

      // Attendance rows are deliberately left alone: a cancelled session keeps its marks
      // and is excluded from attendance-rate maths (T-ATT-10).
      const updated = await client.query<SessionRow>(
        joinedFromCte("upd").replace(
          "<statement>",
          `update sessions set status = 'cancelled', cancel_reason = $2
            where id = $1
            returning ${SESSION_RETURNING}`,
        ),
        [id, reason],
      );
      const [withSummary] = await withSummaries(client, [updated.rows[0]!]);
      const { row, summary } = withSummary!;

      await audit.record(client, viewerAudit(viewer, ctx), {
        action: "session.cancel",
        entityType: "session",
        entityId: id,
        before: { status: found.status },
        after: serializeSession(row),
        reason,
      });
      return { status: 200, body: serializeSession(row, summary) };
    });
  } catch (err) {
    mapPgError(err);
  }
};
