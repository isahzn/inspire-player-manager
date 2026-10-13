/**
 * API_CONTRACTS §3.5 — schedules, sessions, player attendance, coach time.
 *
 * The rules that matter here (ATTENDANCE §4, AUTH §6):
 *  - a coach may only touch a session whose group is assigned to them on the
 *    session's date, and only inside `attendance_coach_edit_window_hours`;
 *  - changing an existing mark requires a reason, for coaches *and* owners;
 *  - check-in is a self-reported server timestamp inside the configured window,
 *    ignores any client-supplied time, and never proves physical presence.
 */
import { endpoint, section, res, z, type Section } from "../registry.js";
import {
  AttendanceRecordInput,
  CoachAttendance,
  DateStr,
  HHmm,
  Id,
  Instant,
  RosterRow,
  Session,
  SessionAttendance,
  TrainingSchedule,
  dateRangeQuery,
  listOf,
  pageOf,
  pageQuery,
  sortParam,
} from "../components.js";

const idParam = z.object({ id: Id });
const sessionParam = z.object({ id: Id });
const attendanceParam = z.object({ id: Id, playerId: Id });

const sessionStatus = z.enum(["scheduled", "completed", "cancelled"]);

export const sessionsAttendanceSection: Section = section("3.5 Sessions and attendance", [
  // -------------------------------------------------------------------------
  // Schedules (SCH-01..02)
  // -------------------------------------------------------------------------
  endpoint({
    id: "SCH-01",
    operationId: "SCH-01.list",
    method: "get",
    path: "/training-schedules",
    auth: "owner",
    permission: "sessions:manage",
    summary: "List training schedules",
    description:
      "Tuesday/Thursday rows are seed data, not code: deleting them changes nothing in the application (T-ATT-02).",
    tags: ["Attendance"],
    query: z.object({ ageGroupId: Id.optional(), includeInactive: z.coerce.boolean().optional() }),
    responses: [res.json(200, listOf(TrainingSchedule), "Schedules")],
    milestone: "m4",
  }),

  endpoint({
    id: "SCH-01",
    operationId: "SCH-01.create",
    method: "post",
    path: "/training-schedules",
    auth: "owner",
    permission: "sessions:manage",
    summary: "Create a training schedule",
    description:
      "Creates the recurring rule only. Future sessions come from SCH-02 (or the daily generator); existing sessions are never rewritten by a schedule change.",
    tags: ["Attendance"],
    mutating: true,
    audit: "training_schedule.create",
    body: z.strictObject({
      ageGroupId: Id,
      weekday: z.number().int().min(1).max(7),
      startTime: HHmm,
      endTime: HHmm,
      venue: z.string().max(120).optional(),
      validFrom: DateStr,
      validTo: DateStr.optional(),
    }),
    responses: [res.json(201, TrainingSchedule, "Created schedule")],
    milestone: "m4",
  }),

  endpoint({
    id: "SCH-01",
    operationId: "SCH-01.update",
    method: "patch",
    path: "/training-schedules/{id}",
    auth: "owner",
    permission: "sessions:manage",
    summary: "Update a training schedule",
    tags: ["Attendance"],
    params: idParam,
    mutating: true,
    audit: "training_schedule.update",
    body: z.strictObject({
      startTime: HHmm.optional(),
      endTime: HHmm.optional(),
      venue: z.string().max(120).optional(),
      validFrom: DateStr.optional(),
      validTo: DateStr.optional(),
      isActive: z.boolean().optional(),
    }),
    responses: [res.json(200, TrainingSchedule, "Updated schedule")],
    milestone: "m4",
  }),

  endpoint({
    id: "SCH-01",
    operationId: "SCH-01.deactivate",
    method: "post",
    path: "/training-schedules/{id}/deactivate",
    auth: "owner",
    permission: "sessions:manage",
    summary: "Deactivate a training schedule",
    description: "Existing sessions are untouched; generation stops from the next run.",
    tags: ["Attendance"],
    params: idParam,
    mutating: true,
    audit: "training_schedule.deactivate",
    responses: [res.json(200, TrainingSchedule, "Deactivated schedule")],
    milestone: "m4",
  }),

  endpoint({
    id: "SCH-02",
    method: "post",
    path: "/training-schedules/{id}/generate",
    auth: "owner",
    permission: "sessions:manage",
    idempotent: true,
    mutating: true,
    audit: "session.generate",
    summary: "Generate sessions from a schedule",
    description:
      "Idempotent per the `(schedule_id, session_date)` unique index and returning `{created, skipped}`; a maximum of 90 days per call; already-edited sessions are never overwritten (T-ATT-01).",
    tags: ["Attendance"],
    params: idParam,
    body: z.strictObject({
      from: DateStr,
      to: DateStr.describe("At most 90 days after `from`"),
    }),
    responses: [
      res.json(
        200,
        z.object({ created: z.number().int(), skipped: z.number().int() }),
        "Generation result",
      ),
    ],
    errors: ["VALIDATION_ERROR"],
    milestone: "m4",
  }),

  // -------------------------------------------------------------------------
  // Sessions (SES-01..04)
  // -------------------------------------------------------------------------
  endpoint({
    id: "SES-01",
    method: "get",
    path: "/sessions",
    auth: "coach_scoped",
    permission: "sessions:read",
    scope: "Coach: assigned groups only; filtered in the query, not post-filtered",
    summary: "List sessions",
    description:
      "Defaults to today → +14 days, sorted by `startsAt`. Coach scope uses the assignment active on each session's date.",
    tags: ["Attendance"],
    query: pageQuery.extend({
      from: DateStr.optional(),
      to: DateStr.optional(),
      ageGroupId: Id.optional(),
      status: sessionStatus.optional(),
      sort: sortParam.describe("startsAt | sessionDate"),
    }),
    responses: [res.json(200, pageOf(Session), "One page of sessions")],
    errors: ["INVALID_SORT"],
    milestone: "m4",
  }),

  endpoint({
    id: "SES-02",
    method: "post",
    path: "/sessions",
    auth: "owner",
    permission: "sessions:manage",
    summary: "Create a one-off session",
    description:
      "A session for the same group whose `starts_at` collides with a non-cancelled one is refused with 409 `SESSION_DUPLICATE`.",
    tags: ["Attendance"],
    mutating: true,
    audit: "session.create",
    body: z.strictObject({
      ageGroupId: Id,
      startsAt: Instant,
      endsAt: Instant,
      venue: z.string().max(120).optional(),
      leadCoachUserId: Id.optional(),
    }),
    responses: [res.json(201, Session, "Created session")],
    errors: ["SESSION_DUPLICATE", "VALIDATION_ERROR"],
    milestone: "m4",
  }),

  endpoint({
    id: "SES-03",
    operationId: "SES-03.read",
    method: "get",
    path: "/sessions/{id}",
    auth: "coach_scoped",
    permission: "sessions:read",
    scope: "Coach: 404 for a session of an unassigned group (T-AUTH-04)",
    summary: "Read a session",
    tags: ["Attendance"],
    params: sessionParam,
    responses: [res.json(200, Session, "The session")],
    milestone: "m4",
  }),

  endpoint({
    id: "SES-03",
    operationId: "SES-03.update",
    method: "patch",
    path: "/sessions/{id}",
    auth: "owner",
    permission: "sessions:manage",
    summary: "Update a session",
    tags: ["Attendance"],
    params: sessionParam,
    mutating: true,
    audit: "session.update",
    body: z.strictObject({
      startsAt: Instant.optional(),
      endsAt: Instant.optional(),
      venue: z.string().max(120).optional(),
      leadCoachUserId: Id.optional(),
      version: z.number().int(),
    }),
    responses: [res.json(200, Session, "Updated session")],
    errors: ["VERSION_CONFLICT", "SESSION_DUPLICATE"],
    milestone: "m4",
  }),

  endpoint({
    id: "SES-04",
    method: "post",
    path: "/sessions/{id}/cancel",
    auth: "owner",
    permission: "sessions:manage",
    summary: "Cancel a session",
    description:
      "Attendance is left as it was; a cancelled session is excluded from attendance-rate maths (T-ATT-10).",
    tags: ["Attendance"],
    params: sessionParam,
    mutating: true,
    audit: "session.cancel",
    body: z.strictObject({ reason: z.string().min(5).max(200) }),
    responses: [res.json(200, Session, "Cancelled session")],
    errors: ["REASON_REQUIRED"],
    milestone: "m4",
  }),

  // -------------------------------------------------------------------------
  // Player attendance (ATT-01..03)
  // -------------------------------------------------------------------------
  endpoint({
    id: "ATT-01",
    method: "get",
    path: "/sessions/{id}/attendance",
    auth: "coach_scoped",
    permission: "attendance:mark",
    scope: "Coach: assigned groups only; 404 otherwise",
    summary: "Read the attendance sheet for a session",
    description:
      "The roster is the players whose group history covers `session_date` and who are active on that date (ATTENDANCE §3). `editableUntil` is the coach's window; owners ignore it. `canEdit` tells the client whether this caller may save.",
    tags: ["Attendance"],
    params: sessionParam,
    responses: [res.json(200, SessionAttendance, "Session, roster and edit window")],
    milestone: "m4",
  }),

  endpoint({
    id: "ATT-02",
    method: "put",
    path: "/sessions/{id}/attendance",
    auth: "coach_scoped",
    permission: "attendance:mark",
    scope: "Coach: assigned groups only, inside the edit window",
    idempotent: true,
    mutating: true,
    audit: "attendance.bulk_save",
    summary: "Save attendance in bulk",
    description:
      "All-or-nothing upsert of N records plus one audit row per changed record (T8). Changing an existing mark requires `reason` (5–200 chars). A player not on the roster ⇒ 422 `PLAYER_NOT_ON_ROSTER` and nothing is written; outside the window ⇒ 422 `ATTENDANCE_WINDOW_CLOSED` for a coach (owners are not windowed). Retrying with the same key cannot duplicate.",
    tags: ["Attendance"],
    params: sessionParam,
    body: z.strictObject({
      records: z.array(AttendanceRecordInput).min(1),
    }),
    responses: [
      res.json(
        200,
        z.object({ saved: z.number().int(), roster: z.array(RosterRow) }),
        "Saved count and the recomputed roster",
      ),
    ],
    errors: [
      "ATTENDANCE_WINDOW_CLOSED",
      "PLAYER_NOT_ON_ROSTER",
      "REASON_REQUIRED",
      "VERSION_CONFLICT",
      "IDEMPOTENCY_KEY_REUSED",
    ],
    milestone: "m4",
  }),

  endpoint({
    id: "ATT-03",
    method: "patch",
    path: "/sessions/{id}/attendance/{playerId}",
    auth: "coach_scoped",
    permission: "attendance:correct_any",
    scope:
      "Coach: assigned groups AND inside the edit window (outside it ⇒ owners only, 422 for a coach)",
    mutating: true,
    audit: "attendance.correct",
    summary: "Correct a single attendance record",
    description:
      "Always a correction, so `reason` is required for every caller (coaches and owners) and the before/after is audited (T-ATT-05).",
    tags: ["Attendance"],
    params: attendanceParam,
    body: z.strictObject({
      status: z.enum(["present", "absent", "late", "excused"]).optional(),
      note: z.string().max(500).optional(),
      reason: z.string().min(5).max(200),
      version: z.number().int(),
    }),
    responses: [res.json(200, RosterRow, "Updated roster row")],
    errors: ["ATTENDANCE_WINDOW_CLOSED", "REASON_REQUIRED", "VERSION_CONFLICT"],
    milestone: "m4",
  }),

  // -------------------------------------------------------------------------
  // Coach time (CAT-01..05) — CR-003
  // -------------------------------------------------------------------------
  endpoint({
    id: "CAT-01",
    method: "post",
    path: "/coach-attendance/check-in",
    auth: "coach_scoped",
    permission: "coach_attendance:self",
    scope: "Coach: own check-ins, own sessions only",
    mutating: true,
    audit: "coach_attendance.check_in",
    summary: "Clock in for a session",
    description:
      "A self-reported timestamp taken by the server at request time — any client-supplied time is ignored, and this record does not prove physical presence (AUTH §7). Allowed from `starts_at − coachCheckinOpensMinutesBefore` to `ends_at + coachCheckinClosesMinutesAfterEnd` (settings); one open check-in per coach and one check-in per session.",
    tags: ["CoachTime"],
    body: z.strictObject({ sessionId: Id, note: z.string().max(500).optional() }),
    responses: [res.json(201, CoachAttendance, "The open check-in")],
    errors: ["ALREADY_CHECKED_IN", "CHECKIN_WINDOW_CLOSED", "VALIDATION_ERROR"],
    milestone: "m4",
  }),

  endpoint({
    id: "CAT-02",
    method: "post",
    path: "/coach-attendance/check-out",
    auth: "coach_scoped",
    permission: "coach_attendance:self",
    scope: "Coach: own check-ins only",
    mutating: true,
    audit: "coach_attendance.check_out",
    summary: "Clock out of a session",
    description:
      "Requires an open check-in of the caller's own. Once closed, the coach leaves `checkedInNow` and the closed span counts toward `todayMinutes`/`weekMinutes` (T-ATT-11).",
    tags: ["CoachTime"],
    body: z.strictObject({ sessionId: Id }),
    responses: [res.json(200, CoachAttendance, "The closed record")],
    errors: ["NO_OPEN_CHECK_IN"],
    milestone: "m4",
  }),

  endpoint({
    id: "CAT-03",
    method: "get",
    path: "/coach-attendance",
    auth: "coach_scoped",
    permission: "coach_attendance:self",
    scope: "Coach: own records only; `coachUserId` is owner-only (an owner sees all)",
    summary: "List coach attendance",
    tags: ["CoachTime"],
    query: pageQuery.extend({
      from: DateStr.optional(),
      to: DateStr.optional(),
      coachUserId: Id.optional().describe("Owner only; ignored for a coach"),
    }),
    responses: [res.json(200, pageOf(CoachAttendance), "One page of coach attendance")],
    milestone: "m4",
  }),

  endpoint({
    id: "CAT-04",
    method: "post",
    path: "/coach-attendance",
    auth: "owner",
    permission: "coach_attendance:manage",
    mutating: true,
    audit: "coach_attendance.create",
    summary: "Record coach attendance on a coach's behalf",
    description:
      "Owner manual entry (e.g. paper sign-in). Reason is mandatory and the row records `enteredBy='owner'`.",
    tags: ["CoachTime"],
    body: z.strictObject({
      coachUserId: Id,
      sessionId: Id,
      checkInAt: Instant,
      checkOutAt: Instant.optional(),
      reason: z.string().min(5).max(200),
    }),
    responses: [res.json(201, CoachAttendance, "Created record")],
    errors: ["REASON_REQUIRED", "ALREADY_CHECKED_IN", "VALIDATION_ERROR"],
    milestone: "m4",
  }),

  endpoint({
    id: "CAT-05",
    method: "patch",
    path: "/coach-attendance/{id}",
    auth: "owner",
    permission: "coach_attendance:manage",
    mutating: true,
    audit: "coach_attendance.correct",
    summary: "Correct a coach attendance record",
    description:
      "Sets `corrected=true` and requires a reason. Corrections are audited with before/after (T-ATT-08) — coach time is self-reported, so an owner's correction is the only way it becomes trustworthy.",
    tags: ["CoachTime"],
    params: idParam,
    body: z.strictObject({
      checkInAt: Instant.optional(),
      checkOutAt: Instant.optional(),
      reason: z.string().min(5).max(200),
      version: z.number().int(),
    }),
    responses: [res.json(200, CoachAttendance, "Corrected record")],
    errors: ["REASON_REQUIRED", "VERSION_CONFLICT"],
    milestone: "m4",
  }),
]);
