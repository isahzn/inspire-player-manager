/**
 * DSH-02 — the coach dashboard (API_CONTRACTS §3.8).
 *
 * This is the coach's own page: the sessions of the groups they hold, and **their own**
 * clock-in state. Three rules matter here:
 *
 *  - **Scope is the caller's, decided in SQL.** An assignment held on *each session's own
 *    date* scopes the lists — and RLS enforces the same thing — so a coach never sees a
 *    session of a group they do not hold (AUTH §6).
 *  - **No financial field exists here.** The payload has no invoice, fee or balance: this is
 *    the projection a coach is allowed to have (CLAUDE.md §3).
 *  - **`myOpenCheckIn` is the caller's own record**, which is what drives the one-tap
 *    clock-out (CR-003); `myWeekMinutes` counts **closed** records only, in the academy's
 *    own week.
 *
 * `DSH-01` (the owner dashboard) is not served here: its `messaging` block reads
 * `message_jobs`, which arrives with M7, and `coachTime` is CR-003 — see the handoff.
 */
import { asViewer } from "../http/context.js";
import type { Handler, HandlerResult } from "../http/router.js";
import { todayInTimeZone } from "./people-helpers.js";
import { SESSION_SELECT, withSummaries } from "./sessions.js";
import {
  serializeCoachAttendance,
  serializeSession,
  type CoachAttendanceRow,
  type SessionRow,
} from "./attendance-serialize.js";

/** The coach's own open record, with the session/group names the contract's shape needs. */
const OPEN_CHECK_IN_SELECT = `select c.id, c.coach_user_id, u.full_name as coach_name, c.session_id,
                                     g.name as age_group_name, s.starts_at, c.check_in_at,
                                     c.check_out_at, c.entered_by, c.corrected, c.check_in_note,
                                     c.version
                                from coach_attendance c
                                join users u on u.id = c.coach_user_id
                                join sessions s on s.id = c.session_id
                                join age_groups g on g.id = s.age_group_id`;

/** The same "assignment held on the session's date" predicate SES-01 uses. */
const COACH_SCOPE = (param: string) => `exists (
  select 1
    from coach_group_assignments a
   where a.coach_user_id = ${param}
     and a.age_group_id = s.age_group_id
     and a.assigned_from <= s.session_date
     and (a.assigned_to is null or a.assigned_to >= s.session_date)
)`;

export const dsh02Coach: Handler = async ({ viewer }): Promise<HandlerResult> => {
  const today = todayInTimeZone(viewer.academy.timezone);

  const body = await asViewer(viewer, async (client) => {
    const todaySessions = await client.query<SessionRow>(
      `${SESSION_SELECT}
        where s.session_date = $1::date and ${COACH_SCOPE("$2")}
        order by s.starts_at asc, s.id asc`,
      [today, viewer.userId],
    );

    const upcoming = await client.query<SessionRow>(
      `${SESSION_SELECT}
        where s.session_date > $1::date and s.session_date <= $1::date + 7
          and ${COACH_SCOPE("$2")}
        order by s.starts_at asc, s.id asc`,
      [today, viewer.userId],
    );

    const open = await client.query<CoachAttendanceRow>(
      `${OPEN_CHECK_IN_SELECT}
        where c.coach_user_id = $1 and c.check_out_at is null
        order by c.check_in_at desc, c.id desc
        limit 1`,
      [viewer.userId],
    );

    // Closed records only (T-ATT-11): a still-open shift is not time worked. The week is the
    // academy's own — `date_trunc('week')` is Monday-based, computed in the academy timezone.
    const week = await client.query<{ minutes: string }>(
      `select coalesce(sum(extract(epoch from (check_out_at - check_in_at)) / 60), 0)::text
                as minutes
         from coach_attendance
        where coach_user_id = $1
          and check_out_at is not null
          and (check_in_at at time zone $2)::date
              >= date_trunc('week', (now() at time zone $2))::date`,
      [viewer.userId, viewer.academy.timezone],
    );

    const [todayWithSummaries, upcomingWithSummaries] = [
      await withSummaries(client, todaySessions.rows),
      await withSummaries(client, upcoming.rows),
    ];

    const openRecord = open.rows[0];
    return {
      todaySessions: todayWithSummaries.map(({ row, summary }) => serializeSession(row, summary)),
      upcoming: upcomingWithSummaries.map(({ row, summary }) => serializeSession(row, summary)),
      ...(openRecord ? { myOpenCheckIn: serializeCoachAttendance(openRecord) } : {}),
      myWeekMinutes: Number(week.rows[0]?.minutes ?? 0),
    };
  });

  return { status: 200, body };
};
