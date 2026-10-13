# HANDOFF 2026-10-12 — Frontend Steps 6–8: WhatsApp, dashboard/reports, admin

Author: Buffy (frontend lead) · Milestone: M7 + M8 (frontend slices, mocks) · Change record: **CR-003 surfaces are now built while ADR-019 is still *Proposed*** — see §3 · Plan: [FRONTEND_PLAN.md](../../../FRONTEND_PLAN.md) §5 (Steps 6–8)
Branch/PR: none — **this project still has no tracked files** (`git ls-files .` → 0; the folder is untracked in the workspace repo)

> The Step 6 half of this work has its own record: [2026-10-12-frontend-step6-whatsapp.md](2026-10-12-frontend-step6-whatsapp.md) (the file `src/api/types.ts` cites for the `MessageJob.kind` gap). This file covers all three steps together, because they share one mock store, one handler registration order and one set of contract gaps.

## 1. Scope delivered

### Step 6 — WhatsApp
`MSG-01..08`, `SET-05..08`. `/whatsapp` (Status · Messages · Reminders & templates · Settings) and `/whatsapp/messages/[id]` (`MSG-02..05` + the copy/`wa.me` fallback). The `SET-08` per-automation switches under the `MSG-07` master pause. Full detail, and the rules the slice exists to keep, are in the Step 6 handoff above.

### Step 7 — Dashboard and reports
- **`/dashboard`** (`src/app/dashboard/page.tsx`) — one route, two projections, chosen from `Me.user.role`:
  - **Owner (`DSH-01`)** — alerts strip; the money row (**Invoiced · Collected · Outstanding · Overdue**, always four separate numbers, with "due in the next 7 days" and "credit held"); players with per-group bars linking to a filtered `/players`; today's sessions with unmarked counts; **Coaches today** (`coachTime`: checked in now, today's and this week's hours, open check-ins needing correction); upcoming sessions; messaging (session status + failed/dead/needs-review counts linking to `/whatsapp`).
  - **Coach (`DSH-02`) "Today"** — today's session cards with **one-tap clock in/out** (no dialog, no confirmation, ≥ 48 px) and **Take attendance**, upcoming sessions, and **own hours this week**.
  - Only Invoiced/Collected follow the date-range selector; Outstanding/Overdue are labelled "as of now". A coach never calls an owner endpoint, and hours come from **closed** check-ins only — an open check-in shows elapsed time and is never counted as worked hours.
- **`/reports`** (`src/app/reports/page.tsx`) — the index: one card per report naming what it answers and which filters it takes.
- **`/reports/[name]`** (`src/app/reports/[name]/page.tsx`) — one screen for all eight reports: filters from the URL, a table, a totals row, **Export CSV** (`RPT-02`) with the filters echoed in the filename, and a "generated at" timestamp. Columns come from the API's `ReportResult.columns`, so nothing is hardcoded client-side. `collections` keeps **Invoiced** and **Collected** in separate columns with separate totals — there is no combined money column. `outstanding` is "as of now" and says so. Money cells are integer minor units formatted through `lib/money.ts`.
- **Data layer:** `src/mocks/handlers.dashboard.ts` (`DSH-01/02`, `RPT-01/02`) and `src/mocks/reports.ts` (`REPORT_NAMES`, `isReportName`, `parseFilters`, `runReport`, `buildCsv`, `EXPORT_ROW_CAP = 50_000`).

