/**
 * T-DB-RLS-03 (+ the data-layer half of T-AUTH-01/T-DB-RLS-01).
 *
 * These tests deliberately **bypass the API** and talk to PostgreSQL as `ia_app`, because
 * the point of RLS is that it holds even when the API is wrong (DATABASE §7: "a backstop,
 * not the primary control"). An API-level test cannot prove that.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Client } from "pg";
import { createUser, createInvite } from "../helpers/auth.js";
import { prepareTestDatabase, resetData, runtimeClient, migratorClient } from "../helpers/test-db.js";

/** Runs a query with a request context, exactly as the API would. */
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

describe("RLS as the runtime role (T-DB-RLS-01/03)", () => {
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

  it("runs as a non-privileged role: no superuser, no BYPASSRLS (T-DB-RLS-03)", async () => {
    const result = await app.query<{ current_user: string; rolsuper: boolean; rolbypassrls: boolean }>(
      `select current_user, r.rolsuper, r.rolbypassrls
         from pg_roles r where r.rolname = current_user`,
    );
    const row = result.rows[0]!;
    expect(row.current_user).toBe("ia_app");
    expect(row.rolsuper).toBe(false);
    expect(row.rolbypassrls).toBe(false);
    // And it is not the owner of the tables it reads.
    const owned = await app.query<{ count: string }>(
      `select count(*)::text as count from pg_tables
        where schemaname = 'public' and tableowner = current_user`,
    );
    expect(Number(owned.rows[0]!.count)).toBe(0);
  });

  it("returns nothing without a request context (deny by default)", async () => {
    const users = await app.query("select count(*)::text as c from users");
    expect(users.rows[0]!["c"]).toBe("0");
    const settings = await app.query("select count(*)::text as c from academy_settings");
    expect(settings.rows[0]!["c"]).toBe("0");
  });

  it("lets a coach read only their own user row", async () => {
    const owner = await createUser({ username: "rls.owner", role: "owner" });
    const coach = await createUser({ username: "rls.coach", role: "coach" });

    const asCoach = await asRole(app, { userId: coach.id, role: "coach" }, (c) =>
      c.query<{ id: string }>("select id from users"),
    );
    expect(asCoach.rows.map((r) => r.id)).toEqual([coach.id]);
    expect(asCoach.rows.map((r) => r.id)).not.toContain(owner.id);
  });

  it("denies a coach every owner-only table (T-DB-RLS-01)", async () => {
    const owner = await createUser({ username: "rls.owner2", role: "owner" });
    const coach = await createUser({ username: "rls.coach2", role: "coach" });
    await createInvite(owner.id);

    const counts = await asRole(app, { userId: coach.id, role: "coach" }, async (c) => {
      const tables = [
        "academy_settings",
        "user_invites",
        "idempotency_keys",
        "payment_methods",
        "reminder_rules",
        "message_templates",
        "audit_logs",
      ];
      const out: Record<string, number> = {};
      for (const table of tables) {
        // Identifiers come from a fixed list in this test.
        const r = await c.query<{ c: string }>(`select count(*)::text as c from ${table}`);
        out[table] = Number(r.rows[0]!.c);
      }
      return out;
    });

    for (const [table, count] of Object.entries(counts)) {
      expect(count, `${table} must be invisible to a coach`).toBe(0);
    }
  });

  it("lets an owner read settings and the audit trail", async () => {
    const owner = await createUser({ username: "rls.owner3", role: "owner" });
    const counts = await asRole(app, { userId: owner.id, role: "owner" }, async (c) => {
      const settings = await c.query<{ c: string }>("select count(*)::text as c from academy_settings");
      const methods = await c.query<{ c: string }>("select count(*)::text as c from payment_methods");
      return { settings: Number(settings.rows[0]!.c), methods: Number(methods.rows[0]!.c) };
    });
    expect(counts.settings).toBe(1);
    expect(counts.methods).toBeGreaterThan(0);
  });

  it("makes audit_logs append-only even for the runtime role (T-DB-RLS-03)", async () => {
    const owner = await createUser({ username: "rls.owner4", role: "owner" });

    // Append is allowed (any authenticated caller may audit).
    await asRole(app, { userId: owner.id, role: "owner" }, (c) =>
      c.query(
        `insert into audit_logs (actor_user_id, actor_role, action, entity_type, entity_id, request_id)
         values ($1, 'owner', 'test.append', 'user', $1, 'test')`,
        [owner.id],
      ),
    );

    // UPDATE and DELETE are refused: the grants omit them and a trigger raises.
    await expect(
      asRole(app, { userId: owner.id, role: "owner" }, (c) =>
        c.query("update audit_logs set action = 'tampered'"),
      ),
    ).rejects.toThrow(/append-only|permission denied/i);

    await expect(
      asRole(app, { userId: owner.id, role: "owner" }, (c) =>
        c.query("delete from audit_logs"),
      ),
    ).rejects.toThrow(/append-only|permission denied/i);
  });

  it("hash-chains audit rows so tampering is detectable (T-SEC-07 precondition)", async () => {
    const owner = await createUser({ username: "rls.owner5", role: "owner" });
    await asRole(app, { userId: owner.id, role: "owner" }, async (c) => {
      for (const action of ["chain.one", "chain.two", "chain.three"]) {
        await c.query(
          `insert into audit_logs (actor_user_id, actor_role, action, entity_type, entity_id, request_id)
           values ($1, 'owner', $2, 'user', $1, 'test')`,
          [owner.id, action],
        );
      }
    });
    const rows = await migrator.query<{ action: string; prev_hash: string | null; row_hash: string }>(
      "select action, prev_hash, row_hash from audit_logs where action like 'chain.%' order by id",
    );
    expect(rows.rows).toHaveLength(3);
    expect(rows.rows[0]!.prev_hash).toBeNull();
    expect(rows.rows[1]!.prev_hash).toBe(rows.rows[0]!.row_hash);
    expect(rows.rows[2]!.prev_hash).toBe(rows.rows[1]!.row_hash);
    // Different content, different hash.
    expect(new Set(rows.rows.map((r) => r.row_hash)).size).toBe(3);
  });

  it("does not expose the login helpers to PUBLIC (least privilege)", async () => {
    // PostgreSQL grants EXECUTE to PUBLIC by default, which would hand the password hash
    // to every role. A PUBLIC grant shows up in the ACL as `=X/<owner>`; after the
    // explicit REVOKE there must be no such entry.
    const result = await app.query<{ proname: string; acl: string | null }>(
      `select p.proname, p.proacl::text as acl
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'app'
          and p.proname in ('resolve_session', 'find_user_for_login', 'find_invite')
        order by p.proname`,
    );
    expect(result.rows).toHaveLength(3);
    for (const row of result.rows) {
      expect(row.acl, `${row.proname} must not grant EXECUTE to PUBLIC`).not.toBeNull();
      // A PUBLIC entry has an EMPTY grantee: `{...,=X/owner,...}` — i.e. `X/` directly
      // after `{` or `,`. A named grant looks like `ia_app=X/owner` and is fine.
      expect(row.acl!, `${row.proname} ACL`).not.toMatch(/(^|[{,])X\//);
    }
  });

  it("resolves a session through the SECURITY DEFINER helper and hides unknown ids", async () => {
    const owner = await createUser({ username: "rls.owner6", role: "owner" });
    const { createSession } = await import("../../src/auth/sessions.js");
    const issued = await asRole(app, { userId: owner.id, role: "owner" }, (c) =>
      createSession(c as never, { userId: owner.id, role: "owner" }),
    );

    const found = await app.query("select * from app.resolve_session($1)", [issued.sessionId]);
    expect(found.rows).toHaveLength(1);
    expect(found.rows[0]!["user_id"]).toBe(owner.id);

    const missing = await app.query("select * from app.resolve_session($1)", ["0".repeat(64)]);
    expect(missing.rows).toHaveLength(0);
  });

  it("refuses to leave the academy without an active owner (T-AUTH-07, deferred trigger)", async () => {
    const owner = await createUser({ username: "rls.onlyowner", role: "owner" });
    await expect(
      asRole(app, { userId: owner.id, role: "owner" }, (c) =>
        c.query("update users set status = 'disabled' where id = $1", [owner.id]),
      ),
    ).rejects.toThrow(/LAST_OWNER|active owner/);
  });

  /**
   * Regression for migration 0006. The invariant is a whole-table assertion, but it was
   * evaluated with the invoker's rights, so a coach writing to their own row ran the
   * `count(*)` through `users_self_read` (which sees one row), found no active owner and
   * aborted the transaction at COMMIT — every coach sign-in returned 500. Seen here at
   * the data layer, with an owner present, so the failure cannot be blamed on the API.
   */
  it("lets a coach write their own row even though another user is the owner (0006)", async () => {
    const owner = await createUser({ username: "rls.owner7", role: "owner" });
    const coach = await createUser({ username: "rls.coach7", role: "coach" });

    // Exactly what sign-in does to the coach's row, as the coach.
    await asRole(app, { userId: coach.id, role: "coach" }, (c) =>
      c.query(
        "update users set failed_login_count = 0, last_login_at = now() where id = $1",
        [coach.id],
      ),
    );

    const seen = await migrator.query<{ last_login_at: Date | null }>(
      "select last_login_at from users where id = $1",
      [coach.id],
    );
    expect(seen.rows[0]!.last_login_at).not.toBeNull();

    // And the invariant is still enforced for the owner it was written for.
    await expect(
      asRole(app, { userId: owner.id, role: "owner" }, (c) =>
        c.query("update users set role = 'coach' where id = $1", [owner.id]),
      ),
    ).rejects.toThrow(/LAST_OWNER|active owner/);
  });
});
