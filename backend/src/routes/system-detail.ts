/**
 * SYS-03 — detailed system health (API_CONTRACTS §3.8, DEPLOYMENT §6).
 *
 * This is the operator's page, and its whole value is that it is **not** optimistic. Three rules
 * shape it:
 *
 *  1. **`unknown` is a real answer.** The OpenWA session and the message queue cannot be reported
 *     today — the provider adapter and `message_jobs` arrive with M7, which is blocked on a
 *     dedicated phone number (spike S1). Inventing a session state or reporting a healthy,
 *     empty queue would be the one thing a health page must never do, so both are reported
 *     `unknown` **with the reason**. A page that says "unknown, here is why" is useful; one that
 *     shows green because nothing is wired is worse than no page at all.
 *  2. **The worker's evidence is the database's, not this process's.** `scheduler` and
 *     `lastBackup` are read from `job_runs`/`worker_heartbeats` (0015), which the worker writes.
 *     With no worker running this is honest rather than empty: the last activity is the epoch,
 *     `stale` is true, and the detail says no worker run has ever been recorded. The API cannot
 *     report on a worker it does not run.
 *  3. **The read goes through the owner's own RLS transaction** (`asViewer`). These tables are
 *     owner-readable and nobody else's: a coach has no `audit:read`, so the route denies them
 *     before the query, and the policies deny them even if that guard were wrong.
 *
 * The failure and stuck summaries deliberately carry no row contents — a job *name* and a
 * count, never a payload (SECURITY_AND_PRIVACY §3.5: ids and counts, no PII).
 */
import { z } from "zod";
import { config } from "../config.js";
import { asViewer } from "../http/context.js";
import { storageStatus } from "../files/storage.js";
import { readBackupHealth, readSchedulerHealth } from "../ops/job-runs.js";
import type { Handler, HandlerResult } from "../http/router.js";
import { SystemHealth } from "../../spec/components.js";

/** The response is the contract's own type, so a shape change cannot drift unnoticed. */
type SystemHealthBody = z.infer<typeof SystemHealth>;

/**
 * Why there is no OpenWA session state to report.
 *
 * The two cases are different problems and are told apart honestly: a build on the mock provider
 * has nothing linked by design, while a build configured for OpenWA is waiting on M7's adapter,
 * which itself waits on spike S1 (the five provider facts, which need a phone number).
 */
function openwaDetail(): string {
  if (config.messagingProvider !== "openwa") {
    return (
      `Messaging runs on the "${config.messagingProvider}" provider — no OpenWA session is ` +
      "linked, so there is no session state to report. M7 adds the OpenWA adapter."
    );
  }
  return (
    "OpenWA is configured but its adapter arrives with M7: the five provider facts (O18–O22) " +
    "are unverified until spike S1 runs against a linked number, and no M7 code is written " +
    "against guessed behaviour."
  );
}

export const sys03Health: Handler = async ({ viewer }): Promise<HandlerResult> => {
  const body = await asViewer(viewer, async (client): Promise<SystemHealthBody> => {
    // The route is already inside a database transaction, so a failure here means the
    // connection died mid-request rather than "the database is down" — which is why the
    // detail says what was asked, not what it means for the deployment.
    let db: SystemHealthBody["db"];
    try {
      await client.query("select 1");
      db = { status: "ok" };
    } catch {
      db = {
        status: "down",
        detail: "The database did not answer a trivial query while serving this request.",
      };
    }

    const storage = storageStatus();
    const scheduler = await readSchedulerHealth(client, {
      staleMinutes: config.worker.heartbeatStaleMinutes,
    });
    const lastBackup = await readBackupHealth(client);

    // The scheduler's own detail, plus the two things an operator acts on: a failing job and a
    // run that died mid-flight. Names only — a job's payload is not this page's business.
    const problems: string[] = [];
    if (scheduler.failingJobs.length > 0) {
      problems.push(
        `${scheduler.failingJobs.length} job(s) failing: ` +
          `${scheduler.failingJobs.map((job) => job.job).join(", ")}.`,
      );
    }
    if (scheduler.stuck.length > 0) {
      problems.push(
        `${scheduler.stuck.length} run(s) still marked running: ` +
          `${scheduler.stuck.map((job) => job.job).join(", ")}.`,
      );
    }

    return {
      db,
      storage: {
        status: storage.configured ? "ok" : "degraded",
        detail: storage.detail,
      },
      openwa: { status: "unknown", detail: openwaDetail() },
      queue: {
        status: "unknown",
        detail:
          "The message queue arrives with M7 — `message_jobs` does not exist yet, so there is " +
          "nothing queued, sending, failed or awaiting review.",
      },
      scheduler: {
        lastRunAt: scheduler.lastRunAt,
        stale: scheduler.stale,
        detail: problems.length > 0 ? `${scheduler.detail} ${problems.join(" ")}` : scheduler.detail,
      },
      lastBackup: {
        at: lastBackup.at,
        status: lastBackup.status,
        detail: lastBackup.detail,
      },
      version: config.version,
    };
  });

  return { status: 200, body };
};
