/**
 * M5 (second half) — payments, allocations, proofs and receipts, through the real HTTP stack.
 *
 * Four things are tested here that a status code alone cannot show:
 *
 *  - **A balance only ever moves through PAY-04/PAY-06/PAY-07, and always to a value derived
 *    from the allocations** — every assertion re-reads the invoice, so a refusal is proven to
 *    have written nothing rather than merely to have returned 409.
 *  - **A receipt that checks out perfectly changes nothing.** `PRF-04` is run against a PDF
 *    whose amount, reference, beneficiary, date, payer and status all match; the findings say
 *    so, and the payment, its allocations, the invoice and the receipt count are re-read
 *    afterwards to prove no status moved (T-VER-04, ADR-013/ADR-020/ADR-021).
 *  - **Money is never edited.** Reversal is the correction path: the invoice returns to
 *    `issued`, the allocations are stamped rather than deleted, and the receipt is void.
 *  - **The lock order is real**: the same payment cannot be double-allocated, because the
 *    second attempt sees the first one's credit already spent.
 *
 * Invoice rows come from fixtures: the billing-run and invoice endpoints that will write them
 * are the other half of M5, and a payment is meaningless without an invoice to allocate
 * against.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import { createUser, errorCode, login, request } from "../helpers/auth.js";
import {
  closeTestPool,
  migratorClient,
  prepareTestDatabase,
  resetData,
  testApp,
} from "../helpers/test-db.js";

const OWNER_IP = "198.51.100.81";
const COACH_IP = "198.51.100.82";

/** Where the storage adapter will look for uploaded objects (FILES_AND_PDF §5). */
const FILES_ROOT = resolve("var/test-files");

interface PaymentBody {
  id: string;
  amountMinor: number;
  status: string;
  allocatedMinor: number;
  unallocatedMinor: number;
  reference?: string;
  method: { code: string; requiresReference: boolean };
  allocations?: { invoice: { id: string; invoiceNumber: string }; amountMinor: number; reversedAt?: string }[];
  proofs?: { fileId: string; docKind: string; verification?: { status: string } }[];
  receipt?: { id: string; receiptNumber: string };
  proofVerification?: { status: string };
  version: number;
}

