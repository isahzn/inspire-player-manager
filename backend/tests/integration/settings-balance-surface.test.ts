/**
 * The M5 tail, driven through the real HTTP stack: `SET-04` (payment methods), `PLY-09`
 * (a player's invoices), `PLY-11` (a player's balance) and `GDN-06` (a guardian's balance).
 *
 * Two rules are the reason this file exists rather than trusting the handlers:
 *
 *  - **Credit is never netted into outstanding** (T-RPT-02, BILLING_ENGINE §12). A guardian
 *    holding credit while owing money must show both figures, not a difference.
 *  - **A payment-method `code` is immutable.** It is what a payment references, so it is
 *    deactivated, never renamed or deleted.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { createUser, errorCode, login, request } from "../helpers/auth.js";
import {
  closeTestPool,
  migratorClient,
  prepareTestDatabase,
  resetData,
  testApp,
} from "../helpers/test-db.js";

const OWNER_IP = "198.51.100.111";
const COACH_IP = "198.51.100.112";
const PAST_INSTANT = "2026-10-05T04:00:00.000Z";

interface InvoiceBody {
  id: string;
  invoiceNumber: string;
  status: string;
  balanceMinor: number;
  isOverdue: boolean;
  player: { id: string };
}
interface BalanceBody {
  outstandingMinor: number;
  overdueMinor: number;
  creditMinor: number;
  openInvoices?: InvoiceBody[];
}

describe("M5 tail: payment methods, player and guardian balances", () => {
  let app: FastifyInstance;
  let ownerId: string;
  let ownerCookie: string;
  let ownerCsrf: string;
  let coachCookie: string;
  let phoneSeq = 0;
  let keySeq = 0;
  let fixtureSeq = 0;

  const nextKey = (prefix: string) => `${prefix}-${(keySeq += 1)}-1a2b3c`;

  beforeAll(async () => {
    await prepareTestDatabase();
  });

  beforeEach(async () => {
    await resetData();
    await createUser({ username: "bal.owner", role: "owner" });
    const owner = await createUser({ username: "bal.owner2", role: "owner" });
    const coach = await createUser({ username: "bal.coach", role: "coach" });
    ownerId = owner.id;

    app = await testApp();
    const ownerSession = await login(app, owner.username, owner.password, OWNER_IP);
    ownerCookie = ownerSession.cookie;
    ownerCsrf = ownerSession.csrfToken;
    const coachSession = await login(app, coach.username, coach.password, COACH_IP);
    coachCookie = coachSession.cookie;
  });

  afterAll(async () => {
    await app.close();
    await closeTestPool();
  });

  async function createGroup(name: string) {
    const response = await request(app, {
      method: "POST",
      url: "/api/v1/age-groups",
      cookie: ownerCookie,
      csrf: ownerCsrf,
      payload: { name },
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json() as { id: string; name: string };
  }

  async function createPlayer(fullName: string, registrationDate: string, ageGroupId?: string) {
    phoneSeq += 1;
    const response = await request(app, {
      method: "POST",
      url: "/api/v1/players",
      cookie: ownerCookie,
      csrf: ownerCsrf,
      payload: {
        fullName,
        dateOfBirth: "2014-05-05",
        registrationDate,
        ...(ageGroupId ? { ageGroupId } : {}),
        guardians: [
          {
            fullName: `${fullName} Guardian`,
            phone: `0771235${String(100 + phoneSeq)}`,
            isPrimary: true,
            receivesInvoices: true,
          },
        ],
      },
    });
    expect(response.statusCode, response.body).toBe(201);
    const body = response.json() as { id: string; guardians: { guardian: { id: string } }[] };
    return { id: body.id, guardianId: body.guardians[0]!.guardian.id };
  }

  async function fixtureInvoice(playerId: string, guardianId: string, totalMinor: number, dueDate: string) {
    fixtureSeq += 1;
    const id = randomUUID();
    const number = `INV-2026-${String(800000 + fixtureSeq).padStart(6, "0")}`;
    const client = await migratorClient();
    try {
      await client.query("begin");
      await client.query(
        `insert into invoices
           (id, invoice_number, kind, player_id, guardian_id, issue_date, due_date, status,
            subtotal_minor, adjustments_minor, total_minor, paid_minor, snapshot, created_by)
         values ($1, $2, 'manual', $3, $4, '2025-12-01', $5::date, 'issued', $6, 0, $6, 0, '{}'::jsonb, $7)`,
        [id, number, playerId, guardianId, dueDate, totalMinor, ownerId],
      );
      await client.query(
        `insert into invoice_items
           (id, invoice_id, line_no, item_type, description, quantity, unit_amount_minor,
            amount_minor, created_by)
         values ($1, $2, 1, 'fee', 'Fixture fee', 1, $3, $3, $4)`,
        [randomUUID(), id, totalMinor, ownerId],
      );
      await client.query("commit");
    } catch (err) {
      await client.query("rollback").catch(() => undefined);
      throw err;
    } finally {
      await client.end();
    }
    return { id, number };
  }

  // =========================================================================
  // SET-04 — payment methods
  // =========================================================================
  it("lists, creates and updates payment methods without changing a code (SET-04)", async () => {
    // `payment_methods` is reference data `resetData` deliberately keeps, so clear the code
    // this test creates first — otherwise a second run would find it already present.
    const cleanup = await migratorClient();
    await cleanup.query("delete from payment_methods where code = 'cheque'");
    await cleanup.end();

    const list = await request(app, {
      method: "GET",
      url: "/api/v1/settings/payment-methods",
      cookie: ownerCookie,
    });
    expect(list.statusCode, list.body).toBe(200);
    const seeded = (list.json() as { data: { code: string }[] }).data.map((m) => m.code);
    expect(seeded).toEqual(expect.arrayContaining(["cash", "bank_transfer", "other"]));

    const created = await request(app, {
      method: "POST",
      url: "/api/v1/settings/payment-methods",
      cookie: ownerCookie,
      csrf: ownerCsrf,
      payload: { code: "cheque", label: "Cheque", requiresReference: true },
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json()).toEqual({
      code: "cheque",
      label: "Cheque",
      requiresReference: true,
      isActive: true,
    });

    // The code is the identity: a duplicate is refused.
    const duplicate = await request(app, {
      method: "POST",
      url: "/api/v1/settings/payment-methods",
      cookie: ownerCookie,
      csrf: ownerCsrf,
      payload: { code: "cheque", label: "Another cheque" },
    });
    expect(duplicate.statusCode, duplicate.body).toBe(422);

    // Deactivate rather than delete: a payment referencing this code stays explainable.
    const updated = await request(app, {
      method: "PATCH",
      url: "/api/v1/settings/payment-methods/cheque",
      cookie: ownerCookie,
      csrf: ownerCsrf,
      payload: { label: "Bank cheque", isActive: false },
    });
    expect(updated.statusCode, updated.body).toBe(200);
    expect(updated.json()).toEqual({
      code: "cheque",
      label: "Bank cheque",
      requiresReference: true,
      isActive: false,
    });

    // The inactive method is still listed.
    const after = await request(app, {
      method: "GET",
      url: "/api/v1/settings/payment-methods",
      cookie: ownerCookie,
    });
    expect(
      (after.json() as { data: { code: string; isActive: boolean }[] }).data.find(
        (m) => m.code === "cheque",
      )?.isActive,
    ).toBe(false);

    const unknown = await request(app, {
      method: "PATCH",
      url: "/api/v1/settings/payment-methods/nope",
      cookie: ownerCookie,
      csrf: ownerCsrf,
      payload: { label: "Nope" },
    });
    expect(unknown.statusCode).toBe(404);

    const coach = await request(app, {
      method: "GET",
      url: "/api/v1/settings/payment-methods",
      cookie: coachCookie,
    });
    expect(coach.statusCode).toBe(403);
  });

  // =========================================================================
  // PLY-09 / PLY-11 — a player's invoices and balance
  // =========================================================================
  it("reports a player's invoices, outstanding, overdue and credit separately (PLY-09/11)", async () => {
    const group = await createGroup("Under 12");
    const player = await createPlayer("Balance Player", "2026-01-01", group.id);

    const overdue = await fixtureInvoice(player.id, player.guardianId, 300_000, "2026-01-01");
    const future = await fixtureInvoice(player.id, player.guardianId, 200_000, "2099-01-01");

    // A confirmed payment with nothing allocated is credit, not a payment against a bill.
    const payment = await request(app, {
      method: "POST",
      url: "/api/v1/payments",
      cookie: ownerCookie,
      csrf: ownerCsrf,
      headers: { "idempotency-key": nextKey("pay") },
      payload: {
        amountMinor: 100_000,
        methodCode: "cash",
        receivedAt: PAST_INSTANT,
        payerGuardianId: player.guardianId,
        status: "confirmed",
      },
    });
    expect(payment.statusCode, payment.body).toBe(201);

    const invoices = await request(app, {
      method: "GET",
      url: `/api/v1/players/${player.id}/invoices`,
      cookie: ownerCookie,
    });
    expect(invoices.statusCode, invoices.body).toBe(200);
    const page = invoices.json() as { data: InvoiceBody[]; meta: { total: number } };
    expect(page.meta.total).toBe(2);
    expect(page.data.map((row) => row.id).sort()).toEqual([overdue.id, future.id].sort());

    const balance = await request(app, {
      method: "GET",
      url: `/api/v1/players/${player.id}/balance`,
      cookie: ownerCookie,
    });
    expect(balance.statusCode, balance.body).toBe(200);
    const body = balance.json() as BalanceBody;
    expect(body.outstandingMinor).toBe(500_000);
    expect(body.overdueMinor).toBe(300_000);
    // Credit is reported on its own line, never subtracted from outstanding.
    expect(body.creditMinor).toBe(100_000);

    // A coach holds neither permission nor an RLS policy on invoices.
    const coach = await request(app, {
      method: "GET",
      url: `/api/v1/players/${player.id}/balance`,
      cookie: coachCookie,
    });
    expect(coach.statusCode).toBe(403);
  });

  // =========================================================================
  // GDN-06 — a guardian's balance
  // =========================================================================
  it("reports a guardian's balance across their players with the open invoices (GDN-06)", async () => {
    const group = await createGroup("Under 12");
    const first = await createPlayer("Guardian Child One", "2026-01-01", group.id);
    const second = await createPlayer("Guardian Child Two", "2026-01-01", group.id);

    // Link the second child to the first child's guardian, so the balance really spans players.
    const link = await request(app, {
      method: "POST",
      url: `/api/v1/players/${second.id}/guardians`,
      cookie: ownerCookie,
      csrf: ownerCsrf,
      payload: { guardianId: first.guardianId, isPrimary: true, receivesInvoices: true },
    });
    expect(link.statusCode, link.body).toBe(201);

    const openInvoice = await fixtureInvoice(first.id, first.guardianId, 300_000, "2026-01-01");
    await fixtureInvoice(second.id, first.guardianId, 150_000, "2099-01-01");

    const balance = await request(app, {
      method: "GET",
      url: `/api/v1/guardians/${first.guardianId}/balance`,
      cookie: ownerCookie,
    });
    expect(balance.statusCode, balance.body).toBe(200);
    const body = balance.json() as BalanceBody;
    expect(body.outstandingMinor).toBe(450_000);
    expect(body.overdueMinor).toBe(300_000);
    expect(body.creditMinor).toBe(0);
    expect(body.openInvoices).toHaveLength(2);
    // The detail is the open invoices behind the outstanding figure, oldest due first.
    expect(body.openInvoices![0]!.id).toBe(openInvoice.id);
    expect(body.openInvoices![0]!.isOverdue).toBe(true);

    const coach = await request(app, {
      method: "GET",
      url: `/api/v1/guardians/${first.guardianId}/balance`,
      cookie: coachCookie,
    });
    expect(coach.statusCode).toBe(403);
    expect(errorCode(coach)).toBe("FORBIDDEN");
  });
});
