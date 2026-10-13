# Handoff — backend M2 complete (2026-10-13)

## Goal

Close milestone **M2** of [IMPLEMENTATION_PLAN](../IMPLEMENTATION_PLAN.md) — the identity,
permission and settings foundation of the API — against the contract registry in
`backend/spec/`, with the database layer (RLS, deferred constraints) proven independently
of the API.

## Current state

**M2 is implemented and green: 23/23 contract endpoints carrying `milestone: "m2"` are
served.** The remaining 111 endpoints belong to M3–M8 and are documented but not served —
`backend/scripts/progress-report.ts` prints the contract-versus-handler gap per milestone
(`TOTAL: 23/134` today), so "documented" never has to be confused with "implemented".

Verification, one run, on the test database (`ia_test`):

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean, exit 0 |
| `npx vitest run` | **41 passed / 41** (4 files: unit, db, integration ×2) |
| `npx tsx scripts/progress-report.ts` | `m2: 23/23`, `TOTAL: 23/134` |
| Migrations `0001`–`0006` | applied to `ia_dev` and `ia_test` |

**Not done / owed for M2:**

- **No live server smoke test.** Every HTTP assertion goes through `app.inject()` against
  a real PostgreSQL; `src/server.ts` has never been started against `ia_dev` in this
  session. The runtime-role self-check (`assertRuntimeRoleIsUnprivileged`) therefore has
  unit coverage but no startup evidence.
- **Contract gaps raised, not resolved** (unchanged from the previous session, repeated in
  §4): `AUTH-06` response shape, no `TOTP_REQUIRED`, no `INVITE_INVALID`, how
  `SESSION_EXPIRED` is distinguished, `SET-03`'s `multipart/form-data` body, `USR-05`'s
  response shape, `paymentInstructions` required-but-nullable, `audit_logs.entity_id`
  being a uuid for non-uuid rows.

## Active files

New this session:

- `backend/migrations/0006_owner_invariant_visibility.sql`
- `backend/src/routes/settings.ts`
- `backend/scripts/progress-report.ts`
- `backend/tests/integration/owner-surface.test.ts`

Modified:

- `backend/src/http/router.ts` (`fastifyPath`), `backend/src/http/context.ts` (`asViewer`),
  `backend/src/routes/users.ts`, `backend/src/routes/index.ts`, `backend/src/app.ts`
  (`DEBUG_TESTS=1` diagnostic), `backend/tests/helpers/auth.ts` (per-test client IP),
  `backend/tests/db/rls.test.ts`, `backend/tests/unit/unit.test.ts`,
  `docs/engineering/PROJECT_STATUS.md`, `handoff.md`.

## Changes made

Three defects were found by driving the real HTTP surface, none of them by reading code:

1. **Every coach sign-in returned 500 (fixed by migration `0006`).** The deferred
   "at least one active owner" constraint trigger from `0002` evaluated its
   `select count(*) from users where role = 'owner'` with the *invoker's* rights. Sign-in
   updates the caller's own row, so for a coach the count ran through `users_self_read`
   (which sees exactly one row — the coach), found no active owner and aborted the whole
   transaction at COMMIT with a spurious `LAST_OWNER`. `0006` recreates the function as
   `SECURITY DEFINER` with a fixed `search_path` (the pattern already used by the pre-auth
   helpers in `0004`), so the invariant is a table-level assertion again while `ia_app`
   still cannot read another user's row. The table keeps FORCE ROW LEVEL SECURITY.
2. **Parameterised contract paths were unreachable.** Paths come from the registry in the
   OpenAPI style (`/users/{id}`) and were registered verbatim, so Fastify served a
   *literal* `{id}` segment: `/api/v1/users/<uuid>` answered 404 for six endpoints
   (`AUTH-06.revoke`, `USR-03..05`). `fastifyPath()` translates `{name}` → `:name`;
   parameters are still validated against the contract's own schema afterwards.
3. **Owner reads ran without an RLS context.** `USR-01`/`USR-03` read `users` through the
   bare pool, where `app.app_role()` is empty, so the identity policies matched nothing:
   the list came back empty and a lookup answered 404 — a wrong answer, not an error.
   Reads now run through `asViewer(viewer, …)`, added to `src/http/context.ts` with the
   reason written down, and `owner-surface.test.ts` asserts the non-empty list so the
   silent-empty failure cannot return.

Also in this change: `SET-01`/`SET-02` (read + update) implemented in `src/routes/settings.ts`
— partial updates merged against the stored row and validated as a whole (`fixed_month_day`
needs its date; `fixed_day_of_month` needs monthly billing and a day 1..28), every write
audited with before/after, reads and writes inside the owner's transaction. `entityId` is
`null` for these rows because `audit_logs.entity_id` is a uuid and the settings row is
`id = 1`; the change itself is in the before/after pair.

