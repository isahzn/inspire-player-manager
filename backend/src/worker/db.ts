/**
 * The worker's database access (DEPLOYMENT_AND_OPERATIONS §8).
 *
 * The worker talks to PostgreSQL through the **migrator** role, exactly as the operator CLIs do
 * (`create-owner`, `check:invoices`). That is a deliberate choice, not a shortcut:
 *
 *  - There is no session to authenticate and no user whose RLS identity the work belongs to. A
 *    nightly invariant check *must* see every row, including ones a policy would hide, or it is
 *    not a check.
 *  - None of these jobs is a user action, so nothing here fabricates a `app.app_user_id()`.
 *    Where a job needs a `created_by`, it passes `null` — the columns allow it — instead of
 *    attributing system work to a person.
 *
 * A `Pool` (not a bare `Client`) because the API's own code takes `PoolClient`: the billing
 * engine, the PDF service and `nextDocumentNumber` all do. Checking a client out per job keeps
 * those signatures untouched and lets the job's advisory lock live on the very connection doing
 * the work.
 */
import { Pool, type PoolClient } from "pg";
import { config } from "../config.js";

let workerPool: Pool | null = null;

/** The worker's pool. Throws when the deployment has not supplied a migrator URL. */
export function workerDb(): Pool {
  const url = config.worker.migratorDatabaseUrl;
  if (!url) {
    throw new Error(
      "DATABASE_MIGRATOR_URL is required to run the worker: the scheduled jobs run through the " +
        "migrator role (there is no session to authenticate). See DEPLOYMENT §4.",
    );
  }
  workerPool ??= new Pool({
    connectionString: url,
    max: 4,
    client_encoding: "UTF8",
    application_name: "ia-worker",
    // A long-running job must not be killed by the API's 5 s statement timeout.
    statement_timeout: 0,
  });
  return workerPool;
}

export async function closeWorkerDb(): Promise<void> {
  if (workerPool) {
    await workerPool.end();
    workerPool = null;
  }
}

/**
 * Runs `fn` while holding this job's session advisory lock.
 *
 * The lock is what makes "one worker runs this job" true even when two containers are deployed
 * by mistake during a rollout. `pg_try_advisory_lock` never blocks: a job that cannot take its
 * lock is simply skipped this tick, and the next tick tries again.
 *
 * The unlock lives in a `finally`, so a thrown job cannot leave the lock held for the life of
 * the connection — a leaked lock would silently stop the job from ever running again.
 */
export async function withJobLock<T>(
  job: string,
  fn: () => Promise<T>,
): Promise<{ locked: boolean; value?: T }> {
  const client = await workerDb().connect();
  try {
    const acquired = await client.query<{ ok: boolean }>(
      `select pg_try_advisory_lock(hashtext($1)) as ok`,
      [job],
    );
    if (!acquired.rows[0]?.ok) return { locked: false };
    try {
      return { locked: true, value: await fn() };
    } finally {
      await client.query(`select pg_advisory_unlock(hashtext($1))`, [job]).catch(() => undefined);
    }
  } finally {
    client.release();
  }
}

export interface AcademyClock {
  timezone: string;
  /** The academy-local date (`YYYY-MM-DD`). Every daily job keys off this, never a UTC date. */
  today: string;
  /** The academy-local time (`HH:MM`) — used for the daily schedules. */
  time: string;
}

/** Reads the academy's own clock. A job that runs on the server's clock bills the wrong month. */
export async function academyClock(client: PoolClient): Promise<AcademyClock> {
  const result = await client.query<{ timezone: string; today: string; time: string }>(
    `select timezone,
            (now() at time zone timezone)::date::text as today,
            to_char((now() at time zone timezone), 'HH24:MI') as time
       from academy_settings where id = 1`,
  );
  const row = result.rows[0];
  if (!row) throw new Error("academy_settings row 1 is missing");
  return { timezone: row.timezone, today: row.today, time: row.time };
}

/** Checks a client out for one job run, so the job's SQL and its lock share a connection. */
export async function jobClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await workerDb().connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}
