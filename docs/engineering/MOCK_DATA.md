# MOCK_DATA

> **Status:** Draft v1 · **Owner:** Claude (spec) / Hassen (MSW fixtures) · **Updated:** 2026-10-12 (Step 5 added the mock-store behaviour section at the end) · Shapes are normative per [API_CONTRACTS](../architecture/API_CONTRACTS.md) §2; values are fake. User rows carry `username`, never `email` ([ADR-018](../engineering/DECISIONS.md#adr-018)). Mock logins: `owner` · `coach` · `totp` (asks for a code) · `locked` (ACCOUNT_LOCKED) — any password. Use these in MSW handlers; if a shape changes in the contract, update here.

```jsonc
// GET /auth/me (owner) — AUTH-03
{ "user": {"id":"0192a000-0000-7000-8000-000000000001","username":"owner","fullName":"Demo Owner","role":"owner","status":"active","totpEnabled":false},
  "csrfToken":"mock-csrf-token",
  "academy":{"name":"Inspire Academy","timezone":"Asia/Colombo"},
  "permissions":["users:manage","settings:manage","players:manage","billing:manage","payments:manage","messaging:manage","reports:read","audit:read",
    "sessions:read","sessions:manage","attendance:mark","attendance:correct_any","coach_attendance:manage"] }
// The owner holds every permission in AUTH_AND_PERMISSIONS §6; this list carries only the ones the
// frontend uses for navigation and guards (it grew in Step 4 — the training screens are permission-gated,
// not role-gated). A guard that needs "the owner" reads a permission, never `role === 'owner'`.

// GET /auth/me (coach)
{ "user": {"id":"0192a000-0000-7000-8000-000000000002","username":"coach","fullName":"Demo Coach","role":"coach","status":"active","totpEnabled":false},
  "csrfToken":"mock-csrf-token","academy":{"name":"Inspire Academy","timezone":"Asia/Colombo"},
  "permissions":["groups:read","players:read_restricted","sessions:read","attendance:mark","coach_attendance:self"],
  "assignedGroupIds":["0192a000-0000-7000-8000-0000000000a1"] }

// GET /players?page=1&pageSize=25 (owner) — PLY-01
{ "data":[ { "id":"0192a000-0000-7000-8000-0000000000b1","registrationNo":"IA-0001","fullName":"Demo Player One","dateOfBirth":"2015-03-14","ageOnReference":10,
    "registrationDate":"2026-01-10","status":"active","statusEffectiveDate":"2026-01-10",
    "currentGroup":{"id":"0192a000-0000-7000-8000-0000000000a1","name":"Under-11","since":"2026-01-10"},
    "guardians":[{"guardian":{"id":"0192a000-0000-7000-8000-0000000000c1","fullName":"Demo Guardian","phone":"+94770000001","whatsappConsent":"granted"},"isPrimary":true,"receivesInvoices":true}],
    "billingAnchorDate":"2026-01-10","outstandingMinor":400000,"version":3 } ],
  "meta":{"page":1,"pageSize":25,"total":1,"totalPages":1} }

// same list as coach — PlayerCoachView (no DOB, guardians, notes, balances)
{ "data":[{"id":"0192a000-0000-7000-8000-0000000000b1","registrationNo":"IA-0001","fullName":"Demo Player One","age":10,"status":"active","group":{"id":"0192a000-0000-7000-8000-0000000000a1","name":"Under-11"}}],
  "meta":{"page":1,"pageSize":25,"total":1,"totalPages":1} }

// POST /billing/previews — BIL-01
{ "previewHash":"sha256:ab12…","targetDate":"2026-11-01","frequency":"monthly","mode":"calendar",
  "lines":[{"playerId":"0192a000-0000-7000-8000-0000000000b1","playerName":"Demo Player One","registrationNo":"IA-0001",
    "ageGroup":{"id":"0192a000-0000-7000-8000-0000000000a1","name":"Under-11"},"periodStart":"2026-11-01","periodEnd":"2026-11-30",
    "issueDate":"2026-11-01","dueDate":"2026-11-08","feeMinor":400000,"feeId":"0192a000-0000-7000-8000-0000000000f1",
    "guardian":{"id":"0192a000-0000-7000-8000-0000000000c1","fullName":"Demo Guardian"},"warnings":[]}],
  "skipped":[{"playerId":"0192a000-0000-7000-8000-0000000000b9","playerName":"Demo No Group","reason":"NO_GROUP"}],
  "totals":{"count":1,"totalMinor":400000} }

// GET /invoices/{id} — INV-02 (partially paid)
{ "id":"0192a000-0000-7000-8000-0000000000d1","invoiceNumber":"INV-2026-000101","kind":"periodic","status":"partially_paid","isOverdue":true,"daysOverdue":4,
  "player":{"id":"0192a000-0000-7000-8000-0000000000b1","fullName":"Demo Player One","registrationNo":"IA-0001"},
  "guardian":{"id":"0192a000-0000-7000-8000-0000000000c1","fullName":"Demo Guardian"},"ageGroup":{"id":"0192a000-0000-7000-8000-0000000000a1","name":"Under-11"},
  "periodStart":"2026-11-01","periodEnd":"2026-11-30","issueDate":"2026-11-01","dueDate":"2026-11-08","currency":"LKR",
  "subtotalMinor":400000,"adjustmentsMinor":0,"totalMinor":400000,"paidMinor":150000,"balanceMinor":250000,
  "items":[{"id":"0192a000-0000-7000-8000-0000000000e1","lineNo":1,"itemType":"fee","description":"Monthly fee – Under-11 (Nov 2026)","quantity":1,"unitAmountMinor":400000,"amountMinor":400000}],
  "allocations":[{"id":"0192a000-0000-7000-8000-0000000000g1","paymentId":"0192a000-0000-7000-8000-0000000000p1","invoice":{"id":"0192a000-0000-7000-8000-0000000000d1","invoiceNumber":"INV-2026-000101"},"amountMinor":150000,"allocatedAt":"2026-11-05T09:30:00Z"}],
  "hasPdf":true,"version":4 }

// POST /payments (pending, with a bank-transfer PDF receipt attached) — PAY-02 response
// CR-004: there is ONE check vocabulary — a proof's checks live in `proofs[].verification.findings[]`
// (PAYMENT_VERIFICATION §4/§5); the payment itself carries only the rollup `proofVerification`.
{ "id":"0192a000-0000-7000-8000-0000000000p2","amountMinor":1000000,"currency":"LKR","method":{"code":"bank_transfer","label":"Bank transfer","requiresReference":true,"isActive":true},
  "reference":"TRX99","receivedAt":"2026-11-06T04:00:00Z","payer":{"guardianId":"0192a000-0000-7000-8000-0000000000c1","name":"Demo Guardian"},
  "status":"pending","allocatedMinor":0,"unallocatedMinor":1000000,"proofVerification":{"status":"passed","checkedAt":"2026-11-06T04:06:00Z"},"proofs":[{"fileId":"0192a000-0000-7000-8000-0000000000h1","originalName":"receipt.pdf","mimeType":"application/pdf","sizeBytes":96421,"uploadedAt":"2026-11-06T04:05:00Z","uploadedBy":{"id":"0192a000-0000-7000-8000-000000000001","fullName":"Demo Owner"},"docKind":"bank_receipt_pdf","verification":{"docKind":"bank_receipt_pdf","status":"checked","parserVersion":"demo-bank@0.1.0","checkedAt":"2026-11-06T04:06:00Z","findings":[{"code":"AMOUNT_MATCH","level":2,"result":"pass","detail":"Receipt amount equals the recorded amount."}]}}],"version":1 }

// POST /payments/{id}/proofs/{fileId}/verify — PRF-04 (CR-004): a bank-transfer PDF e-receipt, verified
// VERIFY (ADR-021): findings are ADVISORY. One `fail` ⇒ the payment shows "Check failed: …", but it stays
// `pending` until an owner confirms (PAY-04) — passing checks never move money. No bank layout is assumed:
// the parser is per-bank and its version is recorded (OPEN-023).
{ "fileId":"0192a000-0000-7000-8000-0000000000h2","originalName":"receipt.pdf","mimeType":"application/pdf","sizeBytes":96421,
  "uploadedAt":"2026-11-06T04:05:00Z","uploadedBy":{"id":"0192a000-0000-7000-8000-000000000001","fullName":"Demo Owner"},
  "docKind":"bank_receipt_pdf",
  "verification":{ "docKind":"bank_receipt_pdf","status":"failed","parserVersion":"demo-bank@0.1.0","checkedAt":"2026-11-06T04:06:00Z",
    "extracted":{ "bankName":"Demo Bank","documentType":"Fund Transfer Confirmation","reference":"DEMO-REF-0001",
      "transactionAt":"2026-11-06T03:58:00Z","amountMinor":400000,"currency":"LKR",
      "payerName":"Demo Guardian","payerAccountMasked":"****0000","beneficiaryName":"Inspire Academy Demo",
      "beneficiaryAccountMasked":"****0001","channel":"CEFT","status":"Successful","remarks":"INV-2026-000101" },
    "findings":[
      {"code":"AMOUNT_MATCH","level":2,"result":"pass","detail":"Receipt amount equals the recorded amount."},
      {"code":"BENEFICIARY_MATCH","level":2,"result":"pass","detail":"Beneficiary matches an academy account."},
      {"code":"DATE_TOLERANCE","level":2,"result":"warn","detail":"Transferred 2 minutes before the recorded time.","meta":{"deltaMinutes":-2}},
      {"code":"RECEIPT_NOT_REUSED","level":2,"result":"fail","detail":"This receipt reference is already attached to another payment.","meta":{"otherPaymentId":"0192a000-0000-7000-8000-0000000000p3"}}
    ] } }
// The image case is deliberately NOT parsed: a JPEG/PNG proof is stored with "docKind":"bank_receipt_image"
// and yields verification.status "unverifiable" (findings: SUPPORTING_ONLY) — never a passing check (ADR-021 §2).

// GET /sessions/{id}/attendance — ATT-01
{ "session":{"id":"0192a000-0000-7000-8000-0000000000s1","ageGroup":{"id":"0192a000-0000-7000-8000-0000000000a1","name":"Under-11"},"sessionDate":"2026-11-03","startsAt":"2026-11-03T12:00:00Z","endsAt":"2026-11-03T13:30:00Z","status":"scheduled","version":1},
  "roster":[{"player":{"id":"0192a000-0000-7000-8000-0000000000b1","fullName":"Demo Player One","registrationNo":"IA-0001"}},
            {"player":{"id":"0192a000-0000-7000-8000-0000000000b2","fullName":"Demo Player Two","registrationNo":"IA-0002"},"record":{"status":"late","markedAt":"2026-11-03T12:10:00Z","markedBy":"Demo Coach","version":1}}],
  "editableUntil":"2026-11-04T12:00:00Z","canEdit":true }

// GET /messages/{id} — MSG-02 (sent, not yet delivered)
{ "id":"0192a000-0000-7000-8000-0000000000m1","kind":"reminder_pre_due","status":"sent","deliveryState":"server_accepted",
  "invoice":{"id":"0192a000-0000-7000-8000-0000000000d1","invoiceNumber":"INV-2026-000101"},"player":{"id":"0192a000-0000-7000-8000-0000000000b1","fullName":"Demo Player One"},
  "guardian":{"id":"0192a000-0000-7000-8000-0000000000c1","fullName":"Demo Guardian","phoneMasked":"+9477****001"},
  "scheduledFor":"2026-11-05T03:30:00Z","attempts":1,"maxAttempts":5,"sentAt":"2026-11-05T03:31:10Z",
  // VERIFY: the numeric meaning of providerAck is OpenWA-specific and NOT yet confirmed (O19).
  // Treat as an opaque value we store, not as a portable ack enum.
  "events":[{"eventType":"queued","at":"2026-11-05T03:00:00Z"},{"eventType":"provider_accepted","at":"2026-11-05T03:31:10Z","providerAck":1}] }

// GET /messaging/status — MSG-06 (disconnected)
// VERIFY (OPENWA_INTEGRATION §2 O18): the OpenWA session-status enum has NOT been confirmed.
// This placeholder must be replaced with a real value recorded by spike S1 before M7 code uses it.
{ "automationEnabled":true,"automations":{"invoiceDelivery":true,"reminderPreDue":false,"reminderOverdue":true,"proofCheck":true},"provider":"openwa","session":{"status":"UNVERIFIED_STATUS_ENUM","checkedAt":"2026-11-05T03:40:00Z"},
  "queue":{"queued":12,"sending":0,"failedLast24h":1,"dead":0,"needsReview":0} }

// GET /dashboard/owner — DSH-01 (CR-003: the coach-time block only; money/players/sessions omitted)
{ "coachTime":{ "checkedInNow":[{"coach":{"id":"0192a000-0000-7000-8000-000000000002","fullName":"Demo Coach"},
      "session":{"id":"0192a000-0000-7000-8000-0000000000s1","ageGroupName":"Under-11","startsAt":"2026-11-03T12:00:00Z"},
      "checkInAt":"2026-11-03T11:52:00Z","elapsedMinutes":38}],
    "todayMinutes":38,"weekMinutes":212,"openNeedingCorrection":1 } }
// VERIFY: `proofVerification` and `verification.findings[]` are ADVISORY only (ADR-020/ADR-021) — the payment above stays "pending" until an owner confirms (PAY-04).
// `proofCheck:true` in MSG-06 means the checks ran; it never means the transfer was confirmed.

// Errors
{ "error":{"code":"ALLOCATION_EXCEEDS_BALANCE","message":"The amount is more than the invoice balance.","details":[{"field":"allocations.0.amountMinor","issue":"max 250000","meta":{"balanceMinor":250000}}],"requestId":"req_01J…"} }
{ "error":{"code":"VERSION_CONFLICT","message":"This record was changed by someone else.","requestId":"req_01J…"} }
{ "error":{"code":"VALIDATION_ERROR","message":"Please correct the highlighted fields.","details":[{"field":"guardians.0.phone","issue":"Invalid phone number"}],"requestId":"req_01J…"} }
{ "error":{"code":"RATE_LIMITED","message":"Too many requests.","requestId":"req_01J…"} }   // + Retry-After header
```

## Mock store behaviour added with the billing/payments slice (Step 5)

All of the above is served from **one mock store** (`frontend/src/mocks/db.ts`): handler modules share it, it lives in memory and mirrors to `localStorage` under `ia_mock_people_v1` with `schema: 3`. A schema bump, a cleared storage or `resetMockPeople()` re-seeds it, so every browser context in the e2e starts from the same fixtures. Step 5 gave the store invoices (items, adjustments, allocations), payments with credit, proofs with findings, receipts and billing runs. The seed carries an invoice in every status (issued, partially paid, paid, void, plus one overdue), one invoice whose PDF is not built yet, a confirmed payment holding credit, and pending payments with a PDF receipt, a photo only, and a reused receipt reference.

Behaviour worth knowing before writing a screen against it:

- **`BIL-01` is stateless.** `previewHash` is an FNV-1a digest over the canonical `(targetDate + lines + skipped)`, so the same state always produces the same hash and any change to what *would* be created changes it. `BIL-02` recomputes the preview and answers **409 `PREVIEW_STALE`** when the hash no longer matches — it never bills from a stale preview. A run skips players already invoiced for that period with the reason `ALREADY_INVOICED`, and is recorded with its created/skipped counts.
- **Money only moves through a confirmed payment.** Allocating on a `pending` payment is **409 `PAYMENT_NOT_CONFIRMED`** (whether it arrives with `PAY-02`'s `allocations` or later through `PAY-06`), an allocation above a balance is 409 `ALLOCATION_EXCEEDS_BALANCE`, and voiding an invoice that still has allocations is refused until they are released — released allocations become payment credit.
- **`PRF-04` is deterministic and advisory.** The same document yields the same `findings[]`, with the parser version recorded; an image proof is always `unverifiable` (`SUPPORTING_ONLY`) and can never pass; no check writes a payment status, an allocation or a receipt (ADR-020/ADR-021). The mock does **not** keep uploaded bytes — a proof download serves a generated stub of the same kind, so nothing here is a real document reader.
- **`INV-06` / `RCT-02` simulate PDF generation.** An invoice without a built PDF answers **409 `PDF_NOT_READY`** until `POST /invoices/{id}/pdf/regenerate` succeeds, which is what makes the "Preparing PDF…" state reachable through the UI. Both stream a real `application/pdf` body thereafter.
- **Idempotency is enforced on the wire, not in the UI.** Money `POST`s replay a repeated `Idempotency-Key` (`Idempotent-Replay: true`) instead of recording twice, and a missing key is **400 `IDEMPOTENCY_KEY_REQUIRED`**.
- **Order matters in `mocks/handlers.ts`:** MSW answers with the first matching registration, and the billing/payments routes are composed after `auth`/`people`/`sessions`. `GET */invoices/:id` is owned by `handlers.billing.ts` alone (the Step 3 read-only stub in `handlers.people.ts` was retired to a comment when `INV-02` became the full page).

**Scenario fixtures to build:** coach with one assigned group; an unassigned-group resource returning 404; an invoice list with each status (issued, partially_paid, paid, void, overdue); a payment with credit; a billing preview with `PREVIEW_STALE` on commit; message jobs in every status/delivery combination; an OpenWA session-not-connected banner state using our normalized label `awaiting_qr` (**the provider's own status strings are VERIFY — S1 O18**; do not reuse the previous provider's `scanqr` value).
