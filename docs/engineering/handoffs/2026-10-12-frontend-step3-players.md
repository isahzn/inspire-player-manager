# HANDOFF 2026-10-12 — Frontend Step 3: players, guardians, groups & fees, coaches, CSV import

Author: Buffy (frontend lead) · Milestone: M1/M2 (frontend slice, mocks) · Change record: none (no spec/architecture change)
Branch/PR: none — **this project still has no tracked files** (`git ls-files .` → 0; the folder is untracked in the workspace repo), so there is no diff to review · Plan: [FRONTEND_PLAN.md](../../../FRONTEND_PLAN.md) §11

## 1. Scope delivered

- **Pages implemented (all against MSW mocks, mock mode only):**
  - `/players` — list: PLY-01 with `q`, `status` (default Active), `ageGroupId`, `hasOutstanding` (owner), sort (`fullName`/`registrationDate`/`registrationNo`), paging; owner columns (reg no · name · group · age · status · primary guardian phone · outstanding) and the coach projection (reg no · name · age · group · status) with no money or guardian data.
  - `/players/new` — register: PLY-02 + PLY-08 (advisory), GRP-05 (suggestion only), GDN-01 (reuse a sibling's guardian).
  - `/players/[id]` — profile tabs Overview · Guardians · Group history · Attendance · Invoices · Messages (owner) and Overview + Attendance (coach); header carries the status chip, group, outstanding. Owner actions: PLY-04 (via edit), PLY-05 change status, PLY-06 transfer group.
  - `/players/[id]/edit` — PLY-04 with the `version` echoed and a 409 `VERSION_CONFLICT` reload dialog.
  - `/age-groups` — GRP-01/02/03/04 (create, edit, archive/unarchive; `AGE_GROUP_HAS_ACTIVE_PLAYERS` surfaced with a link to the filtered players).
  - `/age-groups/[id]` — roster (PLY-01 filtered by group), FEE-01 fee history, FEE-02 change fee with the past-date confirmation, CCH-02 assigned coaches, SCH-01 placeholder.
  - `/coaches` — CCH-01..04 (list, add coach via USR-02 with the one-time `inviteUrl`, assign group, end assignment).
  - `/imports/players` — IMP-01 → IMP-02 three-step wizard.
  - `/billing/invoices/[id]` — **read-only** INV-02 view so PLY-09's "link to the invoice" is not a dead route; allocations, PDF, send and void remain the billing slice's.
- **Endpoint wrappers added to `src/api/client.ts`:** PLY-01..11, GRP-01..05, FEE-01/02, GDN-01..06, CCH-01..04, USR-02, IMP-01/02, INV-02 (read-only). Every wrapper is named by its contract ID and sends `Idempotency-Key` where the contract marks **Idem**.
- **Migrations added: none** (no backend exists).
- Docs read before starting: `CLAUDE.md`, `README.md`, `PROJECT_STATUS`, `CONTINUATION_GUIDE`, `CHANGE_MANAGEMENT`, `API_CONTRACTS` (§1–§3.4, §3.8), `DATABASE` §3.1–3.3, `PAGE_SPECIFICATIONS` §0/§3/§4, `ROUTES_AND_NAVIGATION`, `DESIGN_SYSTEM`, `CSV_IMPORT`, `MOCK_DATA`, `AUTH_AND_PERMISSIONS`, the 2026-10-11 and 2026-10-12 handoffs, and the Next.js 16 docs shipped in `node_modules/next/dist/docs` (`useParams`, `useSearchParams`).

## 2. Evidence

- `npm run typecheck` (`tsc --noEmit`) — clean, **exit 0** (2026-10-12)
- `npm run lint` (`eslint`) — clean, **0 errors / 0 warnings**, exit 0
- `npm run build` (`next build`, Turbopack) — green, **29 routes**, exit 0 (log: `frontend/.verify/build-step3.log`)
- **`npm run verify:e2e` — 12/12 (Step 2) + 30/30 (Step 3) PASS, exit 0** in system Chrome against `npm run dev` on `:3100` (mock mode). `verify:e2e` now runs `.verify/step2-e2e.mjs` then `.verify/step3-e2e.mjs`; `npm run verify:e2e:step3` runs the new one alone.
- Interface checks that the running app actually behaves as specified (Step 3 script, beyond "the page rendered"):
  - the **list is filtered through the URL** (`?status=active&q=amara` → 1 matching player) and a filter change followed immediately by typing does **not** lose either change;
  - **Outstanding is shown separately** from Invoiced/Collected, and the owner sees `Rs. 2,500` for the seeded partially-paid invoice (invoice `400000 − 150000` minor);
  - clicking **Register anyway** really creates the player and lands on the new profile; the **advisory PLY-08 warning opens no dialog**, the **409 opens the dialog**;
  - **archiving a group with active players is refused** with the reason; **a past fee date is refused until the owner ticks the confirmation** (`#fee-from-error` → "Confirm that this applies from a past date"), then records `Rs. 4,500`;
  - the **import wizard commits** the valid row, reports the result, and treats the duplicate row as a warning the owner must approve;
  - at **360 px** the list renders as cards (6 cards, names present) — tables → cards;
  - **coach**: the list hides balances/guardian phones/the register action, the profile shows *Overview + Attendance only*, a player from an unassigned group answers **404 "Not found"**, and `/players/new` answers **No access**.
- Screenshots (for human review, written by the script to `frontend/.verify/`): `players-1280.png`, `players-outstanding-1280.png`, `player-profile-1280.png`, `player-profile-360.png`, `players-360.png`, `register-duplicate-1280.png`, `group-detail-1280.png`, `coach-players-403-1280.png`, `import-review-1280.png`, `import-done-1280.png`.
- **Limitation, stated plainly:** I verified structure through the DOM and the assertions above; I did **not** view the PNGs pixel-by-pixel, and there is still **no axe run** and no real-phone check (both the Step 2 and Step 3 slices carry that gap).

## 3. Deviations from the spec

| Spec ref | What differs | Why | Needs spec change? (CR-###) |
|---|---|---|---|
| `PAGE_SPECIFICATIONS` §3 (no such line) | PLY-08's advisory result renders as an **inline note**; the dialog is reserved for the server's 409 `DUPLICATE_SUSPECTED` | A dialog that opens while the owner is still typing is hostile, and the spec only ties the dialog to the 409 | No (C0 — behaviour, not contract) |
| `ROUTES_AND_NAVIGATION` `/billing/invoices/[id]` | Added as a **read-only** INV-02 page in this slice | PLY-09 must "link to the invoice"; leaving a dead link would fail the dead-link audit | No — the route and endpoint already exist in the spec; the rest of the page is Step 5 |
| `FRONTEND_PLAN` §1/§5 (money/dates owned by Step 5) | `lib/money.ts`, `lib/dates.ts`, `lib/phone.ts` created now (integer minor units, timezone-safe business dates, E.164 normalisation) | Step 3 already had to display money and dates; a throwaway formatter would have had to be replaced | No — Step 5 still owns the **unit tests** (T-UI-01) and the rest of the money surface |
| `IMP-02` request body | Assumed `{ importRowsWithWarnings: boolean }` | `CSV_IMPORT` §3 step 3 requires the tick box; the contract does not carry the field | **Yes — see §4.1** |

No other deviations. No contract shape was changed by the frontend work.

## 4. Contract drift / requests

1. **IMP-02 needs a request field:** `POST /imports/players/{batchId}/commit` must accept `importRowsWithWarnings: boolean` (CSV_IMPORT §3 step 3: "Rows with warnings commit only if the owner ticked *import rows with warnings*"). The frontend sends it; the contract must carry it or the behaviour is unimplementable as specified.
2. **IMP-01 `preview[]` has no defined field list** in `API_CONTRACTS` §3.8. It is declared in `src/api/types.ts` (`ImportPreviewRow`) from CSV_IMPORT §2's columns (`row, fullName, dateOfBirth?, registrationDate?, ageGroupName?, status?, guardianName, guardianPhone, guardianRelationship?, whatsappConsent?, consentSource?, notes?`) — Freebuff must confirm or amend it, and API_CONTRACTS should then state it.
3. **CSV columns are only in `CSV_IMPORT` §2, not in the contract.** The mock parser and the wizard now follow §2 exactly (snake_case: `full_name, date_of_birth, registration_date, age_group, status, guardian1_name, guardian1_phone, guardian1_relationship, guardian2_name, guardian2_phone, whatsapp_consent, consent_source, notes`; comma or semicolon; ≤ 1000 rows, ≤ 2 MB). Keep the two documents aligned — an earlier draft of this slice used invented camelCase column names and was corrected.
4. **`PlayerCreate.guardians` is written as malformed TypeScript** in `API_CONTRACTS` §3.4: `({ guardianId } | { fullName; phone; … })[] & { isPrimary; receivesInvoices }[]`. Read as intended it must be **per element**: `({ guardianId } | { fullName; phone; relationship?; whatsappConsent? }) & { isPrimary: boolean; receivesInvoices: boolean }`. The frontend implements the per-element intersection; please fix the spec text (C0).
5. **`PlayerCoachView.primaryGuardian` "only if setting"** — the gate is `academy_settings.coach_can_see_guardian_phone` (SET-01, OPEN-008). The mock currently always returns it for an assigned player. The backend must apply the setting; the frontend only renders what it receives.
6. **Coach scoping is mock-level.** `PLY-01/03/10` answer 404 for an out-of-scope player because the mock filters by the coach's current assignments. In production this must come from the database (RLS), evidenced by **T-DB-RLS-02** — a frontend filter is not authorization.
7. **Still open from 2026-10-11 (unchanged):** GAP-1 AUTH-06 response shape, GAP-2 `TOTP_REQUIRED` semantics, GAP-3 `INVITE_INVALID`, GAP-4 how `SESSION_EXPIRED` is signalled. CR-002 applies: none of them may reintroduce `email`.
8. **No backend exists**, so no contract test was possible; `api/openapi.yaml` is still absent (M1 not delivered). Frontend types remain hand-written from API_CONTRACTS §2 (ADR-009's interim path).

## 5. Known gaps and risks

- **No version control on this project** — unchanged and still the cheapest protection available (`git ls-files .` → 0). This slice added ~15 source files; none of them can be diffed, reviewed or reverted.
- **409 `VERSION_CONFLICT` is implemented but not exercised by an automated check** (it needs two clients touching one record). The reload dialog exists; only a manual/2-tab test would prove it.
- **Mock store:** the people slice is kept in module memory and mirrored to `localStorage` `ia_mock_people_v1` so a reload does not undo a registration. It is dev-only (`NEXT_PUBLIC_USE_MOCKS`), never shipped, and cleared by clearing site data; the E2E runs in fresh contexts, so every run starts from the seed.
- **Import is mock-side:** the browser parses the CSV in the mock so the wizard is testable; the real parsing/commit is Freebuff's, in one transaction (IMP-02).
- **Next.js 16 dev-only diagnostic (pre-existing, app-wide):** the console logs *"Route "/players": Could not validate that a segment in your UI has instant navigation … Dropped segment: src/app/players/page.tsx"* — on `/dashboard` and `/login` too, i.e. not introduced here. Cause: `Providers` renders `null` until the MSW worker has started, so the page segment is absent during validation (deliberate since Step 1). Fix candidates, for a later slice: `export const instant = false` on the segments, or a loading state that renders the segment. It does not affect behaviour, but it does put a dev overlay in the console and the E2E had to scope its dialog selectors to our own `aria-label`s because of it.
- **Not verified here:** real-phone 360 px use, axe/critical-path screen-reader pass, >100 players per group (the roster fetch is capped at the contract's `pageSize ≤ 100`), and the mock's `localStorage` behaviour in private mode.
- Money rule respected: no float arithmetic anywhere in the new code; every amount is rendered through `formatMoneyMinor` (integer minor units) and parsed through `parseMoneyInput`.

## 6. How to run / verify

```bash
cd "Projects/inspire-academy-player manager/frontend"
npm install
npm run dev                # http://localhost:3100 (mock mode via .env.local)
npm run typecheck && npm run lint && npm run build
npm run verify:e2e         # step 2 (12) + step 3 (30); needs `npm run dev` listening
npm run verify:e2e:step3   # step 3 only
```

Mock logins (any password): `owner` · `coach` · `totp` (asks for a code) · `locked`. Seed data: 3 age groups (Under-11 is the coach's), 8 players (7 active/1 withdrawn/1 inactive), 7 invoices, guardians incl. one opted-out, 2 coaches with assignments. Reset the people mocks by clearing site data in the browser.

## 7. Next steps (exact)

1. **Claude (docs):** resolve §4.1–§4.4 in `API_CONTRACTS`/`CSV_IMPORT` (IMP-02 field, IMP-01 `preview[]` shape, CSV column list, the `PlayerCreate.guardians` type text) and close the four open GAPs from 2026-10-11.
2. **Frontend:** Step 4 — mobile attendance sheet (`/sessions`, `/sessions/[id]`, coach one-tap clock in/out), the riskiest UX; keep T-UI-10..12 (one-handed, 360 px, checked at that step).
3. **Hassen:** the decisions that still block building (CR-003 confirmation; OPEN-021/003/006/018; logo OPEN-001), and a look at the screenshots in `frontend/.verify/`.
4. **Freebuff (when M1 lands):** implement `username`-based AUTH-01/USR-02, the PLY/GRP/FEE/GDN/CCH/IMP endpoints to the reviewed contract, coach scoping in the database (not the UI), and answer §4.1–§4.5.

## 8. Reviewer checklist (Claude/Hassen fills)

[ ] Compared to DATABASE/API docs  [ ] Permissions verified by route matrix  [ ] No money floats
[ ] Audit rows present  [ ] Tests evidence reviewed  [ ] PROJECT_STATUS updated  [ ] Verdict: accepted / changes requested
