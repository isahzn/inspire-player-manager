/**
 * DSH-01 — the owner dashboard, through the real HTTP stack.
 *
 * The assertions are about the two rules the page exists to keep, plus the honesty of the parts
 * that have no source yet:
 *
 *  - **invoiced ≠ collected** — they are separate keys, and with one issued invoice and no
 *    confirmed payment the first moves and the second stays zero;
 *  - **coach time is coach time** — a still-open check-in is not worked minutes (T-ATT-11);
 *  - **the unbuilt half says so** — `message_jobs` does not exist until M7, so the messaging
 *    block reports the `unknown` session label and zero failures out of zero jobs, and the
 *    alert strip reports the missing worker rather than pretending one has run.
 *
 * Fixtures are inserted through the migrator role (`migratorClient`) rather than the billing
 * endpoints: DSH-01 reads aggregates, and driving a whole billing run to produce one invoice
 * would make this file a second copy of `billing-surface.test.ts` while testing less of DSH-01.
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

const OWNER_IP = "198.51.100.171";
const COACH_IP = "198.51.100.172";

const FEE = 400_000;

interface AlertBody {
  code: string;
  severity: "info" | "warning" | "critical";
  message: string;
  link?: string;
}
interface DashboardBody {
  range: { from: string; to: string };
  players: {
    active: number;
    inactive: number;
    withdrawn: number;
    byGroup: { ageGroupId: string; name: string; count: number }[];
  };
  coachTime: {
    checkedInNow: { coach: { id: string }; elapsedMinutes: number }[];
    todayMinutes: number;
    weekMinutes: number;
    openNeedingCorrection: number;
  };
  sessions: {
    today: { id: string }[];
    next7Days: { id: string }[];
    todayAttendance: {
      present: number;
      absent: number;
      late: number;
      excused: number;
      unmarked: number;
    };
  };
  money: {
    invoicedMinor: number;
    invoicesIssuedCount: number;
    collectedMinor: number;
    outstandingMinor: number;
    overdueMinor: number;
    overdueCount: number;
    dueSoon: { days: number; count: number; totalMinor: number };
    creditHeldMinor: number;
  };
  messaging: {
    automationEnabled: boolean;
    automations: {
      invoiceDelivery: boolean;
      reminderPreDue: boolean;
      reminderOverdue: boolean;
      proofCheck: boolean;
    };
    sessionStatus: string;
    failed24h: number;
    dead: number;
    needsReview: number;
  };
  alerts: AlertBody[];
}

/** Business-date arithmetic on `YYYY-MM-DD`, the same day counting `due_date + N` does. */
function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