/** A minimal but real PDF: a text layer with every field a bank e-receipt carries. */
function buildReceiptPdf(lines: string[]): Buffer {
  const content = [
    "BT",
    "/F1 11 Tf",
    "72 720 Td",
    ...lines.flatMap((line, index) => [
      index === 0 ? "(x) Tj" : `(${line.replace(/[()\\]/g, (char) => `\\${char}`)}) Tj`,
      "0 -16 Td",
    ]),
    "ET",
  ].join("\n");

  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R " +
      "/Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];

  let pdf = "%PDF-1.4\n";
  objects.forEach((body, index) => {
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  pdf += "trailer\n<< /Root 1 0 R /Size 6 >>\n%%EOF\n";
  return Buffer.from(pdf, "latin1");
}

describe("M5 money surface (payments, proofs, receipts)", () => {
  let app: FastifyInstance;
  let ownerId: string;
  let ownerCookie: string;
  let ownerCsrf: string;
  let coachCookie: string;
  let coachCsrf: string;
  let playerId: string;
  let guardianId: string;
  let guardianName: string;

  beforeAll(async () => {
    await prepareTestDatabase();
  });

  beforeEach(async () => {
    await resetData();
    process.env["FILES_DIR"] = FILES_ROOT;
    await rm(FILES_ROOT, { recursive: true, force: true });
    await mkdir(FILES_ROOT, { recursive: true });

    await createUser({ username: "money.owner", role: "owner" });
    const owner = await createUser({ username: "money.owner2", role: "owner" });
    const coach = await createUser({ username: "money.coach", role: "coach" });
    ownerId = owner.id;

    app = await testApp();
    const ownerSession = await login(app, owner.username, owner.password, OWNER_IP);
    ownerCookie = ownerSession.cookie;
    ownerCsrf = ownerSession.csrfToken;
    const coachSession = await login(app, coach.username, coach.password, COACH_IP);
    coachCookie = coachSession.cookie;
    coachCsrf = coachSession.csrfToken;

    // The academy's own account, so BENEFICIARY_MATCH has something to match against
    // (PAYMENT_VERIFICATION §4: with none configured the check must report `unknown`).
    const settings = await request(app, {
      method: "PATCH",
      url: "/api/v1/settings/academy",
      cookie: ownerCookie,
      csrf: ownerCsrf,
      payload: {
        beneficiaryAccounts: [{ name: "Inspire Academy", accountMasked: "0012 3456 7890" }],
      },
    });
    expect([200, 204]).toContain(settings.statusCode);

    // A player with a guardian — the payer of everything below.
    guardianName = "Nimal Perera";
    const player = await request(app, {
      method: "POST",
      url: "/api/v1/players",
      cookie: ownerCookie,
      csrf: ownerCsrf,
      payload: {
        fullName: "Kasun Perera",
        dateOfBirth: "2014-05-05",
        registrationDate: "2026-01-01",
        guardians: [
          {
            fullName: guardianName,
            phone: "0771234999",
            isPrimary: true,
            receivesInvoices: true,
          },
        ],
      },
    });
    expect(player.statusCode, player.body).toBe(201);
    const created = player.json() as {
      id: string;
      guardians: { guardian: { id: string } }[];
    };
    playerId = created.id;
    guardianId = created.guardians[0]!.guardian.id;
  });

  afterAll(async () => {
    await app.close();
    await closeTestPool();
    await rm(FILES_ROOT, { recursive: true, force: true });
    delete process.env["FILES_DIR"];
  });

  // -------------------------------------------------------------------------
  // Fixtures written straight to the database (the invoice writers are M5-half-A)
  // -------------------------------------------------------------------------
  let invoiceSeq = 0;
  async function createInvoice(totalMinor: number, dueDate = "2026-10-20") {
    invoiceSeq += 1;
    const invoiceId = randomUUID();
    const invoiceNumber = `INV-2026-${String(invoiceSeq).padStart(6, "0")}`;
    const client = await migratorClient();
    try {
      // One explicit transaction: the invoice's totals are checked against its lines by a
      // **deferred** constraint trigger (0012), so the row and its line must commit together.
      await client.query("begin");
      await client.query(
        `insert into invoices
           (id, invoice_number, kind, player_id, guardian_id, issue_date, due_date, status,
            subtotal_minor, adjustments_minor, total_minor, paid_minor, created_by)
         values ($1, $2, 'manual', $3, $4, '2026-10-01', $5, 'issued', $6, 0, $6, 0, $7)`,
        [invoiceId, invoiceNumber, playerId, guardianId, dueDate, totalMinor, ownerId],
      );
      await client.query(
        `insert into invoice_items
           (id, invoice_id, line_no, item_type, description, quantity, unit_amount_minor,
            amount_minor, created_by)
         values ($1, $2, 1, 'fee', 'Monthly fee', 1, $3, $3, $4)`,
        [randomUUID(), invoiceId, totalMinor, ownerId],
      );
      await client.query("commit");
    } catch (err) {
      await client.query("rollback").catch(() => undefined);
      throw err;
    } finally {
      await client.end();
    }
    return { invoiceId, invoiceNumber };
  }

  /** Reads the invoice's committed money columns as an owner-only backstop for assertions. */
  async function invoiceState(invoiceId: string) {
    const client = await migratorClient();
    try {
      const result = await client.query<{
        status: string;
        paid_minor: string;
        total_minor: string;
        balance_minor: string;
      }>(
        `select status, paid_minor::text, total_minor::text, balance_minor::text
           from invoices where id = $1`,
        [invoiceId],
      );
      const row = result.rows[0]!;
      return {
        status: row.status,
        paidMinor: Number(row.paid_minor),
        totalMinor: Number(row.total_minor),
        balanceMinor: Number(row.balance_minor),
      };
    } finally {
      await client.end();
    }
  }

  async function allocateProof(
    paymentId: string,
    opts: { bytes?: Buffer; docKind: "bank_receipt_pdf" | "bank_receipt_image" | "other"; key?: string },
  ) {
    const fileId = randomUUID();
    const storageKey = opts.key ?? `payment-proofs/${paymentId}/${fileId}.pdf`;
    const bytes = opts.bytes ?? Buffer.from("");
    if (bytes.byteLength > 0) {
      const full = join(FILES_ROOT, storageKey);
      await mkdir(join(full, ".."), { recursive: true });
      await writeFile(full, bytes);
    }
    const client = await migratorClient();
    try {
      await client.query(
        `insert into files (id, kind, storage_key, mime_type, size_bytes, sha256, uploaded_by)
         values ($1, 'payment_proof', $2, $3, $4, $5, $6)`,
        [
          fileId,
          storageKey,
          opts.docKind === "bank_receipt_pdf" ? "application/pdf" : "image/jpeg",
          bytes.byteLength,
          createHash("sha256").update(bytes).digest("hex"),
          ownerId,
        ],
      );
      await client.query(
        `insert into payment_proofs (id, payment_id, file_id, uploaded_by, doc_kind)
         values ($1, $2, $3, $4, $5)`,
        [randomUUID(), paymentId, fileId, ownerId, opts.docKind],
      );
    } finally {
      await client.end();
    }
    return { fileId, storageKey };
  }

  /** The proof row's id (the contract's `{fileId}`), which is not the `files.id`. */
  async function proofIdFor(paymentId: string) {
    const client = await migratorClient();
    try {
      const result = await client.query<{ id: string }>(
        `select id from payment_proofs where payment_id = $1 order by created_at desc limit 1`,
        [paymentId],
      );
      return result.rows[0]!.id;
    } finally {
      await client.end();
    }
  }

  // -------------------------------------------------------------------------
  // Request helpers
  // -------------------------------------------------------------------------
  function recordPayment(payload: Record<string, unknown>, key: string) {
    return request(app, {
      method: "POST",
      url: "/api/v1/payments",
      cookie: ownerCookie,
      csrf: ownerCsrf,
      headers: { "idempotency-key": key },
      payload,
    });
  }

  function confirmPayment(paymentId: string, payload: Record<string, unknown>, key: string) {
    return request(app, {
      method: "POST",
      url: `/api/v1/payments/${paymentId}/confirm`,
      cookie: ownerCookie,
      csrf: ownerCsrf,
      headers: { "idempotency-key": key },
      payload,
    });
  }

  function allocateCredit(paymentId: string, payload: Record<string, unknown>, key: string) {
    return request(app, {
      method: "POST",
      url: `/api/v1/payments/${paymentId}/allocate`,
      cookie: ownerCookie,
      csrf: ownerCsrf,
      headers: { "idempotency-key": key },
      payload,
    });
  }

  function verifyProof(paymentId: string, proofId: string) {
    return request(app, {
      method: "POST",
      url: `/api/v1/payments/${paymentId}/proofs/${proofId}/verify`,
      cookie: ownerCookie,
      csrf: ownerCsrf,
    });
  }

  // -------------------------------------------------------------------------
  // PAY-02 / PAY-04 / PAY-03 / RCT-01
  // -------------------------------------------------------------------------
  it("records a confirmed payment, allocates it and issues a receipt (PAY-02/03/04, RCT-01)", async () => {
    const { invoiceId, invoiceNumber } = await createInvoice(400_000);

    const created = await recordPayment(
      {
        amountMinor: 400_000,
        methodCode: "cash",
        receivedAt: "2026-10-05T04:00:00.000Z",
        payerGuardianId: guardianId,
        status: "confirmed",
        allocations: [{ invoiceId, amountMinor: 400_000 }],
      },
      "pay-cash-1",
    );
    expect(created.statusCode, created.body).toBe(201);
    const payment = created.json() as PaymentBody;
    expect(payment.status).toBe("confirmed");
    expect(payment.allocatedMinor).toBe(400_000);
    expect(payment.unallocatedMinor).toBe(0);
    expect(payment.allocations).toHaveLength(1);
    expect(payment.receipt?.receiptNumber).toMatch(/^RCT-\d{4}-\d{6}$/);

    // The invoice is paid *because* the allocation says so, not because anyone said so.
    expect(await invoiceState(invoiceId)).toEqual({
      status: "paid",
      paidMinor: 400_000,
      totalMinor: 400_000,
      balanceMinor: 0,
    });

    // PAY-03.read returns the allocations, the receipt and the (absent) proofs.
    const read = await request(app, {
      method: "GET",
      url: `/api/v1/payments/${payment.id}`,
      cookie: ownerCookie,
    });
    expect(read.statusCode, read.body).toBe(200);
    const detail = read.json() as PaymentBody;
    expect(detail.allocations![0]!.invoice.invoiceNumber).toBe(invoiceNumber);
    expect(detail.receipt!.receiptNumber).toBe(payment.receipt!.receiptNumber);
    expect(detail.proofs ?? []).toHaveLength(0);

    // RCT-01 lists it, unvoided.
    const receipts = await request(app, {
      method: "GET",
      url: `/api/v1/receipts?paymentId=${payment.id}`,
      cookie: ownerCookie,
    });
    expect(receipts.statusCode, receipts.body).toBe(200);
    const page = receipts.json() as {
      data: { receiptNumber: string; paymentId: string; voided: boolean }[];
      meta: { total: number };
    };
    expect(page.meta.total).toBe(1);
    expect(page.data[0]!.paymentId).toBe(payment.id);
    expect(page.data[0]!.voided).toBe(false);
  });

  it("refuses allocations on a pending payment, then confirm moves the balance (PAY-02/04)", async () => {
    const { invoiceId } = await createInvoice(400_000);

    const pending = await recordPayment(
      {
        amountMinor: 400_000,
        methodCode: "bank_transfer",
        reference: "TRX-PENDING-1",
        receivedAt: "2026-10-05T04:00:00.000Z",
        payerGuardianId: guardianId,
        status: "pending",
        allocations: [{ invoiceId, amountMinor: 400_000 }],
      },
      "pay-pending-1",
    );
    expect(pending.statusCode, pending.body).toBe(409);
    expect(errorCode(pending)).toBe("PAYMENT_NOT_CONFIRMED");

    // A pending payment that was accepted on its own carries no allocation and moves nothing.
    const plain = await recordPayment(
      {
        amountMinor: 400_000,
        methodCode: "bank_transfer",
        reference: "TRX-PENDING-2",
        receivedAt: "2026-10-05T04:00:00.000Z",
        payerGuardianId: guardianId,
        status: "pending",
      },
      "pay-pending-2",
    );
    expect(plain.statusCode, plain.body).toBe(201);
    const payment = plain.json() as PaymentBody;
    expect(payment.allocatedMinor).toBe(0);
    expect(payment.unallocatedMinor).toBe(400_000);
    expect(await invoiceState(invoiceId)).toMatchObject({ status: "issued", paidMinor: 0 });

    // Confirming with the allocation is what moves the balance (PAY-04).
    const confirmed = await confirmPayment(
      payment.id,
      { allocations: [{ invoiceId, amountMinor: 400_000 }], version: payment.version },
      "pay-confirm-1",
    );
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    expect((confirmed.json() as PaymentBody).status).toBe("confirmed");
    expect(await invoiceState(invoiceId)).toMatchObject({ status: "paid", paidMinor: 400_000 });

    // Confirming twice is a state error, not a second receipt.
    const again = await confirmPayment(payment.id, { version: 2 }, "pay-confirm-2");
    expect(again.statusCode).toBe(409);
    expect(errorCode(again)).toBe("INVALID_STATE_TRANSITION");
  });

  it("refuses a second live payment with the same reference (PAY-02)", async () => {
    const first = await recordPayment(
      {
        amountMinor: 100_000,
        methodCode: "bank_transfer",
        reference: "TRX-DUP-1",
        receivedAt: "2026-10-05T04:00:00.000Z",
        status: "pending",
      },
      "pay-dup-1",
    );
    expect(first.statusCode, first.body).toBe(201);

    // Same reference, different case: the unique index is on `lower(reference)`.
    const duplicate = await recordPayment(
      {
        amountMinor: 100_000,
        methodCode: "bank_transfer",
        reference: "trx-dup-1",
        receivedAt: "2026-10-06T04:00:00.000Z",
        status: "pending",
      },
      "pay-dup-2",
    );
    expect(duplicate.statusCode, duplicate.body).toBe(409);
    expect(errorCode(duplicate)).toBe("PAYMENT_DUPLICATE_REFERENCE");

    // A bank transfer with no reference cannot be reconciled, so it is refused outright.
    const noReference = await recordPayment(
      {
        amountMinor: 100_000,
        methodCode: "bank_transfer",
        receivedAt: "2026-10-06T04:00:00.000Z",
        status: "pending",
      },
      "pay-dup-3",
    );
    expect(noReference.statusCode).toBe(422);
    expect(errorCode(noReference)).toBe("VALIDATION_ERROR");
  });

  // -------------------------------------------------------------------------
  // The allocation limits (T-FIN-06/07/08)
  // -------------------------------------------------------------------------
  it("refuses an allocation larger than the invoice owes and writes nothing (PAY-04)", async () => {
    const { invoiceId } = await createInvoice(400_000);
    const payment = (
      await recordPayment(
        {
          amountMinor: 900_000,
          methodCode: "cash",
          receivedAt: "2026-10-05T04:00:00.000Z",
          payerGuardianId: guardianId,
          status: "pending",
        },
        "pay-over-invoice",
      )
    ).json() as PaymentBody;

    const over = await confirmPayment(
      payment.id,
      { allocations: [{ invoiceId, amountMinor: 400_001 }], version: payment.version },
      "pay-over-confirm",
    );
    expect(over.statusCode, over.body).toBe(409);
    expect(errorCode(over)).toBe("ALLOCATION_EXCEEDS_BALANCE");

    // Nothing was written: the invoice is untouched, the payment is still pending, and no
    // receipt exists — the refusal is proven, not assumed.
    expect(await invoiceState(invoiceId)).toMatchObject({ status: "issued", paidMinor: 0 });
    const read = await request(app, {
      method: "GET",
      url: `/api/v1/payments/${payment.id}`,
      cookie: ownerCookie,
    });
    const after = read.json() as PaymentBody;
    expect(after.status).toBe("pending");
    expect(after.allocations ?? []).toHaveLength(0);
    expect(after.receipt).toBeUndefined();
  });

  it("refuses allocating more than the payment holds (PAY-06)", async () => {
    const { invoiceId, invoiceNumber } = await createInvoice(400_000);
    const second = await createInvoice(400_000);

    const created = await recordPayment(
      {
        amountMinor: 500_000,
        methodCode: "cash",
        receivedAt: "2026-10-05T04:00:00.000Z",
        payerGuardianId: guardianId,
        status: "confirmed",
        allocations: [{ invoiceId, amountMinor: 400_000 }],
      },
      "pay-credit-1",
    );
    expect(created.statusCode, created.body).toBe(201);
    const payment = created.json() as PaymentBody;
    expect(payment.unallocatedMinor).toBe(100_000);

    // The credit is real but only 1,000.00 worth: the second invoice cannot take 4,000.
    const tooMuch = await allocateCredit(
      payment.id,
      { allocations: [{ invoiceId: second.invoiceId, amountMinor: 400_000 }], version: payment.version },
      "pay-credit-2",
    );
    expect(tooMuch.statusCode, tooMuch.body).toBe(409);
    expect(errorCode(tooMuch)).toBe("ALLOCATION_EXCEEDS_PAYMENT");
    expect(await invoiceState(second.invoiceId)).toMatchObject({ status: "issued", paidMinor: 0 });

    // What is left can be allocated, as a partial payment.
    const partial = await allocateCredit(
      payment.id,
      { allocations: [{ invoiceId: second.invoiceId, amountMinor: 100_000 }], version: payment.version },
      "pay-credit-3",
    );
    expect(partial.statusCode, partial.body).toBe(200);
    const after = partial.json() as PaymentBody;
    expect(after.unallocatedMinor).toBe(0);
    expect(after.allocations).toHaveLength(2);
    expect(await invoiceState(second.invoiceId)).toMatchObject({
      status: "partially_paid",
      paidMinor: 100_000,
      balanceMinor: 300_000,
    });

    // PAY-08 offers exactly what the payment it is called with still holds. This one holds
    // nothing — both invoices' 5,000.00 are allocated — so it must suggest nothing rather than
    // invent credit that PAY-06 would refuse a moment later.
    const suggestion = await request(app, {
      method: "GET",
      url: `/api/v1/payments/${payment.id}/allocation-suggestion?guardianId=${guardianId}`,
      cookie: ownerCookie,
    });
    expect(suggestion.statusCode, suggestion.body).toBe(200);
    expect(suggestion.json()).toEqual({ suggested: [], creditMinor: 0 });
    expect(invoiceNumber).toMatch(/^INV-\d{4}-\d{6}$/);
  });

  it("reads a guardian's credit for `new`, then suggests oldest-due-first (PAY-08)", async () => {
    const { invoiceId } = await createInvoice(400_000);
    await recordPayment(
      {
        amountMinor: 500_000,
        methodCode: "cash",
        receivedAt: "2026-10-05T04:00:00.000Z",
        payerGuardianId: guardianId,
        status: "confirmed",
        allocations: [{ invoiceId, amountMinor: 400_000 }],
      },
      "pay-suggest-1",
    );

    // The documented contract gap: the record-payment screen has no payment yet, so it calls
    // the route with the literal `new`. That must be a plain answer, not a 500 from a uuid cast.
    const forNewPayment = await request(app, {
      method: "GET",
      url: `/api/v1/payments/new/allocation-suggestion?guardianId=${guardianId}`,
      cookie: ownerCookie,
    });
    expect(forNewPayment.statusCode, forNewPayment.body).toBe(200);
    const credit = forNewPayment.json() as { suggested: unknown[]; creditMinor: number };
    // The 1,000.00 left over from the confirmed payment is the credit on offer, and there is
    // no open invoice for it to go to — so an empty suggestion with the credit intact.
    expect(credit.creditMinor).toBe(100_000);
    expect(credit.suggested).toEqual([]);

    // Two open invoices of different ages. `new` offers the guardian's 1,000.00 (their credit),
    // which reaches only the older one; the later-due invoice must not be touched while an
    // older one still owes — that ordering is the whole point of the helper.
    const older = await createInvoice(200_000, "2026-10-10");
    const newer = await createInvoice(300_000, "2026-10-25");
    const fromCredit = (
      await request(app, {
        method: "GET",
        url: `/api/v1/payments/new/allocation-suggestion?guardianId=${guardianId}`,
        cookie: ownerCookie,
      })
    ).json() as { suggested: { invoiceId: string; amountMinor: number }[]; creditMinor: number };
    expect(fromCredit.suggested).toEqual([{ invoiceId: older.invoiceId, amountMinor: 100_000 }]);
    expect(fromCredit.creditMinor).toBe(0);

    // A freshly recorded 5,000.00 with nothing allocated is a payment, so calling the route with
    // *its* id offers that payment's own remainder instead: both invoices, oldest first.
    const unallocated = (
      await recordPayment(
        {
          amountMinor: 500_000,
          methodCode: "cash",
          receivedAt: "2026-10-06T04:00:00.000Z",
          payerGuardianId: guardianId,
          status: "confirmed",
        },
        "pay-suggest-2",
      )
    ).json() as PaymentBody;
    const fromPayment = (
      await request(app, {
        method: "GET",
        url: `/api/v1/payments/${unallocated.id}/allocation-suggestion?guardianId=${guardianId}`,
        cookie: ownerCookie,
      })
    ).json() as { suggested: { invoiceId: string; amountMinor: number }[]; creditMinor: number };
    expect(fromPayment.suggested).toEqual([
      { invoiceId: older.invoiceId, amountMinor: 200_000 },
      { invoiceId: newer.invoiceId, amountMinor: 300_000 },
    ]);
    expect(fromPayment.creditMinor).toBe(0);
    // The fully-paid invoice is never suggested again, in either mode.
    expect(fromPayment.suggested.some((entry) => entry.invoiceId === invoiceId)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Reversal (T4)
  // -------------------------------------------------------------------------
  it("reverses a payment: the invoice reopens, the receipt is void, nothing is deleted (PAY-07)", async () => {
    const { invoiceId } = await createInvoice(400_000);
    const created = await recordPayment(
      {
        amountMinor: 400_000,
        methodCode: "cash",
        receivedAt: "2026-10-05T04:00:00.000Z",
        payerGuardianId: guardianId,
        status: "confirmed",
        allocations: [{ invoiceId, amountMinor: 400_000 }],
      },
      "pay-reverse-1",
    );
    expect(created.statusCode, created.body).toBe(201);
    const payment = created.json() as PaymentBody;
    expect(await invoiceState(invoiceId)).toMatchObject({ status: "paid" });

    const reversed = await request(app, {
      method: "POST",
      url: `/api/v1/payments/${payment.id}/reverse`,
      cookie: ownerCookie,
      csrf: ownerCsrf,
      headers: { "idempotency-key": "pay-reverse-2" },
      payload: { reason: "Recorded against the wrong player", version: payment.version },
    });
    expect(reversed.statusCode, reversed.body).toBe(200);
    const after = reversed.json() as PaymentBody;
    expect(after.status).toBe("reversed");
    expect(after.allocatedMinor).toBe(0);
    expect(after.unallocatedMinor).toBe(400_000);

    // The invoice is owed again, and the allocation row still exists — stamped, not deleted.
    expect(await invoiceState(invoiceId)).toMatchObject({
      status: "issued",
      paidMinor: 0,
      balanceMinor: 400_000,
    });
    const read = await request(app, {
      method: "GET",
      url: `/api/v1/payments/${payment.id}`,
      cookie: ownerCookie,
    });
    const detail = read.json() as PaymentBody;
    expect(detail.allocations).toHaveLength(1);
    expect(detail.allocations![0]!.reversedAt).toBeDefined();

    // The receipt survives as a void record: the paper copy may still be in the owner's file.
    const receipts = await request(app, {
      method: "GET",
      url: `/api/v1/receipts?paymentId=${payment.id}`,
      cookie: ownerCookie,
    });
    const page = receipts.json() as { data: { voided: boolean }[]; meta: { total: number } };
    expect(page.meta.total).toBe(1);
    expect(page.data[0]!.voided).toBe(true);

    // A reversed payment is a dead end: it cannot be allocated to again.
    const dead = await allocateCredit(
      payment.id,
      { allocations: [{ invoiceId, amountMinor: 100_000 }], version: after.version },
      "pay-reverse-3",
    );
    expect(dead.statusCode).toBe(409);
    expect(errorCode(dead)).toBe("INVALID_STATE_TRANSITION");
  });

  // -------------------------------------------------------------------------
  // Proofs (PRF-03, PRF-04) — evidence, never payment
  // -------------------------------------------------------------------------
  it("records findings from a matching receipt without moving a single balance (PRF-04)", async () => {
    const { invoiceId, invoiceNumber } = await createInvoice(400_000);
    const created = await recordPayment(
      {
        amountMinor: 400_000,
        methodCode: "bank_transfer",
        reference: "TRX-99001",
        receivedAt: "2026-10-05T04:00:00.000Z",
        payerGuardianId: guardianId,
        payerName: guardianName,
        status: "confirmed",
        allocations: [{ invoiceId, amountMinor: 400_000 }],
      },
      "pay-verify-1",
    );
    expect(created.statusCode, created.body).toBe(201);
    const payment = created.json() as PaymentBody;

    const pdf = buildReceiptPdf([
      "Transaction Receipt",
      "Bank Name: Commercial Bank",
      "Transaction Reference: TRX-99001",
      "Transaction Date: 2026-10-05 10:30",
      "Amount (LKR): 4,000.00",
      "Sender Name: Nimal Perera",
      "Beneficiary Name: Inspire Academy",
      "Beneficiary Account: 0012 3456 7890",
      "Status: Completed",
      `Remarks: Payment for ${invoiceNumber}`,
    ]);
    await allocateProof(payment.id, { bytes: pdf, docKind: "bank_receipt_pdf" });
    const proofId = await proofIdFor(payment.id);

    const verified = await verifyProof(payment.id, proofId);
    expect(verified.statusCode, verified.body).toBe(200);
    const verification = verified.json() as {
      docKind: string;
      status: string;
      findings: { code: string; level: number; result: string; detail: string }[];
      extracted?: { reference?: string; amountMinor?: number };
      parserVersion?: string;
    };

    expect(verification.docKind).toBe("bank_receipt_pdf");
    expect(verification.status).toBe("checked");
    expect(verification.extracted?.reference).toBe("TRX-99001");
    expect(verification.extracted?.amountMinor).toBe(400_000);
    expect(verification.parserVersion).toBeTruthy();
    // Every check ran, and the money checks passed on the strength of the document itself.
    expect(verification.findings.filter((f) => f.result === "fail")).toEqual([]);
    expect(verification.findings.filter((f) => f.result === "unknown")).toEqual([]);
    const byCode = new Map(verification.findings.map((f) => [f.code, f.result]));
    expect(byCode.get("AMOUNT_MATCH")).toBe("pass");
    expect(byCode.get("REFERENCE_MATCH")).toBe("pass");
    expect(byCode.get("BENEFICIARY_MATCH")).toBe("pass");
    expect(byCode.get("STATUS_SUCCESSFUL")).toBe("pass");
    expect(byCode.get("INVOICE_MATCH")).toBe("pass");
    expect(byCode.get("RECEIPT_NOT_REUSED")).toBe("pass");

    // A passing check is advice: no status, balance, allocation or receipt changed.
    expect(await invoiceState(invoiceId)).toMatchObject({ status: "paid", paidMinor: 400_000 });
    const read = await request(app, {
      method: "GET",
      url: `/api/v1/payments/${payment.id}`,
      cookie: ownerCookie,
    });
    const after = read.json() as PaymentBody;
    expect(after.status).toBe("confirmed");
    expect(after.allocatedMinor).toBe(400_000);
    expect(after.proofVerification?.status).toBe("passed");
    expect(after.proofs).toHaveLength(1);
  });

  it("reads a mismatched receipt as a failure and still changes nothing (PRF-04)", async () => {
    const { invoiceId } = await createInvoice(400_000);
    const pendingCreated = await recordPayment(
      {
        amountMinor: 400_000,
        methodCode: "bank_transfer",
        reference: "TRX-99002",
        receivedAt: "2026-10-05T04:00:00.000Z",
        payerGuardianId: guardianId,
        status: "pending",
      },
      "pay-mismatch-1",
    );
    expect(pendingCreated.statusCode, pendingCreated.body).toBe(201);
    const payment = pendingCreated.json() as PaymentBody;

    // The receipt says a different amount and points at somebody else's account.
    const pdf = buildReceiptPdf([
      "Transaction Receipt",
      "Bank Name: Sampath Bank",
      "Transaction Reference: TRX-99002",
      "Transaction Date: 2026-10-05 10:30",
      "Amount (LKR): 40,000.00",
      "Beneficiary Name: Some Other Trader",
      "Beneficiary Account: 9999 8888 7777",
      "Status: Completed",
    ]);
    await allocateProof(payment.id, { bytes: pdf, docKind: "bank_receipt_pdf" });
    const proofId = await proofIdFor(payment.id);

    const verified = await verifyProof(payment.id, proofId);
    expect(verified.statusCode, verified.body).toBe(200);
    const verification = verified.json() as {
      status: string;
      findings: { code: string; result: string }[];
    };
    expect(verification.status).toBe("failed");
    const byCode = new Map(verification.findings.map((f) => [f.code, f.result]));
    expect(byCode.get("AMOUNT_MATCH")).toBe("fail");
    expect(byCode.get("BENEFICIARY_MATCH")).toBe("fail");

    // The rejection-looking findings did not reject the payment: that stays an owner action.
    const read = await request(app, {
      method: "GET",
      url: `/api/v1/payments/${payment.id}`,
      cookie: ownerCookie,
    });
    const after = read.json() as PaymentBody;
    expect(after.status).toBe("pending");
    expect(after.receipt).toBeUndefined();
    expect(after.proofVerification?.status).toBe("failed");
    expect(await invoiceState(invoiceId)).toMatchObject({ status: "issued", paidMinor: 0 });
  });

  it("never parses a photo, and a deleted proof keeps its record (PRF-03/04)", async () => {
    const photoCreated = await recordPayment(
      {
        amountMinor: 400_000,
        methodCode: "bank_transfer",
        reference: "TRX-99003",
        receivedAt: "2026-10-05T04:00:00.000Z",
        payerGuardianId: guardianId,
        status: "pending",
      },
      "pay-photo-1",
    );
    expect(photoCreated.statusCode, photoCreated.body).toBe(201);
    const payment = photoCreated.json() as PaymentBody;

    // No bytes on disk at all: an image is never read, so its absence changes nothing.
    await allocateProof(payment.id, { docKind: "bank_receipt_image" });
    const proofId = await proofIdFor(payment.id);

    const verified = await verifyProof(payment.id, proofId);
    expect(verified.statusCode, verified.body).toBe(200);
    const verification = verified.json() as {
      status: string;
      findings: { code: string; result: string; detail: string }[];
    };
    expect(verification.status).toBe("unverifiable");
    expect(verification.findings.map((f) => f.code)).toEqual(["SUPPORTING_ONLY"]);
    expect(verification.findings[0]!.result).toBe("unknown");
    expect(verification.findings[0]!.detail).toMatch(/PDF/i);

    // Deleting is allowed while the payment is pending, and keeps the row (DATABASE §6).
    const deleted = await request(app, {
      method: "DELETE",
      url: `/api/v1/payments/${payment.id}/proofs/${proofId}`,
      cookie: ownerCookie,
      csrf: ownerCsrf,
    });
    expect(deleted.statusCode, deleted.body).toBe(204);
    // An empty body, not an error envelope pretending to be one.
    expect(deleted.body ?? "").toBe("");

    // It is gone from the payment's proofs but still present as metadata.
    const read = await request(app, {
      method: "GET",
      url: `/api/v1/payments/${payment.id}`,
      cookie: ownerCookie,
    });
    const after = read.json() as PaymentBody;
    // The deleted proof is gone from the API's view while its row survives for the trail.
    expect(after.proofs ?? []).toHaveLength(0);
    const client = await migratorClient();
    try {
      const rows = await client.query<{ deleted_at: Date | null }>(
        `select deleted_at from payment_proofs where id = $1`,
        [proofId],
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]!.deleted_at).not.toBeNull();
    } finally {
      await client.end();
    }

    // A deleted proof cannot be verified again.
    const verifyDeleted = await verifyProof(payment.id, proofId);
    expect(verifyDeleted.statusCode).toBe(404);
  });

  // -------------------------------------------------------------------------
  // Authorization
  // -------------------------------------------------------------------------
  it("denies the money surface to a coach (T-AUTH-01, T-DB-RLS-01)", async () => {
    const list = await request(app, {
      method: "GET",
      url: "/api/v1/payments",
      cookie: coachCookie,
    });
    expect(list.statusCode).toBe(403);
    expect(errorCode(list)).toBe("FORBIDDEN");

    const receipts = await request(app, {
      method: "GET",
      url: "/api/v1/receipts",
      cookie: coachCookie,
    });
    expect(receipts.statusCode).toBe(403);

    const record = await request(app, {
      method: "POST",
      url: "/api/v1/payments",
      cookie: coachCookie,
      csrf: coachCsrf,
      headers: { "idempotency-key": "coach-pay-1" },
      payload: {
        amountMinor: 100_000,
        methodCode: "cash",
        receivedAt: "2026-10-05T04:00:00.000Z",
        status: "confirmed",
      },
    });
    expect(record.statusCode).toBe(403);
  });
});
