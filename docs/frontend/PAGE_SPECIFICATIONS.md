# PAGE_SPECIFICATIONS

> **Status:** Draft v1 (planned) · **Owner:** Claude (spec) / Hassen (implementation) · **Updated:** 2026-10-11
> **Depends on:** [ROUTES_AND_NAVIGATION](ROUTES_AND_NAVIGATION.md), [API_CONTRACTS](../architecture/API_CONTRACTS.md), [DESIGN_SYSTEM](DESIGN_SYSTEM.md) · **Source of truth for:** page content, fields, tables, states, validation messages.

**Never invent endpoints or fields.** Every data need below cites an endpoint ID from API_CONTRACTS; if something is missing, raise a change request ([CHANGE_MANAGEMENT](../engineering/CHANGE_MANAGEMENT.md)).

## 0. Cross-page rules

**Standard states (every data view):** *loading* (skeleton matching layout, ≥ 300 ms delay before showing), *empty* (explain + primary action), *error* (message from `error.message`, requestId in small text, Retry), *permission-denied* (403 state), *success* (toast with undo link where sensible; toasts never carry the only copy of critical info).
**Tables (≥ 640 px):** sticky header, sortable columns per API `sort`, page size 25/50/100, filters in a bar (chips on mobile in a bottom sheet), URL query-string state (shareable/back-button safe). **Mobile (< 640 px):** each row becomes a card (title line, 2–3 key fields, status chip, chevron).
**Forms:** labels above inputs, helper text, inline errors from `details[].field`, submit disabled while pending, `Idempotency-Key` for IDem endpoints, unsaved-changes guard, `version` echoed for updates; 409 `VERSION_CONFLICT` → "Someone else changed this — Reload" dialog showing the diff summary.
**Destructive/financial confirmations:** dialog states what changes in plain words, shows amounts, requires typed reason where the API does (min 5 chars); primary button text is the action (e.g., "Void invoice"), never "OK".
**Money:** input as decimal text → minor integers via helper ([API_INTEGRATION](API_INTEGRATION.md) §6); display `Rs. 4,000` / `LKR 4,000.00` per DESIGN_SYSTEM. **Dates/times:** formatted in the academy timezone. **Status chips:** colour + icon + text.
**Accessibility:** see DESIGN_SYSTEM §8; every page has one `<h1>`, landmarks, focus management on route change and dialog open/close.

## 1. Auth pages

| Page | Fields & validation | Actions / states |
|---|---|---|
| Login | `username` (required, 3–32 chars, `a-z 0-9 . _ -`, case-insensitive; ADR-018), `password` (required), `totpCode` shown only after server says TOTP required | Submit → `AUTH-01`. Errors: `INVALID_CREDENTIALS` ("Username or password is incorrect"), `ACCOUNT_LOCKED` ("Too many attempts. Try again in 15 minutes"), `RATE_LIMITED`. No "show which field is wrong". |
| Accept invite | `password` (≥ 12 chars, strength meter, not common → server 422), `confirm` | Token invalid/expired → message + "Ask an owner for a new link". |
| Profile | Change password (`currentPassword`, `newPassword`); sessions list with "Sign out other devices"; TOTP enroll (QR from `secretUri`, 6-digit confirm) | `AUTH-04/06/07` |

## 2. Dashboard

**Owner (`DSH-01`)** — date-range selector (This month default, Last month, Custom) affects **invoiced/collected only**; outstanding/overdue are "as of now" and labelled so.

