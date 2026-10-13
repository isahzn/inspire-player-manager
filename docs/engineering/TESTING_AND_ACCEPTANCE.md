# TESTING_AND_ACCEPTANCE

> **Status:** Draft v1 (planned — **no test has been written or run**) · **Owner:** Claude (spec) / Freebuff + Hassen (implement) · **Updated:** 2026-10-11
> **Depends on:** every architecture doc · **Source of truth for:** test strategy, acceptance criteria, traceability, release gate. Strategy shaped by the installed `engineering:testing-strategy` skill (pyramid; focus on business-critical paths, security boundaries, data integrity).

Test IDs are `T-<AREA>-nn`. Other documents may cite them without the `T-` prefix only inside a "Test" column. **A criterion is "verified" only when its automated test (or recorded manual check) has passed in CI/at a dated manual run** — record it in PROJECT_STATUS.

## 1. Strategy

| Layer | Scope | Tooling (suggested) | Owner |
|---|---|---|---|
| Unit | Pure rules: period math, due dates, eligibility, money parse/format, allocation maths, retry/backoff, template rendering | Vitest/Jest | both |
| DB constraint & transaction | Run against **real Postgres** (container): UQs, exclusion constraints, deferred triggers, RLS, locking, migrations from empty & from previous release | test DB per run | Freebuff |
| Integration (API) | Each endpoint with real DB, auth, validation, errors, audit rows | supertest/inject | Freebuff |
| Contract | Server responses validated against `openapi.yaml`; frontend generated types compile; mocks validated against schema | schema validators in CI | joint |
| Permission/security | Route × role matrix, IDOR, RLS independent test, CSRF, rate limit, header scan | custom + scanner | Freebuff |
| Concurrency | Parallel requests (payments, billing runs, check-ins, attendance) with N workers | scripted | Freebuff |
| Messaging | OpenWA **mock server** simulating failures/timeouts/status events/webhooks; one manual S1 run against real OpenWA | mock HTTP | Freebuff |
| PDF | Parse generated PDF text and compare totals with DB; render snapshot to PNG for visual diff; Sinhala/Tamil samples | pdf text extract | Freebuff |
| Frontend component/interaction | Forms, validation mapping, money helpers, attendance sheet, dialogs | Testing Library | Hassen |
| E2E | Critical journeys on mobile + desktop viewports against staging | Playwright | joint |
| Accessibility | axe in CI + manual keyboard/screen-reader checklist | axe, manual | Hassen |
| Backup/restore | Scripted restore into isolated DB + invariant job | script + log | Hassen |
| Mobile usability | Real phone checklist (attendance one-handed, payment record, upload photo) | manual | Hassen |
| Regression | Full suite on every PR; E2E smoke on each deploy; bug ⇒ new test first | CI | both |

Coverage targets (guidance, not goals in themselves): billing/payment/allocation/permission modules ≥ 95 % branch; overall backend ≥ 80 %; **every acceptance row below automated unless marked (manual)**.

## 2. Acceptance criteria (Given / When / Then)

