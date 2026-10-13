# handoff.md — read this one first

> **Updated:** 2026-10-14 · **Owner granted standing permission this session** (§6) — ordinary
> development, local infrastructure and commits need no further approval.
>
> This file is the whole picture: what works, what is broken, what only a person can supply, and
> the exact next actions. The milestone records live in
> [`docs/engineering/handoffs/`](docs/engineering/handoffs/) — the newest is
> `2026-10-14-backend-m6-complete.md`. Nothing here is invented: every number below was measured
> in this session.

---

## 1. Goal

Two things, in one session:

1. Finish the backend milestone work and keep the record honest.
2. Build the two owner-facing tools the owner asked for, as **plain TypeScript, no AI agent in the
   loop**: one that *produces* the invoice message from a template (amount, number, dates, player,
   guardian — filled in automatically) and one that *checks* the invoices.

A third question kept recurring and is answered in §4: **when it is time to pay, what exactly does
a guardian receive, and what is "pay your fees"?**

## 2. Current state — measured, not assumed

| Check | Result |
|---|---|
| `npx vitest run` (all three projects) | **177 passed / 177, exit 0**, 19 files |
| `npx vitest run --project unit` | 67 passed / 67, exit 0 |
| `npm run typecheck` | **exit 0** (clean) |
| `npx tsx scripts/progress-report.ts` | **109 / 135 endpoints** |
| Both new CLIs, against a real database | ran, exit 0; refusals exit 1 (§3) |

Endpoint progress: **M2 23/23 · M3 31/31 · M4 19/19 · M5 26/26 · M6 9/9 · M7 0/21 · M8 1/6.**

Working tree: **46 changed paths, 2 commits** — the entire backend (M2–M6) is uncommitted. Nothing
is deployed; there is no CI.

## 3. What works, what is broken, what needs fixing

### Works, with evidence

- **Money end to end** (M5, 26/26). Invoices, allocations, confirmations, reversals, receipts, and
  the rule that matters most: **a proof is evidence, never payment** — nothing auto-confirms.
- **Documents** (M6, 9/9). `INV-06/07` and `RCT-02` build, store and stream PDFs; `PUB-01` serves a
  guardian's capability link with one uniform 404; `PRF-01/02` upload and stream proofs with EXIF
  stripped and PDFs screened for active content.
- **The invoice message generator** — `npm run invoice-message -- --invoice INV-… [--mint-link]`.
  Fills the owner's own `invoice_delivery` template from the invoice's live balance and refuses
  (`INVOICE_VOID`, `NOTHING_DUE`, `NO_GUARDIAN`, `TEMPLATE_MISSING`, `TEMPLATE_INCOMPLETE`) rather
  than producing a half-message. Verified against real rows: correct text, correct `wa.me` link,
  exit 1 on both refusal paths.
- **The invoice checker** — `npm run check:invoices [--include-void] [--json] [--fail-on warn]`.
  Read-only. Caught a real state in the test database: `LKR 4,000.00 was due on 2026-10-01 and is
  still outstanding`; exit 0 at the default `error` threshold, exit 1 with `--fail-on warn`.
- **The receipt checker** (CR-004) — `src/files/receipt-parser.ts`, already TypeScript, already
  tested through the money surface.

### Broken, missing, or fragile — honestly

1. **M7 messaging is 0/21 and cannot start without a phone number** (§5.1). No messaging code has
   been written against guessed provider behaviour, deliberately. Five OpenWA facts (O18–O22)
   remain unverified until a local instance is linked.
2. **No background PDF worker.** `pdf_stale` is nobody's job — `INV-07` renders a document when it
   is asked to. So an invoice can be stale indefinitely and nothing rebuilds it. `check:invoices`
   now *reports* this (`PDF_MISSING`, `PDF_STALE`, `PDF_REBUILD_OVERDUE`) instead of hiding it.
3. **M8 is 1/6.** `DSH-01` needs M7's `message_jobs`; `AUD-01`'s `entityId` is required by the
   contract but nullable in the database; `SYS-03` has no scheduler/backup data source; `RPT-01/02`
   wait on the frontend's report shapes being ratified as the contract source.