| Block | Content | Notes |
|---|---|---|
| Alerts strip | `alerts[]` (WhatsApp disconnected, dead/needs-review messages, open coach check-ins > 12 h, backup failed) | critical = red banner with link |
| Money row (4 cards) | **Invoiced** (`invoicedMinor`, count) · **Collected** (`collectedMinor`) · **Outstanding** (as of now) · **Overdue** (`overdueMinor`, `overdueCount`) | Never sum Invoiced+Collected; tooltip definitions from [BILLING_ENGINE](../architecture/BILLING_ENGINE.md) §14; "Due in next 7 days" mini-card; "Credit held" small |
| Players | Active total + per-group bars | click → `/players?ageGroupId=` |
| Today's sessions | `sessions.today` with attendance progress (`unmarked` count) | click → session |
| Coaches today | **Checked in now** (`coachTime.checkedInNow`: coach · group · check-in time · elapsed) · today's + this week's **coach hours** · "N open check-ins need correction" | staff-visible, never money; hours come only from **closed** `coach_attendance` records ([ATTENDANCE](../architecture/ATTENDANCE.md) §5); click → `/coach-attendance`; empty state: "No coach is clocked in right now" |
| Upcoming | `next7Days` | |
| Messaging | session status chip, failed/dead/needs-review counts | → `/whatsapp` |

**Coach (`DSH-02`) "Today":** big cards for today's sessions (group, time, venue) with primary buttons **Check in** and **Take attendance**; open check-in shows "Check out" + elapsed time; below: upcoming sessions and the coach's own total hours this week.
**Clock in/out is the most-used action on a phone:** one tap straight from the card (no dialog, no confirmation — it is reversible by an owner correction), ≥ 48 px target, thumb-reachable, thumb-side placement on the card, and it must work one-handed at 360 px (T-UI-10). Times shown are the server's, in the academy timezone, with the device clock never involved; after clocking out the card shows the recorded span.

## 3. Players

**List `/players`** — columns: Reg no · Name · Age group · Age · Status · Primary guardian phone (owner) · Outstanding (owner, `PLY-01 includes outstandingMinor`) ; filters: search `q`, status (default Active), age group, "Has outstanding" (owner); sort name/registration date; bulk actions: none (v1). Actions: **Register player**, **Import CSV** (owner). Coach columns: Reg no, Name, Age, Group, Status only.
**Register `/players/new`** (owner)
| Field | Rules |
|---|---|
| Full name* | 2–120 chars, trimmed |
| Date of birth | optional; not in future; age 3–25 (warning, not block, outside) |
| Registration date* | default today; ≤ today + 30 d |
| Age group | optional; **suggested chip** appears from DOB (`GRP-05`): "Suggested: Under-12 (age 11 on 1 Jan 2026) — Use this"; owner must pick/confirm; no auto-assign; if no DOB: manual select, helper "Assign later is allowed" |
| Guardian 1* | name (2–120), phone* (normalized, shows E.164 preview), relationship, consent select (Unknown/Granted) + source if Granted; "Receives invoices" toggle (default on) |
| Guardian 2 (optional) | same, optional |
| Notes / Coach notes | ≤ 1000 / ≤ 500 |
| Duplicate warning | on blur of name+DOB/phone call `PLY-08`; also handle 409 `DUPLICATE_SUSPECTED`: dialog listing matches (name, DOB, group, status) with "Open existing" or "Register anyway" (sets `acknowledgeDuplicates`) |
Success → profile page toast. Existing guardian reuse: typeahead over `GDN-01` to link a sibling's guardian.
**Profile `/players/[id]`** header: name, reg no, status chip, group chip, outstanding. Tabs: *Overview* (details, notes, edit), *Guardians* (list, consent state chip, consent update `GDN-05`, add/remove, primary toggle), *Group history* (timeline `PLY-07`), *Attendance* (summary + list with date filter), *Invoices* (`PLY-09`, link to invoice), *Messages* (filter `MSG-01 playerId`). Actions menu: Edit, **Change status** (dialog: status, effective date, reason, "Stop reminders" checkbox when withdrawing), **Transfer group** (dialog: group, effective date, reason* — warning: "Existing invoices are not changed; next invoice uses the new group's fee"). Coach profile: Overview + Attendance only, restricted fields.

## 4. Age groups, coaches, schedules

