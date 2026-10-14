# handoff.md — read this one first

> **Updated:** 2026-10-14 (fourth session of the day: **the backend is deployed and running on the
> VPS** — §2 has the measured state, §12 the session, §5 the two things that now block real use) ·
> **Owner granted standing permission** (§6) — ordinary development, local infrastructure and
> commits need no further approval.
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

**Deploy the backend to the VPS by running the runbook that had never been run.** The previous
session wrote [VPS_DEPLOYMENT_RUNBOOK.md](docs/engineering/VPS_DEPLOYMENT_RUNBOOK.md) and said so
plainly, in the compose header and in §12: nothing in it had ever been started. The goal was to run
it on the real box, end to end, and to **fix whatever a first real run exposed rather than route
around it**. Four defects in that never-run path were found and fixed (§12); the deployment is up.

One instruction arrived while it ran, from the owner: **stay HTTP-only for now** — the academy has
no domain and no mailbox for Let's Encrypt, so the ACME email is a placeholder and the site is plain
HTTP on `:80`, with the HTTPS switch documented inline in
[the Caddyfile](backend/deploy/Caddyfile).

## 2. Current state — measured, not assumed

| Check | Result |
|---|---|
| `npx tsc --noEmit` | **exit 0** |
| `npx vitest run` (all three projects) | **260 passed / 260, exit 0** — 27 files (unit 117, db 25, integration 118). The 20 new tests are the anchor's and the audit chain's (§3) |
| `npx tsx scripts/migrate.ts` | 16 migrations applied, exit 0 (`0016` is the chain repair) |
| `npm run storage:probe` (`-- --anchor` too) | **9/9 PASS, exit 0** against a real S3 server (`rclone serve s3`), including the negative: a wrong-secret signature is rejected `403`, an unsigned request `400` |
| `npx tsx scripts/progress-report.ts` | **114 / 135 endpoints** |
| `npm run openapi` + `npx redocly lint ../api/openapi.yaml` | valid, **135 operations**, 3 pre-existing warnings |
| `node tools/check-links.mjs` | exit 0 — 58 files / 409 links, 0 broken (the runbook included) |
| `npm run test:assert-report:self-test` | **exit 0** — 5 cases: a complete green run passes, and an all-skipped run, a run missing its `db` project, a short run and a failed run each fail |
| `npm run test:report` + `npm run test:assert-report` | **exit 0, and it prints the real numbers**: 260 tests in 27 files — unit 7, db 4, integration 16 — passed 260, failed 0, pending 0, todo 0 |
| `npm run build` → `ls dist/scripts` | **exit 0**, and `migrate.js`, `bootstrap-roles.js`, `create-owner.js`, `storage-probe.js` are all emitted — which is what makes §3's Dockerfile fix checkable |
| `node tools/check-stale-refs.mts` | exit 0 — no stale provider references |
| Commits | **11 atomic commits** for M2–M8, then this session's CI-guard commit; the tree holds no source changes, and the two sample receipts stay untracked on purpose (§5.3) |
| The worker, run for real | `npm run worker:once` exit 0, then `job_runs`/`worker_heartbeats` **read back out of the database**: five daily jobs `ok`, `ops.logical_backup skipped` (no `BACKUP_DIR`), and **nothing re-claimed that had already succeeded** — the `(job, run_key)` idempotency observed, not asserted |
| The nightly invariant job, run for real on a chain with the anchor configured | **`ops.invariant_nightly ok`**, 3 audit rows checked, `auditChainBroken: 0`, `anchorStatus: uploaded` — and the uploaded object's `headHash` **equals** the chain head read back from the database (§3) |
| **The deployment itself, on the VPS** | **Running.** `ia_db`, `ia_api`, `ia_worker` all `healthy` and `ia_caddy` up, HTTP-only on `:80`. 17 migrations applied, seed applied, and the database holds **exactly one user — the owner, `invited`, with a live 72 h invite**. `GET /api/v1/health` → `200 {"status":"ok"}`; an unauthenticated `GET /api/v1/users` → **401 `UNAUTHENTICATED` with a `requestId`** (the real router, not a 404) (§12) |
| **Login over plain HTTP** | **Verified end to end** with a throwaway active coach, over the forwarded SSH port: `POST /api/v1/auth/login` → 200 and `Set-Cookie: ia_session=…; Path=/; HttpOnly; SameSite=Lax` — **no `Secure`**, because `COOKIE_SECURE=false` for the HTTP-only pilot — then `GET /api/v1/auth/me` → **200 with the cookie and 401 without it**. The throwaway account was deleted afterwards and the database is back to one row (§12) |
| **Reaching the API from the internet** | **The forward works; DNS is the last step.** The VM sits behind the provider's NAT (`enp16s0 192.168.122.24`), and the provider now routes the hostname **`inspire-player.lk`** to this VM's port 80. Verified **from outside**: `Host: inspire-player.lk` against `93.127.141.71` → `/api/v1/health` **200 `{"status":"ok"}`**, an unauthenticated `/api/v1/users` → **401 with a `requestId`**, and a CORS preflight for `http://inspire-player.lk` → **204** with the matching `Access-Control-Allow-Origin`. `inspire-player.lk` is **NXDOMAIN** today, so the A record is all that is missing (§5) |
| **The app itself** | **Deployed on the same box and the same origin as the API.** `ia_web` (Next.js 16.4, `ia-frontend:prod`) is healthy; Caddy sends `/api/*` to the API and everything else to the app. Verified **from outside** through the provider's forward: `/login` **200**, `/accept-invite?token=…` **200**, `/` **307 → /dashboard**, `/api/v1/health` **200**, `/api/v1/users` **401**, and **zero `msw` in the bundles actually served** — the mock-mode trap is checked rather than assumed (§12.7) |
| **The three unbuilt M7 jobs, now actually observed** | `messages.queue_consumer`, `messages.reminder_enqueue` and `openwa.health` each recorded **`skipped`** carrying their not-built reason — the behaviour the M8 handoff could only *code-read*, because every tick in this project until now had run before their 08:30 academy-local window. It is measured, at 17:07 local |
| **The owner's invite** | **Issued and live (72 h, single use), and it needs DNS.** `reset-owner` produced `http://inspire-player.lk/accept-invite?token=…` on the new hostname. Nobody can open it until that name resolves (§5) — which is the whole distance between “deployed” and “the owner is using it” |
| **The nightly logical backup** | **Works, and has been restored.** `pg_dump` 16.15 is in the image, and the job connects as **`ia_backup`** — read-only, and the only role with `BYPASSRLS`, because `pg_dump` sets `row_security = off` and every table here is FORCE RLS (§12.6). `job_runs` for 2026-10-14 reads **`ok`** with a 186 KiB dump, and a full **restore drill passed in 3 s** (35 tables, 17 migrations, the academy row) — entry 1 in [`RESTORE_LOG.md`](docs/engineering/RESTORE_LOG.md). A *failed* dump still leaves no file behind (§12.4) |

