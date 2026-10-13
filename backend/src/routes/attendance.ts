/**
 * ATT-01..03 — the attendance sheet (API_CONTRACTS §3.5, M4).
 *
 * Three rules the code is responsible for, each enforced twice (API *and* the policies
 * in migration `0011`):
 *
 *  - **The roster is not a filter.** It comes from `rosterForSession` (the player's group
 *    history must cover the session date for the session's group, and they were active on
 *    that date). Saving a mark for anyone else is `PLAYER_NOT_ON_ROSTER` **before any
 *    write**, so a bad row cannot leave half a sheet saved.
 *  - **The coach's edit window is a deadline, not a suggestion.** Owners are never
 *    windowed; a coach outside `starts_at + attendance_coach_edit_window_hours` gets 422
 *    `ATTENDANCE_WINDOW_CLOSED`. RLS refuses the same writes, so a handler bug cannot
 *    quietly rewrite history.
 *  - **Changing a saved mark needs a reason** (5–200), for every caller. An unchanged
 *    record is skipped entirely — no write, no audit row.
 */
import { withTransaction } from "../db/pool.js";
import { asViewer } from "../http/context.js";
import { ApiError, errors } from "../errors.js";
import { mapPgError } from "../db/pg-errors.js";
import * as audit from "../audit.js";
import { uuidv7 } from "../ids.js";
import { withIdempotency } from "../http/idempotency.js";
import type { Handler, HandlerResult } from "../http/router.js";
import { viewerAudit } from "./auth.js";
import { editableUntil, loadSessionRow, rosterForSession } from "./attendance-helpers.js";
import {
  serializeRosterRow,
  serializeSessionAttendance,
  type AttendanceRecordRow,
} from "./attendance-serialize.js";

type AttendanceStatus = "present" | "absent" | "late" | "excused";

interface AttendanceRecordInput {
  playerId: string;
  status: AttendanceStatus;
  note?: string;
  version?: number;
  reason?: string;
}

interface StoredRecord {
  id: string;
  status: string;
  note: string | null;
  version: number;
}

const MIN_REASON = 5;

/** An owner may always write; a coach only until the edit window closes. */
function withinWindow(until: Date, role: "owner" | "coach"): boolean {
  return role === "owner" || Date.now() <= until.getTime();
}

// ---------------------------------------------------------------------------
// ATT-01 — read the sheet
// ---------------------------------------------------------------------------
export const att01Read: Handler = async ({ viewer, params }): Promise<HandlerResult> => {
  const { id } = params as { id: string };

  const loaded = await asViewer(viewer, async (client) => {
    // RLS hides a session of a group the coach does not hold on that date, so an
    // out-of-scope id reaches `notFound()` here rather than a 403.
    const session = await loadSessionRow(client, id);
    if (!session) throw errors.notFound();
    const roster = await rosterForSession(client, session);
    const until = await editableUntil(client, id);
    return { session, roster, until };
  });

  return {
    status: 200,
    body: serializeSessionAttendance(
      loaded.session,
      loaded.roster,
      loaded.until,
      withinWindow(loaded.until, viewer.role),
    ),
  };
};

