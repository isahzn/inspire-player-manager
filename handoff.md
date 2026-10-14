# handoff.md — read this one first

> **Updated:** 2026-10-14 (second backend session of the day: the S3 boundary proved against a real
> server, the audit anchor uploaded off-host, and the audit hash chain repaired) · **Owner granted
> standing permission** (§6) — ordinary development, local infrastructure and commits need no further
> approval.
>
> This file is the whole picture: what works, what is broken, what only a person can supply, and the
> exact next actions. The milestone records live in
> [`docs/engineering/handoffs/`](docs/engineering/handoffs/) — the newest is
> `2026-10-14-audit-chain-and-anchor.md` (the S3 interop proof, the anchor upload, and the audit
> chain fix), after `2026-10-14-backend-m8-and-production-plumbing.md` (M8 + the worker/storage/CI
> work).
> Nothing here is invented: every number below was measured in this session, and where something is
> only code-read rather than observed, it says so.

---

## 1. Goal

Four things, in this order, with the fourth deliberately not started:

1. Commit the **46 uncommitted paths** (the entire M2–M6 backend and the invoice tools) as clean
   atomic commits.
2. Build **M8's five remaining endpoints**: `DSH-01`, `RPT-01`, `RPT-02`, `AUD-01`, `SYS-03`.
3. Build the **production plumbing M7 and M10 both need**: a worker process with the scheduled jobs,
   a real storage adapter, the nightly invariant job, retention/purge, a `Dockerfile`, and CI.
4. **Not** write anything against guessed OpenWA behaviour — M7 is blocked on a phone number (§5.1).

## 2. Current state — measured, not assumed

| Check | Result |
|---|---|
| `npx tsc --noEmit` | **exit 0** |
| `npx vitest run` (all three projects) | **260 passed / 260, exit 0** — 27 files (unit 117, db 25, integration 118). The 20 new tests are the anchor's and the audit chain's (§3) |
| `npx tsx scripts/migrate.ts` | 16 migrations applied, exit 0 (`0016` is the chain repair) |
| `npm run storage:probe` (`-- --anchor` too) | **9/9 PASS, exit 0** against a real S3 server (`rclone serve s3`), including the negative: a wrong-secret signature is rejected `403`, an unsigned request `400` |
| `npx tsx scripts/progress-report.ts` | **114 / 135 endpoints** |
| `npm run openapi` + `npx redocly lint ../api/openapi.yaml` | valid, **135 operations**, 3 pre-existing warnings |
| `node tools/check-links.mjs` | exit 0 — 56 files / 399 links, 0 broken |
| `node tools/check-stale-refs.mts` | exit 0 — no stale provider references |
| Commits | **11 atomic commits** for M2–M8 (the 46 paths and the M8 work both committed); the working tree holds no source changes, and the two sample receipts stay untracked on purpose (§5.3) |
| The worker, run for real | `npm run worker:once` exit 0, then `job_runs`/`worker_heartbeats` **read back out of the database**: five daily jobs `ok`, `ops.logical_backup skipped` (no `BACKUP_DIR`), and **nothing re-claimed that had already succeeded** — the `(job, run_key)` idempotency observed, not asserted |
| The nightly invariant job, run for real on a chain with the anchor configured | **`ops.invariant_nightly ok`**, 3 audit rows checked, `auditChainBroken: 0`, `anchorStatus: uploaded` — and the uploaded object's `headHash` **equals** the chain head read back from the database (§3) |

Endpoint progress: **M2 23/23 · M3 31/31 · M4 19/19 · M5 26/26 · M6 9/9 · M7 0/21 · M8 6/6.**

Nothing is deployed; CI now exists and has **never run** (§11, gate item 1).

## 3. What works, what is broken, what needs fixing

### Works, with evidence

- **Money end to end** (M5, 26/26) — invoices, allocations, confirmations, reversals, receipts, and
  the rule that matters most: **a proof is evidence, never payment**; nothing auto-confirms.
- **Documents** (M6, 9/9) — `INV-06/07` and `RCT-02` build, store and stream PDFs; `PUB-01` serves a
  guardian's capability link with one uniform 404; `PRF-01/02` upload and stream proofs with EXIF
  stripped and PDFs screened for active content.