### 2.1 Authentication & authorization
| ID | Criterion | Type |
|---|---|---|
| T-AUTH-01 | Given a coach session, when calling **every** route tagged financial/messaging/audit/settings/users/reports, then 403 (or 404 for id-scoped) and **no body leaks data**; generated from the route registry so new routes can't be skipped | integration |
| T-AUTH-02 | Given any route without a declared permission, then CI fails (deny-by-default) | unit/CI |
| T-AUTH-03 | Given coach A (group U12) and a U14 player id, when GET `/players/{id}`, then 404; list endpoints never contain U14 players | integration |
| T-AUTH-04 | Given a coach, when GET `/sessions/{id}` / `/sessions/{id}/attendance` of an unassigned group, then 404; PUT attendance ⇒ 404 and nothing written | integration |
| T-AUTH-05 | Coach player payload contains only allowed keys (allow-list), no `dateOfBirth`, guardians, `notes`, fee/balance | integration |
| T-AUTH-06 | Given coach assignment ended yesterday, when coach opens that group's next session, then 404 | integration |
| T-AUTH-07 | Last active owner cannot be disabled/demoted; two concurrent demotions of two owners leave ≥ 1 owner | concurrency |
| T-AUTH-08 | Idle/absolute expiry, revocation on disable and password change, lockout after 5 failures, cookie flags `HttpOnly; Secure; SameSite=Lax`, no token in JSON | integration |
| T-AUTH-09 | Non-GET without valid `X-CSRF-Token` or with foreign `Origin` ⇒ 403 `CSRF_FAILED` | integration |
| T-DB-RLS-01 | Connected as `ia_app` with `app.role='coach'`, SELECT from every financial table returns 0 rows and writes fail — **independent of the API** | DB |
| T-DB-RLS-02 | RLS coach scope on players/sessions/attendance matches API scope for assigned vs unassigned groups | DB |
| T-DB-RLS-03 | `ia_app` cannot UPDATE/DELETE `audit_logs`, `message_events`; cannot bypass RLS | DB |

### 2.2 Players, groups, history
| ID | Criterion | Type |
|---|---|---|
| T-PLY-01 | Create player with DOB, no group ⇒ allowed; group suggestion returned but **not** applied | integration |
| T-PLY-02 | Same name+DOB ⇒ 409 `DUPLICATE_SUSPECTED` until `acknowledgeDuplicates=true` | integration |
| T-PLY-03 | Player ages past a group's max age ⇒ group unchanged (no silent move) | integration |
| T-PLY-04 | Transfer closes open history, opens new row; old invoices, attendance, payments unchanged; overlapping history rejected by DB | integration + DB |
| T-GRP-01 | Archive blocked while active players assigned; fee overlap rejected by exclusion constraint | integration + DB |
| T-PLY-05 | Withdrawn/inactive players retained, searchable by status, excluded from future rosters and billing | integration |

### 2.3 Billing, invoices, payments (financial gate)
| ID | Criterion | Type |
|---|---|---|
| T-FIN-01 | Re-running the same scheduler day or manual run twice ⇒ second creates 0 invoices; `ALREADY_INVOICED` counted | integration |
| T-FIN-02 | 20 parallel billing-run requests (different idempotency keys) ⇒ exactly one invoice per eligible player-period | concurrency |
| T-FIN-03 | Same `Idempotency-Key` + same body ⇒ identical response, one record; different body ⇒ 422 `IDEMPOTENCY_KEY_REUSED` | integration |
| T-FIN-04 | Fee changed after issue ⇒ old invoice totals/PDF unchanged; next period uses new fee (worked examples 1, 4 in BILLING_ENGINE) | integration |
| T-FIN-05 | Partial payment 1,500 of 4,000 ⇒ `partially_paid`, balance 2,500; second 2,500 ⇒ `paid`, balance 0 (example 2) | integration |
| T-FIN-06 | **Two concurrent payments each allocating 3,000 to an invoice with balance 4,000** ⇒ exactly one succeeds; other 409 `ALLOCATION_EXCEEDS_BALANCE`; `paid_minor ≤ total_minor` always (example 8) | concurrency |
| T-FIN-07 | Allocating a payment to two invoices sums ≤ amount; surplus remains credit; credit later allocatable; reversal restores states (examples 3, 6) | integration |
| T-FIN-08 | Void excludes invoice from outstanding/overdue/dashboard; void with allocations requires `releaseAllocations`; scheduler does not recreate it unless `allowReissue` (example 10) | integration |
| T-FIN-09 | Pending payment with proof ⇒ no allocations, no receipt, balances unchanged; after confirm ⇒ allocations + receipt; reject ⇒ nothing | integration |
| T-FIN-10 | Cash payment recorded without proof ⇒ confirmed | integration |
| T-FIN-11 | Overdue derived on academy-local date boundary (23:59/00:01 Asia/Colombo) | unit |
| T-FIN-12 | Deferred invariant trigger blocks direct SQL that would make Σ allocations ≠ `paid_minor` or exceed totals | DB |
| T-FIN-13 | Money endpoints reject non-integers, negatives, > cap, and non-multiples of 100 when fractional disabled; no float in code (lint rule) | unit/integration |
| T-FIN-14 | Mid-period join, transfer, withdrawn-player eligibility match BILLING_ENGINE §4–§8 for both calendar and anchored modes, weekly and monthly | unit |
| T-FIN-15 | Due-date rules (all three) incl. `max(computed, issue_date)` and 28-day cap | unit |
| T-FIN-16 | Invoice numbers unique, sequential per year under concurrency; rolled-back issuance leaves no gap | concurrency |
| T-FIN-17 | Nightly invariant job detects injected corruption and alerts | integration |
| T-FIN-18 | Preview hash mismatch ⇒ 409 `PREVIEW_STALE` | integration |
| T-FIN-19 | Every money mutation writes an audit row with before/after/reason | integration |
| T-FIN-20 | With `proofCheck` on, a `pending` bank-transfer payment carrying a proof gets advisory `checks[]` only (duplicate reference, amount vs. outstanding, proof present/duplicate, pending age); **no** worker or automation path can move a payment to `confirmed`, allocate, or change a balance, and `PAY-04` remains the owner's action (non-owner ⇒ 403). Turning `proofCheck` off changes no stored payment | integration |