4. **`OPEN-018` "bank transfer only" is recorded but NOT applied.** The seed still lists `cash` as
   active. Applying it is not a one-liner: `bank_transfer` requires a reference, so every money
   fixture must move onto it with a distinct reference and the duplicate-reference rule then bites
   across them. Half-applying would leave the product claiming a default it does not have.
5. **Contract text still disagrees with the shipped code in places** — the full list is
   [`NEEDS_FROM_OWNER.md`](NEEDS_FROM_OWNER.md) §3, including the one addition this project made
   (`PUB-02`) that wants a blessing, and `FILES_AND_PDF` §7's wording about a bucket-signed URL.
6. **No CI, no performance measurement, nothing deployed.** Stated so it is not mistaken for done.

## 4. The money question, answered (this is the plain-language answer)

> "When the time to pay comes, do they send a PDF? What is 'pay your fees'?"

**"Pay your fees" is an invoice, and the invoice is the message.** The guardian receives this
(real output, from a live invoice):

```
Hello Nimal Perera, this is Inspire Academy. Invoice INV-2026-000001 for Kasun Perera is ready.
Amount due: LKR 4,000.00 · Due: 08 Nov 2026
View/download: https://<host>/api/v1/public/invoices/<token>/pdf
Reply STOP to stop these messages.
```

Then, in order:

1. **Invoice out** — the message above. Number, amount, due date, and a link that works with no
   login and dies when the invoice is voided or the token expires (30 days by default).
2. **They transfer** the amount by bank transfer, quoting the invoice number as the reference.
3. **They send back the bank's PDF e-receipt.** *This is the PDF that gets sent* — the **bank's
   receipt**, not the invoice. A screenshot or photo is supporting evidence only and can never pass
   a check.
4. **The machine reads it** (`PRF-04`): amount, reference, date within a day, payer name, whether it
   goes to the academy's own account, and whether that receipt is already attached to another
   payment. Findings are **advice**.
5. **The owner confirms** (`PAY-04`). Only then does money move and a receipt get issued.

The bank details that print on the invoice come from the payment-instructions block, which is still
empty — that is owner item 4 in §5.

## 5. What only a person can supply (this is the blocker list)

Nothing here is a coding task. Every row has a safe default that is **already built**, so a
developer can run the whole system today without any of it.

1. **A phone number for a local OpenWA instance** — *the block*. Everything in M7 (21 endpoints)
   waits on it. A spare/second phone is enough to start; the VPS and production number are only
   needed before live verification.
2. **The academy's real details**: logo file, legal name, address, phone (`OPEN-001`), the real fee
   per group, and the **bank payment-instructions text** that prints on every invoice (`OPEN-018`).
3. **The two sample bank receipts** — confirm `Receipt.pdf` / `anotherrecipt.pdf` are the right two
   and which bank each is, and whether they may move into `backend/tests/fixtures/receipts/`.
4. **The domain** the guardian's invoice link will live on (`OPEN-017`).
5. **Sinhala/Tamil on documents?** (`OPEN-013`). Spike P1 answered it: PDFKit is deterministic and
   English is perfect, but it has **no complex-script shaping**, so supporting them means the whole
   pipeline becomes HTML → headless Chromium. Default today: English-only, names transliterated at
   best.
6. **CR-003 approval in writing** — the coach clock-in dashboard block, the per-automation switches
   and "mobile is a shipping requirement" are built while `ADR-019` is still *Proposed*. Automations
   ship **off by default** until it is confirmed.
7. Smaller, release-gate items (retention periods, mandatory TOTP, the storage bucket) — details in
   [`NEEDS_FROM_OWNER.md`](NEEDS_FROM_OWNER.md) §1.

## 6. Standing permission — recorded at the owner's instruction

The owner said, in this session: *"you have permission for everything. Whatever needs to be done,
you have permission."* Recorded as:

- **Granted:** read/write anywhere in this project; running local infrastructure (the local
  PostgreSQL on port 55432, migrations, seeds); creating, editing and deleting my own files and
  tests; running the full test suite; **committing** the work (the 46 uncommitted paths in §2 are
  the obvious first candidate).
- **Still asked first, because permission cannot make them safe:** anything irreversible or
  outward-facing — `git push`, deploying, sending real WhatsApp messages, or touching real money
  data. Not a refusal; a flag.
- **Permission cannot supply a physical resource.** A phone number, the bank details, the logo and
  the domain are things only a person can hand over (§5). No amount of permission substitutes for
  them, which is why §5 exists.

## 7. Active files (this session)

**New source** — `backend/src/messaging/template.ts`, `invoice-message.ts`, `invoice-link.ts`;
`backend/src/ops/invoice-health.ts`.

**New CLIs** — `backend/scripts/invoice-message.ts`, `backend/scripts/invoice-health.ts`
(`package.json`: `invoice-message`, `check:invoices`).

**New tests** — `backend/tests/unit/invoice-checks.test.ts` (24 tests),
`backend/tests/integration/invoice-tools-surface.test.ts` (5 tests, real PostgreSQL).

**Modified** — `backend/package.json` (two scripts), `NEEDS_FROM_OWNER.md` (§3 `PUB-01` row), this
file.

**Carried over from the M6 session** — new: `src/files/upload.ts`, `src/files/image-metadata.ts`,
`src/files/signed-url.ts`, `src/routes/public.ts`, `migrations/0014_public_readers.sql`,
`tests/integration/files-surface.test.ts`, `tests/unit/file-uploads.test.ts`. Modified:
`src/routes/proofs.ts`, `settings.ts`, `money-serialize.ts`, `serialize.ts`, `academy-brand.ts`,
`index.ts`, `src/http/router.ts`, `src/http/plugins.ts`, `src/files/receipt-parser.ts`,
`spec/sections/02-settings.ts`, `api/openapi.yaml`/`.json`, `docs/architecture/FILES_AND_PDF.md`,
`docs/engineering/PROJECT_STATUS.md`.

## 8. Changes made (this session)

- **`template.ts`** — `{{variable}}` filling with two deliberate properties: a placeholder with no
  value **stays literal and is reported** (an empty `Amount due:` is worse than a refusal), and a
  typo is reported as *unknown* rather than left in the text, so a settings screen can refuse a
  template at save time. Plus `whatsappDeepLink()` for the owner-side "send it myself" action.
- **`invoice-message.ts`** — one query reads invoice, guardian, academy and the owner's active
  template; `buildInvoiceMessage()` returns text or a refusal reason. The amount is the **balance at
  that moment**, not the original total, so a partly-paid invoice asks only for the remainder.
- **`invoice-link.ts`** — 32 random bytes, only the SHA-256 stored (a leaked database holds no
  working link), expiry from `invoice_link_ttl_days`. Revocation stays in the database trigger on
  void (`0013`) so every voiding path revokes.
- **`invoice-health.ts`** — checks that are pure over rows, plus a separate loader so the arithmetic
  and the SQL are each testable. Catches what is *wrong* (lines that do not sum to the total, a
  balance that is not total − paid, allocations on a void invoice, paid with nothing allocated, a
  capability link that outlived its invoice) and what is *invisible* (a document never generated, or
  stale past its threshold). All amounts print as `LKR 4,000.00`, never as minor units.
- **`scripts/invoice-message.ts`** mints the link only when the template actually uses
  `{{invoiceLink}}`, and writes an audit row (`invoice.link_create`) when it does.
- **`scripts/invoice-health.ts`** takes "today" in the academy's timezone (`Asia/Colombo`), supports
  `--json`, and exits 1 per `--fail-on` (default `error`).
- Both CLIs run through the **migrator** role like `create-owner`/`reset-owner` — there is no session
  to authenticate and the operator already holds server access. The libraries take `AnyQueryable`,
  so the API routes still pass their RLS-scoped `PoolClient`.

## 9. Failed attempts (so they are not repeated)