- **The audit chain is a chain again, and it now leaves the building** (new). Migration `0016`
  makes the chain trigger read the whole table (`SECURITY DEFINER` as `ia_migrator`) — before it,
  only owners could see `audit_logs`, so **every coach write and every failed login started a new
  chain** and the nightly job reported a broken hash — and repairs the fragments the old reader
  produced. `record()` additionally takes the chain's advisory lock before its insert, so two
  overlapping writes cannot fork it. The **anchor now uploads** to `AUDIT_ANCHOR_BUCKET`: one
  immutable canonical-JSON object per verification, which is what makes it a witness the database's
  operator cannot revise. Unconfigured is reported as `not_configured`; a configured bucket that
  refuses the upload fails the run.
- **The dashboard, reports, audit trail and system page** (M8, 6/6). `DSH-01` answers every block with
  **`invoicedMinor` and `collectedMinor` as separate fields that are never summed**; `RPT-01` serves
  eight reports over real SQL with a per-report sort allow-list, and `RPT-02` exports the same rows
  as CSV (BOM, CRLF, formula-injection neutralised, a 50 000-row cap, and an audit row naming the
  filters). `AUD-01` lists the trail including rows with **no** entity or actor — an audit trail with
  holes is not an audit trail. `SYS-03` reports `db` (a real `select 1`), `storage`, `scheduler` and
  `lastBackup`, and answers `unknown` **with the reason** for the two things M7 owns.
- **A worker process with the scheduled jobs** (new). `npm run worker` / `worker:once`, one tick every
  15 s, a per-job advisory lock so two containers cannot double-run a job, and `job_runs` as the
  evidence — which is what `SYS-03` reads. The **daily billing scheduler** issues invoices through
  BIL-02's own engine, so invoices no longer exist only when a person clicks a run. The
  **`files.pdf_sweeper`** is the job `FILES_AND_PDF` §4 describes and nothing implemented.
- **A storage adapter** (new). `src/files/storage.ts` is a port with a `local` driver (unchanged
  default) and an `s3` driver; `STORAGE_DRIVER=s3` without its variables is a **startup failure**,
  never a silent fall back to a directory nobody backs up.
- **A nightly invariant job, retention/purge, a `Dockerfile` and CI** (new). The invariant job checks
  totals = Σ items, balance, allocations on void invoices, paid-but-unallocated, and **recomputes the
  audit hash chain**; a failure marks the run `failed`, which is the release procedure's own rollback
  trigger. Purge touches **operational rows only** — financial rows and proofs are reported as
  "eligible but not purged" because deleting them needs the owner's written decision (OPEN-009).
- **The invoice message generator and the read-only invoice checker** (previous session, still true).

### Broken, missing, or fragile — honestly

1. **M7 messaging is 0/21 and cannot start without a phone number** (§5.1). No messaging code has been
   written against guessed provider behaviour, deliberately. The three M7 jobs are **registered** in
   the worker and are recorded `skipped` with the reason once their 08:30 window arrives — that
   recording path is code-read, **not observed**, because every tick so far ran before 08:30 local.
2. **The S3 driver has now spoken to a real S3 server, but not to a production bucket.**
   `npm run storage:probe` against `rclone serve s3` in path-style passed 9/9, including the negative
   that a forged signature is refused (`403`). What is still unexercised: **virtual-host addressing**
   and any actual provider (R2/S3/Supabase). **Run the probe against the real bucket before any
   deployment trusts proofs to it** — it is on the go-live checklist (DEPLOYMENT §9).
3. **CI has never run.** There is no remote and no runner, so `.github/workflows/ci.yml` is a written
   workflow, not a green one. The first push is its first test.
4. **The suite was flaky, and it was the harness.** Diagnosed and fixed this session (§9); two
   consecutive full runs are green since. Worth knowing because the failure mode looked like product
   breakage: logins answering 500 and `deadlock detected` out of `truncate`.
5. **`OPEN-018` "bank transfer only" is recorded but NOT applied.** The seed still lists `cash` as
   active. Half-applying it would leave the product claiming a default it does not have.
