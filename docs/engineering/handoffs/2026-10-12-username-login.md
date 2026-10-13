# HANDOFF 2026-10-12 — Username login (CR-002): `email` dropped as the login identifier

Author: Buffy (frontend lead) · Milestone: M1/M2 (contract correction + frontend slice) · Change record: **CR-002** · ADR: [ADR-018](../DECISIONS.md#adr-018)
Branch/PR: none — **this project has no tracked files** (`git ls-files .` → 0; the whole folder is untracked in the workspace repo), so there is no diff to review · Plan: [FRONTEND_PLAN.md](../../../FRONTEND_PLAN.md) §10

## 1. Scope delivered

- **CR-002 implemented (class C3):** `username` replaces `email` as the login identifier; user records have **no** email field. Requested by Hassen 2026-10-12 ("instead of `owner@example.com` it's just `owner`").
- Endpoint IDs touched (spec, not code): **AUTH-01** `{username,password,totpCode?}` · **USR-02** `{username,fullName,phone?,role}` · the `User` type.
- **Code changed:** `src/app/login/page.tsx` (field, label, state, error copy, mock-account hint) · `src/api/client.ts` (`auth01Login`) · `src/api/types.ts` (`User.username`) · `src/lib/auth.tsx` (login input type, `resolveReLogin`, `switchMockRole`, re-login modal text) · `src/lib/mock.ts` (fixtures `owner` / `coach`) · `src/mocks/handlers.ts` (AUTH-01 matching on username + error copy) · `src/app/profile/page.tsx` (subtitle) · `.verify/step2-e2e.mjs` (selectors + mock logins) · `package.json` (`dev` now pins `-p 3100`).
- **Spec changed in the same change (per [CHANGE_MANAGEMENT](../CHANGE_MANAGEMENT.md) §3):** `API_CONTRACTS` §2 + AUTH-01 + USR-02 · `DATABASE` §3.1 `users` · `AUTH_AND_PERMISSIONS` §1 · `PAGE_SPECIFICATIONS` §1 + Users · `MOCK_DATA` · `DEPLOYMENT_AND_OPERATIONS` §9 (`create-owner --username`) · `DECISIONS` (ADR-018 + index rows 017/018) · `OPEN_DECISIONS` (OPEN-022 added) · `PROJECT_STATUS` (CR-002) · `FRONTEND_PLAN` · this handoff.
- **Migrations added: none** (no backend exists). **No unrelated feature touched.**
- Docs read before starting: `CLAUDE.md`, `README.md`, `PROJECT_STATUS`, `CONTINUATION_GUIDE`, `CHANGE_MANAGEMENT`, `DECISIONS`, `OPEN_DECISIONS`, `API_CONTRACTS`, `DATABASE`, `AUTH_AND_PERMISSIONS`, `PAGE_SPECIFICATIONS`, `MOCK_DATA`, `DEPLOYMENT_AND_OPERATIONS`, `FRONTEND_PLAN`, and the 2026-10-11 frontend handoff. The real repository was inspected first (every `email` occurrence in code and docs was enumerated) rather than assuming — that is how the academy-contact `email` was separated from the credential.

## 2. Evidence

- `npm run typecheck` (`tsc --noEmit`) — clean, **exit 0**
- `npm run lint` (`eslint`) — clean, **exit 0**
- `npm run build` (`next build`, Turbopack) — green, 23 routes + `_not-found` prerendered, **exit 0**
- **`npm run verify:e2e` — 12/12 PASS, exit 0** (2026-10-12, Playwright driving system Chrome against `npm run dev` on `:3100`): logged-out guard → `/login?next=`; bad credentials → "Username or password is incorrect." with no field reveal; `TOTP_REQUIRED` → dashboard; owner dashboard + full nav; coach nav hides Billing/Users; coach `/billing` inline 403; coach `/sessions`; `ACCOUNT_LOCKED`; profile sections.
- Interface check for the requested behaviour: the E2E **fills `#username` and signs in**, i.e. the field the user asked for is what the running app accepts. Screenshot refreshed at `frontend/.verify/login-360.png`.
- **Limitation, stated plainly:** a raw `curl http://127.0.0.1:3100/login` returns only the client shell (12 KB, no form markup, no "Sign in" string), because the form is a client component inside `<Suspense>`. Grepping static HTML **cannot** prove the field, so it is not claimed as evidence — only the browser DOM (E2E) is.

## 3. Deviations from the spec

| Spec ref | What differs | Why | Needs spec change? (CR-###) |
|---|---|---|---|
| `FRONTEND_PLAN` §6 / 2026-10-11 handoff §6 (port 3100) | `next dev` defaulted to **3000**, so `npm run verify:e2e` (which targets `:3100`) could not run as documented. `package.json` now pins `"dev": "next dev -p 3100"` | The documented verify flow must actually reproduce; a documented-but-wrong port is a defect | No (C0 — makes the docs true) |

No other deviations. No spec was amended by the frontend work beyond the CR itself.

## 4. Contract drift / requests

- **Nothing to drift against yet** — the backend does not exist and `api/openapi.yaml` is still absent (M1 not delivered), so frontend types remain hand-written from `API_CONTRACTS` §2 (the documented interim path, ADR-009).
- **For Freebuff (M1):** the contract now requires `username` on `AUTH-01`, `USR-02` and `User`. A backend that implements `email` will fail contract review — it must not be silently adapted to.
- **Open GAPs from 2026-10-11 remain open** (AUTH-06 response shape, `TOTP_REQUIRED`, `INVITE_INVALID`, how `SESSION_EXPIRED` is signalled). When they are closed, none may reintroduce `email`.
- **Deliberately unchanged:** the academy's own contact `email` (`academies.email`, `SET-01`, printed on invoice PDFs) and the OPEN-012 digest email. Those are academy contact data, not credentials.

## 5. Known gaps and risks

- **No version control on this project** (`git ls-files .` → 0 files): these changes cannot be diffed, reverted or audited. Commit the project (with `node_modules/`, `.next/`, `.verify/*.png` ignored) before further work — it is the cheapest protection available.
- No backend ⇒ no contract test; the `email`/`username` mismatch would be caught by review, not by CI.
- Mock accounts (`owner`, `coach`, `totp`, `locked`) accept **any** password — dev-only, gated by `NEXT_PUBLIC_USE_MOCKS`, and the mock session store (`ia_mock_role`) is dev-only.
- **Usernames are immutable in v1** (ADR-018). A typo at creation means a new user + re-invite; `USR-03` PATCH deliberately omits `username`. If that turns out to be annoying in practice, it needs its own CR.
- No axe scan (unchanged from 2026-10-11); the mobile/one-handed checks for the new field were manual (360 px screenshot), not a scripted device test.

## 6. How to run / verify

```bash
cd "Projects/inspire-academy-player manager/frontend"
npm install
npm run dev            # http://localhost:3100 (mock mode on via .env.local)
npm run typecheck && npm run lint && npm run build
npm run verify:e2e     # needs `npm run dev` already listening on :3100
```

Mock logins (any password): `owner` · `coach` · `totp` (asks for a code) · `locked` (locked). Invite token: `valid-invite-token`.

## 7. Next steps (exact)

1. **Hassen:** confirm or amend **CR-003** and answer **OPEN-022** (see the companion handoff `2026-10-12-plan-changes-cr003.md`).
2. **Claude:** close the four contract gaps, keeping `username` (no `email` may return).
3. **Frontend:** Step 3 — players list/register/profile, groups + fees, coaches, import wizard, MSW PLY/GRP/GDN handlers.

## 8. Reviewer checklist (Claude/Hassen fills)

[ ] Compared to DATABASE/API docs  [ ] Permissions verified by route matrix  [ ] No money floats
[ ] Audit rows present  [ ] Tests evidence reviewed  [ ] PROJECT_STATUS updated  [ ] Verdict: accepted / changes requested