describe("M8 owner dashboard (DSH-01)", () => {
  let app: FastifyInstance;
  let ownerCookie: string;
  let ownerCsrf: string;
  let coachCookie: string;
  /** The academy's own today, read from the same expression the route uses. */
  let today: string;
  let groupName: string;
  let fixtureSeq = 0;

  beforeAll(async () => {
    await prepareTestDatabase();
  });

  beforeEach(async () => {
    await resetData();
    await createUser({ username: "dsh1.owner", role: "owner" });
    const owner = await createUser({ username: "dsh1.owner2", role: "owner" });
    const coach = await createUser({ username: "dsh1.coach", role: "coach" });

    app = await testApp();
    const ownerSession = await login(app, owner.username, owner.password, OWNER_IP);
    ownerCookie = ownerSession.cookie;
    ownerCsrf = ownerSession.csrfToken;
    const coachSession = await login(app, coach.username, coach.password, COACH_IP);
    coachCookie = coachSession.cookie;

    // `job_runs`/`worker_heartbeats` are not in `resetData`'s truncate list (the worker owns
    // them and they are not fixture data), so a worker test file that ran before this one would
    // otherwise leave a fresh heartbeat behind and make the WORKER_STALE assertion flaky.
    const client = await migratorClient();
    try {
      await client.query("delete from job_runs");
      await client.query("delete from worker_heartbeats");
      const academy = await client.query<{ today: string }>(
        `select (now() at time zone timezone)::date::text as today from academy_settings where id = 1`,
      );
      today = academy.rows[0]!.today;
    } finally {
      await client.end();
    }

    fixtureSeq += 1;
    groupName = `DSH1 Group ${fixtureSeq}`;
  });

  afterAll(async () => {
    await app.close();
    await closeTestPool();
  });

  const readDashboard = (cookie = ownerCookie) =>
    request(app, { method: "GET", url: "/api/v1/dashboard/owner", cookie });

  /**
   * One group, one active player in it and one issued invoice for that player — the smallest
   * world in which every block of the dashboard has something true to say.
   */
  async function seedPlayerAndInvoice(): Promise<{ groupId: string; invoiceId: string }> {
    const client = await migratorClient();
    try {
      // One transaction for the whole fixture, and it is not optional: `app.check_invoice_totals`
      // is a **deferred** constraint trigger, so it fires at COMMIT. An autocommitted invoice
      // insert would be checked before its line exists and be refused ("totals do not match its
      // lines").
      await client.query("begin");
      const groupId = randomUUID();
      await client.query(
        `insert into age_groups (id, name, sort_order) values ($1, $2, 0)`,
        [groupId, groupName],
      );

      const playerId = randomUUID();
      await client.query(
        `insert into players
           (id, registration_no, full_name, registration_date, billing_anchor_date,
            status, status_effective_date)
         values ($1, $2, 'Dash Player', $3::date, $3::date, 'active', $3::date)`,
        [playerId, `IA-9${fixtureSeq}01`, today],
      );
      await client.query(
        `insert into player_group_history (id, player_id, age_group_id, effective_from)
         values ($1, $2, $3, $4::date)`,
        [randomUUID(), playerId, groupId, today],
      );

      const invoiceId = randomUUID();
      // Issued inside the dashboard's default range (the academy's current month) and due in
      // `DUE_SOON_DAYS`, so it lands in `invoicedMinor` *and* in `dueSoon`, and is not overdue.
      await client.query(
        `insert into invoices
           (id, invoice_number, kind, player_id, period_start, period_end, issue_date, due_date,
            status, currency, subtotal_minor, adjustments_minor, total_minor, paid_minor)
         values ($1, $2, 'periodic', $3, $4::date, $4::date, $4::date, $5::date,
                 'issued', 'LKR', $6, 0, $6, 0)`,
        [invoiceId, `INV-2026-9${fixtureSeq}001`, playerId, today, addDays(today, 7), FEE],
      );
      await client.query(
        `insert into invoice_items
           (id, invoice_id, line_no, item_type, description, quantity, unit_amount_minor,
            amount_minor)
         values ($1, $2, 1, 'fee', 'Monthly fee', 1, $3, $3)`,
        [randomUUID(), invoiceId, FEE],
      );

      await client.query("commit");
      return { groupId, invoiceId };
    } catch (err) {
      await client.query("rollback").catch(() => undefined);
      throw err;
    } finally {
      await client.end();
    }
  }

  it("answers every block, and defaults the range to the academy's current month (DSH-01)", async () => {
    const response = await readDashboard();
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json() as DashboardBody;

    expect(body.range.to).toBe(today);
    expect(body.range.from).toBe(`${today.slice(0, 7)}-01`);
    expect(body.players).toBeDefined();
    expect(body.coachTime).toBeDefined();
    expect(body.sessions.today).toEqual([]);
    expect(body.sessions.next7Days).toEqual([]);
    expect(body.sessions.todayAttendance).toEqual({
      present: 0,
      absent: 0,
      late: 0,
      excused: 0,
      unmarked: 0,
    });
    expect(body.money.collectedMinor).toBe(0);
    expect(body.money.creditHeldMinor).toBe(0);
  });

  it("counts the register, the group and the issued invoice, with invoiced ≠ collected (DSH-01)", async () => {
    const { groupId } = await seedPlayerAndInvoice();

    const response = await readDashboard();
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json() as DashboardBody;

    expect(body.players.active).toBe(1);
    expect(body.players.inactive).toBe(0);
    expect(body.players.withdrawn).toBe(0);
    expect(body.players.byGroup).toContainEqual({
      ageGroupId: groupId,
      name: groupName,
      count: 1,
    });

    // Invoiced moved, collected did not: they are different sources, never one "revenue".
    expect(body.money.invoicedMinor).toBe(FEE);
    expect(body.money.invoicesIssuedCount).toBe(1);
    expect(body.money.collectedMinor).toBe(0);

    expect(body.money.outstandingMinor).toBe(FEE);
    // Due in seven days: outstanding, but not yet overdue, and inside the due-soon window.
    expect(body.money.overdueMinor).toBe(0);
    expect(body.money.overdueCount).toBe(0);
    expect(body.money.dueSoon.days).toBe(7);
    expect(body.money.dueSoon.count).toBe(1);
    expect(body.money.dueSoon.totalMinor).toBe(FEE);
  });

  it("counts a closed shift as worked time and an open one as open, never as time (T-ATT-11)", async () => {
    const clock = await clockFacts();
    const coachUserId = await coachId();
    const [closedSession, openSession] = await seedSessions([2, 13]);

    // Both records are dated in SQL against the same clock the dashboard reads, so the
    // expected minutes are derived rather than assumed: a 2-hour-old shift is "today" only
    // when the local day has already turned once since midnight.
    const client = await migratorClient();
    try {
      await client.query(
        `insert into coach_attendance
           (id, coach_user_id, session_id, check_in_at, check_out_at, entered_by)
         values ($1, $2, $3, now() - interval '2 hours', now() - interval '1 hour', 'owner')`,
        [randomUUID(), coachUserId, closedSession],
      );
      await client.query(
        `insert into coach_attendance (id, coach_user_id, session_id, check_in_at, entered_by)
         values ($1, $2, $3, now() - interval '13 hours', 'self')`,
        [randomUUID(), coachUserId, openSession],
      );
    } finally {
      await client.end();
    }

    const body = (await readDashboard()).json() as DashboardBody;

    expect(body.coachTime.todayMinutes).toBe(clock.closed_date === clock.today ? 60 : 0);
    expect(body.coachTime.weekMinutes).toBe(clock.closed_date >= clock.week_start ? 60 : 0);

    // The still-open shift is reported as open, with its elapsed minutes — and adds nothing
    // to the two totals above, because an open record is not time worked yet.
    expect(body.coachTime.checkedInNow).toHaveLength(1);
    expect(body.coachTime.checkedInNow[0]!.coach.id).toBe(coachUserId);
    expect(body.coachTime.checkedInNow[0]!.elapsedMinutes).toBeGreaterThanOrEqual(780);

    // Open for more than twelve hours, so the owner is asked to correct it — and told so in
    // the alert strip rather than only on a coach's own page.
    expect(body.coachTime.openNeedingCorrection).toBe(1);
    expect(body.alerts.map((alert) => alert.code)).toContain("COACH_CHECKIN_OPEN");
  });

  it("surfaces the missing worker and the missing PDF as alerts, never as silence (DSH-01)", async () => {
    await seedPlayerAndInvoice();

    const response = await readDashboard();
    const body = response.json() as DashboardBody;
    const codes = body.alerts.map((alert) => alert.code);

    // No worker has ever run in this test database: that is a critical fact, not a blank strip.
    expect(codes).toContain("WORKER_STALE");
    expect(body.alerts.find((a) => a.code === "WORKER_STALE")!.severity).toBe("critical");
    // The invoice was inserted without a document, which the sweeper would generate.
    expect(codes).toContain("PDF_MISSING");
    // Nothing is past its due date in this fixture.
    expect(codes).not.toContain("OVERDUE_INVOICES");

    // Ordered critical → warning → info.
    const order = { critical: 0, warning: 1, info: 2 } as const;
    const severities = body.alerts.map((alert) => order[alert.severity]);
    expect(severities).toEqual([...severities].sort((a, b) => a - b));
  });

  it("reports the messaging block honestly while M7 is unbuilt (DSH-01)", async () => {
    const response = await readDashboard();
    const body = response.json() as DashboardBody;

    // The switches exist (academy_settings) and default off; the session and the queue do not.
    expect(body.messaging.sessionStatus).toBe("unknown");
    expect(body.messaging.failed24h).toBe(0);
    expect(body.messaging.dead).toBe(0);
    expect(body.messaging.needsReview).toBe(0);
    expect(body.messaging.automations).toEqual({
      invoiceDelivery: expect.any(Boolean),
      reminderPreDue: expect.any(Boolean),
      reminderOverdue: expect.any(Boolean),
      proofCheck: expect.any(Boolean),
    });
  });

  it("refuses a coach (DSH-01 is `reports:read`, owner only)", async () => {
    const response = await readDashboard(coachCookie);
    expect(response.statusCode, response.body).toBe(403);
    expect(errorCode(response)).toBe("FORBIDDEN");
  });

  // --- small fixture helpers ----------------------------------------------------------------
  async function coachId(): Promise<string> {
    const client = await migratorClient();
    try {
      const result = await client.query<{ id: string }>(
        "select id from users where username = 'dsh1.coach' and role = 'coach'",
      );
      return result.rows[0]!.id;
    } finally {
      await client.end();
    }
  }

  /**
   * The three dates the coach-time assertion is phrased against, all read from the database's
   * own clock in the academy's own timezone — the same source the route uses, so "today" here
   * cannot disagree with "today" there.
   */
  async function clockFacts(): Promise<{
    today: string;
    closed_date: string;
    week_start: string;
  }> {
    const client = await migratorClient();
    try {
      const result = await client.query<{
        today: string;
        closed_date: string;
        week_start: string;
      }>(
        `select (now() at time zone timezone)::date::text as today,
                ((now() - interval '2 hours') at time zone timezone)::date::text as closed_date,
                date_trunc('week', now() at time zone timezone)::date::text as week_start
           from academy_settings where id = 1`,
      );
      return result.rows[0]!;
    } finally {
      await client.end();
    }
  }

  /** Creates one session per offset (hours ago) so two coach records cannot collide. */
  async function seedSessions(hoursAgo: number[]): Promise<string[]> {
    const client = await migratorClient();
    try {
      const existing = await client.query<{ id: string }>(
        "select id from age_groups where lower(name) = lower($1) and archived_at is null",
        [groupName],
      );
      let groupId = existing.rows[0]?.id;
      if (!groupId) {
        groupId = randomUUID();
        await client.query(
          `insert into age_groups (id, name, sort_order) values ($1, $2, 0)`,
          [groupId, groupName],
        );
      }

      const ids: string[] = [];
      for (const hours of hoursAgo) {
        const sessionId = randomUUID();
        await client.query(
          `insert into sessions (id, age_group_id, session_date, starts_at, ends_at, status)
           values (
             $1, $2,
             ((now() - ($3::int * interval '1 hour'))
                at time zone (select timezone from academy_settings where id = 1))::date,
             now() - ($3::int * interval '1 hour'),
             now() - ($3::int * interval '1 hour') + interval '1 hour',
             'scheduled')`,
          [sessionId, groupId, hours],
        );
        ids.push(sessionId);
      }
      return ids;
    } finally {
      await client.end();
    }
  }
});