Endpoint progress: **M2 23/23 · M3 31/31 · M4 19/19 · M5 26/26 · M6 9/9 · M7 0/21 · M8 6/6.**

**A backend is deployed now** — a VPS, a database, a worker and a reverse proxy, all running, with
the first owner invited. What that does *not* yet mean: nobody can reach it from the internet (§5),
the frontend is not deployed, TLS is off by the owner's instruction, and the nightly backup does not
complete (§2). CI still has to prove the tests ran rather than merely pass (§3 item 3).

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
3. **CI has now run, twice, and both were green — but the first one was green for the wrong
   reason, and that is fixed.** Push #1 reported `success` in 69 s with the suite "passing" in 40 s
   against a locally measured 254 s, and nothing in the log could distinguish that from a run that
   ran nothing. That shape is not hypothetical here: this project has twice seen a vitest file whose
   `beforeAll` threw reported as **skipped**, so an unreachable database yields a fast, empty, green
   run. CI now runs `npm run test:report` and then `scripts/assert-test-report.mjs`, which fails the
   build on any skipped/pending/todo test, on a project that produced no files, or on a total below
   `scripts/tests-minimums.json` (260 tests / 27 files today). **The guard carries its own
   `--self-test`**, and it earned its place immediately: the self-test caught a bug in its own
   fixture on the first run. **The corrected pipeline has now been observed green on the runner**
   (run #2, `f7c656a`, both jobs `success`): step 6 is the guard's self-test and step 14 is "Prove
   the suite actually ran", both `success`, so the report CI produced contained at least 260 tests
   across unit 7 / db 4 / integration 16 with nothing skipped. One caveat worth stating: **the
   step's printed numbers could not be read back** — the job-log endpoint needs admin rights on this
   repository — so this rests on the guard's own semantics (it fails on a missing, short or skipped
   report, and it passed), not on seeing the line. The suite's own step takes 34 s on the runner
   against 254 s on this Windows + OneDrive machine, which is the other reason the counts had to be
   asserted rather than inferred from a duration.
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

