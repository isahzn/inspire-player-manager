# The audit chain was a forest · the anchor now leaves the building · the S3 driver has met a real server

> **Session:** 2026-10-14, continuing the M8 session of the same day · **Owner:** Freebuff
> **Depends on:** [the M8 handoff](2026-10-14-backend-m8-and-production-plumbing.md) (the worker, the
> storage adapter, the invariant job) · **Every number below was measured in this session.**

## 1. What this session set out to do, and what it found instead

`handoff.md` §10 listed four next steps, in order: commit the M8 work, prove the S3 boundary, watch
CI (needs a remote), build M7 (blocked on a phone number), then close the small operational gaps the
new worker had made visible. The commits had already landed when the session resumed, so the work
began at the second item.

It did three things, one of which was not planned and mattered more than the other two:

1. **The S3 driver has now spoken to a real S3 server**, and the check is a reusable script, not a
   one-off: `npm run storage:probe` (and `-- --anchor`). Evidence in §3.1.
2. **The audit-chain anchor is now uploaded off-host** (`AUDIT_ANCHOR_BUCKET`), the last item in the
   M8 handoff's "deliberately not done" list. Verified end to end: the object in the bucket carries
   the same head hash the database recorded. Evidence in §3.2.
3. **The audit hash chain was broken — not by this session's code, but by design.** Running the
   nightly job for real on a database with coach activity failed it with `1 broken audit hash(es)`,
   which is the release procedure's rollback trigger. It was not a flake: the chain trigger read the
   previous row **with the writer's RLS visibility**, and only owners may read `audit_logs`. Every
   coach write, every attendance mark, every failed login started a **new chain**. Fixed in migration
   `0016`, with two tests that fail without it (§2.3, §3.3).

## 2. The three changes

### 2.1 `scripts/storage-probe.ts` — the S3 boundary, checkable in one command

MinIO's community server binaries are **gone** (`dl.min.io` answers `410 Gone`: the project is
archived and no longer serves them), so the probe was proved against **`rclone serve s3`** — a real
S3 implementation that verifies SigV4 itself. Nine checks, and the one that gives the others their
meaning: **a request signed with the wrong secret is rejected (403)**. A server that accepted a
forged signature would have made the successful writes prove nothing about the signing code.

### 2.2 The audit anchor now leaves the database (`src/ops/audit-anchor.ts`)

`audit_anchors` (0015) records what was verified — in the same database as the rows it attests to, so
an attacker with write access to that database can revise both together. The nightly job now uploads
one **immutable object per verification** (`audit-anchor/<head-row>-<anchor-id>.json`, canonical
JSON), which is what turns the record into a witness the database operator cannot rewrite. There is
no `latest.json` pointer for exactly that reason: a pointer is something a later writer can repoint.

Three rules, each of them the "honest" choice this project keeps making:

- **Unconfigured is `not_configured`, not a pass and not a failure** — the run says where the
  verification *is* recorded and what to set for an off-host witness.
- **A configured bucket that refuses the upload fails the run.** Same reasoning as
  `assertStorageUsable`: a deployment must not believe it has off-host tamper evidence when it does
  not.
- **The anchor bucket never inherits the files bucket's bucket name or prefix** (only the endpoint,
  region, credentials and addressing style). The first version did inherit them, and a test caught
  it: with `STORAGE_BUCKET` as the fallback, a deployment that configured only the files bucket would
  have "anchored" into that same bucket — the tamper-evidence copy sitting inside the storage it
  exists to be independent of.

### 2.3 The audit chain: a lock, a definer, and a repair (migration `0016`)

Two independent defects, both found by running the nightly job rather than by reading the code:

1. **The chain trigger read the previous hash with the writer's privileges.** `audit_logs` is
   readable only by owners (`audit_read`: `app.app_role() = 'owner'`) while anyone authenticated may
   append. So a coach's audit row could not see the owner's rows and wrote `prev_hash = null` — the
   start of a second chain. Reproduced deterministically: an owner, a coach and an anonymous write
   produced **three roots**. `0016` makes the trigger `SECURITY DEFINER`, owned by `ia_migrator` (the
   only role whose policy reads everything), with a pinned `search_path` like every other definer
   function in this schema. The runtime role gains not one row of visibility: it is `ia_migrator`'s
   own policy that grants the read, and `ia_migrator` is not a superuser and has no `BYPASSRLS`.
2. **The trigger's read took no lock**, so two audited writes that overlap in time both read "there
   is no previous row" and both started a chain — reproduced with two transactions held open
   concurrently (`2 roots` for 2 rows, `5 roots` for 5 rows). `record()` now takes the chain's
   advisory lock **before** its insert, so the row id is allocated inside the lock and its
   predecessor is committed and visible. The cost is deliberate: an audited write holds the lock
   until its transaction ends, so audited transactions run one at a time. At this academy's volume
   that is nothing, and a chain that can fork is not tamper evidence.

