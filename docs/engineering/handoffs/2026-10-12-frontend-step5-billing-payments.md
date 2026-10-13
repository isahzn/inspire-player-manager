# HANDOFF 2026-10-12 — Frontend Step 5: billing and payments

Author: Buffy (frontend lead) · Milestone: M5 (frontend slice, mocks) · Change record: none (no spec/architecture change beyond one error-code clarification)
Branch/PR: none — **this project still has no tracked files** (`git ls-files .` → 0) · Plan: [FRONTEND_PLAN.md](../../../FRONTEND_PLAN.md) §13

## 1. Scope delivered

- **`/billing`** — the hub: **Invoices** and **Runs** tabs, filters held in the URL, and a KPI header that keeps **Outstanding and Overdue separate** and never adds **Invoiced** to **Collected**.
- **`/billing/new`** — the run wizard (BIL-01 → BIL-02): target date (+ optional age group) → **preview** with fee, due date, guardian, skipped players in plain language and a per-line adjustment → **confirm** with optional WhatsApp queueing → **done** with the created/skipped counts. A preview that moved on shows *"Data changed — preview refreshed"*, re-previews, and states that nothing was created.
- **`/billing/invoices/[id]`** — INV-02..08: items, adjustment (reduction only), void **with released allocations**, `"Preparing PDF…"` + regenerate, send.
- **`/billing/invoices/new`** — INV-03 manual invoice.
- **`/payments`** — PAY-01 list with the **All / Pending / With credit** tabs (filters in the URL).
- **`/payments/new`** — PAY-02 record payment with the allocation editor and the PAY-08 suggestion.
- **`/payments/[id]`** — PAY-03..07, **PRF-01..04** (the CR-004 verification panel), RCT-01/02 (receipt + PDF).
- **Data layer:** the mock store extended to **schema 3** (`src/mocks/db.ts`: invoices with items/adjustments/allocations, payments with credit, proofs with findings, receipts, billing runs; mirrored to `localStorage ia_mock_people_v1`); `src/mocks/billing.ts` = the money engine implementing the **real** rules of `BILLING_ENGINE` §1–§12 and `PAYMENT_VERIFICATION` (balances *derived* from active allocations, a deterministic FNV-1a `previewHash`, 409 `PREVIEW_STALE` on issue, confirm-before-allocate, advisory proofs that never move money); `src/mocks/handlers.billing.ts` (31 route registrations); `src/mocks/handlers.people.ts` (the Step 3 read-only INV-02 stub is retired to a comment — `GET */invoices/:id` is now owned by the billing slice); `src/mocks/handlers.ts` composes `auth → people → sessions → billing` (MSW answers with the first match); contract types and wrappers in `src/api/types.ts` and `src/api/client.ts`; `src/lib/billing.ts` = the label-discipline module (`invoiceStatusLabel`, `paymentStatusLabel`, `proofLabel` over a closed set of allowed strings, `sortFindings`, `findingLabel`); `src/components/StatusChip.tsx`.
- **T-UI-01 unit tests:** `src/lib/__tests__/money.test.ts` (11 tests) and `dates.test.ts` (6 tests) under Vitest, run by `npm run verify:unit`.
- Migrations added: none (no backend). Docs implemented: `BILLING_ENGINE` §1–§12, `PAYMENT_VERIFICATION`, `API_CONTRACTS` §1/§2 (the endpoint rows for BIL/INV/PAY/PRF/RCT/SET).
- New verification script: `frontend/.verify/step5-e2e.mjs` (60 checks), run by `npm run verify:e2e:step5`.

**Not built, on purpose:** the CR-003 surfaces. `ADR-019` is still *Proposed*, so the **Verification tab** the route spec describes for `/payments` is deliberately absent from `TABS`, `SET-08` per-automation switches are not built, and automatic proof checks on upload are off — `settings.proofAutoCheck` stays false and the explicit `PRF-04` re-check (always allowed by the contract) is the only path the UI offers.

## 2. Evidence

