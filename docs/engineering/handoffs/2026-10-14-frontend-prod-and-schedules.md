# HANDOFF 2026-10-14 — frontend to production mode, plus automated training sessions

Author: Buffy (Freebuff)      Milestone: M9/M10 prep      Branch/PR: local `master` (uncommitted)

## 1. Scope delivered

The frontend was still running against its built-in MSW mocks. This session pointed it at the real
API, gave the demo real data, and built the one screen the owner asked for — the recurring training
schedule that automates sessions.

- **Frontend out of mock mode** — `NEXT_PUBLIC_USE_MOCKS=false` and `NEXT_PUBLIC_API_BASE_URL` set to
  the real API for local dev (`.env.local` / `.env.development`, both git-ignored). The production
  path needs no change: `frontend/Dockerfile` already defaults `NEXT_PUBLIC_USE_MOCKS=false` and
  `NEXT_PUBLIC_API_BASE_URL=/api/v1`.
- **A real hydration bug the switch exposed, fixed** — `app/login/page.tsx` disabled the submit
  button on `status === "loading"`. During SSR the auth status cannot be known, so the server
  rendered `disabled` and the client hydrated `disabled={false}`; React reports that mismatch and
  does **not** patch it, so the button stayed stuck disabled and login was impossible in prod mode.
  (Mock mode hid it: `Providers` renders nothing until MSW starts, so the login form was never
  server-rendered.) The button is now gated on `pending` only.
- **SCH-01/02 wired into the frontend** — new `TrainingSchedule` / `ScheduleGenerateResult` types
  (`src/api/types.ts`) and `sch01ListSchedules` / `sch01CreateSchedule` / `sch01UpdateSchedule` /
  `sch01DeactivateSchedule` / `sch02GenerateSessions` wrappers (`src/api/client.ts`), matching the
  existing `/training-schedules` contract exactly.
- **The Schedules page built** (`src/app/schedules/page.tsx`, previously a "coming soon"
  placeholder): list rules by age group, create/edit (day, times, venue, valid range), deactivate,
  and generate sessions for a range — one rule or all active rules at once.
- **A re-runnable demo seed** — `backend/scripts/seed-demo.ts` (`npm run seed:demo`): owner `huzzam`
  and coach `demo1` (both active, password `12345`), the three age groups with fees, and the
  recurring Tuesday + Thursday 16:00–17:30 schedule for every group, then the sessions it generates.
- **Coach group assignment exercised against the real API** — the `/coaches` UI already shipped this
  (CCH-03/04); this session proved it end-to-end against the backend instead of mocks.

Docs read first: `handoff.md`, `CLAUDE.md`, `docs/engineering/PROJECT_STATUS.md`,
`docs/frontend/PAGE_SPECIFICATIONS.md` (via the code), `backend/src/routes/schedules.ts`,
`backend/migrations/0010_sessions.sql`.

## 2. Evidence

- `frontend`: `npm run typecheck` **exit 0**, `npm run lint` **0 errors / 0 warnings**,
  `npm run build` **exit 0 with mocks off** (all 35 routes, `/schedules` included).
- `backend`: `npx tsc --noEmit` **exit 0**. `npm run migrate` applied `0017`, exit 0.
  `npm run seed:demo` exit 0 — printed: owner created, coach created, 40 other users removed,
  3 age groups, **6 schedules**, **96 sessions generated**.
- **Browser (real Chrome via `playwright-core`), prod mode against the live API** — temporary script,
  run then deleted:
  `PASS schedules page renders rows` · `PASS age groups listed` · `PASS no error state` ·
  `PASS sessions page shows generated sessions` · `PASS coach sees assigned groups` ·
  `PASS coach does NOT see unassigned group` → **ALL PASS**.
- **API (curl), real backend**: `POST /auth/login` for both `huzzam` and `demo1` → **200** with a
  session cookie; `GET /training-schedules` → 6 rules (Tue + Thu, 16:00–17:30, all three groups);
  `GET /sessions` shows the generated dates (16:00 Colombo = 10:30Z); `POST /coach-assignments` for
  Under-11 and Under-14 → 201 each; then `GET /coaches` shows `demo1` with **two** groups, and the
  coach's own `GET /sessions` returns **only** Under-11/Under-14 (never Under-17);
  `POST /training-schedules/{id}/generate` → `{"created":0,"skipped":4}` on a filled range and
  `{"created":4,"skipped":0}` on an empty one — the idempotency the contract promises.

