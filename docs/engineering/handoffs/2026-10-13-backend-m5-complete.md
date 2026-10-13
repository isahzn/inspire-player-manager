# HANDOFF 2026-10-13 — backend M5 complete (26/26) + M8 started (DSH-02)

Author: Freebuff (backend lead)  Milestone: **M5 done; M8 in progress**  Branch/PR: none — work sits uncommitted

## 1. Scope delivered

- **M5 is 26/26.** This session closed the last five endpoints — `SET-04.list/create/update`
  (payment methods), `PLY-11` (player balance), `GDN-06` (guardian balance) — and wrote the
  end-to-end evidence the previous half owed.
- **M8 is 1/6.** `DSH-02` (the coach dashboard) is served.
- **Project total 100/134.** `npx tsx scripts/progress-report.ts` → `m2 23/23 · m3 31/31 ·
  m4 19/19 · m5 26/26 · m8 1/6`.
- **New tests (20):** `billing-surface.test.ts` (16), `settings-balance-surface.test.ts` (3),
  `dashboard-surface.test.ts` (1). Full suite **107 passed / 107**.

### Task 1 — the billing/invoice evidence

`tests/integration/billing-surface.test.ts` drives BIL-01/02/03 and INV-01..05 through the real
app on `ia_test`. It proves, rather than asserts-by-status: preview stores nothing (counts
re-read); a stale preview writes no invoice and no run; a second run reports
`invoicesCreated: 0 / invoicesSkipped: N` as `partial`; the same `Idempotency-Key` replays; a
negative adjustment makes its own line and marks the PDF stale; positive / over-fee /
duplicate-per-player / unknown-player adjustments and `queueWhatsApp: true` are 422 with
nothing written; an anchored month clamps (31 Jan → 28 Feb → 30 Mar) and arrears bills the
period that just ended; `overdue`, the snapshot `ageGroupId` and `INVALID_SORT`; a reversed
allocation stays visible with the invoice back to `issued`; INV-04 release/suppress/allow and
the double-void/stale-version refusals; INV-05 clearing the balance to `paid`; and a coach
refused across the whole surface.

## 2. Evidence

| Check | Result |
|---|---|
| `npx tsc --noEmit` | **exit 0** |
| `npx vitest run` | **exit 0** — `Test Files 13 passed`, **107 passed / 107** |
| `npx tsx scripts/progress-report.ts` | **`TOTAL: 100/134`** |
| `npm run openapi` + `npx redocly lint ../api/openapi.yaml` | 134 operations, **valid** (3 pre-existing warnings) |
| `node tools/check-links.mjs` | 386 links / 53 files, 0 broken |
| `node tools/check-stale-refs.mts` | OK |

**Not verified:** the new endpoints have no concurrency stress test (T1–T10 remain
single-threaded), M8's DSH-02 has no owner-side financial assertion (it has none by design),
and nothing here is measured for latency.

## 3. Deviations from the spec

| Spec ref | What differs | Why | Needs spec change? |
|---|---|---|---|
| `BIL-02` run `status`/`invoicesSkipped` | A run reports the **preview's** skips too, and is `partial` whenever anything was skipped | BILLING_ENGINE §9 says a re-run reports `skipped: ALREADY_INVOICED`; the old code counted only insert-time conflicts and called `0 created / 0 skipped` `issued`. Fixed in `billing-engine.ts`. | no — but §9's wording is now load-bearing |
| `BIL-02` `status` on an all-skipped run | `partial`, not `failed` | The frontend mock (`frontend/src/mocks/billing.ts:914`) says `failed` when `invoicesCreated === 0`. A correct skip is not a failure. **Contract drift — see §4.** | yes |
| `PLY-11` `creditMinor` | Credit of the player's linked guardians, summed | The contract does not define credit attribution to a *player* (credit is a guardian concept, §11). Reported separately, never netted (T-RPT-02). | yes — define player-level credit |
| `GDN-06` totals | Span the guardian's **players**, not only invoices billed to them | "A guardian's balance across their players"; matches the frontend mock and the family model. | no |
| `SET-04.create` duplicate `code` | 422 `VALIDATION_ERROR` | The contract lists no code for a duplicate; `mapPgError` maps the unique violation. | yes — name a code |
| `SET-04` `sortOrder` | Accepted on write, **absent** from the response | `PaymentMethod` (API_CONTRACTS §2) has no `sortOrder` field. | yes — the field is written but unreadable |
| `PLY-09` | Now returns the player's real invoices | It was a stub returning an empty page ("until M5"). M5 exists, so the stub was a lie. | no |
| M8 scope | Only `DSH-02` served | See §5. | no |

## 4. Contract drift / requests

| Endpoint | What differs | Needed |
|---|---|---|
| `BIL-02` | A period that is already invoiced is reported as a **skip**, so the declared `ALREADY_INVOICED` error cannot fire; and a zero-created run is `partial` where the frontend mock says `failed`. | Decide the run's status semantics (drop the code, and align `failed`/`partial`). |
| `PLY-11` | `creditMinor` attribution undefined for a player. | Define it (guardian-sum is shipped). |
| `SET-04.create` | Duplicate `code` has no named error. | Name one. |
| `SET-04.update` | `sortOrder` in the body but not in `PaymentMethod`. | Add `sortOrder` to the response or drop it from the request. |
| `AUD-01` | `AuditEntry.entityId` is required, but `audit_logs.entity_id` is nullable (settings, payment-method, billing-preview rows carry none). | Make `entityId` optional, or define a sentinel. |
| `PRF-02` (M6) | Returns `{url, expiresAt}`, but the local-directory adapter cannot mint a pre-signed URL. | A bucket (OPEN-016) or a contract that allows the backend to stream. |
| `SES-04`, `INV-03`, `ATT-03`, `PAY-08`, `PLY-01`/`SCH-01`, `PLY-10` | Carried unchanged from the M4/M5 handoffs. | Claude to rule. |

## 5. Why M6/M7/M8 are not finished

- **M6 (8 endpoints):** the entry condition is **spike P1** (does the chosen PDF library shape
  Sinhala/Tamil correctly?). It was not run. Independently, **PRF-02** has no storage-URL story
  in this build (§4), and **PUB-01** needs a new migration for `invoice_access_tokens`.
- **M7 (21 endpoints):** entry condition **spike S1** — deploy OpenWA and record O18–O22 from
  real logs. That needs a dedicated number and a VPS from the owner. Building the adapter first
  would invent the five facts the spike exists to replace.
- **M8 (5 of 6):** `DSH-01`'s `messaging` block reads `message_jobs` (M7) and `coachTime` is
  CR-003; `AUD-01` is blocked on the `entityId` contract item; `SYS-03`'s `scheduler`/`lastBackup`
  have no data source until M7/M10; `RPT-01/02` should be ported from the verified frontend mock
  (`frontend/src/mocks/reports.ts`) once that is ratified as the contract source.

## 6. How to run / verify

```bash
cd backend
npx tsc --noEmit
npx vitest run                       # 107 tests, all three projects, against ia_test
npx tsx scripts/progress-report.ts   # expect m5: 26/26, m8: 1/6, TOTAL 100/134
npm run openapi && npx redocly lint ../api/openapi.yaml
# from the project root
node tools/check-links.mjs && node tools/check-stale-refs.mts
```

## 7. Reviewer checklist

[ ] Compared to DATABASE/API docs  [ ] Permissions verified by route matrix  [ ] No money floats
[ ] Audit rows present  [ ] Tests evidence reviewed  [ ] PROJECT_STATUS updated
[ ] Verdict: accepted / changes requested