6. **Contract text still disagrees with the shipped code in places** — the list is
   [`NEEDS_FROM_OWNER.md`](NEEDS_FROM_OWNER.md) §3, including the additions this project made
   (`PUB-02` still wants a blessing, and this session added an optional `AuditEntry.entityId` and two
   optional `SystemHealth` fields — each flagged in the M8 handoff §4).
7. **Nothing is deployed, no performance measurement exists and `docs/engineering/RESTORE_LOG.md`
   does not exist.** The audit anchor now *is* uploaded (§3), which removes the last item from this
   list that code could close. Stated so none of the rest is mistaken for done.
8. **Virtual-host S3 addressing has never been exercised**, and no production provider (R2/S3/
   Supabase) has been spoken to — only a local `rclone serve s3` by path. `npm run storage:probe`
   against the real bucket is the check, and it is on the go-live checklist (DEPLOYMENT §9).

## 4. The money question, answered (this is the plain-language answer)

> "When the time to pay comes, do they send a PDF? What is 'pay your fees'?"

**"Pay your fees" is an invoice, and the invoice is the message.** The guardian receives this (real
output, from a live invoice):

```
Hello Nimal Perera, this is Inspire Academy. Invoice INV-2026-000001 for Kasun Perera is ready.
Amount due: LKR 4,000.00 · Due: 08 Nov 2026
View/download: https://<host>/api/v1/public/invoices/<token>/pdf
Reply STOP to stop these messages.
```

Then, in order:

1. **Invoice out** — the message above. Number, amount, due date, and a link that works with no login
   and dies when the invoice is voided or the token expires (30 days by default).
2. **They transfer** the amount by bank transfer, quoting the invoice number as the reference.
3. **They send back the bank's PDF e-receipt.** *This is the PDF that gets sent* — the **bank's
   receipt**, not the invoice. A screenshot or photo is supporting evidence only and can never pass a
   check.
4. **The machine reads it** (`PRF-04`): amount, reference, date within a day, payer name, whether it
   goes to the academy's own account, and whether that receipt is already attached to another
   payment. Findings are **advice**.
5. **The owner confirms** (`PAY-04`). Only then does money move and a receipt get issued.

The bank details that print on the invoice come from the payment-instructions block, which is still
empty — that is owner item 2 in §5.

## 5. What only a person can supply (this is the blocker list)

Nothing here is a coding task. Every row has a safe default that is **already built**, so a developer
can run the whole system today without any of it.

1. **A phone number for a local OpenWA instance** — *the block*. Everything in M7 (21 endpoints) waits
   on it. A spare/second phone is enough to start; the VPS and production number are only needed
   before live verification.
2. **The academy's real details**: logo file, legal name, address, phone (`OPEN-001`), the real fee per
   group, and the **bank payment-instructions text** that prints on every invoice (`OPEN-018`).
3. **The two sample bank receipts** — confirm `Receipt.pdf` / `anotherrecipt.pdf` are the right two and
   which bank each is, and whether they may move into `backend/tests/fixtures/receipts/`. They are
   **deliberately still untracked** so they cannot enter the repository by accident.
4. **The domain** the guardian's invoice link will live on (`OPEN-017`).
5. **Sinhala/Tamil on documents?** (`OPEN-013`). Spike P1 answered it: PDFKit is deterministic and
   English is perfect, but it has **no complex-script shaping**, so supporting them means the whole
   pipeline becomes HTML → headless Chromium. Default today: English-only, names transliterated at
   best.
6. **CR-003 approval in writing** — the coach clock-in dashboard block, the per-automation switches
   and "mobile is a shipping requirement" are built while `ADR-019` is still *Proposed*. Automations
   ship **off by default** until it is confirmed.
7. Smaller release-gate items (retention periods, mandatory TOTP, the storage bucket decision
   `OPEN-016`) — details in [`NEEDS_FROM_OWNER.md`](NEEDS_FROM_OWNER.md) §1.
8. **A CI runner** — a remote to push to (or a self-hosted runner). Without it, gate item 1 stays
   unobservable no matter how good the workflow file is.

## 6. Standing permission — recorded at the owner's instruction

