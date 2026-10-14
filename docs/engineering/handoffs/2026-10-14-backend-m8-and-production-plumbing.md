# Backend M8 complete (6/6) + the production plumbing M7 and M10 both need

> **Date:** 2026-10-14 · **Author:** Freebuff (backend) · **Milestones:** M8 (dashboards, reports,
> audit, system health) and the worker/scheduler/storage/CI work named in `handoff.md` §11 B
> **Status:** complete, suite green. **Start here if you are the next session.** Previous
> milestone: [M6 complete](2026-10-14-backend-m6-complete.md).

## 1. Result

**M8 is 6/6 endpoints served. Overall `TOTAL: 114/135`** (was 109/135). The backend suite is
**240 passed / 240** in 25 files (was 177), `tsc` clean, OpenAPI valid (135 operations, 3
pre-existing warnings), both documentation scripts pass.

The 46 uncommitted paths from the previous session are now **committed as nine atomic commits**
(§5), and the three things §11 B called "not built" are built: the worker, the storage adapter and
CI.

| Endpoint | What it does now |
|---|---|
| `AUD-01` | Lists the audit trail, newest first, with `actorUserId`/`entityType`/`entityId`/`action` (contains)/`from`/`to`/`q` filters. Every row is listed, **including rows with no entity and no actor** (a login, a CLI run, a scheduler-triggered billing run) — an audit trail with holes is not an audit trail. |
| `SYS-03` | The operator's page. `db` (a real `select 1`), `storage` (which driver, and whether it is usable), `openwa` and `queue` (**`unknown` with the reason** — M7 is unbuilt), `scheduler` (the newest `job_runs` row or heartbeat, whether it is older than `WORKER_STALE_MINUTES`, the failing jobs and the stuck runs), `lastBackup`, `version`. |
| `RPT-01` | Eight reports (`players`, `attendance-summary`, `attendance-detail`, `invoices`, `payments`, `outstanding`, `collections`, `coach-attendance`) over real SQL, with the column metadata, whole-result totals, paging and a per-report sort allow-list (`INVALID_SORT`). |
| `RPT-02` | The same result as CSV: UTF-8 BOM, CRLF, `Content-Disposition`, a 50 000-row cap, formula-injection neutralisation for all six leading characters, **no totals row**, and an audit row naming the filters used. |
| `DSH-01` | The owner dashboard: register + `byGroup`, `coachTime` (closed records only for today/week; open > 12 h counted separately), today's and the next seven days' sessions with an attendance summary, the money block, the messaging block and a computed alert strip. **`invoicedMinor` and `collectedMinor` are separate fields and are never summed.** |

### New plumbing (§11 B)

