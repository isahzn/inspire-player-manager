# VPS_DEPLOYMENT_RUNBOOK

> **Status:** Written 2026-10-14 · **Owner:** Freebuff · **Audience:** Hassen (operator)
> **Read first:** [DEPLOYMENT_AND_OPERATIONS](../architecture/DEPLOYMENT_AND_OPERATIONS.md) §2, §5, §9
> — the topology and the go-live checklist this runbook *executes* — and
> [`handoff.md`](../../handoff.md) §5–§6, which is what only a person can supply.

## 0. Honest status: what is ready, and what this runbook cannot promise

**Ready to deploy as a pilot today:**

- the API (135 contract operations, 114 shipped) and the worker (8 scheduled jobs);
- money, documents, the dashboard, the reports, the audit trail and `SYS-03`;
- one immutable image (`backend/Dockerfile`) and a CI workflow that now proves the tests ran.

**Not ready — and none of these are fixed by following this runbook:**

| Not ready | What it means on the day |
|---|---|
| **Messaging (M7, 0/21 endpoints)** | No WhatsApp. `MESSAGING_PROVIDER=mock` records messages to the database instead of sending them. The invoice message *generator* works; nothing is delivered. Invoices are downloaded and sent by hand. |
| **No reverse-proxy/TLS or compose file in the repo before today** | The two files this runbook uses (`backend/deploy/`) were written today and **have never been started** — this machine has no Docker. Expect to fix small things on the first `up`. |
| **A backup has never been restored** | DEPLOYMENT §7 requires a restore drill. Do step 12 before real money enters the system. |
| **No security review, no performance measurement** | Release gate items 7 and M9. A pilot is not a release. |
| **No frontend Docker image** | The frontend goes on Vercel / Cloudflare Pages (step 11). That is DEPLOYMENT §2's own recommendation, not a shortcut. |

The one-line version: **the money engine is deployable; messaging is not, and will not be until a phone number is paired on this VPS (§5.1 of the handoff).**

## 1. What you need to buy or have

| Item | Minimum | Note |
|---|---|---|
| VPS | **2 vCPU / 4 GB RAM / 40 GB disk**, Ubuntu 24.04 LTS | 2 GB works only with a swap file (step 2.3); `npm ci` + `tsc` in the image build is the memory peak |
| Domain | one registrable domain | `api.<domain>` here, `app.<domain>` for the frontend |
| PostgreSQL | **the `localdb` profile in step 6, or a managed instance** | Managed with point-in-time recovery is what DEPLOYMENT §2 asks for. The compose profile exists because a pilot may reasonably not pay for it yet — but then RPO is whatever your `pg_dump` schedule is |
| Frontend host | free tier | Vercel or Cloudflare Pages |
| Email address | any | Let's Encrypt expiry notices (`ACME_EMAIL`) |

**No payment gateway, no email API, no third-party API key is needed.** §10 says it plainly: *OpenWA is self-hosted and MIT-licensed, and nothing else in the current build talks to a paid service.* `SENTRY_DSN` is documented but **not wired** — setting it does nothing today.

## 2. Provision and harden the VPS

Run as `root` on the fresh box.

```bash
# 2.1 Update, then create the deployment user (never deploy as root).
apt update && apt upgrade -y
apt install -y ca-certificates curl git openssl ufw
adduser --disabled-password --gecos "" deploy
usermod -aG sudo deploy

# Copy your SSH key in (run this from YOUR machine, not the VPS):
#   ssh-copy-id deploy@<vps-ip>
# Then refuse password logins entirely:
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
systemctl restart ssh

# 2.2 Firewall: only SSH, HTTP, HTTPS. (The API's own port 3200 is bound to loopback.)
ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443/tcp && ufw --force enable

# 2.3 Swap — only on a 2 GB box. On 4 GB, skip.
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

Then, **as `deploy`** (exit and `ssh deploy@<vps-ip>`):

```bash
# 2.4 Docker Engine + the compose plugin, from Docker's own repository.
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker deploy
# Log out and back in so the group membership applies, then:
docker version && docker compose version
```

## 3. DNS, before TLS can be issued

At your DNS provider, two `A` records pointing at the VPS IP:

| Name | Type | Value | Used by |
|---|---|---|---|
| `api` | A | `<vps-ip>` | the API, via Caddy (step 7) |
| `app` | A | (frontend host's target — Vercel/Cloudflare gives you this) | the frontend |

Both must resolve **before** step 7: Caddy asks Let's Encrypt for a certificate at first start and a failed lookup costs you a rate-limited retry. Check with `dig +short api.<domain>` from the VPS.

`app` and `api` must share the same registrable domain. That is what makes the session cookie (`SameSite=Lax`, `src/routes/auth.ts`) work across the two origins, and it is why DEPLOYMENT §2 says so.

## 4. Put the code on the box and build the image

There is no image-publishing CI job (`.github/workflows/ci.yml` runs tests only), so **build on the VPS**.

```bash
sudo mkdir -p /opt/inspire && sudo chown deploy:deploy /opt/inspire
git clone https://github.com/isahzn/inspire-player-manager.git /opt/inspire/src
cd /opt/inspire/src/backend

