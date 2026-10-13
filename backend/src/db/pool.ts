/**
 * Database access.
 *
 * The runtime role is `ia_app`: no DDL, no BYPASSRLS, not a table owner. Every request
 * transaction starts by setting the RLS context (`app.user_id`, `app.role`) with
 * `SET LOCAL`, which is what makes the per-role policies in DATABASE §7 apply to the
 * statements that follow (BACKEND_BUILD_GUIDE §4).
 *
 * Money rule: nothing here parses or formats amounts; amounts are integers end to end.
 */
import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";
import { config } from "../config.js";

export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: config.poolMax,
  // Connection encoding: Windows defaults to the console code page, which cannot
  // carry Unicode names (Sinhala/Tamil) or message templates.
  client_encoding: "UTF8",
  statement_timeout: config.statementTimeoutMs,
  idle_in_transaction_session_timeout: 10_000,
  application_name: "ia-api",
});

export type Db = Pool | PoolClient;

export async function query<R extends QueryResultRow = QueryResultRow>(
  text: string,
  values: readonly unknown[] = [],
): Promise<QueryResult<R>> {
  return pool.query<R>(text, values as unknown[]);
}

export interface RequestContext {
  userId: string | null;
  role: "owner" | "coach" | null;
}

/**
 * Runs `fn` inside one transaction with the RLS context applied.
 *
 * `SET LOCAL` is scoped to the transaction, so a pooled connection cannot leak one
 * request's identity into the next. The context is set with `set_config(..., true)`,
 * which is parameter-bindable and therefore cannot be injected through.
 */
export async function withTransaction<T>(
  ctx: RequestContext,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await applyContext(client, ctx);
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

async function applyContext(client: PoolClient, ctx: RequestContext): Promise<void> {
  await client.query("select set_config('app.user_id', $1, true)", [ctx.userId ?? ""]);
  await client.query("select set_config('app.role', $1, true)", [ctx.role ?? ""]);
}

/** Bare transaction without an identity — startup checks, seeds, background work. */
export async function withRawTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return withTransaction({ userId: null, role: null }, fn);
}

/**
 * Startup self-check (BACKEND_BUILD_GUIDE §4): prove the runtime role cannot bypass
 * RLS and is not a superuser. Refusing to start is the point — a server that silently
 * ran with a privileged role would invalidate every RLS test.
 */
export async function assertRuntimeRoleIsUnprivileged(): Promise<void> {
  const result = await pool.query<{ current_user: string; rolsuper: boolean; rolbypassrls: boolean }>(
    `select current_user,
            r.rolsuper,
            r.rolbypassrls
       from pg_roles r
      where r.rolname = current_user`,
  );
  const row = result.rows[0];
  if (!row) throw new Error("could not read the runtime role's attributes");
  if (row.rolsuper) throw new Error(`runtime role ${row.current_user} is a superuser; use ia_app`);
  if (row.rolbypassrls) {
    throw new Error(`runtime role ${row.current_user} has BYPASSRLS; RLS would not apply`);
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}
