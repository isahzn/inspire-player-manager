/**
 * Forward-only migration runner (DATABASE §10).
 *
 * Applies `migrations/NNNN_*.sql` in filename order, each inside its own
 * transaction, recording a checksum in `schema_migrations`. Runs as `ia_migrator`
 * (DDL role) — never as the runtime role, and never as a superuser.
 *
 *   npm run migrate            apply to DATABASE_MIGRATOR_URL
 *   npm run migrate -- --test  apply to TEST_DATABASE_URL (used by the test harness)
 *   npm run seed               load db/seed.sql
 *
 * A migration whose checksum changed after being applied is refused: that means a
 * file was edited in place, which would leave two environments with different
 * schemas and no way to tell.
 */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { Client, type ClientConfig } from "pg";
import { config as loadEnv } from "dotenv";

loadEnv();

const MIGRATIONS_DIR = path.resolve(process.cwd(), "migrations");
const SEED_FILE = path.resolve(process.cwd(), "db", "seed.sql");

function useTestDb(): boolean {
  return process.argv.includes("--test");
}

function connectionString(): string {
  const url = useTestDb()
    ? (process.env["TEST_MIGRATOR_URL"] ?? deriveTestUrl(process.env["DATABASE_MIGRATOR_URL"]))
    : process.env["DATABASE_MIGRATOR_URL"];
  if (!url) throw new Error("DATABASE_MIGRATOR_URL (or TEST_MIGRATOR_URL) is required");
  return url;
}

/** Swaps the database name in a connection URL, keeping the role and password. */
export function deriveTestUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const parsed = new URL(url);
  parsed.pathname = "/ia_test";
  return parsed.toString();
}

export function clientConfig(url: string): ClientConfig {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 5432),
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: decodeURIComponent(parsed.pathname.replace(/^\//, "")),
    // Windows defaults the client encoding to the console code page (WIN1252),
    // which cannot carry the Unicode in our comments, names or message templates.
    client_encoding: "UTF8",
  };
}

async function migrationFiles(): Promise<{ name: string; sql: string; checksum: string }[]> {
  const names = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  return Promise.all(
    names.map(async (name) => {
      const sql = await readFile(path.join(MIGRATIONS_DIR, name), "utf8");
      return { name, sql, checksum: createHash("sha256").update(sql).digest("hex") };
    }),
  );
}

export async function migrate(url = connectionString()): Promise<void> {
  const client = new Client(clientConfig(url));
  await client.connect();
  try {
    await client.query(`
      create table if not exists schema_migrations (
        name        text primary key,
        checksum    text not null,
        applied_at  timestamptz not null default now(),
        applied_by  text not null default current_user
      )
    `);
    const applied = new Map(
      (
        await client.query<{ name: string; checksum: string }>(
          "select name, checksum from schema_migrations",
        )
      ).rows.map((r) => [r.name, r.checksum]),
    );

    for (const file of await migrationFiles()) {
      const previous = applied.get(file.name);
      if (previous && previous !== file.checksum) {
        throw new Error(
          `${file.name} changed after it was applied (checksum mismatch). Add a new migration instead of editing history.`,
        );
      }
      if (previous) continue;
      // One transaction per migration: a failure leaves no half-applied schema.
      await client.query("begin");
      try {
        await client.query(file.sql);
        await client.query("insert into schema_migrations (name, checksum) values ($1, $2)", [
          file.name,
          file.checksum,
        ]);
        await client.query("commit");
        console.log(`applied ${file.name}`);
      } catch (err) {
        await client.query("rollback");
        throw new Error(`${file.name} failed: ${describeSqlError(err, file.sql)}`);
      }
    }
    console.log(`migrations up to date (${applied.size + (await migrationCount())} applied)`);
  } finally {
    await client.end();
  }
}

async function migrationCount(): Promise<number> {
  return 0; // only used for the summary line
}

/** Turns a Postgres error position into `file.sql:LINE: message` — the difference
 * between "syntax error" and a fixable report. */
export function describeSqlError(err: unknown, sql: string): string {
  const message = err instanceof Error ? err.message : String(err);
  const position = (err as { position?: string }).position;
  if (!position) return message;
  const offset = Number(position);
  const line = sql.slice(0, offset).split("\n").length;
  const source = sql.split("\n")[line - 1]?.trim() ?? "";
  return `line ${line}: ${message}\n    > ${source}`;
}

/** Loads the all-environment seed (re-runnable). */
export async function seed(): Promise<void> {
  const sql = await readFile(SEED_FILE, "utf8");
  const url = useTestDb()
    ? (process.env["TEST_MIGRATOR_URL"] ?? deriveTestUrl(process.env["DATABASE_MIGRATOR_URL"]))!
    : process.env["DATABASE_MIGRATOR_URL"]!;
  const client = new Client(clientConfig(url));
  await client.connect();
  try {
    await client.query(sql);
    console.log("seed applied");
  } finally {
    await client.end();
  }
}

const isMain = process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/migrate.ts");
if (isMain) {
  const wantsSeed = process.argv.includes("--seed");
  try {
    await migrate();
    if (wantsSeed) await seed();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }
}
