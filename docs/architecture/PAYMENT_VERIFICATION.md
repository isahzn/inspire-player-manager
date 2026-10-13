# PAYMENT_VERIFICATION

> **Status:** Draft v1 (planned) · **Owner:** Claude (spec) / Freebuff (implementation) · **Updated:** 2026-10-12
> **Depends on:** [BILLING_ENGINE](BILLING_ENGINE.md) §11 (payment lifecycle) · [FILES_AND_PDF](FILES_AND_PDF.md) §6 (proof upload) · [DATABASE](DATABASE.md) §3.3/§3.6 · [API_CONTRACTS](API_CONTRACTS.md) §3.6 · [SECURITY_AND_PRIVACY](SECURITY_AND_PRIVACY.md)
> **Source of truth for:** what a bank-transfer proof must be, what is extracted from it, how it is cross-checked, what the findings mean, and the limits of that verification.
> **Change record:** CR-004 · **ADR:** [ADR-021](../engineering/DECISIONS.md#adr-021) · **Resolves:** OPEN-022

## 1. The rule that never moves

A proof is **evidence, not payment** ([ADR-013](../engineering/DECISIONS.md#adr-013)). Verification here means: *the system reads the bank receipt, extracts its facts, cross-checks them against what was recorded, and reports findings.* It **never** confirms a payment, never allocates, never changes a balance, and never generates a receipt. Only an owner confirms (`PAY-04`), and that remains true with every automation switched on ([ADR-020](../engineering/DECISIONS.md#adr-020)).

Verification exists to remove mechanical work and to catch the common failure modes — wrong amount, wrong invoice quoted, a used receipt sent twice, "I paid" with nothing attached, a slip that isn't from our bank — not to replace the owner's judgement.

## 2. Document kinds, and why a PDF is required

| `doc_kind` | What it is | Verification value |
|---|---|---|
| `bank_receipt_pdf` | The bank's own e-receipt exported from online banking / the bank app. Has a **text layer**. | **Preferred and required for checks.** Only this kind can be parsed and cross-checked. |
| `bank_receipt_image` | A photo or a screenshot of a slip or of a phone screen. | **Supporting evidence only.** Never parsed, never drives a check. A screenshot is trivially edited and has no text layer, so a "pass" on it would be a lie. |
| `other` | Anything else (authorization letter, handwritten slip). | Supporting only. |

**Policy (owner instruction 2026-10-12):** for a bank transfer the academy **asks for the PDF**, and when a non-PDF arrives the system says so in plain words — *"A photo can't be verified — please send the PDF receipt from your bank app."* The image is still kept (it is evidence, and refusing it loses information), but it is marked `supporting_only` and can never produce a passing check. When only an image exists, the payment still reads **Pending verification** and the owner confirms by eye as they do today.

## 3. What is extracted from a receipt PDF ("the bill")

| Field | Typical source | Used for |
|---|---|---|
| `bankName` | header/footer | parser selection, reported to the owner |
| `documentType` | title ("Transaction Receipt", "Fund Transfer Confirmation") | is this a receipt at all |
| `reference` / `receiptNo` | "Reference", "Transaction ID", "Receipt No" | matching against the recorded `reference`; duplicate detection |
| `transactionAt` | date + time of transfer | date tolerance check; the owner's "when was it transferred" |
| `amountMinor` + `currency` | amount | exact amount match |
| `payerName`, `payerAccountMasked` | "From" | soft match against the guardian |
| `beneficiaryName`, `beneficiaryAccountMasked` | "To" | **must match an academy account** (from `payment_instructions`) |
| `channel`, `status` | CEFT / SLIPS / internal / "Successful" | report; a non-success status is a failure finding |
| `remarks` / `purpose` | free text (often the invoice number) | invoice cross-check |

Extraction is **text-layer based**: the PDF's own text is read with a deterministic parser per bank layout ([OPEN-023](#8-limits-and-open-questions) covers layout coverage). No rendering, no OCR in v1.

## 4. Verification levels

### L1 — document integrity (can this be checked at all?)
- `%PDF-` magic bytes; ≤ 5 MB; page count and object count within limits; **not encrypted**.
- Text layer present. Empty text layer (a scan) ⇒ `NO_TEXT_LAYER` → *not verifiable*, ask for a text-based export.
- Active content rejected outright: `/JavaScript`, `/JS`, `/Launch`, `/EmbeddedFile`, `/OpenAction`, external `/URI` references (we never fetch them).
- Metadata sanity (producer, creation date, incremental updates) — **reported, never trusted**: a clean producer is not proof of authenticity.
- A valid digital signature is reported when present. Most Sri Lankan bank e-receipts are unsigned — **absence is not a failure**, and we never claim a signature we did not verify.

### L2 — does the receipt match what we recorded? (deterministic)
| Check | Rule | Result on mismatch |
|---|---|---|
| `AMOUNT_MATCH` | receipt amount == recorded `amountMinor` exactly (integer minor units) | `fail` |
| `REFERENCE_MATCH` | receipt reference == recorded `reference`, or the invoice number appears in `remarks` | `warn` (owner decides; references are often edited by the payer) |
| `BENEFICIARY_MATCH` | receipt beneficiary account/name matches one of the academy's accounts in `payment_instructions` | **`fail`** — money went somewhere else |
| `DATE_TOLERANCE` | `transactionAt` within the configured tolerance of `received_at` (default: same calendar day in academy time, ±1 day) | `warn` |
| `PAYER_SOFT_MATCH` | payer name similar to the guardian's name | `warn` only — siblings, spouses and third parties pay legitimately |
| `STATUS_SUCCESSFUL` | receipt status says completed/successful | `fail` if explicitly failed/pending |
| `RECEIPT_NOT_REUSED` | this `reference`/`receiptNo` is not already attached to **another** payment; identical file `sha256` not already stored elsewhere | **`fail`** — the most common real-world abuse |
| `INVOICE_MATCH` | the invoice being paid appears in `remarks`, or the amount matches its balance | `warn` |

### L3 — did the money actually arrive? (reconciliation, recommended)
The only check that answers that question. The owner exports a **statement** (CSV/PDF) from the academy's own online banking for a period and imports it; the system matches each credit line to a recorded bank-transfer payment (date ±1 day, exact amount, reference contained in the narration) and states:

`STATEMENT_MATCHED` · `STATEMENT_MISSING` (recorded, never seen in the bank) · `STATEMENT_AMOUNT_MISMATCH` · `STATEMENT_DUPLICATE` (one credit claimed by two payments).

L3 is what catches a **genuine receipt reused for a second payment** and a slip whose amount was edited after download. It depends on the academy's bank being able to export a statement in a readable format — a factual question for the owner, tracked as **OPEN-023**. Until it exists, L2 is the ceiling and §8 says so plainly.

### L4 — bank API
Not planned. No bank-integration capability is assumed. If it ever exists, it replaces L3's manual export, nothing else.

## 5. Findings, labels and what the UI may say

Each proof carries `findings[]`: `{ code, level: 1|2|3, result: 'pass'|'warn'|'fail'|'unknown', detail, meta? }` with the stable codes above plus `NO_TEXT_LAYER`, `DOC_TYPE_UNSUPPORTED`, `PARSE_FAILED`, `SUPPORTING_ONLY`.

Payment-level label (derived, never stored as truth):

| Condition | Label |
|---|---|
| all L2 checks pass | **Ready to confirm — checks passed** (still `pending`) |
| any `fail` | **Check failed: `<plain reason>`** |
| only images attached | **Not verifiable — ask for the PDF** |
| no proof attached | **No proof attached** |

**Forbidden:** "verified", "paid", "confirmed", a green tick standing where money is concerned. The amount always reads **Pending verification** until an owner confirms. A passing check is advice, not a state change.

## 6. Untrusted-document handling (security)

Every uploaded proof is treated as hostile input, because it is produced by someone outside the academy:

- Parsing runs in a **sandboxed worker** with a CPU/memory/time limit, read-only, no network, no shell, no temp-file execution. A parser crash must fail one proof, never the process or the request.
- No server-side rendering of the uploaded PDF for verification, no external resource fetching, no executing attachments. Active-content tokens are rejected at upload ([FILES_AND_PDF](FILES_AND_PDF.md) §6) and re-checked before parsing.
- The original file is never modified; extraction results are stored beside it.
- Extracted values can contain personal data (payer name, masked account) ⇒ **same access class as the proof itself**: owner-only, audited reads, excluded from logs, message bodies and error messages, retention per [DATABASE](DATABASE.md) §6.
- Malware scanning becomes materially more worthwhile now that third-party documents are parsed. Still owner-mediated upload in v1 → **[OPEN-015](../engineering/OPEN_DECISIONS.md) priority raised**, with ClamAV as the candidate.
- A faked or malformed PDF must never be able to mark a payment, corrupt a parse job, or leak another academy's data (single academy, but the rule stands).

## 7. Getting the PDF from the guardian

Owner-side, no new automation surface: the payment/proof row offers **"Ask for the PDF"**, which produces a ready-to-send message ("Please send the bank transfer receipt as a PDF from your bank app — a photo can't be verified") with the existing **copy + `wa.me`** helper ([PAGE_SPECIFICATIONS](../frontend/PAGE_SPECIFICATIONS.md) §9). This uses the manual-fallback path the project already has, so no new consent surface, no new queue relationship, and nothing can be sent to a guardian who has not consented.

An **automated** guardian-facing `proof_request` message is a bigger change (a new `message_jobs` relationship — a payment, not an invoice — plus a template, a switch and consent rules) and is therefore **not** in v1: see **OPEN-025**.

## 8. Limits, and open questions

**What this design cannot do — say it in the UI when it matters:**
- A text PDF can be edited or forged. L2 catches careless edits, duplicates and reuse; it is not forensic document examination.
- L3 trusts the statement the owner imports.
- "Successful" on a receipt does not mean the money is still in the account — a transfer can be reversed later. Only the statement shows reality.
- Nothing here proves the payer is the guardian. Third parties paying on a family's behalf are normal, so `PAYER_SOFT_MATCH` is a warning at most.
- A verified-looking payment is still **unconfirmed** until a human says so.

| Open | Question | Safe default |
|---|---|---|
| [OPEN-023](../engineering/OPEN_DECISIONS.md) | Which bank(s), and can the academy export a statement the system can read (CSV/PDF)? Which receipt layouts must the parser cover? | L2 only; L3 built when a real statement export is supplied |
| [OPEN-024](../engineering/OPEN_DECISIONS.md) | Scanned/image-only receipt PDFs (no text layer): keep asking for a text export, or add OCR later? | Keep asking for the PDF export; no OCR |
| [OPEN-025](../engineering/OPEN_DECISIONS.md) | Automate the guardian-facing "send the PDF" request (new message kind), or keep it an owner-side copy/`wa.me` action? | Owner-side action (v1) |

## 9. Tests

`T-VER-01..06` in [TESTING_AND_ACCEPTANCE](../engineering/TESTING_AND_ACCEPTANCE.md) §2.10: PDF-only policy, L2 check matrix (including reused receipt and amount edit), forged/active-content PDF rejected, sandboxed parser failure contained, no automation can confirm a payment, and the label discipline (a passing check never renders as paid).
