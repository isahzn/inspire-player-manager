# HANDOFF 2026-10-12 — Frontend Step 6: WhatsApp pages

Author: Buffy (frontend lead) · Milestone: M7 (frontend slice, mocks) · Change record: **CR-003 surfaces are now built — see §3; ADR-019 is still *Proposed*** · Plan: [FRONTEND_PLAN.md](../../../FRONTEND_PLAN.md) §5 (Step 6)
Branch/PR: none — **this project still has no tracked files** (`git ls-files .` → 0)

> The combined Steps 6–8 record is [2026-10-12-frontend-step678.md](2026-10-12-frontend-step678.md). This file is the Step 6 half, kept separate because `src/api/types.ts` and several modules cite it by name for the contract gaps raised here (§4).

## 1. Scope delivered

- **`/whatsapp`** (`src/app/whatsapp/page.tsx`) — four tabs, all filters in the URL: **Status · Messages · Reminders & templates · Settings**.
  - **Status** — connection card with the **master pause/resume** (`MSG-07`, confirm dialog), the session status word from *our* label set, last checked, queue counts, the disconnected banner, **Send test to my number** (`MSG-08`), the standing risk note about unofficial automation, and below the card the **Automations list** (`SET-08`): one switch each for **Invoices · Pre-due reminders · Late (overdue) reminders · Bank-transfer proof checks**, with the master state shown read-only as *Paused (master)* and each switch stating what turning it off does **and does not** do.
  - **Messages** — `MSG-01` table (scheduled/sent time · kind · player · guardian masked phone · invoice · **Status** · **Delivery** · attempts · error), filters on status/kind/date/player/invoice, row → detail.
  - **Reminders & templates** — `SET-05` rule table (kind, offset days, active) with add/patch/delete, and `SET-06` per-key template editor with variable chips, a live preview rendered from sample values, unknown-`{{var}}` validation and a character counter.
  - **Settings** — `SET-07` (send window, pacing, max per hour, invoice mode, opt-out keywords) plus the consent-policy snippet the forms ship with.
- **`/whatsapp/messages/[id]`** (`src/app/whatsapp/messages/[id]/page.tsx`) — `MSG-02..05`: rendered body, event timeline, **Retry** (`MSG-03`), **Cancel** (`MSG-04`), **Mark sent manually** (`MSG-05`, with a note), and the copy / `wa.me` manual fallback.
- **Data layer:** `src/mocks/store678.ts` (new) is the shared Step 6–8 mock store (users, audit, reminder rules, templates, messaging settings, `SET-08` switches, academy settings, session status), mirrored to `localStorage ia_mock_admin_v1`; `src/mocks/handlers.messaging.ts` (new) registers `MSG-01..08` + `SET-05..08`; `src/lib/messaging.ts` (new) is the **label-discipline module** for this slice; `src/api/types.ts` + `src/api/client.ts` gained the contract types and the `msg01..08` / `set05..08` wrappers; `src/components/StatusChip.tsx` gained the message/delivery/automation words.
- Message jobs stay in `src/mocks/db.ts`'s existing `messages: MessageJob[]` — the billing slice already enqueues there on a run (`BIL-02 queueWhatsApp`), so `MSG-*` acts on the **same rows** rather than a second list. `store678` only derives from it (queue counts, status) and mutates under a rule.
- Migrations added: none (no backend). Docs implemented: `API_CONTRACTS` §2 (`MessageJob`, `SessionStatusLabel`) and §3.7 (`MSG-01..08`, `SET-05..08`), `PAGE_SPECIFICATIONS` §9, `ROUTES_AND_NAVIGATION` §1, `OPENWA_INTEGRATION` §9, `ADR-019`, `ADR-020`.

### Rules this slice exists to keep