**New this session — the two things now standing between the deployment and real use:**

- **`inspire-player.lk` needs an A record pointing at `93.127.141.71`.** *Solved this session* — the
  provider's panel now forwards that hostname to this VM's port 80, and the forward is **verified
  working from outside** (§2); the base URLs and CORS were set to it. What is left is DNS: the name
  is NXDOMAIN today, which is a registrar task, not a server one. (If the provider's interception
  becomes a problem later, the two alternatives remain a dedicated IP or a **Cloudflare Tunnel** —
  the latter needs no inbound port at all and would give real HTTPS on `app.`/`api.` hostnames.)
- ~~**A decision: which role takes the nightly dump.**~~ — **decided and done: a dedicated `ia_backup`
  role** (`BYPASSRLS` + `pg_read_all_data`, read-only, used by nothing else), created by
  `db/bootstrap.sql` and given its password by the bootstrap CLI from `DATABASE_BACKUP_URL`. The
  alternative — the superuser URL — was rejected because it would put credentials that can read every
  database *and* the machine's filesystem inside an unattended nightly job. The dump now succeeds and
  **has been restored** (§2, §12.6).

1. **A phone number for OpenWA — supplied 2026-10-14** (a test number; deliberately not written
   into this repository). What M7 still waits on is a **home for the gateway**: the session must be
   paired where OpenWA will live (the OpenWA VPS of DEPLOYMENT §2), because a session paired on a
   developer machine dies with it and pairing twice is what trips WhatsApp's passkey gate. This
   machine cannot host it either — `npm ci` needs a C++ toolchain for `better-sqlite3` and there is
   no Docker, no Visual Studio and a OneDrive-synced working copy. **That VPS now exists (§2), so the gateway
   has a home — pairing the session on it is what M7 now waits on.**
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
7. **Storage: decided 2026-10-14 — it stays on the VPS, not a third-party bucket** (`OPEN-016`
   resolved in that direction). The implementation choice is between the `local` driver in a
   directory on the VPS and a MinIO container on the same box with `STORAGE_DRIVER=s3`; either way
   the nightly off-host copy of proofs (DEPLOYMENT §7) remains mandatory, because a bucket on the
   same machine is not a backup of that machine.
8. Smaller release-gate items (retention periods with the accountant, mandatory TOTP) — details in
   [`NEEDS_FROM_OWNER.md`](NEEDS_FROM_OWNER.md) §1.
9. ~~**A CI runner**~~ — **supplied 2026-10-14**: the remote is
   `https://github.com/isahzn/inspire-player-manager.git` and both CI runs so far are green. Gate
   item 1 is now observable.

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

**Fourth session of 2026-10-14 (the deployment)** — new:
`backend/migrations/0017_owner_invariant_bootstrap.sql`. Modified: `backend/Dockerfile` (`pg_dump` —
§12.3), `backend/src/worker/jobs.ts` (a failed dump no longer leaves a truncated file — §12.4),
`backend/scripts/migrate.ts` (the `isMain` guard — §12.2), `backend/deploy/Caddyfile` (HTTP-only,
with the HTTPS switch and why), `backend/deploy/docker-compose.prod.yml` (a stale `/health` comment),
and this file. **On the VPS only, never in git:** `backend/deploy/.env.production` — the secrets, and
`COOKIE_SECURE=false` for the HTTP-only pilot, with the reason written beside it.

