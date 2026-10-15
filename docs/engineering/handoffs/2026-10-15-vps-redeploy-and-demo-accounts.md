# HANDOFF 2026-10-15 — VPS redeployed, demo accounts seeded, and a migration trap

Author: Freebuff      Milestone: M10 (deploy/ops)      Branch/PR: master, uncommitted at time of writing

## 1. Scope delivered

- No source change to the app. This was a **deployment and operator session**.
- **VPS `93.127.141.71:10057`, user `deploy`, key `~/.ssh/id_ed25519_deploy`** (not recorded anywhere in
  the repo before now). Compose project `inspire`; images `ia-backend:prod`, `ia-frontend:prod`.
- Rebuilt both images from commit `b40d4e5`; recreated `api`, `worker`, `web`; `ia_db` and `ia_caddy`
  untouched.
- Migrations applied: none — the VPS was already at `0017` and identical to the repo.
- Seed: `dist/scripts/seed-demo.js` (owner `huzzam`, coach `demo1`, password `12345`, 3 age groups,
  6 weekly rules, 99 sessions, 1 never-claimed user removed with the owner's approval).
- Docs read before starting: root `handoff.md` (§12, §14, §15), [VPS_DEPLOYMENT_RUNBOOK](../VPS_DEPLOYMENT_RUNBOOK.md)
  §12–§16, `backend/deploy/docker-compose.prod.yml`, `backend/deploy/Caddyfile`, `backend/scripts/migrate.ts`,
  `backend/src/routes/auth.ts`, `backend/src/routes/users.ts`, [HANDOFF_TEMPLATE](../HANDOFF_TEMPLATE.md).

## 2. Evidence

- **Pre-deploy backup: taken and read back.** `pg_dump -Fc` → `/home/deploy/backups/predeploy-20261015T054728Z.dump`
  (191 KB); `pg_restore --list` reports **452 TOC entries**.
- **`migrate` → `migrations up to date (17 applied)`, exit 0.**
- **`docker ps` after the swap:** `ia_api`, `ia_worker`, `ia_web` **healthy**; `ia_db` and `ia_caddy`
  `Up 13 hours` (no restart, no DB downtime).
- **Through Caddy, from outside the box** (`Host: inspire-player.lk`, `Origin: http://inspire-player.lk`):
  `POST /auth/login` `huzzam`/`12345` → **200** (role `owner`, 21 permissions) · `demo1`/`12345` → **200**
  (role `coach`, 5 permissions) · wrong password → **401 `INVALID_CREDENTIALS`** ·
  `GET /api/v1/training-schedules` → the 6 rules (Under-11, Tue, 16:00–17:30) · `GET /schedules` → **200** ·
  `GET /api/v1/health` → **200** `{"status":"ok"}`, `/ready` → **200**.
- **Caddy's running config matches the file on disk** (container started 16:51:08, Caddyfile last edited
  16:49:29) — checked because the first external request behaved unexpectedly (see §5).
- Coverage of billing/permission modules: not touched; the permission sets above are the API's own
  response for the two roles.

## 3. Deviations from the spec