| Page | Specification |
|---|---|
| Age groups | Table: Name · Age range · Active players · **Current fee** (owner) · Status. Create/edit dialog (name unique among active; min ≤ max). Archive blocked message from `AGE_GROUP_HAS_ACTIVE_PLAYERS` with link to filtered players. |
| Group detail | Roster (players), **Fee history** table (effective from/to, amount) and "Change fee" dialog: `amount` (> 0, whole rupees unless fractional enabled), `effective from` (default first of next period; past dates need an explicit confirm checkbox "Applies from a past date; issued invoices are NOT changed"), preview text: "New invoices for periods starting on/after {date} will be LKR X". Schedules list, assigned coaches. |
| Coaches | List users role coach with groups; "Add coach" → `USR-02` with `inviteUrl` shown once in a copyable dialog; assign/end assignment dialogs (group, from date). |
| Schedules | Table weekday/time/venue/group/validity/active; create/edit with times (HH:mm), validity range; "Generate sessions" (range ≤ 90 d) shows created/skipped. Tue/Thu preset button for convenience (just fills the form). |

## 5. Sessions and attendance (mobile-critical)

**Sessions list:** default "Today + next 14 days"; filters group/status/date; calendar toggle optional (v1: list grouped by day). Owner: "Add session", cancel.
**Session page (`/sessions/[id]`)** — header: group, date, time (academy tz), venue, lead coach, status; **check-in bar** for coaches (state machine: *Check in* → *Checked in 17:02 · Check out* → *Done*); disabled with explanation outside the window (`CHECKIN_WINDOW_CLOSED`).
**Attendance sheet (one-hand mobile design):**
- Sticky top: counts chips (Present n · Late n · Absent n · Excused n · Unmarked n) and **Mark all present**.
- Player rows: ≥ 56 px high, name + reg no; segmented control **P / L / A / E** (≥ 44 × 44 px targets, labels also spelled out in accessible name); tap again to clear (unmarked) for unsaved rows; optional note via row expander.
- Sticky bottom **Save attendance** (primary, full width) → `ATT-02` with draft `Idempotency-Key`. While offline/failing: banner "Not saved — Retry"; draft persisted locally 24 h.
- Existing saved rows locked-looking: changing one prompts a **reason** field (required) (`ATT-02/03`); after the edit window (`canEdit=false`) the sheet is read-only for coaches with explanation + `editableUntil`.
- Conflict (`VERSION_CONFLICT`): row highlighted "Updated by {name}"; choose keep theirs/overwrite (reason required).
- Cancelled session: read-only banner.

## 6. Coach attendance (`/coach-attendance`)
Table: Coach · Session (group, date) · Check-in · Check-out · Duration · Entered by · Corrected badge. Filters: date range, coach (owner). Owner actions: **Add entry** and **Correct** (dialog: times, **reason***). Open check-ins highlighted. Coach sees own rows read-only. Disclaimer note: "Check-ins are self-reported and server-timestamped; they don't prove physical presence."

## 7. Billing and invoices