**Third session of 2026-10-14** — new: `backend/scripts/assert-test-report.mjs`,
`backend/scripts/tests-minimums.json`, `backend/deploy/docker-compose.prod.yml`,
`backend/deploy/Caddyfile`, [the VPS runbook](docs/engineering/VPS_DEPLOYMENT_RUNBOOK.md). Modified:
`backend/Dockerfile` (**it could not migrate** — §12), `backend/package.json`,
`.github/workflows/ci.yml`, `.gitignore`, this file.

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

**This session (the deployment): four defects in a path nobody had ever run, fixed at the cause** —
the `LAST_OWNER` invariant that made the academy's first owner impossible to create (`0017`), the
`migrate.ts` guard that turned the documented migrate command into a silent no-op, the `HEALTHCHECK`
that probed a path the router does not serve, and a failed `pg_dump` that left a truncated archive
looking exactly like a backup. §12 has each one with the evidence that found it.

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
  failed and found it.

**Fourth session (the deployment):**

- **An SSH tunnel started in the foreground hangs the tool, not the tunnel.** `ssh -N -L …` never
  returns, so a synchronous command times out *after* the tunnel is up and working. Start it as a
  background process, curl through it, then stop it — and note that `taskkill /IM ssh.exe` kills
  every tunnel on the machine, not just the one.
- **The deploy directory is not the repository root.** `docker-compose.prod.yml` and
  `.env.production` live in `/opt/inspire/src/backend/deploy`; a diagnostic that `cd`-ed two levels
  short printed an empty environment and looked like a missing env file. A path that works locally is
  a guess on a server.
- **`pg_dump` refuses a server newer than itself**, and Debian bookworm ships only client 15 while
  `bookworm-backports` carries no 16 — so the client has to come from PGDG (`apt.postgresql.org`).
  A plain `apt-get install postgresql-client` builds an image that starts, runs overnight, and then
  aborts on the dump.
- **A grep that found nothing because of a backtick.** `` `/api/v1/health` `` in a comment does not
  match the pattern `api/v1/health ` (there is a backtick between the two), so a correct edit read as
  an unapplied one. A failed grep is evidence about the pattern at least as often as about the file.
- **A failed daily job retries every tick.** `claimJobRun` re-claims any row whose status is not `ok`,
  so `ops.logical_backup` was retried **every 15 seconds** and wrote one truncated dump per attempt.
  Right for a transient failure, expensive for a permanent one — and the reason §12.4 mattered.

## 10. Next steps, in order

1. ~~**Push so CI runs once**~~ — **done**. ~~the VPS deployment~~ — **done**. ~~the dump role~~ —
   **done and restored**. ~~deploy `frontend/`~~ — **done, same origin as the API** (§12.7). ~~re-issue
   the invite~~ — **done and live**. What is left, in order: **(a)** one **A record** for
   `inspire-player.lk` → `93.127.141.71` (§5). Everything the owner needs is already waiting behind
   it: their invite link is `http://inspire-player.lk/accept-invite?token=…`, valid for 72 h from
   2026-10-14 17:02Z; **(b)** copy the dumps and `ia_files` off the machine (runbook 12b); **(c)** turn
   HTTPS on by changing one line in the Caddyfile and putting `COOKIE_SECURE=true` back.
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
| 1 | CI green on the release commit | **Ran, green, and now forced to be honest about it.** `.github/workflows/ci.yml` runs typecheck, build, contract generation + lint, the full suite against a real PostgreSQL, and the documentation tools; two runs exist on `origin/master`, both green. The second push added `assert-test-report.mjs`, which refuses a short or skipped run — a green run now *proves* it ran 260 tests in 27 files, not merely that it exited 0. The suite is green locally too: 260/260, exit 0 |
| 2 | E2E smoke on staging (login, register, attendance, clock in/out, billing run, payment + receipt, `PRF-04` queue, WhatsApp via mock, void) | **Partly, and for the first time not "impossible": there is a real deployment now (§2)**. Health, login, the session cookie over HTTP and the 401s were walked by hand against the running box. The rest need the deployed frontend, which does not exist yet, so the item stays open |
| 3 | T-FIL-09 and T-MSG-02/03/06 pass | T-FIL-09 **passes**; **every T-MSG row is blocked** (M7 unbuilt) |
| 4 | OpenWA spike S1 (O18–O22) + T-MSG-12 on the real number | **Not started** — needs the number (§5.1) |
| 5 | Accessibility + real-device mobile checklist signed off | **Not done** — M9; needs the owner's phone |
| 6 | T-OPS-01 within 90 days + T-OPS-02 rehearsal | **Started, for the first time with evidence.** [`RESTORE_LOG.md`](docs/engineering/RESTORE_LOG.md) now exists and holds **one real drill**: the nightly dump restored into a throwaway database in 3 s with `pg_restore` exit 0 and no messages. That proves the mechanism, not an RTO — the database holds one invited owner, so the number is a floor — and the dump is still on the machine it protects |
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
   non-root, no secrets) and **a CI workflow**, plus, as of this session, **a reverse proxy that
   actually runs**: `backend/deploy/Caddyfile` in the compose stack, with TLS deliberately off and
   the switch written down. The liveness path is `/api/v1/health`, **not `/health`** — a bare
   `/health` is a 404 on the real router, which is exactly what the old `HEALTHCHECK` asked for
   (§12.1). Still missing: the **maintenance flag** the documented rollback path (b) needs.
