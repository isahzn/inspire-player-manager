/**
 * Local PostgreSQL control for machines without Docker (this one).
 *
 * Uses the official PostgreSQL binaries that `embedded-postgres` ships as a
 * dependency, but drives them with `pg_ctl` instead of the library's own API:
 * `EmbeddedPostgres.start()` registers an exit hook that shuts the cluster down
 * when the script ends, which cannot host a database that outlives one command.
 *
 * Real Postgres matters here: RLS policies, exclusion constraints, deferred
 * constraint triggers and `FOR UPDATE` locking cannot be exercised by a simulator
 * (DATABASE §7-§8, TESTING_AND_ACCEPTANCE §1).
 *
 *   npm run db:up       initialise (first run) + start + ensure databases
 *   npm run db:down     stop
 *   npm run db:status   report
 *   npm run db:destroy  stop + delete the cluster
 *
 * Hosts WITH Docker can use docker-compose.yml instead — same port, same
 * DATABASE_URL, so nothing else changes.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { Client } from "pg";
import { config as loadEnv } from "dotenv";

loadEnv();

const EXE = process.platform === "win32" ? ".exe" : "";
const DATA_DIR = path.resolve(process.cwd(), ".pgdata");
const LOG_FILE = path.join(DATA_DIR, "server.log");
const SUPERUSER = "postgres";
const SUPERUSER_PASSWORD = "ia_postgres_dev_password";
const DATABASES = ["ia_dev", "ia_test"];

/** Locates the bundled PostgreSQL binaries for this platform. */
function binaryDir(): string {
  const platformPackages: Record<string, string> = {
    "win32-x64": "windows-x64",
    "win32-arm64": "windows-arm64",
    "linux-x64": "linux-x64",
    "linux-arm64": "linux-arm64",
    "darwin-x64": "darwin-x64",
    "darwin-arm64": "darwin-arm64",
  };
  const key = `${process.platform}-${process.arch}`;
  const platformPackage = platformPackages[key] ?? key;

  // `require.resolve('embedded-postgres')` → …/embedded-postgres/dist/index.js,
  // whose sibling scope directory (`@embedded-postgres`) holds the platform package.
  const require = createRequire(import.meta.url);
  const entry = require.resolve("embedded-postgres");
  const scopeDir = path.resolve(path.dirname(entry), "..", "..", "@embedded-postgres");
  return path.join(scopeDir, platformPackage, "native", "bin");
}

function port(): number {
  const url = new URL(process.env["DATABASE_URL"] ?? "postgres://localhost:55432/ia_dev");
  return Number(url.port || 55432);
}

function superuserUrl(db = "postgres"): string {
  return (
    process.env["DATABASE_SUPERUSER_URL"]?.replace(/\/[^/]*$/, `/${db}`) ??
    `postgres://${SUPERUSER}:${SUPERUSER_PASSWORD}@localhost:${port()}/${db}`
  );
}