- **Delivery is never inferred.** The Delivery word comes from `deliveryLabel(deliveryState)`; "Delivered" requires `device_delivered` and "Read" requires `read`. Because OpenWA's ack mapping is unconfirmed (spike S1, `OPEN-019`), the adapter may only emit `server_accepted`/`unknown`, so those two labels stay **unreachable rather than guessed** — and the seeded message rows are normalised to `server_accepted` at seed time so the fixture cannot claim an ack we cannot map.
- **`MSG-05` is not a confirmation.** "Mark sent manually" records the owner's own claim (`manualFallback`) and stops retries; it sets `deliveryState: 'unknown'`.
- **`SET-08` off means off, and never back-fills.** Switching an automation off stops new enqueues **and** cancels that kind's not-yet-sent jobs (`cancelled` + `skipReason: 'AUTOMATION_DISABLED'`); re-enabling sends nothing retroactively. The copy says so on the control itself.
- **No switch implies money moved.** `proofCheck` says the checks *ran*; it never means a transfer was confirmed (`ADR-020`/`ADR-021`).
- **`MSG-07` pauses claiming, not queuing.** Queued jobs stay queued (`API_CONTRACTS` §4), so pause does not refuse a retry or an enqueue.

## 2. Evidence

**Verified by the coordinator on 2026-10-12** against `npm run dev` on :3100 (mock mode), system Chrome: `tsc --noEmit` clean, `eslint` **0/0**, `next build` green (**35 routes**), `verify:unit` **17/17**, and `verify:e2e:step678` **45/45 PASS** — inside the full-suite rerun **12/12 + 30/30 + 41/41 + 60/60 + 45/45 = 188 checks, 0 failures, exit 0** (log `frontend/.verify/e2e-all-step678.log`). Full detail, including the fixes this verification forced, is in [the Steps 6–8 handoff](2026-10-12-frontend-step678.md) §2.

The Step 6 rules proven through the running screens and the API: the four tabs render; **no message row reads "Delivered"** while every seeded ack is `server_accepted`/`unknown`, with the honest words on the rows and the rule explained on the tab; `MSG-05` produces the owner's own claim (`sent`) and never a delivery state; `MSG-03` answers **400 without an `Idempotency-Key`**, re-queues without claiming delivery and refuses only with `MESSAGE_NOT_RETRYABLE`; switching `reminderOverdue` off cancels the unsent jobs as `cancelled` + `AUTOMATION_DISABLED` and **re-enabling back-fills nothing**; `MSG-02` returns an event timeline with no invented `providerAck`; and a coach gets **403 from the messaging API plus a permission-denied page with none of the switches**.

**Not verified:** nothing has been sent to a real provider (the seeded session is `awaiting_qr` and the ack mapping is still spike S1), the reminder *scheduler* is the backend's and does not exist here, `SET-06`'s `preview` is rendered from `SAMPLE_TEMPLATE_VALUES`, and no a11y scan has been run.

## 3. Deviations from the spec

