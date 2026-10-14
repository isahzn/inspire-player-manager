#!/usr/bin/env node
/**
 * The worker process (DEPLOYMENT_AND_OPERATIONS §2: `api` and `worker` containers from one
 * image, and §8: the ten scheduled jobs).
 *
 * It is deliberately a **plain loop**, not a framework: one process, one tick every
 * `WORKER_TICK_MS`, jobs run sequentially. There is no broker, no queue table to poll for
 * schedule state, and no in-memory schedule that a restart would lose — every "has this run
 * already?" question is answered by the database (see `claimJobRun`).
 *
 * Consequences worth knowing, all of them deliberate:
 *
 *  - **A restart loses nothing.** A daily job whose time has passed runs on the next tick, and
 *    the unique `(job, run_key)` index means a job that already succeeded cannot run twice.
 *  - **Two workers cannot double-run a job.** Every job takes a session advisory lock named
 *    after it, so a rollout that briefly has two containers is safe.
 *  - **One broken job does not stop the others.** `runJob` records the failure and returns it.
 *
 * `--once` runs a single tick and exits, which is how the jobs are exercised without leaving a
 * process running.
 */
import { pathToFileURL } from "node:url";
import type { PoolClient } from "pg";
import { assertStorageUsable } from "../files/storage.js";
import { config } from "../config.js";
import { JOB, finishJobRun, claimJobRun, writeHeartbeat } from "../ops/job-runs.js";
import { academyClock, closeWorkerDb, jobClient, workerDb, withJobLock } from "./db.js";
import { JOBS, type JobDef, type JobContext } from "./jobs.js";

function log(message: string): void {
  // One line per event, never a dump. The process log is not an audit trail (the DATABASE is).
  process.stdout.write(`${new Date().toISOString()} worker ${message}\n`);
}

/** Due-ness of a daily job: its time has passed on the academy's clock. */
function dailyDue(job: JobDef, time: string): boolean {
  return job.at !== undefined && time >= job.at;
}

/** In-memory due-ness of an interval job. A restart simply runs it once more, which is safe. */
const lastAttempt = new Map<string, number>();

function intervalDue(job: JobDef, now: number): boolean {
  if (job.everyMs === undefined) return false;
  return now - (lastAttempt.get(job.name) ?? 0) >= job.everyMs;
}

/**
 * Runs one job under its own claim and lock.
 *
 * The three shapes are genuinely different, which is why they are not forced into one:
 * a **daily** job claims its academy-local date (so it runs at most once a day, and catches up
 * after downtime); an **interval** job records nothing when it found nothing (it runs every
 * 30 seconds and a row saying "nothing to do" would bury the rows that matter); a **not-built**
 * job is recorded `skipped` with the reason.
 */
