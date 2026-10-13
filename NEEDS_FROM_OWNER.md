# NEEDS_FROM_OWNER — what is still waiting on a person

> **Status:** Living · **Maintainer:** Freebuff (backend lead) · **Updated:** 2026-10-14
> **Purpose:** every item here is either a question only a person can answer or a resource only
> a person can provide. Nothing in §1 is a coding task; §3 is documentation work for Claude.
> **Nothing blocks a developer from running the system today** — every row below has a safe
> default that is actually built, named under "if you do nothing".
>
> **Standing permission was granted on 2026-10-14** ("you have permission for everything"). That
> settles every *decision* on this list — ordinary development, local infrastructure and commits
> need no further approval. It cannot supply the resources: **item 6 (a phone number for OpenWA) is
> still the single hard block**, and the bank details, logo and domain in items 1 and 4 are still
> things only a person can hand over. See `handoff.md` §5–§6.

---

## 1. What I need from you

### 1a. Things I have to ask you outright

| # | What I need | Why it matters | If you do nothing |
|---|---|---|---|
| **1. Logo file, legal name, address, phone** | `OPEN-001`. The upload path (`SET-03`) is built and tested, so the moment you send a PNG/JPEG/SVG (≤ 1 MB, ideally ≥ 600 px wide, transparent) I can load it; the legal name/address/phone are printed in every invoice and receipt header. | PDFs and the UI brand block; a guardian's bank transfer is guided by the address and account details on the invoice. | PDFs print the academy name as a plain text wordmark, with whatever `SET-01` currently holds. I will not invent a logo or a legal name. |
| **2. Must invoices/receipts print Sinhala or Tamil?** | `OPEN-013`. **Spike P1 was run (2026-10-13):** PDFKit produces valid, deterministic PDFs and English is perfect, but it has **no complex-script shaping** — Sinhala/Tamil would come out visually wrong. Supporting them means the whole pipeline becomes HTML → headless Chromium (heavier to run, patch and secure). | The PDF engine for M6 and every document after it. | **English-only**, PDFKit + embedded Noto Sans (Latin). A player or guardian name in Sinhala/Tamil would print transliterated at best — so tell me if your names are Latin-script in the register. |
| **3. The two sample receipts — are these the two, and which bank is each?** | `OPEN-023`. I found `Receipt.pdf` and `anotherrecipt.pdf` in the project root. The receipt parser is **per-bank layout**, so it needs to know which layout each sample is. Also: may I move them into `backend/tests/fixtures/receipts/` so the parser's tests are reproducible, or would you rather they stay out of git? | The `PRF-04` receipt check (the only thing that catches a receipt reused for a second payment, or an edited amount). | Parser starts against them as "bank A" / "bank B"; a third bank needs its own sample later. |
| **4. The academy's real configuration and bank details** | `OPEN-018`. Monthly + calendar + due 7 days after issue is already the seeded default. Your "bank transfer only" answer is **recorded but not yet applied** — see §1b, which says why and what it would take. Still missing: the **real fee per group**, and the **payment instructions text** (bank name, branch, account name/number) that prints on every invoice. | Go-live, and the invoice's payment-instructions block — an invoice a guardian cannot act on is not finished. | Seed defaults: placeholder fees, empty payment instructions. |
| **5. Domain name and where the guardian's invoice link lives** | `OPEN-017`. `PUB-01` (the guardian-facing capability link) is built; the link it is placed in a message as `https://<api-host>/api/v1/public/invoices/<token>/pdf`. The private key/TLS and the host name are yours to provide. | The link a guardian taps; the public origin cannot be invented. | Links work against the local/staging host only. |
| **6. WhatsApp: a spare number to link locally** | Spike S1. You said build and test locally first. To record the five unverified OpenWA facts (`O18–O22`) I need **a phone number (a spare or second phone)** to link to a local OpenWA instance. The VPS and the production number are only needed before live verification. | All 21 M7 messaging endpoints. Nothing in M7 can be honestly verified without it. | M7 stays unstarted — no messaging code written against guessed provider behaviour. |
| **7. CR-003 approval, in writing** | The coach clock-in dashboard block, the per-automation WhatsApp switches (`SET-08`) and "mobile is a shipping requirement" are built on the frontend while `ADR-019` is still *Proposed*. I need you to confirm or amend them. | `SET-08`, `DSH-01.coachTime` and the M8 clock cards wait on this (`CAT-01..05` is already live and needs retroactive sign-off). | Automations stay **off by default**; `SET-08`, `DSH-01.coachTime` and the clock cards stay unbuilt. |
| **8. Age-eligibility reference and the real group age ranges** | `OPEN-003`. Today: `jan_1_of_year` and suggestion-only. | Group suggestions (`GRP-05`) run on this default. | Suggestions may be wrong at go-live; nothing breaks. |
| **9. Retention periods (with your accountant)** | `OPEN-009`. Financial records 7 yr and proofs 24 mo are the engineering defaults. | Production release gate (M10) — deleting a document too early is not recoverable. | Defaults stay; a production release would need your written acceptance. |
| **10. Mandatory TOTP for owners?** | `OPEN-010`. Security posture for the academy's own login. | Release gate only (M10). | Optional but strongly recommended. |
| **11. Storage provider for the private bucket** | `OPEN-016`. Payment proofs, logos and PDFs are in a private local directory (`FILES_DIR`) today; proofs are streamed back through the backend rather than a signed URL, so nothing needs a bucket to work. R2 / Supabase Storage / S3 all fit the one-file adapter. | Real deployment only. | Local directory — fine for dev/staging, not for production (no off-host backup, no versioning). |

