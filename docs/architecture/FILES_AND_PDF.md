# FILES_AND_PDF

> **Status:** Draft v1 (planned) · **Owner:** Claude (spec) / Freebuff (implementation) · **Updated:** 2026-10-12
> **Depends on:** [DATABASE](DATABASE.md) (`files`, `invoices`, `receipts`, `invoice_access_tokens`, `payment_proofs`), [SECURITY_AND_PRIVACY](SECURITY_AND_PRIVACY.md) · **Source of truth for:** PDF layouts, file validation, storage, secure access.

## 1. Brand assets

No logo file was available when this spec was written (no repository/uploads were provided). **Do not invent a logo.** The owner uploads the official logo via `SET-03` (PNG/JPEG/SVG ≤ 1 MB, ideally ≥ 600 px wide, transparent background). Until then PDFs and UI show the academy name as a plain text wordmark. Brand colors are likewise **TBD by the owner** (OPEN-001 in [OPEN_DECISIONS](../engineering/OPEN_DECISIONS.md)); see [DESIGN_SYSTEM](../frontend/DESIGN_SYSTEM.md) for the neutral fallback palette.

## 2. Invoice PDF specification

A4 portrait, 18 mm margins, one page for ≤ 12 line items (flows to more pages with repeated table header). Rendered **only** from `invoices`, `invoice_items`, `snapshot` ([DATABASE](DATABASE.md) §4) — never from live settings.

| Zone | Content |
|---|---|
| Header | Logo (or name wordmark), academy name, address, phone, email (from snapshot). Right: title **INVOICE**, status badge, `Invoice no.`, `Issue date`, `Due date`. |
| Bill-to | Guardian name + phone (full number, it's the guardian's own document) or "—"; **Player**: full name, registration no., age group (snapshot). |
| Period | `Billing period: 01 Nov 2026 – 30 Nov 2026` (periodic) or description (manual). |
| Items table | `#`, Description, Qty, Unit amount, Amount. Fee lines first, then adjustment lines (negative values shown with a minus and the reason in the description). |
| Totals | Subtotal · Adjustments · **Total** · Amount paid · **Balance due** (bold). |
| Payment instructions | `snapshot.academy.paymentInstructions` (bank details, "quote invoice number as reference"). |
| Footer | `Invoice INV-… · Page x of y · Generated 11 Oct 2026 14:05 (Asia/Colombo)` and "Balance shown is as at the generation time." |

**Status badge** values: `ISSUED`, `PARTIALLY PAID`, `PAID`, `VOID` (large diagonal "VOID" watermark). **Overdue is not printed** because the PDF is static and overdue changes with the calendar; the due date is shown instead.

Formatting: dates `dd MMM yyyy`; amounts `LKR 4,000.00` (always two decimals in PDFs, thousands separators, minus sign for negatives); right-aligned numeric columns; tabular figures.

**PDF regeneration triggers** (set `pdf_stale = true` in the same transaction): payment allocation/reversal affecting the invoice, adjustment, void, academy snapshot never (snapshot is frozen). Worker regenerates; the previous file object is kept 30 days.

## 3. Receipt PDF specification

Issued only for a `confirmed` payment ([BILLING_ENGINE](BILLING_ENGINE.md) §11).

| Zone | Content |
|---|---|
| Header | Same branding block; title **PAYMENT RECEIPT**; `Receipt no.` (`RCT-…`), `Date received`, `Issued on`. |
| Payment | Method label, **payment reference**, payer (guardian name or `payerName`), amount received (large). |
| Allocation table | `Invoice no.`, Player, Applied amount, Invoice balance after this payment. One row per active allocation. |
| Credit | If `unallocated > 0`: line "Unallocated credit held: LKR …". |
| Footer | "This receipt confirms payment recorded by the academy. Payment proofs are not receipts." Generated timestamp, page numbers. |

If the payment is later reversed, regeneration adds a diagonal **"VOID – PAYMENT REVERSED"** watermark and shows the reversal date; the receipt number stays reserved.

## 4. PDF generation