- **Fixture invoice had no PDF, so `PDF_MISSING` fired** — correct behaviour, wrong expectation in
  my "healthy invoice" test. Fixed by giving the fixture a real `files` row and `pdf_file_id`, which
  also exercises the join.
- **`files_storage_key_key` violated on the second test.** `files` is *not* in `resetData()`'s
  truncate list (reference data), so a fixed storage key collided. The key now carries the file id.
- **A unit expectation went stale when I corrected a fixture number** (`balanceMinor` 123457 →
  123456, to satisfy the deferred totals trigger), and the overdue-sum assertion had to follow.
- **`npx tsx -e "<script with top-level await>"` silently did nothing** — no error, no effect, and
  the checker then "passed" because the update never happened. Use a real temporary file under
  `var/` and delete it. An inline script that prints nothing is a failed script, not a quiet one.
- **From the M6 session, still worth knowing:** `academy_settings` and `files` survive
  `resetData()`, and a logo uploaded in one test leaked into the next.

## 10. Next steps, in order

1. **Commit.** 46 changed paths, 2 commits — the M2–M6 backend and these tools are uncommitted.
   Permission is recorded in §6.
2. **M8's decidable work** (no phone number needed): `AUD-01` (settle `entityId` first), `SYS-03`
   (decide its data source), `RPT-01/02` ported from `frontend/src/mocks/reports.ts` once ratified.
3. **Give `SYS-03` a real source of truth by surfacing the new checks there** — the checker is
   deliberately usable before M7, and `/system/health` is where an owner would look.
4. **Template validation on save** — `inspectTemplate()` already refuses an unknown variable; the
   settings screen should use it so a bad template cannot be saved in the first place.
5. **M7, the moment §5.1 arrives:** start with spike S1 (the five OpenWA facts), then `message_jobs`
   and the provider. The generator already produces the exact text the queue must send — call
   `buildInvoiceMessage()`, do not write a second implementation.
6. **Owner items** (§5) and **contract text** (§3 item 5) whenever they land; neither blocks
   development.

## 11. What actually stands between here and production

Grounded in this project's own gates — [TESTING_AND_ACCEPTANCE](docs/engineering/TESTING_AND_ACCEPTANCE.md) §4 (10-item release gate),
[DEPLOYMENT_AND_OPERATIONS](docs/architecture/DEPLOYMENT_AND_OPERATIONS.md) §5–§9 (release procedure, monitoring, backups, go-live
checklist) and [IMPLEMENTATION_PLAN](docs/engineering/IMPLEMENTATION_PLAN.md) M9–M10 — checked against what the code actually is today.

### A. The release gate, item by item

| # | Gate | State today |
|---|---|---|
| 1 | CI green on the release commit | **Not possible — there is no CI.** The suite is green *locally* (177/177) |
| 2 | E2E smoke on staging (login, register, attendance, clock in/out, billing run, payment + receipt, `PRF-04` queue, WhatsApp via mock, void) | **Not possible — nothing is deployed, there is no staging** |
| 3 | T-FIL-09 and T-MSG-02/03/06 pass | T-FIL-09 **passes**; **every T-MSG row is blocked** (M7 unbuilt) |
| 4 | OpenWA spike S1 (O18–O22) + T-MSG-12 on the real number | **Not started** — needs the number (§5.1) |
| 5 | Accessibility + real-device mobile checklist signed off | **Not done** — M9; needs the owner's phone |
| 6 | T-OPS-01 within 90 days + T-OPS-02 rehearsal | **Not done** — `docs/engineering/RESTORE_LOG.md` does not exist yet |
| 7 | Security gate (`SECURITY_AND_PRIVACY` §7) | **Unverified** — no security review has been run as a gate |
| 8 | `openapi.yaml` matches the running server, frontend types generated from it, no drift | **Partly** — the contract is generated and validated; drift items are still open (§3.5) |
| 9 | OPEN-001/002/009/018/019 resolved or accepted in writing | **OPEN-002 resolved**; 001, 009, 018, 019 still open. 018 is recorded but deliberately unapplied |
| 10 | Handover pack delivered; first owner created with TOTP | **Not done** — `create-owner` and TOTP exist; the pack and training do not |

