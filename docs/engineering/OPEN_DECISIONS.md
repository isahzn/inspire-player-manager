# OPEN_DECISIONS

> **Status:** Living · **Owner:** Claude (maintains), decider named per row · **Updated:** 2026-10-11
> Rule: the **safe default** is what gets built unless the decider answers. Resolve by moving the row to "Resolved" with date and updating affected docs ([CHANGE_MANAGEMENT](CHANGE_MANAGEMENT.md)).

| ID | Question | Impact | Safe default (built unless changed) | Decider | Blocks |
|---|---|---|---|---|---|
| OPEN-001 | Official logo, academy legal name, address, phone, brand colors? | PDFs, UI theme | Text wordmark + neutral palette | Academy owner | M6/M9 polish |
| OPEN-003 | Age-eligibility reference date (Jan 1 of year / fixed date / today) and group age ranges | Group suggestions, fairness | `jan_1_of_year`; suggestion only | Academy owner | M3 |
| OPEN-004 | Proration for players joining mid-period (calendar mode) | Money | Full fee; optional manual adjustment | Academy owner | M5 |
| OPEN-005 | Mid-period transfer: any top-up/refund? | Money | None; manual adjustment | Academy owner | M5 |
| OPEN-006 | Invoice in advance (period start) or arrears (period end)? | Cash flow | In advance | Academy owner | M5 |
| OPEN-007 | Auto-apply credit to next invoice? | Money UX | No (manual allocate) | Academy owner | M5 |
| OPEN-008 | May coaches see guardian phone? | Privacy | No | Academy owner | M3 |
| OPEN-009 | Financial record and proof retention periods (tax/legal) | Compliance | 7 yr financial; proofs 24 mo | Owner + accountant | M10 |
| OPEN-010 | Mandatory TOTP for owners? | Security | Optional but strongly recommended; release gate asks for risk acceptance if absent | Hassen + owners | M2 |
| OPEN-011 | Process inbound WhatsApp messages only for exact opt-out keywords (no storage)? | Privacy/compliance | Yes | Owner | M7 |
| OPEN-012 | Daily digest email to owners for failures/health | Ops | Banner + `/system/health` only | Hassen | M10 |
| OPEN-013 | Sinhala/Tamil message templates | UX | English only | Owner | later |
| OPEN-014 | Offline attendance sync | Coach UX | Local draft + retry | Coaches/owner | later |
| OPEN-015 | Malware scanning on uploads | Security | None (owner-only uploads) | Hassen | later |
| OPEN-016 | Object storage + managed Postgres providers and monthly budget | Cost | Decide at M10 prep with verified pricing | Hassen/owner | M10 |
| OPEN-017 | Acceptable RPO/RTO and uptime expectations; domain name | Ops | RPO ≤ 15 min (PITR), RTO ≤ 4 h | Owner | M10 |
| OPEN-018 | Academy's real configuration: weekly vs monthly, calendar vs anchored, due rule, fee per group, payment methods, payment instructions | Config only | Monthly, calendar, 7 days after issue, cash + bank transfer | Academy owner | seed/go-live |
| OPEN-019 | Legal review of Sri Lanka PDPA obligations (children's data, breach notice, consent wording) | Compliance | Engineering guidance only | Owner + counsel | M10 |
| OPEN-020 | Guardian data-export action (JSON) in UI | Privacy | Runbook-only manual export | Hassen | later |
| OPEN-021 | Stack confirmation: Hassen's frontend framework and Freebuff's backend framework/data layer | Build | Next.js + Fastify/TS | Hassen/Freebuff | M1 |
| OPEN-023 | Which bank(s) does the academy use, and can it export a **statement** the system can read (CSV/PDF from online banking)? Which receipt layout(s) must the parser cover? | Verification level 3 — the only check that proves money actually arrived (catches a genuine receipt reused for a second payment, or an edited amount) | **L2 only** (receipt extraction + cross-check). L3 is designed but built only when a real statement export is supplied; parser starts with the bank that supplied a sample receipt | Academy owner | M5+ |
| OPEN-024 | Scanned / image-only receipt PDFs (no text layer): keep asking for a text-based export, or add OCR? | Verification coverage vs. complexity, cost, and privacy (OCR/vision would mean guardian bank documents passing through another model) | **Keep asking for the PDF export.** No OCR in v1; an image-only PDF is flagged `NO_TEXT_LAYER` and stays owner-verified | Academy owner | later |
| OPEN-025 | Automate the guardian-facing "please send the PDF" request as a message kind (`proof_request`), or keep it an owner-side copy/`wa.me` action? | Messaging scope + consent surface: an automated request needs a `message_jobs` relationship to a **payment** (not an invoice), a template, an automation switch and dedupe limits | **Owner-side action** (ready-made message + copy/`wa.me`, using the existing manual-fallback path). No new message kind | Academy owner | M7 |

## Resolved
| ID | Question | Resolution | Date |
|---|---|---|---|
| OPEN-002 | WAHA **Core (text + link)** vs **Plus (PDF attachments, built-in API security)**; verify Plus price | **Resolved — no decision needed.** The provider is now **OpenWA** (ADR-017), which is MIT-licensed, self-hosted, with **no paid tier and no feature gates** on 2026-10-11. Document sending is a supported capability, so `attachment_and_link` is gated on a passing spike test rather than a purchase. | 2026-10-11 |
| OPEN-022 | What may automated **bank-transfer proof verification** do: deterministic checks only, or also extract amount/reference/date from the uploaded image via OCR/vision? | Money accuracy + privacy + AI-feature scope | **Resolved 2026-10-12 by the owner: read the document.** "Always ask for a PDF … check the time it was transferred … the number … verify it's been synced properly." Implemented as deterministic text-layer extraction from the **bank's PDF e-receipt** + cross-check ([PAYMENT_VERIFICATION](../architecture/PAYMENT_VERIFICATION.md), [ADR-021](DECISIONS.md#adr-021)); images are supporting-only; **no OCR/vision** (that part is now [OPEN-024](#open-024)); verification still never confirms a payment ([ADR-020](DECISIONS.md#adr-020)). | 2026-10-12 |
