/**
 * T-DB-RLS-02 — the M3 coach scope, proven **at the database** rather than through the API.
 *
 * DATABASE §7 calls RLS a backstop, not the primary control, so the only way to show it
 * holds is to talk to PostgreSQL as `ia_app` with a coach context and look at what the
 * policies return. A coach must reach a player only through a group they hold *today*,
 * and must reach no guardian, fee or import row at all.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Client } from "pg";
import { createUser } from "../helpers/auth.js";
import { prepareTestDatabase, resetData, runtimeClient, migratorClient } from "../helpers/test-db.js";

async function asRole<T>(
  client: Client,
  ctx: { userId: string | null; role: "owner" | "coach" | null },
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  await client.query("begin");
  try {
    await client.query("select set_config('app.user_id', $1, true)", [ctx.userId ?? ""]);
    await client.query("select set_config('app.role', $1, true)", [ctx.role ?? ""]);
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback").catch(() => undefined);
    throw err;
  }
}

describe("M3 coach scope as the runtime role (T-DB-RLS-02)", () => {
  let app: Client;
  let migrator: Client;

  beforeAll(async () => {
    await prepareTestDatabase();
    app = await runtimeClient();
    migrator = await migratorClient();
  });

  beforeEach(async () => {
    await resetData();
  });

  afterAll(async () => {
    await app.end();
    await migrator.end();
  });

  /**
   * Two groups, two players (one per group), a coach holding only group A, and a fee.
   * Inserted as `ia_migrator` so the fixtures exist independently of any policy.
   */
  async function fixtures() {
    const owner = await createUser({ username: "p3.owner", role: "owner" });
    const coach = await createUser({ username: "p3.coach", role: "coach" });
    const otherCoach = await createUser({ username: "p3.coach2", role: "coach" });

    const groupA = "01890f4a-0001-7000-8000-000000000001";
    const groupB = "01890f4a-0002-7000-8000-000000000002";
    const playerA = "01890f4a-0011-7000-8000-000000000011";
    const playerB = "01890f4a-0012-7000-8000-000000000012";
    const guardianA = "01890f4a-0021-7000-8000-000000000021";

    await migrator.query(
      `insert into age_groups (id, name, min_age, max_age, sort_order) values
         ($1, 'Group A', 6, 9, 1),
         ($2, 'Group B', 10, 13, 2)`,
      [groupA, groupB],
    );
    await migrator.query(
      `insert into players (id, registration_no, full_name, date_of_birth, registration_date,
                            billing_anchor_date, status, status_effective_date, created_by)
       values ($1, 'IA-0001', 'Player A', '2016-02-02', '2026-01-01', '2026-01-01', 'active', '2026-01-01', $3),
              ($2, 'IA-0002', 'Player B', '2012-02-02', '2026-01-01', '2026-01-01', 'active', '2026-01-01', $3)`,
      [playerA, playerB, owner.id],
    );
    await migrator.query(
      `insert into player_group_history (id, player_id, age_group_id, effective_from, changed_by)
       values (gen_random_uuid(), $1, $3, '2026-01-01', $5),
              (gen_random_uuid(), $2, $4, '2026-01-01', $5)`,
      [playerA, playerB, groupA, groupB, owner.id],
    );
    await migrator.query(
      `insert into guardians (id, full_name, phone_e164) values ($1, 'Guardian A', '+94770000001')`,
      [guardianA],
    );
    await migrator.query(
      `insert into player_guardians (player_id, guardian_id, is_primary) values ($1, $2, true)`,
      [playerA, guardianA],
    );
    await migrator.query(
      `insert into group_fees (id, age_group_id, amount_minor, effective_from, created_by)
       values (gen_random_uuid(), $1, 450000, '2026-01-01', $2)`,
      [groupA, owner.id],
    );
    // The coach holds group A only, from the start of the year.
    await migrator.query(
      `insert into coach_group_assignments (id, coach_user_id, age_group_id, assigned_from, created_by)
       values (gen_random_uuid(), $1, $2, '2026-01-01', $3)`,
      [coach.id, groupA, owner.id],
    );

    return { owner, coach, otherCoach, groupA, groupB, playerA, playerB, guardianA };
  }

  it("scopes a coach's players to the groups they hold today", async () => {
    const fx = await fixtures();

    const seen = await asRole(app, { userId: fx.coach.id, role: "coach" }, (c) =>
      c.query<{ id: string }>("select id from players order by id"),
    );
    expect(seen.rows.map((r) => r.id)).toEqual([fx.playerA]);
    expect(seen.rows.map((r) => r.id)).not.toContain(fx.playerB);

    // The same read as the owner sees both.
    const all = await asRole(app, { userId: fx.owner.id, role: "owner" }, (c) =>
      c.query<{ id: string }>("select id from players order by id"),
    );
    expect(all.rows).toHaveLength(2);
  });

  it("exposes only the assigned groups and their history rows to a coach", async () => {
    const fx = await fixtures();

    const groups = await asRole(app, { userId: fx.coach.id, role: "coach" }, (c) =>
      c.query<{ id: string }>("select id from age_groups"),
    );
    expect(groups.rows.map((r) => r.id)).toEqual([fx.groupA]);

    const history = await asRole(app, { userId: fx.coach.id, role: "coach" }, (c) =>
      c.query<{ age_group_id: string }>("select age_group_id from player_group_history"),
    );
    expect(history.rows.map((r) => r.age_group_id)).toEqual([fx.groupA]);

    // A coach with no assignment at all sees nothing.
    const none = await asRole(app, { userId: fx.otherCoach.id, role: "coach" }, (c) =>
      c.query<{ id: string }>("select id from players"),
    );
    expect(none.rows).toHaveLength(0);
  });

  it("returns the coach's group ids from app_coach_group_ids()", async () => {
    const fx = await fixtures();
    const ids = await asRole(app, { userId: fx.coach.id, role: "coach" }, (c) =>
      c.query<{ ids: string[] }>("select app.app_coach_group_ids(current_date) as ids"),
    );
    expect(ids.rows[0]!.ids).toEqual([fx.groupA]);
  });

  it("denies a coach the fee, guardian, link and import tables outright", async () => {
    const fx = await fixtures();
    const counts = await asRole(app, { userId: fx.coach.id, role: "coach" }, async (c) => {
      const out: Record<string, number> = {};
      for (const table of ["group_fees", "guardians", "player_guardians", "import_batches"]) {
        const r = await c.query<{ c: string }>(`select count(*)::text as c from ${table}`);
        out[table] = Number(r.rows[0]!.c);
      }
      return out;
    });
    for (const [table, count] of Object.entries(counts)) {
      expect(count, `${table} must be invisible to a coach`).toBe(0);
    }
  });

  it("lets a coach's write to a player touch no row (no coach write policy)", async () => {
    const fx = await fixtures();
    // `players` has a coach SELECT policy but no coach UPDATE policy, so the UPDATE sees
    // zero rows and silently writes nothing — hence the read-back below, not a throw.
    const result = await asRole(app, { userId: fx.coach.id, role: "coach" }, (c) =>
      c.query("update players set full_name = 'Renamed' where id = $1", [fx.playerA]),
    );
    expect(result.rowCount).toBe(0);

    const check = await migrator.query<{ full_name: string }>(
      "select full_name from players where id = $1",
      [fx.playerA],
    );
    expect(check.rows[0]!.full_name).toBe("Player A");
  });

  it("never lets the runtime role delete a person, only a guardian link", async () => {
    const fx = await fixtures();
    // `player_guardians` is the one grant with DELETE (GDN-04.unlink).
    await asRole(app, { userId: fx.owner.id, role: "owner" }, (c) =>
      c.query("delete from player_guardians where player_id = $1 and guardian_id = $2", [
        fx.playerA,
        fx.guardianA,
      ]),
    );
    await expect(
      asRole(app, { userId: fx.owner.id, role: "owner" }, (c) =>
        c.query("delete from players where id = $1", [fx.playerB]),
      ),
    ).rejects.toThrow(/permission denied/i);
  });
});
