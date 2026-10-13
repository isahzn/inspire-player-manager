/**
 * One-time per-database bootstrap, run as a superuser (DATABASE §7).
 *
 * Creates the two runtime roles (`ia_migrator`, `ia_app`), the required extensions,
 * and the schema grants — then sets each role's password from the connection URLs in
 * the environment, so no credential is ever hardcoded. Managed Postgres providers
 * give you a privileged role for exactly this step, and it is safe to re-run.
 *
 * Usage: `npm run bootstrap`  (needs DATABASE_SUPERUSER_URL plus the two role URLs)
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "pg";
import { config as loadEnv } from "dotenv";

loadEnv();

const SQL_FILE = path.resolve(process.cwd(), "db", "bootstrap.sql");

function parse(url: string, name: string): { user: string; password: string; database: string; host: string; port: number } {
  const parsed = new URL(url);
  if (!parsed.password) throw new Error(`${name} must contain a password`);
  return {
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: decodeURIComponent(parsed.pathname.replace(/^\//, "")) || "postgres",
    host: parsed.hostname,
    port: Number(parsed.port || 5432),
  };
}

/**
 * Databases that need the bootstrap applied. Extensions are per-database, and the
 * roles are cluster-wide — so the maintenance database (`postgres`) is included
 * first, which also makes the very first run work before any app database exists.
 */
function targetDatabases(maintenance: string): string[] {
  const fromUrls = [process.env["DATABASE_URL"], process.env["DATABASE_MIGRATOR_URL"]]
    .filter((u): u is string => Boolean(u))
    .map((u) => parse(u, "DATABASE_URL").database);
  const testDb = process.env["TEST_DATABASE_URL"]
    ? parse(process.env["TEST_DATABASE_URL"]!, "TEST_DATABASE_URL").database
    : "ia_test";
  return [...new Set([maintenance, ...fromUrls, testDb])];
}

async function main() {
  const superUrl = process.env["DATABASE_SUPERUSER_URL"];
  if (!superUrl) throw new Error("DATABASE_SUPERUSER_URL is required for bootstrap");
  const superConn = parse(superUrl, "DATABASE_SUPERUSER_URL");
  const migrator = parse(process.env["DATABASE_MIGRATOR_URL"] ?? "", "DATABASE_MIGRATOR_URL");
  const app = parse(process.env["DATABASE_URL"] ?? "", "DATABASE_URL");

  if (migrator.user === app.user) {
    throw new Error("the runtime role and the migration role must be different (DATABASE §7)");
  }
  // SECURITY_AND_PRIVACY §5: secrets shorter than 32 bytes are refused at startup.
  for (const [name, conn] of [["ia_migrator", migrator], ["ia_app", app]] as const) {
    if (conn.password.length < 16) {
      throw new Error(`${name}'s password is too short (min 16 chars for local dev, 32 in production)`);
    }
  }

  const sql = await readFile(SQL_FILE, "utf8");

  for (const database of targetDatabases(superConn.database)) {
    const client = new Client({
      host: superConn.host,
      port: superConn.port,
      user: superConn.user,
      password: superConn.password,
      database,
      client_encoding: "UTF8",
    });
    try {
      await client.connect();
    } catch (err) {
      console.error(`skip ${database}: ${err instanceof Error ? err.message : err}`);
      continue;
    }
    try {
      await client.query(sql);
      // Passwords come from the environment, never from a file in the repo.
      await client.query(`alter role ia_migrator with login password ${quote(migrator.password)}`);
      await client.query(`alter role ia_app with login password ${quote(app.password)}`);
      // The migration role needs CREATE on the database (it creates schemas); the
      // runtime role only ever needs CONNECT.
      await client.query(
        `grant connect, create, temporary on database ${ident(database)} to ia_migrator`,
      );
      await client.query(`grant connect on database ${ident(database)} to ia_app`);
      const roles = await client.query<{ rolname: string; rolbypassrls: boolean }>(
        "select rolname, rolbypassrls from pg_roles where rolname in ('ia_migrator','ia_app') order by rolname",
      );
      console.log(
        `bootstrapped ${database}: ${roles.rows.map((r) => `${r.rolname}(bypassrls=${r.rolbypassrls})`).join(", ")}`,
      );
    } finally {
      await client.end();
    }
  }
  console.log("bootstrap complete");
}

/** Safe literal for a password (single-quote escaped). */
function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Safe identifier (double-quote escaped). */
function ident(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

await main();