**Billing hub — Invoices tab (`INV-01`):** columns Invoice no · Player · Guardian · Group · Period · Issued · Due · Total · Paid · **Balance** · Status chip (Issued / Partially paid / Paid / **Overdue** (derived chip, red, shows days) / Void). Filters: status, overdue toggle, group, issue/due ranges, search. Row actions: Open, Record payment (prefills), Send WhatsApp, Download PDF. KPI header: Outstanding, Overdue (same definitions as dashboard).
**Runs tab:** list of runs (date, created/skipped, by whom) → detail.
**New billing run `/billing/new` (wizard):**
1. *Settings summary* (read-only: frequency, mode, due rule, with link to Settings) + **Target date** picker + optional group filter.
2. *Preview* (`BIL-01`): table of lines (player, group, period, fee, due, warnings) with count/total; **Skipped** section with reasons in plain language (`NO_GROUP` → "No age group on {date}", `NO_FEE` → "No fee set for the group"); per-row optional **adjustment** (negative amount + reason) e.g. half month.
3. *Issue* confirmation: "Create N invoices totalling LKR X?" checkbox "Send invoices by WhatsApp when ready" (disabled with reason if automation paused/ session down/ no consent — shows how many guardians will be skipped).
4. Result (`BIL-02`): created/skipped counts, link to filtered invoice list; `PREVIEW_STALE` → "Data changed — preview refreshed" and return to step 2.
**Invoice detail (`/billing/invoices/[id]`):** header (number, status chip, player/guardian links, dates), items table, totals block (total, paid, balance), **allocations** list (payment link, amount, date, reversed?), **messages** list (`MSG-01 invoiceId`), PDF preview/download, actions: *Record payment*, *Send via WhatsApp* (guardian picker; shows consent warnings), *Add discount/waiver* (negative adjustment dialog: amount ≤ balance, reason), *Void* (dialog: reason*, "Release payments to credit" shown when allocations exist, "Allow re-issue" checkbox default off with explanation), *Regenerate PDF*. Void shows banner and hides money actions. PDF generation pending → "Preparing PDF…" with retry.
**Manual invoice:** player picker, description, amount, due date (≥ issue date), guardian.

## 8. Payments, receipts, proofs