# Tag by commit so a rollback is a tag change, not a rebuild (DEPLOYMENT §5).
SHA=$(git rev-parse --short HEAD)
docker build -t ia-backend:$SHA .
docker tag ia-backend:$SHA ia-backend:current
```

Record `$SHA` somewhere — rollback is `IA_IMAGE=ia-backend:<previous-sha>` in the environment file plus step 16.

## 5. Generate the secrets

Three values are **required and must be real random data**: `config.ts` refuses to start if any is
shorter than 32 characters, and additionally refuses any value beginning `dev-only`/`changeme`/
`secret`/`test` when `NODE_ENV=production`.

```bash
cd /opt/inspire/src/backend/deploy

openssl rand -base64 48   # → SESSION_COOKIE_SECRET
openssl rand -base64 48   # → CSRF_SECRET
openssl rand -base64 48   # → TOTP_ENCRYPTION_KEY
openssl rand -base64 36   # → the password inside DATABASE_URL        (ia_app)
openssl rand -base64 36   # → the password inside DATABASE_MIGRATOR_URL (ia_migrator)
openssl rand -base64 36   # → the password inside DATABASE_SUPERUSER_URL (postgres, step 6 only)
```

**Keep `TOTP_ENCRYPTION_KEY`.** It encrypts `users.totp_secret_enc` at rest. Lose it and every owner's
TOTP secret is unrecoverable — they re-enrol, which is survivable; what is not survivable is being
surprised by it later. Put all six values in the offline secret export DEPLOYMENT §7 requires.

## 6. Write `.env.production`

```bash
cp /opt/inspire/src/backend/.env.example /opt/inspire/src/backend/deploy/.env.production
chmod 600 /opt/inspire/src/backend/deploy/.env.production
nano /opt/inspire/src/backend/deploy/.env.production
```

Every line below matters; lines not listed keep `.env.example`'s value, which is already correct.

### 6a. Required — the process will not start without them

| Key | Value for production |
|---|---|
| `NODE_ENV` | `production` |
| `APP_ENV` | `production` |
| `DATABASE_URL` | `postgres://ia_app:<generated>@db:5432/ia_prod` — **`db` is the compose service name**; with managed Postgres use its host and add `?sslmode=require` |
| `DATABASE_MIGRATOR_URL` | `postgres://ia_migrator:<generated>@db:5432/ia_prod` — the worker and every operator CLI use this, the API never does |
| `DATABASE_SUPERUSER_URL` | `postgres://postgres:<generated>@db:5432/ia_prod` — **step 8 only.** Delete it from this file afterwards |
| `SESSION_COOKIE_SECRET` | the generated value |
| `CSRF_SECRET` | the generated value |
| `TOTP_ENCRYPTION_KEY` | the generated value |

### 6b. Required for the deployments to be correct, not merely to boot