**The repair.** Existing rows carry the fragments (`prev_hash = null` mid-table), and a fragment is a
permanently broken link — the invariant job would report it for the life of the database, so it had
to be repaired rather than tolerated. `0016` recomputes `prev_hash`/`row_hash` in id order with the
immutability trigger disabled for the duration, **inside the same transaction**, and then asserts the
result is a single chain (raising and rolling back if not). Only *derived* values are rewritten: no
row's content, actor or timestamp is touched. This is safe exactly once, here, because nothing is
deployed and no anchor ever attested to the old chain — the migration says so in its own header,
because after the first real verification such a rewrite would be evidence tampering. Pre-existing
`audit_anchors` rows are left in place (they are a record of what was verified at the time) but name
hashes this repair supersedes.

## 3. Evidence

### 3.1 The S3 driver against a real server (2026-10-14)

`rclone serve s3` on `127.0.0.1:9000`, path-style, `npm run storage:probe` — **9/9 PASS, exit 0**, in
both modes:

- `PUT` of a **1.5 MB** object (the size of a scanned bank receipt) → `true`; reads back
  byte-for-byte identical (1 500 000 bytes);
- a missing object reads as `null`; a `..` key is refused before any request is made;
- **a wrong-secret signature is rejected `HTTP 403`** and the forged object is not in the bucket;
- **an unsigned `GET` is rejected `HTTP 400`**;
- the object the run created was deleted again.

Not proven, and said so in the source header: **virtual-host addressing** (rclone serves one bucket
by path, so only path-style was exercised) and interop with a specific production provider — running
`npm run storage:probe` against the real bucket is now a go-live checklist item
([DEPLOYMENT §9](../../architecture/DEPLOYMENT_AND_OPERATIONS.md)).

### 3.2 The anchor, end to end (2026-10-14)

Three audited writes in `ia_test` (owner, coach, anonymous — the case that used to fork the chain),
then `npx tsx src/worker/index.ts --once` with `AUDIT_ANCHOR_*` pointed at the probe bucket:

```
ops.invariant_nightly ok in 119ms {invoicesChecked: 0, invoiceErrors: 0, invoiceWarns: 0,
  overdueCount: 0, arithmeticMismatches: 0, auditRowsChecked: 3, auditChainBroken: 0,
  anchorStatus: "uploaded",
  anchorObject: "audit-anchor/3-01a139b6-1ce9-72ea-9b5d-869dca7054ab.json",
  anchorDetail: "Anchored off-host at … in ia-anchor."}
```

read back out of the database **and** the bucket, not asserted from the log:

| Where | What it says |
|---|---|
| `job_runs.detail` | `anchorStatus: uploaded`, the object key, `auditChainBroken: 0` |
| `audit_anchors` | `verified_from 1`, `verified_to 3`, `rows_checked 3`, `head_hash ac7cd733…`, `created_at 09:19:58.698Z` |
| the object in `ia-anchor` | `headHash ac7cd733…` (identical), `verifiedTo "3"`, `verifiedAt 09:19:58.698Z`, `academyTimezone Asia/Colombo`, `kind audit-chain-anchor` |
| the chain itself | `select row_hash … order by id desc limit 1` **equals** the uploaded `headHash` |

Then the honest-skip path, same database, no `AUDIT_ANCHOR_*`: `anchorStatus: "not_configured"`,
`anchorObject: null`, status still `ok`, and the detail names `AUDIT_ANCHOR_BUCKET` and where the
verification *is* recorded.

### 3.3 The suite

| Check | Result |
|---|---|
| `npx tsc --noEmit` | **exit 0** |
| `npx vitest run` (all three projects) | **260 passed / 260, exit 0** — 27 files (117 unit, 25 db, 118 integration) |
| `npx tsx scripts/migrate.ts` | 16 migrations applied, exit 0 |
| `tests/db/audit-chain.test.ts` | 4 tests: two-overlapping-writes, five-overlapping-writes, owner+coach+anonymous, and the rolled-back-transaction case |
| Red-first | the concurrency pair failed **before** the lock (`2 roots`), the coach case failed **before** `0016` (`3 roots`) |

The suite grew from 240 to 260: 16 anchor unit tests, 4 chain db tests.

## 4. Files

