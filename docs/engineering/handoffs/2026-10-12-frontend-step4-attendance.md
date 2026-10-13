# HANDOFF 2026-10-12 — Frontend Step 4: sessions, the mobile attendance sheet, coach time

Author: Buffy (frontend lead) · Milestone: M4 (frontend slice, mocks) · Change record: none (no spec/architecture change)
Branch/PR: none — **this project still has no tracked files** (`git ls-files .` → 0) · Plan: [FRONTEND_PLAN.md](../../../FRONTEND_PLAN.md) §12

## 1. Scope delivered

- **`/sessions`** — SES-01 + **SES-02** (owner "Add session") + **SES-04** (owner "Cancel session" with a reason). Default window today … +14 d, filters `from`/`to`/`ageGroupId`/`status` held in the URL, rows grouped by day, each showing the academy-time range, group, venue, lead coach, the attendance progress from `attendanceSummary`, the session status chip and a link to the sheet.
- **`/sessions/[id]`** — SES-03, ATT-01/02/03, CAT-01/02. Two blocks, deliberately independent:
  - **coach check-in bar** — one tap, no dialog, ≥ 48 px; states *Check in* → *Checked in 17:02 · N elapsed* → *Check out* → *Done · recorded span*; disabled with the window explained outside `starts_at − 60 min … ends_at + 120 min`; an open check-in elsewhere is surfaced before a second check-in is attempted. Times are the server's, rendered in the academy timezone.
  - **attendance sheet** — sticky counts chips + "Mark all present", ≥ 56 px rows with ≥ 48 px P/L/A/E targets (radiogroup semantics, one tab stop, arrow keys), an optional note per row, a **required reason when changing a saved record**, sticky full-width Save through ATT-02 with the draft's `Idempotency-Key`, a 24 h local draft, a read-only mode outside the coach's window and on cancelled sessions, and a 409 conflict dialog offering *Keep theirs* / *Overwrite with mine*.
- **`/coach-attendance`** — CAT-03 log (filters `from`/`to`/`coachUserId(O)`), desktop table + mobile cards, **open check-ins highlighted as elapsed and flagged past 12 h**, a `Σ hours (closed records only)` line, CAT-04 owner manual entry and CAT-05 owner correction (reason ≥ 5, sets `corrected`), and the verbatim self-reporting disclaimer. A coach sees only their own rows, read-only.
- **Data layer:** `Session`/`AttendanceStatus`/`RosterRow`/`SessionAttendance`/`CoachAttendance` types, wrappers for SES-01..04, ATT-01..03, CAT-01..05, the mock store extended to schema 2 (sessions with real times/status/venue, attendance records with version + who marked them, `coachAttendance`), `mocks/handlers.sessions.ts`, shared `mocks/http.ts` (one copy of the 401/403/404 guards, the error envelope and `Idempotency-Key` replay with `Idempotent-Replay`), `lib/attendanceDraft.ts`, `components/AttendanceRow.tsx`, and academy-timezone instant helpers in `lib/dates.ts` (offset read from the tz database, never hardcoded).
- Migrations added: none (no backend). Docs read first: `ATTENDANCE` §1–§5, `API_CONTRACTS` §1–§2/§3.5, `PAGE_SPECIFICATIONS` §5/§6 + §0 states, `ROUTES_AND_NAVIGATION`, `DESIGN_SYSTEM` §4–§8, `DATABASE` §3.7, `TESTING_AND_ACCEPTANCE` §2.6/§2.9 (T-ATT-01..11, T-UI-10), `MOCK_DATA`, `AUTH_AND_PERMISSIONS` §6, `handoffs/2026-10-12-frontend-step3-players.md`.

**Not built, on purpose:** everything CR-003 adds — the DSH-02 one-tap clock cards, the DSH-01 `coachTime` card, `SET-08` per-automation switches and the verification queue. ADR-019 is still *Proposed*, so those surfaces stay unbuilt. The check-in bar on the session page is the pre-CR-003 surface (`ROUTES` lists `CAT-01/02` on `/sessions/[id]`), not the new one.

## 2. Evidence