## Failed attempts

- **The first two diagnoses were wrong, and the logs said so.** A probe that wrote to
  `ia_dev` while the API read `ia_test` proved nothing; both URLs had to be rewritten to
  the test database before the real exception appeared. Lesson kept in the docs: an
  inconclusive probe is not evidence.
- **`DEBUG_TESTS=1` alone does not turn logging on under Vitest** — the `integration`
  project sets `LOG_LEVEL=silent`, which wins over the app's own level. Diagnosing the two
  500s in the settings endpoints needed the app driven *outside* Vitest
  (`scripts/probe-*.ts`, `LOG_LEVEL=info`), which showed `invalid input syntax for type
  uuid: "1"` from `audit_logs.entity_id`. Those throwaway probes have been deleted; the
  `DEBUG_TESTS=1` hook in `src/app.ts` is the keepable part.
- **One `tsc` error was in the test file, not the source** (`payload[last]` possibly
  undefined under `noUncheckedIndexedAccess`); fixed by narrowing the index instead of
  widening the type.

## Remaining work, measured before handover

| Fact | Value | How it was checked |
|---|---|---|
| Contract endpoints served | **23 of 134** | `scripts/progress-report.ts` |
| Acceptance T-IDs named by the suite | **7 of 118** (`T-AUTH-01/02/07`, `T-DB-RLS-01/03`, `T-SEC-03`, `T-SEC-07`) | `grep -ohE 'T-[A-Z]{2,4}(-[A-Z]+)?-[0-9]+' backend/tests/**/*.ts` vs the catalogue |
| CI configuration | **none** — no `.github/`, no workflow file | `ls .github` + a find for workflow files |
| Queue/worker/scheduler, PDF generation, storage adapter, OpenWA adapter | **none exist** (only `src/messaging/mock.ts` + the provider port) | `find backend/src backend/scripts -type f` |
| Untested weight in the catalogue | T-FIN 27 · T-UI 24 · T-ATT 18 · T-MSG 17 · T-FIL 17 | per-area count over `TESTING_AND_ACCEPTANCE.md` |
| Leftover scripts in `backend/scripts/` | `diag.ts`, `diag2.ts`, `smoke-zod.ts`, `probe-encoding.ts`, `probe-totp.ts` | the same listing; none is wired to an npm script |

**Cost estimate, revised after this session measured the pace:** ~40–55 agent-hours for the
M3–M8 endpoints (each with its migration, RLS and layer tests) plus 6–10 hours for M9/M10 —
6–8 working days of continuous work for everything that does not need owner input. The
afternoon's earlier estimate of 7–9 hours was an extrapolation from endpoint count alone and
is wrong: roughly half of this session went on diagnosing three latent database-layer
defects, which is the shape of this codebase and must be budgeted for.

## Next steps

1. **M3 (31 endpoints, the largest slice):** players, guardians, groups, fees,
   coach-availability and CSV import — new tables plus their RLS policies, in migration
   `0007+`, following `DATABASE.md` §3 and `BEHAVIOUR` sections the contract cites.
   `scripts/progress-report.ts` lists every missing operation id per milestone.
2. **Start the server once against `ia_dev`** (`npm run dev`) and confirm
   `assertRuntimeRoleIsUnprivileged()` passes and `/ready` answers 200 — the one M2 claim
   with no evidence yet.
3. **Keep the three fixed defects honest:** each has a named regression test
   (`rls.test.ts` "0006", `route-matrix.test.ts` 401/403 matrix,
   `owner-surface.test.ts` USR-01 non-empty list). Re-run them before claiming M2 again.
4. **Milestone order, unblocked milestones first:** M3 → M4 → M8 → M5 (billing core) →
   M6 (with spike P1) → M7. That ordering matters because M7 cannot start honestly without
   spike S1 (a VPS and a dedicated WhatsApp number) and its values O18–O22 recorded in
   OPENWA_INTEGRATION §2 first.
5. **Blocked on people, not code — leave these to the owner/Hassen rather than starting
   them:** the T-UI-10 real-phone pass (M9 and every new mobile surface), M10's production
   access, deployment and restore test, and the open decisions **CR-003** (*Proposed*),
   **OPEN-001** (logo), **OPEN-023/024/025** (bank, scanned PDFs, the "send the PDF"
   request). The eight contract gaps in this document's §4 are still unanswered and each one
   is currently handled by a documented local decision instead of a contract change.
