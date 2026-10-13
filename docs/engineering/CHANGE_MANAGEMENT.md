# CHANGE_MANAGEMENT

> **Status:** Draft v1 · **Owner:** Claude (runs the process), Hassen (approves) · **Updated:** 2026-10-11
> Mandatory for any change to requirements, architecture, schema, API, permissions, billing rules, security controls or scope — whoever proposes it (Hassen, Freebuff, Claude).

## 1. Procedure (follow in order)

1. **Read** [CLAUDE.md](../../CLAUDE.md), [PROJECT_STATUS](PROJECT_STATUS.md), [DECISIONS](DECISIONS.md), this file.
2. **Read** the architecture docs touched (use the matrix in §3) and **inspect the actual repository** (never assume Freebuff followed the spec: compare real migrations/routes with DATABASE/API docs first).
3. **Write a Change Request** (template §6) in the PR/issue or at the bottom of `PROJECT_STATUS` "Pending changes".
4. **Impact analysis** — identify affected: requirements, tables/columns/constraints, endpoints/payloads, permissions & RLS, frontend routes/pages/components, mock data, tests & acceptance rows, deployment/env vars, costs, existing data (migration needed?), open decisions.
5. **Explain** benefits, risks, implementation cost, compatibility impact; **prefer the smallest change that safely meets the need**. Offer the "do nothing / config-only" alternative.
6. **Decide**: Hassen approves (business-policy items go to the named decider in OPEN_DECISIONS). Silent consequential decisions are forbidden.
7. **Record**: new/updated ADR in DECISIONS (consequential), resolve or add OPEN-xxx.
8. **Update every affected source-of-truth document in the same change** (§3). Never leave two documents contradicting each other. If two docs define the same contract, only one is the source; the other links.
9. **Update tests**: acceptance rows (T-IDs), traceability matrix, mock data, contract file.
10. **Update** PROJECT_STATUS (what changed, what is now pending) and, if the resume path changed, CONTINUATION_GUIDE.
11. **Existing implementation:** state explicitly whether it needs a migration, data conversion, compatibility layer, or regression test; don't overwrite completed work just to match a preference without that analysis.
12. **Verify** after implementation: reviewed artifact or passing tests; mark complete only with evidence.

## 2. Impact classification

| Class | Examples | Approval | Extra requirements |
|---|---|---|---|
| **C0 Editorial** | typo, clarification with no behavioural change | Claude | note in status |
| **C1 Compatible** | add optional field/endpoint, new report, copy changes | Hassen | docs + tests + mock data updated together |
| **C2 Policy/behaviour** | billing/age rules, permission change, retention, messaging policy | Hassen **and** named decider (OPEN) | ADR, test updates, owner sign-off recorded |
| **C3 Breaking** | rename/remove field, change meaning/type, status enum change, schema change needing data migration, auth model change | Hassen | migration + rollback plan (§5), version strategy, coordinated release |
| **C4 Scope** | anything in the out-of-scope list (portal, gateway, multi-tenant, mobile apps) | Hassen, written | cost/time impact first; avoid unless essential |

## 3. Documents that must be updated together

| Change touches | Update all of |
|---|---|
| Table/column/constraint | DATABASE → API_CONTRACTS (types) → AUTH (if RLS/permission) → relevant domain doc (BILLING/ATTENDANCE/OPENWA/FILES) → TESTING rows → MOCK_DATA → PROJECT_STATUS |
| Endpoint/payload/error code | API_CONTRACTS (and `openapi.yaml` after M1) → PAGE_SPECIFICATIONS/API_INTEGRATION → MOCK_DATA → TESTING → AUTH route permission list |
| Permission/role | AUTH matrix → API_CONTRACTS route auth column → DATABASE §7 RLS → ROUTES_AND_NAVIGATION → PAGE_SPEC → TESTING (T-AUTH, T-DB-RLS) |
| Billing/payment rule | BILLING_ENGINE (worked examples!) → DATABASE (constraints) → API_CONTRACTS → PAGE_SPEC labels → TESTING (T-FIN) → DECISIONS/OPEN |
| Messaging behaviour | OPENWA_INTEGRATION → DATABASE §3.6 → API §3.7 → PAGE_SPEC §9 → TESTING (T-MSG) |
| Deployment/env var | DEPLOYMENT_AND_OPERATIONS → SECURITY (secrets inventory) → BACKEND_BUILD_GUIDE → `.env.example` |
| Scope/timeline | IMPLEMENTATION_PLAN → PROJECT_STATUS → KNOWN_RISKS → README |
| UI-only | PAGE_SPEC/DESIGN_SYSTEM/ROUTES (+ API_INTEGRATION if client behaviour) → TESTING (T-UI) |

## 4. Files to read before a change (minimum)
Always: CLAUDE.md, PROJECT_STATUS, DECISIONS, CHANGE_MANAGEMENT. Then per §3 row, plus KNOWN_RISKS and OPEN_DECISIONS, and the **actual code** for affected modules.

## 5. Breaking changes: migration and rollback plan (required content)
1. What breaks and for whom (frontend versions, Freebuff modules, stored data, in-flight jobs, issued PDFs/links).
2. Strategy: **expand → migrate/backfill → contract** across ≥ 2 releases; API: new field/endpoint first, then switch consumers, then remove; if unavoidable `/api/v2` with ≥ 90-day overlap ([API_CONTRACTS](../architecture/API_CONTRACTS.md) §1).
3. Data conversion script (idempotent, dry-run, row counts, invariant job before/after).
4. Backup point taken immediately before; restore rehearsed on staging.
5. Rollback: previous app image + compatible schema, or PITR/compensating migration; define the decision point and criteria.
6. Test plan: new tests + regression of affected T-IDs; contract tests against both versions during overlap.
7. Communication: HANDOFF note to Hassen/Freebuff, owner notice if behaviour is visible.

## 6. Change Request template
```
CR-### Title:
Proposed by / date:
Problem & requirement:
Smallest proposed change:
Alternatives (incl. do nothing):
Class (C0–C4):
Impact: requirements | DB | API | permissions/RLS | frontend | tests | deploy/cost | existing data
Compatibility/migration/rollback:
Docs to update:
Decision (who/when) → ADR/OPEN link:
Implementation evidence (PR/tests):
```

## 7. Avoiding scope creep and conflicting specs
- Out-of-scope list in [README](../../README.md) and CLAUDE.md is binding; C4 needs written approval.
- No "while we're here" additions inside unrelated PRs.
- One source of truth per contract; others link, never copy long definitions.
- Each ADR is changed only by a new superseding ADR.
- Weekly (or per-milestone) consistency check: grep the docs for each table/endpoint name changed; run the doc lint checklist in CONTINUATION_GUIDE §6.