4. ~~No invariant job~~ — **built** (`ops.invariant_nightly`): invoice arithmetic, allocations, orphan
   counts and the **audit hash chain**, re-anchored nightly — and the anchor now **uploads to
   `AUDIT_ANCHOR_BUCKET`**, so the nightly verification leaves the database it attests to.
5. **Observability is still logs only.** `SENTRY_DSN` is documented but unwired, there are no metrics,
   no uptime monitor and no daily digest (OPEN-012). `SYS-03` now exists to look at, but nothing
   alerts on it.

### C. Only a person can supply these

Dedicated phone number + VPS · a CI runner or a remote to push to · domain and TLS, and acceptance of
RPO ≤ 15 min / RTO ≤ 4 h (OPEN-017) · **the VPS itself**, plus the managed-Postgres-with-PITR
choice and its budget (storage is now decided: VPS-local, §5.7) · **bank payment instructions and the real fee per group** (OPEN-018) · logo,
legal name, address (OPEN-001) · retention periods with an accountant (OPEN-009) · mandatory TOTP?
(OPEN-010) · PDPA legal review and a published privacy notice (OPEN-019) · CR-003 approval in writing ·
the real-device pass · the handover pack and owner training · the real player roster imported by CSV.

### D. The shortest honest path

1. ~~**Push** so CI runs once~~ — **done**, and so is the **first real deployment** (§2). What is
   left of this step is not code: make the VM reachable (§5), set the base URLs and CORS to the real
   host, and fix the dump role (§5).
2. **Prove the S3 driver against the real provider** (`npm run storage:probe`, `-- --anchor`) — still
   open, but no longer on the critical path: the pilot runs `STORAGE_DRIVER=local` on the VPS
   (§5.7), so the live question is the **off-host copy of proofs**, not the driver.
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

## 12. This session — the deployment, and the four defects it exposed

**What was asked:** run the VPS runbook the previous session had written but never run. What follows
is what a first real run found, against a real PostgreSQL 16, real Docker, and a network that turned
out to sit behind the provider's NAT.

### 12.0 The deployment, as it now stands

| | |
|---|---|
| Box | `/opt/inspire/src` — the repo cloned on the VPS, run from `backend/deploy` |
| Containers | `ia_db` (postgres:16-alpine), `ia_api`, `ia_worker` (one image, `ia-backend:prod`) and `ia_caddy` — all up, the first three `healthy` |
| Database | roles bootstrapped from `db/bootstrap.sql`, **17 migrations** applied, seed applied (`academy_settings` = "Inspire Academy" / `Asia/Colombo`) |
| Users | **one** — the owner, `invited`, with a live 72 h invite |
| Reached by | nothing public yet (§5); `http://127.0.0.1/…` on the box itself, and an SSH tunnel for me |

