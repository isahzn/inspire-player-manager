/**
 * CAT-01..05 — coach time (API_CONTRACTS §3.5, DATABASE §3.5, M4).
 *
 * Coach time is **self-reported**, and the code is written to keep that honest:
 *
 *  - `check_in_at`/`check_out_at` for a self check-in/out are `now()` **in SQL**. A
 *    client-supplied time is never accepted, so a coach cannot backdate a clock-in
 *    (AUTH §7). This record does not prove physical presence and no response says it does.
 *  - The check-in window (`starts_at − opens_before` … `ends_at + closes_after`) is read
 *    through `app.coach_checkin_window`, a SECURITY DEFINER helper — the minutes live in
 *    the owner-only `academy_settings` table, which a coach cannot read. The window is
 *    also compared in SQL, so it is the database's clock that decides.
 *  - `entered_by` distinguishes a coach's own tap from an owner's paper-sign-in entry, and
 *    `corrected` is set only by CAT-05 — an owner's correction is what makes a self-report
 *    trustworthy (T-ATT-08).
 *
 * `version`/`updated_at` are trigger-maintained (0011); nothing here writes them.
 */
import { withTransaction } from "../db/pool.js";
import { asViewer } from "../http/context.js";
import { errors, ApiError } from "../errors.js";
import { isPgError, mapPgError } from "../db/pg-errors.js";
import * as audit from "../audit.js";
import { uuidv7 } from "../ids.js";
import type { Handler, HandlerResult } from "../http/router.js";
import { viewerAudit } from "./auth.js";
import { coachCheckinWindow } from "./attendance-helpers.js";
import { serializeCoachAttendance, type CoachAttendanceRow } from "./attendance-serialize.js";

/** The joined projection every response uses: the coach's and the session's names. */
const CAT_SELECT = `select c.id, c.coach_user_id, u.full_name as coach_name, c.session_id,
                           g.name as age_group_name, s.starts_at, c.check_in_at,
                           c.check_out_at, c.entered_by, c.corrected, c.check_in_note,
                           c.version
                      from coach_attendance c
                      join users u on u.id = c.coach_user_id
                      join sessions s on s.id = c.session_id
                      join age_groups g on g.id = s.age_group_id`;

/** Columns a RETURNING clause must repeat so the CTE below can join on them. */
const CAT_RETURNING = `id, coach_user_id, session_id, check_in_at, check_out_at, entered_by,
                       corrected, check_in_note, version`;

/** Wraps an inserted/updated row so the joined names come back in one round trip. */
function joinedFromCte(cte: string, statement: string): string {
  return `with ${cte} as (
            ${statement}
          )
          select w.id, w.coach_user_id, u.full_name as coach_name, w.session_id,
                 g.name as age_group_name, s.starts_at, w.check_in_at, w.check_out_at,
                 w.entered_by, w.corrected, w.check_in_note, w.version
            from ${cte} w
            join users u on u.id = w.coach_user_id
            join sessions s on s.id = w.session_id
            join age_groups g on g.id = s.age_group_id`;
}

// ---------------------------------------------------------------------------
// CAT-01 — clock in
// ---------------------------------------------------------------------------
export const cat01CheckIn: Handler = async ({ ctx, viewer, body }): Promise<HandlerResult> => {
  const { sessionId, note } = body as { sessionId: string; note?: string };

  try {
    return await withTransaction({ userId: viewer.userId, role: viewer.role }, async (client) => {
      // The session must be one the caller may see: RLS hides an unassigned group's
      // session, so 404 (not 403) is the honest answer.
      const session = await client.query("select id from sessions where id = $1", [sessionId]);
      if (!session.rows[0]) throw errors.notFound();

      const window = await coachCheckinWindow(client, sessionId);
      if (!window) throw errors.notFound();

      // The server's clock decides, not the caller's.
      const allowed = await client.query<{ allowed: boolean }>(
        `select (now() >= $1::timestamptz and now() <= $2::timestamptz) as allowed`,
        [window.opensAt, window.closesAt],
      );
      if (!allowed.rows[0]!.allowed) {
        throw new ApiError(
          "CHECKIN_WINDOW_CLOSED",
          "Check-in is not open for this session right now.",
        );
      }

      const existing = await client.query<{ id: string }>(
        `select id
           from coach_attendance
          where coach_user_id = $1
            and (check_out_at is null or session_id = $2)
          limit 1`,
        [viewer.userId, sessionId],
      );
      if (existing.rows[0]) {
        throw new ApiError("ALREADY_CHECKED_IN", "You already have an open check-in.");
      }

      const id = uuidv7();
      const inserted = await client.query<CoachAttendanceRow>(
        joinedFromCte(
          "ins",
          `insert into coach_attendance
             (id, coach_user_id, session_id, check_in_at, check_in_note, entered_by)
           values ($1, $2, $3, now(), $4, 'self')
           returning ${CAT_RETURNING}`,
        ),
        [id, viewer.userId, sessionId, note ?? null],
      );
      const row = inserted.rows[0]!;
      await audit.record(client, viewerAudit(viewer, ctx), {
        action: "coach_attendance.check_in",
        entityType: "coach_attendance",
        entityId: id,
        after: serializeCoachAttendance(row),
      });
      return { status: 201, body: serializeCoachAttendance(row) };
    });
  } catch (err) {
    // Either unique index (one open per coach, one per session) means the same thing.
    if (isPgError(err) && err.code === "23505") {
      throw new ApiError("ALREADY_CHECKED_IN", "You already have an open check-in.");
    }
    mapPgError(err);
  }
};