The owner said, in the previous session: *"you have permission for everything. Whatever needs to be
done, you have permission."* Recorded as:

- **Granted:** read/write anywhere in this project; running local infrastructure (the local PostgreSQL
  on port 55432, migrations, seeds); creating, editing and deleting my own files and tests; running
  the full test suite; **committing** the work.
- **Still asked first, because permission cannot make them safe:** anything irreversible or
  outward-facing — `git push`, deploying, sending real WhatsApp messages, or touching real money data.
  Not a refusal; a flag.
- **Permission cannot supply a physical resource.** A phone number, the bank details, the logo, the
  domain and a CI runner are things only a person can hand over (§5). No amount of permission
  substitutes for them, which is why §5 exists.

## 7. Active files

**Second session of 2026-10-14** — new: `backend/src/ops/audit-anchor.ts`,
`backend/scripts/storage-probe.ts`, `backend/migrations/0016_audit_chain_reader.sql`,
`backend/tests/unit/audit-anchor.test.ts`, `backend/tests/db/audit-chain.test.ts`,
[the session handoff](docs/engineering/handoffs/2026-10-14-audit-chain-and-anchor.md). Modified:
`backend/src/files/storage-s3.ts` (a second bucket's config; the interop result replaces its "NOT
VERIFIED" header), `backend/src/audit.ts` (the chain lock), `backend/src/worker/jobs.ts` (the anchor
upload), `backend/package.json`, `backend/.env.example`,
`docs/architecture/DEPLOYMENT_AND_OPERATIONS.md`, `docs/engineering/PROJECT_STATUS.md`, this file.

**First session of 2026-10-14** — new source: `backend/src/worker/{index,db,jobs}.ts`; `backend/src/ops/job-runs.ts`;
`backend/src/routes/{audit,owner-dashboard,reports,system-detail}.ts`; `backend/src/ops/reports.ts`;
`backend/src/files/storage-s3.ts`; `backend/migrations/0015_operations.sql`.

**New tests** — `backend/tests/integration/{audit-surface,owner-dashboard-surface,reports-surface,system-health-surface}.test.ts`;
`backend/tests/unit/{reports,s3-storage}.test.ts`.

**New deploy artefacts** — `backend/Dockerfile`, `backend/.dockerignore`, `.github/workflows/ci.yml`.