Three things to know before touching it. It was **reinitialised once**, because my own invariant
tests had left four junk owner rows in it — a brand-new production database must not carry test
pollution, and the clean re-init then ran the runbook's commands as written, which was the point. The
`db` service carries `profiles: ["localdb"]`, so **every** compose command needs `--profile localdb`
or Compose answers `service "worker" depends on undefined service "db"`. And the repository on the
box was **root-owned** (cloned under `sudo`), which is why the first `scp` of a fix landed nowhere.

### 12.1 `HEALTHCHECK` probed a path that does not exist

The Dockerfile asked for `/health`, and the runbook's step 10 says the same. The router mounts every
contract route under `/api/v1`, so `/api/v1/health` is the endpoint (`SYS-01`) and `/health` is a
**404**: the container would have reported `unhealthy` forever while serving perfectly, and an
operator would have gone looking for a fault that was not there.

### 12.2 The documented migrate command did nothing, silently

`scripts/migrate.ts` guards `main()` with `process.argv[1].endsWith("scripts/migrate.ts")`. That
matches when run through `tsx` and **never** matches the compiled `dist/scripts/migrate.js` the
runbook calls through `--entrypoint node` — so the deployment's migration step exited **0 having done
nothing**. The guard now compares `pathToFileURL(process.argv[1]).href`, the same fix
`worker/index.ts` needed in an earlier session.

### 12.3 The first owner could not be created — an invariant conflict, not an operator error

`create-owner` inserts the first owner as **`invited`** — they set their own password from a 72 h
single-use link (DEPLOYMENT §9.2). The 0002/0006 `LAST_OWNER` invariant demanded an **`active`** owner
on *every* write to `users`, **deferred to COMMIT**. On a fresh database with no owner yet, the
bootstrap therefore died with `23514: at least one active owner must exist (LAST_OWNER)`. The academy
could never have had a first owner, and the failure looked like a bug in `create-owner`.

`migrations/0017_owner_invariant_bootstrap.sql` redefines the check to fire on what it guards: an
**INSERT can never remove the last active owner**, and only a row that **was** an active owner can be
lost. The advisory lock and the deferred SECURITY DEFINER evaluation are unchanged from 0006.
**T-AUTH-07 still holds** — verified by trying to demote the last active owner, which still raises
`LAST_OWNER`.

### 12.4 A failed `pg_dump` left a backup-shaped file

First the missing binary: the job spawns `pg_dump` and the slim image has no PostgreSQL client, so
runbook step 12a's "the worker already writes one nightly" was `spawn pg_dump ENOENT`. The client has
to match the server's major version (`pg_dump` refuses a newer server), so it comes from PGDG —
Debian bookworm has only 15 and `bookworm-backports` has no 16 — and the repo and its key are removed
again after the install.

Then the job failed *later*, and worse. `pg_dump` sets `row_security = off`; these tables are
**FORCE ROW LEVEL SECURITY** on purpose (`0016`); so it died inside `academy_settings` **after writing
182 KB of archive**. And `claimJobRun` re-claims any run whose status is not `ok`, so that became **a
new truncated dump every 15 seconds**, in the exact directory runbook step 12a tells the operator to
trust.

The job now removes the partial file before it throws: **a missed backup has to look like a missed
backup, not like a backup.** Verified by emptying the directory and watching two ticks leave it at
**zero files**, with `job_runs` still honestly recording `failed`. **No automated test covers this** —
the only failure that leaves a file needs a real `pg_dump` against a table the dumping role cannot
read, which the suite has no way to guarantee on a machine that may not have `pg_dump` at all.

**The dump itself could not be fixed in code**, because a full logical dump of an RLS database must
come from a role exempt from RLS and both existing roles are deliberately forbidden `BYPASSRLS`. That
was put to the owner as a decision rather than taken — §12.6 is what came back and what it proved.

### 12.5 HTTP-only, and the cookie that would have broken it

The instruction was to stay HTTP-only until there is a domain and a mailbox, so the Caddyfile has no
site hostname — pointed at one it could not validate, Caddy logged a certificate failure every minute
and answered everything with a 308 to an HTTPS port with no certificate — and `ACME_EMAIL` stays a
placeholder.

That exposed something else: `.env.production` carried `COOKIE_SECURE=true` (the production
default), and **a `Secure` cookie is discarded by a browser over plain HTTP** — so login would have
appeared to succeed and the very next request would have been unauthenticated. Set to `false` for the
pilot, with the reason and the flip-back written beside it in the file.

