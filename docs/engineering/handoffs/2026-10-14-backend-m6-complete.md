# Backend M6 complete — documents, uploads and the guardian's link (9/9)

> **Date:** 2026-10-14 · **Author:** Freebuff (backend) · **Milestone:** M6 — Files, PDFs, proofs
> and the public invoice link · **Status:** complete, suite green
> **Start here if you are the next session.** M5-complete handoff:
> [2026-10-13-backend-m5-complete](2026-10-13-backend-m5-complete.md).

## 1. Result

**M6 is 9/9 endpoints served. Overall `TOTAL: 109/135`.** The backend suite is **147 passed / 147**
(was 124), `tsc` clean, OpenAPI valid (3 pre-existing warnings), both documentation scripts pass.

The four endpoints the M5 handoff left open — `SET-03`, `PRF-01`, `PRF-02`, `PUB-01` — are
served, and the milestone gained a **fifth contract entry, `PUB-02`**, for the reason in §4.

What is genuinely new in this milestone is that the API now stores and serves **files**, and the
two of those routes answer with **no session at all**. That is where the design work went: every
rule below exists because a caller could otherwise reach a document they have no right to.

| Endpoint | What it does now |
|---|---|
| `SET-03` | Stores the logo (PNG/JPEG/SVG ≤ 1 MB, sniffed by magic bytes), points `academy_settings.logo_file_id` at it, audits `settings.logo.upload`, returns `{logoUrl}`. The superseded logo file is **never deleted** — issued invoices name it in their snapshot. |
| `PUB-02` (new) | The anonymous read that makes `logoUrl` a *public* URL without a bucket: the academy's own logo, no parameter, 5-minute cache. |
| `PRF-01` | Uploads a proof (PDF/JPEG/PNG/WebP ≤ 5 MB, ≤ 5 per payment): type by magic bytes, JPEG/PNG/WebP rewritten to strip EXIF/GPS/trailing payloads, PDF screened for active content **before** it is stored, `doc_kind` derived from the sniffed type + the payment's method, duplicate bytes on the same payment refused, `note` validated, `settings.logo.upload`-style audit row. Nothing about the payment moves. |
| `PRF-02` | Returns `{url, expiresAt}` — the contract's own shape — where the URL is the same route with an `exp`+`sig` HMAC pair valid for **at most 5 minutes**; following it streams the bytes with `no-store` and audits the read. |
| `PUB-01` | Serves an invoice PDF to a capability token: SHA-256 match, expiry, revocation, non-void invoice and an existing object resolved in **one** `SECURITY DEFINER` statement; every failure is the same 404; 30 requests a minute per IP. |

## 2. Evidence (2026-10-14, after the last edit to source)

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean, exit 0 |
| `npx vitest run` | exit **0** — **147 passed / 147** (17 files: 43 unit, 21 db-layer, 83 integration) |
| `npx tsx scripts/progress-report.ts` | `m2 23/23 · m3 31/31 · m4 19/19 · m5 26/26 · m6 9/9 · m8 1/6`, **`TOTAL: 109/135`** |
| `npm run openapi` + `npx redocly lint ../api/openapi.yaml` | **valid** (3 pre-existing warnings) |
| `node tools/check-links.mjs` | 387 links / 54 files, 0 broken |
| `node tools/check-stale-refs.mts` | OK, 34 intentional mentions |

New coverage, and what it actually proves:

- `tests/integration/files-surface.test.ts` (11 tests) drives the real app. It is deliberately not
  a status-code suite: "the logo is stored" reads the **bytes at rest** back out of the storage key
  the `files` row names; "the metadata is gone" asserts the uploaded EXIF payload is absent from
  what was stored; "a proof never changes a payment" re-reads the payment, its allocations and the
  receipt list; "every bad link is the same 404" compares the error **bodies** (minus `requestId`);
  and the logo is asserted to reach the invoice PDF as an embedded `/Subtype /Image` object of the
  logo's own size.
- `tests/unit/file-uploads.test.ts` (13 tests) covers magic-byte sniffing, name sanitising, the
  three container strippers (including the malformed-input refusals) and the signature helper,
  including that the expiry cannot be extended by editing it.

## 3. Files

**New source**

- `src/files/upload.ts` — the multipart reader: one ordered pass over `req.parts()` (so a `note`
  sent after the file is not lost), magic-byte typing, name sanitising, per-endpoint size rules.
