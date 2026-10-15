# HANDOFF 2026-10-15 — OpenWA spike S1: what the gateway actually does

Author: Freebuff      Milestone: M7 (messaging) — spike S1      Branch/PR: master, uncommitted at time of writing

**Scope.** Spike S1 from [OPENWA_INTEGRATION](../../architecture/OPENWA_INTEGRATION.md) §2: record
**observed** OpenWA behaviour for **O18–O22** instead of guessing it. The gateway was built and run
**on this machine** (`0.24.0`, `ENGINE_TYPE=baileys`, SQLite, port 2785) and driven through its own
REST API. **No phone was ever paired and no message was sent to any real number** — so everything
below is the behaviour of a gateway in the unauthenticated state, and the report says so at each
point rather than generalising.

| | |
|---|---|
| Engine | **`baileys`** (the spec's default, §12) — the `whatsapp-web.js` engine was not exercised |
| Session | one, `ia-spike-s1`, **never paired** |
| Questions answered | **O18 partly**, **O20 envelope**, **O21 partly**, **O22 partly** |
| Questions **not** answered | **O19 — untouched**; the inbound half of O20; "number not on WhatsApp" in O21 |
| M7 code written | **none** — the adapter is still not built, and §2's rule ("no M7 code merges until S1 is documented") still holds, because S1 is not finished |
| Raw evidence | `TMP/openwa-spike/evidence/` (`http-log.jsonl`, `webhook-deliveries.jsonl`, `s1-report.json`), with `S1-FINDINGS.md`, `INSTALL-NOTES.md` and the three scripts beside it |
| Deployed | **nothing** |

## 1. How to reproduce

Three scripts in `TMP/openwa-spike/`, in order, all loopback-only:

```
install.sh        # copy the source off OneDrive, install, prove the sqlite binary loads
boot-gateway.sh   # build exists already; boots on 2785 with the settings below
run-s1.sh         # drives the API, writes evidence/ + a summary report
```

Boot settings that matter: `ENGINE_TYPE=baileys`, `SERVE_DASHBOARD=false` (the dashboard source is
excluded — see §2), and **`WEBHOOK_SSRF_PROTECT=false`**, which is **test-only**: the spike's
webhook receiver is on `127.0.0.1`, and the SSRF guard blocks loopback by default. Never copy that
value to a deployment. `WEBHOOK_RETRY_DELAY` was left at the shipped `5000` so the backoff measured
is the backoff a deployment would get.

## 2. Four install blockers, all diagnosed

Recorded because they cost the previous session its whole runtime, and two of them are
environmental rather than project-specific. Full detail in `TMP/openwa-spike/INSTALL-NOTES.md`.

1. **`npm ci` in the OneDrive workspace fails with `ENOTEMPTY`** on a *different* directory each
   attempt — OneDrive races npm's cleanup. Still the reason the source must be copied off OneDrive
   to build.
2. **A leftover `npm ci` from the crashed session was still running** (`PID 10124`, started 12:59,
   117 s CPU) while new attempts ran **in the same directory**, which is what the "files vanishing
   mid-extract" (`TAR_ENTRY_ERROR ENOENT`) actually was. Nothing external was needed to explain it.
3. **`better-sqlite3@13.0.3` cannot build here** — Node 24 is ABI 137, `13.0.3` publishes no
   prebuild for it, so `node-gyp` runs and finds no Visual Studio. `npm ci` then exits 1 and
   **rolls the whole `node_modules` back to zero**, which is why previous attempts appeared to
   produce nothing. Fixed by pinning `better-sqlite3` to **`12.4.1`**, which does ship
   `node-v137-win32-x64` (verified 200 before relying on it; `12.0.0`, `11.10.0` and `13.0.3` all
   404). Because npm's `overrides` cannot rewrite a *direct* dependency, the pin goes in
   `dependencies`, so the install is `npm install`, not `ci`.
4. **`postinstall` runs a second full `npm ci` inside `dashboard/` and aborts the install if it
   fails.** The API build (`nest build`) only compiles `src/`, and `SERVE_DASHBOARD=false` disables
   serving the SPA, so `dashboard/` is excluded from the copy and that step becomes a no-op. The
   Baileys/whatsapp-web.js patch scripts still ran and all applied cleanly.

**Environmental, measured:** file creation on this box is ~18× slower than normal — 21.5 min for
the install against a **fully warm npm cache** (`0ms (cache hit)` on every tarball), with the tree
still growing at ~35–50 files/s. Network was fine (1.7 MB/s measured). Consistent with real-time
file scanning on write; Defender is on (`RealTimeProtectionEnabled=True`) but its exclusion list
needs administrator rights to read, so this was **not** confirmed further. **Consequence: run long
installs detached and poll — a foreground install will outlive a tool timeout.**

## 3. O18 — session lifecycle status strings (partly verified)

Observed, in order:

| Status | Where |
|---|---|
| `created` | in the `POST /api/sessions` **201** body |
| `initializing` | in the `POST /sessions/{id}/start` 200 body, then on the first poll |
| `qr_ready` | ~2 s later, where polling stopped |

Session object (this is what a health check reads):
`{id, name, status, phone, pushName, connectedAt, lastActive, createdAt, updatedAt, lastError, restriction, engineLoaded}`.

`GET /api/sessions/{id}/qr` → **200** `{ "qrCode": "data:image/png;base64,iVBORw0KGgo…", "status": "qr_ready" }`
— a **PNG data-URI** (~7.1 KB), not a raw payload, so a UI can render it directly and nothing needs
to store it.

**Not observed:** `authenticating`, `ready`, `disconnected`, `action_required`, `failed`. Those
names are from `session.entity.ts` (`SessionStatus`) and are **source-derived, not measured**. Only
`ready` means connected; the other seven must read as not healthy.

## 4. O19 — delivery/read (ack) semantics: **still open**

**No `message.*` webhook event fired at all**, because no message could be sent. There is therefore
**no evidence** of a server-accepted → delivered → read progression and no `ack` payload. The only
adjacent fact: a **failed** send still persists a message row, `status: "failed"`, `waMessageId: null`.

`GET /api/sessions/{id}/messages` returns **`{ messages: [ … ] }`** (wrapped, not a bare array).

**Nothing changes in the code because of this run.** §9.4's rule stands exactly as written: the
adapter emits only `server_accepted`/`unknown`, and no "Delivered" label appears until one real
send's progression has been watched.

## 5. O20 — webhook payload shape (envelope verified, inbound not)

Envelope on **every** delivery:

```json
{
  "event": "session.status",
  "timestamp": "2026-10-15T08:43:49.896Z",
  "sessionId": "8e0c9c43-138a-46e9-a263-1ee8676022d4",
  "idempotencyKey": "sess_8e0c9c43-…_initializing_2026-10-15T08:43:47.322Z_358e43d5-…",
  "deliveryId": "dlv_23cfec19-6655-42e1-8a4c-b48142a6c75f",
  "data": { "sessionId": "8e0c9c43-…", "status": "initializing" }
}
```

| Event | `data` |
|---|---|
| `session.status` | `{ sessionId, status }` |
| `session.qr` | `{ sessionId, qr }` — the same base64 PNG data-URI, **~9 KB per delivery** |

Headers, verbatim:

```
x-openwa-event:           session.status
x-openwa-idempotency-key: sess_…_initializing_2026-10-15T08:43:47.322Z_<webhookId>
x-openwa-delivery-id:     dlv_182fc320-7c46-42c5-a1a3-fb7e9bdb1af7
x-openwa-retry-count:     0
x-openwa-signature:       sha256=aeb3fbaa…daf        (only when the webhook has a secret)
user-agent:               OpenWA-Webhook/1.0.0
```

**Two O5/O6 claims moved from "docs" to "observed":** a subscription created **with** a secret
received `X-OpenWA-Signature: sha256=<64 hex>`; an otherwise identical subscription created
**without** one received **no signature header at all**. §9's "a missing header is a rejection" is
therefore correct *and* only safe because we always configure a secret.

**`message.received` was never produced**, so §11's opt-out payload remains documentation-based.
**Still open.**

The ~9 KB QR body is why §9's "store ids, never payloads" is load-bearing rather than tidiness.

## 6. O21 — HTTP error codes and bodies (partly verified)

| Situation invoked | Status | Body |
|---|---|---|
| Send while not connected | **409** | `{"message":"Session is not connected. The WhatsApp client is not ready.","error":"Conflict","statusCode":409}` |
| Empty `text` | 400 | `{"message":["text should not be empty"],"error":"Bad Request","statusCode":400}` |
| Missing `chatId` | 400 | `{"message":["chatId should not be empty","chatId must be a string"],…}` |
| **Malformed** `chatId` | **409** | the same "Session is not connected" body |
| Unknown session id | 400 | `{"message":"Session 'does-not-exist' is not active. Start the session first.",…}` |
| `GET` a non-UUID session id | 400 | `{"message":"Validation failed (uuid is expected)",…}` |
| Start an already-started session | 400 | `{"message":"Session is already started",…}` |
| **Rate limit** | **429** | `{"statusCode":429,"message":"ThrottlerException: Too Many Requests"}` |

**Three findings that change the design, now written into §7/§8/§9 of the architecture doc:**

1. **"Session not working" is 409, not 503.** Nothing may match it as a 5xx: a 5xx match routes it
   to `needs_review` — "the message may have been delivered" — when nothing was sent at all.
2. **A malformed recipient also answers 409**, because the session check runs *before* recipient
   validation. **409 must never be classified as `INVALID_RECIPIENT`** (which sets `dead` and tells
   the owner to use the manual fallback). While the session is down, recipient faults are invisible.
3. **The gateway's own throttle is much tighter than §6's pacing** — the 429 arrived on the **6th**
   rapid send, with `Retry-After: 1` and a full `X-RateLimit-Limit-short|medium|long|instance|ingress-ip`
   family. §6 paces at ≤ 40/hour, so **429 is ordinary backpressure the worker will meet in normal
   operation**, not an incident. The limiter is per instance / per ingress IP, so anything else
   sharing that IP consumes the same budget.

Also worth carrying: `GET /api/sessions/{id}` **requires a UUID** — a name gives
`400 "Validation failed (uuid is expected)"`. `OPENWA_SESSION_ID` must be the id from session
creation, **not** the name, and a 400 there must map to health **`down`**, not §8's `unknown`.

**Not observed:** the "number not on WhatsApp" response (the DTO says Baileys answers 400 for an
unregistered number and 503 when the lookup is unanswered). §7's `INVALID_RECIPIENT` row **stays
unconfirmed** and needs a live session.

## 7. O22 — webhook retry schedule (partly verified)

A subscription subscribed to `session.status`, `session.qr`, `session.authenticated` with
`retryCount: 5`, whose receiver answered **500** to its first four attempts:

| Delivery | `X-OpenWA-Retry-Count` | Arrived |
|---|---|---|
| `dlv_23cfec19…` | 0 | 08:43:50.033 |
| `dlv_23cfec19…` (retry) | **1** | 08:43:55.207 — **+5.17 s** |
| `dlv_ff995a1d…` | 0 | 08:43:52.169 |
| `dlv_ff995a1d…` (retry) | **1** | 08:43:57.256 — **+5.09 s** |
| `dlv_ffe626c0…` | 0 | 08:43:52.171 |
| `dlv_ffe626c0…` (retry) | **1** | 08:43:57.255 — **+5.08 s** |

- **First retry ≈ 5.1 s**, matching the shipped `WEBHOOK_RETRY_DELAY=5000` base.
- **`X-OpenWA-Retry-Count` is 0-based** — `0` on the first attempt, `1` on the first retry.
- **`X-OpenWA-Delivery-Id` is stable across the retry** (`dlv_23cfec19…` on both), so §9's
  delivery-id dedupe rests on a real property.
- **Refined for §9:** both ids are **per subscription, not per event** — one `session.status`
  delivered to three subscriptions produced three different delivery ids, and the idempotency key's
  last segment is the **webhook id** (`sess_<sessionId>_<status>_<ISO>_<webhookId>`). Deduping on
  either is still correct and required; it just will not catch the same event arriving through two
  subscriptions.

**Not observed:** the multiplier for 2nd+ retries. The probe counted attempts **per URL path**, so
several concurrent deliveries shared one counter and the later attempts were answered 200, which
ended each chain after the first retry. **The base delay is measured; the doubling is still code.**

## 8. What is still required — the owner's checklist

Everything left needs **one thing: the number**, paired once, in the place it will live.

- **Where it must be paired:** on the VPS (§12), **never on a developer machine** — a session paired
  here dies with this machine, and pairing twice is what trips WhatsApp's passkey gate. So the first
  pairing should be the one that survives.
- **Which number:** the dedicated academy number (a test number was supplied 2026-10-14; it is
  deliberately not written down). Not a personal number. The phone must stay online.
- **What to scan:** the gateway's own dashboard or `GET /api/sessions/{id}/qr`, which returns the
  pairing PNG data-URI; a pairing code is also available
  (`POST /api/sessions/{id}/pairing-code`) if scanning is awkward.
- **Env vars to set on the backend:** `OPENWA_BASE_URL`, `OPENWA_API_KEY`, `OPENWA_SESSION_ID`,
  `OPENWA_WEBHOOK_SECRET`. **`OPENWA_SESSION_ID` is the session's UUID, not its name** — the name
  fails with a 400 (see §6).
- **What "paired" looks like:** the session's `status` becomes `ready` (**the only connected value
  observed or in the enum**), `phone`/`pushName` populate, and `engineLoaded` is `true`. In
  `/system/health` that must read as integration `openwa` **healthy**; every other status reads as
  not healthy, and the queue stays paused.
