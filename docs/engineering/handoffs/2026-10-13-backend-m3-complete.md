# HANDOFF 2026-10-13 — backend M3 complete (players, guardians, groups, fees, coach assignments, CSV import)

Author: Freebuff      Milestone: M3      Branch/PR: (local working tree)

## 1. Scope delivered

- **Endpoint IDs implemented (31):** `GRP-01..05`, `FEE-01/02`, `CCH-01..05`, `PLY-01..09`, `GDN-01..05`, `IMP-01/02`. Every endpoint carries `milestone: "m3"` in the contract registry, and `backend/scripts/progress-report.ts` now prints `m3: 31/31` (`TOTAL: 54/134`).
- **Migrations added:**
  - `0007_people.sql` — `age_groups`, `group_fees`, `coach_group_assignments`, `players`, `player_group_history`, `guardians`, `player_guardians`, `import_batches`; the `app.app_coach_group_ids(date)` scope helper; `app.set_updated_at()` / `app.bump_version()` triggers; RLS (ENABLE + FORCE) and grants.
  - `0008_academy_coach_context.sql` — appends `age_reference_rule`, `age_reference_month_day`, `coach_can_see_guardian_phone` to the coach-facing `app.academy_public` view.
  - `0009_primary_guardian_view.sql` — `app.player_primary_guardian` (SECURITY DEFINER), the one door through which a coach may see a primary guardian's name/phone when `coach_can_see_guardian_phone` is true.
- **New dependency:** `@fastify/multipart@^9` (IMP-01 multipart upload; shared limits 2 MB / one file).
- **Docs read before starting:** IMPLEMENTATION_PLAN M3, DATABASE §2–§3.2/§7/§8, API_CONTRACTS (via `spec/sections/03,04,08`), CSV_IMPORT, AUTH_AND_PERMISSIONS §4–§5, TESTING_AND_ACCEPTANCE, the M2 handoff.

## 2. Evidence

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean, exit 0 |
| `npx vitest run` | **56 passed / 56** (6 files: 1 unit, 2 db, 3 integration) |
| `npx tsx scripts/progress-report.ts` | `m2: 23/23`, `m3: 31/31`, `TOTAL: 54/134` |
| `npm run openapi:lint` | valid, 3 pre-existing warnings (contract unchanged) |
| Live server against `ia_dev` | started 2026-10-13; `assertRuntimeRoleIsUnprivileged()` passed; `GET /api/v1/health` → 200, `GET /api/v1/ready` → 200 |

New tests:

- `tests/db/people-rls.test.ts` (6) — **T-DB-RLS-02**: as `ia_app` with a coach context, the coach sees only the players/groups/history of the group they hold *today*; `coach_group_assignments`/`group_fees`/`guardians`/`player_guardians`/`import_batches` return nothing; an UPDATE to a player touches **0 rows**; the runtime role can delete only a `player_guardians` link, never a `players` row.
- `tests/integration/people-surface.test.ts` (9) — drives the real HTTP surface: fee change (missing/reused/replayed `Idempotency-Key`, past-date confirmation), group suggestion + archive refusal, register → read → transfer with history, duplicate warning + acknowledgement + advisory PLY-08, coach restricted projection (key set asserted, out-of-scope 404), withdrawal reason (`REASON_REQUIRED`), guardian link/primary/unlink-last refusal/consent, and the CSV validate → commit → replay flow. Owner-only M3 endpoints are asserted 403 for a coach (T-AUTH-01).

`tests/helpers/test-db.ts` `resetData()` now also clears the M3 tables and `document_counters`, so fixtures cannot leak between tests.

## 3. Deviations from the spec

| Spec ref | What differs | Why | Needs spec change? |
|---|---|---|---|
| DATABASE §7 grants | `ia_app` holds **DELETE on `player_guardians`** (the only delete grant added) | GDN-04.unlink removes a *link*; there is no soft-delete column for it, and DATABASE §6's "never hard-deleted" rule is about people/financial rows | cosmetic — worth a line in DATABASE §7 |
| DATABASE §3.2 | `app.academy_public` gained three columns (0008) and a new `app.player_primary_guardian` view (0009) | a coach needs the age rule and, when the setting is on, the primary guardian's phone; widening a policy on `guardians` would expose the whole table | no — same pattern as the existing coach view |
| DATABASE §3.3 `/players/{id}/invoices` (PLY-09) | returns an **empty page** | the `invoices` table is introduced in M5; no player can have an invoice yet, so an empty page is the truthful answer and the shape stays contract-correct | no — M5 fills it |
| API_CONTRACTS PLY-05 | the withdrawal-without-reason refusal uses the declared **`REASON_REQUIRED`** (422) | the contract row lists it; `VALIDATION_ERROR` would have been the generic code | no |
| CSV_IMPORT §3 step 3 | IMP-02 has no request body in the contract, so "import rows with warnings" cannot be ticked per row; **duplicate-suspect rows are skipped and counted**, other warnings commit | the contract's own description already says duplicate-suspect rows are skipped rather than merged; a body flag would be a contract addition | yes — see §4 |
| CSV_IMPORT §3 step 1 | the parsed rows live in `import_batches.report` jsonb; no `files` row is written | no object-storage adapter exists until M6; the bytes are never kept, only the normalized rows | no — M6 stores the file |

