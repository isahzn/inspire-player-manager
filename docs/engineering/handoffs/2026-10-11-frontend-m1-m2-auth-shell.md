# HANDOFF 2026-10-11 — Frontend app shell (M1) + auth, guards, apiClient (M2)

Author: Hassen (frontend) · Frontend lead agent: Buffy · Milestone: M1 (frontend part) and M2 (frontend part)
Branch/PR: `frontend/` new app, uncommitted work tree · Plan: [FRONTEND_PLAN.md](../../../FRONTEND_PLAN.md)

## 1. Scope delivered

- **Fully implemented pages:** `/login` (PAGE_SPEC §1), `/accept-invite` (PAGE_SPEC §1), `/forgot-password` (static help per ROUTES), `/profile` (PAGE_SPEC §1 — password, sessions, TOTP), `/403`.
- **Placeholder pages (built, content pending):** `/dashboard` (owner money cards, hard-coded — Step 7 wires DSH-01/02), plus 16 guarded stubs: `/players`, `/sessions`, `/age-groups`, `/coach-attendance` (auth-only) and `/billing`, `/billing/new`, `/payments`, `/whatsapp`, `/reports`, `/users`, `/settings`, `/audit`, `/system`, `/coaches`, `/schedules`, `/imports/players` (auth + owner permission). 23 `page.tsx` files total; `not-found.tsx` covers `/404`.
- **Route-map paths NOT yet present (deliberate — they belong to Steps 3–8):** `/players/new`, `/players/[id]`, `/players/[id]/edit`, `/age-groups/[id]`, `/sessions/[id]`, `/billing/invoices/[id]`, `/billing/invoices/new`, `/payments/new`, `/payments/[id]`, `/whatsapp/messages/[id]`, `/reports/[name]`. Every `href` in the app resolves to a built route — verified by script (0 dead links, 2026-10-11).
- **Endpoint IDs consumed (no others invented):** AUTH-01, AUTH-02, AUTH-03, AUTH-04, AUTH-05, AUTH-06 (list + revoke), AUTH-07 (enroll/confirm/disable). All wrappers are named by contract ID (`auth01Login`, `auth03Me`, …) so reviews can trace them.
- **No migrations added** (frontend only). **No backend code touched.**
- **Mocks:** MSW handlers for the AUTH family returning the exact contract envelope + MOCK_DATA shapes, incl. `INVALID_CREDENTIALS`, `ACCOUNT_LOCKED`, `RATE_LIMITED`, `VALIDATION_ERROR`, `UNAUTHENTICATED` (all named in the contract) and three assumed codes — see §4.
- **Docs read before starting:** `CLAUDE.md`, `README.md`, `docs/engineering/PROJECT_STATUS.md`, `IMPLEMENTATION_PLAN.md`, `DECISIONS.md`, `KNOWN_RISKS.md`, `OPEN_DECISIONS.md`, `FRONTEND_KICKOFF.md`, `FRONTEND_BUILD_GUIDE.md`, `MOCK_DATA.md`, `HANDOFF_TEMPLATE.md`, `docs/frontend/ROUTES_AND_NAVIGATION.md`, `PAGE_SPECIFICATIONS.md`, `DESIGN_SYSTEM.md`, `API_INTEGRATION.md`, `docs/architecture/API_CONTRACTS.md`, `AUTH_AND_PERMISSIONS.md` §4. Repo inspected before assuming (no `package.json`, no logo — both confirmed absent 2026-10-11).

## 2. Evidence

- **Automated checks run 2026-10-11, all green (exit 0):** `npm run typecheck` · `npm run lint` · `npm run build` (23 routes prerendered) · `npm run verify:e2e`.
- **Dead-link audit (script, 2026-10-11): 0 dead links.** This check found and fixed one real bug: the dashboard's "New billing run" button pointed at `/billing/new`, which did not exist. Added the guarded `/billing/new` placeholder; verified owner can reach it and coach gets the 403 state.
- **`npm run verify:e2e` — 12/12 PASS** (Playwright driving system Chrome against the running app in mock mode, `frontend/.verify/step2-e2e.mjs`):
  logged-out `/dashboard` → `/login?next=`; generic error on bad credentials (no field reveal); `TOTP_REQUIRED` path reveals the code field then reaches dashboard; owner dashboard shows Invoiced and Collected as separate numbers; owner nav shows Billing/Users and `/billing` opens; coach nav hides Billing/Users and `/billing` renders the inline 403 state **without calling owner APIs**; coach can open `/sessions`; ACCOUNT_LOCKED message; profile shows password + sessions + TOTP.
- **Manual checks:** 360 × 740 and 1280 × 800 rendering via screenshots (`frontend/.verify/login-360.png`, `dashboard-owner-1280.png`, `billing-coach-403-360.png`, `profile-360.png`); manual keyboard tab-through of login, profile and 403 flows; no automated axe scan (see §5).
- **No T-ID test matrix exists yet** for frontend (TESTING_AND_ACCEPTANCE is spec-only), so this handoff cites the E2E script instead of T-IDs. Flagged in §5.

## 3. Deviations from the spec