Verified the way a browser would, over the tunnel: `POST /api/v1/auth/login` → **200**,
`Set-Cookie: ia_session=…; HttpOnly; SameSite=Lax` with **no `Secure`**, then `GET /api/v1/auth/me` →
**200 with the cookie and 401 without it**. The throwaway active coach used for that was deleted
afterwards; the database holds one user again.

### 12.6 The dump role, and the first restore this project has ever performed

The decision came back as **a dedicated `ia_backup` role**, which is the right shape: `BYPASSRLS` for
the reason above, `pg_read_all_data` (PG 14+) for read access that a later migration cannot forget to
grant, and nothing else — no write, no DDL, no superuser. `db/bootstrap.sql` creates it and carries
the reasoning for why it is the one exception to this schema's own "no BYPASSRLS" rule, and the
guard in that file now *fails the bootstrap* if a future edit ever swaps the flags between roles.

The worker connects the dump as `ia_backup` and not as the migrator, and when `DATABASE_BACKUP_URL`
is missing the job records `skipped` naming it instead of failing every 15 s — the old behaviour
retried a permanent configuration error one hundred and twenty times an hour (§9).

The contrast is worth keeping, because it is what made the diagnosis unambiguous. Both roles were
asked to read `academy_settings` the way `pg_dump` does:

```
  ia_backup    → 1 row (RLS bypassed)
  ia_migrator  → ERROR: query would be affected by row-level security policy for table "academy_settings"
```

**It works, and it has been restored** — which is the runbook's own test of whether a backup is a
backup:

| Drill | Result |
|---|---|
| `pg_restore` into a throwaway `ia_restore_test` on the VPS | **exit 0, no messages** |
| Restored | 35 tables · 17 migrations · `academy_settings` = “Inspire Academy / Asia/Colombo / LKR” · 1 user (`owner`, `invited`) · 2 `audit_logs` rows |
| Duration | **3 s** (create + restore + verify + drop) |
| Left behind | nothing — the throwaway was dropped and `ia_prod` confirmed untouched |

It is written up as [`RESTORE_LOG.md`](docs/engineering/RESTORE_LOG.md) entry 1, with its limits
stated there rather than implied: 3 s is a floor measured on an almost-empty database, the dump still
lives on the machine it protects, and `ia_files` (the payment proofs) is not in it.

### 12.7 The frontend, and a bug that only existed outside mock mode

The runbook's plan was Vercel or Cloudflare Pages for the app and this VPS for the API. **I put the
app on the same box and the same origin instead**, because it is strictly simpler and needs no
third-party account: `handle /api/*` goes to the API, `handle` goes to the app, so there is no
cross-origin request at all — no CORS to configure, and the `SameSite=Lax` session cookie is
same-origin by construction rather than by a shared registrable domain. The box had the headroom
(2 vCPU, 3.8 GiB, 55 GB free). The deviation is written down in the runbook §11 with its reasoning,
not left as a surprise.

`frontend/Dockerfile` and a `web` compose service are new. `NEXT_PUBLIC_API_BASE_URL` is
**relative** (`/api/v1`): every API caller in this app is a client component and nothing fetches
during SSR, so a relative base resolves against whatever origin the browser is on — which means the
TLS switch later needs no rebuild, and the app does not depend on its own public name resolving from
inside its container.

**Then the build failed, and the reason is the useful part.**

```
Error occurred prerendering page "/age-groups/[id]" ... digest: 'CLIENT_HOOK_DYNAMIC'
     50 | export function AppShell({ children }: { children: React.ReactNode }) {
     51 |   const pathname = usePathname();
```

`AppShell` sits in the root layout and uses `usePathname()`/`useRouter()`. With `cacheComponents` on,
Next refuses those hooks during prerender unless a Suspense boundary is above them — correctly, since
it cannot prerender a shell whose whole navigation depends on the URL. `src/app/layout.tsx` now wraps
the shell in `<Suspense>` with a small `AppLoading` fallback.