### 2.4 Files and PDFs
| ID | Criterion | Type |
|---|---|---|
| T-FIL-01 | Upload with `.jpg` extension but PDF/EXE bytes ⇒ 415; SVG/HTML ⇒ 415 | integration |
| T-FIL-02 | 5 MB + 1 byte ⇒ 413 (also at proxy); 6th proof ⇒ 422/409 | integration |
| T-FIL-03 | JPEG with EXIF GPS ⇒ stored copy has no EXIF | integration |
| T-FIL-04 | PDF containing `/JavaScript` ⇒ rejected | integration |
| T-FIL-05 | Storage keys contain no original filename/PII; bucket has no public access (config assertion) | integration/ops |
| T-FIL-06 | Coach/anonymous request for proof/PDF endpoints ⇒ 403/401; direct bucket URL without signature ⇒ denied | integration/ops |
| T-FIL-07 | Signed URL expires ≤ 5 min; reading proof writes an audit row | integration |
| T-FIL-08 | Public invoice link: valid token returns that invoice only; expired/revoked/unknown ⇒ identical 404; void revokes; rate limit enforced; `no-store` headers | integration |
| T-FIL-09 | **PDF totals equal DB**: for 50 randomized invoices (with adjustments/partials), text-extracted total/paid/balance equal `invoices` row; generator refuses on mismatch | integration |
| T-FIL-10 | PDF regenerates after payment/adjustment/void; unchanged input ⇒ same `pdf_input_hash`, no new file | integration |
| T-FIL-11 | Sinhala/Tamil player and guardian names render (visual snapshot) — Spike P1 | manual+snapshot |
| T-FIL-12 | Storage outage ⇒ billing/payment transactions unaffected; PDF stays stale and recovers | integration |
| T-FIL-13 | Receipt exists only for confirmed payment; reversal ⇒ watermark on regeneration | integration |