- `npm run typecheck` — clean, exit 0 · `npm run lint` — clean, **0 errors / 0 warnings**, exit 0 · `npm run build` — green, **30 routes**, exit 0 (log `frontend/.verify/build-step4.log`).
- **`npm run verify:e2e` — 12/12 (Step 2) + 30/30 (Step 3) + 41/41 (Step 4) = 83 checks PASS, exit 0** in system Chrome against `npm run dev` on :3100 (mock mode). Step 3 was re-run in full after this slice's changes to the store, the owner fixture and the handlers: no regression. New script `npm run verify:e2e:step4`.
- Interface behaviour proven through the running app (Step 4 script):
  - the list groups by day, filters by group and status through the URL, shows the cancelled session's reason and **offers no cancel action on it**, and explains an empty window; **two quick filter changes both survive** (the Step 3 stale-URL race, checked again on this page's copy);
  - the sheet loads with one saved row and `Unmarked 2`; **"Mark all present" fills unmarked rows only**; changing the saved row reveals the reason field and **a save without one is refused before anything is written**; the unsent marks are **persisted with their `Idempotency-Key`**, the save then writes 3 records, clears the draft, refreshes the sheet from the response and **survives a reload**;
  - against the API the app itself calls: **no reason on a changed record → 422 `REASON_REQUIRED`**, **the same `Idempotency-Key` replays instead of duplicating** (`Idempotent-Replay: true`), **no key → 400 `IDEMPOTENCY_KEY_REQUIRED`**;
  - coach time: both coaches listed with a duration, the open check-in flagged *Needs correction (> 12 h)* and **excluded from the hours total**, the disclaimer verbatim, a too-short correction reason refused inline, and the correction saved with the row reading *Corrected*;
  - coach, at **360 × 640**: only their group's sessions, no cancel action, **one tap clocks in with no dialog**, the open check-in shows the server time + elapsed + check-out, **the check-in target measures 48 px, P/L/A/E 48 × 48 px, rows 116 px**, the **sticky Save sits above the mobile tab bar** (save bottom 576 / nav top 595 — the bar measures the tab bar rather than guessing an offset), the sheet saves from the phone layout, clocking out records the span, an **out-of-scope session is 404**, a past session is **read-only with the window explained**, and their own log is read-only with the disclaimer.
- `npm run verify:links` (`frontend/.verify/dead-links.mjs`, the Step 2 audit kept runnable) — **29 static routes, 0 unresolved `href`s**, exit 0. Dynamic ids are left to the E2E scripts, which navigate them for real.
- Screenshots for human review (`frontend/.verify/`): `sessions-1280.png`, `attendance-sheet-1280.png`, `coach-attendance-1280.png`, `sessions-coach-360.png`, `attendance-sheet-360.png`, `attendance-readonly-360.png`, `session-404-360.png`, `coach-attendance-360.png`.
- **Limitation, stated plainly:** T-UI-10 asks for a **real-phone** pass. What was measured is an emulated 360 × 640 viewport in desktop Chrome (target sizes, sticky-bar geometry, the flows). The device check is still owed — that is Hassen's sign-off, and it has not happened. There is also still **no axe run** (Steps 1–4 all carry that gap).

## 3. Deviations from the spec

| Spec ref | What differs | Why | Needs a spec change? (CR-###) |
|---|---|---|---|
| `MOCK_DATA` owner fixture | The owner's `permissions` grew to include `sessions:read`, `sessions:manage`, `attendance:mark`, `attendance:correct_any`, `coach_attendance:manage` (mirrored in MOCK_DATA.md) | The guards read `Me.permissions`, never `role === 'owner'`; without them the owner could not open the training screens. The owner holds every permission in AUTH §6 — the fixture lists only what the UI reads | No — fixture completion, recorded here |
| mock seed | Today's Under-11 session is anchored to "now" (started 30 min ago) | So the check-in window and the sheet are usable whenever the app is run; a fixed time would make the demo dead outside a 3-hour window each day. Mock-only | No (C0) |
| `PAGE_SPECIFICATIONS` §5 | "Mark all present" fills **only unmarked rows** and says so | Flipping saved records would demand a reason for each of them, which is not what a one-tap shortcut means | No (C0) |
| `API_CONTRACTS` ATT-02 | "Overwrite with mine" re-sends only the conflicting rows **without `version`** | That is the only representation of "overwrite" the request shape allows. The backend must confirm what it means (see §4.1) | **Yes — see §4.1** |
| `ROUTES_AND_NAVIGATION` `/sessions/[id]` | The owner does **not** get a check-in button (they use CAT-04 on `/coach-attendance`) | A clock-in by the owner would record the owner's own user id as "coach time"; `CAT-01` allows it but nothing needs it | No (C0) |
| `API_CONTRACTS` SES-03 `PATCH` | Not implemented (GET is) | Editing one session's venue/time/lead coach belongs with the schedules slice; nothing in Step 4 renders it | No — scheduled with Step 8 (recorded) |
| §Report definition, coach hours | `Σ hours` is summed **in the UI from the loaded rows** | `Page<T>` has no `totals` field (the report row `RPT-01` does), so the range filters are what scope the total. Labelled "closed records only" | No (C0) — see §4.5 |

## 4. Contract drift / requests

1. **ATT-02 cannot express "unmark".** Upserting the listed records is the whole request, so a saved record can never be cleared — the sheet therefore keeps saved rows locked-looking and only lets *unsaved* rows be cleared (which is what PAGE_SPEC §5 describes, but the API should say so explicitly rather than leave it implied by omission). If unmarking is meant to be possible, ATT-02 needs an explicit representation for it.
2. **Nothing returns the caller's own check-in state.** ATT-01 returns the session, the roster, `editableUntil` and `canEdit`; the check-in bar's state had to be inferred from `CAT-03` filtered to the session date ± 1 day. A `myCheckIn` block on ATT-01 (or on `SES-03`) would remove that inference — it is exactly the field `DSH-02.myOpenCheckIn` (CR-003) already anticipates.
3. **`VERSION_CONFLICT` payload shape is undefined.** The UI reads `details[].field` as the player id and `details[].meta.current` as the current record to name who won; the contract only says "with the current record". Same class of gap as the Step 3 `PlayerCreate.guardians` type — please write the shape down.
4. **Check-in window values are assumed from ATTENDANCE §4** (`coach_checkin_opens_minutes_before` 60 / `coach_checkin_closes_minutes_after_end` 120) and mirrored in the UI copy. If they are configurable per academy, the session payload should carry the resolved window instead of the client re-deriving it.
5. **`Page<T>` has no totals.** For CAT-03 the range filter therefore defines the visible total. Either add `totals` to paginated coach-attendance or state that the total is always page-scoped.
6. **Nothing was invented**: every field rendered comes from API_CONTRACTS §2/§3.5 or MOCK_DATA; the owner-fixture completion in §3 is recorded in MOCK_DATA.md.

## 5. Known gaps and risks

- **No version control on this project** — unchanged, still the cheapest protection available (`git ls-files .` → 0). This slice adds ~12 source files and can be diffed only file-by-file by hand.
- **T-UI-10's device pass is owed** (see §2). Emulation is not a phone.
- **No axe run** (Steps 1–4).
- **Not exercised by the E2E:** the owner's **CAT-04 "Add coach time"** dialog (built, typechecked and lint-clean, but only the correction path is automated); the **partial unique rule** "a coach cannot hold two open check-ins" (implemented and reflected by a disabled button + explanation, but the seeded open record belongs to the second coach, so the refusal itself is not proven end-to-end); the draft's **24 h expiry** (cannot be waited out — what is proven is the key, the persistence and the clear-on-success).
- **Three copies of the URL-filter compose logic** now exist (`/players`, `/sessions`, `/coach-attendance`). The fix for the Step 3 write race was copied faithfully and is checked on the new page too, but this should become one `useUrlFilters` hook in a later slice rather than a fourth copy.
- **An app-wide form convention, recorded not changed:** `required` attributes mean an *empty* required field is refused by the browser's native bubble, while the design system (§8) asks for inline messages plus a summary. It predates this slice (Step 2/3 forms do the same) and changing it touches every dialog, so the E2E exercises the app-level rules with non-empty invalid values instead. Worth a deliberate decision later.
- **Real bug found and fixed while verifying:** the login `#username` `pattern="[A-Za-z0-9._-]+"` is an **invalid regular expression under the modern `v` flag** (`-` must be escaped), so the browser logged a syntax error and silently ignored the pattern. Escaped to `[A-Za-z0-9._\-]+`; it is behaviour-preserving (the pattern was never applied before) and the same format rule is already enforced server-side by the mock and by AUTH.
- **CR-003 surfaces remain blocked** on Hassen's approval (ADR-019 *Proposed*): coach clock cards on DSH-02, `coachTime` on DSH-01, `SET-08` switches, verification queue.
- Money rule respected: nothing in this slice renders, parses or computes money; a coach's clock time is explicitly never mixed with player attendance, fees or balances (asserted in the sheet's footnote and in the UI copy).