**Why no earlier session caught it, which is the part worth remembering:** `NEXT_PUBLIC_USE_MOCKS=true`
lives in a developer's untracked `.env.local`, and in mock mode `Providers` renders `null` until the
MSW worker starts — so prerendering never reached `AppShell` and the hooks were never called. **Every
build this project had ever done was a mock build**, which is exactly the trap runbook §11 calls the
most expensive mistake available: a mock build is green, looks right, and proves nothing about the
app that will actually talk to the API.

The verification that closes that gap is not "the build passed" — it is that the **served bundles
contain no MSW worker** (`0` hits), the title is the real one, `/api/v1/health` answers `200 JSON`
from the API while `/api/v1/users` answers `401`, and the invite route renders. All four were checked
from outside the box, not just on it.

## 13. Previous session — the push, the guard, and two real defects

**What was asked:** push everything except WhatsApp to
`https://github.com/isahzn/inspire-player-manager.git`, then explain how to get it onto a VPS.

1. **Pushed.** 316 tracked files on `origin/master`; the two sample receipts stayed untracked on
   purpose. A secret/PII pass ran first: no `.env`, no key, no phone number, no PII PDF in the tree.
2. **CI ran, and its first green was not trustworthy.** 69 s total, the suite "passing" in 40 s
   against a locally measured 254 s. Rather than accept it, the counts are now asserted: the
   workflow writes `test-report.json` and `assert-test-report.mjs` fails the build on a skipped or
   pending test, on a project that ran no files, or on a total below `tests-minimums.json`. The
   guard has a `--self-test`, and **it immediately failed on its own fixture** — the fixture used
   relative paths where the rules match `/tests/unit/` with a leading slash, so every project
   scored zero. A guard nobody has watched fail is a guard nobody can trust; this one failed on
   contact and was fixed.
3. **The image could not migrate — a real deployment blocker, found while writing the runbook.**
   `scripts/migrate.ts` reads `process.cwd()/migrations` and `scripts/bootstrap-roles.ts` reads
   `cwd/db/bootstrap.sql`, and the Dockerfile's runtime stage copied only `dist/` and
   `package.json`. The image would have started cleanly and then failed on the VPS, at the worst
   moment, with an ENOENT from an operator CLI. The runtime stage now copies `migrations/` and
   `db/`. The CLIs are also reached with `--entrypoint node`, because the image's
   `ENTRYPOINT sh -c 'exec node "$APP_ENTRY"'` silently drops extra arguments.
4. **The VPS runbook exists** — [VPS_DEPLOYMENT_RUNBOOK.md](docs/engineering/VPS_DEPLOYMENT_RUNBOOK.md)
   — with the environment file's every line classified as required / required-for-correctness /
   optional / ignore, and the honest limits stated up front.

**The answer to "what API keys do you need": none.** No payment gateway, no email API, no
third-party key. The three required secrets are `SESSION_COOKIE_SECRET`, `CSRF_SECRET` and
`TOTP_ENCRYPTION_KEY` (all `openssl rand -base64 48`), plus the database URLs' own passwords.
`SENTRY_DSN` is documented but **not wired**, and `DEV_OWNER_USERNAME`/`DEV_OWNER_PASSWORD` in
`.env.example` are read by **nothing** — worth deleting from the template so nobody sets them
believing an account will appear.

**The two deploy artefacts were unrun when this was written — they have since been started.** This
machine has no Docker, so `docker-compose.prod.yml` and `Caddyfile` were written and YAML-parsed only.
The next session ran both on the VPS (§12). The note is kept because it is what the runbook's honesty
rests on, not because it is still true.

### The one-line version (updated 2026-10-14, fourth session)

Money, documents, the dashboard, the reports, the audit trail and the system page all work and are
tested; **messaging is still the only missing feature, and it waits on pairing the gateway on a VPS
that exists** rather than on a phone number. **The whole system is deployed** — database, API, worker,
reverse proxy and the Next.js app on one origin, 17 migrations, a login path verified over HTTP, a
nightly dump that has been **restored**, and a live invite for the owner waiting on a single **A
record** for `inspire-player.lk`. What stands between here and production is that **one DNS entry**,
TLS, an off-host copy of the dumps and the payment proofs, a security review, and the owner items in
§5.
