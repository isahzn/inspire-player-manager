/**
 * Job bookkeeping — what the worker records, and what SYS-03 reads (DEPLOYMENT §6/§8).
 *
 * Two ideas live together here because they are the same table:
 *
 *  - **Evidence.** Every scheduled run leaves a `job_runs` row naming the job, whether it
 *    succeeded and what it did. SYS-03 is built entirely on this: without it, "the worker is
 *    running" would be an assertion rather than something the operator can look at.
 *  - **Idempotency.** `claimJobRun` is a single `insert … on conflict … where status <> 'ok'`,
 *    so "this daily job already completed for this window" is enforced by the database's own
 *    unique index instead of by the worker's memory. A crashed run leaves `running` and can be
 *    retried; a completed one cannot accidentally run twice.
 *
 * The worker writes through the **migrator** connection (as the operator CLIs do — there is no
 * session to authenticate), which is why every function here takes `AnyQueryable` rather than a
 * `PoolClient`. SYS-03 reads the same tables through the caller's own RLS-scoped transaction.
 */
import type { AnyQueryable } from "../audit.js";
import { uuidv7 } from "../ids.js";

/**
 * The ten jobs of DEPLOYMENT §8, plus the heartbeat and the billing scheduler's own name.
 *
 * A stable name is what makes a typo create a *new* job rather than silently reusing one, so
 * the registry is the only place a name may be written. Jobs owned by M7 are listed and
 * explicitly not built: the worker records them as `skipped` with the reason, which is how the
 * operator sees "this is waiting on a phone number" in the same place as everything else.
 */
export const JOB = {
  heartbeat: "worker.heartbeat",
  billingScheduler: "billing.scheduler",
  sessionGeneration: "sessions.generate",
  reminderEnqueue: "messages.reminder_enqueue",
  messageConsumer: "messages.queue_consumer",
  openwaHealth: "openwa.health",
  pdfSweeper: "files.pdf_sweeper",
  stuckJobs: "ops.stuck_jobs",
  orphanFiles: "files.orphan_sweeper",
  invariant: "ops.invariant_nightly",
  retention: "ops.retention_purge",
  backup: "ops.logical_backup",
} as const;

export type JobName = (typeof JOB)[keyof typeof JOB];

/** Jobs that exist only as a promise until M7 ships. Named so SYS-03 can say why. */
export const NOT_BUILT_JOBS: readonly JobName[] = [
  JOB.reminderEnqueue,
  JOB.messageConsumer,
  JOB.openwaHealth,
];

export type JobStatus = "running" | "ok" | "failed" | "skipped";