- `src/files/image-metadata.ts` — JPEG/PNG/WebP container rewriting. No new dependency: the
  metadata lives in self-describing segments (`APPn`/`COM`, `tEXt`/`eXIf`, `EXIF`/`XMP `), so
  stripping it leaves the compressed pixels untouched — which is the outcome that matters for
  evidence. A container that cannot be parsed returns `null` and the upload is refused.
- `src/files/signed-url.ts` — HMAC-signed, 5-minute access credentials, keyed by a **subkey derived
  from `CSRF_SECRET`** (`HMAC(secret, "ia.file-url.v1")`) so a file URL can never be replayed as a
  CSRF token or vice versa.
- `src/routes/public.ts` — `PUB-01` and `PUB-02`.
- `migrations/0014_public_readers.sql` — `app.public_invoice_document(token_hash)` and
  `app.public_logo()`, replacing 0013's `app.consume_invoice_token`.
- `tests/integration/files-surface.test.ts`, `tests/unit/file-uploads.test.ts`.

**Modified**

- `src/routes/proofs.ts` — `PRF-01`, `PRF-02` beside the existing `PRF-03/04`.
- `src/routes/settings.ts` — `SET-03`.
- `src/routes/money-serialize.ts` — `serializeProof.fileId` is now the **proof's** id (see §4.2).
- `src/routes/serialize.ts` — `Me.academy.logoUrl` (the comment saying it was absent until M6 now
  does something).
- `src/routes/academy-brand.ts` — `academyLogoUrl()`, derived from `API_BASE_URL` (never from the
  request `Host`, which the caller controls).
- `src/routes/index.ts` — five registrations.
- `src/http/router.ts` — per-route rate limits from the contract's `rateLimit` label
  (`login` 10/min, `public_invoice` 30/min, `exports` 10/h; the global 300/min otherwise).
- `src/http/plugins.ts` — the multipart streaming backstop raised to 5 MB (the largest endpoint
  limit) with each endpoint still enforcing its own smaller one.
- `src/files/receipt-parser.ts` — exported `screenActiveContent`, so the upload screen and the
  pre-parse screen cannot disagree about which tokens are dangerous.
- `spec/sections/02-settings.ts` — the `PUB-02` entry.
- `api/openapi.yaml`, `api/openapi.json` (regenerated).

## 4. Decisions worth reading before changing this code

1. **`PUB-02` was added to the contract, and it should be blessed or renamed by Claude.** `SET-03`
   promises a `logoUrl` that is "public through `/auth/me` and PDFs". With no bucket (OPEN-016) and
   no public origin, a private local directory cannot mint such a URL, and an `<img src>` does not
   carry the session cookie, so an authenticated route could not be rendered by the settings screen
   either. `PUB-02` is the smallest honest answer: an anonymous read of the academy's **own** logo,
   with no parameter, so nothing else in private storage is reachable through it.
2. **The contract's `{fileId}` means the proof's id — and now the response agrees.** M5 pinned the
   path parameter to `payment_proofs.id` (`money-surface.test.ts` says so explicitly) while
   `ProofMeta.fileId` was serialised as `files.id`. No client could complete that round trip:
   reading a payment returned one id and download/delete expected another. Since the frontend's own
   mock treats `fileId` as a single identity, `serializeProof` now emits the proof's id and
   `files.id` is no longer exposed anywhere. `PRF-02/03/04` are unchanged.
3. **Images are stripped, not re-encoded.** A codec dependency was declined: decoding hostile input
   to remove metadata would add a native build and a trusted decoder for a job that is container
   surgery. What the spec's "decode and re-encode" is *for* — no GPS, no appended payload, pixels
   unaltered — is delivered without one.
4. **`PRF-02` matches the contract rather than bending it.** One route, two modes: without
   credentials it mints the signed URL, with them it streams the bytes. A second, undeclared route
   for the bytes was not an option — this codebase refuses to serve a route that is not in the
   contract — and a leaked URL is limited by its signature even for the owner who holds the session.
5. **A public read leaves no audit row, by decision.** `audit_logs.audit_append` requires an actor
   (`app.app_user_id() is not null`), and an anonymous caller has none. Rather than widen that
   policy, the evidence for a public read is the token row: `use_count` and `last_used_at` move in
   the same statement that validates, so a refused use is never counted. A row that names nobody
   would look like an audit trail without being one.
