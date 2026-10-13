# HANDOFF 2026-10-13 — backend M4 complete: attendance, coach time, player history

Author: Freebuff (backend lead)      Milestone: M4      Branch/PR: none — work sits uncommitted in the working tree (`git ls-files .` → 158; the backend changes of both M4 halves are among the 30 modified paths)

## 1. Scope delivered

- **Endpoints implemented (9, completing M4):** `ATT-01`, `ATT-02`, `ATT-03`, `CAT-01`,
  `CAT-02`, `CAT-03`, `CAT-04`, `CAT-05`, `PLY-10`. M4 is now **19/19**; project total
  **73/134**.
- **Migration added:** `0011_attendance.sql` — `player_attendance` (status CHECK, unique
  `(session_id, player_id)`, note ≤ 500), `coach_attendance` (unique
  `(coach_user_id, session_id)`, partial unique *one open check-in per coach*, CHECK
  `check_out_at > check_in_at`, `entered_by ∈ {self,owner}`), `version`/`updated_at`
  triggers, RLS + grants, and three SECURITY DEFINER helpers
  (`app.attendance_edit_window_hours`, `app.attendance_editable_until`,
  `app.coach_checkin_window`).
- **Also changed:** `Session.attendanceSummary` is now **served** (the first-half handoff
  recorded it as omitted; that deviation is closed). It is attached to every `Session`
  response — `SES-01`, `SES-02`, `SES-03.read`, `SES-03.update`, `SES-04` — from one batch
  query per response, never from a per-row one.
- **Docs read before starting:** ATTENDANCE §3–§5, API_CONTRACTS §2/§3.5, DATABASE §3.5/§7,
  AUTH_AND_PERMISSIONS §4/§6/§7, TESTING_AND_ACCEPTANCE §2.6 (T-ATT-01..11), the M4
  first-half handoff.

## 2. Evidence

| Check | Result |
|---|---|
| `npx tsc --noEmit` | **exit 0** |
| `npx vitest run` (all three projects) | **exit 0** — `Test Files 8 passed (8)`, **72 passed / 72** (11 new) |
| `npx tsx scripts/progress-report.ts` | `m2: 23/23`, `m3: 31/31`, **`m4: 19/19`**, `TOTAL: 73/134` |
| Migrations `0001`–`0011` | applied to `ia_dev` (by hand) and `ia_test` (by the harness) |

New file: `backend/tests/integration/attendance-surface.test.ts`, 11 tests. What they assert
that a status code cannot:

- **The roster is a fact about a date.** A player who joined after the session (2026-10-20
  history vs a 2026-10-15 session), one transferred out before it, and one withdrawn before
  it are all absent from the same sheet — compared by player id, not by count.
- **All-or-nothing.** A batch of one valid + one off-roster record returns
  `PLAYER_NOT_ON_ROSTER` **and the sheet is re-read to prove nothing was written**.
- **An unchanged save writes nothing** (`saved: 0`) and a retried `Idempotency-Key` replays
  the stored response (`Idempotent-Replay: true`) instead of re-applying.
- **The window**: a coach is refused `ATTENDANCE_WINDOW_CLOSED` on a session whose
  `starts_at + 24h` has passed while **the same write succeeds for an owner**, and the coach
  can still *read* the sheet (`canEdit: false`).
- **Server time only**: `checkInAt` from `CAT-01` falls inside the request's own clock
  window; a second check-in is 409 `ALREADY_CHECKED_IN` (open-row rule), a third after
  check-out is 409 too (the `(coach, session)` unique index), and `version` increases on
  check-out.
- **`attendanceSummary`** on `SES-03.read` *and* `SES-01` is exactly
  `{present:1, absent:0, late:0, excused:0, unmarked:1}`.
- **PLY-10** leaves a **cancelled** session out entirely (its absence was marked *before*
  cancelling, so the rows still exist) and reports the unmarked session in `unmarked` only —
  no row in `data`.
- **Scope**: a coach gets 404 (not 403) for another group's sheet and for a player who moved
  out of their groups.

## 3. Deviations from the spec

| Spec ref | What differs | Why | Needs spec change? (CR-###) |
|---|---|---|---|
| PLY-10 `query` (`dateRangeQuery`) | when `from`/`to` are omitted the window is *registration date → today* (academy-local) rather than unbounded | a history has no future: counting not-yet-held sessions as `unmarked` would inflate every player's figure | no — but the default is worth writing into the contract |
| `Session.attendanceSummary` | delivered (closes the first-half deviation) | — | no |

## 4. Contract drift / requests

1. **`ATT-03` cannot be used by a coach as its `scope` note implies.** It declares
   `permission: "attendance:correct_any"`, which AUTH §4 grants to owners only (coaches hold
   `attendance:mark`), so a coach gets **403** even inside the window. Implemented exactly as
   declared; the permission map was **not** widened. Fix is either the permission map or the
   contract row.
2. **`SES-04`'s declared `REASON_REQUIRED` still cannot fire** (carried from the first half):
   the body schema enforces `reason` 5–200, so a short reason surfaces as
   `VALIDATION_ERROR`. Same applies to any "required" text the schema already enforces.
3. **`ATT-02`'s `saved`** is the count of records actually inserted/changed, not the count
   submitted — the contract only says "saved count".
4. **PLY-10's `summary` semantics** are read as: `present/absent/late/excused` count marked
   sessions; `unmarked` counts roster sessions with no record; cancelled sessions are
   excluded from **both**. The contract's sentence ("excludes excused and unmarked sessions")
   most plausibly describes the attendance *rate*, which is M9's, so `excused` is counted in
   its own bucket here. Please confirm.

## 5. Known gaps and risks

- `Session.attendanceSummary` costs one extra query per session response (a single batch
  query for a page, not N+1); it is not cached, and a list of 25 sessions runs four
  correlated subqueries for those 25 ids.
- **No daily session generator** — as before, `SCH-02` is owner-triggered only, so nothing
  creates tomorrow's sessions by itself. A dashboard "today" card empties itself without it.
- `coach_attendance` records are self-reported and prove nothing about physical presence
  (AUTH §7). The code and its doc comment say so; no response implies otherwise.
- Still **no CI**; nothing here is enforced on a push.
- Performance is unmeasured (M9 owns p95).

## 6. How to run / verify

```bash
cd backend
npx tsc --noEmit
npx vitest run                       # 72 tests, all three projects, against ia_test
npx tsx scripts/progress-report.ts   # expect m4: 19/19
npx tsx scripts/migrate.ts up        # ia_dev (add --test for ia_test)
```

## 7. Next steps (exact)

1. **M5 (billing, 26 endpoints)** is the next milestone but is **not** unblocked for the
   parts that need decisions (see §"Decisions pending" in PROJECT_STATUS): `PLY-11`,
   `GDN-06`, `SET-04`. `BIL-01/02/03`, `INV-01..05`, `PAY-01..08` and `RCT-01` can be built
   from BILLING_ENGINE as written.
2. **Claude:** rule on the four contract items in §4 (chiefly `ATT-03`'s permission, which is
   a live 403 for coaches).
3. **Owner (Hassen):** the CR-003 approval is still owed in writing; `ADR-019` remains
   *Proposed* while CAT-01..05 — the endpoints it describes — are now served.

## 8. Reviewer checklist (Claude/Hassen fills)

[ ] Compared to DATABASE/API docs  [ ] Permissions verified by route matrix  [ ] No money floats
[ ] Audit rows present  [ ] Tests evidence reviewed  [ ] PROJECT_STATUS updated  [ ] Verdict: accepted / changes requested