### Step 8 — Admin, settings and polish
- **`/users`** (`src/app/users/page.tsx`) — `USR-01..05`: list (name, **username**, role, status, last login), invite-URL dialog shown **once** with copy, edit, disable/enable, `USR-05` reset (# see §4.4). Invited coaches keep landing in the people slice's coach list because `POST /users` stays owned there (one line added so the invited user also appears in the admin store's list).
- **`/settings`** (`src/app/settings/page.tsx`) — four tabs: **Academy** (`SET-01` full), **Billing** (`SET-02`, save dialog states "Applies to invoices issued after now"), **Payment methods** (`SET-04`; deactivate, never delete — the code is immutable), **Branding** (`SET-03` logo upload with a preview, or the plain words "Using text header" when there is none).
- **`/system`** (`src/app/system/page.tsx`) — `SYS-03` cards (DB, storage, OpenWA, queue, scheduler heartbeat, last backup, version). A card with no reading shows **Unknown**, never Ok.
- **`/audit`** (`src/app/audit/page.tsx`) — `AUD-01`, newest first, filters in the URL, detail drawer pretty-printing the before/after snapshots exactly as the API returned them (masked values left masked).
- **Imports** — the 3-step wizard already existed from Step 3 (`/imports/players`, `IMP-01/02`); this session did not rebuild it. No axe harness was added (see §5).
- **Wiring:** `src/components/AppShell.tsx` gained the missing **System** entry in the owner sidebar; `src/components/StatusChip.tsx` gained the words this slice prints (message status/delivery, session status, automation state, health state).

### Shared data layer (all three steps)
- **`src/mocks/store678.ts` (new)** — one store for Step 6–8 state: users, the audit log, reminder rules, templates, messaging settings, the `SET-08` switches, the academy settings, session status and the logo URL. Mirrored to `localStorage ia_mock_admin_v1` (the people/billing store keeps `ia_mock_people_v1`). It also owns the two cross-slice rules: `patchAutomations` cancels a switched-off kind's unsent jobs (`AUTOMATION_DISABLED`, never back-filling) and `logAudit` is the single audit writer, so `AUD-01` shows real history.
- **Message jobs stay in `db.ts`'s `messages` array** — the billing slice already enqueues there, so `MSG-*` and the dashboard read the same rows instead of a look-alike list.
- **`src/lib/messaging.ts` (new)** — the messaging label-discipline module (the twin of `lib/billing.ts`): closed sets for status/delivery/kind/session words, `skipReasonLabel`, the `AUTOMATIONS` metadata, `automationWarning` (R-20), template var parsing/rendering, `reminderRuleLabel`, `waMeLink`, `ASK_FOR_PDF_MESSAGE`.
- **`src/api/types.ts` / `src/api/client.ts`** — the contract types and wrappers for all three steps: `msg01..08`, `set05..08`, `dsh01/02`, `rpt01/02`, `usr01..05`, `set01GetAcademySettings`/`set01PatchAcademySettings`, `set02PatchBillingSettings`, `set03UploadLogo`, `set04CreatePaymentMethod`/`set04PatchPaymentMethod`, `aud01ListAuditLogs`, `sys03GetSystemHealth`.
- **`src/mocks/handlers.ts`** — registration order is now `auth → people → sessions → messaging → admin → dashboard → billing`. The admin slice owns `GET /settings/academy` and returns the **full** `AcademySettings` (merging the identity/payment fields from `db.settings`), so the money screens' existing subset read is not shadowed by a second handler.
- Migrations added: none (no backend).

## 2. Evidence

**Verified by the coordinator on 2026-10-12, after every slice landed**, against `npm run dev` listening on :3100 (mock mode) with system Chrome:

| Command | Result | Log |
|---|---|---|
| `npm run typecheck` (`tsc --noEmit`) | clean, exit 0 | — |
| `npm run lint` | **0 errors / 0 warnings** | — |
| `npm run build` | green, **35 routes** (was 33) | `.verify/build-step678.log` |
| `npm run verify:unit` | **17/17** (unchanged from Step 5) | — |
| `npm run verify:e2e:step678` | **45/45 PASS** | `.verify/e2e-all-step678.log` |
| `npm run verify:e2e` (all five scripts) | **12/12 + 30/30 + 41/41 + 60/60 + 45/45 = 188 checks, 0 failures, exit 0** | `.verify/e2e-all-step678.log` |

The full-suite rerun matters: the handler registration order changed and a second mirrored store was introduced, and neither regressed Steps 2–5.

What the new script proves through the running app (not just "it rendered"): the four tabs and the no-back-fill copy; **no message row reads "Delivered"** while every seeded ack is `server_accepted`/`unknown`, and the honest words are on the rows; MSG-05 turns a failed job into the owner's own claim (`sent`) and still refuses to claim delivery; MSG-03 requires an `Idempotency-Key` (400 without one) and re-queues without a delivery claim, refusing only with `MESSAGE_NOT_RETRYABLE`; **turning `reminderOverdue` off cancels two unsent jobs as `cancelled` + `AUTOMATION_DISABLED`, and re-enabling back-fills none of them**; MSG-02 returns an event timeline with no invented `providerAck`; DSH-01 keeps Invoiced and Collected as separate fields (1,300,000 / 1,400,000 minor), reports coach time from the closed records and raises the disconnected-WhatsApp alert; the collections report and its CSV keep Collected and Invoiced in separate columns **and separate totals**, the export carries a real UTF-8 BOM (checked as bytes) plus a `Content-Disposition` filename, and an unknown report name is a 404 page; USR-04 answers **409 `LAST_OWNER`** for the last active owner; SET-01 returns the full academy settings; Branding says *Using text header*; AUD-01 is newest-first with request ids; SYS-03 reports `openwa=degraded` while the session is disconnected; and on a 360 px viewport the coach gets their own day, their own hours with the "closed check-ins only" note, **403 from the messaging API, and a permission-denied page with none of the switches**.

**Fixes made while verifying (the cause, never worked around):**

1. `src/app/payments/page.tsx` — the new doc comment contained `**Confirm**/**Reject**`, whose `*/` **closed the block comment early**, so TS/ESLint parsed the prose as code (5 syntax errors). Reworded to `Confirm/Reject`; nothing else in that file was touched.
2. `src/api/client.ts` — this slice declared `usr02CreateUser` a second time (`TS2323`/`TS2393`); the Step 3 wrapper is kept and a comment points at it.
3. `src/mocks/reports.ts` — `attendanceDetailRows` took an unused `viewer`; the parameter and its call site were removed rather than silenced.
4. `src/mocks/store678.ts` — the seeded `skipReason`/`lastError`/`nextAttemptAt` extras were built but never spread into the job, and the guardian-phone read needed a `typeof` narrowing (`TS2345`).
5. `src/mocks/handlers.admin.ts` — one `as unknown as Record<string, unknown>` for the settings writer (the shape has no index signature); no other casts were added.
6. Lint to 0/0: `audit/page.tsx` memoised its `?? []` fallback; **`settings/page.tsx` was restructured from four effect-synced copies to derived state** (`react-hooks/set-state-in-effect` ×4) — no `eslint-disable`, no suppression; `whatsapp/page.tsx` escaped two quotes in JSX text.
7. `.verify/step2-e2e.mjs` asserted the **old placeholder dashboard copy** (`Collected (Nov 2026)`) that DSH-01 replaced. The assertion now checks the four separate figures on the real page: updated to the new reality, not relaxed.

Two of the new script's own assertions were wrong at first and were fixed rather than loosened: `textContent("body")` also returns the inline RSC `<script>` payloads (so the checks were reading JSX source strings), and a CSV BOM cannot be seen through `res.text()` because UTF-8 decoding strips it — the export is now read as bytes.

**Still not verified:** no axe/a11y scan has been run for any step (Steps 1–8); T-UI-10's real-phone pass is still owed by Hassen; the seeded WhatsApp session is `awaiting_qr`, so no message can actually reach a provider; and **CR-003 is not approved in writing** — see §3.

_Not verifiable at the time this was written:_ every file named in §1 was present on disk, so no slice was missing. The only file this author could not read **in full** was `src/mocks/handlers.admin.ts` (the read was truncated mid-`SET-04 PATCH`); its remaining routes (`SET-04 PATCH`, `AUD-01`, `SYS-03`) are described from the plan and from the part that was visible, not from a full read.

## 3. Deviations from the spec

| Spec ref | What differs | Why | Needs a spec change? (CR-###) |
|---|---|---|---|
| `PROJECT_STATUS` §"CR-003 is written but NOT approved" + `ADR-019` (**Proposed**) | The CR-003 surfaces **are built**: the `SET-08` per-automation switches, the `DSH-02` one-tap clock in/out cards, the `DSH-01` `coachTime` block, and the `/payments` **Verification** tab (gated on `SET-08.proofCheck`, which is **off by default**) | These three steps were the session's brief, and the plan's Step 6/7 deliverables name these exact surfaces | **Yes — needs Hassen's confirmation in writing.** Recorded here rather than resolved silently: the code now contains surfaces an ADR still calls *Proposed* |
| `API_CONTRACTS` §2 `MessageJob.kind` | `kind` gained `"test"` | `MSG-08` returns a `MessageJob`; a test send matches no listed kind — §4.1 | Yes (contract addition) |
| `DSH-02` response | `CoachDashboard` gained `myWeekMinutes` | `PAGE_SPECIFICATIONS` §2 requires the coach's own hours this week; the contract's three fields cannot express it — §4.2 | Yes (contract addition) |
| `RPT-01` response | `ReportResult` adds `columns`, `generatedAt` and `filters` on top of `Page<Row> + totals` | The contract fixes neither the `Row` shape nor the `totals` keys, and the screen must not hardcode columns — §4.5 | Yes (contract addition) |
| `SET-07` `attachment_and_link` | Rejected with **422 `VALIDATION_ERROR`** | The contract requires rejection until a spike-S1 media test passes but names no code — §4.4 | Yes (error code) |
| `USR-03` PATCH | A `username` in the body is refused with 422 rather than ignored | `ADR-018` says a username cannot be edited, only replaced by re-inviting; silently dropping the field would look like a save | No (clarification of ADR-018) |
| mock stores | A second mirrored store (`ia_mock_admin_v1`) beside `ia_mock_people_v1` | Step 6–8 state has no home in `db.ts`; one shared module beats three handler slices growing three copies | No (C0) — mock only |

## 4. Contract drift / requests

1. **`MessageJob.kind` has no `test`, and a test send has no invoice or player.** `MSG-08` is typed `→ MessageJob`, but `kind` lists only the three send kinds and `invoice`/`player` are non-optional. `kind: "test"` was added in `src/api/types.ts`, and the mock writes the literal ids `"test"` with names `TEST` / `Test message`. Either the kind union grows and `invoice`/`player` become optional for it, or `MSG-08` returns its own shape.
2. **`DSH-02` has no field for the coach's own hours this week.** `PAGE_SPECIFICATIONS` §2 requires them, so `CoachDashboard.myWeekMinutes` was added (closed check-ins only, same rule as `coachTime`).
3. **`BIL-02`'s message-job `skipReason` strings are still undefined** (raised in the Step 5 handoff, still open). `src/lib/messaging.ts` maps the reasons it recognises and **prints anything else verbatim**; `MSG-04`'s cancel writes `CANCELLED_BY_OWNER`, a value the contract does not define.
4. **`MSG-03`'s blocked-retry case has no code.** A retry refused because the guardian opted out, or the invoice was voided/paid, answers the only code the contract names for an illegal action — 409 `MESSAGE_NOT_RETRYABLE` — with a plain-language reason.
5. **`SET-07`'s `attachment_and_link` rejection code is unstated** → 422 `VALIDATION_ERROR` with the spike-S1 reason.
6. **`RPT-01`'s `Row` shape and `totals` keys are unspecified.** `ReportRow` (`Record<string, string|number|boolean|null>`), `ReportColumn` and `ReportResult` are declared in `src/api/types.ts` so the screen can render whatever the API sends. The eight reports' filter **query-param names** are likewise the frontend's choice (the contract fixes only the report names); if the backend uses different keys, the export filename and the table will still agree with each other but the filters will not reach the query.
7. **`RPT-02`'s row cap and rate-limit codes are unstated in the table row.** `reports.ts` carries `EXPORT_ROW_CAP = 50_000` and the page maps the 429/413 envelope to "Narrow the filters (max 50,000 rows)", per `PAGE_SPECIFICATIONS` §10 — the contract should name those codes.
8. **`AUD-01`'s `from`/`to` are not stated as dates or instants.** The page sends `YYYY-MM-DD` and expects inclusive academy-local day bounds.
9. **`USR-*` has no standalone "revoke sessions" endpoint.** `PAGE_SPECIFICATIONS` §11 lists a row action "revoke sessions", but no contract row does that alone — `USR-05` is the route that revokes sessions *and* issues a new invite, so the row action **is** `USR-05` and its dialog says so. A standalone revoke was not invented.
10. **`SET-07` needs a `consentPolicyText`** (`PAGE_SPECIFICATIONS` §9 requires the consent snippet for forms); the contract's field list has none, so it is declared here. Drop it if the backend keeps that text elsewhere.
11. **`SET-08`'s GET shape** is written as "the same object + `masterPaused`"; declared as `AutomationsResponse = Automations & { masterPaused: boolean }`.
12. **`SET-01`'s `beneficiaryAccounts` is read-only.** The full-`AcademySettings` reference returned by `GET /settings/academy` carries the accounts a bank receipt is matched against (`PAYMENT_VERIFICATION` §3), but this screen does not offer them for edit and the mock refuses an unknown field. Whether they are editable from Settings is a product decision, not a UI one.

## 5. Known gaps and risks

- **CR-003 was never approved in writing.** The built surfaces are listed in §3; if Hassen does not confirm, either `ADR-019` must move to Accepted or those surfaces must come back out. This is the single biggest open item in this slice.
- **Everything here is mocks.** No message is sent, no provider is contacted, no report is computed by a real engine, no audit row is written outside the browser, and `/system`'s health cards read the mock store — they report the shape of the answer, not the state of a real system.
- **The mock's report numbers come from the mock ledger.** `reports.ts` derives `collections`/`invoices`/`payments`/`outstanding` from the same billing store the money screens use, so the two agree by construction — that agreement is the thing the real backend has to reproduce, and nothing here tests it.
- **Doc inconsistency worth fixing:** `src/app/payments/[id]/page.tsx` still carries the comment that the `/payments` Verification tab is "deliberately NOT built", while `src/app/payments/page.tsx` now builds it, gated on `SET-08.proofCheck`. The comment is stale, not the code.
- **Dangling handoff references:** several modules cite handoffs this session did not write — `src/app/users/page.tsx` and `src/app/audit/page.tsx` point at "the Step 8 handoff", `src/app/dashboard/page.tsx`/`src/api/types.ts` point at "the Step 7 handoff". Those files do not exist; §4 of this combined record carries their content. Either create the two files or repoint those comments here.
- **No axe/a11y scan has been run for any step (1–8)** — no axe harness is installed. The `SET-08` switches, the coach clock cards, the reports table and the settings forms have had no automated a11y pass.
- **T-UI-10/11/12's real-phone pass is still owed by Hassen** — the coach clock card and the settings/automation switches are specified as one-handed at 360 px; only an emulated viewport has been used.
- **`/imports/players` was not touched in this session** — it is the Step 3 wizard; whether its 3rd step matches `CSV_IMPORT` §3 today was not re-checked.
- **No version control on this project** — unchanged (`git ls-files .` → 0), so this slice can only be diffed by hand.

## 6. How to run / verify

```bash
cd "Projects/inspire-academy-player manager/frontend"
npm install
npm run dev                 # http://localhost:3100 (mock mode)
npm run typecheck && npm run lint && npm run build
npm run verify:unit         # Vitest (money/dates)
npm run verify:e2e          # step 2 + 3 + 4 + 5 suites
```

Mock logins (any password): `owner` · `coach`. Fixtures: `localStorage ia_mock_people_v1` (people/billing/sessions/messages) and `ia_mock_admin_v1` (users, audit, messaging settings, automations, academy settings, logo, session status). Clear site data to re-seed. `proofCheck` is **off** by default, so the `/payments` Verification tab does not appear until it is switched on in `/whatsapp` → Status → Automations.

## 7. Next steps (exact)

1. **Hassen (owner):** confirm `ADR-019`/CR-003 in writing, or ask for the surfaces in §3 to be removed; do the outstanding **T-UI-10** device pass on the coach clock card and the automation switches.
2. **Claude (docs):** answer §4.1–§4.12 — most urgently the `MessageJob.kind`/`test` problem, the `skipReason` vocabulary, `myWeekMinutes` on `DSH-02`, and the `RPT-01` row/totals shape. Also decide whether `SET-01.beneficiaryAccounts` is editable.
3. **Frontend (next session):** create or repoint the Step 7/Step 8 handoff references, fix the stale `payments/[id]` comment, add an axe pass, and update `FRONTEND_PLAN.md` §5 + `PROJECT_STATUS.md` with the results of the Step 6–8 verification run.
4. **Freebuff (when the backend lands):** the real aggregates behind `DSH-01/02`, the server-side report engine + streaming CSV with the 50k cap and formula-injection neutralisation, `USR-*`/`SET-*`/`AUD-01`/`SYS-03`, and the `SET-08` per-kind gating in the worker.

## 8. Reviewer checklist (Claude/Hassen fills)

[ ] Compared to `API_CONTRACTS` §3.7/§3.8 and `PAGE_SPECIFICATIONS` §2/§9/§10/§11  [ ] Permissions verified by route matrix (`/whatsapp`, `/reports`, `/users`, `/settings`, `/audit`, `/system`)  [ ] No money floats
[ ] Invoiced and Collected separate on the dashboard and in `collections`  [ ] Audit rows present on every mutation  [ ] Evidence reviewed  [ ] `PROJECT_STATUS` updated  [ ] Verdict: accepted / changes requested
