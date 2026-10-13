# AUTH_AND_PERMISSIONS

> **Status:** Draft v1 (planned) · **Owner:** Claude (spec) / Freebuff (implementation) · **Updated:** 2026-10-11
> **Depends on:** [DATABASE](DATABASE.md) §7 · **Source of truth for:** roles, permission matrix, scope rules, session behaviour. Per-endpoint role/scope is also listed in [API_CONTRACTS](API_CONTRACTS.md) and must match this file.

## 1. Authentication

| Item | Decision |
|---|---|
| Method | Username + password ([ADR-018](../engineering/DECISIONS.md#adr-018)). The username is the **login identifier** (`citext`, unique case-insensitively, stored lower-case, immutable in v1); 3–32 chars from `a-z 0-9 . _ -`. There is no email credential anywhere. No social login, no parent login (out of scope). |
| Hashing | argon2id (OWASP-recommended parameters at implementation time; record the chosen values in DECISIONS). Never log or return hashes. |
| Password policy | ≥ 12 chars, not in a bundled common-password list, not equal to the username. No forced periodic rotation. |
| Sessions | Server-side sessions in `user_sessions`; opaque 256-bit random token; DB stores only its SHA-256. |
| Cookie | `ia_session`: `HttpOnly; Secure; SameSite=Lax; Path=/`, scoped to the academy's parent domain so `app.` (frontend) and `api.` (backend) are **same-site**. No tokens in `localStorage`. |
| Lifetimes (defaults) | Owner: idle 2 h, absolute 12 h. Coach: idle 24 h, absolute 14 days (phones at the pitch). Every login rotates the token; password change/reset revokes all other sessions. |
| Lockout / throttle | 5 consecutive failures ⇒ account locked 15 min (`locked_until`); additionally per-IP and per-username rate limits on `/auth/login`. Always the same generic error: `INVALID_CREDENTIALS`. |
| MFA | Optional TOTP for owners, **strongly recommended** because owners control money [OPEN-010]. Coaches: none in v1. |
| Account creation | Owner creates a user → `user_invites` link (72 h, single use) → user sets password. Forgot password: coach asks an owner to reset (generates a new invite link). Owner lockout recovery: CLI `reset-owner` run on the server ([DEPLOYMENT_AND_OPERATIONS](DEPLOYMENT_AND_OPERATIONS.md) §9). The owner picks the `username` at creation (USR-02) and it is shown once with the invite URL so it can be handed over out-of-band. No email service is required in v1 — user records carry no email field at all. |
| Disable user | `status='disabled'` + revoke all sessions immediately. Cannot disable/demote the **last active owner** (409 `LAST_OWNER`). An owner cannot demote themselves if that leaves zero owners. |

## 2. CSRF, CORS, transport

- State-changing requests (`POST/PUT/PATCH/DELETE`) require header `X-CSRF-Token` (value returned by `POST /auth/login` and `GET /auth/me`, bound to the session) **and** an `Origin`/`Referer` matching the allowlisted frontend origin(s). Missing/invalid ⇒ 403 `CSRF_FAILED`.
- CORS: only the configured frontend origin(s), `credentials: true`, explicit methods/headers; never `*`.
- HTTPS only; HSTS; cookies `Secure`. See [SECURITY_AND_PRIVACY](SECURITY_AND_PRIVACY.md).

## 3. Roles

| Role | Description |
|---|---|
| `owner` | Full academy administration, including money, messaging, users. Multiple owners allowed. |
| `coach` | Sees and acts only within their **currently assigned age groups** and own check-ins. No financial, messaging, user-admin or settings access. |
| *(public token)* | Not a role. Unauthenticated holders of a valid `invoice_access_token` may fetch exactly one invoice PDF. See [FILES_AND_PDF](FILES_AND_PDF.md). |
| *(OpenWA webhook)* | Not a role. Authenticated by **HMAC-SHA256** only (`X-OpenWA-Signature`, verified over the raw body); may only post provider events. See [OPENWA_INTEGRATION](OPENWA_INTEGRATION.md) §9. |

Future roles (e.g. `accountant` read-only, `parent`) are **not** built; the permission-string design below leaves room for them.

## 4. Permission matrix

Legend: ✅ allowed · 🔒 allowed within scope · ❌ denied (API 403, and RLS denies at DB where noted).

| Resource / action | Owner | Coach | Notes |
|---|---|---|---|
| Own profile / change password / sessions | ✅ | ✅ | |
| Users: list, create, edit, disable, reset | ✅ | ❌ | |
| Academy settings (all) | ✅ | ❌ | coach receives only academy name, logo, timezone via `/auth/me` |
| Age groups: create/edit/archive | ✅ | ❌ | |
| Age groups: read | ✅ | 🔒 assigned groups | |
| Group fees: read/write | ✅ | ❌ | **coaches never see fees** |
| Coach assignments: manage | ✅ | ❌ | |
| Coach assignments: read | ✅ | 🔒 own | |
| Players: create/edit/status/transfer | ✅ | ❌ | |
| Players: list/read | ✅ full | 🔒 assigned groups, **restricted projection** | coach fields: id, registrationNo, fullName, age, status, group, coachNotes. Not: DOB (age only), owner `notes`, guardians, balances |
| Guardians: read/write | ✅ | ❌ | optional `coach_can_see_guardian_phone` exposes **primary guardian name + phone only** |
| Duplicate check, group suggestion | ✅ | ❌ | |
| Training schedules/sessions: create/edit/cancel | ✅ | ❌ | |
| Sessions: read | ✅ | 🔒 assigned groups | |
| Player attendance: mark | ✅ | 🔒 assigned groups, session not older than edit window | |
| Player attendance: correct (change an existing mark) | ✅ any time | 🔒 inside edit window, reason required | after window ⇒ owner only |
| Coach check-in/out | ✅ (on behalf, as correction) | 🔒 own, own sessions only | |
| Coach attendance: read | ✅ all | 🔒 own | |
| Coach attendance: correct/create | ✅ with reason | ❌ | audited |
| Billing preview/run, invoices, adjustments, void | ✅ | ❌ | RLS deny |
| Payments, allocations, reversal, credit | ✅ | ❌ | RLS deny |
| Payment proofs upload/view/**verify** | ✅ | ❌ | RLS deny + storage private. Proof verification (`PRF-04`) is owner-only as well: a coach sees neither the proof nor the extracted facts/findings (`payerName`, masked accounts) — proof-class PII, [PAYMENT_VERIFICATION](PAYMENT_VERIFICATION.md) §6 |
| Receipts / invoice PDFs | ✅ | ❌ | |
| WhatsApp: status, logs, retry, pause, templates, rules, **automation switches (`SET-08`)** | ✅ | ❌ | per-automation on/off + master pause; every toggle audited ([ADR-019](../engineering/DECISIONS.md#adr-019)) |
| Dashboard (owner) | ✅ | ❌ | |
| Dashboard (coach: today's sessions, assigned groups) | — | ✅ | |
| Reports & CSV export | ✅ | ❌ | exports audited; attendance report for coach can be added later |
| Audit log, system health | ✅ | ❌ | |
| CSV import | ✅ | ❌ | |

Permission strings (used in code and tests): `users:manage`, `settings:manage`, `groups:manage`, `groups:read`, `fees:manage`, `players:manage`, `players:read`, `players:read_restricted`, `guardians:manage`, `sessions:manage`, `sessions:read`, `attendance:mark`, `attendance:correct_any`, `coach_attendance:self`, `coach_attendance:manage`, `billing:manage`, `payments:manage`, `files:read_sensitive`, `messaging:manage`, `reports:read`, `audit:read`, `import:manage`. Role → permission mapping lives in **one** server module; endpoints declare the permission they need.

## 5. Authorization pipeline (every request)

1. **Authenticate**: validate cookie → session row (not revoked/expired) → user `status='active'`. Touch `last_seen_at`/idle expiry.
2. **CSRF/Origin** check on non-safe methods.
3. **Coarse guard**: endpoint's required permission ∈ role's permissions, else 403 `FORBIDDEN`.
4. **Scope guard** (coach): resolve `coachGroupIds(on_date)` from `coach_group_assignments`. Every resource id in the path/body is resolved **server-side to its owning group** and checked ∈ scope. Out-of-scope ⇒ **404 `NOT_FOUND`** (not 403) for single-resource reads, to avoid confirming existence (IDOR hardening). List endpoints are filtered in the query, not post-filtered.
5. **Field projection**: serializer chosen by role (`PlayerOwnerView` vs `PlayerCoachView`). Never return a full row and strip in the frontend.
6. **DB context**: `SET LOCAL app.user_id/app.role` → RLS applies (DATABASE §7).
7. **Audit**: mutating and sensitive-read actions write `audit_logs` (who, what, before/after, reason, request id).

Deny by default: a route with no declared permission fails startup/CI (route-registry test).

## 6. Group-level and time-based rules

- A coach's scope on date *D* uses assignments active on *D*; ending an assignment removes access to future sessions immediately but historical attendance **they recorded** remains visible to owners.
- **Session scope:** coach may open session *S* iff `S.age_group_id ∈ coachGroupIds(S.session_date)`.
- **Edit window:** coach may create/modify `player_attendance` for *S* until `S.starts_at + attendance_coach_edit_window_hours` (default 24 h). Later changes: owner only.
- **Corrections:** changing an *existing* mark requires `reason` (5–200 chars) from coaches **and** owners; initial marking does not. All changes write audit rows with before/after.
- **Check-in window:** coach may check in from `starts_at − 60 min` to `ends_at + 120 min` (settings), once per session; check-out requires an open check-in of their own.

## 7. What the system can and cannot verify (coach time tracking)

Check-in is a **self-reported timestamp** recorded by the server at request time, tied to an authenticated coach, an assigned session and the check-in window. It does **not** prove physical presence (no GPS, no biometrics). Owners can correct entries; corrections are audited with reason. Do not present these records as proof for payroll disputes without further evidence.

## 8. Authorization test requirements

Mapped in [TESTING_AND_ACCEPTANCE](../engineering/TESTING_AND_ACCEPTANCE.md) (AUTH-*, SEC-*). Minimum automated suite:

1. **Route matrix test:** for every route × {anonymous, coach, owner} assert the status in the permission table (generated from the route registry; fails if a route is undeclared).
2. **IDOR test:** coach A requests coach B's group resources by id ⇒ 404 on single GET, absent from lists.
3. **Finance isolation:** coach calls every billing/payment/file/messaging/audit route ⇒ 403; direct SQL as `ia_app` with `app.role='coach'` returns 0 rows from financial tables (RLS test).
4. **Projection test:** coach player payload contains no guardian/DOB/notes/fee keys (schema allow-list).
5. **Window tests:** coach marks inside/outside edit window; correction without reason ⇒ 422.
6. **Session tests:** expiry (idle + absolute), revocation on disable/password change, lockout after 5 failures, CSRF missing/invalid, cookie flags.
7. **Last-owner tests** including concurrent demotion of two owners (exactly one succeeds).