// ---------------------------------------------------------------------------
// CAT-02 — clock out
// ---------------------------------------------------------------------------
export const cat02CheckOut: Handler = async ({ ctx, viewer, body }): Promise<HandlerResult> => {
  const { sessionId } = body as { sessionId: string };

  try {
    return await withTransaction({ userId: viewer.userId, role: viewer.role }, async (client) => {
      const open = await client.query<{ id: string }>(
        `select id
           from coach_attendance
          where coach_user_id = $1 and session_id = $2 and check_out_at is null
          for update`,
        [viewer.userId, sessionId],
      );
      const found = open.rows[0];
      if (!found) {
        throw new ApiError("NO_OPEN_CHECK_IN", "You have no open check-in for this session.");
      }

      const updated = await client.query<CoachAttendanceRow>(
        joinedFromCte(
          "upd",
          `update coach_attendance set check_out_at = now()
            where id = $1
            returning ${CAT_RETURNING}`,
        ),
        [found.id],
      );
      const row = updated.rows[0]!;
      await audit.record(client, viewerAudit(viewer, ctx), {
        action: "coach_attendance.check_out",
        entityType: "coach_attendance",
        entityId: found.id,
        after: serializeCoachAttendance(row),
      });
      return { status: 200, body: serializeCoachAttendance(row) };
    });
  } catch (err) {
    mapPgError(err);
  }
};

// ---------------------------------------------------------------------------
// CAT-03 — list
// ---------------------------------------------------------------------------
export const cat03List: Handler = async ({ viewer, query }): Promise<HandlerResult> => {
  const { page, pageSize, from, to, coachUserId } = query as {
    page: number;
    pageSize: number;
    from?: string;
    to?: string;
    coachUserId?: string;
  };
  const isOwner = viewer.role === "owner";

  const values: unknown[] = [];
  const filters: string[] = [];

  // Scope: a coach sees only their own rows, so `coachUserId` is ignored for them.
  if (isOwner) {
    if (coachUserId) {
      values.push(coachUserId);
      filters.push(`c.coach_user_id = $${values.length}`);
    }
  } else {
    values.push(viewer.userId);
    filters.push(`c.coach_user_id = $${values.length}`);
  }

  // Dates are academy-local business days, so the check-in instant is converted first.
  // The timezone placeholder is appended **only** when a bound needs it: parameters are
  // shared with the count query, and one the count's SQL never references makes Postgres
  // reject the statement ("bind message supplies N parameters, but … requires M").
  let tzIndex = 0;
  if (from || to) {
    values.push(viewer.academy.timezone);
    tzIndex = values.length;
  }
  const localDate = `(c.check_in_at at time zone $${tzIndex})::date`;
  if (from) {
    values.push(from);
    filters.push(`${localDate} >= $${values.length}::date`);
  }
  if (to) {
    values.push(to);
    filters.push(`${localDate} <= $${values.length}::date`);
  }
  const where = filters.length ? `where ${filters.join(" and ")}` : "";

  const { total, rows } = await asViewer(viewer, async (client) => {
    const countResult = await client.query<{ total: string }>(
      `select count(*)::text as total from coach_attendance c ${where}`,
      values,
    );
    const pageResult = await client.query<CoachAttendanceRow>(
      `${CAT_SELECT} ${where} order by c.check_in_at desc, c.id desc
         limit $${values.length + 1} offset $${values.length + 2}`,
      [...values, pageSize, (page - 1) * pageSize],
    );
    return { total: Number(countResult.rows[0]?.total ?? 0), rows: pageResult.rows };
  });

  return {
    status: 200,
    body: {
      data: rows.map(serializeCoachAttendance),
      meta: {
        page,
        pageSize,
        total,
        totalPages: pageSize > 0 ? Math.ceil(total / pageSize) : 0,
      },
    },
  };
};

