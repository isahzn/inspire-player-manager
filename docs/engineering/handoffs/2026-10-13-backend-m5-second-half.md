# HANDOFF 2026-10-13 — backend M5 second half: the payments bugs, and the billing/invoice surface

Author: Freebuff (backend lead)      Milestone: M5 (partial — 21/26)      Branch/PR: none — work sits uncommitted in the working tree

## 1. Scope delivered

- **Endpoints implemented (9, this half):** `BIL-01`, `BIL-02`, `BIL-03.list`, `BIL-03.read`,
  `INV-01`, `INV-02`, `INV-03`, `INV-04`, `INV-05`. M5 is now **21/26**; project total
  **94/134** (`scripts/progress-report.ts`).
- **The first half was finished first.** The payment surface (`PAY-01..08`, `PRF-03/04`,
  `RCT-01`) was left mid-session with four failing tests. Those failures were real, and two of
  them were bugs in the foundation rather than in the tests (§4) — recorded here because the
  fix is what makes the billing half trustworthy.
- **Migration `0012_money.sql` completed:** the three period rules as SQL —
  `app.billing_period_start`, `app.billing_period_end`, `app.billing_month_index` — so the
  preview, the run and any later report compute a period the same way (BILLING_ENGINE §3).
- **New source:** `src/routes/billing-engine.ts` (config, preview, `previewHash`, the issue-run
  transaction), `src/routes/billing.ts` (BIL-01/02/03), `src/routes/invoices.ts` (INV-01..05).
  Invoice/run serializers in `money-serialize.ts`; the full invoice projection
  (`INVOICE_FULL_SELECT`, `loadInvoiceFull`, `invoiceItems`, `allocationsForInvoice`) and
  `releaseAllocationsForInvoice` in `money-helpers.ts`.
- **Docs read before starting:** BILLING_ENGINE §1–§15, API_CONTRACTS §3.6 (via
  `spec/sections/06-billing-payments.ts`), DATABASE §3.3/§3.4/§4/§7/§8, AUTH §4, the M4
  handoffs.
- **One tool fixed:** `tools/check-stale-refs.mts` skipped nothing, so the retired-provider
  token it looks for matched by chance inside a base64 `integrity` hash in
  `backend/package-lock.json` — the consistency check the status doc claims passes was failing
  on a hash. Integrity lines are skipped now (the rest of a lockfile is still scanned, so a
  real dependency carrying the retired name is still caught) and the self-test covers both
  directions. `check-links` → 384 links / 52 files, 0 broken; `check-stale-refs` → OK,
  self-test 22 PASS.

## 2. Evidence

| Check | Result |
|---|---|
| `npx tsc --noEmit` | **exit 0** |
| `npx vitest run` (all three projects) | **exit 0** — `Test Files 10 passed (10)`, **87 passed / 87** |
| — split | 18 unit · **21 database-layer** (17 RLS/constraint + 4 new billing-period) · 48 integration |
| `npx tsx scripts/progress-report.ts` | `m2: 23/23`, `m3: 31/31`, `m4: 19/19`, **`m5: 21/26`**, `TOTAL: 94/134` |
| `npm run openapi` + `npx redocly lint ../api/openapi.yaml` | 134 operations written; **valid** (3 pre-existing warnings) |
| Migrations `0001`–`0012` | applied to `ia_dev` and `ia_test` |
| `tests/db/billing-period.test.ts` (new, 4 tests) | the §3 worked examples, including the clamp boundary |

**What is *not* verified, and this is the important line:** the nine new endpoints have **no
end-to-end test**. `tests/integration/billing-surface.test.ts` does not exist yet, so nothing
drives `POST /billing/previews`, `POST /billing/runs` or `INV-01..05` through HTTP. What *is*
verified is narrower: the period rules against §3's examples (db tests), the preview query and
the hash against real rows (a throwaway script, since deleted), the whole payment surface
(11 integration tests), and that every new route is inside the contract, owner-only,
permission-guarded and 401/403 as expected (`route-matrix.test.ts`, which enumerates the
handlers and walks the registry). Treat the billing surface as **unproven**, not as done.

## 3. Deviations from the spec