| Spec ref | What differs | Why | Needs spec change? (CR-###) |
|---|---|---|---|
| DEPLOYMENT §2 / runbook §16 | Compose was run inside a throwaway container as root, instead of directly as the deploy user | `deploy` has no sudo and cannot read the root-owned `.env.production`; mounting the socket + deploy dir keeps every secret in its original file | No — a permission workaround, recorded in runbook §16 |
| Runbook §16 (`git pull` as `administrator`) | The box's checkout was **not** updated (still `51d90d0`); the source came from a tarball of `b40d4e5` | `deploy` cannot write to `/opt/inspire/src` | No, but the next runbook deploy needs the owner |

## 4. Contract drift / requests

- None from this session. Two contract facts confirmed by reading the code and are worth stating
  plainly because they were asked twice:
  - **New accounts never come with a password.** `usr02Create` inserts `status = 'invited'` and no
    `password_hash`, and returns a one-time 72 h `inviteUrl`; the invitee sets their own password
    (policy: ≥12 characters, not the username, not a common password) and then may enrol TOTP.
  - **An owner cannot be given a password through any `.env`.** Nothing reads `DEV_OWNER_PASSWORD`
    or any other `*_PASSWORD` variable; an account with no password can only be claimed through an
    invite/reset link (`create-owner`, `reset-owner`), and `AUTH-04` needs the current password.

## 5. Known gaps and risks

- **A CRLF trap in migrations, met for real.** The first image built for this deploy packaged
  `0001_platform.sql` with CRLF (from a Windows checkout with `core.autocrlf=true`) and `migrate`
  refused it: *checksum mismatch* (`5de75407…` shipped vs `06a8a9b7…` recorded). Fixed by exporting
  with `git -c core.autocrlf=false archive` and rebuilding — **not** by editing `schema_migrations`.
  Written into runbook §16.
- **The app is reachable from the internet only with the right `Host`.** `http://93.127.141.71/`
  returns a plain 404 from outside, while the same address with `Host: inspire-player.lk` returns the
  app. The box itself answers both, and Caddy has no host matcher, so the split is at the hosting edge.
  A hosts entry works today; the A record is still the real fix.
- **`demo1` has no age-group assignments**, so the coach's `GET /sessions` correctly returns 0. The
  coach-facing half of the demo is empty until groups are assigned.
- **HTTP only, no TLS, and a 5-character password on a publicly reachable box.** The seed prints its
  own warning; anyone who finds the host can sign in as the owner. Acceptable only while nothing is
  pointed at it.
- **The box's checkout is stale (`51d90d0`) and root-owned**, and **six commits are still unpushed**
  locally — the deployed images are ahead of both the checkout and `origin/master`.
- **An unexplained invite/auth anomaly on the VPS**: `owner` was `invited` with no password while its
  invite read `used_at 2026-10-14 17:07:55`, the API log has **zero** `accept-invite` requests, and
  `audit_logs` shows an `auth.login` success at 16:06:27 for a coach user that no longer exists. Not
  reproduced, not guessed at; look at it on a copy of the database.
- **No off-host copy** of either the backups or the payment proofs (unchanged from root `handoff.md` §5).
- **The login fix from the first half of this session is not verifiable on the VPS by curl**, because
  the production `/login` ships no form in its initial HTML; that correction is in root `handoff.md`
  §15/§16.5 and [the other handoff](2026-10-15-login-credential-leak.md).

## 6. How to run / verify

```bash
# Reach the box (key is NOT in the repo)
ssh -i ~/.ssh/id_ed25519_deploy -p 10057 deploy@93.127.141.71

# Run compose without touching the root-owned env file
cd /opt/inspire/src/backend/deploy
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock -v "$PWD":/deploy \
  -v /usr/libexec/docker/cli-plugins/docker-compose:/usr/local/bin/docker-compose \
  -w /deploy alpine:latest /usr/local/bin/docker-compose --profile localdb \
  -f docker-compose.prod.yml --env-file .env.production <config --quiet | up -d api worker web>
```

Logins on the deployment: `huzzam` / `demo1`, password `12345` (below policy, demo only). Reach it with
`Host: inspire-player.lk` (hosts entry) until the A record exists.

## 7. Next steps (exact)

- **Owner:** add the A record for `inspire-player.lk` → `93.127.141.71`, then TLS (Caddyfile note at
  its top, `COOKIE_SECURE=true`).
- **Owner (or next agent with root):** `git pull` the checkout to `b40d4e5` and rebuild through the
  runbook so the box's source matches the running images; also push the six local commits.
- **Owner:** decide whether `demo1` should be assigned to age groups so the coach side shows data.
- **Owner:** replace `12345` with a ≥12-character password before this box is pointed at by anything.

## 8. Reviewer checklist (Claude/Hassen fills)

[ ] Compared to DEPLOYMENT §2  [ ] Permissions verified by route matrix  [ ] No money floats
[ ] Audit rows present  [ ] Tests evidence reviewed  [ ] PROJECT_STATUS updated  [ ] Verdict: accepted / changes requested
