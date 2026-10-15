# HANDOFF 2026-10-15 — the login form could put the password in the URL

Author: Freebuff      Milestone: M1/frontend (no new surface)      Branch/PR: master, uncommitted at time of writing

## 1. Scope delivered

- Page: `app/login/page.tsx` — the submit button is disabled until the client is hydrated, closing the
  native-GET window that §14.2's first repair left open. **No contract item, no endpoint, no schema
  change.**
- Migrations added: none.
- New permanent guard: `frontend/.verify/login-guard.mjs`, wired as `npm run verify:login-guard`.
- Docs read before starting: root `handoff.md` (§12.7, §14), `frontend/package.json`,
  `backend/src/auth/password.ts`, `backend/scripts/create-owner.ts`, `reset-owner.ts`, `seed-demo.ts`,
  [HANDOFF_TEMPLATE](../HANDOFF_TEMPLATE.md).

## 2. Evidence

- `npm run verify:login-guard` — **4/4 PASS**, exit 0 (withholds every `/_next/static/**` chunk, so
  the page under test is the server-rendered HTML, then asserts the button enables after hydration).
  **The same guard was run against the previous button and FAILED 3 of 4 checks**, landing on
  `/login?username=huzzam&password=12345`. Both runs are pasted in root `handoff.md` §15.1.
- `npm run typecheck` exit 0 · `npm run lint` exit 0 · `npm run verify:unit` **17/17** ·
  `npm run build` (mocks off) exit 0, 35 routes.
- Real Chrome against the live API (`:3100` dev → `:3200`): owner `huzzam` and coach `demo1` both log
  in with `12345` and leave `/login` (landing `/dashboard`, 12 and 5 nav links); a wrong password
  stays on `/login`. **5/5 PASS.**
- Database read for the owner's password question: `users` shows `huzzam` (owner) and `demo1` (coach)
  both `active`, both hashes verifying against `12345`, `updated_at` 2026-10-14 23:09.
- Coverage of billing/permission modules: not touched.

## 3. Deviations from the spec

| Spec ref | What differs | Why | Needs spec change? (CR-###) |
|---|---|---|---|
| PAGE_SPEC §1 | The submit button is disabled for the moment between first paint and hydration; the spec is silent on that window | A pre-hydration submit is a native GET, which puts the credential in the URL/history/`Referer` | No — behaviour after hydration is unchanged; a note in the spec would be enough |

## 4. Contract drift / requests

- None. No endpoint, field or error code was touched.
- The template's `DEV_OWNER_USERNAME` / `DEV_OWNER_PASSWORD` are read by **nothing** in
  `backend/src|scripts|db|migrations`, and no code reads any `*_PASSWORD` env var. Worth deleting from
  `.env.example` so nobody sets them expecting an account to appear.

## 5. Known gaps and risks

- The window is narrower in a production build than in `next dev`; it is closed in both, and the guard
  tests the server-rendered HTML rather than racing hydration, so it cannot go flaky on a fast machine.
- With JavaScript entirely broken/blocked the button stays disabled — the same outcome as before (a
  native GET that never logs anyone in and leaks the password), so this is strictly better, but it is a
  deliberate trade-off and is not machine-verified beyond the guard.
- The mock-mode E2E suite was **not** re-run: it needs a `NEXT_PUBLIC_USE_MOCKS=true` dev server and
  the one on `:3100` is in live mode. The login path was verified in the stricter environment instead.
- The owner's **deployed** password state is unknown from here; the recovery paths are in root
  `handoff.md` §15.3.

## 6. How to run / verify

```
cd frontend
npm run dev                     # required first; any mode, listening on :3100
npm run verify:login-guard      # 4/4 PASS, exit 0
npm run typecheck && npm run lint && npm run verify:unit && npm run build
```

Live demo (this machine): backend `:3200`, frontend `:3100`, owner `huzzam` / coach `demo1`, password
`12345` (below policy, demo only).

## 7. Next steps (exact)

- **Owner:** say where the password was changed — the VPS `.env` (value still in that file, and it never
  took effect) or inside the app (unrecoverable; use `npm run reset-owner -- --username <name>`).
- **Owner:** the A record for `inspire-player.lk`, which is all that blocks the deployed invite
  (root `handoff.md` §14.4).
- Commit this change, and add the spec note from §3 if the window should be documented.

## 8. Reviewer checklist (Claude/Hassen fills)

[ ] Compared to PAGE_SPEC §1  [ ] Permissions verified by route matrix  [ ] No money floats
[ ] Audit rows present  [ ] Tests evidence reviewed  [ ] PROJECT_STATUS updated  [ ] Verdict: accepted / changes requested
