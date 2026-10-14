/**
 * The audit hash chain under **concurrency** (DATABASE §3.7, T-SEC-07).
 *
 * The chain is what makes a silent edit to `audit_logs` detectable: every row carries the hash of
 * the row before it, so changing or deleting a historical row breaks every later hash. That claim
 * only holds if the chain is a chain — exactly one predecessor link per row, no forks.
 *
 * This test exists because it did not, and the nightly invariant job found the gap the hard way:
 * `app.audit_logs_chain()` reads the previous row's hash with a plain `select … order by id desc
 * limit 1`, which takes no lock and sees nothing uncommitted. Two audit writes that overlap in
 * time therefore **both** read "there is no previous row" and both start a chain of their own —
 * observed as two rows with `prev_hash is null` and the second one failing the invariant job's
 * check. In a live academy that is not an exotic case: two people saving at once is a Tuesday.
 *
 * The assertions are deliberately about the *property* (one root, every link intact) rather than
 * about which row got which id, so the test does not encode an implementation detail.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Client } from "pg";
import { record, type AuditContext } from "../../src/audit.js";
import { withTransaction } from "../../src/db/pool.js";
import { closeTestPool, migratorClient, prepareTestDatabase, resetData } from "../helpers/test-db.js";

const OWNER_ID = "01920000-0000-7000-8000-000000000001";
const COACH_ID = "01920000-0000-7000-8000-000000000002";

const ctx = (requestId: string): AuditContext => ({
  actorUserId: null,
  actorRole: null,
  requestId,
  ip: null,
});

interface ChainSummary {
  rows: number;
  roots: number;
  brokenLinks: number;
}

/** The chain's own health, in the same terms the nightly invariant job uses. */
async function chainSummary(client: Client): Promise<ChainSummary> {
  const result = await client.query<{ rows: string; roots: string; broken: string }>(
    `with chained as (
       select id, prev_hash, row_hash, lag(row_hash) over (order by id) as expected_prev
         from audit_logs
     )
     select count(*)::text as rows,
            count(*) filter (where prev_hash is null)::text as roots,
            count(*) filter (
              where coalesce(prev_hash, '') is distinct from coalesce(expected_prev, '')
            )::text as broken
       from chained`,
  );
  const row = result.rows[0]!;
  return { rows: Number(row.rows), roots: Number(row.roots), brokenLinks: Number(row.broken) };
}

/** The chain summary read on its own connection, which is then closed. */
async function readChain(): Promise<ChainSummary> {
  const client = await migratorClient();
  try {
    return await chainSummary(client);
  } finally {
    await client.end();
  }
}

describe("the audit hash chain", () => {
  beforeAll(async () => {
    await prepareTestDatabase();
  });

  beforeEach(async () => {
    await resetData();
  });

  afterAll(async () => {
    await closeTestPool();
  });

  it("stays a single chain when two audited writes overlap in time (T-SEC-07)", async () => {
    const first = await migratorClient();
    const second = await migratorClient();
    try {
      // Two transactions open at the same time, each writing an audit row — the shape of two
      // requests arriving together. The second one's insert must not land before the first has
      // committed, or it cannot see what it is chaining onto.
      await Promise.all([
        (async () => {
          await first.query("begin");
          await record(first, ctx("concurrency-1"), {
            action: "probe.concurrent.one",
            entityType: "probe",
          });
          // Hold the transaction open so the two writes genuinely overlap.
          await new Promise((resolve) => setTimeout(resolve, 250));
          await first.query("commit");
        })(),
        (async () => {
          await second.query("begin");
          await record(second, ctx("concurrency-2"), {
            action: "probe.concurrent.two",
            entityType: "probe",
          });
          await second.query("commit");
        })(),
      ]);
    } finally {
      await first.end();
      await second.end();
    }

    const summary = await readChain();
    expect(summary.rows).toBe(2);
    // One chain has exactly one root — the oldest row, which had nothing to chain onto.
    expect(summary.roots).toBe(1);
    expect(summary.brokenLinks).toBe(0);
  });

  it("is still a single chain over many overlapping writes (T-SEC-07)", async () => {
    const clients = await Promise.all(Array.from({ length: 5 }, () => migratorClient()));
    try {
      await Promise.all(
        clients.map(async (client, index) => {
          await client.query("begin");
          await record(client, ctx(`concurrency-many-${index}`), {
            action: `probe.concurrent.bulk.${index}`,
            entityType: "probe",
          });
          await new Promise((resolve) => setTimeout(resolve, 50 * (index + 1)));
          await client.query("commit");
        }),
      );
    } finally {
      await Promise.all(clients.map((client) => client.end()));
    }

    const summary = await readChain();
    expect(summary.rows).toBe(5);
    expect(summary.roots).toBe(1);
    expect(summary.brokenLinks).toBe(0);
  });

  it("chains a coach's row onto the owner's — RLS must not fragment the chain (T-SEC-07)", async () => {
    // The defect this holds shut: only an owner may *read* `audit_logs` (0001: audit_read), and
    // the chain trigger read the previous row with the writer's own privileges. So a coach's
    // audit row — a clock-in, an attendance mark — could not see the owner's row and started a
    // new chain of its own. The nightly invariant job then reported a broken hash, which is what
    // a real tamper looks like: the alarm the operator must be able to trust was firing on
    // ordinary coach activity.
    await withTransaction({ userId: OWNER_ID, role: "owner" }, (client) =>
      record(client, { ...ctx("owner-write"), actorUserId: OWNER_ID, actorRole: "owner" }, {
        action: "probe.owner.write",
        entityType: "probe",
      }),
    );
    await withTransaction({ userId: COACH_ID, role: "coach" }, (client) =>
      record(client, { ...ctx("coach-write"), actorUserId: COACH_ID, actorRole: "coach" }, {
        action: "probe.coach.write",
        entityType: "probe",
      }),
    );
    // A write with no identity at all — a failed login is audited too (auth.login no_such_user).
    await withTransaction({ userId: null, role: null }, (client) =>
      record(client, ctx("anonymous-write"), {
        action: "probe.anonymous.write",
        entityType: "probe",
      }),
    );

    const summary = await readChain();
    expect(summary.rows).toBe(3);
    expect(summary.roots).toBe(1);
    expect(summary.brokenLinks).toBe(0);
  });

  it("chains a row written after a rolled-back one onto the last committed row", async () => {
    const rolled = await migratorClient();
    await rolled.query("begin");
    await record(rolled, ctx("rollback"), { action: "probe.rolled_back", entityType: "probe" });
    await rolled.query("rollback");
    // The rolled-back insert burns an id, so the shell of a rolled-back row must not be treated
    // as the chain's head by whatever is written next.
    await rolled.query("begin");
    await record(rolled, ctx("after-rollback"), {
      action: "probe.after_rollback",
      entityType: "probe",
    });
    await rolled.query("commit");
    await rolled.end();

    const summary = await readChain();
    expect(summary.rows).toBe(1);
    expect(summary.roots).toBe(1);
    expect(summary.brokenLinks).toBe(0);
  });
});