**Payments list:** Date received · Payer · Method · Reference · Amount · Allocated · **Credit** · Status chip (Pending / Confirmed / Rejected / Reversed) · Receipt no. Tabs: All · Pending · With credit · **Verification** (bank transfers carrying a proof — CR-004, hidden when `SET-08.proofCheck` is off). Filters: status, method, date range, payer.
**Record payment `/payments/new`:**
| Field | Rules |
|---|---|
| Payer | guardian typeahead (`GDN-01`) or free-text name |
| Amount* | > 0, whole rupees unless fractional enabled, ≤ LKR 100M |
| Method* | active `payment_methods`; reference field required when `requiresReference` |
| Date received* | default now; not future; > 1 year past needs confirm |
| Status | **Confirmed** (default for cash) / **Pending verification** |
| Proof | file picker (PDF/JPG/PNG/WebP ≤ 5 MB; camera capture on mobile); progress, remove; text: "A proof is evidence only — payment counts after you confirm it." For a bank transfer, ask the payer for the bank's **PDF e-receipt** — a photo is supporting evidence only and cannot be verified (see the verification queue below) |
| Allocation | table of payer's open invoices (`GDN-06`, oldest due first) with "Apply" amount inputs prefilled by `PAY-08`; remainder shown as **Credit**; validation live: each ≤ balance, sum ≤ amount; server errors `ALLOCATION_EXCEEDS_*` surfaced |
Duplicate hint: warn if same payer+amount+date within 24 h or `PAYMENT_DUPLICATE_REFERENCE`.
**Verification queue (CR-003/CR-004 — the tab is hidden when `SET-08.proofCheck` is off, but the manual `PRF-04` verify action and the "Ask for the PDF" prompt stay available):** `/payments` gains a **Verification** tab: bank-transfer payments that have a proof and are still `pending`, oldest first, each row showing payer, amount, received date and the advisory findings as pass/warn/fail chips (`AMOUNT_MATCH` · `REFERENCE_MATCH` · `BENEFICIARY_MATCH` · `DATE_TOLERANCE` · `PAYER_SOFT_MATCH` · `STATUS_SUCCESSFUL` · `RECEIPT_NOT_REUSED`, plus `STATEMENT_MATCHED`/`STATEMENT_MISSING` once statement reconciliation exists — [OPEN-023](../engineering/OPEN_DECISIONS.md)).
**Verification panel (per proof):** the **extracted facts** as labelled fields — bank · reference · transaction date + time · amount · payer · beneficiary · status — with the findings beneath them, each failure in plain language ("This receipt's reference is already attached to another payment"). Never show a raw parser dump, and never show a field we did not actually extract. A manual re-check is always available (`PRF-04`).
**PDF-first (CR-004):** a bank-transfer receipt must be the bank's **PDF e-receipt** (`doc_kind = bank_receipt_pdf`). A photo or screenshot (`bank_receipt_image`) is kept as supporting evidence and can never produce a passing check; when only an image is attached the row reads **"Not verifiable — ask for the PDF"** with a one-tap **Ask for the PDF** action that copies a ready-to-send message ("Please send the bank transfer receipt as a PDF from your bank app — a photo can't be verified.") using the existing copy/`wa.me` helper (§9).
**Label discipline (a rule, not styling):** the amount reads **Pending verification** until an owner confirms; the derived labels are **"Ready to confirm — checks passed"** · **"Check failed: <reason>"** · **"Not verifiable — ask for the PDF"** · **"No proof attached"**. "Verified", "paid" and "confirmed" — and any green tick standing where money is concerned — may **never** stand in for a confirmation ([ADR-020](../engineering/DECISIONS.md#adr-020), [ADR-021](../engineering/DECISIONS.md#adr-021)). Checks are advice, not proof: a receipt can be edited or reused, and "successful" does not mean the money is still in the account ([PAYMENT_VERIFICATION](../architecture/PAYMENT_VERIFICATION.md) §8). Actions stay **Confirm** / **Reject** — the queue is a view, never a decision (T-FIN-20). A failed check explains what to look at; it never blocks Confirm. Empty state: "Nothing to verify — all bank transfers are confirmed."

**Payment detail:** summary, status timeline, allocations (with link), **Proofs** panel (thumbnails after `PRF-02` fetch on click; open in new tab; audited; each proof shows its `doc_kind`, its verification status and a **Verify** action, `PRF-04`), receipt card (number, Download PDF `RCT-02`, Regenerate), actions: *Confirm* (pending; allocation editor), *Reject* (reason), *Allocate credit*, *Reverse payment* (reason*; warning lists invoices that will reopen), edit reference/notes/date.

## 9. WhatsApp (`/whatsapp`)

| Tab | Content |
|---|---|
| Status | Connection card: automation switch **Pause/Resume** (`MSG-07`, confirm dialog), session status chip + last checked, queue counts, plain-language banner when disconnected ("Reminders are paused. Open the OpenWA dashboard and reconnect — scan the QR code or enter the pairing code..." text from handover), **Automations list** (`SET-08`, below the connection card): one switch each for **Invoices** · **Pre-due reminders** · **Late (overdue) reminders** · **Bank-transfer proof checks**, with the master state shown read-only as "Paused (master)" when `MSG-07` is active. Each switch states its effect in one line — "Off: no new sends of this kind, and unsent ones are cancelled. Messages missed while off are **not** sent retroactively." Show a warning when an automation is off while unpaid invoices exist (R-20) — never let the owner believe reminders are running when they are not. Every toggle is confirmed + audited. **Send test to my number** (`MSG-08`). Show the provider's own session-status text; the exact status values are **VERIFY — spike S1** ([OPENWA_INTEGRATION](../architecture/OPENWA_INTEGRATION.md) §2 O18). Standing risk note: "Unofficial WhatsApp automation via a reverse-engineered client — delivery isn't guaranteed." |
| Messages | Table (`MSG-01`): Scheduled/Sent time · Kind · Player · Guardian (masked phone) · Invoice · **Status** · **Delivery** · Attempts · Error. Status labels: *Queued, Sending, Sent, Failed (will retry), Needs review, Failed permanently, Cancelled, Skipped (reason)*; Delivery labels: *Unknown, Accepted by server, **Delivered** (only for `device_delivered`), **Read*** — "Delivered" is never shown for `sent` alone. Mapping provider events onto `device_delivered`/`read` is **VERIFY — spike S1** ([OPENWA_INTEGRATION](../architecture/OPENWA_INTEGRATION.md) §2 O19); until it is confirmed the adapter may only emit `server_accepted`/`unknown`, so the **Delivered** and **Read** labels stay unreachable rather than guessed. Filters: status, kind, date, player/invoice. Row detail drawer: rendered text, event timeline, actions **Retry**, **Cancel**, **Mark sent manually** (with note), "Copy message & open wa.me" helper for manual fallback. |
| Reminders & templates | Reminder rules table (kind, offset days, active) with add/remove; template editor per key with variable chips, live preview with sample values, validation of unknown `{{vars}}`; character counter. |
| Settings | Send window, pacing, max per hour, invoice mode (`link` / `attachment_and_link` — the attachment mode is disabled with a hint until the S1 media test passes; OpenWA supports documents and has no paid tier, so capability must be proven by test, not purchased), opt-out keywords. Consent policy text snippet for forms. |

## 10. Reports (`/reports/[name]`) and exports
Common: date range presets, filter bar, table with totals row, **Export CSV** button (`RPT-02`; shows "Preparing…", handles 429/413 row cap with message "Narrow the filters (max 50,000 rows)"), "Generated at" timestamp, filters echoed in the CSV filename.

| `name` | Filters | Columns | Totals |
|---|---|---|---|
| `players` | status, group, registered from/to, q | Reg no, name, group, status, registration date, DOB, primary guardian, phone | count |
| `attendance-summary` | from, to, group, player | Player, group, sessions, present, late, absent, excused, unmarked, rate % | group averages |
| `attendance-detail` | from, to, group, session, status | Date, session, player, status, note, marked by | counts per status |
| `invoices` | issue/due range, status, group, overdue, player | Invoice no, player, group, period, issue, due, total, paid, balance, status | Σ total, Σ paid, Σ balance |
| `payments` | received range, method, status, guardian | Date, payer, method, reference, amount, allocated, credit, status, receipt no | Σ amount |
| `outstanding` | group, min days overdue (as of now) | Player, guardian, invoice, due, balance, days overdue | Σ balance |
| `collections` | range, groupBy `day|week|month|method|ageGroup` | Period/bucket, **Collected**, **Invoiced** (separate columns), count | separate sums, never combined |
| `coach-attendance` | range, coach | Coach, session, in, out, hours, corrected | Σ hours (closed only) |

## 11. Admin pages

| Page | Specification |
|---|---|
| Users | List (full name, **username**, role, status, last login); Add user (`USR-02`, invite URL dialog: the owner **chooses the `username`** — 3–32 chars `a-z 0-9 . _ -`, uniqueness checked server-side — and the dialog shows **username + invite URL once** with a copy button, so it can be handed over out-of-band; a username cannot be edited afterwards, only replaced by re-inviting, per [ADR-018](../engineering/DECISIONS.md#adr-018)); row menu: edit, disable/enable (reason), reset password (invite URL), revoke sessions. `LAST_OWNER` error → plain message. |
| Settings → Academy | name, address, phone, email, **payment instructions** (multiline, shown on PDFs; preview), timezone (select; default Asia/Colombo), age rule (Jan 1 / fixed date / today) + explanation text with example, coach visibility toggle, attendance edit window, check-in window. |
| Settings → Billing | frequency, mode (calendar/anchored) with explainer diagrams, due rule, issue timing. Save dialog: "Applies to invoices issued after now. Existing invoices won't change." |
| Settings → Payment methods | list, add (code immutable), requires-reference toggle, deactivate. |
| Settings → Branding | logo upload (preview on a sample invoice header); note when absent: "Using text header". |
| Imports | 3-step wizard (upload → validation report with row-level errors/warnings → commit) per [CSV_IMPORT](../engineering/CSV_IMPORT.md). |
| Audit | Table with filters (actor, entity type/id, action, date) and detail drawer showing before/after JSON diff (masked values as given). |
| System | Cards: DB, storage, OpenWA, queue, scheduler heartbeat, last backup, version; each with status chip and "last checked". |
