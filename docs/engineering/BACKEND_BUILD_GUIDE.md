# BACKEND_BUILD_GUIDE (for Freebuff)

> **Status:** Draft v1 · **Owner:** Claude (spec) / Freebuff (builds) · **Updated:** 2026-10-11
> You implement the backend **to the documents**, you do not reinterpret them. When something is ambiguous or wrong, stop and report (HANDOFF), don't guess.

## 1. Read first (in order)
1. [CLAUDE.md](../../CLAUDE.md) — rules that must never be violated.
2. [PROJECT_STATUS](PROJECT_STATUS.md), [IMPLEMENTATION_PLAN](IMPLEMENTATION_PLAN.md) (your current milestone), [DECISIONS](DECISIONS.md), [OPEN_DECISIONS](OPEN_DECISIONS.md).
3. [DATABASE](../architecture/DATABASE.md), [BILLING_ENGINE](../architecture/BILLING_ENGINE.md), [AUTH_AND_PERMISSIONS](../architecture/AUTH_AND_PERMISSIONS.md), [API_CONTRACTS](../architecture/API_CONTRACTS.md) (then `api/openapi.yaml` after M1).
4. For your task: [ATTENDANCE](../architecture/ATTENDANCE.md), [FILES_AND_PDF](../architecture/FILES_AND_PDF.md), [OPENWA_INTEGRATION](../architecture/OPENWA_INTEGRATION.md), [SECURITY_AND_PRIVACY](../architecture/SECURITY_AND_PRIVACY.md), [DEPLOYMENT_AND_OPERATIONS](../architecture/DEPLOYMENT_AND_OPERATIONS.md), [TESTING_AND_ACCEPTANCE](TESTING_AND_ACCEPTANCE.md).

## 2. What to inspect before coding each task
- Current repo state (`git status`, last commits, existing migrations, existing routes) and PROJECT_STATUS — don't redo finished work.
- The acceptance tests (T-IDs) for the task: write/outline them **first**.
- Any HANDOFF reports from the frontend dev mentioning your endpoints.

## 3. Implementation sequence (per milestone slice)
1. **Migration**: one migration for the slice's tables exactly as in DATABASE (names, types, CHECKs, UQs, exclusion constraints, indexes, RLS policies, grants). Header comment: purpose, rollback approach. Apply from empty and on previous schema in CI.
2. **DB tests first** for constraints/RLS/triggers of the slice (T-DB-*, T-FIN-12).
3. **Schemas**: Zod request/response schemas named per endpoint ID; OpenAPI generated; unknown fields rejected on mutating routes.
4. **Domain services** (pure rules separated from I/O): billing eligibility, period/due math, allocation, retry classification — unit-test heavily.
5. **Endpoints**: register each route with `{ id, permission, scope resolver, schema, idempotent? }` in the route registry (deny by default). Handler order: authenticate → CSRF/Origin → permission → scope → validate → transaction (set RLS context) → service → audit → serialize with the role-specific projection.
6. **Audit**: use a single `audit.record()` inside the same transaction; mutation without audit fails the test suite for routes flagged `mutating`.
7. **Integration + contract tests** for the endpoint; update PROJECT_STATUS evidence only after green CI.

## 4. Rules for enforcing permissions
- Never trust ids from the client: resolve the owning group/entity server-side and check scope; out-of-scope ⇒ 404.
- Never return full rows: use explicit projections (`PlayerOwnerView`, `PlayerCoachView`).
- Always set `SET LOCAL app.user_id/app.role` before queries; connect with `ia_app`, never a superuser. Verify in startup self-check that the role lacks `BYPASSRLS`.
- Sort/filter fields come from allow-lists; all SQL parameterized.

## 5. Transactions, billing and money (read BILLING_ENGINE twice)
- Implement T1–T10 exactly as in DATABASE §8: **lock order payment → invoices ascending id**; no HTTP calls inside transactions; retry on `40001`/`40P01` up to 3×.
- Idempotency middleware for every **Idem** route: reserve key row (`in_progress`) → run → store response; concurrent same-key request waits/returns 409-in-progress then replays.
- Money only as integer minor units; ESLint/semgrep rule banning `parseFloat`, `Number(` on money fields, and `toFixed` for arithmetic.
- Concurrency tests (T-FIN-02, 06, 16) must run in CI repeatedly (e.g., 50 iterations) — flaky = bug.
- Add the nightly invariant job in M5, not later.

## 6. Files, PDF, storage
Spike P1 first; per FILES_AND_PDF. Validate by magic bytes, re-encode images, private bucket, short signed URLs, audited reads. Generator self-check on totals. Use a local MinIO container in dev/CI.

## 7. OpenWA
Do spike S1 first and record results ([OPENWA_INTEGRATION](../architecture/OPENWA_INTEGRATION.md) §2 — items **O18–O22** are still open, including session status values and delivery semantics). Implement the provider port; keep the **mock provider** as a first-class implementation used by all automated tests. Follow §6–§9 of the OpenWA doc for queue claim, retry classification, webhook verification (`X-OpenWA-Signature: sha256=<hex>`, HMAC-SHA256 over the exact raw body, constant-time compare), delivery-state monotonicity, consent checks, pacing.

**Do not carry over WAHA's provider facts** — its `X-Webhook-Hmac`/SHA-512 signing, its `-1…4` ack enum and its `WORKING`/`SCAN_QR_CODE` status names are invalid for OpenWA (O5, O18, O19). Until S1 confirms delivery semantics (O19), the adapter may emit only `server_accepted` — never `device_delivered`/`read` — so the UI cannot claim "Delivered" on an assumption. Never log keys/phones/bodies.

## 8. Logging, errors, config
Structured JSON logs with `requestId`; mask phones; never log secrets/cookies/bodies of proofs. Central error handler maps domain errors to the contract's codes; unknown errors ⇒ `INTERNAL_ERROR` without internals. Config validated at startup (fail fast). Provide `.env.example`, `docker-compose.yml` for dev (Postgres, MinIO, mock messaging provider), seeds per DATABASE §10.

## 9. How to report completed work
After each task/PR fill [HANDOFF_TEMPLATE](HANDOFF_TEMPLATE.md): endpoints implemented (IDs), migrations, tests run + results (paste summary), **deviations from the spec** (must be none unless approved), new/changed contract items, known gaps, how to run. Claude (or Hassen) verifies against the spec before marking anything complete. Don't edit architecture docs yourself except `PROJECT_STATUS` evidence lines — propose changes via CHANGE_MANAGEMENT.