/** Spawns a Postgres tool from the bundled binaries, capturing output. */
function run(tool: string, args: string[], opts: { allowFailure?: boolean } = {}) {
  const bin = binaryDir();
  const result = spawnSync(path.join(bin, `${tool}${EXE}`), args, {
    cwd: bin,
    encoding: "utf8",
    env: { ...process.env, PGDATA: DATA_DIR },
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (result.error) throw result.error;
  if (result.status !== 0 && !opts.allowFailure) {
    throw new Error(`${tool} exited ${result.status}\n${output}`);
  }
  return { status: result.status, output };
}

async function initialise() {
  if (existsSync(path.join(DATA_DIR, "PG_VERSION"))) return;
  await mkdir(DATA_DIR, { recursive: true });
  // The password file must live OUTSIDE the data directory: initdb refuses to
  // initialise a directory that is not empty.
  const pwFile = path.join(tmpdir(), `ia-initpw-${process.pid}`);
  await writeFile(pwFile, SUPERUSER_PASSWORD, "utf8");
  console.log(`initialising cluster in ${DATA_DIR}`);
  try {
    run("initdb", [
      "-D",
      DATA_DIR,
      "-U",
      SUPERUSER,
      "--pwfile",
      pwFile,
      "-E",
      "UTF8",
      "--locale=C",
      // `password` (per the generated pg_hba.conf) is plaintext-over-loopback only;
      // this cluster listens on localhost and is never exposed.
      "-A",
      "password",
    ]);
  } finally {
    await rm(pwFile, { force: true });
  }
}

function isRunning(): boolean {
  const { output } = run("pg_ctl", ["status", "-D", DATA_DIR], { allowFailure: true });
  return /server is running|PID:/.test(output);
}

async function ensureDatabases() {
  const admin = new Client({ client_encoding: "UTF8", connectionString: superuserUrl("postgres") });
  await admin.connect();
  try {
    // Guard: a cluster created without an explicit encoding defaults to the
    // Windows console code page (WIN1252), which cannot store Sinhala/Tamil names
    // or the message templates. Fail loudly instead of silently corrupting data.
    const enc = await admin.query<{ encoding: string }>(
      "select pg_encoding_to_char(encoding) as encoding from pg_database where datname = current_database()",
    );
    if (enc.rows[0]?.encoding !== "UTF8") {
      throw new Error(
        `cluster encoding is ${enc.rows[0]?.encoding}, expected UTF8. Run \`npm run db:destroy\` then \`npm run db:up\`.`,
      );
    }
    const existing = await admin.query<{ datname: string }>("select datname from pg_database");
    const names = new Set(existing.rows.map((r) => r.datname));
    for (const db of DATABASES) {
      if (names.has(db)) continue;
      // Identifiers are from a fixed allow-list, never interpolated user input.
      // template0 + explicit UTF8 so the database encoding never depends on the host locale.
      await admin.query(
        `create database "${db}" owner "${SUPERUSER}" encoding 'UTF8' template template0 lc_collate 'C' lc_ctype 'C'`,
      );
      console.log(`created database ${db}`);
    }
  } finally {
    await admin.end();
  }
}

async function up() {
  await initialise();
  if (isRunning()) {
    console.log(`PostgreSQL already running on port ${port()}`);
  } else {
    console.log(`starting PostgreSQL on port ${port()} (log: ${LOG_FILE})`);
    run("pg_ctl", [
      "-D",
      DATA_DIR,
      "-l",
      LOG_FILE,
      "-o",
      `-p ${port()} -c timezone=UTC -c max_connections=100`,
      "-w",
      "-t",
      "60",
      "start",
    ]);
  }
  // pg_ctl -w can report success slightly before the postmaster accepts TCP
  // connections on Windows, so wait for a real connection before creating databases.
  await waitForReady();
  await ensureDatabases();
  console.log(`ready: ${superuserUrl("ia_dev")}`);
}

function down() {
  if (!isRunning()) {
    console.log("not running");
    return;
  }
  run("pg_ctl", ["-D", DATA_DIR, "-m", "fast", "-w", "stop"]);
  console.log("stopped");
}

function status() {
  const { output } = run("pg_ctl", ["status", "-D", DATA_DIR], { allowFailure: true });
  console.log(isRunning() ? `running on port ${port()}` : "not running");
  if (process.env["DB_VERBOSE"] === "1") console.log(output);
}

/** Waits for the cluster to accept connections; used by tests and CI. */
export async function waitForReady(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const client = new Client({
      client_encoding: "UTF8",
      connectionString: superuserUrl("postgres"),
    });
    try {
      await client.connect();
      await client.end();
      return;
    } catch (err) {
      await client.end().catch(() => undefined);
      if (Date.now() > deadline) throw err;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

const isMain = process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/db.ts");
if (isMain) {
  const cmd = process.argv[2];
  try {
    if (cmd === "up") await up();
    else if (cmd === "down") down();
    else if (cmd === "status") status();
    else if (cmd === "destroy") {
      down();
      await rm(DATA_DIR, { recursive: true, force: true });
      console.log("cluster destroyed");
    } else {
      console.error("usage: tsx scripts/db.ts <up|down|status|destroy>");
      process.exitCode = 1;
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }
}

// Keep `spawn` referenced for future use in detached mode without a lint warning.
void spawn;
