/**
 * Shared logic for attendance and coach time (M4).
 *
 * The **roster rule** lives here so ATT-01, ATT-02, `Session.attendanceSummary` and
 * PLY-10 cannot drift from one another (ATTENDANCE §3):
 *
 *   roster(session) = players whose `player_group_history` covers the session's date for
 *   the session's group **and** who were active on that date. `status_effective_date` is
 *   what makes "active on that date" a real question: a player withdrawn in June belongs
 *   in May's roster and in none after it.
 *
 * The window helpers call the SECURITY DEFINER functions from migration `0011` rather
 * than reading `academy_settings` (owner-only, invisible to a coach).
 */
import type { PoolClient } from "pg";
import type {
  AttendanceRecordRow,
  SessionAttendanceSummary,
  SessionRow,
} from "./attendance-serialize.js";

/** The joined session projection every session-shaped response uses. */
export const SESSION_SELECT = `select s.id, s.age_group_id, g.name as age_group_name, s.schedule_id,
          s.session_date, s.starts_at, s.ends_at, s.venue, s.status, s.cancel_reason,
          s.lead_coach_user_id, u.full_name as lead_coach_name, s.version
     from sessions s
     join age_groups g on g.id = s.age_group_id
     left join users u on u.id = s.lead_coach_user_id`;

export async function loadSessionRow(
  client: PoolClient,
  sessionId: string,
): Promise<SessionRow | null> {
  const result = await client.query<SessionRow>(`${SESSION_SELECT} where s.id = $1`, [sessionId]);
  return result.rows[0] ?? null;
}

/** The roster of one session, each row carrying its attendance record when one exists. */
export async function rosterForSession(
  client: PoolClient,
  session: Pick<SessionRow, "id" | "age_group_id" | "session_date">,
): Promise<AttendanceRecordRow[]> {
  const result = await client.query<AttendanceRecordRow>(
    `select p.id as player_id, p.full_name as player_name, p.registration_no,
            a.status, a.note, a.marked_at, a.marked_by, a.version as record_version
       from player_group_history h
       join players p on p.id = h.player_id
       left join player_attendance a on a.session_id = $2 and a.player_id = p.id
      where h.age_group_id = $1
        and h.effective_from <= $3::date
        and (h.effective_to is null or h.effective_to >= $3::date)
        and (p.status = 'active' or p.status_effective_date > $3::date)
      order by p.full_name asc, p.id asc`,
    [session.age_group_id, session.id, session.session_date],
  );
  return result.rows;
}


/** Marked/unmarked counts for a set of sessions, in one round trip (no N+1). */
export async function attendanceSummaries(
  client: PoolClient,
  sessionIds: string[],
): Promise<Map<string, SessionAttendanceSummary>> {
  const out = new Map<string, SessionAttendanceSummary>();
  if (sessionIds.length === 0) return out;

  const result = await client.query<{
    session_id: string;
    roster: string;
    marked: string;
    present: string;
    absent: string;
    late: string;
    excused: string;
  }>(
    `select s.id as session_id,
            (select count(*)
               from player_group_history h
               join players p on p.id = h.player_id
              where h.age_group_id = s.age_group_id
                and h.effective_from <= s.session_date
                and (h.effective_to is null or h.effective_to >= s.session_date)
                and (p.status = 'active' or p.status_effective_date > s.session_date))::text as roster,
            (select count(*) from player_attendance a where a.session_id = s.id)::text as marked,
            (select count(*) from player_attendance a where a.session_id = s.id and a.status = 'present')::text as present,
            (select count(*) from player_attendance a where a.session_id = s.id and a.status = 'absent')::text as absent,
            (select count(*) from player_attendance a where a.session_id = s.id and a.status = 'late')::text as late,
            (select count(*) from player_attendance a where a.session_id = s.id and a.status = 'excused')::text as excused
       from sessions s
      where s.id = any ($1::uuid[])`,
    [sessionIds],
  );

  for (const row of result.rows) {
    out.set(row.session_id, {
      present: Number(row.present),
      absent: Number(row.absent),
      late: Number(row.late),
      excused: Number(row.excused),
      unmarked: Math.max(0, Number(row.roster) - Number(row.marked)),
    });
  }
  return out;
}

/** `starts_at + attendance_coach_edit_window_hours` — the coach's write deadline. */
export async function editableUntil(client: PoolClient, sessionId: string): Promise<Date> {
  const result = await client.query<{ until: Date }>(
    `select app.attendance_editable_until($1) as until`,
    [sessionId],
  );
  return result.rows[0]!.until;
}

/** The self-check-in window of a session, from the settings' open/close minutes. */
export async function coachCheckinWindow(
  client: PoolClient,
  sessionId: string,
): Promise<{ opensAt: Date; closesAt: Date } | null> {
  const result = await client.query<{ opens_at: Date; closes_at: Date }>(
    `select opens_at, closes_at from app.coach_checkin_window($1)`,
    [sessionId],
  );
  const row = result.rows[0];
  return row ? { opensAt: row.opens_at, closesAt: row.closes_at } : null;
}
