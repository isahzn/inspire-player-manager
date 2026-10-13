# HANDOFF 2026-10-12 — Plan changes (CR-003): coach clock in/out on the dashboard · per-automation WhatsApp switches · mobile as a shipping requirement

Author: Buffy (frontend lead) · Milestone: M1 (plan change, awaiting approval) · Change record: **CR-003** · ADRs: [ADR-019](../DECISIONS.md#adr-019) (Proposed) · [ADR-020](../DECISIONS.md#adr-020) (Accepted) · Open item: [OPEN-022](../OPEN_DECISIONS.md)
Branch/PR: none — **this project has no tracked files** (`git ls-files .` → 0; the whole folder is untracked in the workspace repo). Docs only. · Plan: [FRONTEND_PLAN.md](../../../FRONTEND_PLAN.md) §10

## 1. Scope delivered

Requested by Hassen 2026-10-12: *(1) a coach clocks in and out and the time is recorded on the dashboard; (2) WhatsApp automation for late reminders, bank-transfer verification and invoices, each switchable off on its own; (3) it has to work on mobile.*

**Docs only. No code was written and nothing is approved yet.** Per [CHANGE_MANAGEMENT](../CHANGE_MANAGEMENT.md) §1 this is a Change Request + impact analysis; the decision step (§1.6) is Hassen's.

What was added, and where:

| Part | What the plan now says | Docs changed |
|---|---|---|
| **1. Coach clock in/out → dashboard** | Coach time is recorded in one place (`coach_attendance`, unchanged) and surfaced twice: the coach dashboard gets **one-tap clock in/out** (no dialog, ≥ 48 px, elapsed while open, own weekly hours); the owner dashboard gets a derived **`coachTime`** block (checked in now, today/week hours, open check-ins needing correction) and a **"Coaches today"** card. No new table, no duplicated state, no coupling to money. | [API_CONTRACTS](../../architecture/API_CONTRACTS.md) §2 `OwnerDashboard` · [ATTENDANCE](../../architecture/ATTENDANCE.md) §4/§5 · [PAGE_SPECIFICATIONS](../../frontend/PAGE_SPECIFICATIONS.md) §2 · [MOCK_DATA](../MOCK_DATA.md) |
| **2a. Per-automation switches** | Four per-automation booleans in `academy_settings` (invoice delivery · pre-due reminders · overdue/late reminders · proof checks), **all default false**, with a new **`SET-08`** as their one surface. `MSG-07` stays the **master** pause and always wins. Disabling a kind stops new enqueues **and** cancels that kind's unsent jobs; **re-enabling never back-fills**. A manual invoice send is not blocked by the per-automation flag. | [DATABASE](../../architecture/DATABASE.md) §3.1 · [API_CONTRACTS](../../architecture/API_CONTRACTS.md) §3.6 (`SET-07` note corrected) + new `SET-08` + `MSG-06.automations` · [OPENWA_INTEGRATION](../../architecture/OPENWA_INTEGRATION.md) §4/§6/§11 · [PAGE_SPECIFICATIONS](../../frontend/PAGE_SPECIFICATIONS.md) §9 |
| **2b. Bank-transfer verification** | Automated as **advisory, deterministic checks only** (duplicate reference · amount vs. outstanding · proof present/duplicate · pending age) feeding a **Verification queue** on `/payments`, oldest first. It can flag, sort and explain; it **cannot** confirm, reject, allocate or change any balance — `PAY-04` stays an owner action. Proof is still evidence, not payment (ADR-013). | [DECISIONS](../DECISIONS.md) ADR-020 · [API_CONTRACTS](../../architecture/API_CONTRACTS.md) `PAY-04` + `SET-08.proofCheck` · [PAGE_SPECIFICATIONS](../../frontend/PAGE_SPECIFICATIONS.md) §8 · [OPEN_DECISIONS](../OPEN_DECISIONS.md) OPEN-022 |
| **3. Mobile** | Mobile is a **shipping requirement, not a polish step**: every new surface must be one-handed usable at 360 px with ≥ 44 px targets and is checked on a real phone at its own milestone exit (new T-UI-10..12), not deferred to M9. | [IMPLEMENTATION_PLAN](../IMPLEMENTATION_PLAN.md) §3 + M4/M5/M7/M8 · [TESTING_AND_ACCEPTANCE](../TESTING_AND_ACCEPTANCE.md) · [PAGE_SPECIFICATIONS](../../frontend/PAGE_SPECIFICATIONS.md) |

Also updated: [ROUTES_AND_NAVIGATION](../../frontend/ROUTES_AND_NAVIGATION.md) (`/payments` Verification tab) · [KNOWN_RISKS](../KNOWN_RISKS.md) (R-20 automation silently off, R-21 checks mistaken for verification) · [TESTING_AND_ACCEPTANCE](../TESTING_AND_ACCEPTANCE.md) (T-ATT-11, T-MSG-13/14, T-FIN-20, T-UI-10/11/12, traceability REQ-06/09/11/16, release-gate items 2 and 5) · [PROJECT_STATUS](../PROJECT_STATUS.md) (CR-003 record) · [FRONTEND_PLAN](../../../FRONTEND_PLAN.md).

## 2. Evidence

- **Good news: part 1 was mostly already specified.** `coach_attendance` (DATABASE §3.7), coach check-in/check-out rules (ATTENDANCE §4: windows, uniqueness, server-stamped times, owner corrections with reason), `CAT-01..05` endpoints and `DSH-02.myOpenCheckIn` all pre-existed, and `ATTENDANCE` §4 already promised that a check-in open > 12 h "is flagged on the owner dashboard" — **with no field to hold it**. The change therefore adds the missing `coachTime` block and the display, not a new mechanism.
- **Part 2 needed a written decision, not a silent edit:** the specs said "automation on/off is **only** via MSG-07", which the per-automation request contradicts. That line was corrected in the same change (CHANGE_MANAGEMENT §3: messaging behaviour ⇒ OPENWA_INTEGRATION + DATABASE §3.6 + API §3.7 + PAGE_SPEC §9 + T-MSG together).
- **Part 2b was stopped short of the money rule deliberately.** "Automate bank transfer verification" has two readings, and one of them (auto-confirm when checks pass) would break ADR-013 and let a forgeable guardian screenshot move the ledger. The plan takes the safe reading as the default (OPEN-022) and records the alternative as an explicit C4 question — the C4 written-approval path exists for exactly this.
- Verification of this work is documentary: reading the listed files (there is no diff to review — see §6: nothing in this project is under version control). **No tests exist to run** — no code changed, the backend does not exist, and these are specification documents. Nothing here is claimed as implemented.
- Cross-document consistency checks were run manually (every new ID defined once and referenced correctly: `SET-08`, `coachTime`, `T-ATT-11`, `T-MSG-13/14`, `T-FIN-20`, `T-UI-10..12`, `R-20`, `R-21`, `OPEN-022`, `ADR-019`, `ADR-020`).

## 3. Deviations from the spec

| Spec ref | What differs | Why | Needs spec change? (CR-###) |
|---|---|---|---|
| `API_CONTRACTS` SET-07 note ("automation on/off is **only** via MSG-07") | Corrected to: master pause is MSG-07, per-automation is SET-08 | The request requires per-automation control; leaving the old line would have left two documents contradicting each other | CR-003 (this change) |
| `PAGE_SPECIFICATIONS` §2 alerts strip / ATTENDANCE §4 ("flagged on the owner dashboard") | Now backed by a real field (`coachTime.openNeedingCorrection`) | The earlier text promised a flag that no field could carry | CR-003 (this change) |

## 4. Contract drift / requests

- **New contract surface for Freebuff M1/M5/M7:** `SET-08` (`GET/PATCH /settings/automations`), four `academy_settings` booleans, `OwnerDashboard.coachTime`, `MSG-06.automations`, `checks[]` on a pending payment, four new test rows. `api/openapi.yaml` must carry all of it when it is produced.
- **Decided**: bank-transfer automation is advisory only (ADR-020, Accepted — the money boundary does not move with this request).
- **Not decided — needs the owner (OPEN-022):** may verification *read* the uploaded proof image (OCR/vision extraction to pre-fill amount/reference/date)? Safe default = **no**; "yes" would be a C4 scope change (AI/document-understanding feature, plus guardian bank data leaving our infrastructure).
- **Needs the owner (ADR-019 is *Proposed*):** confirm the switch set and its semantics — specifically *"re-enabling never back-fills"* and *"a manual invoice send is not blocked by the per-automation flag"*. Both are decisions a reasonable owner could want the other way round, so they are written down rather than assumed.

## 5. Known gaps and risks

- **Nothing is built.** Every item here is *Planned* on the evidence ladder (CONTINUATION_GUIDE §3). No T-ID can pass yet; the backend and the migrations do not exist.
- **Approval gate:** ADR-019 is Proposed, so M7's automation work must not start from it as though it were settled. CR-003 is `pending owner approval` in PROJECT_STATUS.
- **R-20 (new):** with per-automation switches, an owner can believe reminders are running when they are off. Mitigated in the plan (visible switch state + effect text + warning when an automation is off while unpaid invoices exist), but it is a real operational risk that only shows up in use.
- **R-21 (new):** a green "checks passed" badge can be misread as verification. Mitigated by never labelling a checked payment as paid/verified and by T-FIN-20 asserting no automation path can confirm a payment.
- **No version control on this project.** `git ls-files .` returns **0** — every file here (docs, `frontend/`, `design/`) is untracked in the workspace repo. Nothing can be diffed, reverted or audited, and a bad edit or deletion is unrecoverable. This is the single most fixable risk in the repository: commit it (and add `node_modules/`, `.next/`, `.verify/*.png` to `.gitignore` first).
- **Mobile claims are unverified for these surfaces** — they do not exist yet; T-UI-10..12 are the acceptance rows that will hold them to it.
- **Pacing reality unchanged:** a monthly run of ~100 invoices still drains over 1–2 hours (OPENWA_INTEGRATION §6), so per-automation switches change *what* is sent, not how fast.

## 6. How to run / verify

Nothing to run — this change touches Markdown only. **`git diff` will not help: this project is untracked** (`git ls-files .` returns 0 files), so the edits can only be reviewed by reading the files. To check consistency:

```bash
cd "Projects/inspire-academy-player manager"
grep -rn "SET-08" docs                # new endpoint defined once (API_CONTRACTS) and referenced consistently
grep -rn "coachTime" docs             # one shape, two consumers (DSH-01 + MOCK_DATA)
grep -rn "OPEN-022\|ADR-019\|ADR-020" docs/engineering
node tools/check-stale-refs.mts       # provider-name lint (CONTINUATION_GUIDE §6) — exits 0
```

Relative-link check (run 2026-10-12): 277 relative links across 36 files, **0 broken**.

```bash
# link check (no script is tracked in the repo; this is how it was done)
node -e '...' # or any markdown link checker over docs/ + *.md
```

## 7. Next steps (exact)

1. **Hassen:** approve/amend **CR-003**; answer **OPEN-022**; confirm the two ADR-019 semantics.
2. **Claude:** fold the new contract surface into `api/openapi.yaml` when M1 lands; keep `SET-08` the single surface for automation switches.
3. **Freebuff (M4/M5/M7):** implement `coachTime` aggregates, `SET-08` + per-kind gating in the worker, and the advisory proof checks — each only after CR-003 is approved.
4. **Frontend (Steps 4/5/6/7):** clock in/out one-tap, Automations list, Verification queue, "Coaches today" card — with the 360 px checks in the same step.

## 8. Reviewer checklist (Claude/Hassen fills)

[ ] Compared to DATABASE/API docs  [ ] Permissions verified by route matrix  [ ] No money floats
[ ] Audit rows present  [ ] Tests evidence reviewed  [ ] PROJECT_STATUS updated  [ ] Verdict: accepted / changes requested
