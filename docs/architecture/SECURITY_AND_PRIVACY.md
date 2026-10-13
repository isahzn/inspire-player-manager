# SECURITY_AND_PRIVACY

> **Status:** Draft v1 (planned) · **Owner:** Claude (spec) / Freebuff + Hassen (implementation, ops) · **Updated:** 2026-10-11
> **Depends on:** [AUTH_AND_PERMISSIONS](AUTH_AND_PERMISSIONS.md), [FILES_AND_PDF](FILES_AND_PDF.md), [OPENWA_INTEGRATION](OPENWA_INTEGRATION.md) · **Source of truth for:** threat model, control checklist, privacy, incident response.

Assumption: **the browser, the network and the database can be attacked.** Frontend validation is UX only; every rule is enforced server-side and, where listed, in the database.

## 1. Assets, actors, trust boundaries

| Asset | Sensitivity |
|---|---|
| Child names, DOB, registration data | High (minors) |
| Guardian names + phone numbers | High (PII) |
| Invoices, payments, proofs (bank refs, screenshots) | High (financial) |
| Credentials, sessions, API keys, HMAC secret | Critical |
| Audit log | High (integrity) |
| Attendance, coach hours | Medium |

Actors: owner (trusted, fallible), coach (limited-trust insider), guardian with link (anonymous), internet attacker, compromised device, malicious/curious insider with DB access, OpenWA/WhatsApp (untrusted external).

## 2. Threat model (STRIDE-oriented)

| # | Threat | Control | Test |
|---|---|---|---|
| T1 | Credential stuffing / brute force | argon2id, lockout, per-IP+account rate limits, generic errors, optional owner TOTP | T-SEC-01 |
| T2 | Session theft / fixation | HttpOnly+Secure+SameSite cookie, token rotation on login, hash-only storage, idle+absolute expiry, revoke on password change/disable | T-SEC-02 |
| T3 | CSRF | CSRF header token + Origin allowlist + SameSite=Lax + strict CORS | T-SEC-03 |
| T4 | **IDOR / BOLA** (coach changes ids) | scope guard resolves owning group server-side; 404 for out-of-scope; list queries filtered in SQL; route-matrix test | T-AUTH-03..06 |
| T5 | **Privilege escalation** to finance | deny-by-default permission registry; RLS denies coach on all financial tables | T-AUTH-01, T-DB-RLS-01 |
| T6 | Mass assignment | request schemas with explicit allow-lists (`strict`), no spreading bodies into queries | T-SEC-04 |
| T7 | SQL injection | parameterized queries only; no string-built SQL; lint rule; sort/filter fields mapped from allow-lists | T-SEC-05 |
| T8 | XSS | JSON API only; frontend escapes by default; no `dangerouslySetInnerHTML` with user data; CSP; CSV/PDF outputs encoded | T-SEC-06 |
| T9 | CSV/formula injection in exports | prefix cells beginning `= + - @ \t \r` with `'`; UTF-8 BOM | T-RPT-04 |
| T10 | Malicious upload | magic-byte validation, size caps, image re-encode, PDF token screening, private storage, random keys, `nosniff` | T-FIL-01..05 |
| T11 | Proof/PDF disclosure | owner-only endpoints, short signed URLs, no public bucket, audited reads | T-FIL-06..08 |
| T12 | Invoice-link leakage | 256-bit token, hashed, expiry, revoke on void, rate limit, uniform 404, `no-store` | T-FIL-09..11 |
| T13 | OpenWA key leak / exposed OpenWA | server-side only, private network + firewall + proxy key enforcement, per-key session scoping + IP allow-list, dashboard locked, rotation runbook | T-MSG-SEC-01 |
| T14 | Forged webhook | HMAC-SHA256 raw-body verification of `X-OpenWA-Signature` (constant-time), IP allowlist, size limit, delivery-id dedupe | T-MSG-SEC-02 |
| T15 | Duplicate/forged money operations | idempotency keys, UQs, row locks, deferred invariants | T-FIN-* |
| T16 | Tampered audit trail | append-only grants, hash chain, daily verification + external anchor | T-SEC-07 |
| T17 | Data exfiltration via export/API | owner-only exports, audited, rate-limited, row caps | T-SEC-08 |
| T18 | Secrets in logs/repo | redaction middleware, secret scanning in CI, `.env` ignored, no secrets in error bodies | T-SEC-09 |
| T19 | Vulnerable dependencies | lockfile, weekly scan, 7-day fix SLA for high/critical | CI gate |
| T20 | Insider with DB access | least-privilege roles (no superuser), no `BYPASSRLS`, audit INSERT-only, backups encrypted | review |
| T21 | DoS / resource abuse | rate limits, body size limits, pagination caps, statement timeouts (5 s default, 30 s exports), worker pacing | T-SEC-10 |
| T22 | Timing/enumeration | generic login errors, uniform 404 for tokens and out-of-scope resources | T-SEC-11 |

## 3. Control checklist (what Freebuff must implement)

