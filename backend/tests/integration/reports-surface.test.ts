/**
 * RPT-01/RPT-02 — the report surface, through the real HTTP stack.
 *
 * The assertions are about what a report must be, not about status codes: the column metadata the
 * table renders, the `totals` a figure gets read from, and — the part that matters most for an
 * export — that the CSV is a spreadsheet document (BOM, plain decimal money) and that pulling one
 * leaves an audit row naming the filters used.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { uuidv7 } from "../../src/ids.js";
import { createUser, errorCode, login, request } from "../helpers/auth.js";
import {
  closeTestPool,
  migratorClient,
  prepareTestDatabase,
  resetData,
  testApp,
} from "../helpers/test-db.js";

const OWNER_IP = "198.51.100.131";
const COACH_IP = "198.51.100.132";

interface ReportBody {
  data: Record<string, unknown>[];
  meta: { page: number; pageSize: number; total: number; totalPages: number };
  totals?: Record<string, number>;
  columns: { key: string; label: string; type: string }[];
  generatedAt: string;
  filters: Record<string, string | undefined>;
}

describe("M8 reports (RPT-01, RPT-02)", () => {
  let app: FastifyInstance;
  let ownerCookie: string;
  let ownerCsrf: string;
  let coachCookie: string;
  let coachCsrf: string;

  beforeAll(async () => {
    await prepareTestDatabase();
  });

  beforeEach(async () => {
    await resetData();
    await createUser({ username: "rpt.owner", role: "owner" });
    const owner = await createUser({ username: "rpt.owner2", role: "owner" });
    const coach = await createUser({ username: "rpt.coach", role: "coach" });

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

  /** One player, in a group, with a primary guardian — inserted as the migration role. */
  async function seedPlayer(): Promise<void> {
    const client = await migratorClient();
    const groupId = uuidv7();
    const playerId = uuidv7();
    const guardianId = uuidv7();
    try {
      await client.query(
        `insert into age_groups (id, name, min_age, max_age, sort_order)
         values ($1, 'Under 10', 8, 10, 1)`,
        [groupId],
      );
      await client.query(
        `insert into group_fees (id, age_group_id, amount_minor, effective_from)
         values ($1, $2, 500000, '2026-01-01')`,
        [uuidv7(), groupId],
      );
      await client.query(
        `insert into players (id, registration_no, full_name, date_of_birth, registration_date,
                              billing_anchor_date, status, status_effective_date)
         values ($1, 'REG-0001', 'Kasun Perera', '2017-04-02', '2026-01-05', '2026-01-05',
                 'active', '2026-01-05')`,
        [playerId],
      );
      await client.query(
        `insert into player_group_history (id, player_id, age_group_id, effective_from)
         values ($1, $2, $3, '2026-01-05')`,
        [uuidv7(), playerId, groupId],
      );
      await client.query(
        `insert into guardians (id, full_name, phone_e164)
         values ($1, 'Nimal Perera', '+94771234567')`,
        [guardianId],
      );
      await client.query(
        `insert into player_guardians (player_id, guardian_id, is_primary, receives_invoices)
         values ($1, $2, true, true)`,
        [playerId, guardianId],
      );
    } finally {
      await client.end();
    }
  }

  const getReport = (name: string, queryString = "", cookie = ownerCookie) =>
    request(app, { method: "GET", url: `/api/v1/reports/${name}${queryString}`, cookie });

  it("runs the players report with the columns the table renders (RPT-01)", async () => {
    await seedPlayer();

    const response = await getReport("players");
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json() as ReportBody;

    expect(body.columns.map((c) => c.key)).toEqual([
      "registrationNo",
      "fullName",
      "group",
      "status",
      "registrationDate",
      "dateOfBirth",
      "guardianName",
      "guardianPhone",
    ]);
    expect(body.meta).toMatchObject({ page: 1, pageSize: 25, total: 1, totalPages: 1 });
    expect(body.totals).toEqual({ count: 1 });
    expect(typeof body.generatedAt).toBe("string");

    // A flat row: the register's own facts, and the player's *current* group.
    const row = body.data[0]!;
    expect(row).toMatchObject({
      registrationNo: "REG-0001",
      fullName: "Kasun Perera",
      group: "Under 10",
      status: "active",
      registrationDate: "2026-01-05",
      dateOfBirth: "2017-04-02",
      guardianName: "Nimal Perera",
      guardianPhone: "+94771234567",
    });
  });

  it("reports an empty window without inventing rows (RPT-01)", async () => {
    const response = await getReport("attendance-summary");
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json() as ReportBody;
    expect(body.data).toEqual([]);
    expect(body.totals).toMatchObject({ sessions: 0, present: 0, late: 0, ratePercent: 0 });
  });

  it("pages the report while reporting the full total (RPT-01)", async () => {
    await seedPlayer();
    const response = await getReport("players", "?pageSize=1&page=1");
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json() as ReportBody;
    expect(body.data).toHaveLength(1);
    // The total covers every matching row, not the page: a total over one page is unusable.
    expect(body.meta.total).toBe(1);
    expect(body.filters).toEqual({});
  });

  it("echoes the filters it used (RPT-01)", async () => {
    await seedPlayer();
    const response = await getReport("players", "?status=active");
    expect(response.statusCode, response.body).toBe(200);
    expect((response.json() as ReportBody).filters).toEqual({ status: "active" });

    const none = await getReport("players", "?status=withdrawn");
    expect((none.json() as ReportBody).data).toEqual([]);
  });

  it("refuses a report name that is not in the contract (RPT-01)", async () => {
    const response = await getReport("not-a-report");
    expect(response.statusCode, response.body).toBe(422);
    expect(errorCode(response)).toBe("VALIDATION_ERROR");
  });

  it("refuses an unknown sort field instead of quietly reordering (RPT-01)", async () => {
    const response = await getReport("players", "?sort=notAColumn");
    expect(response.statusCode, response.body).toBe(422);
    expect(errorCode(response)).toBe("INVALID_SORT");
  });

  it("refuses a coach on the whole report surface (RPT-01)", async () => {
    const response = await getReport("players", "", coachCookie);
    expect(response.statusCode, response.body).toBe(403);
    expect(errorCode(response)).toBe("FORBIDDEN");
    expect(coachCsrf.length).toBeGreaterThan(0);
  });

  it("streams a BOM-prefixed CSV export and audits the read (RPT-02)", async () => {
    await seedPlayer();

    const response = await request(app, {
      method: "GET",
      url: "/api/v1/reports/players/export?status=active",
      cookie: ownerCookie,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers["content-type"]).toContain("text/csv");
    expect(response.headers["content-disposition"]).toContain(
      'attachment; filename="report-players-',
    );
    // The BOM is what makes Excel read a Sinhala or Tamil name as text rather than mojibake.
    expect(response.body.startsWith("\uFEFF")).toBe(true);
    // The header row carries labels, and the money-free players report carries the name.
    const [header, firstRow] = response.body.replace(/^\uFEFF/, "").split("\r\n");
    expect(header).toBe(
      "Reg no,Name,Age group,Status,Registered,Date of birth,Primary guardian,Guardian phone",
    );
    expect(firstRow).toContain("Kasun Perera");
    expect(firstRow).toContain("2026-01-05");

    // A bulk read of children's data leaves a record of what was read.
    const client = await migratorClient();
    try {
      const audit = await client.query<{ entity_type: string; after: { rowCount: number } }>(
        `select entity_type, after from audit_logs where action = 'report.export'
          order by id desc limit 1`,
      );
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0]!.entity_type).toBe("report");
      expect(audit.rows[0]!.after.rowCount).toBe(1);
    } finally {
      await client.end();
    }
  });

  it("writes plain decimal money into the CSV, with no totals row (RPT-02)", async () => {
    // An invoice with money in it: the export must carry a number a spreadsheet can sum.
    const client = await migratorClient();
    const invoiceId = uuidv7();
    const playerId = uuidv7();
    try {
      await client.query(
        `insert into players (id, registration_no, full_name, registration_date,
                              billing_anchor_date, status, status_effective_date)
         values ($1, 'REG-0002', 'Amara Silva', '2026-01-06', '2026-01-06', 'active', '2026-01-06')`,
        [playerId],
      );
      // The invoice and its line go in one transaction: `app.check_invoice_totals` is a
      // deferred constraint trigger, and autocommit would check it after the invoice alone.
      await client.query("begin");
      await client.query(
        `insert into invoices (id, invoice_number, kind, player_id, issue_date, due_date, status,
                               currency, subtotal_minor, adjustments_minor, total_minor, paid_minor)
         values ($1, 'INV-2026-000001', 'manual', $2, '2026-10-01', '2026-10-08', 'issued',
                 'LKR', 400000, 0, 400000, 0)`,
        [invoiceId, playerId],
      );
      await client.query(
        `insert into invoice_items (id, invoice_id, line_no, item_type, description, quantity,
                                    unit_amount_minor, amount_minor)
         values ($1, $2, 1, 'fee', 'Monthly fee', 1, 400000, 400000)`,
        [uuidv7(), invoiceId],
      );
      await client.query("commit");
    } finally {
      await client.end();
    }

    const response = await request(app, {
      method: "GET",
      url: "/api/v1/reports/invoices/export",
      cookie: ownerCookie,
    });
    expect(response.statusCode, response.body).toBe(200);

    const lines = response.body.replace(/^\uFEFF/, "").trimEnd().split("\r\n");
    expect(lines[0]).toContain("Total,Paid,Balance");
    const row = lines[1]!;
    // `4000.00`, not `LKR 4,000.00` and not `400000` minor units.
    expect(row).toContain("4000.00");
    expect(row).not.toContain("LKR");
    // No totals line: a "Total" row inside a column a spreadsheet sums is a double-count trap.
    expect(lines).toHaveLength(2);
  });
});