## 6. How to run / verify

```bash
cd "Projects/inspire-academy-player manager/frontend"
npm install
npm run dev                 # http://localhost:3100 (mock mode)
npm run typecheck && npm run lint && npm run build
npm run verify:e2e          # step 2 (12) + step 3 (30) + step 4 (41); needs `npm run dev` listening
npm run verify:e2e:step4    # step 4 only
npm run verify:links        # app-level dead-link audit (static hrefs vs routes)
```

Mock logins (any password): `owner` · `coach` · `totp` · `locked`. The people/training store lives in `localStorage ia_mock_people_v1` (per browser profile; clear site data to re-seed from scratch) and the unsent attendance draft in `ia-attendance-draft:<sessionId>` (24 h, cleared on sign-out). The seeded Under-11 session for *today* always has an open check-in window and three players on its roster, one of them already marked.

## 7. Next steps (exact)

1. **Hassen (owner):** do the T-UI-10 device pass on a real phone (clock in/out one-handed at 360 px, then the sheet) and look at the screenshots in `frontend/.verify/`. Approve or amend **CR-003** — the coach clock cards, `coachTime` and `SET-08` switches are all waiting on it.
2. **Claude (docs):** answer §4.1–§4.5 (ATT-02 unmark semantics, the own-check-in field, the `VERSION_CONFLICT` payload, where the check-in window lives, coach-hours totals) and the four Step 3 items that are still open.
3. **Frontend:** Step 5 (billing + payments, the money rules — `lib/money.ts`/`lib/dates.ts` unit tests, T-UI-01) next, unless Hassen wants the DSH-02 clock cards first (they depend on CR-003 approval, not on Step 5).
4. **Freebuff (when M1 lands):** SES/ATT/CAT to the reviewed contract, the coach roster scoping in the database (not the UI), server-stamped check-in times, and the partial unique constraint behind "one open check-in".

## 8. Reviewer checklist (Claude/Hassen fills)

[ ] Compared to DATABASE/API docs  [ ] Permissions verified by route matrix  [ ] No money floats
[ ] Audit rows present  [ ] Tests evidence reviewed  [ ] PROJECT_STATUS updated  [ ] Verdict: accepted / changes requested