## 3. Deviations from the spec

| Spec ref | What differs | Why | Needs spec change? |
|---|---|---|---|
| AUTH §1 password policy (min 12) | the demo accounts use `12345` | explicit owner instruction for a demo; the policy is enforced on the API path (accept-invite / change-password), and the seed hashes with the same argon2id parameters directly | owner's call; the seed prints a warning to keep it demo-only |

## 4. Contract drift / requests

- **None raised by the frontend work.** The SCH wrappers were written to the shape the backend
  already serialises (`serializeTrainingSchedule` → `ageGroup{id,name}`, `weekday`, `startTime`,
  `endTime`, `venue?`, `validFrom`, `validTo?`, `isActive`), and the page needed no field the
  contract does not already have.
- For the record, not a request: `frontend/src/mocks/` now has **no** handler for
  `/training-schedules`. Mock mode is being retired (see §5), so the schedules screen shows its error
  state if it is ever opened with `NEXT_PUBLIC_USE_MOCKS=true`.

## 5. Known gaps and risks

- **The weak demo password is a real risk if this database is ever exposed.** `12345` is far below
  the policy. Keep this seed to a local/demo box; do not run it against a publicly reachable database.
- **`seed-demo.ts` has no automated test.** It was exercised by running it (twice: create then
  idempotent), which is the evidence above; it is not in the Vitest suite.
- **`.env.local` / `.env.development` are git-ignored**, so the local switch to prod mode is not in
  the commit — it is a local configuration, by the repository's own rule.
- **Mock handlers for schedules were not added** — intentional, since mock mode is off. If mock mode
  is ever restored, the Schedules page will need a handlers slice and a mock store.
- **The VPS was not touched.** The user asked for "both" local and the VPS; deploying needs a
  separate explicit go-ahead (standing permission excludes it) and DNS for `inspire-player.lk` is
  still NXDOMAIN, so the deploy would not be reachable yet anyway. The exact steps are in `handoff.md`
  §13.4.

## 6. How to run / verify

```bash
# backend (already listening on :3200 during this session)
cd backend && npm run migrate && npm run seed:demo && npx tsx src/server.ts

# frontend, prod mode against the local API (env already set in frontend/.env.local)
cd frontend && npx next dev -p 3100      # or: npm run build && npm run start

# accounts
#   owner  huzzam / 12345
#   coach  demo1  / 12345
# local URLs: app http://localhost:3100 · api http://localhost:3200/api/v1
```

## 7. Next steps (exact)

1. **Commit** the four source changes (`frontend/src/api/{types,client}.ts`,
   `frontend/src/app/schedules/page.tsx`, `frontend/src/app/login/page.tsx`) + `seed-demo.ts` +
   `package.json`.
2. **Deploy when authorised (§13.4 of `handoff.md`)** — rebuild the frontend image on the VPS, run
   `seed-demo` against `ia_prod` (or `create-owner` if the weak password is refused), and open DNS.
3. **Restore mock-mode coverage for `/training-schedules`** only if mock mode is kept.
4. Owner decisions still blocking full production: the real age groups and fees, the academy's
   details and bank instructions, and the `create-owner` + TOTP handover (see `handoff.md` §5).

## 8. Reviewer checklist (Claude/Hassen fills)

[ ] Compared to DATABASE/API docs — SCH shape matches the serializer
[ ] Permissions verified by route matrix — `/schedules` gated on `settings:manage`; coach scope
    verified (no Under-17)
[ ] No money floats — unchanged; the seed writes integer minor units
[ ] Audit rows present — user creation/assignment go through the API (audited); the CLI seed writes
    users directly, as `create-owner` does
[ ] Tests evidence reviewed — typecheck/lint/build + the temporary browser run + curl, all above
[ ] PROJECT_STATUS updated
[ ] Verdict: accepted / changes requested
