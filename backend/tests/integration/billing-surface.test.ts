/**
 * M5 (second half) — the billing runs and the invoice surface, through the real HTTP stack.
 *
 * This is the evidence the M5 handoff said was owed: `BIL-01/02/03` and `INV-01..05` were
 * implemented, typechecked and routed, but nothing drove them through the API. A status code
 * is not evidence on a money surface, so every refusal below is also **re-read**: a 409 that
 * wrote a row is a bug whatever it returned, and the counts are asserted against the database.
 *
 * The rules under test, in BILLING_ENGINE's order:
 *
 *  - **A preview is a question.** `BIL-01` names every player's fee and skip reason but stores
 *    nothing — the invoices and billing_runs tables are re-read to prove it.
 *  - **A run recomputes what it is handed.** A fee or roster change between preview and issue
 *    is a 409 `PREVIEW_STALE`, not a run that bills a fee the owner never saw (T-FIN-18), and
 *    it writes nothing either.
 *  - **A second run is a report, not a second set of invoices.** It answers
 *    `invoicesCreated: 0 / invoicesSkipped: N`; the same `Idempotency-Key` replays instead.
 *  - **An issued invoice is a snapshot.** Its group, fee and period are frozen; the only
 *    post-issue changes are a void and a *negative* adjustment.
 *  - **Void respects money.** Allocations block it unless released back to the payments as
 *    credit, and a voided period is not silently reissued (`suppress_reissue`).
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

const OWNER_IP = "198.51.100.101";
const COACH_IP = "198.51.100.102";

const TARGET = "2026-10-15";
const PERIOD_START = "2026-10-01";
const PERIOD_END = "2026-10-31";
const FEE = 400_000;
/** The date a run took place, used as a past `receivedAt` for payments. */
const PAST_INSTANT = "2026-10-05T04:00:00.000Z";

interface PreviewLine {
  playerId: string;
  playerName: string;
  registrationNo: string;
  ageGroup: { id: string; name: string };
  feeId: string;
  feeMinor: number;
  guardian?: { id: string; fullName: string };
  periodStart: string;
  periodEnd: string;
  issueDate: string;
  dueDate: string;
  warnings: string[];
}
interface PreviewSkip {
  playerId: string;
  playerName: string;
  reason: string;
}
interface PreviewBody {
  previewHash: string;
  targetDate: string;
  frequency: string;
  mode: string;
  lines: PreviewLine[];
  skipped: PreviewSkip[];
  totals: { count: number; totalMinor: number };
}
interface RunBody {
  id: string;
  runKey: string;
  status: string;
  targetDate: string;
  invoicesCreated: number;
  invoicesSkipped: number;
  invoiceIds: string[];
}
interface InvoiceItem {
  id: string;
  lineNo: number;
  itemType: string;
  description: string;
  amountMinor: number;
}
interface InvoiceBody {
  id: string;
  invoiceNumber: string;
  kind: string;
  status: string;
  isOverdue: boolean;
  daysOverdue: number;
  player: { id: string; fullName: string };
  ageGroup: { id: string; name: string };
  periodStart?: string;
  periodEnd?: string;
  issueDate: string;
  dueDate: string;
  subtotalMinor: number;
  adjustmentsMinor: number;
  totalMinor: number;
  paidMinor: number;
  balanceMinor: number;
  items?: InvoiceItem[];
  allocations?: { id: string; amountMinor: number; reversedAt?: string }[];
  hasPdf: boolean;
  version: number;
}
interface PaymentBody {
  id: string;
  allocatedMinor: number;
  unallocatedMinor: number;
  version: number;
}

/** Business-date arithmetic on `YYYY-MM-DD`, the same day counting `issue_date + N` does. */
function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

