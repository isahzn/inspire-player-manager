# DECISIONS (Architecture Decision Records)

> **Status:** Living document · **Owner:** Claude (author), Hassen (approver) · **Updated:** 2026-10-11
> Add new ADRs at the bottom; never delete — mark **Superseded by ADR-xxx**. Open business questions live in [OPEN_DECISIONS](OPEN_DECISIONS.md). Process: [CHANGE_MANAGEMENT](CHANGE_MANAGEMENT.md). ADR format follows the installed `engineering:architecture` skill.

| ADR | Title | Status |
|---|---|---|
| 001 | Backend stack: Node.js + TypeScript + Fastify | Proposed (Freebuff may counter-propose in M1) |
| 002 | PostgreSQL with constraints + RLS defense in depth | Accepted |
| 003 | Money as integer minor units | Accepted |
| 004 | Own cookie-session auth in Postgres | Accepted |
| 005 | Postgres-backed queue, no Redis | Accepted |
| 006 | No `draft` invoice state; preview instead | Accepted |
| 007 | Messaging provider port; WAHA first | **Accepted; WAHA-first superseded by ADR-017** (the port itself remains in force) |
| 008 | PDF generation library with Chromium fallback | Proposed (spike P1) |
| 009 | Contract ownership: Markdown until M1, then OpenAPI | Accepted |
| 010 | Overdue is derived, never stored | Accepted |
| 011 | Attendance: online API + local draft, no offline sync | Accepted |
| 012 | WAHA Core by default; spike S1 gates M7 | **Superseded by ADR-017** (OpenWA has no tiers; OPEN-002 resolved) |
| 013 | Proof ≠ payment; pending/confirmed payments | Accepted |
| 014 | Immutable invoices with snapshots | Accepted |
| 015 | Single-tenant single-academy | Accepted |
| 016 | Anonymize instead of hard-delete people | Accepted |
| 017 | Messaging provider is OpenWA (replaces WAHA) | Proposed — **supersedes ADR-012**; the ADR-007 port stays in force |
| 018 | Username is the login identifier; users have no email | Accepted |
| 019 | Messaging automation is per-automation opt-in, with one master pause | Proposed — owner to confirm (CR-003) |
| 020 | Bank-transfer proof checks are advisory; an owner always confirms | Accepted |
| 021 | Bank-transfer proofs are bank-issued **PDFs**, verified by extraction + cross-check; verification never confirms | Accepted |

<a id="adr-001"></a>
## ADR-001: Backend stack — Node.js LTS + TypeScript + Fastify + Zod
**Status:** Proposed · **Date:** 2026-10-11 · **Deciders:** Hassen (Freebuff to confirm)
**Context:** Greenfield; frontend in TypeScript; need schema-first contract and small ops footprint.
**Decision:** Fastify with Zod schemas generating OpenAPI; a SQL-first data layer (query builder or plain SQL; ORM allowed only if it supports RLS context, exclusion constraints and explicit locks).
**Alternatives:** NestJS (heavier, more ceremony); Python FastAPI (second language, but strong typing/OpenAPI); Go (fast, slower to iterate).
**Consequences:** One language across stack; Freebuff may swap framework via change process provided contract/invariants hold. **Sources:** to verify in M1 (framework docs).

<a id="adr-002"></a>
## ADR-002: PostgreSQL with DB constraints and RLS as backstop
**Status:** Accepted. **Context:** Money and permissions are high-risk; frontend/API bugs must not be able to corrupt data. **Decision:** PostgreSQL 16+; exclusion constraints for non-overlapping history/fees, partial unique indexes for duplicate prevention, deferred constraint triggers for financial sums, RLS (FORCE) with `SET LOCAL` context. **Alternatives:** API-only authorization (single layer, rejected); SQLite (no RLS/concurrency); MySQL (weaker constraint set). **Consequences:** Migrations are more demanding; tests must cover RLS separately; every request runs in a transaction with context. **Sources:** PostgreSQL docs on RLS, exclusion constraints, `SELECT … FOR UPDATE SKIP LOCKED` (official docs; not re-fetched this session — verify in M1).