| Spec ref | What differs | Why | Needs a spec change? (CR-###) |
|---|---|---|---|
| `PROJECT_STATUS` §"CR-003 is written but NOT approved" / `ADR-019` (**Proposed**) | The `SET-08` per-automation switches **are built** in this slice | They are named in the Step 6 deliverable of the plan this session was asked to finish; `ADR-019` has **not** been flipped to Accepted | **Yes — needs Hassen's confirmation in writing.** Until then this surface exists in code while the ADR is *Proposed*; that contradiction is recorded here rather than resolved silently |
| `API_CONTRACTS` §2 `MessageJob.kind` | `kind` gained `"test"` | `MSG-08` is typed `→ MessageJob` but a test send matches none of the three kinds — see §4.1 | Yes (contract addition) |
| `SET-07` `attachment_and_link` | Rejected with **422 `VALIDATION_ERROR`** | The contract says it is rejected until a passing spike-S1 media test but names no code — see §4.4 | Yes (error code) |
| mock store | A second mirrored store (`localStorage ia_mock_admin_v1`) next to `ia_mock_people_v1` | Step 6–8 state (users, audit, rules, templates, switches, academy settings) has no home in `db.ts`; keeping it in one shared module stops three handler slices growing three copies | No (C0) — mock only |

## 4. Contract drift / requests

1. **`MessageJob.kind` has no `test` value, although `MSG-08` returns a `MessageJob`.** A test send is not an invoice delivery or a reminder, so `kind: "test"` was added in `src/api/types.ts` rather than mislabelling the row. **Also**: `MessageJob.invoice` and `.player` are non-optional, and a test send has neither — `handlers.messaging.ts` writes the literal ids `"test"` with names `TEST` / `Test message`. Either `kind` gains `test` and `invoice`/`player` become optional for it, or `MSG-08` returns its own shape.
2. **`BIL-02`'s message-job `skipReason` strings are still undefined** (carried over from the Step 5 handoff). `lib/messaging.ts` maps the reasons it recognises (`AUTOMATION_DISABLED`, `CONSENT_REVOKED`, `INVOICE_VOID`, `INVOICE_PAID`, `PAUSED`, `SESSION_DOWN`, `NO_TEMPLATE`) and **prints anything else verbatim** — never guessed at. `MSG-04`'s cancel writes `CANCELLED_BY_OWNER`, a value the contract does not define.
3. **`MSG-03`'s "re-checks consent/invoice state" has no stated error for the blocked case.** The only code the contract names for an illegal message action is `MESSAGE_NOT_RETRYABLE` (409), so a retry refused because the guardian opted out, or the invoice was voided/paid, answers that code with a plain-language reason instead of inventing a second one.
4. **`SET-07`'s `attachment_and_link` has no rejection code.** It answers 422 `VALIDATION_ERROR` with the reason (media sending has not passed spike S1).
5. **The exact `SessionStatusLabel` values are ours, not OpenWA's** (the contract says so explicitly). The UI prints `sessionStatusLabel()` words — *Connected / Awaiting QR scan / Starting / Stopped / Failed / Unknown* — and never the raw provider string, so a provider that returns something unrecognised degrades to *Unknown* instead of leaking a provider value the mock has no evidence for.
6. **`SET-08`'s `GET` response shape** is written as "the same object + `masterPaused`". Declared here as `AutomationsResponse = Automations & { masterPaused: boolean }`.
7. **`SET-07` includes a `consentPolicyText`** the contract's field list does not have. `PAGE_SPECIFICATIONS` §9 requires "consent policy text snippet for forms", so the field is declared and the mock returns it; if the backend keeps that text in code instead, this field should be dropped.

## 5. Known gaps and risks

- **Nothing is ever sent.** The mock has no provider: no message leaves the machine, `wa.me` is copied/opened by hand, and `MSG-05` records the owner's claim. `msg08`'s "sent" status is a queue simulation, not an observation.
- **Automatic proof checks on upload are not wired to a document reader.** `SET-08.proofCheck` flips the switch and the `/payments` Verification tab keys off it, but with the switch **off by default** nothing checks on upload; the explicit `PRF-04` re-check stays the real path (`ADR-021`).
- **The Delivered/Read labels are unreachable by construction** until spike S1 lands — that is the intended state, not a bug, but it means those two branches are unexercised.
- **No axe/a11y scan and no real-phone pass** (T-UI-10/11) — unchanged from Steps 1–5.
- **`MSG-07` pause does not stop the queue from being retried manually**, by design (`API_CONTRACTS` §4).

## 6. How to run / verify

```bash
cd "Projects/inspire-academy-player manager/frontend"
npm run dev            # http://localhost:3100 (mock mode)
npm run typecheck && npm run lint && npm run build
```

Mock logins (any password): `owner` · `coach`. Messaging fixtures live in `localStorage ia_mock_admin_v1` (settings/rules/templates/audit) and the message jobs in `ia_mock_people_v1` (the billing store). Clear site data to re-seed; a `/whatsapp` reload keeps a flipped switch and a saved template.

## 7. Next steps (exact)

1. **Hassen (owner):** confirm `ADR-019`/CR-003 in writing, or ask for the `SET-08` switches and the `coachTime`/clock-card surfaces to be pulled back out (see §3).
2. **Claude (docs):** answer §4.1–§4.7 (`MessageJob.kind` = `test` and the invoice/player problem, the `skipReason` vocabulary, the retry-refusal code, the media-rejection code, the `SET-08` GET shape, `consentPolicyText`).
3. **Freebuff (when M7 lands):** the real OpenWA adapter behind `MessagingProvider` — the ack mapping (spike S1, `O18`/`O19`), per-kind gating in the worker, and `SET-08` cancelling enqueues rather than the mock's in-memory sweep.

## 8. Reviewer checklist (Claude/Hassen fills)

[ ] Compared to `API_CONTRACTS` §3.7 / `OPENWA_INTEGRATION` §9  [ ] Permissions verified by route matrix (`/whatsapp` → `messaging:manage`)  [ ] No money floats
[ ] Audit rows present on every switch/settings mutation  [ ] Evidence reviewed  [ ] `PROJECT_STATUS` updated  [ ] Verdict: accepted / changes requested