describe("M5 billing run and invoice surface (second half)", () => {
  let app: FastifyInstance;
  let ownerId: string;
  let ownerCookie: string;
  let ownerCsrf: string;
  let coachCookie: string;
  let coachCsrf: string;
  let keySeq = 0;
  let fixtureSeq = 0;
  let phoneSeq = 0;

  function nextKey(prefix: string): string {
    keySeq += 1;
    return `${prefix}-${keySeq}-0f3a9b`;
  }

  beforeAll(async () => {
    await prepareTestDatabase();
  });

  beforeEach(async () => {
    await resetData();
    // Two owners, as the other M-series fixtures do, so the deferred "at least one active
    // owner" trigger is never in play while fixtures churn.
    await createUser({ username: "bil.owner", role: "owner" });
    const owner = await createUser({ username: "bil.owner2", role: "owner" });
    const coach = await createUser({ username: "bil.coach", role: "coach" });
    ownerId = owner.id;

    app = await testApp();
    const ownerSession = await login(app, owner.username, owner.password, OWNER_IP);
    ownerCookie = ownerSession.cookie;
    ownerCsrf = ownerSession.csrfToken;
    const coachSession = await login(app, coach.username, coach.password, COACH_IP);
    coachCookie = coachSession.cookie;
    coachCsrf = coachSession.csrfToken;

    // `academy_settings` is NOT truncated by `resetData` (it is reference configuration, not
    // fixture data) and every test file shares `ia_test`, so another file may have left the
    // billing configuration on weekly/anchored. Pin it here so each test starts from the
    // documented default and the periods below are deterministic.
    const pinned = await request(app, {
      method: "PATCH",
      url: "/api/v1/settings/billing",
      cookie: ownerCookie,
      csrf: ownerCsrf,
      payload: {
        billingFrequency: "monthly",
        billingPeriodMode: "calendar",
        weekStartDay: 1,
        invoiceIssueTiming: "period_start",
        dueRuleType: "days_after_issue",
        dueRuleValue: 7,
      },
    });
    expect(pinned.statusCode, pinned.body).toBe(200);
  });

  afterAll(async () => {
    await app.close();
    await closeTestPool();
  });

  // -------------------------------------------------------------------------
  // Fixtures (through the API wherever the API is the thing under test)
  // -------------------------------------------------------------------------
  async function createGroup(name: string): Promise<{ id: string; name: string }> {
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

  async function createFee(groupId: string, amountMinor: number, effectiveFrom: string) {
    const response = await request(app, {
      method: "POST",
      url: `/api/v1/age-groups/${groupId}/fees`,
      cookie: ownerCookie,
      csrf: ownerCsrf,
      headers: { "idempotency-key": nextKey("fee") },
      payload: { amountMinor, effectiveFrom, allowPast: true },
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json() as { id: string; amountMinor: number };
  }

  async function createPlayer(
    fullName: string,
    registrationDate: string,
    ageGroupId?: string,
  ): Promise<{ id: string; guardianId: string }> {
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
            phone: `0771234${String(100 + phoneSeq)}`,
            isPrimary: true,
            receivesInvoices: true,
          },
        ],
      },
    });
    expect(response.statusCode, response.body).toBe(201);
    const body = response.json() as {
      id: string;
      guardians: { guardian: { id: string } }[];
    };
    return { id: body.id, guardianId: body.guardians[0]!.guardian.id };
  }

  async function withdraw(playerId: string, effectiveDate: string) {
    const read = await request(app, {
      method: "GET",
      url: `/api/v1/players/${playerId}`,
      cookie: ownerCookie,
    });
    const version = (read.json() as { version: number }).version;
    const response = await request(app, {
      method: "POST",
      url: `/api/v1/players/${playerId}/status`,
      cookie: ownerCookie,
      csrf: ownerCsrf,
      payload: { status: "withdrawn", effectiveDate, reason: "Left the academy", version },
    });
    expect(response.statusCode, response.body).toBe(200);
  }

  function preview(targetDate: string, extra: Record<string, unknown> = {}) {
    return request(app, {
      method: "POST",
      url: "/api/v1/billing/previews",
      cookie: ownerCookie,
      csrf: ownerCsrf,
      payload: { targetDate, ...extra },
    });
  }

  function runBilling(payload: Record<string, unknown>, key?: string) {
    return request(app, {
      method: "POST",
      url: "/api/v1/billing/runs",
      cookie: ownerCookie,
      csrf: ownerCsrf,
      headers: { "idempotency-key": key ?? nextKey("run") },
      payload,
    });
  }

  /** Preview, then run — the pair the owner actually performs. */
  async function previewAndRun(targetDate: string, extra: Record<string, unknown> = {}) {
    const p = await preview(targetDate);
    expect(p.statusCode, p.body).toBe(200);
    const previewBody = p.json() as PreviewBody;
    const run = await runBilling({ targetDate, previewHash: previewBody.previewHash, ...extra });
    return { preview: previewBody, run };
  }

  function readInvoice(id: string) {
    return request(app, { method: "GET", url: `/api/v1/invoices/${id}`, cookie: ownerCookie });
  }

  function recordCash(
    payload: Record<string, unknown>,
    key = nextKey("pay"),
  ) {
    return request(app, {
      method: "POST",
      url: "/api/v1/payments",
      cookie: ownerCookie,
      csrf: ownerCsrf,
      headers: { "idempotency-key": key },
      payload,
    });
  }

  // --- direct database reads, used only to *prove* what the API did or did not write ------
  async function counts() {
    const client = await migratorClient();
    try {
      const invoices = await client.query<{ n: number }>(
        "select count(*)::int as n from invoices",
      );
      const runs = await client.query<{ n: number }>(
        "select count(*)::int as n from billing_runs",
      );
      return { invoices: invoices.rows[0]!.n, runs: runs.rows[0]!.n };
    } finally {
      await client.end();
    }
  }

  async function invoiceRow(id: string) {
    const client = await migratorClient();
    try {
      const result = await client.query<{
        status: string;
        paid_minor: string;
        total_minor: string;
        adjustments_minor: string;
        balance_minor: string;
        pdf_stale: boolean;
        suppress_reissue: boolean;
        snapshot: { feeId?: string; ageGroupId?: string; feeMinor?: number };
      }>(
        `select status, paid_minor::text, total_minor::text, adjustments_minor::text,
                balance_minor::text, pdf_stale, suppress_reissue, snapshot
           from invoices where id = $1`,
        [id],
      );
      const row = result.rows[0]!;
      return {
        status: row.status,
        paidMinor: Number(row.paid_minor),
        totalMinor: Number(row.total_minor),
        adjustmentsMinor: Number(row.adjustments_minor),
        balanceMinor: Number(row.balance_minor),
        pdfStale: row.pdf_stale,
        suppressReissue: row.suppress_reissue,
        snapshot: row.snapshot,
      };
    } finally {
      await client.end();
    }
  }

  /** A periodic-less invoice written straight to the database: `overdue` needs a past issue. */
  async function fixtureInvoice(opts: {
    playerId: string;
    guardianId: string;
    totalMinor: number;
    dueDate: string;
    issueDate?: string;
    ageGroupId?: string;
  }) {
    fixtureSeq += 1;
    const id = randomUUID();
    const number = `INV-2026-${String(900000 + fixtureSeq).padStart(6, "0")}`;
    const client = await migratorClient();
    try {
      // The totals trigger is deferred, so the row and its line commit together.
      await client.query("begin");
      await client.query(
        `insert into invoices
           (id, invoice_number, kind, player_id, guardian_id, issue_date, due_date, status,
            subtotal_minor, adjustments_minor, total_minor, paid_minor, snapshot, created_by)
         values ($1, $2, 'manual', $3, $4, $5::date, $6::date, 'issued', $7, 0, $7, 0, $8::jsonb, $9)`,
        [
          id,
          number,
          opts.playerId,
          opts.guardianId,
          opts.issueDate ?? "2025-12-01",
          opts.dueDate,
          opts.totalMinor,
          JSON.stringify(
            opts.ageGroupId
              ? { ageGroupId: opts.ageGroupId, ageGroupName: "Fixture group" }
              : {},
          ),
          ownerId,
        ],
      );
      await client.query(
        `insert into invoice_items
           (id, invoice_id, line_no, item_type, description, quantity, unit_amount_minor,
            amount_minor, created_by)
         values ($1, $2, 1, 'fee', 'Fixture fee', 1, $3, $3, $4)`,
        [randomUUID(), id, opts.totalMinor, ownerId],
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
  // BIL-01 — the preview
  // =========================================================================
  it("previews every skip reason, the fee/period/due-date and stores nothing (BIL-01)", async () => {
    const group = await createGroup("Under 12");
    const fee = await createFee(group.id, FEE, "2026-01-01");
    const unfeeoed = await createGroup("Under 14");

    // Registered inside the billed period so the preview carries no "behind by N" warning.
    const billable = await createPlayer("Billable Player", PERIOD_START, group.id);
    const noGroup = await createPlayer("No Group Player", PERIOD_START);
    const noFee = await createPlayer("No Fee Player", PERIOD_START, unfeeoed.id);
    const notActive = await createPlayer("Withdrawn Player", PERIOD_START, group.id);
    await withdraw(notActive.id, "2026-09-01");
    // Registration must fall after the period's end (and a registration date may not be more
    // than 30 days in the future, so this stays within that window of the real today).
    const notYet = await createPlayer("Late Registration", "2026-11-05", group.id);

    const before = await counts();
    const response = await preview(TARGET);
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json() as PreviewBody;

    // Exactly one line, and it carries the fee, the period, the group and a due date.
    expect(body.lines.map((line) => line.playerId)).toEqual([billable.id]);
    const line = body.lines[0]!;
    expect(line.feeMinor).toBe(FEE);
    expect(line.ageGroup).toEqual({ id: group.id, name: "Under 12" });
    expect(line.periodStart).toBe(PERIOD_START);
    expect(line.periodEnd).toBe(PERIOD_END);
    expect(line.dueDate).toBe(addDays(line.issueDate, 7));
    expect(line.guardian?.id).toBe(billable.guardianId);
    expect(line.warnings).toEqual([]);
    expect(body.totals).toEqual({ count: 1, totalMinor: FEE });
    expect(body.frequency).toBe("monthly");
    expect(body.mode).toBe("calendar");
    expect(body.previewHash).toMatch(/^[0-9a-f]{64}$/);
    expect(fee.amountMinor).toBe(FEE);

    // Every skip is reported with its own reason, each for its own cause.
    const reasonFor = (playerId: string) =>
      body.skipped.find((skip) => skip.playerId === playerId)?.reason;
    expect(reasonFor(noGroup.id)).toBe("NO_GROUP");
    expect(reasonFor(noFee.id)).toBe("NO_FEE");
    expect(reasonFor(notActive.id)).toBe("NOT_ACTIVE");
    expect(reasonFor(notYet.id)).toBe("NOT_YET_REGISTERED");
    expect(body.skipped).toHaveLength(4);

    // The preview is a question: it moved no row.
    expect(await counts()).toEqual(before);
  });

  // =========================================================================
  // BIL-02 / BIL-03 — issuing and reading a run
  // =========================================================================
  it("issues sequential invoices with a frozen snapshot and reports the run (BIL-02/03)", async () => {
    const group = await createGroup("Under 12");
    await createFee(group.id, FEE, "2026-01-01");
    const first = await createPlayer("Aisha First", "2026-01-01", group.id);
    const second = await createPlayer("Bimal Second", "2026-01-01", group.id);

    const { run } = await previewAndRun(TARGET);
    expect(run.statusCode, run.body).toBe(201);
    const runBody = run.json() as RunBody;
    expect(runBody.status).toBe("issued");
    expect(runBody.invoicesCreated).toBe(2);
    expect(runBody.invoicesSkipped).toBe(0);
    expect(runBody.invoiceIds).toHaveLength(2);
    expect(runBody.targetDate).toBe(TARGET);

    // Sequential numbers, and the snapshot the invoice will never lose.
    const invoices = await Promise.all(runBody.invoiceIds.map(async (id) => readInvoice(id)));
    for (const response of invoices) expect(response.statusCode, response.body).toBe(200);
    const numbers = invoices.map((response) => (response.json() as InvoiceBody).invoiceNumber);
    expect([...numbers].sort()).toEqual(["INV-2026-000001", "INV-2026-000002"]);

    const byPlayer = new Map(
      invoices.map((response) => {
        const invoice = response.json() as InvoiceBody;
        return [invoice.player.id, invoice] as const;
      }),
    );
    const aishaInvoice = byPlayer.get(first.id)!;
    expect(aishaInvoice.kind).toBe("periodic");
    expect(aishaInvoice.ageGroup).toEqual({ id: group.id, name: "Under 12" });
    expect(aishaInvoice.periodStart).toBe(PERIOD_START);
    expect(aishaInvoice.periodEnd).toBe(PERIOD_END);
    expect(aishaInvoice.subtotalMinor).toBe(FEE);
    expect(aishaInvoice.adjustmentsMinor).toBe(0);
    expect(aishaInvoice.totalMinor).toBe(FEE);
    expect(aishaInvoice.paidMinor).toBe(0);
    expect(aishaInvoice.balanceMinor).toBe(FEE);
    expect(aishaInvoice.status).toBe("issued");
    expect(aishaInvoice.hasPdf).toBe(false);
    // The line is the fee, dated by the run's own issue date (academy-local today).
    expect(aishaInvoice.items).toHaveLength(1);
    expect(aishaInvoice.items![0]!.itemType).toBe("fee");
    expect(aishaInvoice.items![0]!.amountMinor).toBe(FEE);
    expect(aishaInvoice.dueDate).toBe(addDays(aishaInvoice.issueDate, 7));
    expect(byPlayer.get(second.id)!.totalMinor).toBe(FEE);

    // The snapshot on the row is the same group/fee the preview named (ADR-014).
    const row = await invoiceRow(runBody.invoiceIds[0]!);
    expect(row.snapshot.ageGroupId).toBe(group.id);
    expect(row.snapshot.feeMinor).toBe(FEE);

    // BIL-03.read returns the run with the ids it created.
    const read = await request(app, {
      method: "GET",
      url: `/api/v1/billing/runs/${runBody.id}`,
      cookie: ownerCookie,
    });
    expect(read.statusCode, read.body).toBe(200);
    expect((read.json() as RunBody).invoiceIds.sort()).toEqual([...runBody.invoiceIds].sort());

    const list = await request(app, {
      method: "GET",
      url: "/api/v1/billing/runs",
      cookie: ownerCookie,
    });
    expect(list.statusCode, list.body).toBe(200);
    const page = list.json() as { data: RunBody[]; meta: { total: number } };
    expect(page.meta.total).toBe(1);
    expect(page.data[0]!.id).toBe(runBody.id);
  });

  it("refuses a stale preview and writes nothing at all (T-FIN-18)", async () => {
    const group = await createGroup("Under 12");
    await createFee(group.id, FEE, "2026-01-01");
    await createPlayer("Stale Player", "2026-01-01", group.id);

    const p = await preview(TARGET);
    const staleHash = (p.json() as PreviewBody).previewHash;

    // The world moves after the owner previewed: the group's fee changes for this period.
    const change = await request(app, {
      method: "POST",
      url: `/api/v1/age-groups/${group.id}/fees`,
      cookie: ownerCookie,
      csrf: ownerCsrf,
      headers: { "idempotency-key": nextKey("fee-change") },
      payload: { amountMinor: FEE + 50_000, effectiveFrom: PERIOD_START, allowPast: true },
    });
    expect(change.statusCode, change.body).toBe(201);

    const before = await counts();
    const run = await runBilling({ targetDate: TARGET, previewHash: staleHash });
    expect(run.statusCode, run.body).toBe(409);
    expect(errorCode(run)).toBe("PREVIEW_STALE");
    // Nothing was written: not an invoice, not a run.
    expect(await counts()).toEqual(before);
  });

  it("reports a second run as skips, and the same key replays (BIL-02, §9)", async () => {
    const group = await createGroup("Under 12");
    await createFee(group.id, FEE, "2026-01-01");
    await createPlayer("Replayer One", "2026-01-01", group.id);
    await createPlayer("Replayer Two", "2026-01-01", group.id);

    const key = nextKey("run-replay");
    const p1 = await preview(TARGET);
    const run1 = await runBilling(
      { targetDate: TARGET, previewHash: (p1.json() as PreviewBody).previewHash },
      key,
    );
    expect(run1.statusCode, run1.body).toBe(201);
    expect((run1.json() as RunBody).invoicesCreated).toBe(2);

    // A DIFFERENT key for the same period: the periods are taken, so nothing is issued and the
    // run says so — `0 created / 2 skipped`, partial.
    const p2 = await preview(TARGET);
    const preview2 = p2.json() as PreviewBody;
    expect(preview2.lines).toHaveLength(0);
    expect(preview2.skipped.map((s) => s.reason)).toEqual(["ALREADY_INVOICED", "ALREADY_INVOICED"]);
    const run2 = await runBilling({ targetDate: TARGET, previewHash: preview2.previewHash });
    expect(run2.statusCode, run2.body).toBe(201);
    const run2Body = run2.json() as RunBody;
    expect(run2Body.invoicesCreated).toBe(0);
    expect(run2Body.invoicesSkipped).toBe(2);
    expect(run2Body.status).toBe("partial");

    // The SAME key replays the first response and opens no third run.
    const before = await counts();
    const replay = await runBilling(
      { targetDate: TARGET, previewHash: (p1.json() as PreviewBody).previewHash },
      key,
    );
    expect(replay.statusCode, replay.body).toBe(201);
    expect(replay.headers["idempotent-replay"]).toBe("true");
    expect((replay.json() as RunBody).id).toBe((run1.json() as RunBody).id);
    expect(await counts()).toEqual(before);
    expect(before.runs).toBe(2);
  });

  it("refuses to queue WhatsApp messages a build without a queue cannot send (BIL-02)", async () => {
    const group = await createGroup("Under 12");
    await createFee(group.id, FEE, "2026-01-01");
    await createPlayer("Queue Player", "2026-01-01", group.id);

    const before = await counts();
    const p = await preview(TARGET);
    const run = await runBilling({
      targetDate: TARGET,
      previewHash: (p.json() as PreviewBody).previewHash,
      queueWhatsApp: true,
    });
    expect(run.statusCode, run.body).toBe(422);
    expect(errorCode(run)).toBe("VALIDATION_ERROR");
    expect(await counts()).toEqual(before);
  });

  // =========================================================================
  // BIL-02 — adjustments on the run
  // =========================================================================
  it("applies a negative adjustment as its own line and marks the PDF stale (BIL-02, §10)", async () => {
    const group = await createGroup("Under 12");
    await createFee(group.id, FEE, "2026-01-01");
    const player = await createPlayer("Discount Player", "2026-01-01", group.id);

    const p = await preview(TARGET);
    const run = await runBilling({
      targetDate: TARGET,
      previewHash: (p.json() as PreviewBody).previewHash,
      adjustments: [{ playerId: player.id, amountMinor: -100_000, reason: "Sibling discount" }],
    });
    expect(run.statusCode, run.body).toBe(201);
    const runBody = run.json() as RunBody;
    expect(runBody.invoicesCreated).toBe(1);

    const invoice = (await readInvoice(runBody.invoiceIds[0]!)).json() as InvoiceBody;
    expect(invoice.subtotalMinor).toBe(FEE);
    expect(invoice.adjustmentsMinor).toBe(-100_000);
    expect(invoice.totalMinor).toBe(FEE - 100_000);
    expect(invoice.items).toHaveLength(2);
    const adjustment = invoice.items!.find((item) => item.itemType === "adjustment")!;
    expect(adjustment.amountMinor).toBe(-100_000);
    expect(adjustment.description).toBe("Sibling discount");

    // The PDF now shows the wrong balance, so it is marked stale (M6 regenerates it).
    expect((await invoiceRow(runBody.invoiceIds[0]!)).pdfStale).toBe(true);
  });

  it("refuses an invalid adjustment and writes nothing (BIL-02)", async () => {
    const group = await createGroup("Under 12");
    await createFee(group.id, FEE, "2026-01-01");
    const player = await createPlayer("Adjust Player", "2026-01-01", group.id);

    const before = await counts();

    // Positive (an increase is void + reissue, never an adjustment).
    const positive = await previewAndRun(TARGET, {
      adjustments: [{ playerId: player.id, amountMinor: 100_000, reason: "Late fee" }],
    });
    expect(positive.run.statusCode, positive.run.body).toBe(422);

    // Larger than the fee it discounts.
    const overFee = await previewAndRun(TARGET, {
      adjustments: [{ playerId: player.id, amountMinor: -(FEE + 1), reason: "Too big" }],
    });
    expect(overFee.run.statusCode, overFee.run.body).toBe(422);

    // Two adjustments for the same player.
    const duplicate = await previewAndRun(TARGET, {
      adjustments: [
        { playerId: player.id, amountMinor: -100_000, reason: "First" },
        { playerId: player.id, amountMinor: -50_000, reason: "Second" },
      ],
    });
    expect(duplicate.run.statusCode, duplicate.run.body).toBe(422);

    // A player who is not part of the run (a random id) cannot carry one.
    const unknown = await previewAndRun(TARGET, {
      adjustments: [{ playerId: randomUUID(), amountMinor: -100_000, reason: "Ghost" }],
    });
    expect(unknown.run.statusCode, unknown.run.body).toBe(422);

    // Proven, not assumed: no run and no invoice came of any of them.
    expect(await counts()).toEqual(before);
  });

  // =========================================================================
  // Billing periods through the API (BILLING_ENGINE §3)
  // =========================================================================
  it("bills an anchored month from the player's own anchor, clamped (BILLING_ENGINE §3)", async () => {
    // Anchored: the player's periods are measured from their registration date.
    const setting = await request(app, {
      method: "PATCH",
      url: "/api/v1/settings/billing",
      cookie: ownerCookie,
      csrf: ownerCsrf,
      payload: {
        billingFrequency: "monthly",
        billingPeriodMode: "anchored",
        invoiceIssueTiming: "period_start",
      },
    });
    expect(setting.statusCode, setting.body).toBe(200);

    const group = await createGroup("Under 12");
    await createFee(group.id, FEE, "2026-01-01");
    // Registered 31 Jan: the anchor is the 31st, so the Feb period is 28 Feb → 30 Mar.
    const player = await createPlayer("Anchor Player", "2026-01-31", group.id);

    const p = await preview("2026-02-28");
    expect(p.statusCode, p.body).toBe(200);
    const body = p.json() as PreviewBody;
    expect(body.mode).toBe("anchored");
    expect(body.lines.map((line) => line.playerId)).toEqual([player.id]);
    // 31 Jan → 28 Feb (clamped) → the period after it ends 30 Mar.
    expect(body.lines[0]!.periodStart).toBe("2026-02-28");
    expect(body.lines[0]!.periodEnd).toBe("2026-03-30");
  });

  it("bills the period that just ended when issuing in arrears (BILLING_ENGINE §4)", async () => {
    const setting = await request(app, {
      method: "PATCH",
      url: "/api/v1/settings/billing",
      cookie: ownerCookie,
      csrf: ownerCsrf,
      payload: {
        billingFrequency: "monthly",
        invoiceIssueTiming: "period_end",
        billingPeriodMode: "calendar",
      },
    });
    expect(setting.statusCode, setting.body).toBe(200);

    const group = await createGroup("Under 12");
    await createFee(group.id, FEE, "2026-01-01");
    const player = await createPlayer("Arrears Player", "2026-01-01", group.id);

    // A target of 15 Oct picks the period that ended 30 Sep, not the one containing 15 Oct.
    const p = await preview(TARGET);
    expect(p.statusCode, p.body).toBe(200);
    const body = p.json() as PreviewBody;
    expect(body.lines.map((line) => line.playerId)).toEqual([player.id]);
    expect(body.lines[0]!.periodStart).toBe("2026-09-01");
    expect(body.lines[0]!.periodEnd).toBe("2026-09-30");

    // And the issued invoice stores that same period.
    const run = await runBilling({ targetDate: TARGET, previewHash: body.previewHash });
    expect(run.statusCode, run.body).toBe(201);
    const invoice = (await readInvoice((run.json() as RunBody).invoiceIds[0]!)).json() as InvoiceBody;
    expect(invoice.periodStart).toBe("2026-09-01");
    expect(invoice.periodEnd).toBe("2026-09-30");
  });

  // =========================================================================
  // INV-01 — list, overdue, snapshot filter, sort
  // =========================================================================
  it("filters overdue and by the snapshot's group, and rejects an unknown sort (INV-01)", async () => {
    const group = await createGroup("Under 12");
    const other = await createGroup("Under 14");
    const player = await createPlayer("List Player", "2026-01-01", group.id);

    // Overdue needs an invoice issued in the past — a run always issues today.
    const overdue = await fixtureInvoice({
      playerId: player.id,
      guardianId: player.guardianId,
      totalMinor: 300_000,
      dueDate: "2026-01-01",
      issueDate: "2025-12-01",
      ageGroupId: group.id,
    });
    const future = await fixtureInvoice({
      playerId: player.id,
      guardianId: player.guardianId,
      totalMinor: 200_000,
      dueDate: "2099-01-01",
      ageGroupId: other.id,
    });

    const overdueList = await request(app, {
      method: "GET",
      url: "/api/v1/invoices?overdue=true",
      cookie: ownerCookie,
    });
    expect(overdueList.statusCode, overdueList.body).toBe(200);
    const overdueRows = (overdueList.json() as { data: InvoiceBody[] }).data;
    expect(overdueRows.map((row) => row.id)).toEqual([overdue.id]);
    expect(overdueRows[0]!.isOverdue).toBe(true);
    expect(overdueRows[0]!.daysOverdue).toBeGreaterThan(0);

    // `ageGroupId` reads the group the invoice was billed under, from its snapshot.
    const byGroup = await request(app, {
      method: "GET",
      url: `/api/v1/invoices?ageGroupId=${other.id}`,
      cookie: ownerCookie,
    });
    expect(byGroup.statusCode, byGroup.body).toBe(200);
    expect((byGroup.json() as { data: InvoiceBody[] }).data.map((row) => row.id)).toEqual([
      future.id,
    ]);

    const badSort = await request(app, {
      method: "GET",
      url: "/api/v1/invoices?sort=nonsense",
      cookie: ownerCookie,
    });
    expect(badSort.statusCode, badSort.body).toBe(422);
    expect(errorCode(badSort)).toBe("INVALID_SORT");
  });

  // =========================================================================
  // INV-02 — detail with items, and a reversed allocation still visible
  // =========================================================================
  it("returns items and a reversed allocation, the invoice back to issued (INV-02)", async () => {
    const group = await createGroup("Under 12");
    await createFee(group.id, FEE, "2026-01-01");
    const player = await createPlayer("Reversal Player", "2026-01-01", group.id);

    const created = await request(app, {
      method: "POST",
      url: "/api/v1/invoices",
      cookie: ownerCookie,
      csrf: ownerCsrf,
      headers: { "idempotency-key": nextKey("inv-manual") },
      payload: { playerId: player.id, description: "Uniform fee", amountMinor: FEE, dueDate: "2026-11-20" },
    });
    expect(created.statusCode, created.body).toBe(201);
    const invoice = created.json() as InvoiceBody;

    const paid = await recordCash({
      amountMinor: FEE,
      methodCode: "cash",
      receivedAt: PAST_INSTANT,
      payerGuardianId: player.guardianId,
      status: "confirmed",
      allocations: [{ invoiceId: invoice.id, amountMinor: FEE }],
    });
    expect(paid.statusCode, paid.body).toBe(201);
    const payment = paid.json() as PaymentBody;
    expect((await readInvoice(invoice.id)).json()).toMatchObject({ status: "paid", paidMinor: FEE });

    const reversed = await request(app, {
      method: "POST",
      url: `/api/v1/payments/${payment.id}/reverse`,
      cookie: ownerCookie,
      csrf: ownerCsrf,
      headers: { "idempotency-key": nextKey("reverse") },
      payload: { reason: "Recorded against the wrong player", version: payment.version },
    });
    expect(reversed.statusCode, reversed.body).toBe(200);

    // The invoice is owed again and the allocation is stamped, never deleted.
    const detail = (await readInvoice(invoice.id)).json() as InvoiceBody;
    expect(detail.status).toBe("issued");
    expect(detail.paidMinor).toBe(0);
    expect(detail.balanceMinor).toBe(FEE);
    expect(detail.items).toHaveLength(1);
    expect(detail.allocations).toHaveLength(1);
    expect(detail.allocations![0]!.reversedAt).toBeDefined();
  });

  // =========================================================================
  // INV-03 — the manual invoice
  // =========================================================================
  it("issues a manual invoice with its own number and no period, refusing a group-less player (INV-03)", async () => {
    const group = await createGroup("Under 12");
    const player = await createPlayer("Manual Player", "2026-01-01", group.id);
    const groupless = await createPlayer("Groupless Player", "2026-01-01");

    const first = await request(app, {
      method: "POST",
      url: "/api/v1/invoices",
      cookie: ownerCookie,
      csrf: ownerCsrf,
      headers: { "idempotency-key": nextKey("inv-manual") },
      payload: { playerId: player.id, description: "Tournament fee", amountMinor: 150_000, dueDate: "2026-11-20" },
    });
    expect(first.statusCode, first.body).toBe(201);
    const invoice = first.json() as InvoiceBody;
    expect(invoice.kind).toBe("manual");
    expect(invoice.invoiceNumber).toBe("INV-2026-000001");
    expect(invoice.periodStart).toBeUndefined();
    expect(invoice.periodEnd).toBeUndefined();
    expect(invoice.totalMinor).toBe(150_000);
    // The snapshot still attributes it to the group held on the issue date.
    expect(invoice.ageGroup.id).toBe(group.id);

    const second = await request(app, {
      method: "POST",
      url: "/api/v1/invoices",
      cookie: ownerCookie,
      csrf: ownerCsrf,
      headers: { "idempotency-key": nextKey("inv-manual") },
      payload: { playerId: player.id, description: "Trip fee", amountMinor: 250_000, dueDate: "2026-11-20" },
    });
    expect(second.statusCode, second.body).toBe(201);
    expect((second.json() as InvoiceBody).invoiceNumber).toBe("INV-2026-000002");

    const before = await counts();
    const refused = await request(app, {
      method: "POST",
      url: "/api/v1/invoices",
      cookie: ownerCookie,
      csrf: ownerCsrf,
      headers: { "idempotency-key": nextKey("inv-manual") },
      payload: { playerId: groupless.id, description: "No group", amountMinor: 100_000, dueDate: "2026-11-20" },
    });
    expect(refused.statusCode, refused.body).toBe(422);
    expect(errorCode(refused)).toBe("VALIDATION_ERROR");
    expect(await counts()).toEqual(before);
  });

  // =========================================================================
  // INV-04 — voiding
  // =========================================================================
  it("blocks a void while allocations exist, then releases them as credit (INV-04)", async () => {
    const group = await createGroup("Under 12");
    await createFee(group.id, FEE, "2026-01-01");
    const player = await createPlayer("Void Player", "2026-01-01", group.id);

    const invoice = (
      await request(app, {
        method: "POST",
        url: "/api/v1/invoices",
        cookie: ownerCookie,
        csrf: ownerCsrf,
        headers: { "idempotency-key": nextKey("inv-manual") },
        payload: { playerId: player.id, description: "Term fee", amountMinor: FEE, dueDate: "2026-11-20" },
      })
    ).json() as InvoiceBody;

    const paid = await recordCash({
      amountMinor: FEE,
      methodCode: "cash",
      receivedAt: PAST_INSTANT,
      payerGuardianId: player.guardianId,
      status: "confirmed",
      allocations: [{ invoiceId: invoice.id, amountMinor: FEE }],
    });
    expect(paid.statusCode, paid.body).toBe(201);
    const payment = paid.json() as PaymentBody;

    const current = (await readInvoice(invoice.id)).json() as InvoiceBody;
    expect(current.status).toBe("paid");

    // Without releasing, the void is refused and nothing moves.
    const blocked = await request(app, {
      method: "POST",
      url: `/api/v1/invoices/${invoice.id}/void`,
      cookie: ownerCookie,
      csrf: ownerCsrf,
      headers: { "idempotency-key": nextKey("void") },
      payload: { reason: "Issued in error", version: current.version },
    });
    expect(blocked.statusCode, blocked.body).toBe(409);
    expect(errorCode(blocked)).toBe("INVOICE_HAS_ALLOCATIONS");
    expect((await readInvoice(invoice.id)).json()).toMatchObject({ status: "paid", paidMinor: FEE });

    // A stale version is answered with the documented conflict.
    const staleVersion = await request(app, {
      method: "POST",
      url: `/api/v1/invoices/${invoice.id}/void`,
      cookie: ownerCookie,
      csrf: ownerCsrf,
      headers: { "idempotency-key": nextKey("void") },
      payload: { reason: "Issued in error", releaseAllocations: true, version: 99 },
    });
    expect(staleVersion.statusCode, staleVersion.body).toBe(409);
    expect(errorCode(staleVersion)).toBe("VERSION_CONFLICT");

    // With releaseAllocations the payment gets its credit back and the invoice is void.
    const voided = await request(app, {
      method: "POST",
      url: `/api/v1/invoices/${invoice.id}/void`,
      cookie: ownerCookie,
      csrf: ownerCsrf,
      headers: { "idempotency-key": nextKey("void") },
      payload: { reason: "Issued in error", releaseAllocations: true, version: current.version },
    });
    expect(voided.statusCode, voided.body).toBe(200);
    const voidedBody = voided.json() as InvoiceBody;
    expect(voidedBody.status).toBe("void");
    expect(voidedBody.paidMinor).toBe(0);

    const paymentAfter = (
      await request(app, {
        method: "GET",
        url: `/api/v1/payments/${payment.id}`,
        cookie: ownerCookie,
      })
    ).json() as PaymentBody;
    expect(paymentAfter.allocatedMinor).toBe(0);
    expect(paymentAfter.unallocatedMinor).toBe(FEE);

    // Voiding again is a state error, not a second void.
    const again = await request(app, {
      method: "POST",
      url: `/api/v1/invoices/${invoice.id}/void`,
      cookie: ownerCookie,
      csrf: ownerCsrf,
      headers: { "idempotency-key": nextKey("void") },
      payload: { reason: "Again", version: voidedBody.version },
    });
    expect(again.statusCode, again.body).toBe(409);
    expect(errorCode(again)).toBe("INVALID_STATE_TRANSITION");
  });

  it("suppresses reissue by default but recreates the period when allowed (INV-04, §10)", async () => {
    const group = await createGroup("Under 12");
    await createFee(group.id, FEE, "2026-01-01");
    const suppressed = await createPlayer("Suppressed Player", "2026-01-01", group.id);
    const reissuable = await createPlayer("Reissuable Player", "2026-01-01", group.id);

    const { run } = await previewAndRun(TARGET);
    const runBody = run.json() as RunBody;
    expect(runBody.invoicesCreated).toBe(2);
    const byPlayer = new Map<string, InvoiceBody>();
    for (const id of runBody.invoiceIds) {
      const invoice = (await readInvoice(id)).json() as InvoiceBody;
      byPlayer.set(invoice.player.id, invoice);
    }
    const suppressedInvoice = byPlayer.get(suppressed.id)!;
    const reissuableInvoice = byPlayer.get(reissuable.id)!;

    // Void one with the default (suppress) and one with allowReissue.
    const suppressVoid = await request(app, {
      method: "POST",
      url: `/api/v1/invoices/${suppressedInvoice.id}/void`,
      cookie: ownerCookie,
      csrf: ownerCsrf,
      headers: { "idempotency-key": nextKey("void") },
      payload: { reason: "Wrong amount", version: suppressedInvoice.version },
    });
    expect(suppressVoid.statusCode, suppressVoid.body).toBe(200);
    expect((await invoiceRow(suppressedInvoice.id)).suppressReissue).toBe(true);

    const allowVoid = await request(app, {
      method: "POST",
      url: `/api/v1/invoices/${reissuableInvoice.id}/void`,
      cookie: ownerCookie,
      csrf: ownerCsrf,
      headers: { "idempotency-key": nextKey("void") },
      payload: { reason: "Wrong amount", allowReissue: true, version: reissuableInvoice.version },
    });
    expect(allowVoid.statusCode, allowVoid.body).toBe(200);
    expect((await invoiceRow(reissuableInvoice.id)).suppressReissue).toBe(false);

    // The next run recreates only the allowed one.
    const p = await preview(TARGET);
    const previewBody = p.json() as PreviewBody;
    expect(previewBody.lines.map((line) => line.playerId)).toEqual([reissuable.id]);
    expect(previewBody.skipped.find((s) => s.playerId === suppressed.id)?.reason).toBe(
      "ALREADY_INVOICED",
    );
    const second = await runBilling({ targetDate: TARGET, previewHash: previewBody.previewHash });
    expect(second.statusCode, second.body).toBe(201);
    const secondBody = second.json() as RunBody;
    expect(secondBody.invoicesCreated).toBe(1);
    expect(secondBody.invoicesSkipped).toBe(1);
    expect(secondBody.status).toBe("partial");
    const recreated = (await readInvoice(secondBody.invoiceIds[0]!)).json() as InvoiceBody;
    expect(recreated.player.id).toBe(reissuable.id);
  });

  // =========================================================================
  // INV-05 — the post-issue adjustment
  // =========================================================================
  it("clears the balance with a negative adjustment, and refuses too large or on a void (INV-05)", async () => {
    const group = await createGroup("Under 12");
    await createFee(group.id, FEE, "2026-01-01");
    const player = await createPlayer("Waiver Player", "2026-01-01", group.id);

    const invoice = (
      await request(app, {
        method: "POST",
        url: "/api/v1/invoices",
        cookie: ownerCookie,
        csrf: ownerCsrf,
        headers: { "idempotency-key": nextKey("inv-manual") },
        payload: { playerId: player.id, description: "Term fee", amountMinor: FEE, dueDate: "2026-11-20" },
      })
    ).json() as InvoiceBody;

    // More than the balance is refused, and nothing is written.
    const tooLarge = await request(app, {
      method: "POST",
      url: `/api/v1/invoices/${invoice.id}/adjustments`,
      cookie: ownerCookie,
      csrf: ownerCsrf,
      headers: { "idempotency-key": nextKey("adj") },
      payload: { amountMinor: -(FEE + 1), reason: "Too much", version: invoice.version },
    });
    expect(tooLarge.statusCode, tooLarge.body).toBe(422);
    expect((await invoiceRow(invoice.id)).adjustmentsMinor).toBe(0);

    // The full balance clears it: the total becomes 0 and the status is paid.
    const cleared = await request(app, {
      method: "POST",
      url: `/api/v1/invoices/${invoice.id}/adjustments`,
      cookie: ownerCookie,
      csrf: ownerCsrf,
      headers: { "idempotency-key": nextKey("adj") },
      payload: { amountMinor: -FEE, reason: "Full waiver", version: invoice.version },
    });
    expect(cleared.statusCode, cleared.body).toBe(200);
    const clearedBody = cleared.json() as InvoiceBody;
    expect(clearedBody.status).toBe("paid");
    expect(clearedBody.totalMinor).toBe(0);
    expect(clearedBody.balanceMinor).toBe(0);
    expect(clearedBody.adjustmentsMinor).toBe(-FEE);
    expect(clearedBody.items).toHaveLength(2);

    // A voided invoice cannot be adjusted.
    const voidable = (
      await request(app, {
        method: "POST",
        url: "/api/v1/invoices",
        cookie: ownerCookie,
        csrf: ownerCsrf,
        headers: { "idempotency-key": nextKey("inv-manual") },
        payload: { playerId: player.id, description: "Another fee", amountMinor: FEE, dueDate: "2026-11-20" },
      })
    ).json() as InvoiceBody;
    const voided = await request(app, {
      method: "POST",
      url: `/api/v1/invoices/${voidable.id}/void`,
      cookie: ownerCookie,
      csrf: ownerCsrf,
      headers: { "idempotency-key": nextKey("void") },
      payload: { reason: "Issued by mistake", version: voidable.version },
    });
    expect(voided.statusCode, voided.body).toBe(200);
    const onVoid = await request(app, {
      method: "POST",
      url: `/api/v1/invoices/${voidable.id}/adjustments`,
      cookie: ownerCookie,
      csrf: ownerCsrf,
      headers: { "idempotency-key": nextKey("adj") },
      payload: { amountMinor: -10_000, reason: "Late waiver", version: (voided.json() as InvoiceBody).version },
    });
    expect(onVoid.statusCode, onVoid.body).toBe(409);
    expect(errorCode(onVoid)).toBe("INVOICE_VOID");
  });

  // =========================================================================
  // Authorization
  // =========================================================================
  it("refuses a coach across the whole billing surface and reads no invoice", async () => {
    const preview = await request(app, {
      method: "POST",
      url: "/api/v1/billing/previews",
      cookie: coachCookie,
      csrf: coachCsrf,
      payload: { targetDate: TARGET },
    });
    expect(preview.statusCode).toBe(403);
    expect(errorCode(preview)).toBe("FORBIDDEN");

    for (const url of ["/api/v1/billing/runs", "/api/v1/invoices"]) {
      const read = await request(app, { method: "GET", url, cookie: coachCookie });
      expect(read.statusCode, `${url} ${read.body}`).toBe(403);
    }

    const run = await request(app, {
      method: "POST",
      url: "/api/v1/billing/runs",
      cookie: coachCookie,
      csrf: coachCsrf,
      headers: { "idempotency-key": nextKey("coach-run") },
      payload: { targetDate: TARGET, previewHash: "0".repeat(64) },
    });
    expect(run.statusCode).toBe(403);
  });
});