| Item | Decision |
|---|---|
| Engine | Server-side library-based generation (default **PDFKit**, [ADR-008](../engineering/DECISIONS.md#adr-008)): deterministic, no headless browser to patch/secure/size. |
| Fonts | Embed **Noto Sans** (Latin) plus **Noto Sans Sinhala** and **Noto Sans Tamil** with per-run font fallback so non-Latin names render. Bundle the OFL license text. |
| **Spike P1 (M6 task 1)** | Prove Sinhala and Tamil names render correctly (complex-script shaping) in the chosen library. **If shaping is wrong, switch to HTML→PDF via headless Chromium** (documented fallback in ADR-008). Record result in DECISIONS. |
| Trigger | After-commit: worker sweeps `pdf_stale = true` rows every 30 s (also immediately kicked via `LISTEN/NOTIFY` optional). On-demand: `GET …/pdf` generates synchronously (≤ 5 s budget, per-document advisory lock) if stale/missing. |
| Self-check | Generator recomputes `Σ items` and asserts equals `total_minor`, and `total − allocations` equals `balance_minor`; mismatch ⇒ throw, log `PDF_TOTAL_MISMATCH`, keep `pdf_stale = true`, **never** emit a wrong PDF. |
| Determinism | `pdf_input_hash` = SHA-256 of the canonical input JSON. Same hash ⇒ skip regeneration. Embed no random ids; creation date = `issue_date` metadata. |
| Storage key | `invoices/{yyyy}/{invoiceId}/{hash12}.pdf`; `receipts/{yyyy}/{receiptId}/{hash12}.pdf`. |
| Failure | Retry 5× (backoff 30 s → 1 h). Persistent failure ⇒ owner sees "PDF failed — Regenerate" (`INV-07`), `/system/health` lists count of stale > 10 min. Billing records are unaffected. Storage outage ⇒ `503 DEPENDENCY_UNAVAILABLE` on download only. |

## 5. Private object storage

- One **private** bucket per environment (provider candidates: Cloudflare R2, Supabase Storage, AWS S3 — pick by pricing at build time; **prices unverified**, OPEN-016). No public ACL, no public listing, no CDN caching.
- Server-side encryption at rest (confirm provider default). Backend uses a least-privilege credential limited to this bucket. Keys are random/opaque; never contain player names or original filenames.
- Lifecycle: delete superseded PDF versions after 30 days; payment proofs per retention in [DATABASE](DATABASE.md) §6.
- Backup: bucket versioning or nightly sync to a second bucket/provider ([DEPLOYMENT_AND_OPERATIONS](DEPLOYMENT_AND_OPERATIONS.md) §7).

## 6. Payment-proof upload

| Rule | Value |
|---|---|
| Who | Owner only (`PRF-01`). Coaches have no access. |
| Types (by **magic bytes**, not extension/Content-Type) | PDF (`%PDF-`), JPEG, PNG, WebP. Everything else ⇒ 415 `UNSUPPORTED_FILE_TYPE` (HEIC/HEIF unsupported in v1: UI hint "export as JPEG"). SVG/HTML/Office never accepted. |
| Verification kind (CR-004) | For a `bank_transfer` payment the **bank's PDF e-receipt** is what can be verified. A photo or screenshot is stored as `doc_kind='bank_receipt_image'` (`supporting_only`) and is **never parsed**, so it can never produce a passing check. The backend derives and stores `doc_kind` (`'bank_receipt_pdf' \| 'bank_receipt_image' \| 'other'`) on upload; the explicit re-check endpoint is `PRF-04`. Document kinds, check levels and the findings vocabulary: [PAYMENT_VERIFICATION](PAYMENT_VERIFICATION.md) ([ADR-021](../engineering/DECISIONS.md#adr-021)). |
| Size | ≤ 5 MB (413 `FILE_TOO_LARGE`, enforced at proxy **and** app, streaming). ≤ 5 proofs per payment. |
| Image handling | Decode and **re-encode** (strips EXIF/GPS and polyglot payloads); store only the re-encoded bytes. |
| PDF handling | Reject if the first bytes aren't `%PDF-`, or if tokens `/JavaScript`, `/JS`, `/Launch`, `/EmbeddedFile`, `/OpenAction` are present (best-effort screening). Stored as-is — extraction never requires **rendering** the PDF or fetching an external `/URI` reference, and the token screen is **re-run immediately before parsing** ([PAYMENT_VERIFICATION](PAYMENT_VERIFICATION.md) §6). |
| Extracted fields (CR-004) | Text-layer extraction can yield a payer name and masked account numbers ⇒ treated as **proof-class PII**: owner-only, audited reads, never written to logs, message bodies or error messages, retention unchanged ([DATABASE](DATABASE.md) §6). Findings and the parser version are stored beside the file, never as a payment state. |
| Metadata | `sha256` computed server-side; `original_name` sanitized (basename, control chars removed, ≤ 100 chars) and **never used in storage keys or headers unescaped**. Duplicate sha256 on the same payment ⇒ 409. |
| Malware scan | Not in v1 (owner-only uploads, restricted viewing). Revisit with ClamAV if guardians ever upload directly [OPEN-015]. |
| Status effect | None. A proof never confirms a payment, and **no verification result changes a status, allocates money or produces a receipt** — `pending → confirmed` stays an owner action (`PAY-04`) whatever the checks say ([BILLING_ENGINE](BILLING_ENGINE.md) §11, [ADR-021](../engineering/DECISIONS.md#adr-021)). |

## 7. Secure access

| Asset | Who | How |
|---|---|---|
| Payment proof | Owner | `PRF-02` returns a **short-lived URL ≤ 5 min** with `Content-Disposition: attachment`, or the backend streams it. This build has no bucket, so the URL is the API's own download path carrying an `exp`+`sig` HMAC pair (keyed from a subkey of `CSRF_SECRET`) and the bytes are streamed through the backend. Issuance is audited, and so is the read when the bytes are served. |
| Academy logo | Anyone | `PUB-02` (`/api/v1/public/academy/logo`): the academy's **own** logo, unauthenticated and taking **no parameter**, so it cannot address anything else in private storage. `404` until the owner uploads one via `SET-03`, then `Cache-Control: public, max-age=300`; an SVG is served with `Content-Security-Policy: default-src 'none'; sandbox`. `SET-03`'s `logoUrl` and `Me.academy.logoUrl` name this route, because a local-directory store cannot mint the bucket URL this section originally assumed (OPEN-016). |
| Invoice/receipt PDF (owner) | Owner | `INV-06`/`RCT-02` stream via backend (audited read). |
| Invoice PDF (guardian) | Link holder | `PUB-01`: `https://api…/api/v1/public/invoices/{token}/pdf`. Token = 32 random bytes (base64url); DB holds SHA-256 only; TTL `invoice_link_ttl_days` (default 30); **revoked** on void; per-IP rate limit; every failure returns the same 404; response `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, `Content-Disposition: inline; filename="INV-….pdf"`. Streams through the backend (not a storage URL) so revocation is instant. |
| Receipts | Owner only in v1 (guardians see none; owner may forward manually). |

**Capability-URL risk (accepted, documented):** anyone with the link can read that one invoice (player name, guardian name, amount). Mitigations: unguessable token, expiry, revocation, rate limiting, no other PII beyond the invoice. A guardian forwarding the link is outside our control. Never include proofs, phone numbers of others, or other children in that PDF.

## 8. Failure and edge cases

| Case | Behaviour |
|---|---|
| Upload interrupted | Nothing stored; object written to a temp key then renamed after DB commit; orphan sweeper deletes temp objects > 24 h. |
| DB commit fails after object write | Orphan object removed by the sweeper (row-less keys). |
| Object missing but row exists | `INV-06`/`PRF-02` ⇒ 404 + `/system/health` flag; regenerate for PDFs; proofs: owner re-uploads. |
| Concurrent regeneration | Per-document advisory lock; second caller reuses the result. |
| Logo changed | Old invoices keep their snapshot's `logoFileId`; the old logo file is never deleted while referenced. |
| PDF has no text layer (a scan) | `NO_TEXT_LAYER`: extraction cannot run, so the receipt is **not** verified — it stays `supporting_only`, the payment stays **Pending verification** for the owner, and the academy asks for a text-based export from the bank app. Never invent a result from an image ([OPEN-024](../engineering/OPEN_DECISIONS.md)). |