async function runOne(job: JobDef, ctx: JobContext): Promise<void> {
  if (job.notBuilt !== undefined) {
    const id = await claimJobRun(ctx.client, { job: job.name, runKey: ctx.today });
    if (id === null) return;
    await finishJobRun(ctx.client, {
      id,
      status: "skipped",
      detail: { notBuilt: true, reason: job.notBuilt },
    });
    return;
  }

  if (job.kind === "daily") {
    const id = await claimJobRun(ctx.client, { job: job.name, runKey: ctx.today });
    if (id === null) return; // already succeeded for this academy-local day
    const startedAt = Date.now();
    try {
      const { detail, status } = await job.run(ctx);
      const recorded = status ?? "ok";
      await finishJobRun(ctx.client, { id, status: recorded, detail: detail ?? null });
      log(
        `${job.name} ${recorded} in ${Date.now() - startedAt}ms${detail ? ` ${JSON.stringify(detail)}` : ""}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await finishJobRun(ctx.client, { id, status: "failed", error: message.slice(0, 500) });
      log(`${job.name} FAILED: ${message}`);
    }
    return;
  }

  // interval
  lastAttempt.set(job.name, Date.now());
  const startedAt = Date.now();
  try {
    const { detail } = await job.run(ctx);
    if (detail && Object.keys(detail).length > 0) {
      const id = await claimJobRun(ctx.client, { job: job.name });
      if (id !== null) {
        await finishJobRun(ctx.client, { id, status: "ok", detail });
      }
      log(`${job.name} ok in ${Date.now() - startedAt}ms ${JSON.stringify(detail)}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const id = await claimJobRun(ctx.client, { job: job.name });
    if (id !== null) await finishJobRun(ctx.client, { id, status: "failed", error: message.slice(0, 500) });
    log(`${job.name} FAILED: ${message}`);
  }
}

/** One pass over every job. Errors are contained per job; the tick itself never throws. */
export async function tick(): Promise<void> {
  const now = Date.now();
  const due = JOBS.filter((job) =>
    job.kind === "daily" ? true : intervalDue(job, now),
  );
  if (due.length === 0) return;

  await jobClient(async (client) => {
    const clock = await academyClock(client);
    for (const job of due) {
      if (job.kind === "daily" && !dailyDue(job, clock.time)) continue;
      const ctx: JobContext = {
        client,
        today: clock.today,
        time: clock.time,
        timezone: clock.timezone,
      };
      // The lock is per job and per connection: a job that another process holds is skipped
      // this tick rather than queued behind it.
      const locked = await withJobLock(job.name, () => runOneWithClient(job, ctx));
      if (!locked.locked) {
        log(`${job.name} skipped: another worker holds the lock`);
      }
    }
  });
}

/**
 * `withJobLock` opens its own connection for the lock; the job's SQL runs on the tick's client.
 * That is the one place the two are separated, and it is safe because the *lock* is what orders
 * concurrent workers, while the work happening on a different connection of the same pool is
 * still inside this process's sequential loop.
 */
async function runOneWithClient(job: JobDef, ctx: JobContext): Promise<void> {
  await runOne(job, ctx);
}

let stopping = false;

async function main(): Promise<void> {
  const once = process.argv.includes("--once");

  // Fail fast, before a single job runs: a misconfigured bucket must stop the process rather
  // than have proofs written where nobody will find them (BACKEND_BUILD_GUIDE §8).
  assertStorageUsable();
  // Proves the pool can be built and the database answers before the loop starts.
  await workerDb().query("select 1");

  const clock = await jobClient((client) => academyClock(client));
  log(
    `starting: version=${config.version} timezone=${clock.timezone} today=${clock.today} ` +
      `jobs=${JOBS.length} tick=${config.worker.tickMs}ms`,
  );

  if (once) {
    // A heartbeat too, so a single-tick run leaves the same evidence a long-running worker
    // does and SYS-03 can tell that a worker existed at all.
    await jobClient((client) => writeHeartbeat(client, config.version));
    await tick();
    await closeWorkerDb();
    log("--once: single tick complete");
    return;
  }

  // The heartbeat is separate from the job table on purpose: it is the one signal that means
  // "a worker is alive", and it must not be confused with "a job ran" (DEPLOYMENT §6).
  const heartbeat = setInterval(() => {
    void jobClient((client) => writeHeartbeat(client, config.version)).catch((err: unknown) => {
      log(`heartbeat FAILED: ${err instanceof Error ? err.message : String(err)}`);
    });
  }, config.worker.heartbeatMs);
  await jobClient((client) => writeHeartbeat(client, config.version));

  let ticking = false;
  const timer = setInterval(() => {
    if (ticking || stopping) return;
    ticking = true;
    void tick()
      .catch((err: unknown) => {
        log(`tick FAILED: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        ticking = false;
      });
  }, config.worker.tickMs);

  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log(`${signal} received: finishing the current tick and stopping`);
    clearInterval(timer);
    clearInterval(heartbeat);
    // Stop accepting new ticks, let the in-flight one finish, then close the pool. A job that
    // is mid-transaction either commits or rolls back with it — nothing is left half-written.
    const wait = setInterval(() => {
      if (ticking) return;
      clearInterval(wait);
      void closeWorkerDb()
        .catch(() => undefined)
        .finally(() => {
          log("stopped");
          process.exit(0);
        });
    }, 250);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

// `import.meta.url` guard so importing this module in a test does not start the loop. It
// compares file URLs rather than matching path suffixes: on Windows `process.argv[1]` is a
// backslash path, and a suffix test for `worker/index.ts` silently never matches — which is
// how the first version of this file exited 0 having done nothing at all.
const invokedDirectly =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedDirectly) {
  main().catch(async (err: unknown) => {
    log(`fatal: ${err instanceof Error ? err.message : String(err)}`);
    await closeWorkerDb().catch(() => undefined);
    process.exit(1);
  });
}

export { JOB };
export type { PoolClient };
