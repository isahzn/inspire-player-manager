/**
 * M6 — the invoice PDF surface (INV-06/INV-07), through the real HTTP stack.
 *
 * The point of this file is that a **status code is not evidence on a document**. So every
 * claim here is checked against something other than the response:
 *
 *  - "the PDF exists" means the bytes start with `%PDF-` and carry the invoice's own facts —
 *    its number, the player's name, the formatted amount and the due date are read back **out
 *    of the document**, not out of the JSON;
 *  - "not ready" means `409 PDF_NOT_READY` **and** a `Retry-After` the client can act on;
 *  - "regenerate did not duplicate" means the `files` rows for that invoice are counted
 *    before and after, because INV-07 must leave no second copy when nothing changed;
 *  - "the read was audited" means the `audit_logs` rows are queried.
 *
 * The stored-object path is the real one (`FILES_DIR` → a scratch `var/` directory), so the
 * test also covers the storage adapter writing and reading the bytes it just produced.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { inflateSync } from "node:zlib";
import type { FastifyInstance } from "fastify";
import { createUser, errorCode, login, request } from "../helpers/auth.js";
import {
  closeTestPool,
  migratorClient,
  prepareTestDatabase,
  resetData,
  testApp,
} from "../helpers/test-db.js";

const OWNER_IP = "198.51.100.201";
const COACH_IP = "198.51.100.202";

/** A manual invoice's amount: whole rupees, so no fractional-money rule is in play. */
const AMOUNT = 400_000;

/**
 * Decodes the text a PDF actually prints.
 *
 * PDFKit writes every shown string as hex inside a `[<…>] TJ` array, one byte per character
 * for a standard font, and the content streams here are uncompressed. Reading the document
 * back this way is what makes "the invoice number is on the invoice" a real assertion rather
 * than a check that a file exists.
 */
function pdfText(bytes: Buffer): string {
  const raw = bytes.toString("latin1");
  const out: string[] = [];
  let cursor = 0;

  for (;;) {
    const at = raw.indexOf("stream", cursor);
    if (at < 0) break;
    cursor = at + "stream".length;
    if (raw.slice(Math.max(0, at - 3), at) === "end") continue;
    const end = raw.indexOf("endstream", cursor);
    if (end < 0) break;
    const dict = raw.slice(Math.max(0, raw.lastIndexOf("<<", at)), at);

    let start = cursor;
    if (raw[start] === "\r") start += 1;
    if (raw[start] === "\n") start += 1;
    const slice = Buffer.from(raw.slice(start, end), "latin1");
    cursor = end + "endstream".length;

    if (dict.includes("/Subtype /Image") || dict.includes("/DCTDecode")) continue;
    const content = dict.includes("/FlateDecode")
      ? inflateSync(slice).toString("latin1")
      : slice.toString("latin1");

    for (const arrayMatch of content.matchAll(/\[([^\]]*)\] TJ/g)) {
      for (const hexMatch of arrayMatch[1]!.matchAll(/<([0-9A-Fa-f\s]+)>/g)) {
        const hex = hexMatch[1]!.replace(/\s+/g, "");
        if (hex.length % 2 !== 0) continue;
        out.push(Buffer.from(hex, "hex").toString("latin1"));
      }
    }
  }
  return out.join("");
}