**New source** — `src/ops/audit-anchor.ts`; `scripts/storage-probe.ts`.
**New migration** — `migrations/0016_audit_chain_reader.sql`.
**New tests** — `tests/unit/audit-anchor.test.ts`; `tests/db/audit-chain.test.ts`.
**Modified** — `src/files/storage-s3.ts` (a second bucket's config, `s3Put`/`s3Get`/`s3Delete`, the
envelope: the interop result replaces "NOT VERIFIED"), `src/audit.ts` (the chain lock),
`src/worker/jobs.ts` (the anchor upload and its failure rule), `src/files/storage.ts` (unchanged
behaviour, the port re-exports the wrappers), `package.json` (`storage:probe`), `backend/.env.example`
(`AUDIT_ANCHOR_*`), `docs/architecture/DEPLOYMENT_AND_OPERATIONS.md` (§4 env table + the anchor row of
§8 + the §9 checklist), `docs/engineering/PROJECT_STATUS.md`, `handoff.md`.

## 5. Decisions worth reading

1. **The trigger is `SECURITY DEFINER`; the lock is in `record()`, not in the trigger.** The lock had
   to move there because a `BEFORE INSERT` trigger runs *after* the row id is allocated, and two
   writers can therefore allocate ids in one order and take the lock in another — the chain would
   still not follow id order. Locking before the insert is the only point where "the id is mine" and
   "I hold the chain" are true together.
2. **An anchor upload failure fails the nightly run**, joining the invariant failures that
   `DEPLOYMENT §5` treats as a rollback trigger. Deliberate: the alternative is a green run whose
   tamper evidence never left the host.
3. **`AUDIT_ANCHOR_ENDPOINT/_REGION/_ACCESS_KEY_ID/_SECRET_ACCESS_KEY/_FORCE_PATH_STYLE` are an
   implementation addition** to a spec that named only `AUDIT_ANCHOR_BUCKET`/`_PREFIX` — flagged
   here, as `STORAGE_DRIVER` was in the M8 handoff, and added to the DEPLOYMENT §4 table so the
   names are recorded rather than implied.
4. **The anchor document is canonical JSON, field by field.** `JSON.stringify` of a row object would
   inherit key order from SQL, which would make the object's own hash meaningless.
5. **No `latest.json` pointer, ever.** Append-only is the property that makes the anchor evidence.

## 6. Failed attempts (so they are not repeated)

- **MinIO's binaries are no longer served.** `dl.min.io` returns `410 Gone` with the archived-project
  notice; the M8 handoff's "confirm against MinIO or R2" is no longer actionable as written. Use
  `rclone serve s3` locally, or the real bucket.
- **A stale-thinking trap worth recording:** the first two attempts to explain the forked chain
  assumed a *concurrency* bug, and the concurrency bug is real — but it was not the one producing the
  failure in the integration suite. What settled it was instrumenting the real path and reading the
  data: two login transactions, different xids, the second seeing `rowsInTable=0` on a table that had
  a committed row. That is impossible under concurrency alone, and it pointed straight at RLS. *A
  theory that explains the symptom is not a diagnosis until the data says so.*
- **`resetData()` in the test harness cannot be the explanation for the coach case either** — the
  failing rows are written by `beforeEach`'s own logins, sequentially, on a clean table.
- **The local PostgreSQL cluster had crash-recovered** (its backend died with `0xC0000142`; the
  postmaster reinitialised and then wedged, resetting every connection). If the suite reports
  everything *skipped*, it is the database, not the tests: `npm run db:status` can say "running" while
  the cluster is wedged, and `npm run db:down && npm run db:up` clears it.

## 7. Not done, and why

- **M7 (21 endpoints)** — still blocked on a dedicated phone number, unchanged. No code was written
  against guessed OpenWA behaviour.
- **CI has still never run** — still no remote. The workflow is unchanged and now covers a larger
  suite.
- **The 5k-invoice p95 has still never been measured** (M9), and this session's work adds a
  serialisation point that a performance pass should measure rather than assume: audited writes now
  run one at a time. The number to watch is the p95 of a write endpoint, not of a read.
- **The anchor is only as good as its bucket**: pointed at the files bucket by misconfiguration, it
  proves nothing. The variable names and the probe's `--anchor` mode exist to make that checkable.

## 8. Next steps

1. **Push so CI runs once** (needs a remote, `handoff.md` §5.8) — now covering 260 tests.
2. **Run `npm run storage:probe` and `npm run storage:probe -- --anchor` against the real bucket**
   before go-live, and decide the provider (`OPEN-016`).
3. **M7** the moment the number arrives — spike S1 first.
4. **M9** — performance sanity (including the audited-write path), security review, accessibility,
   the real-device pass.
5. The remaining small gaps: the invoice-health findings on `SYS-03`, the maintenance flag the
   documented rollback path needs (now more relevant, since a failed invariant or anchor is a
   rollback trigger), and `SENTRY_DSN`/metrics (OPEN-012).