- `npm run typecheck` — clean, exit 0 (log `frontend/.verify/typecheck-step5.log`) · `npm run lint` — clean, **0 errors / 0 warnings**, exit 0 (log `frontend/.verify/lint-step5.log`) · `npm run build` — green, **33 routes**, exit 0 (log `frontend/.verify/build-step5.log`; that log's separate `Generating static pages (35/35)` line counts differently, so it is not a contradiction).
- `npm run verify:unit` — **Vitest 17/17 tests pass** (money 11 + dates 6), exit 0 (log `frontend/.verify/unit-step5.log`).
- **`npm run verify:e2e:step5` — 60/60 checks PASS, exit 0** in system Chrome against `npm run dev` on :3100 (mock mode), log `frontend/.verify/e2e-step5.log`.
- **The full suite was re-run after this slice: 12/12 (Step 2) + 30/30 (Step 3) + 41/41 (Step 4) + 60/60 (Step 5) = 143 checks PASS, exit 0** (log `frontend/.verify/e2e-all-step5.log`) — no Step 3/4 regression.
- One **Step 3 check was fixed while re-running the suite**: `coaches page lists seeded coaches` read `document.body` right after the header rendered, so it raced the list fetch and failed intermittently (it failed once, 29/30, in a re-run; that log has since been overwritten by the final combined run, so the evidence for the fix is the code change plus Step 3 passing **30/30** in `frontend/.verify/e2e-all-step5.log`). `frontend/.verify/step3-e2e.mjs` now waits for the seeded rows before reading the body — the assertion itself was not relaxed.
- Interface behaviour proven through the running app (Step 5 script):
  - **invoices hub:** 7 rows covering every status including the void one, each row carrying number, player, balance and a status word; **Outstanding and Overdue shown separately**, **Invoiced never added to Collected**; the overdue filter keeps only overdue invoices; **two quick filter changes both survive** (the Step 3 stale-URL race, checked again on this page's copy); the runs tab lists the seeded run with its counts.
  - **invoice detail:** the fee line, totals and the payment that paid it; the allocations list links to the payment that made them; **a discount above the remaining balance is refused before any request**; a valid waiver reduces the balance; **voiding an invoice that still has allocations is refused until they are released**; a voided invoice keeps its reason, drops out of outstanding and offers **no money actions**; releasing allocations **turns them into payment credit**; a missing PDF shows *"Preparing PDF…"* while **INV-06 answers 409 `PDF_NOT_READY`**, and after regenerating it streams a real `application/pdf`.
  - **payments list:** every seeded status, a pending amount reading **"Pending verification"** and never a confirmation, the credit a confirmed payment holds, an already-confirmed payment never labelled "ready to confirm", the **Pending** tab filtering on the wire rather than in the DOM, and the **With credit** tab showing only payments holding credit.
  - **the proof panel (CR-004):** a pending bank transfer starts unverified with its evidence disclaimer; the manual **PRF-04** re-check is offered; the check's facts are shown as labelled fields; a reused receipt is a **failure with a plain-language explanation**; the panel states that checks are **advisory and level 3 is not available**; **a failed check does not touch the payment** (still pending, no receipt); a photo-only proof reads **"Not verifiable — ask for the PDF"** with the copy/`wa.me` fallback; a photo can never produce a passing check and the payment stays pending (rollup `unverifiable`); confirming is described as **the owner's decision, not the check's outcome**, and confirming issues a receipt and drops the pending banner — **RCT-01** then lists it and **RCT-02** streams its PDF.
  - **recording money:** the amount field echoes the parsed amount in minor-unit formatting; the allocation editor shows the remainder as credit; recording lands on the payment's detail with an allocation and a receipt; allocating reduces the invoice balance; and against the API the app itself calls: **409 `ALLOCATION_EXCEEDS_BALANCE`**, **400 without an `Idempotency-Key`**, **a repeated key replays instead of recording twice**, **409 `PAYMENT_DUPLICATE_REFERENCE`**, and **409 `PAYMENT_NOT_CONFIRMED`** when a `pending` payment arrives with allocations.
  - **reversing** warns which invoices will be open again and then reopens the invoice it paid.
  - **the wizard:** it previews lines with a count and a total before anything is issued; skipped players are explained in plain language, not as raw codes; issuing reports **6 invoices created, 2 skipped** for the target date; a period that still has billable lines issues successfully (201); **replaying a preview that has moved on is 409 `PREVIEW_STALE`**; once a run has issued a period, that period previews as already invoiced; and the wizard under the same race **refuses, says nothing was created and goes back to fresh numbers** (runs 3→4, i.e. no run was created by the stale attempt).
  - **on a 360 px phone (measured, not assumed):** the invoice list and the payments list render as **cards with no visible table** and **no sideways scroll** (326 px card width, overflow 0 px), and on the record-payment screen the amount field measures **48 px** and the submit button **44 px** — the money flows of this slice stay one-handed.
  - **permissions:** a coach gets no access to billing and no invoice data, no access to payments and never sees a proof, and the **API itself answers 403**, not just the router.
- Screenshots for human review (`frontend/.verify/`): `billing-invoices-1280.png`, `billing-runs-1280.png`, `billing-run-result-1280.png`, `billing-run-stale-1280.png`, `invoice-detail-1280.png`, `invoice-void-1280.png`, `payments-1280.png`, `payment-confirmed-1280.png`, `payment-verification-1280.png`, plus the 360 px views `billing-invoices-360.png`, `payments-360.png`, `payments-new-360.png`.

## 3. Deviations from the spec

| Spec ref | What differs | Why | Needs a spec change? (CR-###) |
|---|---|---|---|
| `API_CONTRACTS` §1 error table / PAY-02 | `POST /payments` with `status:'pending'` and `allocations` answers **409 `PAYMENT_NOT_CONFIRMED`** (this slice changed it from 422 `VALIDATION_ERROR`; the project is not version-controlled, so the "before" exists in the session, not in a diff — the current state is what `src/mocks/billing.ts` and the PAY-02 row both say) | The §1 table puts `PAYMENT_NOT_CONFIRMED` at 409, and the record-payment screen already maps that code — one rule, one code | No — the PAY-02 row was clarified in the same change |
| mock store | Schema **3** (`db.ts`) adds invoices, payments, proofs, receipts and billing runs | The money slice needs a ledger to derive balances from; the store re-seeds when the schema does not match | No (C0) — mock only |
| `PAGE_SPECIFICATIONS` / `ROUTES_AND_NAVIGATION` `/payments` | The **Verification** tab is absent | It is a CR-003 surface and `ADR-019` is *Proposed*; the per-proof panel (CR-004) is built | No — blocked on Hassen, recorded here |
| `PRF-04` automatic checks | Only the **explicit** re-check is reachable | `SET-08.proofCheck` is CR-003 and unapproved, so `settings.proofAutoCheck` stays false | No — blocked on Hassen, recorded here |

## 4. Contract drift / requests

1. **PAY-08's path carries a payment id while the suggestion is keyed by `guardianId`.** The record-payment form has no payment yet, so it calls the endpoint with the literal id `new`. Documented at both ends (`src/api/client.ts`, `src/mocks/handlers.billing.ts` / `src/app/payments/new/page.tsx`). Either the path should take the payer instead of an id, or the contract should say the id is optional on a *new* suggestion.
2. **BIL-02's queued message jobs' `skipReason` strings are not defined in the contract.** Unknown values are printed exactly as they arrive rather than guessed at — the UI carries friendly wording for the reasons it recognises and leaves the rest verbatim.
3. **Scope boundary worth writing down, not a request:** the mock implements the *real* rules on purpose — a mock that always says yes would prove nothing. Balances are derived, `PREVIEW_STALE` is a real refusal, and allocation is the only thing that moves a balance.

## 5. Known gaps and risks

- **The mock never keeps the owner's uploaded bytes.** A proof download serves a generated stub of the same kind, so **nothing in this slice is a real document reader**, and the "extraction" is derived from what the owner recorded plus the academy's own account — the only deterministic source a mock has. The real parser is per-bank and is Freebuff's (`OPEN-023`), and the findings are advisory throughout (`ADR-020`/`ADR-021`).
- **CR-003 surfaces remain blocked** on Hassen's approval (`ADR-019` *Proposed*): the `/payments` Verification tab, the `SET-08` per-automation switches and automatic checks on upload.
- **No axe / a11y scan has been run for any step (1–5).**
- **T-UI-10's real-phone pass is still owed by Hassen** — what the scripts measure is an emulated viewport, not a phone.
- **The `previewHash` algorithm is not fixed by the contract.** The mock uses FNV-1a over `targetDate + lines + skipped`, so *agreement with the backend's hash is unproven*: the frontend only ever echoes back the value the server handed it, which is what makes `PREVIEW_STALE` safe either way, but the two digests are not guaranteed to match.
- **Money correctness is asserted against the mock's own rules.** The 60 checks exercise the app's behaviour through the running UI plus the API it calls; no server exists, so nothing here proves the real ledger agrees.
- **No version control on this project** — unchanged (`git ls-files .` → 0), so this slice can only be diffed by hand.

## 6. How to run / verify

```bash
cd "Projects/inspire-academy-player manager/frontend"
npm install
npm run dev                 # http://localhost:3100 (mock mode)
npm run typecheck && npm run lint && npm run build
npm run verify:unit         # Vitest: money.ts + dates.ts (T-UI-01)
npm run verify:e2e          # step 2 (12) + step 3 (30) + step 4 (41) + step 5 (60)
npm run verify:e2e:step5    # step 5 only
```

Mock logins (any password): `owner` · `coach`. The money fixtures live in the same store as everything else (`localStorage ia_mock_people_v1`, schema 3); clear site data to re-seed. Every browser context in the e2e starts fresh, so the seeded invoices, payments and proofs are the same on every run.

## 7. Next steps (exact)

1. **Hassen (owner):** look at the screenshots in `frontend/.verify/`, do the outstanding **T-UI-10 device pass**, and decide **CR-003** — the Verification tab, the `SET-08` switches and automatic checks on upload are all waiting on it.
2. **Claude (docs):** answer §4.1 and §4.2 (the PAY-08 path, BIL-02's `skipReason` vocabulary).
3. **Frontend:** **Step 6 — WhatsApp pages** next, unless Hassen wants the CR-003 clock cards first.
4. **Freebuff (when M1 lands):** the per-bank receipt parser behind `PRF-04` (`OPEN-023`), server-side preview/issue with a real `PREVIEW_STALE`, derived balances from the allocation ledger, and PDF generation behind `INV-06`/`RCT-02`.

## 8. Reviewer checklist (Claude/Hassen fills)

[ ] Compared to DATABASE/API docs  [ ] Permissions verified by route matrix  [ ] No money floats
[ ] Audit rows present  [ ] Tests evidence reviewed  [ ] PROJECT_STATUS updated  [ ] Verdict: accepted / changes requested