describe("M6 invoice PDF surface (INV-06/INV-07)", () => {
  let app: FastifyInstance;
  let ownerCookie: string;
  let ownerCsrf: string;
  let coachCookie: string;
  let coachCsrf: string;
  let keySeq = 0;

  function nextKey(prefix: string): string {
    keySeq += 1;
    return `${prefix}-${keySeq}-7c1d4e`;
  }

  beforeAll(async () => {
    await prepareTestDatabase();
  });

  beforeEach(async () => {
    await resetData();
    await createUser({ username: "pdf.owner", role: "owner" });
    const owner = await createUser({ username: "pdf.owner2", role: "owner" });
    const coach = await createUser({ username: "pdf.coach", role: "coach" });

    app = await testApp();
    const ownerSession = await login(app, owner.username, owner.password, OWNER_IP);
    ownerCookie = ownerSession.cookie;
    ownerCsrf = ownerSession.csrfToken;
    const coachSession = await login(app, coach.username, coach.password, COACH_IP);
    coachCookie = coachSession.cookie;
    coachCsrf = coachSession.csrfToken;
  });

  afterAll(async () => {
    await app.close();
    await closeTestPool();
  });

  /** A group, a player in it, and a manual invoice — the shortest path to a real invoice. */
  async function invoiceFixture(): Promise<{
    invoiceId: string;
    invoiceNumber: string;
    playerId: string;
    guardianId: string;
    dueDate: string;
  }> {
    const group = await request(app, {
      method: "POST",
      url: "/api/v1/age-groups",
      cookie: ownerCookie,
      csrf: ownerCsrf,
      payload: { name: "U12" },
    });
    expect(group.statusCode, group.body).toBe(201);
    const groupId = (group.json() as { id: string }).id;

    const player = await request(app, {
      method: "POST",
      url: "/api/v1/players",
      cookie: ownerCookie,
      csrf: ownerCsrf,
      payload: {
        fullName: "Nimal Perera",
        dateOfBirth: "2014-05-05",
        registrationDate: "2026-09-01",
        ageGroupId: groupId,
        guardians: [
          {
            fullName: "Sunil Perera",
            phone: "0771234501",
            isPrimary: true,
            receivesInvoices: true,
          },
        ],
      },
    });
    expect(player.statusCode, player.body).toBe(201);
    const playerBody = player.json() as {
      id: string;
      guardians: { guardian: { id: string } }[];
    };

    const dueDate = "2026-11-08";
    const created = await request(app, {
      method: "POST",
      url: "/api/v1/invoices",
      cookie: ownerCookie,
      csrf: ownerCsrf,
      headers: { "idempotency-key": nextKey("inv") },
      payload: { playerId: playerBody.id, description: "Equipment deposit", amountMinor: AMOUNT, dueDate },
    });
    expect(created.statusCode, created.body).toBe(201);
    const invoice = created.json() as { id: string; invoiceNumber: string };

    return {
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      playerId: playerBody.id,
      guardianId: playerBody.guardians[0]!.guardian.id,
      dueDate,
    };
  }

  async function fileCount(invoiceId: string): Promise<number> {
    const client = await migratorClient();
    try {
      const result = await client.query<{ count: string }>(
        `select count(*)::text as count
           from files f
           join invoices i on i.pdf_file_id = f.id
          where i.id = $1`,
        [invoiceId],
      );
      const all = await client.query<{ count: string }>(
        `select count(*)::text as count from files where kind = 'invoice_pdf' and storage_key like $1`,
        [`invoices/%/${invoiceId}/%`],
      );
      // Both halves matter: one row is *linked* to the invoice, while a duplicate would show
      // up in the second count as a stored object nobody points at.
      return Number(result.rows[0]!.count) + Number(all.rows[0]!.count);
    } finally {
      await client.end();
    }
  }

  async function auditActions(entityId: string): Promise<string[]> {
    const client = await migratorClient();
    try {
      const result = await client.query<{ action: string }>(
        `select action from audit_logs where entity_type = 'invoice' and entity_id = $1
          order by occurred_at asc`,
        [entityId],
      );
      return result.rows.map((row) => row.action);
    } finally {
      await client.end();
    }
  }

  it("refuses to read a PDF that does not exist yet, and says when to come back (INV-06)", async () => {
    const fixture = await invoiceFixture();

    const response = await request(app, {
      method: "GET",
      url: `/api/v1/invoices/${fixture.invoiceId}/pdf`,
      cookie: ownerCookie,
    });

    expect(response.statusCode, response.body).toBe(409);
    expect(errorCode(response)).toBe("PDF_NOT_READY");
    // The whole point of the 409 rather than a 404: the client is told to try again, and when.
    expect(response.headers["retry-after"]).toBe("2");
    // Nothing was written by a read.
    expect(await fileCount(fixture.invoiceId)).toBe(0);
  });

  it("regenerates, then streams a real PDF carrying the invoice's own facts (INV-07 → INV-06)", async () => {
    const fixture = await invoiceFixture();

    const regenerated = await request(app, {
      method: "POST",
      url: `/api/v1/invoices/${fixture.invoiceId}/pdf/regenerate`,
      cookie: ownerCookie,
      csrf: ownerCsrf,
    });
    expect(regenerated.statusCode, regenerated.body).toBe(202);

    const downloaded = await request(app, {
      method: "GET",
      url: `/api/v1/invoices/${fixture.invoiceId}/pdf`,
      cookie: ownerCookie,
    });
    expect(downloaded.statusCode, downloaded.body).toBe(200);
    expect(downloaded.headers["content-type"]).toContain("application/pdf");
    expect(downloaded.headers["content-disposition"]).toContain(fixture.invoiceNumber);
    // An audited sensitive document is never left in a shared cache.
    expect(downloaded.headers["cache-control"]).toBe("no-store");

    const bytes = downloaded.rawPayload as Buffer;
    expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");

    const text = pdfText(bytes);
    expect(text).toContain(fixture.invoiceNumber);
    expect(text).toContain("Nimal Perera");
    // The guardian's own document prints the full number (FILES_AND_PDF §2).
    expect(text).toContain("Sunil Perera");
    // Amounts are `LKR 4,000.00`: two decimals and thousands separators, always.
    expect(text).toContain("LKR 4,000.00");
    expect(text).toContain("08 Nov 2026");
    expect(text).toContain("INVOICE");

    // The read and the rebuild were both audited, because both are sensitive operations.
    const actions = await auditActions(fixture.invoiceId);
    expect(actions).toContain("invoice.pdf.regenerate");
    expect(actions).toContain("invoice.pdf.read");
  });

  it("does not leave a second copy when nothing has changed (INV-07 twice)", async () => {
    const fixture = await invoiceFixture();

    const first = await request(app, {
      method: "POST",
      url: `/api/v1/invoices/${fixture.invoiceId}/pdf/regenerate`,
      cookie: ownerCookie,
      csrf: ownerCsrf,
    });
    expect(first.statusCode, first.body).toBe(202);
    const afterFirst = await fileCount(fixture.invoiceId);
    expect(afterFirst).toBe(2); // 1 linked row + 1 stored object

    const second = await request(app, {
      method: "POST",
      url: `/api/v1/invoices/${fixture.invoiceId}/pdf/regenerate`,
      cookie: ownerCookie,
      csrf: ownerCsrf,
    });
    expect(second.statusCode, second.body).toBe(202);
    // Same input, same `pdf_input_hash`, so the same document — not a third file.
    expect(await fileCount(fixture.invoiceId)).toBe(afterFirst);
  });

  it("rebuilds a voided invoice with its watermark after a void flags it stale (INV-07 after INV-04)", async () => {
    const fixture = await invoiceFixture();

    await request(app, {
      method: "POST",
      url: `/api/v1/invoices/${fixture.invoiceId}/pdf/regenerate`,
      cookie: ownerCookie,
      csrf: ownerCsrf,
    });
    const before = pdfText(
      (
        await request(app, {
          method: "GET",
          url: `/api/v1/invoices/${fixture.invoiceId}/pdf`,
          cookie: ownerCookie,
        })
      ).rawPayload as Buffer,
    );
    expect(before).not.toContain("VOID");

    const read = await request(app, {
      method: "GET",
      url: `/api/v1/invoices/${fixture.invoiceId}`,
      cookie: ownerCookie,
    });
    const version = (read.json() as { version: number }).version;

    const voided = await request(app, {
      method: "POST",
      url: `/api/v1/invoices/${fixture.invoiceId}/void`,
      cookie: ownerCookie,
      csrf: ownerCsrf,
      headers: { "idempotency-key": nextKey("void") },
      payload: { reason: "issued in error", version },
    });
    expect(voided.statusCode, voided.body).toBe(200);

    // The void is a regeneration trigger (§2), so INV-06 stops serving the stale document …
    const stale = await request(app, {
      method: "GET",
      url: `/api/v1/invoices/${fixture.invoiceId}/pdf`,
      cookie: ownerCookie,
    });
    expect(stale.statusCode, stale.body).toBe(409);

    // … and rebuilding prints the void, without changing the number.
    await request(app, {
      method: "POST",
      url: `/api/v1/invoices/${fixture.invoiceId}/pdf/regenerate`,
      cookie: ownerCookie,
      csrf: ownerCsrf,
    });
    const after = pdfText(
      (
        await request(app, {
          method: "GET",
          url: `/api/v1/invoices/${fixture.invoiceId}/pdf`,
          cookie: ownerCookie,
        })
      ).rawPayload as Buffer,
    );
    expect(after).toContain("VOID");
    expect(after).toContain(fixture.invoiceNumber);
  });

  it("lets nobody without files:read_sensitive near a document, and hides an unknown invoice (INV-06)", async () => {
    const fixture = await invoiceFixture();
    await request(app, {
      method: "POST",
      url: `/api/v1/invoices/${fixture.invoiceId}/pdf/regenerate`,
      cookie: ownerCookie,
      csrf: ownerCsrf,
    });

    const asCoach = await request(app, {
      method: "GET",
      url: `/api/v1/invoices/${fixture.invoiceId}/pdf`,
      cookie: coachCookie,
    });
    expect(asCoach.statusCode, asCoach.body).toBe(403);

    // A coach cannot regenerate either — the guard runs before the handler.
    const coachRegenerate = await request(app, {
      method: "POST",
      url: `/api/v1/invoices/${fixture.invoiceId}/pdf/regenerate`,
      cookie: coachCookie,
      csrf: coachCsrf,
    });
    expect(coachRegenerate.statusCode, coachRegenerate.body).toBe(403);

    const missing = await request(app, {
      method: "GET",
      url: `/api/v1/invoices/${randomUUID()}/pdf`,
      cookie: ownerCookie,
    });
    expect(missing.statusCode, missing.body).toBe(404);
  });
});