| Spec ref | What differs | Why | Needs spec change? (CR-###) |
|---|---|---|---|
| DESIGN_SYSTEM §3 (typography) | Web fonts are **not** loaded via `next/font/google`; system stacks are used with Poppins/Inter named first | The build failed fetching fonts.googleapis.com in this offline environment (`next/font` error). Self-hosting via `next/font/local` is the fix and is planned with OPEN-001 brand fonts | Not yet — no visual regression observed at 360 px; raise CR only if the owner wants the exact webfont metrics before then |
| DESIGN_SYSTEM §2 / OPEN-001 (brand) | Text wordmark + placeholder pitch-green palette shipped | No logo or brand colours supplied (OPEN-001); nothing was invented | No — matches the documented safe default |
| FRONTEND_BUILD_GUIDE §2 (structure) | App lives in `frontend/` instead of repo root | Repo is docs-only; keeps the architecture memory clean. Recorded as assumption A1 in FRONTEND_PLAN | No |
| ADR-009 (contract ownership) | Types hand-written from API_CONTRACTS §2 | `api/openapi.yaml` does not exist yet (M1 backend not delivered) | No — explicitly the documented interim path |

No other deviations. No spec was amended by this work.

## 4. Contract drift / requests  ← needs Claude/Freebuff attention

- **GAP-1 — AUTH-06 has no response shape.** API_CONTRACTS §2 defines no session type, so the frontend invented `AuthSession = { id, createdAt, lastSeenAt, ip?, userAgent?, current }`. Please add the type to API_CONTRACTS (and `openapi.yaml`), or correct the field names.
- **GAP-2 — `TOTP_REQUIRED` is not a documented error code.** PAGE_SPEC §1 requires the TOTP field to appear only when the server asks, but AUTH-01's note lists only `INVALID_CREDENTIALS` and `ACCOUNT_LOCKED`. The frontend assumes **401 `TOTP_REQUIRED`**. Needs to be codified or renamed.
- **GAP-3 — `INVITE_INVALID` is not a documented error code.** PAGE_SPEC §1 requires an invalid/expired-token message; AUTH-05 says only "single-use; rate-limited". The frontend assumes **404 `INVITE_INVALID`** (404 also keeps us consistent with the "don't reveal existence" rule).
- **GAP-4 — how `SESSION_EXPIRED` reaches the client.** API_INTEGRATION §2 requires a re-login modal mid-action, but no contract row says which status/code signals it (`401 SESSION_EXPIRED` vs `401 UNAUTHENTICATED`). The frontend currently only treats a 401 during app-start/refresh as signed-out and has a dormant `reportSessionExpired()` hook waiting for the agreed code.
- **No backend expectations blocked:** nothing in the mocks contradicts a documented shape; these four are additive.
- **Note for Freebuff:** mock sessions mirror ADR-004 cookie sessions, but MSW page-thread resolvers cannot read `Cookie` headers, so the mock's session-of-record is `localStorage ia_mock_role` (dev-only, gated by `NEXT_PUBLIC_USE_MOCKS`). No effect on the real client, which always uses `credentials: 'include'`.

## 5. Known gaps and risks

- **No automated accessibility scan.** axe is not installed; only manual keyboard/contrast review was done. DESIGN_SYSTEM §8 requires axe in CI. Scheduled with the Step 3 screens; not claimed as done anywhere.
- **No frontend test matrix.** `npm run verify:e2e` is a browser script, not a T-ID suite; it does not yet run in CI. Vitest (money/dates → T-UI-01) arrives in Step 5.
- **Screenshots were size-sanity-checked, not visually reviewed pixel-by-pixel.**
- **Dashboard numbers are hard-coded placeholders** (Step 7 wires DSH-01/02). They are labelled "mock data" on screen but must not be mistaken for wired figures.
- **Detail routes are not built yet** — see §1 for the explicit list; the 16 placeholder pages render a "Coming in the next slice" card, not real screens.
- **Mock-only session helper** (`ia_mock_role`) exists solely to demo role guards; production auth is cookie-based via the real API.
- **OPEN-021 still unanswered** — the Next.js safe default is being built on; a counter-proposal would invalidate the app shell.

## 6. How to run / verify

```bash
cd frontend
npm install
npm run dev            # http://localhost:3100  (mock mode via NEXT_PUBLIC_USE_MOCKS=true)
npm run typecheck && npm run lint && npm run build
npm run verify:e2e     # needs `npm run dev` already listening on :3100
```
Mock accounts (any password): `owner@example.test` · `coach@example.test` · `totp@example.test` (asks for a code) · `locked@example.test`. Invite token: `valid-invite-token`. Switch roles in-app via the sidebar "Switch to Coach/Owner view (mock)". Screenshots land in `frontend/.verify/` (PNGs gitignored, script tracked).

## 7. Next steps (exact)

1. **Claude:** confirm GAP-1…GAP-4 (or correct them) and update API_CONTRACTS + the frontend docs together; note ADR-009 still gates on `openapi.yaml`.
2. **Hassen/owner:** answer OPEN-021 (stack) and OPEN-001 (logo) so the palette and fonts can be finalised.
3. **Frontend:** Step 3 — players list/register/profile (duplicate warning PLY-08, group suggestion GRP-05), groups + fees, coaches, import wizard, with MSW PLY/GRP/GDN handlers.
4. **Freebuff:** when M1 backend lands, deliver `api/openapi.yaml` so hand-written types in `src/api/types.ts` are replaced by generated ones.

## 8. Reviewer checklist (Claude/Hassen fills)

[ ] Compared to DATABASE/API docs  [ ] Permissions verified by route matrix  [ ] No money floats
[ ] Audit rows present  [ ] Tests evidence reviewed  [ ] PROJECT_STATUS updated  [ ] Verdict: accepted / changes requested