| Spec ref | What differs | Why | Needs spec change? (CR-###) |
|---|---|---|---|
| `BIL-02` `queueWhatsApp: true` | refused with 422 `VALIDATION_ERROR` | the message queue (`message_jobs`) arrives with M7; accepting the flag and dropping it would be a lie about what happened | no — but the contract should say what a build without a queue does |
| `BIL-02` declared `ALREADY_INVOICED` | cannot fire | a period that already has an invoice is **reported as skipped** in the run (`invoicesCreated: 0`, `invoicesSkipped: N`, status `partial`), which is what §9 describes; the same class as `SES-04`'s `REASON_REQUIRED` | yes — drop the code or declare it as the run's own report |
| `INV-04` (§10) | does **not** cancel the invoice's `queued` messages or revoke its access tokens | neither table exists: `message_jobs` is M7, `invoice_access_tokens` is M6. Writing nothing is honest; inventing the tables is not | no — it is M6/M7 work, recorded here |
| `INV-03` | refuses (422) a player who has **no group on the issue date** | the contract's `Invoice.ageGroup` is required, and §4 refuses to invoice a player with no group (`NO_GROUP`). An invoice that cannot be attributed to a group is one the owner cannot explain later | no — but the refusal deserves a line in the contract |
| `INV-03/04/05` responses | carry `items`/`allocations` (the same detail as INV-02) | they are not list responses; returning the lines the write just produced costs one query and cannot mislead | no |
| `INV-01` `ageGroupId` filter | matches `snapshot->>'ageGroupId'` | the group an invoice was billed under is in its snapshot, never in the player's current history (ADR-014) | no — but the path is unindexed |
| `PLY-10` default window (carried from M4) | registration date → today, academy-local | a history has no future | no |

## 4. Bugs this session found (all in already-"done" code)

1. **Deferred trigger trusted `NEW` instead of the committed row.**
   `app.check_payment_cache()` compared `new.allocated_minor` — the value frozen when the
   *statement* queued the event — so a transaction that inserted a payment (`allocated_minor`
   0) and then allocated 4,000 to it queued two events and the first one rejected a perfectly
   correct transaction: **every confirmed payment with an allocation answered 422.** It now
   reads the row back. `app.check_invoice_totals_self()` had the same shape and got the same
   fix. The migration's own comment already claimed "only the committed state has to be
   consistent"; now it is true.
2. **A touch trigger on a column that does not exist.** `receipts_touch_trg` ran
   `app.set_updated_at()` on `receipts`, which has no `updated_at` (DATABASE §3.3 defines it
   without one), so **every `PAY-07` reversal returned 500** on the first receipt update:
   `record "new" has no field "updated_at"`. The trigger is gone; the schema was right.
3. **A receipt that only existed if someone re-confirmed the payment.** `PAY-02` recorded a
   payment directly as `confirmed` — the owner checked the bank statement — and issued no
   receipt, because the receipt was written only in `PAY-04`. §11's rule cuts both ways, so
   the receipt now belongs to the confirmation itself: `issueReceipt()` is called by whichever
   endpoint performs it.
4. **`PAY-08` could not be called the way the contract says it is called.** `{id}` was
   declared a uuid, so the literal `new` the record-payment screen sends (the documented gap in
   the Step 5 frontend handoff) was rejected 422 before the handler could treat it as "no
   payment yet". The registry now declares a plain string for that one param, and the handler
   decides.
5. **One wrong `age()` implementation of an anchored month**, caught by writing the §3 examples
   down before trusting the SQL: `age()` reports `2026-02-28` from `2026-01-31` as *"0 mon 28
   days"*, which files 28 Feb under January's period and contradicts the rule that the next
   period starts that day. The function now finds the largest `n` with
   `anchor + n months <= date` by estimate plus one correction, and the boundary cases are
   permanent tests.

Also worth recording as a process note: one test expectation was **wrong, not the code**. It
asserted that `PAY-08` would suggest allocating 3,000.00 to an invoice from a payment whose
5,000.00 were already fully allocated — i.e. it asked the helper to invent credit that
`PAY-06` would refuse a moment later. The test now asserts nothing-to-offer for a spent
payment, and covers oldest-due-first where real credit exists.

## 5. Known gaps and risks

- **The whole billing/invoice surface is untested end to end** (§2). This is the top risk: it is
  the money-adjacent code with the least evidence behind it.
- **`0012` was edited in place three times**, so its objects were dropped and re-created in
  `ia_dev` and `ia_test` (the runner refuses a changed checksum after apply). That was
  legitimate *only* because nothing is deployed and `0012` has never left this machine: it
  keeps the migration history one coherent file instead of a schema plus a fix-up patch. The
  moment anything is deployed, this approach is off the table — add `0013`.
- **`SET-04.list/create/update`, `PLY-11`, `GDN-06` remain** (5 of M5's 26) and all three are
  blocked on owner decisions, not on code.
- **No PDFs.** `hasPdf` is always false and `pdf_stale` is set but nothing reads it; INV-06/07,
  RCT-02 and PRF-01/02 are M6.
- **Overdue invoices cannot be produced by a run yet** in a test's lifetime: §5's guard
  (`due_date = max(computed, issue_date)`) means a run always issues with today's date, so the
  `INV-01` `overdue` filter can only be exercised with a fixture row issued in the past.
- A manual invoice carries no period (`periodStart`/`periodEnd` absent) and no fee row: its
  snapshot records the group and the description, and `total = subtotal`.
- `INV-04`'s void-versus-allocation race is settled by the **database**, not by the handler: a
  payment allocated into an invoice that is being voided in another transaction fails the
  deferred `invoices_status_shape` check. The owner sees a 4xx/500-shaped refusal rather than
  the documented `INVOICE_HAS_ALLOCATIONS`; the money is safe either way.
- Still **no CI**, no performance measurement (M9 owns p95), and no daily session generator
  (unchanged from M4).

## 6. How to run / verify

```bash
cd backend
npx tsc --noEmit
npx vitest run                       # 87 tests, all three projects, against ia_test
npx tsx scripts/progress-report.ts   # expect m5: 21/26
npm run openapi                      # 134 operations; then npx redocly lint ../api/openapi.yaml
npx tsx scripts/migrate.ts           # ia_dev  (add --test for ia_test)
```

## 7. Next steps (exact)

1. **Write `tests/integration/billing-surface.test.ts`** — the missing evidence, in the order
   that finds real problems fastest: BIL-01 skips (`NO_GROUP`, `NO_FEE`, `NOT_ACTIVE`,
   `NOT_YET_REGISTERED`, `ALREADY_INVOICED`) · BIL-02 issues N invoices with sequential
   `INV-{year}-{000001}` numbers and a snapshot · a stale `previewHash` is 409 `PREVIEW_STALE`
   and **nothing is written** (re-read to prove it) · a second run with a different key reports
   `created: 0 / skipped: N` · `queueWhatsApp: true` is 422 · adjustments: negative applies,
   positive / over-fee / unknown-player are 422 with nothing written · INV-01 `overdue`,
   `ageGroupId` (snapshot) and `INVALID_SORT` · INV-02 items + allocations, with a reversed one
   still visible · INV-03 manual numbering and the no-group refusal · INV-04
   `INVOICE_HAS_ALLOCATIONS`, `releaseAllocations` returning the credit, `suppress_reissue`
   keeping a later run from recreating the period, `allowReissue` letting it · INV-05 the
   derived status when an adjustment clears the balance · a coach refused across the surface.
2. **M6** (PDFs, proofs upload, `PRF-01/02`, `INV-06/07`, `RCT-02`, `PUB-01`) once the test
   above is green — the invoice PDF is what `pdf_stale` has been waiting for.
3. **Claude:** rule on the contract items that have accumulated, most urgent first —
   `ATT-03`'s permission (a live 403 for coaches, M4) · `PAY-08`'s path (a payment id in the
   path of a guardian-keyed read) · `BIL-02`'s `queueWhatsApp` in a build with no queue ·
   `INV-03`'s no-group refusal · the two codes that cannot fire
   (`SES-04`/`BIL-02` `ALREADY_INVOICED`).
4. **Owner (Hassen):** the CR-003 approval is still owed in writing while `CAT-01..05` — part
   of what it covers — are served (M4 handoff §4, PROJECT_STATUS CR-003).

## 8. Reviewer checklist (Claude/Hassen fills)

[ ] Compared to DATABASE/API docs  [ ] Permissions verified by route matrix  [ ] No money floats
[ ] Audit rows present  [ ] Tests evidence reviewed (**billing surface has none — see §2**)
[ ] PROJECT_STATUS updated  [ ] Verdict: accepted / changes requested