### B. Production plumbing that does not exist yet

These are not in the gate table but the deployment doc assumes them, so they are stated plainly:

1. **No worker process and no scheduler.** `src/server.ts` is the API only. All ten scheduled jobs
   in DEPLOYMENT §8 are unbuilt — including the **daily billing scheduler**, session generation,
   the PDF sweeper, the stuck-job/orphan sweepers, retention/purge and the nightly logical backup.
   Today invoices exist only when a person runs a billing run.
2. **Storage is a local directory** (`FILES_DIR`, `src/files/storage.ts`). The `STORAGE_*` variables
   in DEPLOYMENT §4 do not exist in `src/config.ts` at all. So: no bucket, no versioning, no
   off-host copy — and **proofs are the one artefact that cannot be re-created**.
3. **No immutable image and no deploy artefacts.** No `Dockerfile`, no CI workflow, no reverse-proxy
   or TLS config, no maintenance flag (which the documented rollback path (b) needs).
4. **No invariant job.** The gate wants nightly `paid_minor = Σ allocations`, totals = Σ items, no
   negative balances, orphan counts. `npm run check:invoices` covers the invoice half of that (and
   can be run as a cron today); allocations/orphans are not covered.
5. **Observability is logs only.** `SENTRY_DSN` is documented but unwired, there are no metrics, no
   uptime monitor, no `SYS-03` page to look at, and no daily digest (OPEN-012).

### C. Only a person can supply these

Dedicated phone number + VPS · domain and TLS, and acceptance of RPO ≤ 15 min / RTO ≤ 4 h
(OPEN-017) · the managed-Postgres-with-PITR and object-storage decision and its budget (OPEN-016) ·
**bank payment instructions and the real fee per group** (OPEN-018) · logo, legal name, address
(OPEN-001) · retention periods with an accountant (OPEN-009) · mandatory TOTP? (OPEN-010) · PDPA
legal review and a published privacy notice (OPEN-019) · CR-003 approval in writing · the
real-device pass · the handover pack and owner training · the real player roster imported by CSV.

### D. The shortest honest path

1. **Commit** — 46 changed paths, 2 commits. Nothing else can be released cleanly from here.
2. **M8's 5 endpoints** (`DSH-01`, `RPT-01/02`, `AUD-01`, `SYS-03`) — needs no phone number, and
   `SYS-03` is where monitoring and the new checks would surface.
3. **The plumbing M7 and M10 both need:** worker + scheduler with the ten jobs, the storage adapter
   (bucket), the invariant job, retention/purge, a `Dockerfile`, and CI to make gate item 1 real.
4. **M7** the moment the number arrives — spike S1 first, per the plan.
5. **M9:** performance sanity (5k invoices / 20k attendance rows < 300 ms p95), security review,
   accessibility, the real-device pass, a bug bash on an anonymised copy of real data.
6. **M10:** provision, secrets, DNS/TLS, backups **plus a restore drill**, monitoring, `create-owner`
   + TOTP, configuration, CSV import of the real roster, training, handover, then the 14-item
   go-live checklist.

### E. If a pilot is enough, the blocker set collapses

A **pilot for the owner's own bookkeeping** — no guardian-facing messaging, no public links, one
person using it to bill and record payments — does *not* need M7 or M8. It needs only: a deployable
API, managed Postgres, the frontend pointed at the real API (it already is, once
`NEXT_PUBLIC_USE_MOCKS` is off and `NEXT_PUBLIC_API_BASE_URL` is set), a domain with TLS, real
secrets, one backup **with a tested restore**, `create-owner` + TOTP, and the owner's real fees and
bank details. **Guardian-facing automation is the expensive half, not the money engine.**

### The one-line version

Money and documents work and are tested; the invoice tools are built and verified; **messaging is
the only missing feature and it is waiting on a phone number**, not on code. What stands between
here and production is §11: no CI, no deployed environment, **no worker or scheduler**, local
file storage instead of a bucket, no backup-and-restore proof, and five M8 endpoints still to
build. Everything is uncommitted.
