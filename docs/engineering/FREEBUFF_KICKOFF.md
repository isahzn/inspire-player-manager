# FREEBUFF_KICKOFF — exact first instructions for the backend implementer

> Paste the block below to Freebuff. Hassen is the product owner; Claude maintains the specs.

```
You are implementing the BACKEND of the Inspire Academy management system. You are NOT designing it:
the architecture is in this repository. Work from the documents; report instead of guessing.

READ, in order:
1. CLAUDE.md
2. docs/engineering/PROJECT_STATUS.md, IMPLEMENTATION_PLAN.md, DECISIONS.md, OPEN_DECISIONS.md
3. docs/architecture/DATABASE.md, BILLING_ENGINE.md, AUTH_AND_PERMISSIONS.md, API_CONTRACTS.md
4. docs/engineering/BACKEND_BUILD_GUIDE.md and TESTING_AND_ACCEPTANCE.md

CURRENT MILESTONE: M1 (no application code yet), then M2.

M1 TASKS (documentation/verification only — do not write app code):
 1. Review DATABASE, BILLING_ENGINE, AUTH, API_CONTRACTS for implementability. List every ambiguity, contradiction,
    missing field/endpoint, or unsafe rule (cite file + section). Do not silently fix: report.
 2. Verify against CURRENT OFFICIAL DOCS the technical claims we did not verify (PostgreSQL RLS/exclusion constraints/
    SKIP LOCKED/advisory locks, Fastify/Zod/OpenAPI tooling, argon2id parameters, S3-compatible presigned URLs, chosen
    migration tool). Record sources + date in docs/engineering/DECISIONS.md. Confirm or counter-propose ADR-001 and ADR-008.
 3. Produce api/openapi.yaml (OpenAPI 3.1) from API_CONTRACTS.md: every endpoint ID, schemas for all shared types, the
    error format, pagination, the Idempotency-Key header. It must validate with a linter. Frontend will review it.
 4. Write your findings in a HANDOFF report (docs/engineering/HANDOFF_TEMPLATE.md) under docs/engineering/handoffs/.

M1 EXIT = openapi.yaml validated + zero unresolved gaps + frontend dev sign-off.

M2 (starts only after M1 exit): repo + CI, migration tooling, base schema, DB roles + RLS framework, auth/sessions/CSRF,
route permission registry, error format, health endpoints, create-owner CLI, mock messaging provider. Evidence required:
T-AUTH-01,02,07,08,09; T-DB-RLS-03; T-SEC-01,02,05 (see TESTING_AND_ACCEPTANCE.md).

NON-NEGOTIABLE: money = integer minor units; server-side permission checks + RLS; invoices immutable snapshots;
proof != payment; no HTTP calls inside financial transactions; no secrets in logs/frontend; OpenWA only behind the provider port (see docs/architecture/OPENWA_INTEGRATION.md).
Changes to the plan go through docs/engineering/CHANGE_MANAGEMENT.md. Never mark work done without test evidence.
```