// ---------------------------------------------------------------------------
// ATT-02 — bulk save (T8, all-or-nothing, idempotent)
// ---------------------------------------------------------------------------
const att02SaveInner: Handler = async ({ ctx, viewer, params, body }): Promise<HandlerResult> => {
  const { id } = params as { id: string };
  const { records } = body as { records: AttendanceRecordInput[] };

  try {
    return await withTransaction({ userId: viewer.userId, role: viewer.role }, async (client) => {
      const session = await loadSessionRow(client, id);
      if (!session) throw errors.notFound();

      const until = await editableUntil(client, id);
      if (!withinWindow(until, viewer.role)) {
        throw new ApiError(
          "ATTENDANCE_WINDOW_CLOSED",
          "This session can no longer be marked. Ask an owner to make the change.",
        );
      }

      // --- Validate the whole batch before writing anything (all-or-nothing) -------
      const roster = await rosterForSession(client, session);
      const onRoster = new Set(roster.map((row) => row.player_id));
      const offRoster = records.filter((record) => !onRoster.has(record.playerId));
      if (offRoster.length > 0) {
        throw new ApiError(
          "PLAYER_NOT_ON_ROSTER",
          "A player is not on this session's roster.",
          [
            {
              field: "records",
              issue: `${offRoster.length} record(s) name a player who is not on this session's roster.`,
              meta: { playerIds: offRoster.map((record) => record.playerId) },
            },
          ],
        );
      }

      let saved = 0;
      for (let index = 0; index < records.length; index += 1) {
        const record = records[index]!;

        const existing = await client.query<StoredRecord>(
          `select id, status, note, version
             from player_attendance
            where session_id = $1 and player_id = $2`,
          [id, record.playerId],
        );
        const before = existing.rows[0];
        const changed =
          !before ||
          before.status !== record.status ||
          (record.note ?? null) !== (before.note ?? null);
        // An unchanged record writes nothing and is not audited (T8: one row per change).
        if (!changed) continue;

        if (before) {
          if (!record.reason || record.reason.trim().length < MIN_REASON) {
            throw new ApiError("REASON_REQUIRED", "Changing a saved mark needs a reason.", [
              {
                field: `records[${index}].reason`,
                issue: `Give a reason (at least ${MIN_REASON} characters) when changing a saved mark.`,
              },
            ]);
          }
          if (record.version !== undefined && record.version !== before.version) {
            throw errors.versionConflict();
          }
        }

        const written = await client.query<{ id: string }>(
          `insert into player_attendance (id, session_id, player_id, status, note, marked_by)
           values ($1, $2, $3, $4, $5, $6)
           on conflict (session_id, player_id) do update
             set status = excluded.status,
                 note = excluded.note,
                 updated_by = $6,
                 updated_at = now()
           returning id`,
          [uuidv7(), id, record.playerId, record.status, record.note ?? null, viewer.userId],
        );

        await audit.record(client, viewerAudit(viewer, ctx), {
          action: "attendance.bulk_save",
          entityType: "player_attendance",
          entityId: written.rows[0]!.id,
          before: before ? { status: before.status, note: before.note } : undefined,
          after: { status: record.status, note: record.note ?? null },
          ...(record.reason ? { reason: record.reason } : {}),
        });
        saved += 1;
      }

      // Recompute rather than patch: the response must be the sheet as it now stands.
      const fresh = await rosterForSession(client, session);
      return {
        status: 200,
        body: { saved, roster: fresh.map(serializeRosterRow) },
      };
    });
  } catch (err) {
    mapPgError(err);
  }
};

/** Idempotent: a retried save with the same `Idempotency-Key` replays, never re-writes. */
export const att02Save: Handler = withIdempotency(att02SaveInner);

// ---------------------------------------------------------------------------
// ATT-03 — correct one record
// ---------------------------------------------------------------------------
export const att03Correct: Handler = async ({ ctx, viewer, params, body }): Promise<HandlerResult> => {
  const { id, playerId } = params as { id: string; playerId: string };
  const input = body as {
    status?: AttendanceStatus;
    note?: string;
    reason: string;
    version: number;
  };

  try {
    return await withTransaction({ userId: viewer.userId, role: viewer.role }, async (client) => {
      const session = await loadSessionRow(client, id);
      if (!session) throw errors.notFound();

      const until = await editableUntil(client, id);
      if (!withinWindow(until, viewer.role)) {
        throw new ApiError(
          "ATTENDANCE_WINDOW_CLOSED",
          "This session can no longer be edited. Ask an owner to make the change.",
        );
      }

      const existing = await client.query<StoredRecord>(
        `select id, status, note, version
           from player_attendance
          where session_id = $1 and player_id = $2`,
        [id, playerId],
      );
      const before = existing.rows[0];
      if (!before) throw errors.notFound();
      if (before.version !== input.version) throw errors.versionConflict();

      await client.query(
        `update player_attendance
            set status = coalesce($2, status),
                note = case when $3::boolean then $4::text else note end,
                updated_by = $5
          where id = $1`,
        [before.id, input.status ?? null, input.note !== undefined, input.note ?? null, viewer.userId],
      );

      await audit.record(client, viewerAudit(viewer, ctx), {
        action: "attendance.correct",
        entityType: "player_attendance",
        entityId: before.id,
        before: { status: before.status, note: before.note },
        after: {
          status: input.status ?? before.status,
          note: input.note !== undefined ? input.note : before.note,
        },
        reason: input.reason,
      });

      const updated = await client.query<AttendanceRecordRow>(
        `select p.id as player_id, p.full_name as player_name, p.registration_no,
                a.status, a.note, a.marked_at, a.marked_by, a.version as record_version
           from player_attendance a
           join players p on p.id = a.player_id
          where a.id = $1`,
        [before.id],
      );
      return { status: 200, body: serializeRosterRow(updated.rows[0]!) };
    });
  } catch (err) {
    mapPgError(err);
  }
};