- **Then, still outstanding for S1:** one real send's full status progression (**O19**), one inbound
  reply (**O20**), the unregistered-number response (**O21**), and a corrected retry probe for the
  multiplier (**O22**).
- **Unrelated but noticed:** the gateway needs a **prebuilt** `better-sqlite3` for the Node it runs
  on. If the VPS image is Node 24 without a compiler, pin `12.4.1` there too.

## 9. What this session did **not** do

- **No `OpenwaProvider` adapter** and no M7 code. §2's gate is "no M7 code merges until S1 is
  documented", and S1 is **not** documented to completion — O19 in particular is untouched.
- **No pairing**, no real message, no VPS deployment, nothing restarted or deployed anywhere.
- **The `whatsapp-web.js` engine was never exercised.**
- **M7 remains the one unbuilt feature**, exactly as the owner deferred it. Nothing here moves it to
  "done"; it moves five open questions from "guessed" to "measured, in part".

## 10. Files this session touched

**In this repo:** `docs/architecture/OPENWA_INTEGRATION.md` (§2 O18–O22 rows and the S1 note, plus
the O21-driven corrections in §7, §8 and §9) and this handoff. `handoff.md` §17 and
`PROJECT_STATUS.md` are updated to match. **No application code changed.**

**Outside this repo** (scratch, under `TMP/openwa-spike/`): the install/boot/run scripts, the
evidence folder, `S1-FINDINGS.md` and `INSTALL-NOTES.md`. The built gateway lives at
`C:\Users\Dell\openwa-spike\gateway` — outside OneDrive, which is the only way it builds here.