### 2.5 WhatsApp / OpenWA
| ID | Criterion | Type |
|---|---|---|
| T-MSG-01 | OpenWA mock returns connection refused ⇒ invoices/payments committed; job `failed` → retried with backoff to `dead` after 5 attempts; billing data unchanged | integration |
| T-MSG-02 | Same reminder scheduler run twice, and the job retried/restarted ⇒ exactly **one** provider send per dedupe key | integration |
| T-MSG-03 | Worker killed after provider call but before commit ⇒ job becomes `needs_review`, **not** resent automatically | integration |
| T-MSG-04 | Timeout after request sent ⇒ `needs_review`; 429/503 ⇒ retry with `Retry-After` | integration |
| T-MSG-05 | OpenWA reports session not working ⇒ queue pauses without consuming attempts; `/messaging/status` and dashboard show disconnected; recovery resumes in order | integration |
| T-MSG-06 | Job with only provider acceptance shows delivery `server_accepted`; **never** "delivered/read" unless the provider actually reported a device-delivered state. OpenWA's delivery/ack semantics are **VERIFY** ([OPENWA_INTEGRATION](../architecture/OPENWA_INTEGRATION.md) §2 O19) — until S1 confirms them the adapter may emit only `server_accepted`/`unknown`. Out-of-order or duplicate status events never lower state | integration |
| T-MSG-07 | Guardian consent `unknown`/`revoked`/opted-out ⇒ job `skipped` with reason; revoking cancels queued jobs; STOP keyword inbound ⇒ revoked + audit | integration |
| T-MSG-08 | Invoice paid/voided before send ⇒ job `skipped`/`cancelled`; amount rendered at send time reflects partial payments | integration |
| T-MSG-09 | Sends occur only inside send window and obey pacing/max-per-hour | unit/integration |
| T-MSG-10 | Pause switch stops claims immediately; resume continues | integration |
| T-MSG-11 | Manual retry re-checks consent/invoice; manual fallback stops automation for that job | integration |
| T-MSG-SEC-01 | OpenWA API key (`OPENWA_API_KEY`) absent from frontend bundle, API responses, logs, event payloads; OpenWA port (default **2785**) unreachable from the public internet (port scan); the dashboard and `/api/docs`, which share the API port, are not publicly reachable | ops/security |
| T-MSG-SEC-02 | Webhook signature: correct **HMAC-SHA256 over the exact raw body** matching `X-OpenWA-Signature: sha256=<hex>` accepted; missing, malformed or wrong signature ⇒ 401 **before** JSON parsing; OpenWA's automatic webhook retry delivering a repeated `X-OpenWA-Delivery-Id` is deduped and processed once; oversized body (> 256 KB) rejected | integration |
| T-MSG-12 | S1 spike evidence recorded for **O18–O22**: real session-status enum, delivery/ack progression, inbound/opt-out payload shape, HTTP error bodies, webhook retry behaviour | manual |
| T-MSG-13 | With `reminderOverdue` off (SET-08) and overdue invoices present, the daily scheduler enqueues **no** `reminder_overdue` job and cancels that kind's unsent jobs (`cancelled`, `skipReason='AUTOMATION_DISABLED'`); other kinds that are on are unaffected; re-enabling enqueues nothing retroactively (no back-fill blast) | integration |
| T-MSG-14 | Master pause (MSG-07) off ⇒ nothing is claimed whatever the per-automation flags say; with master on and one kind off, a claimed job of that kind is cancelled **without consuming an attempt**; a manual `INV-08` send still succeeds while `invoiceDelivery` is off (blocked only by master pause, health, consent); every toggle writes an audit row | integration |