| Key | Value | Why |
|---|---|---|
| `APP_BASE_URL` | `https://app.<domain>` | absolute links and CORS |
| `API_BASE_URL` | `https://api.<domain>` | **the hostname inside every guardian's invoice link** (`PUB-01`) |
| `CORS_ALLOWED_ORIGINS` | `https://app.<domain>` | exact origins only; the API never accepts `*` |
| `TRUST_PROXY` | **`true`** | Without it the API cannot see the client IP behind Caddy, and the rate limiter's 300 req/min becomes **one shared budget for every user at once**. This is the single most likely thing to be wrong. |
| `COOKIE_SECURE` | `true` | defaults to `true` when `NODE_ENV=production`; set it explicitly. **`false` only while the site is plain HTTP**: a browser drops a `Secure` cookie over HTTP, so login appears to succeed and the very next request is unauthenticated (handoff §12.5). It goes back to `true` the moment TLS is on |
| `COOKIE_DOMAIN` | *(empty)* | host-only cookies are the safer setting and are sufficient, because `app` and `api` share a registrable domain |
| `ACADEMY_TIMEZONE_DEFAULT` | `Asia/Colombo` | seed default; changing it later does not re-schedule anything |
| `POSTGRES_SUPERUSER` / `POSTGRES_SUPERUSER_PASSWORD` / `POSTGRES_DB` | the superuser name, its password, and `ia_prod` | read by the `db` container only (step 6's `localdb` profile) |
| `IA_IMAGE` | `ia-backend:current` | overridden to a sha tag for a rollback |
| `API_HOST` / `APP_HOST` | `api.<domain>` / `app.<domain>` | read by Caddy |
| `ACME_EMAIL` | your email | Let's Encrypt notices |

### 6c. Storage — decided 2026-10-14: it stays on this VPS

```
STORAGE_DRIVER=local
FILES_DIR=/app/var/files      # the compose file sets this; the ia_files volume
BACKUP_DIR=/app/var/backups
```

Leave `STORAGE_ENDPOINT`/`STORAGE_BUCKET`/`STORAGE_ACCESS_KEY_ID`/`STORAGE_SECRET_ACCESS_KEY` empty.
**Do not set `STORAGE_DRIVER=s3` without all five** — that is a startup failure by design
(`assertStorageUsable`), never a silent fall back to a directory nobody backs up.

> **A bucket on this VPS is not a backup of this VPS.** DEPLOYMENT §7 requires the nightly copy of
> proofs and PDFs to leave the machine. Step 12 is that, and it is the one part of the pilot that
> must not be skipped: **proofs cannot be re-created, PDFs can.**

### 6d. Messaging — off, on purpose

```
MESSAGING_PROVIDER=mock
```

`openwa` is not selectable yet: M7 is unbuilt and the adapter does not exist. The three messaging
jobs are registered in the worker and record themselves as `skipped` with the reason. That is the
honest state, and `SYS-03` shows it.

### 6e. Audit anchor — optional, and honest when unset

Leave all `AUDIT_ANCHOR_*` empty for a pilot. The nightly job then records `anchorStatus:
not_configured` and says where the verification *is* recorded — it does not pretend the chain was
anchored off-host. Set `AUDIT_ANCHOR_BUCKET` (ideally on a **different provider** from the files
store) once you have one; a configured bucket that refuses the upload **fails the run**, on purpose.

### 6f. Ignore these

- `DEV_OWNER_USERNAME` / `DEV_OWNER_PASSWORD` — **nothing in the codebase reads them.** They are
  dead config in `.env.example`. Production owners come from `create-owner`, and no default
  credentials exist anywhere.
- `SENTRY_DSN` — documented, **not wired**. Setting it changes nothing today.
- `OPENWA_*`, `WEBHOOK_ALLOWED_IPS` — for M7, not now.

## 7. Start the database, create the roles, migrate, seed

All operator CLIs run **inside the image** (they are compiled to `dist/scripts/*.js`). The
image's `ENTRYPOINT` ignores extra arguments, so `--entrypoint node` is required — this is not
cosmetic, it is the difference between the script running and silently doing nothing.

```bash
cd /opt/inspire/src/backend/deploy
C="docker compose -f docker-compose.prod.yml --env-file .env.production"

# 7.1 Database up first (skip if you are using managed Postgres).
$C --profile localdb up -d db
docker exec ia_db pg_isready -U postgres -d ia_prod   # wait for "accepting connections"

# 7.2 Create the two runtime roles, the extensions and the grants (uses the superuser URL).
#     Safe to re-run. It reads db/bootstrap.sql, which the image now ships.
$C --profile localdb run --rm --entrypoint node api dist/scripts/bootstrap-roles.js

# 7.3 Apply migrations and the seed (settings row, payment methods, reminder rules, templates,
#     counters). Record the migration count — it is 16 today.
$C --profile localdb run --rm --entrypoint node api dist/scripts/migrate.js --seed

# 7.4 Now remove DATABASE_SUPERUSER_URL from .env.production. Nothing at run time needs it.
```

`migrate.ts` records a sha256 per migration and **refuses a changed file**, so migrations are
append-only: never edit an applied `.sql`, add a new one.

## 8. Validate the proxy config, then bring everything up

```bash
cd /opt/inspire/src/backend/deploy
C="docker compose -f docker-compose.prod.yml --env-file .env.production"

# 8.1 One syntax check before anything tries to talk to Let's Encrypt.
$C run --rm --entrypoint caddy caddy validate --config /etc/caddy/Caddyfile

# 8.2 Start api + worker + caddy.
$C --profile localdb up -d

# 8.3 Readiness, not just liveness.
# The router mounts every contract route under /api/v1, so the paths carry that prefix:
# a bare /health is a 404 that looks like a broken deployment. (This was wrong in the first
# version of this runbook, and the image's HEALTHCHECK asked for /health too — handoff §12.1.)
curl -fsS http://127.0.0.1:3200/api/v1/health    # → 200, process up
curl -fsS http://127.0.0.1:3200/api/v1/ready     # → 200, and it ran a real `select 1`
sleep 20 && curl -fsS https://api.<domain>/api/v1/health   # → 200 through TLS
```

If `/api/v1/ready` fails, the startup log says which check refused — `assertRuntimeRoleIsUnprivileged`
(ia_app must not be superuser or BYPASSRLS) is the usual one, and it means step 7.2 did not run.

## 9. Create the first owner, and turn TOTP on

```bash
cd /opt/inspire/src/backend/deploy
C="docker compose -f docker-compose.prod.yml --env-file .env.production"

$C run --rm --entrypoint node api dist/scripts/create-owner.js \
    --username owner --full-name "Academy Owner" --phone 07XXXXXXXX
```

It prints a **one-time invite URL, valid 72 hours**. Open it, set the password, then enrol TOTP via
`POST /auth/totp/enroll` from the app. There are no default credentials — this step is the only way
an account exists.

## 10. Prove the go-live checks that only a running deployment can prove

```bash
cd /opt/inspire/src/backend/deploy
C="docker compose -f docker-compose.prod.yml --env-file .env.production"

# 10.1 The storage driver, against the storage this deployment actually uses.
#      (Skipped for STORAGE_DRIVER=local, which is proven by 10.2. This is the check for §6c's
#      future bucket, and it is on DEPLOYMENT §9's checklist.)
$C run --rm --entrypoint node api dist/scripts/storage-probe.js
$C run --rm --entrypoint node api dist/scripts/storage-probe.js --anchor   # if the anchor is set

# 10.2 Upload a logo, upload a 5 MB proof, download both back, then read /system/health.
#      That exercises the local driver end to end, which no unit test can.

# 10.3 The worker is running and its jobs are recorded — this is the evidence, not a promise.
curl -fsS -b cookies.txt https://api.<domain>/api/v1/system/health | head -40
#      Expect: scheduler.lastRunAt fresh, worker.heartbeat fresh, jobs listed by name,
#      and the three messaging jobs reading `skipped` with a reason — not `ok`.
```

## 11. The frontend

Two variables, both **inlined at build time** — changing them later requires a rebuild, not a
restart.

```bash
# On your machine (or in the host's build settings):
NEXT_PUBLIC_USE_MOCKS=false
NEXT_PUBLIC_API_BASE_URL=https://api.<domain>
```

Deploy `frontend/` to Vercel or Cloudflare Pages as a Next.js project, with `app.<domain>` as the
domain. Then set `APP_BASE_URL` and `CORS_ALLOWED_ORIGINS` in `.env.production` to `https://app.<domain>`
and `docker compose ... up -d api` to reload.

If `NEXT_PUBLIC_USE_MOCKS` is left `true`, the app runs against its **mock** API: everything looks
right and nothing is real. This is the most expensive mistake available in this runbook — check the
browser's network tab shows requests to `api.<domain>`.

## 12. Backups — and the restore that makes them a backup

**12a. Automated dump.** The worker already writes one nightly into `BACKUP_DIR`
(`ops.logical_backup`, recorded in `job_runs`). It proves a dump was *produced*, not that it is
*recoverable*. Both parts below are yours:

```bash
# One file per night, on the VPS:
docker exec ia_worker ls -lh /app/var/backups

# Ship it OFF the machine, encrypted, to a DIFFERENT provider/account (DEPLOYMENT §7).
# rclone/restic/rsync+age all work; the requirement is that losing this VPS does not lose it.
```

**12b. Storage off-host.** The `ia_files` volume holds payment proofs, which are the one artefact
that cannot be re-created. A named volume on this box dies with this box:

```bash
# Nightly, to the same off-host destination (restic/rclone over the volume path):
docker run --rm -v inspire_ia_files:/data -v /etc/ia-backup:/cfg <tool> backup /data
```

**12c. The drill. Do this before real money enters the system.**

```bash
# Restore last night's dump into a throwaway database on the same VPS and prove it is real:
docker exec -i ia_db createdb -U postgres ia_restore_test
docker exec -i ia_db psql -U postgres -d ia_restore_test < <(zcat /path/to/dump.sql.gz)   # adjust to your dump format
docker exec -i ia_db psql -U postgres -d ia_restore_test -c 'select count(*) from invoices;'
```

Then record **date, duration, result** in `docs/engineering/RESTORE_LOG.md` — a file that does not
exist yet, and DEPLOYMENT §9 makes its first entry a go-live requirement. Drop `ia_restore_test`
afterwards. A backup that has never been restored is not a backup.

## 13. Monitoring, the minimum set

| Signal | Where | Alert on |
|---|---|---|
| API up | external pinger on `https://api.<domain>/api/v1/health` | 2 consecutive failures |
| API ready (DB reachable) | pinger on `https://api.<domain>/api/v1/ready` | any failure |
| Worker alive | `scheduler.lastRunAt` in `GET /api/v1/system/health` | older than 15 min |
| Disk | the VPS provider's alert | > 80 % |
| TLS expiry | Caddy renews automatically; note the date | 14 days out |
| Nightly invariant job | `ops.invariant_nightly` in `GET /api/v1/system/health` | any run not `ok` |
| Nightly logical backup | `backup.status` in `GET /api/v1/system/health` | any run not `ok` — and read §12a again before believing a dump file exists |

`SENTRY_DSN` is not wired, so there is **no** error tracking and no metrics beyond the logs:
`docker compose logs -f api worker`. The audit trail (`AUD-01`) and `SYS-03` are the in-product
signals, and they are real.

## 14. What this deployment still does not do

Restating §0, because a working deployment makes these easy to forget. The first three are what the
**first real deployment** (2026-10-14, handoff §12) actually hit:

- **Nothing routes to the box from the internet.** The provider NATs a *shared* public IP and has
  forwarded only SSH. Its own edge proxy answers 80/443 for every customer on that IP, so this VM's
  Caddy listens and is never reached. Check with `curl -I http://<public-ip>/` **from outside** — if
  the answer is a Go `404 page not found` or a `TRAEFIK DEFAULT CERT`, you are seeing the provider,
  not this deployment. Fix it by asking the provider for two forwarded ports, buying a dedicated IP,
  or putting a Cloudflare Tunnel in front (handoff §5).
- **TLS is off, by instruction**, and `ACME_EMAIL` is a placeholder, because the academy has neither a
  domain nor a mailbox yet. §3 and §6b's HTTPS steps are written and unrun; the switch is one line in
  `backend/deploy/Caddyfile` plus two values in `.env.production`.
- **The nightly dump does not complete.** `pg_dump` is in the image, but a full dump of an RLS
  database needs a role exempt from RLS and both roles are deliberately forbidden `BYPASSRLS`. The job
  records `failed` and **leaves no file**, so §12a's `ls` will show an empty directory — that is the
  honest reading, not a broken mount (handoff §5, §12.4).
- **No WhatsApp.** Messages are recorded, not sent.
- **No guardian invoice links sent by message** — `PUB-01` works, so copy the URL from the invoice
  and send it yourself.
- **No off-host anchor** until `AUDIT_ANCHOR_BUCKET` is set.
- **The invoice's payment-instructions block is empty** until the owner supplies the bank details
  (`OPEN-018`), and the fee per group is a seeded placeholder. Print an invoice and read it before
  sending one to a guardian.
- **`OPEN-016`'s off-host copy of proofs** is step 12b, and it is still manual.

## 15. Rollback

Code-only, and this is why step 4 tags by sha:

```bash
cd /opt/inspire/src/backend/deploy
sed -i 's/^IA_IMAGE=.*/IA_IMAGE=ia-backend:<previous-sha>/' .env.production
C="docker compose -f docker-compose.prod.yml --env-file .env.production"
$C --profile localdb up -d api worker
curl -fsS http://127.0.0.1:3200/api/v1/ready
```

Migrations are expand-only, so old code runs against a newer schema. **There is no maintenance flag
built**, so the documented "stop writes" step of DEPLOYMENT §5's rollback path (b) is not available
today: if a migration itself is the problem, restore from a pre-deploy dump and accept the data loss
back to that point. That gap is real and is recorded in `handoff.md` §11.

## 16. Every deploy after the first

```bash
cd /opt/inspire/src/backend
git pull
SHA=$(git rev-parse --short HEAD)
docker build -t ia-backend:$SHA . && docker tag ia-backend:$SHA ia-backend:current

cd deploy
C="docker compose -f docker-compose.prod.yml --env-file .env.production"
$C --profile localdb run --rm --entrypoint node api dist/scripts/migrate.js   # before the new code
$C --profile localdb up -d api worker
curl -fsS http://127.0.0.1:3200/api/v1/ready
docker compose -f docker-compose.prod.yml logs --since 5m api worker | grep -i error
```

Backup first (DEPLOYMENT §5 step 3) whenever the release includes a migration.