export interface JobRunRecord {
  id: string;
  job: string;
  runKey: string | null;
  status: JobStatus;
  detail: Record<string, unknown> | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

/**
 * Claims the right to run `job` for `runKey`, or reports that it already completed.
 *
 * Returns `null` when the job has already succeeded for this window. `ON CONFLICT … WHERE
 * status <> 'ok'` is the whole mechanism: the conflicting row is updated back to `running`
 * only when it did *not* succeed, and a successful row makes the statement affect nothing —
 * so two workers racing the same daily job cannot both proceed, and neither can a worker that
 * restarted.
 *
 * A job with no `runKey` (an interval job) always claims, and is ordered by the caller's
 * advisory lock instead.
 */
export async function claimJobRun(
  client: AnyQueryable,
  args: { job: JobName; runKey?: string | null },
): Promise<string | null> {
  const id = uuidv7();
  const result = await client.query<{ id: string }>(
    `insert into job_runs (id, job, run_key, status, started_at)
     values ($1, $2, $3, 'running', now())
     on conflict (job, run_key) where run_key is not null
       do update set status = 'running', started_at = now(), finished_at = null,
                     error = null, detail = null
       where job_runs.status <> 'ok'
     returning id`,
    [id, args.job, args.runKey ?? null],
  );
  return result.rows[0]?.id ?? null;
}

/** Closes a claimed run. `detail` must stay small and PII-free (SECURITY_AND_PRIVACY §3.5). */
export async function finishJobRun(
  client: AnyQueryable,
  args: {
    id: string;
    status: Exclude<JobStatus, "running">;
    detail?: Record<string, unknown> | null;
    error?: string | null;
  },
): Promise<void> {
  await client.query(
    `update job_runs
        set status = $2, finished_at = now(), detail = $3::jsonb, error = $4
      where id = $1`,
    [
      args.id,
      args.status,
      args.detail === undefined || args.detail === null ? null : JSON.stringify(args.detail),
      args.error ?? null,
    ],
  );
}

export interface JobOutcome<T> {
  /** `false` when the job had already completed for this window and was skipped. */
  ran: boolean;
  result?: T;
  /** The failure, when the job threw. The caller decides whether to keep going. */
  error?: string;
}

/**
 * Runs one job under its own claim, and records the outcome either way.
 *
 * A thrown error is recorded as `failed` and returned rather than rethrown: one broken job must
 * never stop the worker's other jobs from running. The process log keeps the stack; the row
 * keeps the message, trimmed, so SYS-03 can show it without leaking internals.
 */
export async function runJob<T>(
  client: AnyQueryable,
  args: { job: JobName; runKey?: string | null },
  fn: () => Promise<{ detail?: Record<string, unknown> | null; result?: T }>,
): Promise<JobOutcome<T>> {
  const id = await claimJobRun(client, args);
  if (id === null) return { ran: false };

  try {
    const { detail, result } = await fn();
    await finishJobRun(client, { id, status: "ok", detail: detail ?? null });
    return { ran: true, result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await finishJobRun(client, {
      id,
      status: "failed",
      error: message.slice(0, 500),
    });
    return { ran: true, error: message };
  }
}

/** Records a job that is deliberately not built, naming why. */
export async function recordNotBuilt(
  client: AnyQueryable,
  args: { job: JobName; runKey?: string | null; reason: string },
): Promise<void> {
  await runJob(client, args, async () => ({
    detail: { notBuilt: true, reason: args.reason },
  }));
}

// ---------------------------------------------------------------------------
// Heartbeat (§6: the worker touches one row every minute)
// ---------------------------------------------------------------------------
export async function writeHeartbeat(client: AnyQueryable, version: string): Promise<void> {
  await client.query(
    `insert into worker_heartbeats (id, heartbeat_at, version)
     values (1, now(), $1)
     on conflict (id) do update set heartbeat_at = now(), version = excluded.version`,
    [version],
  );
}

// ---------------------------------------------------------------------------
// Reads — what SYS-03 reports
// ---------------------------------------------------------------------------
export interface SchedulerHealth {
  /** The newest evidence of the worker running, or the epoch when there is none. */
  lastRunAt: string;
  stale: boolean;
  detail: string;
  /** The job the timestamp came from; `null` when nothing has ever run. */
  job: string | null;
  /** Jobs whose last run failed, newest first — the operator's actual problem list. */
  failingJobs: { job: string; at: string; error: string | null }[];
  /** Runs still marked `running` after `stuckMinutes`, which means a job died mid-flight. */
  stuck: { job: string; startedAt: string }[];
}

/**
 * Reads the worker's own state.
 *
 * `lastRunAt` is derived from evidence — the newest `job_runs.started_at`, or the heartbeat when
 * that is more recent. With no evidence at all the answer is the epoch with `stale: true`, which
 * is the honest "no worker has ever run here" rather than a comfortable fabrication.
 */
export async function readSchedulerHealth(
  client: AnyQueryable,
  options: { staleMinutes?: number; stuckMinutes?: number; now?: Date } = {},
): Promise<SchedulerHealth> {
  const staleMinutes = options.staleMinutes ?? 5;
  const stuckMinutes = options.stuckMinutes ?? 10;
  const now = options.now ?? new Date();

  const latest = await client.query<{ at: string; job: string | null }>(
    `select coalesce(
              (select started_at from job_runs order by started_at desc limit 1),
              (select heartbeat_at from worker_heartbeats where id = 1)
            )::text as at,
            (select job from job_runs order by started_at desc limit 1) as job`,
  );
  const at = latest.rows[0]?.at ?? null;
  const job = latest.rows[0]?.job ?? null;

  const failing = await client.query<{ job: string; at: string; error: string | null }>(
    `select distinct on (job) job, started_at::text as at, error
       from job_runs
      where status = 'failed'
      order by job, started_at desc`,
  );

  const stuck = await client.query<{ job: string; started_at: string }>(
    `select job, started_at::text as started_at
       from job_runs
      where status = 'running' and started_at < now() - ($1::int * interval '1 minute')
      order by started_at asc`,
    [stuckMinutes],
  );

  if (at === null) {
    return {
      lastRunAt: new Date(0).toISOString(),
      stale: true,
      detail: "No worker run has ever been recorded — start the worker container.",
      job: null,
      failingJobs: [],
      stuck: [],
    };
  }

  const ageMinutes = Math.floor((now.getTime() - new Date(at).getTime()) / 60_000);
  const stale = ageMinutes > staleMinutes;
  return {
    lastRunAt: new Date(at).toISOString(),
    stale,
    detail: stale
      ? `Last worker activity was ${ageMinutes} minutes ago (alert above ${staleMinutes}).`
      : `Last worker activity ${ageMinutes <= 0 ? "just now" : `${ageMinutes} minute(s) ago`}.`,
    job,
    failingJobs: failing.rows.map((row) => ({
      job: row.job,
      at: new Date(row.at).toISOString(),
      error: row.error,
    })),
    stuck: stuck.rows.map((row) => ({
      job: row.job,
      startedAt: new Date(row.started_at).toISOString(),
    })),
  };
}

export interface BackupHealth {
  at: string;
  status: "ok" | "failed" | "unknown";
  detail: string;
}

/**
 * The last logical backup (§7).
 *
 * `unknown` is a real answer, not a placeholder: a deployment that has never run the backup job
 * — or that takes its dumps with a host cron and never reports them — must say so rather than
 * show green. The job records itself in `job_runs` under `ops.logical_backup`, which is what
 * makes this readable without a second table.
 */
export async function readBackupHealth(
  client: AnyQueryable,
  options: { staleHours?: number; now?: Date } = {},
): Promise<BackupHealth> {
  const staleHours = options.staleHours ?? 26;
  const now = options.now ?? new Date();
  const result = await client.query<{ at: string; status: JobStatus; detail: unknown }>(
    `select started_at::text as at, status, detail
       from job_runs
      where job = $1
      order by started_at desc
      limit 1`,
    [JOB.backup],
  );
  const row = result.rows[0];
  if (!row) {
    return {
      at: new Date(0).toISOString(),
      status: "unknown",
      detail: "No logical backup has been recorded by the worker (DEPLOYMENT §7).",
    };
  }
  const ageHours = (now.getTime() - new Date(row.at).getTime()) / 3_600_000;
  if (row.status === "failed") {
    return {
      at: new Date(row.at).toISOString(),
      status: "failed",
      detail: "The last logical backup failed. Check the worker log and the backup target.",
    };
  }
  if (row.status === "skipped") {
    // A deployment that deliberately takes its dumps elsewhere (or has not configured one) must
    // read as `unknown`, not green: the whole point of this field is that it cannot lie.
    const reason =
      row.detail !== null &&
      typeof row.detail === "object" &&
      typeof (row.detail as { reason?: unknown }).reason === "string"
        ? (row.detail as { reason: string }).reason
        : "The last backup run was skipped.";
    return { at: new Date(row.at).toISOString(), status: "unknown", detail: reason };
  }
  return {
    at: new Date(row.at).toISOString(),
    status: "ok",
    detail:
      ageHours > staleHours
        ? `Last backup was ${Math.floor(ageHours)} hours ago (alert above ${staleHours}).`
        : "Nightly logical backup reported.",
  };
}
