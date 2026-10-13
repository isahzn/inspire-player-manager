# ATTENDANCE

> **Status:** Draft v1 (planned) · **Owner:** Claude (spec) / Freebuff (implementation) · **Updated:** 2026-10-11
> **Depends on:** [DATABASE](DATABASE.md) §3.5, [AUTH_AND_PERMISSIONS](AUTH_AND_PERMISSIONS.md) §6 · **Source of truth for:** session scheduling, attendance rules, coach time tracking, timezone behaviour, attendance metrics.

## 1. Sessions and schedules

- `training_schedules` are **configuration**: `(age group, weekday, start, end, venue, validity)`. Seed defaults: Tuesday and Thursday for each seeded group (editable/removable; nothing in code references specific weekdays).
- A job (daily 03:00 academy time, and on schedule save) generates `sessions` for the next **28 days**: for each active schedule/date in validity: insert with `ON CONFLICT (schedule_id, session_date) DO NOTHING`. Re-running is harmless.
- Owner can also create **ad-hoc sessions** (`SES-02`), cancel (`SES-04`, reason), and edit a single session (venue, time, lead coach) without touching the schedule. Editing a schedule affects **only future ungenerated/unmodified sessions** (generated sessions with edits are left alone; owner told how many were skipped).
- Duplicate guard: UQ `(schedule_id, session_date)` and UQ `(age_group_id, starts_at)` for non-cancelled sessions.
- `status`: `scheduled` → `completed` (automatic once `ends_at + 24 h` passes, non-cancelled) or `cancelled`. Cancelled sessions are read-only; existing marks are kept for history but excluded from reports' denominators.

## 2. Timezone rules

- `starts_at/ends_at` are `timestamptz` (UTC) computed from academy-local date+time using the IANA zone in `academy_settings.timezone` (default `Asia/Colombo`). Do not hardcode a UTC offset; use the tz database so a future DST/zone change works.
- All "today", "this week", "is overdue", due-date and window calculations use the **academy zone**. The API returns UTC instants; the **frontend formats them in the academy zone** (from `Me.academy.timezone`), not the device zone.
- A session crossing midnight is allowed (`ends_at` next day); `session_date` = local start date.
- Tests: sessions generated across a configured DST zone (e.g., set zone `Europe/London` in a test) keep local start time; boundary tests for 23:30 local on the last day of a month (period/due logic).

## 3. Roster and player attendance

- **Roster(session)** = players with a `player_group_history` row covering `session_date` for the session's group **and** `status='active'` on that date. Transferred players appear in the group they belonged to on that date; withdrawn players disappear from later rosters but remain in earlier attendance history.
- States: `present`, `absent`, `late`, `excused`; optional note ≤ 500 chars. "Unmarked" is the absence of a row.
- **Bulk workflow (`ATT-01/02`)**: open session → roster list with a one-tap "Mark all present" → tap exceptions → Save. Request carries `Idempotency-Key` (the draft id) so a retried save never duplicates. Server upserts in one transaction (T8) and audits each *changed* record (new or modified).
- **Concurrent coaches** (two coaches in one group): each existing record carries `version`; sending a stale/missing version for an existing record ⇒ 409 `VERSION_CONFLICT` with the current record so the UI can show "Coach X already marked this player". New rows rely on UQ `(session_id, player_id)`.
- **Corrections:** changing an existing record's status requires `reason` (coach inside window; owner any time). Coach edit window default 24 h after `starts_at` (`attendance_coach_edit_window_hours`). Every change → `audit_logs` (before/after/reason/actor).
- **Poor connectivity (v1 decision [ADR-011](../engineering/DECISIONS.md#adr-011)):** online-only API, but the frontend must persist the unsent draft locally (keyed by session id, 24 h) and surface a persistent "Not saved — Retry" state; retry reuses the same `Idempotency-Key`. No offline sync/PWA queue in v1 [OPEN-014].

## 4. Coach check-in / check-out

| Rule | Spec |
|---|---|
| Subject | A coach checks in to **one session** they're assigned to (via group). |
| Window | From `starts_at − coach_checkin_opens_minutes_before` (60) to `ends_at + coach_checkin_closes_minutes_after_end` (120). Outside ⇒ 422 `CHECKIN_WINDOW_CLOSED`. |
| Uniqueness | UQ `(coach_user_id, session_id)` ⇒ second check-in = 409 `ALREADY_CHECKED_IN`; partial UQ `(coach_user_id) WHERE check_out_at IS NULL` ⇒ a coach can't hold two open check-ins (must check out first). |
| Check-out | Requires own open check-in for that session; `check_out_at > check_in_at` (server timestamps both from the server clock; the client cannot send times). |
| Open check-ins | Not auto-closed. A check-in open > 12 h is flagged "needs correction" on the owner dashboard. |
| Owner correction | `CAT-04/05`: owner creates/edits with **reason**; `corrected = true`, `entered_by = 'owner'` for creates; audit before/after. |
| Not verified | Self-reported, server-timestamped. **Not** proof of physical presence (no GPS/biometrics). See [AUTH_AND_PERMISSIONS](AUTH_AND_PERMISSIONS.md) §7. |

**Where the times show (CR-003, 2026-10-12).** Coach time is recorded in exactly one place — `coach_attendance` — and surfaced in two:

| Consumer | What it shows |
|---|---|
| Coach dashboard (`DSH-02`) | Open check-in with **elapsed time** and a one-tap **Check out**; today's sessions carry one-tap **Check in** (≥ 48 px, no dialog); own weekly total hours. |
| Owner dashboard (`DSH-01`, `coachTime`) | **Checked in now** (coach · group · check-in time · elapsed minutes), today's and this week's coach hours, and `openNeedingCorrection` (check-ins open > 12 h) with a link to `/coach-attendance`. |

Rules: both surfaces are **derived reads** of `coach_attendance` (no new table, no duplicated state); hours use the §5 definition (closed records only); an open record is shown as elapsed, never as completed hours. Every figure is rendered in the academy timezone (§2) from server-stamped instants. Player attendance and coach attendance are never mixed: a coach's clock time has **no effect on billing, fees or player attendance metrics**. Owner-side manual entry/correction stays `CAT-04/05` with a reason (audited).

## 5. Reporting definitions

| Metric | Definition |
|---|---|
| Attendance rate (player/group/period) | `(present + late) / (present + late + absent)`; **excused and unmarked excluded**; cancelled sessions excluded. Shown with the counts so exclusions are visible. |
| Session completeness | marked ÷ roster size; sessions older than the edit window with unmarked players flagged. |
| Coach hours | `Σ (check_out_at − check_in_at)` over **closed** records in range; open records listed separately (elapsed only). The owner dashboard reports the same definition as *today* and *this week*; open check-ins > 12 h are counted separately as needing correction (CR-003). |
| Attendance detail export | one row per `(session, player)` including unmarked as blank status. |

Filters and columns: [PAGE_SPECIFICATIONS](../frontend/PAGE_SPECIFICATIONS.md) §Reports.