## 4. Contract drift / requests

- **IMP-02 has no body.** "Import rows with warnings" (CSV_IMPORT §3) cannot be expressed; today duplicate-suspect rows are skipped/counted and all other warnings commit. If the owner must opt in per batch, IMP-02 needs a body (e.g. `{ importRowsWithWarnings: boolean }`).
- **`FEE-02`/`IMP-02` needed an idempotency layer** and the contract declares no code for the concurrent case. `src/http/idempotency.ts` implements the two documented codes (`IDEMPOTENCY_KEY_REQUIRED` 400, `IDEMPOTENCY_KEY_REUSED` 422) and answers a still-in-progress key with 409 `INVALID_STATE_TRANSITION`. M5's money endpoints will reuse it; the concurrency code deserves a contract line.
- **CCH-03's overlap** has no declared error code (the contract row says so explicitly); this implementation returns 409 `INVALID_STATE_TRANSITION`. A dedicated code would be clearer.
- **PLY-01 `hasOutstanding`** is accepted and returns an empty page until M5 defines outstanding. No change needed, but it is a no-op filter today.
- Still open from M2 (unchanged): `AUTH-06` response shape, no `TOTP_REQUIRED`, no `INVITE_INVALID`, how `SESSION_EXPIRED` is distinguished, `SET-03` multipart body, `USR-05` shape, `paymentInstructions` required-but-nullable, `audit_logs.entity_id` uuid for non-uuid rows.

## 5. Known gaps and risks

- **T-PLY-*/T-GRP-01/T-AUTH-06 remain unautomated as catalogue rows.** The tests assert the behaviour the M3 exit names (T-DB-RLS-02, T-AUTH-01/03/05) but they are not written as the TESTING_AND_ACCEPTANCE rows with those IDs.
- **PLY-09 and `hasOutstanding` depend on M5.** PLY-11 and GDN-06 (balances) are M5 and are **not** implemented.
- **No CI** still. `tsc`, `vitest` and `openapi:lint` were run by hand for this handoff.
- **Audit `entity_id` for `import_batch`** is a uuid and the batch id is a uuidv7 — fine, but note `age_group`/`group_fee`/`coach_assignment`/`player`/`guardian` audit rows use the row id (uuid) consistently.
- **`gdn01List` reads the page and the player-links in two separate transactions** — a guardian linked between the two reads would not show its players in that response. Harmless, but it is not a single snapshot.
- **`PLY-05`'s `stopReminders`** is recorded in the audit only: `message_jobs` arrives in M7, so there is nothing to cancel yet.
- **`GDN-05`'s `revoked`** likewise cannot cancel queued jobs yet (M7).
- CSV import: the row number reported is the physical line in the file (header = 1), which is what the owner sees in Excel.

## 6. How to run / verify

```bash
cd "Projects/inspire-academy-player manager/backend"
npm run db:status          # embedded PostgreSQL on 55432
npm run migrate            # apply 0007–0009 to ia_dev
npx tsc --noEmit
npx vitest run             # 56/56
npx tsx scripts/progress-report.ts   # m3: 31/31
npm run openapi:lint
npx tsx src/server.ts      # then GET http://localhost:3200/api/v1/ready
```

## 7. Next steps (exact)

1. **M4 — schedules, sessions, attendance, coach attendance (19 endpoints).** New tables in `0010+`; `scripts/progress-report.ts` lists every missing operation id.
2. **M5 (unblocked next per the milestone order):** `SET-04`, `PLY-11`, `GDN-06`, billing runs, invoices, payments, allocations, receipts — and the `invoices` table that turns PLY-09 and `hasOutstanding` into real answers.
3. **Blocked on people, not code:** CR-003 approval, OPEN-001 (logo), OPEN-023/024/025; M6 begins with spike P1 (Sinhala/Tamil PDF); M7 with spike S1 (VPS + WhatsApp number).
4. **Consider adding CI** (typecheck + `vitest run` + `openapi:lint`) so this evidence is produced on every change.

## 8. Reviewer checklist

[ ] Compared to DATABASE/API docs  [ ] Permissions verified by route matrix  [ ] No money floats
[ ] Audit rows present  [ ] Tests evidence reviewed  [ ] PROJECT_STATUS updated  [ ] Verdict: accepted / changes requested