### 2.6 Attendance and coach tracking
| ID | Criterion | Type |
|---|---|---|
| T-ATT-01 | Session generation twice ⇒ no duplicates; edited sessions untouched; schedule change affects only future | integration |
| T-ATT-02 | Weekday defaults are data: deleting Tue/Thu schedules works without code change | integration |
| T-ATT-03 | Roster respects group history at session date, transfers, withdrawn players | integration |
| T-ATT-04 | Bulk save is atomic; retry with same key ⇒ no duplicates; invalid player ⇒ 422 and nothing saved | integration |
| T-ATT-05 | Coach edit within window w/ reason ok; without reason ⇒ 422 `REASON_REQUIRED`; after window ⇒ 422; owner any time; **every change audited** with before/after | integration |
| T-ATT-06 | Two coaches editing same record ⇒ second gets 409 `VERSION_CONFLICT` | concurrency |
| T-ATT-07 | Double check-in ⇒ 409; second open check-in on another session ⇒ 409; check-out without check-in ⇒ 409; outside window ⇒ 422; client-supplied times ignored | integration |
| T-ATT-08 | Owner correction of coach attendance requires reason, sets `corrected`, audited | integration |
| T-ATT-09 | Timezone: session at 18:00 Asia/Colombo has expected UTC; display in academy tz; DST-zone test keeps local time | unit |
| T-ATT-10 | Attendance-rate formula excludes excused/unmarked/cancelled | unit |
| T-ATT-11 | Dashboard coach time derives only from `coach_attendance`: `checkedInNow` lists open records with elapsed minutes, `todayMinutes`/`weekMinutes` count **closed** records only, a check-in open > 12 h appears in `openNeedingCorrection` + the alerts strip; after check-out the coach leaves `checkedInNow` and hours grow by the recorded span; **no coach-time figure changes any invoice, fee, balance or player attendance metric** | integration |

### 2.7 Reports, dashboard, exports
| ID | Criterion | Type |
|---|---|---|
| T-RPT-01 | Dashboard `invoicedMinor` ≠ `collectedMinor` semantics proven with fixtures (invoice issued, unpaid; payment received for older invoice) | integration |
| T-RPT-02 | Outstanding/overdue exclude void and paid; credit shown separately | integration |
| T-RPT-03 | CSV export respects filters, owner-only, audited, row cap, UTF-8 BOM, Sinhala/Tamil intact | integration |
| T-RPT-04 | Cells starting with `= + - @` are neutralized | unit |

### 2.8 Security / platform
| ID | Criterion | Type |
|---|---|---|
| T-SEC-01 | Brute-force: 5 wrong passwords ⇒ lock; per-IP throttle | integration |
| T-SEC-02 | Unknown body fields on mutating endpoints rejected (no mass assignment) | integration |
| T-SEC-03 | SQLi fuzz on filters/sort (`q`, `sort`) returns 422/empty, never errors/leaks | security |
| T-SEC-04 | Security headers present on API and frontend (scanner) | ops |
| T-SEC-05 | Errors never include stack traces/SQL/paths | integration |
| T-SEC-06 | Logs contain no passwords/tokens/cookies/keys/full phones (log scrub test) | integration |
| T-SEC-07 | Audit chain verification detects a tampered row; anchor stored | integration |
| T-SEC-08 | Dependency scan has 0 high/critical; secret scan clean | CI |
| T-SEC-09 | XSS: names with `<script>`/HTML render inertly in UI and PDFs/CSV | E2E |
| T-OPS-01 | **Backup restore**: latest dump restored to isolated DB; invariant job green; sample proof + PDF retrievable; duration ≤ RTO; recorded in RESTORE_LOG | manual, quarterly |
| T-OPS-02 | Migrations apply from empty and from previous release; rollback procedure rehearsed on staging | CI/manual |
| T-OPS-03 | `/ready` fails when DB down; uptime monitor alerts | ops |

