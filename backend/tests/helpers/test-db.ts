/**
 * Test harness. Everything runs against a real PostgreSQL (`ia_test`): RLS policies,
 * exclusion constraints, deferred triggers and `FOR UPDATE` cannot be simulated, and the
 * M2 exit evidence depends on them being real (TESTING_AND_ACCEPTANCE §1).
 */
import { Client } from "pg";
import { buildApp } from "../../src/app.js";
import { closePool, pool } from "../../src/db/pool.js";
import { migrate } from "../../scripts/migrate.js";
import type { FastifyInstance } from "fastify";

function url(): string {
  const raw = process.env["DATABASE_MIGRATOR_URL"];
  if (!raw) throw new Error("DATABASE_MIGRATOR_URL must point at ia_test");
  return raw;
}

export function clientConfigFrom(urlString: string) {
  const parsed = new URL(urlString);
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 5432),
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: decodeURIComponent(parsed.pathname.replace(/^\//, "")),
    client_encoding: "UTF8",
  };
}

/** Connects as the migration role (DDL + fixture setup). */
export async function migratorClient(): Promise<Client> {
  const client = new Client(clientConfigFrom(url()));
  await client.connect();
  return client;
}

/** Connects as the runtime role, for tests that must prove RLS as the API sees it. */
export async function runtimeClient(): Promise<Client> {
  const raw = process.env["DATABASE_URL"];
  if (!raw) throw new Error("DATABASE_URL must point at ia_test");
  const client = new Client(clientConfigFrom(raw));
  await client.connect();
  return client;
}

let prepared = false;

/** Applies migrations and the seed once per run; safe to call from every test file. */
export async function prepareTestDatabase(): Promise<void> {
  if (prepared) return;
  await migrate(url());
  const client = await migratorClient();
  try {
    const { readFile } = await import("node:fs/promises");
    const path = await import("node:path");
    const seedSql = await readFile(path.resolve(process.cwd(), "db", "seed.sql"), "utf8");
    await client.query(seedSql);
  } finally {
    await client.end();
  }
  prepared = true;
}

/**
 * Clears mutable rows between tests, keeping the seeded reference data.
 *
 * The deferred "at least one active owner" trigger (T-AUTH-07) would otherwise fire when
 * the last fixture user is deleted — clearing test data is not a real mutation of the
 * academy's owner set, so the trigger is disabled for the duration of the statement and
 * re-enabled immediately after. (Audit rows are append-only by design; only the
 * migration role can delete them, and only here, in tests.)
 */
export async function resetData(): Promise<void> {
  const client = await migratorClient();
  try {
    await client.query("alter table users disable trigger users_require_active_owner_trg");
    try {
      await client.query(`
        truncate table
          user_sessions, user_invites, audit_logs, idempotency_keys,
          receipts, payment_proofs, payment_allocations, payments,
          invoice_access_tokens, invoice_items, invoices, billing_runs,
          player_guardians, player_group_history, players, guardians,
          coach_group_assignments, group_fees, age_groups, import_batches,
          sessions, training_schedules, player_attendance, coach_attendance,
          document_counters
        restart identity;
        delete from users;
      `);
    } finally {
      await client.query("alter table users enable trigger users_require_active_owner_trg");
    }
  } finally {
    await client.end();
  }
}

export async function closeTestPool(): Promise<void> {
  await closePool();
}

/** Builds the real app (same wiring as production) with logging silenced. */
export async function testApp(): Promise<FastifyInstance> {
  return buildApp({ logger: false });
}

export { pool };