<a id="adr-003"></a>
## ADR-003: Money as integer minor units
**Status:** Accepted. **Decision:** `bigint *_minor` (1 LKR = 100), JSON integers, strict decimal-string parsing at UI edge, no floats anywhere. **Alternatives:** `numeric(12,2)` (safe in DB, but JS float risk at the API boundary); strings in JSON (extra parsing). **Consequences:** Simple exact arithmetic and equality; UI helpers mandatory; cap LKR 100 M keeps values inside JS safe integers.

<a id="adr-004"></a>
## ADR-004: Own cookie-session auth stored in Postgres
**Status:** Accepted. **Decision:** Opaque tokens, hash-only storage, HttpOnly/Secure/SameSite cookie, CSRF header + Origin check, argon2id. **Alternatives:** JWT in browser (hard revocation, XSS exposure); managed auth provider (cost/lock-in, extra moving parts). **Consequences:** Same-site domains required (`app.` + `api.`); we own password reset flow (owner-issued invite links) and lockout logic.

<a id="adr-005"></a>
## ADR-005: Postgres-backed queue and scheduler, no Redis
**Status:** Accepted. **Context:** ≤ 100 messages/day, single worker. **Decision:** `message_jobs` with `FOR UPDATE SKIP LOCKED`, advisory locks for single-runner jobs. **Alternatives:** BullMQ/Redis, pg-boss, cloud queues. **Consequences:** Transactional enqueue with business writes; one fewer service to secure; revisit if volume grows 100×.

<a id="adr-006"></a>
## ADR-006: No `draft` invoice state
**Status:** Accepted. **Context:** Prompt suggested Draft; owners need review before issue. **Decision:** Billing **preview** (stateless, hashed) replaces drafts; invoices are born `issued`. **Alternatives:** persisted drafts (more states, stale-data problems, accidental duplicates). **Consequences:** Fewer transitions; correction path = void/reissue/negative adjustment.

<a id="adr-007"></a>
## ADR-007: Messaging provider port, WAHA first
**Status:** Accepted. **Decision:** Domain depends on `MessagingService`/`MessagingProvider`; only the WAHA adapter knows WAHA. **Alternatives:** direct WAHA calls from billing code (rejected: lock-in). **Consequences:** Mock provider for dev/test; official WhatsApp API adapter possible later ([OPENWA_INTEGRATION](../architecture/OPENWA_INTEGRATION.md) §14).

<a id="adr-008"></a>
## ADR-008: PDF via library (PDFKit) with Chromium fallback
**Status:** Proposed (spike P1). **Decision:** Start with PDFKit, embedded Noto fonts; if Sinhala/Tamil shaping fails, use headless Chromium HTML→PDF. **Alternatives:** Chromium first (heavier ops, larger attack surface, but easy HTML layout/complex-script shaping). **Consequences:** M6 begins with a time-boxed spike; the PDF layout spec is renderer-independent.

<a id="adr-009"></a>
## ADR-009: Contract ownership
**Status:** Accepted. **Decision:** `API_CONTRACTS.md` authoritative until M1 exit; then `api/openapi.yaml` authoritative (CI-validated), the Markdown becomes a summary. **Consequences:** Exactly one source of truth at any time; M1 exit requires the OpenAPI file reviewed by the frontend dev.

<a id="adr-010"></a>
## ADR-010: Overdue is derived
**Status:** Accepted. **Decision:** Stored invoice statuses: `issued`, `partially_paid`, `paid`, `void`. `isOverdue` computed from `due_date` and academy-local today. **Alternatives:** stored `overdue` flipped by a job (stale if job fails, extra transitions, wrong after payment races). **Consequences:** Queries repeat the predicate (indexed); no job dependency.

<a id="adr-011"></a>
## ADR-011: Attendance — online API with local draft
**Status:** Accepted. **Decision:** No offline sync/PWA in v1; frontend keeps a local draft and retries with the same idempotency key. **Alternatives:** full offline-first queue (complex conflict handling). **Consequences:** Poor-signal pitches tolerated by retry; revisit if coaches report data loss (OPEN-014).