| Piece | What exists now |
|---|---|
| Worker + scheduler | `src/worker/index.ts` (a tick loop, `--once`, graceful SIGTERM shutdown), `src/worker/db.ts` (the migrator pool, a per-job advisory lock, the academy clock) and `src/worker/jobs.ts` (the jobs below). `npm run worker`, `npm run worker:once`. |
| Jobs | `billing.scheduler` (02:00, issues through BIL-02's own engine, `run_key = scheduler:<date>`), `sessions.generate` (03:00, the next 14 days), `files.pdf_sweeper` (**every 30 s — the job FILES_AND_PDF §4 describes and nothing implemented**), `ops.stuck_jobs` (15 min), `files.orphan_sweeper`, `ops.invariant_nightly` (04:00, invoices + allocations + the **audit hash chain**, then records an `audit_anchors` row), `ops.retention_purge` (04:30), `ops.logical_backup` (01:00, `pg_dump` when `BACKUP_DIR` is set) and `worker.heartbeat` (60 s). The three M7 jobs are **registered** with a `notBuilt` reason (`jobs=11` = 8 built + 3 not) and are recorded `skipped` with that reason once their 08:30 window arrives. **That recording path has not been observed**: every tick so far ran before 08:30 academy-local time, so it is code-read rather than measured (§2). |
| Idempotency | `job_runs` + a partial unique index on `(job, run_key)`; `claimJobRun` is one `insert … on conflict … where status <> 'ok'`. A daily job therefore cannot run twice, and a job missed while the worker was down runs on the next tick. |
| Storage adapter | `src/files/storage.ts` is now a port with two drivers: `local` (unchanged behaviour, the default) and `s3` (`src/files/storage-s3.ts`, hand-rolled SigV4 over `node:crypto` + `fetch`, path-style or virtual-host, optional prefix). `STORAGE_DRIVER=s3` without its five variables is a **startup failure** (`assertStorageUsable`), never a silent fall back to a directory nobody backs up. |
| Retention/purge | Operational rows only (expired idempotency keys, expired/revoked invoice links, old `job_runs`). **Financial rows and proofs are reported as "eligible but not purged"**, because deleting them needs the owner's written decision (OPEN-009). |
| Invariants | Nightly: invoice totals = Σ items, balance = total − paid, no allocations on a void invoice, paid-but-not-allocated, the audit chain recomputed row by row, plus orphan counts. Any error marks the run `failed`, which is the release procedure's own rollback trigger. |
| Dockerfile | `backend/Dockerfile` — one image, two entrypoints (`APP_ENTRY`, default `dist/src/server.js`; worker `dist/src/worker/index.js`), non-root, no secrets baked in, a `/health` `HEALTHCHECK`. |
| CI | `.github/workflows/ci.yml` — typecheck, build, `openapi`, `openapi:lint`, the **full** unit+db+integration suite against a real PostgreSQL on 55432 (the project's own `db.ts` path, no service container), and the two documentation tools in a second job. **Release gate item 1 is now reachable**; it has not yet been *observed* green, because this repository has no remote/runner (§6). |

## 2. Evidence (2026-10-14, after the last edit to source)

| Check | Result |
|---|---|
| `npx tsc --noEmit` | exit 0 |
| `npx vitest run` | exit **0** — **240 passed / 240**, 25 files (unit 101, db 21, integration 118), **run twice** after the harness fix in §6.1 |
| `npx tsx scripts/progress-report.ts` | `m2 23/23 · m3 31/31 · m4 19/19 · m5 26/26 · m6 9/9 · m7 0/21 · m8 6/6`, **`TOTAL: 114/135`** |
| `npm run openapi` + `npx redocly lint ../api/openapi.yaml` | valid, 135 operations, 3 pre-existing warnings |
| `node tools/check-links.mjs` | exit 0 — 56 files / 399 links, 0 broken (includes this file) |
| `node tools/check-stale-refs.mts` (+ `--self-test`) | exit 0 · 22 assertions PASS |
| **The worker, run for real** | `npm run worker:once` against the local database, then `job_runs`/`worker_heartbeats` **read back out of it** rather than trusted from the log. One tick at `2026-10-13T23:58Z` (05:28 Asia/Colombo) left `billing.scheduler ok` `{created: 0, skipped: 0, note: "no player is billable yet"}`, `sessions.generate ok`, `files.orphan_sweeper ok`, `ops.invariant_nightly ok` `{invoicesChecked: 0, auditChainBroken: 0, arithmeticMismatches: 0}`, `ops.retention_purge ok` `{eligibleButNotPurged: {invoices: 0, proofs: 0}}`. A later tick at `00:37Z` recorded `ops.logical_backup skipped` (no `BACKUP_DIR`) and **re-claimed none of the five** — the `(job, run_key)` idempotency observed, not asserted. `worker_heartbeats` holds one row (`00:37:19Z`, `0.1.0-dev`). Startup reports `jobs=11 tick=15000ms`. Two mechanics are worth knowing when reading this evidence: an **interval** job (`files.pdf_sweeper`, `ops.stuck_jobs`) records **no row when it finds nothing**, so their absence is not evidence they did not run; and the three **not-built** M7 jobs (08:30) had not come due at either tick, so no `skipped` row for them exists yet. |
| Migrations | `0015_operations.sql` applied to both `ia_dev` and `ia_test` (`migrations up to date (15 applied)`); the file's sha256 still matches the checksum recorded in both, because `migrate.ts` **refuses a migration whose checksum changed after it was applied** — 0015 is history now, and its one cosmetic wart (the `pending_anchors` comment above the `audit_anchors` table) cannot be fixed in place. |

New coverage and what it actually proves:
- `tests/integration/audit-surface.test.ts` (8 tests) — includes a row whose `entity_id` is **NULL**,
  asserted with `Object.hasOwn` to be **absent** rather than `null` or `"null"`.
- `tests/integration/system-health-surface.test.ts` (6) — a worker that has never run reports
  `stale: true` with the epoch; a `job_runs` row makes it `stale: false`; a failing job is named;
  a failed backup reads `failed`, not the older success.
- `tests/integration/owner-dashboard-surface.test.ts` (6) — every block, the default range, an
  issued invoice in `invoicedMinor` with `collectedMinor === 0`, an open 13-hour shift counted as
  needing correction **and adding nothing to worked time**, the alert strip ordered by severity.
- `tests/integration/reports-surface.test.ts` (9) and `tests/unit/reports.test.ts` (11) — the CSV
  rules (BOM, CRLF, plain-decimal money, all six injection prefixes, no totals row) and the ordering
  rule (an absent cell sorts last **in either direction**).
- `tests/unit/s3-storage.test.ts` (23) — see §4.4 for exactly what is and is not proven.

## 3. Files

**New source** — `src/worker/index.ts`, `db.ts`, `jobs.ts`; `src/ops/job-runs.ts`;
`src/routes/audit.ts`, `owner-dashboard.ts`, `reports.ts`, `system-detail.ts`; `src/ops/reports.ts`;
`src/files/storage-s3.ts`; `migrations/0015_operations.sql`.

**New tests** — the six files named in §2.

**Modified** — `src/files/storage.ts` (the port), `src/config.ts` (storage + worker blocks),
`src/routes/index.ts` (five registrations), `src/routes/billing-engine.ts` and `src/routes/pdf-service.ts`
(`userId: string | null` so a scheduler run is attributed to nobody rather than to a person),
`src/ops/job-runs.ts`, `spec/components.ts` (§4), `backend/package.json` (`start` was wrong — see
§4.5 — plus worker scripts), `backend/.env.example`, `docs/architecture/DEPLOYMENT_AND_OPERATIONS.md`
(additive "Implemented as" notes), `api/openapi.yaml`/`.json` (regenerated), `.github/workflows/ci.yml`,
`backend/Dockerfile`, `backend/.dockerignore`, `backend/vitest.config.ts` (the project-serialisation
fix in §6.1).

## 4. Decisions and contract changes worth reading

1. **`AuditEntry.entityId` is now optional** (contract change, flagged as PUB-02 was). The
   database column is nullable and correctly so; the contract was the wrong side. AUD-01 omits the
   key rather than sending `null`.
2. **`SystemHealth.scheduler` gained optional `stale` and `detail`; `lastBackup` gained optional
   `detail`.** The shape could not express "no worker has ever run" or "the last backup was
   skipped". `lastRunAt` stays required and answers the epoch with `stale: true` when there is no
   evidence at all, rather than inventing a recent time or dropping a required field.
3. **`ROW_LIMIT_EXCEEDED` is a frontend-only code.** The mock refuses an oversized export with it
   (413); it is **not** in `spec/registry.ts`. RPT-02 uses `422 VALIDATION_ERROR` with a detail
   telling the caller to narrow the filters — an existing code, used honestly. Adding the code to
   the catalogue is Claude's call.
4. **The S3 driver is written but not interoperable-verified.** Its unit test asserts the crypto
   primitives against **published** vectors (SHA-256 of the empty payload, NIST SHA-256, RFC 4231
   HMAC) and cross-checks the signature against a second SigV4 implementation written from the
   specification — it does **not** assert the AWS `AKIDEXAMPLE` end-to-end vector, so a self-consistent
   signature is all that is proven. **The first `STORAGE_DRIVER=s3` write must be confirmed against
   MinIO or R2 before proofs are trusted to it.**
5. **`package.json`'s `start` was `node dist/server.js`, which cannot work**: `tsconfig.build.json`
   has `rootDir: "."` and includes `src/`, `spec/` and `scripts/`, so the emitted entrypoint is
   `dist/src/server.js`. Fixed, and `start:worker` added. (The deploy doc's `npm start` instruction
   should be read as the corrected script.)
6. **The daily billing scheduler runs the billing engine, not a copy of it.** It issues through
   `buildPreview` + `issueRun` with `triggeredBy: "scheduler"` and `userId: null`. No OpenWA or
   messaging behaviour is involved, so this does not touch the M7 block.
7. **`invoiced ≠ collected` stays structural** in the dashboard and in the `collections` report:
   separate columns, separate sums, and a test that asserts `collectedMinor` is 0 with no confirmed
   payments.
8. **The orphan sweeper reports, never deletes.** A file row is evidence of what was submitted;
   pruning it on a schedule is how an audit loses its exhibits.

## 5. The commits (46 paths, nine atomic commits)

`Ignore generated runtime storage under backend/var` → `Backend DB layer: migrations 0001-0014 …` →
`Backend platform: config, HTTP pipeline, RLS pool, auth, sessions and audit` → `Backend API surface:
M2-M6 endpoints, the contract registry and generated OpenAPI` → `Invoice tools: the message generator
and the read-only invoice checker` → `Operator CLIs: owner provisioning, TOTP probes, progress report
and spikes` → `Backend test suites: unit, database-layer and HTTP integration` → `Project records:
milestone handoffs, status, decisions and the owner asks` → `Repo tooling: link and stale-reference
checkers, frontend ignore rules`.

**Two things were deliberately left out of the commits:**

- **`backend/var/`** (164 generated objects — rendered PDFs, uploaded logos, CLI logs). Now
  gitignored; it is runtime state, not source.
- **`Receipt.pdf` / `anotherrecipt.pdf`** stay untracked. They are real bank receipts and moving them
  into git is a privacy decision the owner has not answered (NEEDS_FROM_OWNER §1 item 3).

## 6. Failed attempts (so they are not repeated)

### 6.1 The suite was flaky, and the harness was the cause

The first full run this session failed **23 tests in 6 files**, every one of them a login
answering `500 INTERNAL_ERROR`; two later runs passed 240/240. Chasing it down: `vitest.config.ts`
defines **three projects against the same `ia_test` and vitest runs projects in parallel**, so the
`db` project's `resetData()` — an `ACCESS EXCLUSIVE` `truncate` across twenty-odd tables — met the
`integration` project's live API traffic. The isolated `db` run then failed with the smoking gun:
`error: deadlock detected` raised out of that `truncate`, and an isolated `integration` run (started
while a `db` run was going) failed 13 tests the same way. The window only widens as integration
files are added, which is why four new integration files surfaced it.

Fix: root-level `maxWorkers: 1` in `vitest.config.ts` (with the reason written down), so exactly one
project touches the database at a time. `fileParallelism: false` was already set per project but that
only orders files *within* a project — worth remembering before adding a fourth project. Two
consecutive full runs are green, and the serialised run is **faster** (254 s vs 278 s).

- **`FILES_DIR` read at call time, not at import.** Moving the storage root into `config` (evaluated
  once at module load) broke `money-surface.test.ts`, which sets `FILES_DIR` to a scratch directory
  after the module graph is loaded. Two PRF-04 tests failed with `PARSE_FAILED` because the object was
  unreadable. `storage.ts` now reads the driver and the directory from the environment **at call
  time**, falling back to the captured config. This was also the most useful thing the suite did
  today: it caught a real behaviour change, not a test problem.
- **`union all` with an unparenthesised `order by … limit`** in the PDF sweeper — a syntax error at
  the `union`, found by running the worker for real (`files.pdf_sweeper FAILED: syntax error at or
  near "union"`). Each branch is now parenthesised.
- **`process.argv[1].endsWith("worker/index.ts")` never matched on Windows** (backslash paths), so
  the worker's first `--once` run printed nothing and exited 0 having done nothing at all. The guard
  now compares `pathToFileURL(process.argv[1]).href` with `import.meta.url`. *An `--once` run that
  produces no output is a failed run, not a quiet one.*
- **`app.check_invoice_totals` is a deferred constraint trigger**, so a fixture that inserts an
  invoice and then its line as two autocommitted statements is refused at the invoice's own commit
  (`totals do not match its lines`). The owner-dashboard fixture now wraps the whole thing in one
  transaction; the reports fixture already did.
- **Three unit assertions disagreed with the implementation and the implementation was right twice
  and wrong once.** `csvCell` neutralises *then* quotes (so `=cmd` becomes `'=cmd`, not `"'=cmd"`) —
  assertion fixed; `sortRows` put empty cells **first** when descending — implementation fixed, since
  "absent last in either direction" is what both the mock and the test's own comment say; and
  `s3StatusDetail` named only the first missing variable — implementation now names **all** of them,
  which is what an operator wants from one restart.
- A "skipped" job recorded `ok` (the backup with no `BACKUP_DIR`), which would have let SYS-03 show a
  green backup on a deployment that has never written one. `JobResult.status` now overrides the
  recorded status, and `readBackupHealth` maps `skipped` to `unknown`.

## 7. Deliberately not done (recorded, not hidden)

- **Nothing in M7.** O18–O22 are still `VERIFY` in OPENWA_INTEGRATION §2 and no dedicated number has
  arrived, so no messaging code exists — including a `message_jobs`-backed queue count for SYS-03 and
  DSH-01's `messaging` block, which report honestly (`unknown`, and 0 failures out of 0 jobs).
- **The `OPEN-018` "bank transfer only" default is still not applied** (unchanged from M6 §5).
- **No performance measurement** (M9's 5k invoices / 20k attendance rows < 300 ms p95).
- **The invariant job's anchor row is a local record, not an upload.** `AUDIT_ANCHOR_BUCKET` /
  `_PREFIX` (DEPLOYMENT §4) are still unused: the nightly job verifies the chain and stores the head
  hash in `audit_anchors`, and nothing ships it off-host yet.
- **No maintenance flag**, which the documented rollback path (b) needs.
- **`SYS-03` does not yet surface the invoice-health findings.** `check:invoices` runs in the
  invariant job; showing the same findings on the operator's page needs a field the `SystemHealth`
  component does not have (see §4.2 for the precedent for adding one).
- **`docs/engineering/RESTORE_LOG.md` still does not exist**, and the backup job proves a dump was
  written, not that it is restorable.

## 8. Next steps

1. **Confirm the S3 driver against a real bucket** (MinIO locally is enough) before anything is
   deployed with `STORAGE_DRIVER=s3`. This is the one new artefact with an unverified boundary.
2. **Watch CI once.** The workflow has never run — there is no remote. The first push is the test.
3. **M7, the moment §5.1 arrives:** spike S1 first, then `message_jobs`, and surface its counts in
   SYS-03 and DSH-01 (the two places already written to say "unknown").
4. **M9:** performance sanity, security review gate, accessibility, the real-device pass.
5. **Claude:** bless or rename `PUB-02` (still open from M6), bless the two `SystemHealth` additions
   and the optional `AuditEntry.entityId`, and decide on `ROW_LIMIT_EXCEEDED`.