### 2.9 Frontend
| ID | Criterion | Type |
|---|---|---|
| T-UI-01 | Money helpers: parse/format table (0, 1, 99, 100, 4000.50, 123456789, invalid) exact; no floating error | unit |
| T-UI-02 | Attendance sheet usable at 360×640: ≥ 44 px targets, one-hand reach, save bar visible, offline draft restored | E2E + manual |
| T-UI-03 | Every form maps `details[].field` errors to inputs; `VERSION_CONFLICT` dialog flow | component |
| T-UI-04 | Coach login shows no owner navigation; direct URL to owner route shows 403 page and fires no owner API calls | E2E |
| T-UI-05 | Idempotency key reused on retry of record-payment after simulated network drop; no duplicate | E2E |
| T-UI-06 | axe: 0 serious/critical on key pages; keyboard-only completion of login, attendance, record payment, billing wizard | a11y |
| T-UI-07 | Dates/times show academy timezone regardless of device timezone | component |
| T-UI-08 | "Delivered" badge appears only for `device_delivered`/`read` | component |
| T-UI-09 | Dashboard labels Invoiced and Collected separately | component |
| T-UI-10 | Coach clock in/out at 360×640: one tap from the session card (no dialog), ≥ 48 px target, thumb-reachable, elapsed time visible while clocked in, keyboard-operable, correct with `prefers-reduced-motion` | E2E + manual |
| T-UI-11 | Automation switches (SET-08) usable at 360 px: each states its effect, asks for confirmation, mirrors master pause read-only when MSG-07 is active, and warns when an automation is off while unpaid invoices exist | component + manual |
| T-UI-12 | Verification queue: a checked payment reads **Pending verification** everywhere (never "verified"/"paid"), a failed check explains itself without blocking Confirm, and the queue is hidden when `proofCheck` is off | component |

### 2.10 Payment proof verification (CR-004)
| ID | Criterion | Type |
|---|---|---|
| T-VER-01 | A bank-transfer payment with a **PDF e-receipt** gets `docKind='bank_receipt_pdf'` and L1/L2 findings; a JPEG/PNG proof gets `bank_receipt_image`, is never parsed, and can never produce a passing check (supporting-only) | integration |
| T-VER-02 | L2 cross-check matrix: amount mismatch (`AMOUNT_MATCH`), beneficiary not matching `payment_instructions` (`BENEFICIARY_MATCH`), explicit non-successful status (`STATUS_SUCCESSFUL`), a `reference` already attached to another payment and a byte-identical file (`sha256`) already stored (`RECEIPT_NOT_REUSED`, `FILE_DUPLICATE`) ⇒ `fail` with a plain reason; `REFERENCE_MATCH`/`DATE_TOLERANCE`/`PAYER_SOFT_MATCH` deviations ⇒ `warn` only | unit/integration |
| T-VER-03 | A PDF with active content (`/JavaScript`, `/Launch`, `/EmbeddedFile`, `/OpenAction`) is rejected, and one with no text layer is flagged `NO_TEXT_LAYER` and never parsed; a malformed or pathological PDF fails **one** proof without failing the process, the request or any other proof (sandboxed, bounded CPU/memory, no network, no rendering) | security/integration |
| T-VER-04 | **No verification path can confirm a payment:** after every check passes the payment is still `pending`, `PAY-04` remains an owner action (coach/non-owner ⇒ 403), and no balance, allocation, receipt or invoice status changed | integration |
| T-VER-05 | `parserVersion` and `checkedAt` are stored with each result, and re-running `PRF-04` after a parser update replaces the findings without touching money state; extracted values and findings never appear in logs or error responses (proof-class PII) | integration |
| T-VER-06 | Extracted values from a synthetic receipt fixture match exactly in minor units (no floats); a label test proves a passing check renders **"Ready to confirm — checks passed"** and never "verified"/"paid" while the status is `pending` | unit/component |

## 3. Requirements-to-tests traceability matrix