<a id="adr-012"></a>
## ADR-012: WAHA Core by default; spike S1 gates M7
**Status:** ~~Proposed~~ **Superseded by [ADR-017](#adr-017)** (2026-10-11) — retained unedited for history.
**Status:** Proposed. **Context:** Core = text only, 1 session; Plus adds files/security; pricing unverified ([OPENWA_INTEGRATION](../architecture/OPENWA_INTEGRATION.md) §2). **Decision:** Build for **Core** (link-based invoice delivery); attachment mode behind a capability check for Plus. Spike S1 verifies unknowns before code. **Alternatives:** Plus from day one; official Business API from day one (template approval/cost overhead). **Consequences:** Delivery works without paid tier; PDF attachment is an optional upgrade.
**Sources (checked 2026-10-11):** WAHA [security](https://waha.devlike.pro/docs/how-to/security), [events](https://waha.devlike.pro/docs/how-to/events/), [receive messages](https://waha.devlike.pro/docs/how-to/receive-messages/), [pricing](https://waha.devlike.pro/pricing).

<a id="adr-013"></a>
## ADR-013: Proof is evidence; payments are pending or confirmed
**Status:** Accepted. **Decision:** Uploading a proof never changes money; only owner-confirmed payments (cash recorded directly confirmed) create allocations/receipts. **Alternatives:** auto-confirm on upload (rejected by requirement). **Consequences:** `pending` state exists; zero balance impact until confirmation.

<a id="adr-014"></a>
## ADR-014: Immutable invoices with snapshots
**Status:** Accepted. **Decision:** Snapshot academy/player/guardian/group/fee/period on issue; post-issue only void or negative adjustments; PDFs from snapshot only. **Consequences:** Fee/group edits never rewrite history; anonymization must scrub snapshots.

<a id="adr-015"></a>
## ADR-015: Single-tenant, single-academy
**Status:** Accepted. **Decision:** One `academy_settings` row; no `academy_id` columns. **Consequences:** Simpler schema/RLS; multi-academy later is a deliberate re-architecture.

<a id="adr-016"></a>
## ADR-016: Anonymize instead of hard-delete people
**Status:** Accepted. **Decision:** Erasure = anonymization (profile + snapshots) once no unpaid balance; financial rows retained per policy. **Consequences:** Referential integrity and audit continuity kept; legal retention to be confirmed (OPEN-009, OPEN-019).

<a id="adr-017"></a>
## ADR-017: Messaging provider is OpenWA (replaces WAHA)
**Status:** Proposed — Freebuff verifies in M1, spike S1 gates M7 · **Date:** 2026-10-11 · **Deciders:** Hassen (requested), Freebuff (to confirm)
**Supersedes:** [ADR-012](#adr-012) entirely; the WAHA-specific half of [ADR-007](#adr-007) (the provider-port decision in ADR-007 stays in force) · **Change record:** CR-001

**Context:** The owner chose to run **OpenWA** ([rmyndharis/OpenWA](https://github.com/rmyndharis/OpenWA), [docs](https://docs.open-wa.org/)) instead of WAHA as the self-hosted WhatsApp gateway. Both are unofficial reverse-engineered clients, so the ban-risk posture (R-01) is unchanged. OpenWA is MIT-licensed and self-hosted with **no paid tier and no feature gates** (verified 2026-10-11), which removes the cost/feature decision that ADR-012 was built around.

**Decision:** The messaging provider is **OpenWA**, behind the unchanged `MessagingProvider` port (ADR-007). Only `OpenwaProvider` knows OpenWA. Concrete, verified provider facts and the full **VERIFY** list live in [OPENWA_INTEGRATION](../architecture/OPENWA_INTEGRATION.md) §2 — this ADR does not restate them, to keep one source of truth.

**Alternatives:** (a) stay on WAHA — rejected by the owner; (b) official WhatsApp Business Cloud API — still the documented migration target (§14) but needs template approval and conversation pricing.

**Consequences:**
- Verification work is **not** carried over: the old WAHA facts (`X-Webhook-Hmac`/SHA-512, ack enum −1…4, `WORKING`/`SCAN_QR_CODE` status names, Core/Plus tiers) are invalid for OpenWA. OpenWA signs with **`X-OpenWA-Signature: sha256=<hex>` (HMAC-SHA256)** and uses a different lifecycle/error surface.
- **OPEN-002 is resolved:** no Core-vs-Plus cost decision exists. `attachment_and_link` is now gated on a passing spike test rather than a purchase.
- New verification burden: session status values, delivery/read semantics, inbound-event shape, error codes and webhook retry timing (OPENWA_INTEGRATION §2 O18–O22) must be recorded by spike S1 before M7 merges.
- Environment variables change (`OPENWA_*`), the dashboard/Swagger now share the API port, and `ENGINE_TYPE` (baileys vs whatsapp-web.js) becomes an operational choice.
- No database or contract-shape change: `NormalizedEvent`, `message_jobs`, `delivery_state` and the "never infer Delivered" rule are unchanged.

**Sources (checked 2026-10-11):** [OpenWA introduction v0.23.5](https://docs.open-wa.org/) · [webhook signature verification](https://github.com/rmyndharis/OpenWA/blob/main/docs/examples/webhook-signature-verification.md) · [sessions API reference](https://docs.open-wa.org/api-reference/sessions/).

<a id="adr-018"></a>
## ADR-018: Username is the login identifier; users have no email
**Status:** Accepted · **Date:** 2026-10-12 · **Deciders:** Hassen (requested), Claude (spec)
**Change record:** CR-002 · **Affects:** [DATABASE](../architecture/DATABASE.md) §3.1 (`users`) · [API_CONTRACTS](../architecture/API_CONTRACTS.md) §2/§3.1 (AUTH-01, USR-02) · [AUTH_AND_PERMISSIONS](../architecture/AUTH_AND_PERMISSIONS.md) §1 · [PAGE_SPECIFICATIONS](../frontend/PAGE_SPECIFICATIONS.md) §1

**Context:** The original design made `email` the login identifier and the unique key on `users`, inherited from the assumption that accounts are created and recovered by email. In reality this academy has **no email service in v1** (invites are handed over out-of-band as a link, [AUTH_AND_PERMISSIONS](../architecture/AUTH_AND_PERMISSIONS.md) §1), users are owners and coaches signing in on a phone, and the owner asked to sign in with a short handle (`owner`) rather than an address. Keeping an email column that nothing sends to adds a second identity attribute to unique-index, case-fold and validate for no benefit.

**Decision:** `username` replaces `email` as the **login identifier**, and `users` has no email column. `POST /auth/login` takes `{username,password,totpCode?}`; `POST /users` takes `{username,fullName,phone?,role}`. Usernames are `citext` (unique case-insensitively), stored lower-case, 3–32 chars from `a-z 0-9 . _ -`, chosen by the owner at creation, and **immutable in v1** — `USR-03` PATCH deliberately does not accept `username`; a rename is a new user plus a re-invite.

**Alternatives:** (a) keep email as the identifier — rejected: no email service exists and it forces typing an address on a phone; (b) keep email as an unused optional contact column — rejected: a dead field to validate, migrate and protect with no consumer; (c) make both unique and accept either to sign in — rejected: two identifiers to enumerate, lock and rate-limit, and ambiguous "which field is wrong" messaging.

**Consequences:**
- Invite/duplicate handling is unchanged in kind: uniqueness is still a `citext` UQ constraint (SQLSTATE 23505 is the duplicate signal), now on `username`.
- The password policy's "not equal to email" comparison becomes "not equal to the username"; login throttling keys on the username instead of the address.
- Recovery is unchanged in kind: an owner issues an invite/reset link ([USR-05](../architecture/API_CONTRACTS.md)); the owner bootstrap CLI becomes `create-owner --username <owner>` ([DEPLOYMENT_AND_OPERATIONS](../architecture/DEPLOYMENT_AND_OPERATIONS.md) §9).
- **What does not change:** the academy's own contact `email` (`academies.email`, printed on PDFs and editable in Settings → Academy) and the OPEN-012 daily digest email. Those are academy contact data, not credentials.
- The username is the only human-facing identifier, so `USR-01` list/search and the invite dialog show it (it must be displayed once with the invite URL so the owner can hand it over).
- Honesty note: the frontend was built against `email` (handoff 2026-10-11). The MSW fixtures, hand-written types, E2E script and specs move with this ADR in the same change, and are listed in CR-002.

**Sources:** none required — internal product decision, no external provider claim.

<a id="adr-019"></a>
## ADR-019: Messaging automation is per-automation opt-in, under one master pause
**Status:** Proposed (owner to confirm in writing) · **Date:** 2026-10-12 · **Deciders:** Hassen (requested), Claude (spec) · **Change record:** CR-003
**Affects:** [DATABASE](../architecture/DATABASE.md) §3.1 (`academy_settings`) · [API_CONTRACTS](../architecture/API_CONTRACTS.md) §3.6/§3.7 (new `SET-08`, `SET-07` note, `MSG-06`) · [OPENWA_INTEGRATION](../architecture/OPENWA_INTEGRATION.md) §4/§6/§11 · [PAGE_SPECIFICATIONS](../frontend/PAGE_SPECIFICATIONS.md) §9 · [TESTING_AND_ACCEPTANCE](TESTING_AND_ACCEPTANCE.md) T-MSG-13/14

**Context:** The original design had exactly one messaging switch — `messaging_automation_enabled`, toggled by `MSG-07` pause/resume — covering every kind: invoice delivery, pre-due reminders and overdue reminders. That is the right **emergency** control, but it is all-or-nothing. The owner wants to run some automations and not others (say: invoices and late reminders on, pre-due reminders off because parents found them noisy), without losing the ability to stop everything instantly. Automations that a business cannot switch off individually get switched off wholesale — which silently stops the ones that matter.

**Decision:** Automation is **per kind**, and every kind defaults to **off**: `messaging_automation_invoice_delivery`, `messaging_automation_reminder_pre_due`, `messaging_automation_reminder_overdue`, `messaging_automation_proof_check`. A job is only enqueued/sent when **all** of these hold: the master `messaging_automation_enabled` (MSG-07), that kind's flag (new `SET-08`), OpenWA health healthy, and the guardian's consent. `MSG-07` stays the master pause; `SET-08` is the per-automation surface (one place in the UI listing everything that can send).
- Disabling a kind takes effect immediately: it stops new enqueues **and** cancels that kind's not-yet-sent jobs (`cancelled` + `skipReason='AUTOMATION_DISABLED'`).
- **Re-enabling never back-fills** missed sends — dedupe keys are per (invoice, guardian, offset), so a back-fill would blast a week of stale reminders at once. The owner sends anything urgent manually.
- A **manual** invoice send (`INV-08`, or the billing wizard's `queueWhatsApp`) is an explicit owner action and is *not* blocked by the per-automation flag — only by master pause, health and consent.

**Alternatives:** (a) keep one global switch — rejected: the owner asked for per-automation control, and all-or-nothing pushes owners to abandon automation entirely; (b) reuse `reminder_rules.is_active` / `message_templates.is_active` as the switches — rejected: those mean "this rule/template exists", and overloading them would make "notify me but don't send" and "delete this rule" the same action, and they cannot express `invoice_delivery` at all; (c) per-guardian or per-invoice opt-outs — unnecessary here (consent already covers per-person, and the owner asking for switches was explicit about scope).

**Consequences:**
- Four new `academy_settings` booleans, all `default false` — matching the existing "leave automation paused until consent is recorded" go-live step; no migration of existing data is needed (nothing is deployed, no automation has ever run).
- `SET-08` is a new endpoint (additive, C1); `SET-07`'s "automation on/off is only via MSG-07" note is now wrong and has been corrected in the same change.
- The worker must check the flag **per job**, not once per loop, so a switch flipped while jobs are queued behaves as specified.
- New failure mode to watch: an owner may believe reminders are running when they are not — surfaced as a dashboard/`/messaging` warning when an automation is off while unpaid invoices exist (R-20).

**Sources:** none required — internal product decision.

<a id="adr-020"></a>
## ADR-020: Bank-transfer proof checks are advisory; only an owner confirms a payment
**Status:** Accepted · **Date:** 2026-10-12 · **Deciders:** Hassen (requested the automation), Claude (spec)
**Change record:** CR-003 · **Affects:** [BILLING_ENGINE](../architecture/BILLING_ENGINE.md) (payment state machine) · [API_CONTRACTS](../architecture/API_CONTRACTS.md) §3.6 (`PAY-04`, `SET-08`) · [PAGE_SPECIFICATIONS](../frontend/PAGE_SPECIFICATIONS.md) §Payments · T-FIN-20, T-UI-12

**Context:** The owner asked for "bank transfer verification" to be automated. Uploaded bank screenshots/PDFs are **evidence**, not money: [ADR-013](#adr-013) and CLAUDE.md §3 are unambiguous that only an owner-confirmed (or owner-recorded cash) payment changes a balance. An automation that flips `pending → confirmed` by itself would be a direct violation of that rule, would put unverified guardian-supplied images in control of the ledger, and would be indistinguishable, in the data, from a human decision. A guardian's screenshot is also trivially forgeable, so "looks valid" can never be sufficient evidence.

**Decision:** Automated verification is **advisory and deterministic**. With `messaging_automation_proof_check` on (SET-08), each bank-transfer payment with a proof gets a check result the owner sees before confirming: duplicate reference within the academy, amount vs. the guardian's outstanding/overdue balance, proof present and not a byte-identical duplicate of an existing proof, and "pending longer than N days". The output is a per-payment `checks[]` + a **verification queue** ordered by age. It can flag, sort and explain. It **cannot** confirm, reject, allocate, or alter any balance — `PAY-04` remains an owner action and is never called by a worker. Payment states, the ledger, and `PAYMENT_NOT_CONFIRMED` semantics are unchanged. Whether checks may also *read* file contents (OCR/vision extraction to pre-fill amount/reference) is **not** decided here — it is [OPEN-022](OPEN_DECISIONS.md) and is out of scope until the owner approves it in writing (it would be a C4 scope change: AI/document-understanding feature + guardian bank data leaving our infrastructure).

**Alternatives:** (a) auto-confirm when checks pass — rejected outright: breaks ADR-013, forgeable evidence, unrecoverable trust failure; (b) auto-confirm below a small amount threshold — rejected: same objection at a smaller number, and it hides the boundary; (c) do nothing and keep it fully manual — rejected: the owner's workload is real, and advisory checks remove most of the mechanical work without touching the money rule.

**Consequences:**
- No change to the payment state machine, allocation rules, or the meaning of `confirmed`. The verification queue is a **view** over `pending` payments plus a check result.
- The UI must never label a checked payment as verified/paid: it says "ready to confirm — N checks passed" or "check failed: …", and the money still reads **pending** until an owner confirms (T-UI-12).
- Checks are stored on the payment for audit, so a later dispute can show what the owner saw at confirmation time.
- The switch (`proofCheck`) only controls whether checks *run and are shown*; turning it off never changes any stored payment.

**Sources:** none required — internal product decision grounded in ADR-013 and the money rules in CLAUDE.md §3.

<a id="adr-021"></a>
## ADR-021: Bank-transfer proofs are bank-issued PDFs, verified by extraction and cross-check — never a confirmation
**Status:** Accepted · **Date:** 2026-10-12 · **Deciders:** Hassen (requested), Claude (spec)
**Change record:** CR-004 · **Resolves:** [OPEN-022](OPEN_DECISIONS.md) · **Affects:** [PAYMENT_VERIFICATION](../architecture/PAYMENT_VERIFICATION.md) (**new** — the source of truth for this) · [FILES_AND_PDF](../architecture/FILES_AND_PDF.md) §6 · [BILLING_ENGINE](../architecture/BILLING_ENGINE.md) §11 · [API_CONTRACTS](../architecture/API_CONTRACTS.md) §2/§3.6 · [DATABASE](../architecture/DATABASE.md) §3.3

**Context:** Proofs used to be opaque files: owner-uploaded, stored, never read, explicitly "not a payment". [OPEN-022](OPEN_DECISIONS.md) asked whether the system may *read* them, with the safe default "no". On 2026-10-12 the owner answered in his own words: *"always ask for a PDF … you can check the time it was transferred … the number … find out a way to verify that it's all been synced properly."* That is a request for document-level verification, so the question is closed and the design is specified in full rather than left to implementation.

**Decision:** (1) For a bank transfer the academy asks for the **bank's own PDF e-receipt**; a photo or screenshot is accepted only as `supporting_only` evidence and can never produce a passing check (no text layer, trivially edited — a "pass" on one would be a false statement). (2) That PDF is parsed by a **text-layer extraction pass in a sandboxed worker**, and its fields (reference/receipt no., transaction date+time, amount, payer, beneficiary, channel, status, remarks) are cross-checked against the recorded payment, the invoice and the academy's own account held in `payment_instructions`. Beneficiary mismatch, amount mismatch, non-successful status, a reused reference and a duplicate file are **failures**; reference/date/payer-name deviations are **warnings** for the owner. (3) Reconciliation against an owner-imported **bank statement** is specified as level 3 — the only check that proves money arrived ([OPEN-023](OPEN_DECISIONS.md)). (4) **Verification stays advisory**: it never confirms, allocates, rejects or changes a balance, no worker may call `PAY-04`, and no screen may render a checked payment as paid/verified ([ADR-013](#adr-013), [ADR-020](#adr-020)). (5) Document understanding is bounded to *deterministic extraction from bank PDFs*: no OCR, no vision model, no LLM, no third-party processing of a guardian's bank document ([OPEN-024](OPEN_DECISIONS.md)).

**Alternatives:** (a) keep proofs opaque (status quo) — rejected: it leaves the owner's manual labour and the reused-receipt / edited-slip risks untouched; (b) "verify" screenshots too — rejected: a pass would be fabricated; (c) send proofs to a vision/LLM API — rejected: guardian bank data leaving our infrastructure, paid third-party processing, and a non-deterministic answer in a money-adjacent decision (recorded as a decision, not an oversight); (d) auto-confirm when all checks pass — rejected outright for the reasons in [ADR-020](#adr-020).

**Consequences:**
- New surface: a verify action and stored findings (`T-VER-*`), with a **parser version** recorded per result so old findings stay explainable when layouts change.
- A real sandbox requirement in the worker: untrusted PDFs are parsed with no network, no rendering, no active content, bounded CPU/memory, and a crash must fail one proof rather than the process. Active-content rejection at upload already exists ([FILES_AND_PDF](../architecture/FILES_AND_PDF.md) §6) and is re-checked before parsing.
- Third-party documents now get machine-read, so malware scanning is materially more worthwhile — [OPEN-015](OPEN_DECISIONS.md) priority raised (ClamAV candidate).
- Parser coverage is **per bank** and will need maintenance; L3 depends on the academy's bank being able to export a readable statement, which is a factual question for the owner ([OPEN-023](OPEN_DECISIONS.md)). Until L3 exists, level 2 is the ceiling and the docs say so instead of implying more.
- Extracted fields can contain personal data (payer name, masked account) → same access class as the proof, excluded from logs/messages/errors, retention per [DATABASE](../architecture/DATABASE.md) §6.
- **Nothing changes about money:** statuses, allocations, receipts and balances behave exactly as before; a passing check only changes what the owner sees before pressing Confirm.

**Sources:** none required — internal product decision. Per-bank receipt layouts and the academy's statement export are deliberately **not** assumed; they are [OPEN-023](OPEN_DECISIONS.md).
