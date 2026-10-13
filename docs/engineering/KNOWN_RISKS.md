# KNOWN_RISKS

> **Status:** Living · **Owner:** Hassen (accountable), Claude (maintains) · **Updated:** 2026-10-11
> Severity = impact × likelihood (H/M/L). Review at every milestone exit.

| ID | Risk | Cat | Sev | Mitigation | Owner | Open question |
|---|---|---|---|---|---|---|
| R-01 | OpenWA is unofficial WhatsApp automation (Baileys or whatsapp-web.js engine, not Meta's API): disconnects, bans, silent failures | Ops | **H** | Dedicated number, pacing, health monitor, banners, manual fallback, provider port, official-API migration path | Hassen | — (OPEN-002 resolved 2026-10-11; no paid tier) |
| R-02 | Financial bug (double allocation / duplicate invoice / wrong balance) | Fin | **H** | Constraints, row locks, idempotency, deferred invariant triggers, nightly invariant job, concurrency tests | Freebuff | — |
| R-03 | Coach accesses finance/unassigned data (IDOR) | Sec | **H** | Deny-by-default registry, scope guards, 404 for out-of-scope, RLS, route-matrix test | Freebuff | — |
| R-04 | Owner account compromise (controls money) | Sec | **H** | argon2id, lockout, TOTP, short owner sessions, audit | Hassen | OPEN-010 |
| R-05 | Backups never restored / lost | Ops | **H** | PITR + cross-provider dumps + quarterly restore test + log | Hassen | OPEN-017 |
| R-06 | Spec ambiguity between Freebuff and frontend | Scope | M | Single contract file/OpenAPI, mock data, HANDOFF reports, contract tests | Claude/Hassen | — |
| R-07 | Business policy undecided (proration, advance vs arrears, credit) | Fin | M | Safe defaults documented; decisions logged | Academy owner | OPEN-004..007 |
| R-08 | Children's PII exposure / legal non-compliance | Priv | **H** | Minimisation, access control, retention, anonymization, legal review | Owner | OPEN-019 |
| R-09 | Capability invoice links forwarded/leaked | Sec | M | 256-bit token, expiry, revoke, rate limit, minimal PDF content | Freebuff | — |
| R-10 | PDF Sinhala/Tamil rendering wrong | Tech | M | Spike P1, Chromium fallback | Freebuff | — |
| R-11 | Cost surprises (managed DB, storage) | Cost | M | Verify prices at M10 prep; no free-tier reliance. Messaging itself costs nothing — OpenWA is MIT/self-hosted with no tiers | Hassen | OPEN-016 |
| R-12 | Scope creep (portal, gateway, multi-tenant) | Scope | M | Out-of-scope list, change process | Hassen | — |
| R-13 | Single operator (bus factor) | Ops | M | Runbooks, handover pack, documented restore, secrets escrow with owner | Hassen | — |
| R-14 | Framework/DB/storage facts in these docs not re-fetched from official docs | Tech | M | Freebuff verifies each against current official docs in M1 and records sources in DECISIONS | Freebuff | — |
| R-15 | Time/timezone bugs (month boundaries, DST in tests) | Tech | L | Academy-tz helpers, boundary tests | Both | — |
| R-16 | Poor connectivity during attendance | UX | M | Local draft, idempotent retry, clear unsaved state | Hassen | OPEN-014 |
| R-17 | Self-reported check-in misread as proof of presence | Scope | L | UI/documentation disclaimers | Hassen | — |
| R-18 | Free tier or pausing DB used in production | Ops | M | Written limits confirmation required in go-live gate | Hassen | OPEN-016 |
| R-19 | OpenWA provider facts are not yet verified (session-status enum, delivery/ack semantics, inbound-event shape, HTTP error codes, webhook retry timing — O18–O22). Building M7 on assumed values would produce wrong delivery labels or broken retries | Tech | M | Spike S1 must record every one of O18–O22 before M7 code merges; until then the adapter may only emit `server_accepted`/`unknown` for delivery state | Freebuff | spike S1 |
| R-20 | An owner believes an automation is running when it is off (per-automation switch off, master pause, or session down) — invoices/reminders silently stop and no one notices until a parent complains | Ops | M | Automations list shows each switch state with its effect; warning when an automation is off while unpaid invoices exist; `/messaging/status` + owner dashboard expose `automations`; unmarked-but-due invoices surface in the alerts strip; every toggle audited (CR-003, T-MSG-13/14, T-UI-11) | Freebuff/Hassen | — |
| R-21 | Automated proof checks are mistaken for verification — an owner confirms without looking, or a future change lets a check flip a payment to `confirmed` | Fin | **H** | Checks are advisory by decision ([ADR-020](../engineering/DECISIONS.md#adr-020)): no code path can confirm a payment except `PAY-04` as an owner; UI always reads "Pending verification" until then; test T-FIN-20 asserts no automation can mutate a payment or balance | Freebuff | — |
