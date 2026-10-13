# FRONTEND_BUILD_GUIDE (for Hassen)

> **Status:** Draft v1 · **Owner:** Claude (spec) / Hassen (builds) · **Updated:** 2026-10-11

## 1. Read first (in order)
1. [CLAUDE.md](../../CLAUDE.md), [PROJECT_STATUS](PROJECT_STATUS.md), [IMPLEMENTATION_PLAN](IMPLEMENTATION_PLAN.md) (current milestone).
2. [ROUTES_AND_NAVIGATION](../frontend/ROUTES_AND_NAVIGATION.md), [PAGE_SPECIFICATIONS](../frontend/PAGE_SPECIFICATIONS.md), [DESIGN_SYSTEM](../frontend/DESIGN_SYSTEM.md), [API_INTEGRATION](../frontend/API_INTEGRATION.md).
3. Contract: [API_CONTRACTS](../architecture/API_CONTRACTS.md) (→ `api/openapi.yaml` after M1), [AUTH_AND_PERMISSIONS](../architecture/AUTH_AND_PERMISSIONS.md) §4, [BILLING_ENGINE](../architecture/BILLING_ENGINE.md) §10–§12 (labels/definitions), [MOCK_DATA](MOCK_DATA.md).

## 2. Project structure (suggested, framework-agnostic)
```
src/
  api/           # client.ts (fetch wrapper), one file per area; functions named by endpoint ID
  api/types/     # generated from openapi.yaml (hand-written until M1 exit)
  lib/           # money.ts, dates.ts, phone.ts, idempotency.ts, errors.ts (code→copy catalogue)
  features/      # players/, groups/, sessions/, billing/, payments/, whatsapp/, reports/, admin/
  components/    # design-system components (DESIGN_SYSTEM §6)
  app or routes/ # route files mirroring ROUTES_AND_NAVIGATION
  mocks/         # MSW handlers + fixtures from MOCK_DATA
```
Feature folders own their queries, forms and components; shared UI only in `components/`.

## 3. Build sequence
1. **M1:** scaffold; tokens; AppShell; `apiClient` with CSRF/credentials/error mapping; MSW with login + `me`; unit tests for `money.ts`, `dates.ts`.
2. **M2:** login, accept-invite, profile, route guards from `permissions`, 401/403/404 states.
3. **M3:** players list/register (duplicate dialog, group suggestion chip), profile tabs, groups/fees, coaches, import wizard.
4. **M4:** sessions list, **attendance sheet first as a mobile prototype** (test on a real phone), check-in bar, draft persistence.
5. **M5:** billing wizard (preview → issue), invoices list/detail, record payment + allocation editor, payments list/detail.
6. **M6:** PDF open/download, proof upload with camera capture, receipts.
7. **M7:** WhatsApp pages, status banners, manual fallback helper.
8. **M8:** dashboards, reports, audit, system health.
9. **M9–M10:** a11y/E2E, polish, real-device checks.

## 4. How to implement the tricky screens
- **Forms:** schema (Zod/Valibot) for UX validation; map server `details[].field`; version echo; unsaved guard; idempotency key per form-open (API_INTEGRATION §4).
- **Tables:** URL-synced state; cards on mobile; never client-side filter across pages.
- **Dashboard:** keep Invoiced vs Collected visually separate; show "as of now" tags; link every number to a pre-filtered list.
- **Attendance:** local draft, optimistic UI only for local selection state, server result is source of truth; reason prompt on edits of saved rows.
- **Billing/payments:** no optimistic updates; show server totals; allocation editor validates live but server decides; confirm dialogs list consequences.
- **Messaging:** exact status/delivery labels from PAGE_SPEC §9; never infer "delivered".
- **Permissions:** hide what the role can't do **and** handle 403/404; never rely on hiding.

## 5. Testing against the backend contract without inventing endpoints
- Develop against MSW handlers that mirror the contract exactly (shape + errors + pagination meta). A script validates mock responses against the schema.
- Switch `NEXT_PUBLIC_USE_MOCKS=false` (name suggested) to hit staging; run the same Playwright flows in both modes.
- If you need a field/endpoint that isn't in the contract: **do not add it locally.** File a HANDOFF "contract request" → Claude runs CHANGE_MANAGEMENT → docs + OpenAPI updated → Freebuff implements → you consume.
- When the real backend differs from the contract, record it as a "contract drift" in the HANDOFF report; don't code around it silently.

## 6. Definition of done for a screen
Spec'd states all present (loading/empty/error/403/success) · mobile + desktop checked · keyboard + axe pass · money/date helpers used · no direct fetch outside `api/` · tests per T-UI IDs · HANDOFF note.
