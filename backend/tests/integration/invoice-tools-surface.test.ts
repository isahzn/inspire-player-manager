/**
 * The invoice message and the invoice checks, against the real database.
 *
 * The unit tests cover the arithmetic and the substitution; what they cannot cover is the SQL —
 * the column names, the `char(3)` currency, the `::text` casts on `bigint` columns and the four
 * aggregates `loadInvoiceHealthRows` joins. A typo there fails at runtime in an operator's hands,
 * so it is asserted here. The seeded `invoice_delivery` template is read through
 * `loadInvoiceMessageInput` too, which is what proves the shipped template and the shipped
 * variable list still agree: if `{{invoiceLink}}` were removed from the template, the message
 * would stop refusing without a link and this test would notice.
 */
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  buildInvoiceMessage,
  loadInvoiceMessageInput,
} from "../../src/messaging/invoice-message.js";
import { mintInvoiceLink } from "../../src/messaging/invoice-link.js";
import { checkInvoiceHealth, loadInvoiceHealthRows } from "../../src/ops/invoice-health.js";
import { createUser, login, request } from "../helpers/auth.js";
import {
  closeTestPool,
  migratorClient,
  prepareTestDatabase,
  resetData,
  testApp,
} from "../helpers/test-db.js";

const OWNER_IP = "10.10.10.1";

