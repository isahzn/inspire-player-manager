# HANDOFF 2026-10-15 — the live deployment, clicked through end to end

Author: Freebuff      Milestone: M10 (deploy/ops) + M9 evidence      Branch/PR: master, uncommitted at time of writing

**Scope.** Everything below was done against the **running VPS deployment** through the public
hostname, in a real Chrome (Playwright driving the installed Chrome), with console errors,
page errors, failed requests, the URL after every click, the visible outcome and a screenshot
captured for each step. Nothing here is read from source alone unless it says so.

| | |
|---|---|
| Target | `http://inspire-player.lk` → `93.127.141.71` (see §2 for how the name was resolved) |
| Owner session | `huzzam` / `12345` |
| Coach session | `demo1` / `12345` |
| Surface swept | **22 routes · 562 visible controls** (113 buttons, 384 links, 36 text inputs, 19 selects, 6 checkboxes/radios, 4 textareas) |
| Buttons pressed | **65** — 31 recorded as skipped, not clicked (the brief's forbidden list: reset password, disable, revoke, delete/remove, cancel session, deactivate schedule) |
| Fixes made after the audit | **all three defects are fixed in the source and verified locally** (§10) — **none of it is deployed**, because a rebuild and redeploy were outside what this session was allowed to do |
| Dialogs opened | **40 — all 40 closed cleanly** by Cancel / Close / Escape |
| Clicks with no observable change | 9 — 8 explained below as measurement artefacts, **1 is silent** (§5.3) |
| Forms | every form submitted deliberately invalid once; the valid half is the create path in §4 |
| Keyboard-only pass | login (succeeds end to end), `/players/new`, `/payments/new`, plus the skip link |
| Coach pass | every owner-only route as `demo1`, the API called directly with the coach's own cookie, the coach's own sessions and one attendance write |

**Timings are not quoted anywhere in this report.** The deployment was reached from a home
connection over the public internet, so any wall-clock number would be a measurement of that
path, not of the product.

---

## 1. What this session changed on the box (complete list)

The audit brief allowed test data. This is all of it — nothing else was touched.

| # | What | Where it came from |
|---|---|---|
| 1 | Player **`Audit Test Player`** (`IA-0001`, Under-11, dob 2016-03-10, registered 2026-10-15, notes “Created by the 2026-10-15 UI click audit.”) | the `/players/new` form |
| 2 | Guardian **`Audit Test Guardian`** (`+94770000001`, relationship Mother, WhatsApp consent **granted**, receives invoices) attached to that player | the same form |
| 3 | **`demo1` assigned to two age groups** — Under-11 and Under-14, from 2026-10-15 | the `/coaches` → “Assign group” dialog. **This was required to make the coach side testable at all**; §16.5 recorded that the coach had no assignments, so their session list was legitimately empty |
| 4 | Attendance: **present** on the Under-11 session of 2026-10-15 (marked by the owner) and on the Under-11 session of 2026-10-20 (marked by `demo1`) | the attendance sheets |
| 5 | Billing run **`01a13e4b`** for Under-11 on 2026-10-15 → invoice **`INV-2026-000001`**, LKR 4,000.00 | `/billing/new` (Preview → Continue → Issue invoices) |
| 6 | Payment **LKR 4,000.00**, bank transfer, reference `INV-2026-000001`, recorded **Confirmed**, with a synthetic 1-page PDF uploaded as the proof, then **allocated** to that invoice | `/payments/new`, then `/payments/{id}` → “Allocate credit” → “Use the suggested amounts” |
| 7 | A test age group that was never created (`X`, 99–1) — the dialog refused it (§3) | `/age-groups` → New age group |
| 8 | **Under-11 was archived and un-archived by the click sweep** (the “Archive” button has no confirmation dialog — §5.2). All three groups are active again; verified by `GET /age-groups` → Under-11, Under-14, Under-17 | `/age-groups` |

I could not avoid #8 without skipping the control, which the brief forbids; it is reported rather
than hidden, and the end state is verified as identical to the start.

**Not touched, by instruction:** every password, 2FA, the owner's sessions, any account deletion,
`seed:demo`, `.env.production`, container recreation, migrations, DNS/Caddy, and git. The one
audit-log row this session added from the sweep is listed in §5.2.

---

## 2. Reachability — which link worked

The brief's “LINK TO TEST” arrived as the unsubstituted placeholder `<paste the URL the owner gives
you here>`, so I used the two candidates the brief itself names, in that order.

| Attempt | Result |
|---|---|
| `http://93.127.141.71/` (the bare address, no Host header) | **404**, `text/plain`, `404 page not found`, no `Via` header — the hosting edge answers, not Caddy |
| `http://93.127.141.71/api/v1/health` | **404** (same) |
| **`Host: inspire-player.lk`** against the same address | **the app**: `/` → **307 → `/dashboard`** with `Via: 1.1 Caddy`, `/login` → **200**, `/api/v1/health` → **200** `{"status":"ok"}` |
| `inspire-player.lk` in DNS | **NXDOMAIN** (`nslookup` → Non-existent domain) — unchanged from §5/§16.5 |
| `https://93.127.141.71/` (TLS on 443) | TLS completes but the certificate is **`CN=TRAEFIK DEFAULT CERT`** (self-signed, notBefore 2026-10-14) and the answer is **404** — i.e. **port 443 is the provider's own Traefik proxy with no router for this host**, not Caddy. Caddy's own config serves `:80` only |
| A hosts-file entry | **Not made.** Windows' hosts file needs elevation and it is a machine-wide change; instead Chrome was launched with `--host-resolver-rules=MAP inspire-player.lk 93.127.141.71`, which is the same resolution decision with no system change. This is what every browser step below ran under |

**So: the hosts-entry route works and is how I browsed it; the bare IP does not.** §16.5's
diagnosis holds exactly as written — the split is at the hosting edge, and Caddy's running config
(re-read on the box this session) still has no host matcher and only a `:80` site block.

---

## 3. Is the deployment the thing we think it is? (read-only)

| Check | Result |
|---|---|
| `docker ps` | `ia_web` **healthy** (`ia-frontend:prod`), `ia_worker` **healthy**, `ia_api` **healthy** (`ia-backend:prod`), `ia_db` **healthy** (`postgres:16-alpine`), `ia_caddy` up (`caddy:2-alpine`) |
| Health/failing streak | all four healthchecked containers `healthy`, **`FailingStreak 0`** |
| Restarts | `ia_api`/`ia_worker`/`ia_web` started **2026-10-15T05:57:4xZ** (the redeploy of §16); `ia_db` 2026-10-14T16:31Z and `ia_caddy` 2026-10-14T16:51Z — **both untouched by the redeploy**, so no database downtime |
| Images actually running | `ia_api` and `ia_worker` = `sha256:62f415fb4ef9…`; `ia_web` = `sha256:5eecf470b507…`; built 2026-10-15T05:55:27Z and 05:57:21Z |
| **Do the running images match today's source?** | **Yes.** The images were built from `b40d4e5` (§16.2), and `git diff --stat b40d4e5..HEAD` contains **only 4 documentation files** (`handoff.md`, `PROJECT_STATUS.md`, `VPS_DEPLOYMENT_RUNBOOK.md`, the 2026-10-15 redeploy handoff) — **no backend, frontend, migration or contract file changed**, so today's source and the deployed images are the same code |
| `GET /api/v1/health` · `/ready` | **200** `{"status":"ok"}` · **200** |
| Unauthenticated `GET /api/v1/users` | **401 `UNAUTHENTICATED`** with a `requestId` — the real router, not a 404 |
| Bare `/health` | **404** (expected: `/api/v1/health` is the endpoint — §12.1) |
| HTTP vs HTTPS | **HTTP only.** HTTP/1.1 on `:80` through Caddy works; `:443` is the provider's Traefik with a default self-signed cert and returns 404. Caddy's config has no site hostname, so it never attempts ACME |
| Cookie flags, over plain HTTP | `ia_session=…; Path=/; Expires=<+12 h>; HttpOnly; SameSite=Lax` — **HttpOnly ✔, SameSite=Lax ✔, no `Secure` (matches `COOKIE_SECURE=false`), no `Domain`**, and it is a **persistent** cookie (12 h from issue), not a session cookie |
| Response hardening | `Content-Security-Policy: default-src 'none' …`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, `X-Ratelimit-Limit: 300` — all present on API responses |
| `/api/v1/auth/me` | `huzzam` → role `owner`, **21 permissions**; `demo1` → role `coach`, **5 permissions** (matches §16.4) |
| `GET /api/v1/system/health` | `db ok` · `storage ok` (“Private local directory /app/var/files … a deployment needs an off-host bucket (OPEN-016)”) · `openwa **unknown**` (“runs on the mock provider … M7 adds the OpenWA adapter”) · `queue **unknown**` (“The message queue arrives with M7 — `message_jobs` does not exist yet”) · `scheduler` fresh (`stale: false`) · `lastBackup` **ok** at 2026-10-14T19:30:00Z · `version 0.1.0`. Both `unknown`s name their reason — they are not silent |
| Disk | `49G` free of `63G` (19% used); load average 0.14 |
| Production `/login` HTML | 8,544 bytes containing **0 `<form>`, 0 `<input>`, 0 `<button>`, and the string “password” does not occur** — this **confirms the §16.5 correction**: the pre-hydration credential leak is a `next dev` finding only |

---

## 4. The create path, end to end (the demo database was empty)

Everything in this section was created **through the deployed UI**, and every number is the one the
page displayed afterwards.

| Step | Control | Expected | Observed |
|---|---|---|---|
| 1 | `/players/new`: Register player (name, dob, group Under-11, guardian + phone + consent granted + receives invoices, notes) | player created, redirected to the player | **`/players/01a13e4a…?created=1`**, “Player registered.”, `IA-0001 · Under-11 · Audit Test Player`, `Outstanding Rs. 0`. API re-read: consent `granted` with `consentRecordedAt`, `receivesInvoices: true` |
| 2 | `/coaches` → Assign group ×2 (Under-11, Under-14, from 2026-10-15) | the coach ends up with both groups | dialog closed, no error; `GET /coaches` → `demo1` has **Under-11 + Under-14** |
| 3 | `/players/new` with a future date of birth | refused with a message | native browser validation stopped the submit: “Value must be 15/10/2026 or earlier.” (an *advisory* age note appeared alongside: “An age of 0 is outside the usual 3–25 range. You can still register the player.”) |
| 4 | Under-11 attendance sheet, 2026-10-15 | the new player is on the roster | **`1 on the roster`**, row `Audit Test Player · IA-0001 · unmarked` → “Mark all present” → `Present 1 · Unmarked 0 · 1 unsaved` → Save → `0 unsaved`, row reads `present since 15 Oct 2026 12:11 · by 01a13e24-03bb…` (academy-local time) |
| 5 | `/billing/new`: group Under-11, target 2026-10-15 → Preview | a preview line, nothing created | `2 · Preview for 2026-10-15` — **`1 line · LKR 4,000.00`**, `Audit Test Player · IA-0001 · Under-11 · 1 Oct – 31 Oct 2026 · Fee Rs. 4,000 · Due 22 Oct 2026 · Guardian Audit Test Guardian` |
| 6 | Continue → **Issue invoices** | invoices issued | `4 · Done — Billing run finished`, “**1 invoice created for 2026-10-15**”, `Run 01a13e4b`, started/finished 12:12 |
| 7 | `/billing/invoices/{id}` | the invoice renders | `INV-2026-000001`, `Issued`, `Balance Rs. 4,000`, period/issue/due dates, guardian billed, `Total LKR 4,000.00 · Paid LKR 0.00 · Balance LKR 4,000.00` |
| 8 | Invoice **Download PDF** (called the same way the button does) | a PDF | **200**, `application/pdf`, **2,645 bytes** |
| 9 | `/payments/new`: payer = the guardian, 4000, bank transfer, reference `INV-2026-000001`, a synthetic 1-page PDF uploaded as the proof, status **Confirmed** → Record payment | payment recorded; the allocation rows prefilled | `POST /payments` **201** then `POST /payments/{id}/proofs` **201**; landed on `/payments/01a13e4c…` showing `Confirmed · Allocated Rs. 0 · Credit Rs. 4,000`, “A proof is evidence only — the payment counts after you confirm it.” **The allocation row was prefilled `4000.00`** (verified separately) but the form was submitted before I had touched it — my sequencing, not a defect |
| 10 | `/payments/{id}` → **Allocate credit** → *Use the suggested amounts* → Allocate credit | allocated, invoice paid | dialog showed `Available to allocate: LKR 4,000.00` → after the suggestion button, the field reads `4000.00` and “Applied LKR 4,000.00 · Left over LKR 0.00” → after allocating: **`Allocated Rs. 4,000 · Credit Rs. 0`** |
| 11 | The invoice again | paid | **`Paid` · `Balance Rs. 0`** |
| 12 | `/dashboard` | the numbers move | **before:** `INVOICED Rs. 0 · COLLECTED Rs. 0 · OUTSTANDING Rs. 0`. **after:** `INVOICED Rs. 4,000 (1 invoice issued in the period) · COLLECTED Rs. 4,000 (confirmed payments received in the period) · OUTSTANDING Rs. 0 · OVERDUE Rs. 0` |
| 13 | `/reports/collections` | one row, separate columns | `2026-10-15 · COLLECTED Rs. 4,000 · INVOICED Rs. 4,000 · COUNT 2`; header still reads “They are never added together” |
| 14 | `/reports/outstanding` | the row disappears once paid | **“No records for this report yet”** (before allocation it listed `INV-2026-000001 · Rs. 4,000 · 0 days overdue`) |
| 15 | `/players` | the player appears | `Players, 1 matching` — `IA-0001 · Audit Test Player · Under-11 · 9 · Active · +94770000001 · Rs. 0` |

**Verdict on the money path: it works, and `invoiced ≠ collected` is visibly structural** — the
dashboard reports Rs. 4,000 collected while the invoice still showed Rs. 4,000 outstanding, which is
the design, and both move independently as the allocation lands. The proof-never-pays rule is
visible too: the payment was `Confirmed` and *still* left the invoice at `Balance Rs. 4,000` until
it was allocated.

---

## 5. Defects

### (a) Broken

#### A1 — **Signing out does not work, and does not end the session.** `POST /auth/logout` → 500

**Expected:** pressing “Sign out” clears the cookie and revokes the session server-side; the next
request is unauthenticated.
**Observed:** `POST /api/v1/auth/logout` → **500 `INTERNAL_ERROR`**. The app bounces to
`/login?next=%2Fprofile` and — measured — **the session is still valid afterwards**.

**Root cause, from the API's own log (verbatim):**

```
err: {"type":"DatabaseError","message":"invalid input syntax for type uuid:
  \"602cda20fafa2d08b34a3862407e20996f67ff979f69c3197ebd2696d087faf4",
  "code":"22P02","routine":"string_to_uuid",
  "stack":"... at async Module.record (file:///app/dist/src/audit.js:47:5)
          at async file:///app/dist/src/routes/auth.js:191:9
          at async withTransaction (file:///app/dist/src/db/pool.js:38:24)
          at async auth02Logout (file:///app/dist/src/routes/auth.js:189:5)"}
reqId "req-8h" → res.statusCode 500
```

`src/routes/auth.ts:251` (`auth02Logout`) runs the revoke **and** the audit write inside one
transaction, and hands `viewer.sessionId` to `audit.record({ entityId: viewer.sessionId })`. That
value is the **session's primary key, which is `sha256(token)` — a 64-character hex `text`**
(`migrations/0002_identity.sql:144`: `id text primary key, -- sha256(token)`), while
`audit_logs.entity_id` is **`uuid`** (`migrations/0001_platform.sql:94`). Postgres raises `22P02`,
the whole transaction rolls back, so **`revokeSession` never commits and `reply.clearCookie` is
never reached.**

**Reproduction (no browser needed):**

```bash
# login, keep the cookie
curl -c s.txt -H 'Host: inspire-player.lk' -H 'Origin: http://inspire-player.lk' \
  -H 'Content-Type: application/json' -X POST \
  -d '{"username":"huzzam","password":"12345"}' http://93.127.141.71/api/v1/auth/login
CSRF=$(...)   # the csrfToken from GET /auth/me
curl -b s.txt -H 'Host: inspire-player.lk' -H 'Origin: http://inspire-player.lk' \
  -H "X-CSRF-Token: $CSRF" -H 'Content-Type: application/json' -X POST \
  -d '{}' http://93.127.141.71/api/v1/auth/logout      # → 500 INTERNAL_ERROR
curl -b s.txt -o /dev/null -w '%{http_code}\n' \
  -H 'Host: inspire-player.lk' http://93.127.141.71/api/v1/auth/me   # → 200  (still signed in)
```

**Why 260 green tests missed it:** `grep -rn "logout" backend/tests` returns **nothing**, and
`AUTH-02` in the test suite appears only in a comment at the top of
`tests/integration/route-matrix.test.ts`. **There is no test for logging out**, so the one endpoint
every user presses cannot fail in CI. This is the most serious finding in this report: on a box with
a 5-character password reachable by anyone who sends the right Host header (§16.6), a user who signs
out on a shared computer is still signed in.**Fixed and verified locally** (never on the box — a redeploy is the owner's call): the audit record now
names the **user**, exactly as `auth.login` does, and keeps the session key in `after` where a `text`
column cannot break the chain. §10 has the local proof and the four new tests.

---

#### A2 — **`/settings` crashes for every owner.** The frontend and the contract disagree on two field vocabularies

**Expected:** the Settings screen opens on Academy details.
**Observed:** “This page couldn't load — Reload to try again, or go back.” and a JavaScript error
`Cannot read properties of undefined (reading 'trim')` on both **Reload** and **Back**. No tab, no
form, no field is reachable: academy details, billing rules, payment methods and branding are all
unusable. Screenshot: `_settings.png` / `settings-*` in the evidence folder.

**Root cause — the API and the frontend use different names for the same two fields:**

| | contract (`api/openapi.yaml` `AcademySettings`) + what the API returns | frontend (`src/api/types.ts:811`) |
|---|---|---|
| the academy's name | **`name`** — live response: `{"name":"Inspire Academy", …}` | **`academyName`** |
| the age rule | **`jan_1_of_year` \| `fixed_month_day` \| `today`** — live response: `"jan_1_of_year"` | **`jan_1` \| `fixed_date` \| `today`** |

`src/app/settings/page.tsx:188` evaluates `draft.academyName.trim()`, `academyName` is `undefined`,
and the page throws during render. The API is right and the frontend is wrong: the response body is
literally `{"name":"Inspire Academy","paymentInstructions":"","beneficiaryAccounts":[],…}`.

**Knock-on effects worth fixing at the same time** (same file):
* `#845` — the Branding tab reads `academyQuery.data?.academyName` and silently falls back to
  `me?.academy.name`, so it *looks* fine while reading a field that does not exist.
* a **save** would PATCH `academyName`, which the API does not accept — the academy's own name could
  not be changed through this screen even if it rendered.

**Reproduction:** log in as `huzzam`, open `/settings`, read the console
(`pageerror: Cannot read properties of undefined (reading 'trim')`), then
`curl -b s.txt -H 'Host: inspire-player.lk' http://93.127.141.71/api/v1/settings/academy`.

**Where the wrong spelling came from, which is the interesting part:** the **MSW mock**
(`src/mocks/store678.ts`, `src/mocks/handlers.admin.ts`) invented `academyName` / `jan_1`, and because
mock mode was the only mode this app had ever been built in (§12.7), the real screens were written
against the mock. `tsc` could not catch it — both sides were hand-written — and it only appeared the
first time the screen ran against the API. **Fixed and verified locally** (§10).

---

#### A3 — **Filtering `/payments` by date breaks the whole list.** The frontend sends a date where the contract requires a datetime

**Expected:** choosing “Received from 2026-10-01” filters the list.
**Observed:** the list is replaced by “**Something went wrong** — Some fields need attention. —
`Reference: db2257c3-…` — Retry”, after `GET /api/v1/payments?from=2026-10-01&…` → **422**.

```json
{"error":{"code":"VALIDATION_ERROR","message":"Some fields need attention.",
 "details":[{"field":"from","issue":"Invalid ISO datetime"},{"field":"to","issue":"Invalid ISO datetime"}]}}
```

The contract is explicit — `name: from … format: date-time, description: "Instant, ISO-8601 UTC"`
(`api/openapi.yaml`, `/payments` GET) — and the backend enforces it. The frontend sends
`YYYY-MM-DD`.

**Second consequence, always on:** the same request drives the non-blocking duplicate-payment hint
on `/payments/new`, so that hint has **never** worked — it 422s on every page load (visible in the
network log of §4 step 9). Any date-bounded payments query is broken for owner and coach alike.

**Reproduction:** as owner, `/payments` → set “Received from” → the error block; or call the URL
above. Screenshot: `payments-date-filter.png`.

**Wider than first reported — `/audit` has the same defect.** Probing every date-filtered list
endpoint on the box (`from=2026-10-01`) found exactly two that reject a business date: **`/payments`
and `/audit-logs`, both 422**; `/sessions`, `/coach-attendance`, `/invoices` (`issueFrom`),
`/billing/runs` and `/dashboard/owner` all answer **200** because they genuinely take business dates.
The audit page's own source comment had already flagged the ambiguity and left it unresolved. The
defect was therefore in **two** screens, and **both are fixed and verified locally** (§10).

---

### (b) Questionable, or by design

| # | Observation | Assessment |
|---|---|---|
| B1 | **The WhatsApp screen is a full-page error.** `/whatsapp` renders “Not found — This record does not exist, or it is outside your groups. Reference: ee5e0ef4…”. `GET /messaging/status` (MSG-06) and `GET /settings/automations` (SET-08) are both 404 because **M7 is unbuilt**, and `whatsapp/page.tsx:250` turns a failed automations query into `<ErrorState>`. Every sub-tab (`?tab=messages`, `?tab=reminders`, `?tab=settings`) does the same | **Consistent with the deferral** (§17) — but the owner should know the tab shows an *error*, not an “M7 not configured yet” state. A stub card would be kinder and harder to mistake for breakage |
| B2 | `GET /settings/automations` 404s on `/payments` too, where `proofCheckOn` silently reads `false` | Same origin as B1. Harmless today; it will need fixing when M7 lands |
| B3 | **“Allocate credit” with a blank amount closes the dialog and changes nothing**, with no message (`/payments/{id}`). My click did exactly this: no POST was attempted, no error appeared, the page simply came back unchanged | Arguably correct (nothing to allocate) but *silent*. A disabled primary button, or “enter an amount”, would be honest. The intended path — **Use the suggested amounts** → Allocate credit — works |
| B4 | `POST /auth/login` (and other POSTs) **without an `Origin` header → 403 `CSRF_FAILED`**, message: “**Your session token is stale. Reload and try again.**” | The rejection is right; the message is wrong for the case. A curl user or an integration is told a browser-ish lie |
| B5 | **Archive has no confirmation dialog.** Pressing “Archive” on an age group in the sweep archived it immediately (no `role="dialog"`, no native confirm). The audit trail recorded `age_group.archive` → `age_group.unarchive` → `age_group.archive` within one minute | The UI offers Unarchive, so it is recoverable, but every other destructive control in this app confirms. **§1 item 8** is this control |
| B6 | Coach check-in was **disabled with “Check-in is closed for this session (it opens 60 minutes before the start and closes 2 hours after the end)”** at 12:23 Asia/Colombo for a 16:00 session | **Correct.** I first mis-read the clock (the UI prints academy-local times; UTC was 06:53). The server refuses with `422 CHECKIN_WINDOW_CLOSED` for the same sessions, so the UI and the API agree, and the window is open from 15:00. Listed because it *looks* like a defect until the timezone is checked |
| B7 | `Strict-Transport-Security: max-age=15552000; includeSubDomains` is sent on **plain-HTTP** responses | Browsers ignore HSTS over HTTP, so it does nothing today; harmless, and correct the day TLS lands. Worth a glance when `COOKIE_SECURE=true` goes back |
| B8 | `ia_session` is a **persistent** cookie with a 12-hour `Expires`, not a session cookie | A deliberate choice (an idle timeout plus absolute expiry exist in `user_sessions`), noted so nobody reads “session cookie” into the name |
| B9 | The **2026-10-14 16:06/22:32 rows** in the audit trail (`auth.login` for a coach user that no longer exists, `user.reset_password` with “System” as actor) are still there, unchanged | Same unexplained anomaly as **§16.1. Still not reproduced, still not guessed at** |

### (c) Suggestions

1. **Add the two tests that would have caught A1 and A2.** A logout test (login → logout → the next
   request is 401) and a settings round-trip (GET → PATCH → GET) belong in the suite. A1 survived
   because *no test mentions logout at all*; A2 survived because the frontend's types are hand-written.
2. **Generate the frontend's types from `openapi.yaml`** — release-gate item 8. A2 and A3 are both
   “the hand-written type drifted from the contract”, and both would have been type errors.
3. **Make the API client refuse to send a `date` where the contract says `date-time`**, so A3 fails
   loudly at the call site rather than as a 422 the user reads as “Something went wrong”.
4. **Give `/whatsapp` a “not built yet” state** instead of the generic Not-found error (B1), and let
   `/payments` tolerate a failed automations query without a console error.
5. **Confirm before archiving an age group** (B5).
6. Remove the duplicate-payment query until it can be sent correctly (A3), or fix it with #3.
7. **When TLS lands**, put `Content-Security-Policy`-style scrutiny on the Caddyfile's response
   headers once more, and revisit B7 in the same pass.

---

## 6. The control-by-control sweep

Full per-route evidence (inventory, click outcomes, console/page errors, failed requests, the URL
after every click) is in the machine-readable run described in §8. The shape, per route:

| Route | Controls | Outcome |
|---|---|---|
| `/dashboard` | period tabs (This month / Last month / Custom), 13 links to sessions/players/billing/payments | all navigate; the Custom tab switches to date inputs; `GET /messaging/status` **404 ×2** (B1) |
| `/players` | search, status filter, age-group filter, “Has outstanding”, pagination | empty state “No players yet” before the create path; after it, `1 matching`, Open works |
| `/players/new` | 11 inputs, 2 selects, 1 checkbox, Add guardian, Register player | see §4; invalid submissions give per-field messages (§7) |
| `/age-groups` | New age group, Edit ×3, Archive ×3 | modals open/close cleanly; “X / 99 / 1” correctly refused; **Archive has no confirm** (B5) — archived and restored, §1.8 |
| `/sessions` | Add session, 15 Cancel-session buttons, date range, 2 filters, 12 “Open sheet” links | all 15 Cancel buttons skipped by the brief's rules; Add-session modal opens and cancels; filters and sheets work |
| `/sessions/{id}` | Cancel session, Mark all present, Save attendance, 4 status sets | status buttons and Save work; the empty-roster state is honest (“No players were on this group's roster on 15 Oct 2026”) |
| `/coach-attendance` | Add entry (dialog), coach select, date range | “Add coach time” dialog opens and cancels; empty state is honest (“Check-ins are self-reported and server-timestamped; they don't prove physical presence.”) |
| `/billing` | Invoices/Runs tabs, 3 filters, search | tabs and filters work (the earlier “no change” on *Invoices* was the default tab) |
| `/billing/new` | group select, target date, Preview → Continue → Issue invoices | full run in §4.5–4.6 |
| `/billing/invoices/new` | amount, due date, **Create invoice (disabled)** | correctly disabled until a player is chosen; the page says “Register a player” and links to it |
| `/billing/invoices/{id}` | Download PDF, and the void/adjust/send actions | PDF **200 / 2,645 bytes**; void was **skipped** (forbidden without asking) |
| `/payments` | status tabs ×3, 3 filters, search, pagination | works with no filter; **any date filter breaks it** (A3); “With credit” correctly sends `?tab=credit&hasCredit=true` and returns 200 |
| `/payments/new` | payer, name, amount, method, reference, date, notes, proof file, confirmed/pending radios, allocation rows | §4.9; allocation row prefills `4000.00`; invalid amounts give messages (§7) |
| `/payments/{id}` | Confirm, Reject, **Allocate credit**, Reverse, Edit, receipt download | allocate (the intended path) works; the rest were not pressed — they change money and are not mine to test on the owner's demo. B3 is the blank-amount case |
| `/schedules` | Generate sessions, Add schedule, Edit ×6, Generate ×6, Deactivate ×3 | Generate opens a dialog and reports `created`/`skipped`; Deactivate **skipped** by the brief's rules; Edit dialogs open/close |
| `/coaches` | Add coach, Assign group, Assignments, search | §4.2; the empty-state copy is honest (“No active group — this coach sees nothing yet.”) |
| `/whatsapp` | 4 tabs | **all four land on the Not-found error state** (B1) |
| `/reports` | 8 report links | all 8 open; collections/outstanding verified numerically (§4.13–4.14) |
| `/users` | Add user, Edit ×2, Reset password ×2, Disable ×2, role/status filters, search | Add/Edit dialogs open and close; **Reset password and Disable skipped** (the brief forbids them) |
| `/settings` | Reload, Back | **broken** (A2) — the only controls on the page are the error boundary's |
| `/audit` | 11 “View detail” buttons, actor filter, 3 text filters, date range | every detail dialog opens and closes cleanly and shows action / entity / when / actor / entity id; filters work |
| `/system` | Refresh | refetches (`GET /system/health` 200) and the “Last checked” timestamps move 12:21 → 12:22 |
| `/profile` | Change password, Set up authenticator, Sign out this device, Sign out other devices, Revoke ×4 | the password form renders (`current-pw`, `new-pw`) and was submitted **only with a deliberately wrong current password**; “Set up authenticator” opens the enrol panel and was **not** completed; **Sign out other devices and every Revoke were skipped**; **“Sign out this device” is A1** — it 500s and does not end the session |
| `/imports/players` | file input, header reference | a `.txt` and a CSV with a wrong header were both rejected with a readable reason; the header contract is printed on the page |
| `/403` | Go to dashboard | renders the intended state: “Access is enforced on the server too — hiding this link would not be enough.” |

---

## 7. Forms twice, and the keyboard-only pass

**Invalid submissions — the message the user actually sees:**

| Form | Input | Message shown |
|---|---|---|
| `/login` | both fields empty | native: “Please fill in this field.” (×2), no app message |
| `/login` | wrong password | “Username or password is incorrect.” — no account enumeration |
| `/players/new` | name `A`, guardian `B`, phone `not-a-number` | “**Please correct the highlighted fields**” + “Use 2–120 characters”, “Guardian name is required”, “Enter a valid Sri Lankan phone number” |
| `/players/new` | required fields empty | native required messages for full name, guardian name, guardian phone |
| `/players/new` | date of birth in the future | native: “Value must be 15/10/2026 or earlier.”, plus the advisory age note |
| `/payments/new` | `0.5` with a bank transfer | “**Could not record the payment — Please correct the highlighted fields.**”, plus “Choose a guardian, or type the payer's name”, plus the bank-proof hint “Ask for the bank's PDF e-receipt…” |
| `/age-groups` | name `X`, min 99, max 1 | **refused**, dialog stays open with its own explanation (no group created) |
| `/imports/players` | `.txt` file; then a CSV whose header is wrong | a readable reason each time, nothing imported |
| `/users` | Add user with a 1-character name | refused; the dialog stays open |

**Keyboard-only pass (no mouse):**

* **Login works end to end.** Tab order is `Skip to content → `#username` → `#password` →
  `Sign in`; typing the two fields and pressing **Enter** lands on `/dashboard`. ✅
* **The skip link works.** First Tab reaches “Skip to content”, Enter moves focus to `main#main`
  and the URL to `/dashboard#main`. ✅
* **`/players/new` tab order:** skip link → the 12 sidebar links → My account → Sign out →
  the WhatsApp banner link → “← Players” → `#fullName` → `#dateOfBirth` → `#registrationDate` →
  `#ageGroupId` → “Add guardian” → `#guardian-0-name` → `#guardian-0-phone` … every control is
  reachable and in visual order. The 15 Tab presses through the fixed sidebar before the content is
  the price of that sidebar — the skip link is the mitigation and it works.
* **`/payments/new` tab order:** the same prefix, then `#pay-payer → #pay-payer-name →
  #pay-amount → #pay-method → #pay-reference → #pay-received-at → #pay-notes → #pay-proof →
  #pay-status → “Record payment”` — the **file input is reachable by keyboard**, and the radio
  group is one tab stop. ✅
* Every interactive target measured ≥ 44 px in the shared kit; no focus-trapped or offscreen
  controls were found, and all 40 dialogs trapped focus correctly and restored it on close.

---

## 8. The fixes, and how each was verified

All three are **source changes only — none of it is on the box.** Rebuilding the images and
recreating the containers is on the brief's forbidden list without the owner, so the deployment still
runs the broken code and A1–A3 remain live there.

| | Change | Files |
|---|---|---|
| A1 | `auth02Logout` audits the **user** (`entityType: "user"`, `entityId: viewer.userId`) and keeps the session key in `after`, exactly as `auth.login` does. One transaction, so the revoke now commits and the cookie is cleared | `backend/src/routes/auth.ts` |
| A2 | `academyName` → `name`, and `jan_1`/`fixed_date` → `jan_1_of_year`/`fixed_month_day`, in the types, the settings screen **and the MSW mock that invented the wrong names** | `frontend/src/api/types.ts`, `app/settings/page.tsx`, `mocks/store678.ts`, `mocks/handlers.admin.ts`, `mocks/billing.ts` |
| A3 | A business date is widened to the academy-local day for the instant-typed filters, in **both** affected screens | `frontend/src/lib/dates.ts` (two helpers + `withAcademyDayRange`), `app/payments/page.tsx`, `app/payments/new/page.tsx`, `app/audit/page.tsx` |
| — | **Four new tests**, because the reason A1 survived is that **no test mentioned logout at all** | `backend/tests/integration/auth-surface.test.ts` (new) |

### The new tests, and what they pin

`tests/integration/auth-surface.test.ts`, all four green:

1. **logout ends the session** — `/auth/me` is 200 before, the logout is 204, `/auth/me` is **401
   `SESSION_EXPIRED`** with the same cookie afterwards. This is the regression test for A1: on the
   shipped box the logout answered 500 and the cookie kept working.
2. **the logout is audited against the user** — row read back with the migrator role:
   `entity_type = 'user'`, `entity_id = <the user's uuid>`.
3. **SET-01 serves the contract's names** — `name` is a string, `academyName` is absent, and
   `ageReferenceRule ∈ {jan_1_of_year, fixed_month_day, today}`. This is what makes the frontend's
   spelling a test-visible contract instead of a guess.
4. **a business date is refused where an instant is required** — `/payments?from=2026-10-01` and
   `/audit-logs?from=2026-10-01` are 422, and the same filter as an instant is 200.

### How the fixes were verified — locally, in a browser

Against the **local** stack (backend `:3200`, frontend `:3100` with `NEXT_PUBLIC_USE_MOCKS=false`,
the local Postgres on `:55432`), in real Chrome:

| Check | Before the fix (production) | After the fix (local) |
|---|---|---|
| `/settings` | `pageerror: Cannot read properties of undefined (reading 'trim')`, “This page couldn't load” | **no pageerror**; the Academy tab renders, `#academy-name` = `Inspire Academy`, `#academy-age-rule` = **`jan_1_of_year`** with options `jan_1_of_year / fixed_month_day / today` |
| `/payments` + a date filter | 422 → “Something went wrong” replaced the list | **200**, `?from=2026-10-01` renders the list; no `Something went wrong`, no 4xx on that request |
| `/audit` + a date filter | same 422 (never fired in the original sweep) | **200**, `?from=2026-10-01` renders the rows |
| Sign out, through the UI | `POST /auth/logout` **500**, cookie still worked | the server **cleared the cookie**, and replaying the browser's own old cookie answers **401 `SESSION_EXPIRED`**; no logout error |

**Suite results after the change:** `npx tsc --noEmit` exit 0 (backend and frontend); `npx eslint`
**0 errors / 0 warnings** on the frontend — the React Compiler rejected my first version of A3
(`preserve-manual-memoization` fires when a helper is called on a `useMemo` dependency in the
component body), so the conversion moved into the query function rather than the rule being disabled;
**backend `npx vitest run` → 264 passed / 264, 28 files, exit 0** (was 260/27, so the four new tests
are the difference and nothing else moved); frontend `npm run verify:unit` **17/17**;
and `scripts/tests-minimums.json` was raised to **264 / 17 integration files** in the same commit, with
`test:assert-report:self-test` still green.

The **frontend production build** also passes with the change (`next build` → “Compiled successfully
in 20.7s”, every route generated, zero errors or warnings) — the check that mock-mode history hid
(§12.7).

**Still not verified:** none of this has been deployed, so the **deployed** behaviour is unchanged
from §5 — A1, A2 and A3 are live on the box until someone rebuilds and restarts `ia_api` and
`ia_web`.

## 9. Evidence and how to re-run it

Everything was driven from a scratch harness **outside the repository** (the repo stays clean, per
the project's own convention that screenshots are not committed — `git ls-files '*.png'` is empty):

```
TMP/vps-audit/
  lib.cjs                            the shared driver (isolated Chrome + --host-resolver-rules)
  01-crawl.cjs … 08-coach-checkin.cjs  the eight phases, in the order run
  out/*.json                         machine-readable results: inventories, every click, every
                                     4xx/5xx, every console error and page error
  shots/*.png                        71 screenshots of every route and of each broken state
```

The Chrome launch that makes the hostname resolve without touching `hosts`:

```js
chromium.launch({ channel: 'chrome',
  args: ['--host-resolver-rules=MAP inspire-player.lk 93.127.141.71'] });
```

**Not verified in this session, stated plainly:**

* **No timing, load or performance measurement** — the brief forbids quoting dev-server or
  home-connection numbers as production ones, so none is quoted.
* **Nothing was tested at mobile viewport widths.** The responsive rules exist in the markup, but
  every measurement above is at 1440×900; the M9 real-device pass still owes this.
* **Screen-reader behaviour is not measured.** Focus order, labels, `aria-*` wiring and the skip
  link were, but no assistive technology was driven.
* **Void / reject / reverse / regenerate / refund-style paths were not pressed**, by the brief's
  rules — so the money paths that undo are still only covered by the automated suite, not by a
  person clicking them on this deployment.
* **The `/settings` fix was not applied to the box**, so A2 is diagnosed and reproducible, not
  demonstrated fixed.

## 10. Next steps

1. **Fix A1, A2 and A3, add the logout and settings tests, then deploy** (needs the owner: a rebuild
   and a redeploy are outside what this session was allowed to do).
2. **Then re-run this harness** — it is in `TMP/vps-audit` on this machine and is deliberately
   outside the repo, so move it into `frontend/.verify/` (logs kept, screenshots ignored) if it is to
   become repeatable.
3. The go-live items are unchanged: DNS (§5), TLS, a real password, off-host backups, the security
   review — and now **A1 before anything is pointed at this box**, because a sign-out that does not
   sign out is a security defect on a box with a 5-character password.
4. M9's remaining halves (performance, accessibility with a real reader, mobile, a bug bash on
   anonymised data) are untouched by this session.
