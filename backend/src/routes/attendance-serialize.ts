/**
 * Serializers for the M4 attendance surface (API_CONTRACTS §2).
 *
 * The two conversions that must not drift:
 *  - **`time` → `HH:mm`.** A `time` column comes back as `09:00:00`; the contract's
 *    `HHmm` is `09:00`, so the seconds are dropped here rather than at each call site.
 *  - **instants stay UTC.** `starts_at`/`ends_at` are `timestamptz` and are serialized
 *    with `toISOString()`, while `sessionDate` is the academy-local business date that
 *    was stamped when the session was created.
 */
import { dateStr } from "./people-serialize.js";

/** `09:00:00` → `09:00`. */
export function timeStr(value: string): string {
  return value.slice(0, 5);
}

export interface TrainingScheduleRow {
  id: string;
  age_group_id: string;
  age_group_name: string;
  weekday: number;
  start_time: string;
  end_time: string;
  venue: string | null;
  valid_from: Date;
  valid_to: Date | null;
  is_active: boolean;
}

export function serializeTrainingSchedule(row: TrainingScheduleRow) {
  return {
    id: row.id,
    ageGroup: { id: row.age_group_id, name: row.age_group_name },
    weekday: row.weekday,
    startTime: timeStr(row.start_time),
    endTime: timeStr(row.end_time),
    ...(row.venue ? { venue: row.venue } : {}),
    validFrom: dateStr(row.valid_from)!,
    ...(row.valid_to ? { validTo: dateStr(row.valid_to) } : {}),
    isActive: row.is_active,
  };
}

export interface SessionRow {
  id: string;
  age_group_id: string;
  age_group_name: string;
  schedule_id: string | null;
  session_date: Date;
  starts_at: Date;
  ends_at: Date;
  venue: string | null;
  status: "scheduled" | "completed" | "cancelled";
  cancel_reason: string | null;
  lead_coach_user_id: string | null;
  lead_coach_name: string | null;
  version: number;
}

/**
 * `SessionAttendanceSummary`: the marked/unmarked tally of one session (ATTENDANCE §3).
 *
 * It lives here rather than beside the query that builds it so `Session` and PLY-10 can
 * name the same shape without importing each other.
 */
export interface SessionAttendanceSummary {
  present: number;
  absent: number;
  late: number;
  excused: number;
  unmarked: number;
}

/**
 * `Session`. `attendanceSummary` is optional in the contract, so it is only attached when
 * the caller actually loaded the counts — a response never carries a summary it invented.
 */
export function serializeSession(row: SessionRow, summary?: SessionAttendanceSummary) {
  return {
    id: row.id,
    ageGroup: { id: row.age_group_id, name: row.age_group_name },
    sessionDate: dateStr(row.session_date)!,
    startsAt: row.starts_at.toISOString(),
    endsAt: row.ends_at.toISOString(),
    ...(row.venue ? { venue: row.venue } : {}),
    status: row.status,
    ...(row.cancel_reason ? { cancelReason: row.cancel_reason } : {}),
    ...(row.lead_coach_user_id && row.lead_coach_name
      ? { leadCoach: { id: row.lead_coach_user_id, fullName: row.lead_coach_name } }
      : {}),
    ...(summary ? { attendanceSummary: summary } : {}),
    version: row.version,
  };
}

// ---------------------------------------------------------------------------
// Attendance (ATT-01..03, PLY-10)
// ---------------------------------------------------------------------------
export interface AttendanceRecordRow {
  player_id: string;
  player_name: string;
  registration_no: string;
  status: "present" | "absent" | "late" | "excused" | null;
  note: string | null;
  marked_at: Date | null;
  marked_by: string | null;
  record_version: number | null;
}

/** `RosterRow`: a player with their record, or without one while they are unmarked. */
export function serializeRosterRow(row: AttendanceRecordRow) {
  return {
    player: {
      id: row.player_id,
      fullName: row.player_name,
      registrationNo: row.registration_no,
    },
    ...(row.status && row.marked_at
      ? {
          record: {
            status: row.status,
            ...(row.note ? { note: row.note } : {}),
            markedAt: row.marked_at.toISOString(),
            markedBy: row.marked_by ?? "",
            version: row.record_version ?? 1,
          },
        }
      : {}),
  };
}

/** `SessionAttendance`. `canEdit` is the caller's own answer, not a shared one. */
export function serializeSessionAttendance(
  session: SessionRow,
  roster: AttendanceRecordRow[],
  editableUntilDate: Date,
  canEdit: boolean,
) {
  return {
    session: serializeSession(session),
    roster: roster.map(serializeRosterRow),
    editableUntil: editableUntilDate.toISOString(),
    canEdit,
  };
}

// ---------------------------------------------------------------------------
// Coach time (CAT-01..05)
// ---------------------------------------------------------------------------
export interface CoachAttendanceRow {
  id: string;
  coach_user_id: string;
  coach_name: string;
  session_id: string;
  age_group_name: string;
  starts_at: Date;
  check_in_at: Date;
  check_out_at: Date | null;
  entered_by: "self" | "owner";
  corrected: boolean;
  check_in_note: string | null;
  version: number;
}

export function serializeCoachAttendance(row: CoachAttendanceRow) {
  return {
    id: row.id,
    coach: { id: row.coach_user_id, fullName: row.coach_name },
    session: {
      id: row.session_id,
      ageGroupName: row.age_group_name,
      startsAt: row.starts_at.toISOString(),
    },
    checkInAt: row.check_in_at.toISOString(),
    ...(row.check_out_at ? { checkOutAt: row.check_out_at.toISOString() } : {}),
    enteredBy: row.entered_by,
    corrected: row.corrected,
    ...(row.check_in_note ? { checkInNote: row.check_in_note } : {}),
    version: row.version,
  };
}