describe("invoice tools surface", () => {
  let app: FastifyInstance;
  let ownerId: string;
  let playerId: string;
  let guardianId: string;
  let invoiceId: string;
  let invoiceNumber: string;

  beforeAll(async () => {
    await prepareTestDatabase();
  });

  beforeEach(async () => {
    await resetData();

    const owner = await createUser({ username: "tools.owner", role: "owner" });
    ownerId = owner.id;
    app = await testApp();
    const session = await login(app, owner.username, owner.password, OWNER_IP);

    const player = await request(app, {
      method: "POST",
      url: "/api/v1/players",
      cookie: session.cookie,
      csrf: session.csrfToken,
      payload: {
        fullName: "Kasun Perera",
        dateOfBirth: "2014-05-05",
        registrationDate: "2026-01-01",
        guardians: [
          { fullName: "Nimal Perera", phone: "0771234999", isPrimary: true, receivesInvoices: true },
        ],
      },
    });
    expect(player.statusCode, player.body).toBe(201);
    const created = player.json() as { id: string; guardians: { guardian: { id: string } }[] };
    playerId = created.id;
    guardianId = created.guardians[0]!.guardian.id;

    invoiceId = randomUUID();
    invoiceNumber = "INV-2026-000001";
    const pdfFileId = randomUUID();
    const client = await migratorClient();
    try {
      // One transaction: the totals-vs-lines check is a **deferred** constraint trigger (0012).
      await client.query("begin");
      // A generated document, so the fixture is a *complete* invoice and the only findings an
      // assertion sees are the ones a test put there deliberately.
      await client.query(
        `insert into files (id, kind, storage_key, mime_type, size_bytes, sha256, uploaded_by)
         values ($1, 'invoice_pdf', $2, 'application/pdf', 1024, repeat('a', 64), $3)`,
        // `files` is not cleared between tests, so the key carries the fresh id.
        [pdfFileId, `invoices/${pdfFileId}.pdf`, ownerId],
      );
      await client.query(
        `insert into invoices
           (id, invoice_number, kind, player_id, guardian_id, issue_date, due_date, status,
            subtotal_minor, adjustments_minor, total_minor, paid_minor,
            pdf_file_id, pdf_generated_at, pdf_stale, created_by)
         values ($1, $2, 'manual', $3, $4, '2026-10-01', '2026-11-08', 'issued', 400000, 0, 400000, 0,
                 $6, now(), false, $5)`,
        [invoiceId, invoiceNumber, playerId, guardianId, ownerId, pdfFileId],
      );
      await client.query(
        `insert into invoice_items
           (id, invoice_id, line_no, item_type, description, quantity, unit_amount_minor,
            amount_minor, created_by)
         values ($1, $2, 1, 'fee', 'Monthly fee', 1, 400000, 400000, $3)`,
        [randomUUID(), invoiceId, ownerId],
      );
      await client.query("commit");
    } catch (err) {
      await client.query("rollback").catch(() => undefined);
      throw err;
    } finally {
      await client.end();
    }
  });

  afterAll(async () => {
    await app.close();
    await closeTestPool();
  });

  it("reads a healthy invoice without a finding, and reports the money as text", async () => {
    const client = await migratorClient();
    try {
      const rows = await loadInvoiceHealthRows(client);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        invoiceNumber,
        status: "issued",
        // `char(3)` comes back padded; the loader trims it.
        currency: "LKR",
        totalMinor: "400000",
        itemsTotalMinor: "400000",
        allocatedMinor: "0",
        guardianName: "Nimal Perera",
        liveLinks: 0,
      });

      const report = checkInvoiceHealth(rows, { today: "2026-10-14" });
      expect(report.findings).toEqual([]);
      expect(report.summary).toMatchObject({ checked: 1, overdueCount: 0 });
    } finally {
      await client.end();
    }
  });

  it("sees a document that is missing and a bill that is past due", async () => {
    const client = await migratorClient();
    try {
      await client.query(
        "update invoices set due_date = '2026-10-01', pdf_file_id = null, pdf_stale = true where id = $1",
        [invoiceId],
      );
      const rows = await loadInvoiceHealthRows(client);
      const report = checkInvoiceHealth(rows, { today: "2026-10-14" });

      expect(report.findings.map((f) => f.code).sort()).toEqual(["OVERDUE", "PDF_MISSING"]);
      expect(report.summary).toMatchObject({ overdueCount: 1, overdueMinor: "400000" });
    } finally {
      await client.end();
    }
  });

  it("notices a stale document, and can exclude void invoices", async () => {
    const client = await migratorClient();
    try {
      await client.query("update invoices set pdf_stale = true where id = $1", [invoiceId]);
      const rows = await loadInvoiceHealthRows(client, { includeVoid: true });
      expect(checkInvoiceHealth(rows, { today: "2026-10-14" }).findings.map((f) => f.code)).toEqual([
        "PDF_STALE",
      ]);

      // Voiding revokes the link in the database (0013) and takes the invoice out of the
      // default report, which is what leaves the checks looking only at live work.
      await client.query(
        `update invoices set status = 'void', voided_at = now(), void_reason = 'fixture'
          where id = $1`,
        [invoiceId],
      );
      const afterVoid = await loadInvoiceHealthRows(client);
      expect(afterVoid).toHaveLength(0);
      const all = await loadInvoiceHealthRows(client, { includeVoid: true });
      expect(all).toHaveLength(1);
    } finally {
      await client.end();
    }
  });

  it("renders the seeded template with the invoice's own numbers", async () => {
    const client = await migratorClient();
    try {
      const loaded = await loadInvoiceMessageInput(client, invoiceNumber);
      expect(loaded).not.toBeNull();
      expect(loaded!.templateBody).toContain("{{amountDue}}");
      expect(loaded!.linkTtlDays).toBe(30);
      expect(loaded!.timezone).toBe("Asia/Colombo");

      // The shipped template asks for the link, so without one the message must refuse rather
      // than go out with `{{invoiceLink}}` in it.
      expect(buildInvoiceMessage({ templateBody: loaded!.templateBody, invoice: loaded!.invoice }))
        .toMatchObject({ sendable: false, reason: "TEMPLATE_INCOMPLETE" });

      const minted = await mintInvoiceLink(client, {
        invoiceId,
        guardianId,
        ttlDays: loaded!.linkTtlDays,
        createdBy: null,
      });
      expect(minted.url).toContain("/api/v1/public/invoices/");
      expect(minted.url).toContain(minted.token);

      const plan = buildInvoiceMessage({
        templateBody: loaded!.templateBody,
        invoice: loaded!.invoice,
        invoiceLink: minted.url,
      });
      expect(plan.sendable).toBe(true);
      if (!plan.sendable) return;
      expect(plan.text).toContain(invoiceNumber);
      expect(plan.text).toContain("LKR 4,000.00");
      expect(plan.text).toContain("08 Nov 2026");
      expect(plan.text).toContain(minted.url);
      expect(plan.text).not.toContain("{{");
      expect(plan.to).toBe("+94771234999");

      // The raw token is never written down — only its SHA-256 (FILES_AND_PDF §7).
      const stored = await client.query<{ token_hash: string; expires_at: Date }>(
        "select token_hash, expires_at from invoice_access_tokens where invoice_id = $1",
        [invoiceId],
      );
      expect(stored.rows).toHaveLength(1);
      expect(stored.rows[0]!.token_hash).not.toContain(minted.token);

      const live = await loadInvoiceHealthRows(client);
      expect(live[0]!.liveLinks).toBe(1);
    } finally {
      await client.end();
    }
  });

  it("says so when the invoice number does not exist", async () => {
    const client = await migratorClient();
    try {
      expect(await loadInvoiceMessageInput(client, "INV-2026-999999")).toBeNull();
    } finally {
      await client.end();
    }
  });
});
