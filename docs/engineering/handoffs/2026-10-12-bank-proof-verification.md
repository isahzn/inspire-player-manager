# HANDOFF 2026-10-12 — Bank-transfer proof verification (CR-004): verify the bank's PDF e-receipt

Author: Buffy (frontend lead) · Milestone: M1 (plan change, accepted) · Change record: **CR-004** · ADR: [ADR-021](../DECISIONS.md#adr-021) (Accepted) · **Resolves:** [OPEN-022](../OPEN_DECISIONS.md)
Branch/PR: none — **this project has no tracked files** (`git ls-files .` → 0; the whole folder is untracked in the workspace repo) · Plan: [FRONTEND_PLAN.md](../../../FRONTEND_PLAN.md) §10

## 1. Scope delivered

**Docs only. No code was written.** The owner asked (2026-10-12, verbatim): *"always ask for a PDF … you can check the time it was transferred … the number … find out a way to verify that it's all been synced properly."* That instruction closed [OPEN-022](../OPEN_DECISIONS.md) (may the system read the uploaded proof?) with a **yes — read the PDF**, so this change specifies the whole verification subsystem rather than leaving it to implementation.

**New source of truth:** [`docs/architecture/PAYMENT_VERIFICATION.md`](../../architecture/PAYMENT_VERIFICATION.md) — document kinds, the extracted fields, the L1/L2/L3 levels, the findings model, the UI labels, untrusted-PDF handling, and the limits.

| Doc | What changed |
|---|---|
| **`PAYMENT_VERIFICATION.md`** (new) | The full analysis: why a PDF is required, the fields read from a receipt, L1 integrity / L2 cross-check / L3 statement reconciliation, finding codes, labels, sandbox rules, limits, and OPEN-023/024/025 |
| `API_CONTRACTS.md` | `ProofMeta` gains `docKind` + `verification`; new `ProofFinding`/`ProofExtract`/`ProofVerification`; `Payment.proofVerification` rollup; `PRF-01` PDF-first note; **new `PRF-04`** (verify a proof); `SET-08.proofCheck` semantics sharpened (auto-check on upload; manual re-check always allowed) |
| `DATABASE.md` | `payment_proofs` gains `doc_kind`, `verification jsonb`, `checked_at`; only `bank_receipt_pdf` can reach a checked status; extracted values are proof-class PII |
| `FILES_AND_PDF.md` §6/§8 | PDF-first verification row, `doc_kind` derivation on upload, active-content token screen re-run **before parsing**, extracted fields as PII, and the "no text layer ⇒ ask for a text export" edge case |
| `BILLING_ENGINE.md` §11 | State diagram label corrected ("owner-checked", not "verified"); no verification result changes status, allocates or creates a receipt |
| `PAGE_SPECIFICATIONS.md` §8 | Verification queue + **per-proof verification panel**, findings chips, PDF-first prompt with the exact wording, label discipline, and the "checks are advice, not proof" line |
| `TESTING_AND_ACCEPTANCE.md` | New **§2.10** with **T-VER-01..06**; REQ-06 traceability; release-gate item 2 |
| `MOCK_DATA.md` | **One** check vocabulary now: a PRF-04 example with findings (`pass`/`warn`/`fail`), the image case, and PAY-02 refreshed to the rollup |
| `IMPLEMENTATION_PLAN.md` | M5 (parser, sandbox, stored findings, PDF-first, panel) + M6 (parsing hardening) with T-VER-01..06 / T-VER-03 in the exit evidence |
| `DECISIONS.md` | **ADR-021** (+ index row); ADR-020's "OPEN-022 is not decided here" line left intact as history — the register ([OPEN_DECISIONS](../OPEN_DECISIONS.md)) carries the resolution |
| `OPEN_DECISIONS.md` | OPEN-022 **resolved** (moved to the Resolved table with the owner's words); **OPEN-023** (bank + statement export), **OPEN-024** (scanned PDFs / OCR), **OPEN-025** (automated "send the PDF" request) added with safe defaults |
| `README.md`, `PROJECT_STATUS.md`, `FRONTEND_PLAN.md` | Doc map, status, CR-004 record, and the resume path |

## 2. Evidence

- **Nothing to test: this is a specification change with no code.** Every item is *Planned* on the evidence ladder ([CONTINUATION_GUIDE](../CONTINUATION_GUIDE.md) §3). The acceptance rows exist (T-VER-01..06) and none can pass yet.
- Consistency checks run after all edits (2026-10-12): **278 relative links across 36 files — 0 broken**; `node tools/check-stale-refs.mts` exits **0**; every new ID (`ADR-021`, `CR-004`, `PRF-04`, `T-VER-01..06`, `OPEN-023/024/025`, `doc_kind` values, all finding codes) is defined once and referenced consistently.
- The frontend was **not touched** by this change, so its last verified evidence still stands: `typecheck` + `lint` + `build` green and `verify:e2e` **12/12 PASS** (2026-10-12, after CR-002).
- One deliberate reconciliation: `MOCK_DATA.md` briefly held **two** check vocabularies (the CR-003 `checks[]` codes and the CR-004 `findings[]` codes). The old array was removed and PAY-02 now carries only the `proofVerification` rollup, so the normative mock file has one vocabulary.

## 3. Deviations from the spec

| Spec ref | What differs | Why | Needs spec change? (CR-###) |
|---|---|---|---|
| — | none. Nothing in this change alters a payment state, a money rule, or an existing endpoint's meaning. | | |

## 4. Contract drift / requests

- **New contract surface for Freebuff:** `PRF-04`, `payment_proofs.doc_kind`/`verification`/`checked_at`, the `ProofFinding`/`ProofExtract`/`ProofVerification` types, `Payment.proofVerification`, and the `SET-08.proofCheck` semantics. It must appear in `api/openapi.yaml` when M1 produces it.
- **Deliberate non-assumptions (facts only the owner knows):**
  - **OPEN-023** — which bank(s), and can the academy export a statement the system can read? Until answered, verification stops at level 2 and the docs say so instead of implying the money was confirmed to have arrived.
  - **OPEN-024** — scanned/image-only receipts: keep asking for a text export (default) or add OCR later. No OCR, no vision model, no LLM in the accepted design.
  - **OPEN-025** — automating the guardian-facing "please send the PDF" message needs a `message_jobs` relationship to a **payment** (not an invoice) plus a template and switch; v1 keeps it an owner-side copy/`wa.me` action using the existing manual-fallback path.
- **Bounded by design:** verification is advisory — no worker may call `PAY-04`, and no screen may render a checked payment as paid/verified ([ADR-013](../DECISIONS.md#adr-013), [ADR-020](../DECISIONS.md#adr-020), [ADR-021](../DECISIONS.md#adr-021)).

## 5. Known gaps and risks

- **Nothing is built.** No parser, no sandbox, no endpoint, no UI. Every claim here is a plan.
- **No version control on this project** (`git ls-files .` → 0 files): these changes cannot be diffed, reviewed or reverted. Commit the project (with `node_modules/`, `.next/`, `.verify/*.png` ignored) before further work.
- **A PDF can be forged.** L2 catches careless edits, duplicates and receipt reuse; it is not forensic. Only L3 (statement reconciliation) proves money arrived, and L3 trusts the statement the owner imports. Stated in the spec **and** required in the UI.
- **Parser maintenance is permanent work:** layouts are per bank, which is why `parserVersion` is stored with every result. Expect breakage when a bank redesigns its receipt.
- **New attack surface:** third-party documents are now machine-read. Sandboxing, no rendering, no network and the active-content screen are specified; malware scanning ([OPEN-015](../OPEN_DECISIONS.md)) moves up the priority list but is still not in v1.
- **Not verified against a real receipt.** No sample receipt from any Sri Lankan bank has been seen, so the field names in §3 are the expected ones, not observed ones (hence OPEN-023).

## 6. How to run / verify

No code to run. **`git diff` will not help — the project is untracked.** To check consistency:

```bash
cd "Projects/inspire-academy-player manager"
grep -rn "PRF-04\|doc_kind\|T-VER-0" docs        # new surface, referenced consistently
grep -rn "OPEN-022" docs                          # only historical mentions remain (ADR-020 body, resolved row)
node tools/check-stale-refs.mts                   # provider lint — exits 0
```
Relative-link check (2026-10-12): 278 links / 36 files, **0 broken**.

## 7. Next steps (exact)

1. **Owner (Hassen):** answer **OPEN-023**, **OPEN-024**, **OPEN-025**; confirm **CR-003**.
2. **Freebuff (M1/M5/M6):** add the CR-004 surface to `api/openapi.yaml`; then the sandboxed parser, `PRF-04`, and the findings pipeline.
3. **Frontend (Step 5):** the verification panel, the PDF-first prompt, the label discipline.
4. **Before any of it:** put the project under version control.

## 8. Reviewer checklist (Claude/Hassen fills)

[ ] Compared to DATABASE/API docs  [ ] Permissions verified by route matrix  [ ] No money floats
[ ] Audit rows present  [ ] Tests evidence reviewed  [ ] PROJECT_STATUS updated  [ ] Verdict: accepted / changes requested
