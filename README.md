# Inspire Academy Management System — Architecture & Documentation

Secure, mobile-first management system for **Inspire Academy** (football): players & guardians, age groups, coaches, sessions & attendance, coach check-in, fees/invoices/payments/receipts (LKR), PDF documents, WhatsApp invoice delivery & reminders via OpenWA, reports, audit.

> **This repository is primarily documentation.** A frontend app now exists under `frontend/` (app shell + auth slice, against mocks); no backend code exists yet. See [Project status](docs/engineering/PROJECT_STATUS.md) for what is planned vs implemented vs verified.

## Scope
**In:** owner and coach roles; players, guardians, groups, assignments; sessions/attendance/coach time; billing, invoices, payments (partial/multi-invoice/credit), receipts, proofs; PDFs; OpenWA messaging; dashboard/reports/CSV; users, permissions, audit; backups/ops.
**Out (unless changed via [CHANGE_MANAGEMENT](docs/engineering/CHANGE_MANAGEMENT.md)):** public website, parent portal/logins, online payment gateway, accounting software, multi-tenant SaaS, native mobile apps, AI features.

## Who does what
| Who | Responsibility |
|---|---|
| **Claude** | Architecture, specifications, rules, testing strategy, documentation, change management |
| **Freebuff** | Backend implementation to the spec (API, DB, billing engine, worker, PDFs, OpenWA) |
| **Hassen** | Frontend implementation; operations/deployment; product owner |

## Documentation map
| Area | Files |
|---|---|
| Rules & process | [CLAUDE.md](CLAUDE.md) · [CHANGE_MANAGEMENT](docs/engineering/CHANGE_MANAGEMENT.md) · [CONTINUATION_GUIDE](docs/engineering/CONTINUATION_GUIDE.md) |
| Architecture | [OVERVIEW](docs/architecture/OVERVIEW.md) · [DATABASE](docs/architecture/DATABASE.md) · [API_CONTRACTS](docs/architecture/API_CONTRACTS.md) · [AUTH_AND_PERMISSIONS](docs/architecture/AUTH_AND_PERMISSIONS.md) · [BILLING_ENGINE](docs/architecture/BILLING_ENGINE.md) · [ATTENDANCE](docs/architecture/ATTENDANCE.md) · [OPENWA_INTEGRATION](docs/architecture/OPENWA_INTEGRATION.md) · [FILES_AND_PDF](docs/architecture/FILES_AND_PDF.md) · [PAYMENT_VERIFICATION](docs/architecture/PAYMENT_VERIFICATION.md) · [SECURITY_AND_PRIVACY](docs/architecture/SECURITY_AND_PRIVACY.md) · [DEPLOYMENT_AND_OPERATIONS](docs/architecture/DEPLOYMENT_AND_OPERATIONS.md) |
| Frontend | [ROUTES_AND_NAVIGATION](docs/frontend/ROUTES_AND_NAVIGATION.md) · [PAGE_SPECIFICATIONS](docs/frontend/PAGE_SPECIFICATIONS.md) · [DESIGN_SYSTEM](docs/frontend/DESIGN_SYSTEM.md) · [API_INTEGRATION](docs/frontend/API_INTEGRATION.md) |
| Engineering & QA | [IMPLEMENTATION_PLAN](docs/engineering/IMPLEMENTATION_PLAN.md) · [BACKEND_BUILD_GUIDE](docs/engineering/BACKEND_BUILD_GUIDE.md) · [FRONTEND_BUILD_GUIDE](docs/engineering/FRONTEND_BUILD_GUIDE.md) · [TESTING_AND_ACCEPTANCE](docs/engineering/TESTING_AND_ACCEPTANCE.md) |
| Decisions & risk | [DECISIONS](docs/engineering/DECISIONS.md) · [OPEN_DECISIONS](docs/engineering/OPEN_DECISIONS.md) · [KNOWN_RISKS](docs/engineering/KNOWN_RISKS.md) · [PROJECT_STATUS](docs/engineering/PROJECT_STATUS.md) |
| Kickoff & helpers | [FREEBUFF_KICKOFF](docs/engineering/FREEBUFF_KICKOFF.md) · [FRONTEND_KICKOFF](docs/engineering/FRONTEND_KICKOFF.md) · [HANDOFF_TEMPLATE](docs/engineering/HANDOFF_TEMPLATE.md) · [MOCK_DATA](docs/engineering/MOCK_DATA.md) · [CSV_IMPORT](docs/engineering/CSV_IMPORT.md) |

## Current status (2026-10-12)
M0 (audit, requirements, decisions) done — greenfield, no logo supplied. Documentation draft v1 written; **awaiting M1 review** (contract finalisation, OpenAPI). Messaging provider is **OpenWA**, not WAHA ([ADR-017](docs/engineering/DECISIONS.md#adr-017), change record CR-001). Frontend: app shell + auth slice built and verified, and sign-in is now **username**-based ([ADR-018](docs/engineering/DECISIONS.md#adr-018), change record CR-002 — [handoff](docs/engineering/handoffs/2026-10-12-username-login.md)). Backend, tests, deployment: **not started**. **CR-003** — coach clock in/out on the dashboard, per-automation WhatsApp switches (invoices · late reminders · bank-transfer verification), and mobile as a shipping requirement — is written into the affected specs but **awaiting owner approval**; nothing is built from it yet ([handoff](docs/engineering/handoffs/2026-10-12-plan-changes-cr003.md)). **CR-004** closes OPEN-022 in the owner's words ("always ask for a PDF"): a bank transfer is now specified to be verified by reading the **bank's PDF e-receipt** — deterministic extraction + cross-check, advisory only, an owner still confirms ([PAYMENT_VERIFICATION](docs/architecture/PAYMENT_VERIFICATION.md), [ADR-021](docs/engineering/DECISIONS.md#adr-021)). Open owner decisions: [OPEN_DECISIONS](docs/engineering/OPEN_DECISIONS.md).

## Quick start for a developer reading this
1. Read [OVERVIEW](docs/architecture/OVERVIEW.md) (15 min), then [BILLING_ENGINE](docs/architecture/BILLING_ENGINE.md) §1–§4 and [AUTH_AND_PERMISSIONS](docs/architecture/AUTH_AND_PERMISSIONS.md) §4 — they carry the highest-risk rules.
2. Backend: follow [BACKEND_BUILD_GUIDE](docs/engineering/BACKEND_BUILD_GUIDE.md) and start with [FREEBUFF_KICKOFF](docs/engineering/FREEBUFF_KICKOFF.md). Frontend: [FRONTEND_BUILD_GUIDE](docs/engineering/FRONTEND_BUILD_GUIDE.md) and [FRONTEND_KICKOFF](docs/engineering/FRONTEND_KICKOFF.md).
3. Contract: `docs/architecture/API_CONTRACTS.md` is authoritative until M1 exits, then `api/openapi.yaml`.
4. Anything unclear or wrong → HANDOFF report / change request; don't guess.