**Modified** — `backend/src/files/storage.ts` (the port), `backend/src/config.ts` (storage + worker
blocks), `backend/src/routes/index.ts` (five registrations), `backend/src/routes/billing-engine.ts`
and `pdf-service.ts` (`userId: string | null`, so a scheduler run is attributed to nobody rather than
to a person), `backend/spec/components.ts`, `backend/package.json` (`start` was wrong — see §9 — plus
the worker scripts), `backend/vitest.config.ts` (§9), `backend/.env.example`,
`api/openapi.yaml`/`.json`, `docs/architecture/DEPLOYMENT_AND_OPERATIONS.md` (additive "Implemented
as" notes), and this file.

## 8. Changes made

The five M8 endpoints and the plumbing, in the detail a reviewer needs — endpoint-by-endpoint
evidence, the four contract decisions, and the commit list — is in
[the M8 handoff](docs/engineering/handoffs/2026-10-14-backend-m8-and-production-plumbing.md). Read
that when you need the specifics; this file keeps the shape.

The four things worth carrying in your head:

- **`invoiced ≠ collected` is structural**, in the dashboard and in the `collections` report.
- **A daily job is idempotent because the database says so** — a partial unique index on
  `(job, run_key)` — not because the worker remembers. A job missed while the worker was down runs on
  the next tick, and one that already succeeded cannot run twice.
- **A skipped job records `skipped`, not `ok`.** A backup that never ran must not read as healthy.
- **The orphan sweeper reports, never deletes.** A file row is evidence of what was submitted.

## 9. Failed attempts (so they are not repeated)

- **The suite was flaky and the harness was the cause.** The first full run failed 23 tests across 6
  files, every one a login answering `500 INTERNAL_ERROR`; a later run passed 240/240. The isolated
  `db` project then produced the smoking gun: **`error: deadlock detected`** raised out of
  `resetData()`'s `truncate`. `vitest.config.ts` defines **three projects against the same `ia_test`
  and vitest runs projects in parallel** — the `db` project's `ACCESS EXCLUSIVE` truncate across
  twenty-odd tables meeting the `integration` project's live API traffic. Fix: root-level
  **`maxWorkers: 1`**. `fileParallelism: false` was already set per project, but that only orders
  files *within* a project. Two consecutive full runs are green since — and the serialised run is
  **faster** (254 s vs 278 s). *A red run is not automatically your change; a green run is not
  automatically reproducible.*
- **`FILES_DIR` must be read at call time, not at import.** Moving the storage root into `config`
  (evaluated once at module load) broke a test that sets `FILES_DIR` after the module graph is
  loaded: two PRF-04 tests failed with `PARSE_FAILED`. `storage.ts` now reads the driver and the
  directory from the environment at call time.
- **`union all` with an unparenthesised `order by … limit`** in the PDF sweeper — a syntax error at
  the `union`, found only by running the worker for real. Each branch is parenthesised now.
- **`process.argv[1].endsWith("worker/index.ts")` never matched on Windows**, so the first
  `--once` run printed nothing and exited 0 having done nothing at all. The guard now compares
  `pathToFileURL(process.argv[1]).href` with `import.meta.url`. *An `--once` run that produces no
  output is a failed run, not a quiet one.*
- **`package.json`'s `start` was `node dist/server.js`, which cannot work** — `tsconfig.build.json`
  includes `src/`, `spec/` and `scripts/`, so the emitted entrypoint is `dist/src/server.js`. Fixed,
  and `start:worker` added.
- **`app.check_invoice_totals` is a deferred constraint trigger**, so a fixture that inserts an
  invoice and then its line as two autocommitted statements is refused at the invoice's own commit.
  Fixtures wrap the pair in one transaction.
- **The `resetData()` truncate cannot free `academy_settings` or `files`** (deliberately: reference
  data), so a fixture storage key or a logo can leak between tests. Learned in the M6 session, still
  true.
- **Three unit assertions disagreed with the implementation and the implementation was right twice
  and wrong once:** `csvCell` neutralises *then* quotes; `sortRows` put empty cells **first** when
  descending (fixed in the implementation — "absent last in either direction" is what the mock and
  the test's own comment say); and `s3StatusDetail` named only the first missing variable (now names
  all of them).
- **A migration file cannot be edited once applied.** `migrate.ts` records a sha256 per migration and
  **refuses a changed file** ("Add a new migration instead of editing history"), so 0015's one
  cosmetic wart — a comment that says `pending_anchors` above the `audit_anchors` table — stays.
  The file's hash was verified against both `ia_test` and `ia_dev` after this session's edits.- **Inline `npx tsx -e "<script with top-level await>"` silently does nothing** — no error, no effect,
  so a probe appears to pass because it never ran. Write a real temporary `.mts` file, run it, delete it.
- **MinIO's community binaries are gone.** `dl.min.io` answers `410 Gone` ("the open-source MinIO
  Server … projects are archived and no longer maintained"). The M8 handoff's "confirm against MinIO
  or R2" is no longer actionable as written: use `rclone serve s3` locally, or the real bucket.
- **The forked audit chain was diagnosed late because two plausible theories came first.** The
  concurrency explanation was *real* — and fixable, and fixed — but it was not what produced the
  failure in the integration suite. What settled it was instrumenting the real path and reading the
  data: two login transactions, different xids, the second seeing `rowsInTable=0` on a table that had
  a committed row. That is impossible under concurrency alone, and it pointed straight at RLS (only
  owners may read `audit_logs`, and the trigger read as the writer). *A theory that explains the
  symptom is not a diagnosis until the data says so.*
- **A wedged local PostgreSQL cluster.** The suite's first run this session reported 240 tests
  **skipped**, not failed: the cluster's backend had died (`0xC0000142`), the postmaster reinitialised
  and then stopped answering — `npm run db:status` still said "running". `npm run db:down &&`
  `npm run db:up` cleared it and both databases were intact. If everything is skipped, suspect the
  database before the tests.
- **A test that passed for the wrong reason.** `tests/unit/audit-anchor.test.ts` cleared only the
  anchor's own variables, so the machine's `.env` supplied `STORAGE_*` and the "does not inherit the
  files bucket" assertion passed against a fallback it did not have. It now clears both sets. Also
  worth noting: the anchor's first implementation *did* inherit `STORAGE_BUCKET` — the corrected test
  failed and found it.## 10. Next steps, in order

1. **Push so CI runs once** (needs a remote, §5.8). The workflow has never executed and now covers
   260 tests.
2. **Run `npm run storage:probe` and `npm run storage:probe -- --anchor` against the real bucket**
   before anything is deployed into it, and decide the provider (`OPEN-016`). The driver's interop is
   proven against a local S3 server; virtual-host addressing is not, and no production provider has
   been spoken to.
3. **M7 the moment §5.1 arrives:** run spike S1 first, record its real values in `OPENWA_INTEGRATION`
   §2, then build `message_jobs` and the provider. The two endpoints already written to say `unknown`
   (`SYS-03`) and zero (`DSH-01`) are the places to surface its counts. Do not write against guessed
   OpenWA behaviour.
4. **M9:** performance sanity (5k invoices / 20k attendance rows < 300 ms p95 — never measured; the
   audited-write path is now serialised on one lock, so measure a write endpoint rather than assume),
   the security review gate, accessibility, the real-device pass, a bug bash on anonymised real data.
5. **The two small operational gaps left** — surface the invoice-health findings on `SYS-03` (needs
   one more optional field, precedent in the M8 handoff §4.2) and the maintenance flag the documented
   rollback path (b) needs. `AUDIT_ANCHOR_BUCKET` uploading is **done** (§3).
6. **Owner items** (§5) and **contract text** (§3 item 6) whenever they land; neither blocks
   development.

## 11. What actually stands between here and production

Grounded in this project's own gates —
[TESTING_AND_ACCEPTANCE](docs/engineering/TESTING_AND_ACCEPTANCE.md) §4 (10-item release gate),
[DEPLOYMENT_AND_OPERATIONS](docs/architecture/DEPLOYMENT_AND_OPERATIONS.md) §5–§9 (release procedure,
monitoring, backups, go-live checklist) and [IMPLEMENTATION_PLAN](docs/engineering/IMPLEMENTATION_PLAN.md)
M9–M10 — checked against what the code actually is today.

### A. The release gate, item by item

| # | Gate | State today |
|---|---|---|
| 1 | CI green on the release commit | **Reachable, not observed.** `.github/workflows/ci.yml` exists (typecheck, build, contract, the full suite against a real PostgreSQL, and the documentation tools) but there is no remote and no runner, so it has never executed. The suite is green *locally*: 260/260, exit 0 |
| 2 | E2E smoke on staging (login, register, attendance, clock in/out, billing run, payment + receipt, `PRF-04` queue, WhatsApp via mock, void) | **Not possible — nothing is deployed, there is no staging** |
| 3 | T-FIL-09 and T-MSG-02/03/06 pass | T-FIL-09 **passes**; **every T-MSG row is blocked** (M7 unbuilt) |
| 4 | OpenWA spike S1 (O18–O22) + T-MSG-12 on the real number | **Not started** — needs the number (§5.1) |
| 5 | Accessibility + real-device mobile checklist signed off | **Not done** — M9; needs the owner's phone |
| 6 | T-OPS-01 within 90 days + T-OPS-02 rehearsal | **Not done** — `docs/engineering/RESTORE_LOG.md` does not exist. The backup job now *writes* a dump when `BACKUP_DIR` is set, which proves a dump, **not a restore** |
| 7 | Security gate (`SECURITY_AND_PRIVACY` §7) | **Unverified** — no security review has been run as a gate |
| 8 | `openapi.yaml` matches the running server, frontend types generated from it, no drift | **Partly** — the contract is generated, valid (135 operations) and lint-clean; the additions this session flagged are still unblessed, and no generated frontend types exist |
| 9 | OPEN-001/002/009/018/019 resolved or accepted in writing | **OPEN-002 resolved**; 001, 009, 018, 019 still open. 018 is recorded but deliberately unapplied |
| 10 | Handover pack delivered; first owner created with TOTP | **Not done** — `create-owner` and TOTP exist; the pack and training do not |

### B. Production plumbing — what now exists, and what still does not

1. ~~No worker process and no scheduler~~ — **built.** `npm run worker` runs eight daily/interval jobs
   under a per-job advisory lock, including the daily billing scheduler and the PDF sweeper.
2. ~~Storage is a local directory~~ — **a port with a local and an S3 driver**. Its interop is now
   **proven against a real S3 server** (`rclone serve s3`, including the negative that a forged
   signature is refused); what remains unproven is **virtual-host addressing** and a specific
   production provider. The bucket/provider decision (`OPEN-016`) is still the owner's, and the
   probe is on the go-live checklist so this cannot be taken on trust.
3. ~~No immutable image and no deploy artefacts~~ — **a `Dockerfile`** (one image, two entrypoints,
   non-root, no secrets, a `/health` `HEALTHCHECK`) and **a CI workflow**. Still missing: reverse-proxy
   and TLS config, and the **maintenance flag** the documented rollback path (b) needs.
4. ~~No invariant job~~ — **built** (`ops.invariant_nightly`): invoice arithmetic, allocations, orphan
   counts and the **audit hash chain**, re-anchored nightly — and the anchor now **uploads to
   `AUDIT_ANCHOR_BUCKET`**, so the nightly verification leaves the database it attests to.
5. **Observability is still logs only.** `SENTRY_DSN` is documented but unwired, there are no metrics,
   no uptime monitor and no daily digest (OPEN-012). `SYS-03` now exists to look at, but nothing
   alerts on it.

### C. Only a person can supply these

Dedicated phone number + VPS · a CI runner or a remote to push to · domain and TLS, and acceptance of
RPO ≤ 15 min / RTO ≤ 4 h (OPEN-017) · the managed-Postgres-with-PITR and object-storage decision and
its budget (OPEN-016) · **bank payment instructions and the real fee per group** (OPEN-018) · logo,
legal name, address (OPEN-001) · retention periods with an accountant (OPEN-009) · mandatory TOTP?
(OPEN-010) · PDPA legal review and a published privacy notice (OPEN-019) · CR-003 approval in writing ·
the real-device pass · the handover pack and owner training · the real player roster imported by CSV.

### D. The shortest honest path

1. **Push** so CI runs once (the commit is done). Nothing can be released cleanly from an unobserved
   pipeline.
2. **Prove the S3 driver against the real provider** (`npm run storage:probe`, `-- --anchor`), and
   decide the bucket (`OPEN-016`).
3. **M7** the moment the number arrives — spike S1 first, per the plan.
4. **M9:** performance sanity, security review, accessibility, the real-device pass, a bug bash on
   anonymised real data.
5. **M10:** provision, secrets, DNS/TLS, backups **plus a restore drill recorded in
   `RESTORE_LOG.md`**, monitoring, `create-owner` + TOTP, configuration, CSV import of the real
   roster, training, handover, then the go-live checklist.

### E. If a pilot is enough, the blocker set collapses

A **pilot for the owner's own bookkeeping** — no guardian-facing messaging, no public links, one person
using it to bill and record payments — does *not* need M7. It needs only: a deployable API (built), a
worker (built), managed Postgres, the frontend pointed at the real API (it already is, once
`NEXT_PUBLIC_USE_MOCKS` is off and `NEXT_PUBLIC_API_BASE_URL` is set), a domain with TLS, real secrets,
one backup **with a tested restore**, `create-owner` + TOTP, and the owner's real fees and bank
details. **Guardian-facing automation is the expensive half, not the money engine.**

### The one-line version

Money, documents, the dashboard, the reports, the audit trail and the system page all work and are
tested; **messaging is the only missing feature and it is waiting on a phone number**, not on code;
the worker, the storage adapter, the invariant job, the off-host audit anchor, the image and CI now
exist, and the audit chain is a chain again. What stands between here and production is a **push so CI
has ever run**, **the S3 boundary proven against the real bucket** (a local server has answered, not a
production provider), an unproven restore, a security review, no deployed environment, and the owner
items in §5.