// ---------------------------------------------------------------------------
// CAT-04 — owner records a coach's time (paper sign-in)
// ---------------------------------------------------------------------------
export const cat04Create: Handler = async ({ ctx, viewer, body }): Promise<HandlerResult> => {
  const input = body as {
    coachUserId: string;
    sessionId: string;
    checkInAt: string;
    checkOutAt?: string;
    reason: string;
  };

  if (
    input.checkOutAt !== undefined &&
    new Date(input.checkOutAt).getTime() <= new Date(input.checkInAt).getTime()
  ) {
    throw errors.validation([
      { field: "checkOutAt", issue: "The check-out time must be after the check-in time." },
    ]);
  }

  try {
    return await withTransaction({ userId: viewer.userId, role: viewer.role }, async (client) => {
      const coach = await client.query(
        "select 1 from users where id = $1 and role = 'coach'",
        [input.coachUserId],
      );
      if (!coach.rows[0]) throw errors.notFound();
      const session = await client.query("select 1 from sessions where id = $1", [
        input.sessionId,
      ]);
      if (!session.rows[0]) throw errors.notFound();

      const open = await client.query<{ id: string }>(
        `select id from coach_attendance where coach_user_id = $1 and check_out_at is null`,
        [input.coachUserId],
      );
      if (open.rows[0]) {
        throw new ApiError(
          "ALREADY_CHECKED_IN",
          "That coach already has an open check-in. Ask them to clock out, or close it first.",
        );
      }

      const id = uuidv7();
      const inserted = await client.query<CoachAttendanceRow>(
        joinedFromCte(
          "ins",
          `insert into coach_attendance
             (id, coach_user_id, session_id, check_in_at, check_out_at, entered_by)
           values ($1, $2, $3, $4::timestamptz, $5::timestamptz, 'owner')
           returning ${CAT_RETURNING}`,
        ),
        [id, input.coachUserId, input.sessionId, input.checkInAt, input.checkOutAt ?? null],
      );
      const row = inserted.rows[0]!;
      await audit.record(client, viewerAudit(viewer, ctx), {
        action: "coach_attendance.create",
        entityType: "coach_attendance",
        entityId: id,
        after: serializeCoachAttendance(row),
        reason: input.reason,
      });
      return { status: 201, body: serializeCoachAttendance(row) };
    });
  } catch (err) {
    if (isPgError(err) && err.code === "23505") {
      throw new ApiError(
        "ALREADY_CHECKED_IN",
        "That coach already has a record for this session.",
      );
    }
    mapPgError(err);
  }
};

// ---------------------------------------------------------------------------
// CAT-05 — owner corrects a record
// ---------------------------------------------------------------------------
export const cat05Correct: Handler = async ({ ctx, viewer, params, body }): Promise<HandlerResult> => {
  const { id } = params as { id: string };
  const input = body as {
    checkInAt?: string;
    checkOutAt?: string;
    reason: string;
    version: number;
  };

  try {
    return await withTransaction({ userId: viewer.userId, role: viewer.role }, async (client) => {
      const beforeResult = await client.query<CoachAttendanceRow>(
        `${CAT_SELECT} where c.id = $1`,
        [id],
      );
      const before = beforeResult.rows[0];
      if (!before) throw errors.notFound();

      const updated = await client.query<CoachAttendanceRow>(
        joinedFromCte(
          "upd",
          `update coach_attendance
              set check_in_at = coalesce($3::timestamptz, check_in_at),
                  check_out_at = case
                    when $4::boolean then $5::timestamptz
                    else check_out_at
                  end,
                  corrected = true
            where id = $1 and version = $2
            returning ${CAT_RETURNING}`,
        ),
        [id, input.version, input.checkInAt ?? null, input.checkOutAt !== undefined, input.checkOutAt ?? null],
      );
      const row = updated.rows[0];
      if (!row) throw errors.versionConflict();

      await audit.record(client, viewerAudit(viewer, ctx), {
        action: "coach_attendance.correct",
        entityType: "coach_attendance",
        entityId: id,
        before: serializeCoachAttendance(before),
        after: serializeCoachAttendance(row),
        reason: input.reason,
      });
      return { status: 200, body: serializeCoachAttendance(row) };
    });
  } catch (err) {
    // A correction that puts check-out before check-in is refused by the table's CHECK.
    mapPgError(err);
  }
};