1. **Transport:** HTTPS only, HSTS (≥ 6 months), TLS 1.2+; redirect HTTP→HTTPS; secure cookies.
2. **Headers:** `Content-Security-Policy` (frontend: default-src 'self', no inline scripts; API: `default-src 'none'`), `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Permissions-Policy` minimal, `X-Frame-Options: DENY`/`frame-ancestors 'none'`.
3. **Validation:** every request body/query/path validated by schema (type, length, range, enum) → 422 `VALIDATION_ERROR`. Unknown fields rejected on mutating endpoints. Phone numbers normalized; names NFC-normalized, control characters stripped.
4. **Errors:** no stack traces, SQL, file paths or secrets to clients; `requestId` for correlation; `INTERNAL_ERROR` generic.
5. **Logging:** structured; never log passwords, tokens, cookies, API keys, HMAC secrets, full phone numbers (mask), message bodies, proof contents. Log auth events, permission denials, financial ops (ids only).
6. **Secrets:** environment/secret manager only; separate per environment; ≥ 32-byte random values; rotation schedule (OpenWA API key 6-monthly, session/cookie secret yearly, DB creds yearly or on staff change).
7. **DB roles & RLS:** per [DATABASE](DATABASE.md) §7; statement timeout; `ia_app` no DDL.
8. **Rate limits & lockouts:** per [API_CONTRACTS](API_CONTRACTS.md) §1.
9. **Audit:** every mutation of money, people, permissions, settings, exports and sensitive reads (proof/PDF download, CSV export); hash-chained; daily verify job; latest hash anchored to object storage.
10. **Backups:** [DEPLOYMENT_AND_OPERATIONS](DEPLOYMENT_AND_OPERATIONS.md) §7 (encrypted, tested restore).
11. **CORS:** exact origins, credentials true.
12. **Frontend rules:** no secrets in bundles, no tokens in `localStorage`/URLs, never render server HTML unsanitized, treat 401 → login, 403 → permission-denied UI, don't cache authenticated responses in shared caches.

## 4. Privacy and data protection

The academy handles **children's data and guardian contact details**. Treat Sri Lanka's Personal Data Protection Act (No. 9 of 2022) as applicable and confirm obligations with local counsel before go-live [OPEN-019: legal review — not verified here; this document is engineering guidance, not legal advice].

| Principle | Implementation |
|---|---|
| Minimisation | No player photo, no medical data, no national ID/birth-certificate numbers, no addresses in v1. Coach view hides DOB/guardian data by default. Optional second guardian only. |
| Purpose limitation | Guardian phone used only for billing communication (+ optional coach contact if owner enables). |
| Consent for messaging | Per-guardian consent state, source, timestamp; opt-out honored immediately ([OPENWA_INTEGRATION](OPENWA_INTEGRATION.md) §11). |
| Access control | Role + group scope; audited sensitive reads. |
| Accuracy & correction | Owners can edit people data; edits audited. Guardian can ask the academy (owner) to correct/export their data: owner uses player/guardian pages + a "Data export (JSON)" action [OPEN-020 nice-to-have, not in M-plan v1; manual DB export procedure documented in runbook]. |
| Erasure | Anonymization procedure ([DATABASE](DATABASE.md) §6) when no unpaid balance and legal retention allows; financial rows keep amounts/numbers but lose names. Procedure = owner-triggered CLI/admin task with audit; documented in runbook. |
| Retention | Table in [DATABASE](DATABASE.md) §6. |
| Breach handling | §6 below. |
| Third parties | WhatsApp/Meta (messages), hosting providers, storage provider. List them in the academy's privacy notice (owner publishes; template text in handover doc). |
| Children | Messages go to guardians only; never message minors directly; no marketing content. |

## 5. Secrets inventory

| Secret | Location | Rotation | Used by |
|---|---|---|---|
| `DATABASE_URL` (app role), `DATABASE_MIGRATOR_URL` | secret store | 12 mo / staff change | API, worker / CI migrate |
| `SESSION_COOKIE_SECRET`, `CSRF_SECRET` | secret store | 12 mo (rotation logs everyone out) | API |
| `OPENWA_API_KEY`, `OPENWA_WEBHOOK_SECRET` | secret store (backend), OpenWA env | 6 mo / suspicion | worker, API |
| `STORAGE_ACCESS_KEY_ID/SECRET` | secret store | 12 mo | API, worker |
| `TOTP_ENCRYPTION_KEY` | secret store | with re-encryption task | API |
| `AUDIT_ANCHOR_*` | secret store | 12 mo | worker |

Never commit secrets; `.env.example` lists names only. CI runs secret scanning.

## 6. Incident response (small-team runbook)

| Step | Action | Owner |
|---|---|---|
| 1 Detect | Alerts (uptime, error spike), owner report, audit anomalies | Hassen / owners |
| 2 Contain | Disable affected user(s); revoke sessions (`USR-04`); pause WhatsApp (`MSG-07`); rotate suspect secrets; block IPs at proxy | Hassen |
| 3 Assess | Use `audit_logs` + request logs: what data, which records, which time window | Hassen + Freebuff |
| 4 Eradicate/Recover | Patch, rotate, restore from backup if data integrity affected ([DEPLOYMENT](DEPLOYMENT_AND_OPERATIONS.md) §7) | Freebuff / Hassen |
| 5 Notify | Academy owner immediately; affected guardians + regulator **if** personal data of children was exposed and law requires (confirm requirement with counsel, OPEN-019) | Academy owner |
| 6 Learn | Post-incident note in `docs/engineering/KNOWN_RISKS.md` + new tests | Hassen |

## 7. Security acceptance gate

No release unless: route-matrix test green; RLS tests green; no high/critical dependency findings; secret scan clean; headers verified with a scanner; backup restore proven within the last 90 days; owner TOTP enrolled for all owners (or recorded risk acceptance). See [TESTING_AND_ACCEPTANCE](../engineering/TESTING_AND_ACCEPTANCE.md).