6. **Nothing renders on a public route.** A token whose invoice has no PDF yet is the same 404 as a
   token that never existed; generation stays `INV-07`, which is the owner's action.

## 5. Deliberately not done (recorded, not hidden)

- **The `OPEN-018` payment-method default is still not applied.** The owner's answer ("bank transfer
  only — remove cash from the defaults") is recorded in `NEEDS_FROM_OWNER.md`, but the seed still
  lists `cash` as active and no migration flips it. It is not a one-line change: `bank_transfer`
  has `requires_reference = true`, so every existing fixture that records a cash payment would need
  a distinct reference (and the duplicate-reference rule would then apply across them). Doing it
  half way would leave the product *claiming* a default it does not have. It is a small, contained
  task for whoever takes it: flip the seed, add the alignment migration, and rework the money
  fixtures onto `bank_transfer`.
- **No background PDF worker.** FILES_AND_PDF §4 describes a 30-second sweep of `pdf_stale`. No
  scheduler exists yet (M7/M8 own the queue), so a document becomes available when `INV-07` is
  called — unchanged from M6's start, and the reason a fresh invoice answers `409 PDF_NOT_READY`.
- **The two sample receipts are still unmoved.** `Receipt.pdf` / `anotherrecipt.pdf` sit in the
  project root; the parser's tests need them under `backend/tests/fixtures/receipts/`, and the owner
  has been asked whether they may be tracked in git (`NEEDS_FROM_OWNER.md` §1 item 3).
- **No logo, and therefore no wordmark change.** `SET-03` is ready for the file; until the owner
  uploads one, PDFs and the UI show the name as text (which is exactly what the code falls back to).

## 6. Failed attempts (so the next session does not repeat them)

- **My first `PRF-02`/`PRF-01` test run failed on the id mismatch in §4.2** — `storedProofBytes` and
  the download URL were both built from `ProofMeta.fileId` (`files.id`) while the handlers looked up
  `payment_proofs.id`. The tests found a real client-facing bug, and the fix was the serialiser, not
  the tests.
- **`academy_settings` is not truncated by `resetData`** (it is reference configuration), so the
  logo one test uploaded was still set for the next test — and for the next *file*. The suite now
  clears `logo_file_id` and the `logo` file rows in `beforeEach` **and** `afterAll`, the same lesson
  M5 learned about the billing cadence.
- **`files` is not truncated by `resetData` either.** Rows for proofs accumulate across a run; they
  are harmless (nothing counts them globally), but a test that asserted a global count would be
  flaky.
- **Three fixture mistakes worth naming**, because each looked like a product bug at first: a second
  `invoiceFixture()` in one test collides on the group name and the guardian phone; a second player
  with the same name and date of birth is refused `DUPLICATE_SUSPECTED`; and comparing two 404
  bodies byte-for-byte fails on `requestId`, which is per request by design.
- **Comparing `Uint8Array` methods on a `subarray`** — the strippers return `Uint8Array`, so
  `readUInt32LE`/`toString("latin1")` need a `Buffer.from(...)` wrapper. Assertion-side, not code.

## 7. Next steps

1. **M8's decidable work:** ratify the frontend's report shapes (`frontend/src/mocks/reports.ts`) as
   the contract source, then port `RPT-01`/`RPT-02`; `AUD-01` (its `entityId` is required by the
   contract while `audit_logs.entity_id` is nullable — settle that first); `SYS-03` (no scheduler or
   backup data source exists yet). `DSH-01` still waits on M7 (`message_jobs`).
2. **M7 is unstarted and blocked honestly** on spike S1, which needs a phone number to link to a
   local OpenWA instance (`NEEDS_FROM_OWNER.md` §1 item 6). Nothing in M7 has been written against
   guessed provider behaviour.
3. **Owner:** the `/auth/me` logo URL, the two sample receipts, the domain for the guardian link,
   CR-003, and the real fee/bank configuration — `NEEDS_FROM_OWNER.md`.
4. **Claude:** bless or rename `PUB-02`; align `FILES_AND_PDF` §7 with what ships (it still
   describes a bucket-signed URL for proofs, which this build does not have); note the `{fileId}`
   semantics in §4.2 in the contract text.
5. **Unchanged and still true:** no CI, no performance measurement, no daily session generator,
   nothing deployed, and the whole backend still sits uncommitted in the working tree.