### 1b. Answers that changed the build (recorded 2026-10-13)

| Your answer | What I did |
|---|---|
| Invoice timing (`OPEN-006`): both modes | Both exist and are tested; the default stays `period_start`. |
| Proration (`OPEN-004`): support both | **Open task, not a decision** — full fee ships today, proration is not built yet. |
| Transfers (`OPEN-005`), guardian credit (`OPEN-007`): manual | Matches what ships; no automation built. |
| Methods (`OPEN-018`): bank transfer only | **Recorded, and deliberately NOT yet applied.** The seed still lists `cash` as active. Flipping it is not a one-line change: `bank_transfer` requires a reference, so every existing money fixture has to move onto it with its own distinct reference (and the duplicate-reference rule then applies across them). A half-applied default would leave the product claiming something it does not do, so it is recorded as an open task in the [M6 handoff](docs/engineering/handoffs/2026-10-14-backend-m6-complete.md) §5 instead. |
| Coaches see guardian phone (`OPEN-008`): yes | Default for new academies flipped to `true` (the `SECURITY DEFINER` projection and `SET-01` toggle already existed). |
| Receipts (`OPEN-023`): start from the two samples · (`OPEN-024`): no OCR | Matches the shipped parser: image-only PDFs are flagged `NO_TEXT_LAYER` and stay owner-verified. |
| Branding (`OPEN-001`): colours are in the frontend | Palette is the frontend's; PDFs use a neutral palette until the logo arrives. |

---

## 2. Not needed from you

- **The bucket choice is not blocking.** The storage key is opaque and the adapter is one file,
  so local-directory storage is a legitimate v1; switching is a deployment-time change.
- **M5's three previously "decision-blocked" endpoints** (`SET-04.*`, `PLY-11`, `GDN-06`) were
  fully specified — built and tested.
- **`PRF-02`'s URL shape is settled, and the contract's own shape is what shipped.** The endpoint
  returns `{url, expiresAt}` exactly as declared; the URL points at this API with a 5-minute HMAC
  signature and following it streams the bytes through the backend, which is `FILES_AND_PDF §7`'s
  "or the backend streams it". No decision is waiting on you (the docs still describe a
  bucket-signed URL — §3).

---

## 3. Contract items for Claude (documentation, not code, not yours)

A safe handler behaviour exists for each; the **contract text** still disagrees with the code.

| Item | What differs | Safe behaviour currently shipped |
|---|---|---|
| `ATT-03` permission | Contract grants an edit a coach cannot perform. | A real **403**. |
| `PAY-08` path | The path carries a payment id, but the suggestion is keyed by **guardian**. | `{id}` is a plain string; `new` = guardian credit, a real id = that payment's remainder. |
| `BIL-02` `queueWhatsApp` | The flag exists but `message_jobs` arrives with M7. | Refused **422** rather than accepted and dropped. |
| `BIL-02` `ALREADY_INVOICED` | Declared as an error but cannot fire — a duplicate is a **skip**. | A run report (`invoicesCreated: 0 / invoicesSkipped: N`). |
| `SES-04` `REASON_REQUIRED` | A declared code the implementation cannot reach. | Needs the contract corrected. |
| `INV-03` no-group refusal | `Invoice.ageGroup` is required, so a player with no group on the issue date is refused. | **422**, with the reason. |
| `PLY-01` / `SCH-01` `z.coerce.boolean()` | Query-string coercion semantics. | Per the registry; needs a note. |
| `PLY-10` default window | Registration date → today, academy-local. | Shipped; needs a line in the contract. |
| `SET-03` response | Declared `{logoUrl}` as a public URL, in a build with no bucket and no public origin. | `logoUrl` now names **`PUB-02`** (below): an anonymous read of the academy's own logo, which is what makes the promise true without a bucket. |
| `PUB-01` token minting | `PUB-01` consumes a capability token, but **no endpoint in the contract mints one** — the raw token only ever appears in an outgoing M7 message. | It is minted **outside the API**, which is why no contract entry was invented: `npm run invoice-message -- --invoice INV-... --mint-link` creates one on the server and prints it in the finished message (`scripts/invoice-message.ts`, verified against real rows). M7's send path will call the same `mintInvoiceLink()`. If the *owner* should be able to copy a link from the UI, the contract still needs a minting endpoint — I would not invent one. |
| **`PUB-02` is an addition I made** (new) | `SET-03` promises a `logoUrl` that is "public through `/auth/me` and PDFs". With no bucket there is no public URL to mint, and an `<img src>` cannot carry the session cookie, so no authenticated route could satisfy it either. | I added `PUB-02` (`GET /public/academy/logo`) to the contract: an anonymous read of the academy's **own** logo, no parameter, so it cannot reach anything else in private storage. **Please bless or rename it** — it is the one contract change this milestone made. |
| `PRF-02` response (no change needed) | The contract asks for `{url, expiresAt}` and exactly that ships: the URL is this API's own route carrying a 5-minute HMAC signature, and following it streams the bytes. §7's "or the backend streams it" is satisfied without a bucket. | The **docs** (`FILES_AND_PDF §7`) still describe a bucket-signed URL and were aligned this session. |
| `{fileId}` means two things (fixed in code) | M5 pinned `PRF-02/03/04`'s `{fileId}` path parameter to `payment_proofs.id`, while `ProofMeta.fileId` serialised `files.id` — so read → download could never work. | `serializeProof` now emits the **proof's** id; the path parameter is unchanged. Worth one sentence in the contract. |