| Req | Requirement (source section of the master prompt) | Spec docs | Tests |
|---|---|---|---|
| REQ-01 | Owner/coach permissions enforced server-side + DB (§4) | AUTH §4–§6, DATABASE §7 | T-AUTH-01..09, T-DB-RLS-01..03, T-UI-04 |
| REQ-02 | Player mgmt, history, duplicates, retention (§5) | DATABASE §3.2, API §3.4 | T-PLY-01..05, T-GRP-01 |
| REQ-03 | Billing rules 1–16 (§6) | BILLING §3–§9 | T-FIN-01,02,04,08,14,15,16,18 |
| REQ-04 | Invoice snapshot/immutability (§6) | BILLING §1,§10; DATABASE §4 | T-FIN-04,08, T-FIL-09,10 |
| REQ-05 | Payments, partial, allocation, credit, correction, proof ≠ payment (§6) | BILLING §11 | T-FIN-05,06,07,09,10,12 |
| REQ-06 | Money accuracy (§6) | DATABASE §1, BILLING §15, [PAYMENT_VERIFICATION](../architecture/PAYMENT_VERIFICATION.md) | T-FIN-12,13, **T-FIN-20**, T-UI-01, **T-UI-12**, **T-VER-01..06** |
| REQ-07 | PDFs invoices/receipts (§7) | FILES §2–§4 | T-FIL-09..13 |
| REQ-08 | Private files, signed access, validation (§7) | FILES §5–§8 | T-FIL-01..08 |
| REQ-09 | OpenWA delivery/reminders/queue/health/retry/duplicates/consent (§8) | [OPENWA_INTEGRATION](../architecture/OPENWA_INTEGRATION.md) all | T-MSG-01..**14**, T-MSG-SEC-01/02, T-UI-08, **T-UI-11** |
| REQ-10 | Attendance & corrections audited (§9) | ATTENDANCE §1–§3 | T-ATT-01..06, T-ATT-09 |
| REQ-11 | Coach check-in/out; limits of verification (§9) | ATTENDANCE §4, AUTH §7 | T-ATT-07,08, **T-ATT-11**, **T-UI-10** |
| REQ-12 | Dashboard, reports, CSV, invoiced ≠ collected (§10) | PAGE_SPEC §2,§10; API §3.8 | T-RPT-01..04, T-UI-09 |
| REQ-13 | Audit history & integrity (§4, §13) | DATABASE §3.7 | T-FIN-19, T-ATT-05, T-SEC-07, T-DB-RLS-03 |
| REQ-14 | Security controls (§13) | SECURITY | T-SEC-01..09, T-AUTH-08/09 |
| REQ-15 | Backups & restore proven (§13, §16) | DEPLOYMENT §7 | T-OPS-01, T-OPS-02 |
| REQ-16 | Mobile-first UI, accessibility, states (§11) | FRONTEND docs | T-UI-02..07, **T-UI-10..12** (CR-003: every new surface must be usable one-handed at 360 px) |
| REQ-17 | Deployment, health, monitoring, handover (§16) | DEPLOYMENT | T-OPS-03, release gate |
| REQ-18 | Timezone/schedule configurability (§9) | ATTENDANCE §2 | T-ATT-02, T-ATT-09, T-FIN-11 |

## 4. Release gate (all must be true; evidence recorded in PROJECT_STATUS)

1. CI green: unit, DB, integration, contract, concurrency, security suites; **T-FIN-* and T-AUTH-* and T-DB-RLS-* have 0 failures and 0 skips**.
2. E2E smoke on staging for: login (owner, coach), register player, attendance save (mobile viewport), **coach clock in → clock out → hours visible on both dashboards**, billing run, record payment + receipt, **a bank-transfer PDF receipt verified (`PRF-04`) and the verification queue**, send WhatsApp via mock, void invoice.
3. T-FIL-09 (PDF totals) and T-MSG-02/03/06 pass.
4. OpenWA spike S1 documented (O18–O22) and T-MSG-12 done with the real number; if `attachment_and_link` mode is enabled, the document-send test too.
5. Accessibility (T-UI-06) and mobile real-device checklist (T-UI-02, and T-UI-10..12 for clock in/out and the automation switches) signed off by Hassen.
6. T-OPS-01 performed within the last 90 days; T-OPS-02 rehearsal done.
7. Security gate in [SECURITY_AND_PRIVACY](../architecture/SECURITY_AND_PRIVACY.md) §7 satisfied.
8. Contract: `openapi.yaml` matches running server; frontend types generated from it; no open "contract drift" items in HANDOFF reports.
9. Open decisions affecting release (OPEN-001/002/009/018/019) resolved or explicitly accepted as defaults by the decider in writing.
10. Owner handover pack delivered; first owner created with TOTP.
