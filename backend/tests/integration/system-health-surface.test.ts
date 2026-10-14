/**
 * SYS-03 — detailed system health, through the real HTTP stack.
 *
 * Two assertions matter more than the status codes. First, that a database with **no worker
 * evidence** is reported as `stale: true` rather than as a comfortable green — that is the
 * honest default and the reason the epoch is allowed onto the page. Second, that once the worker
 * *has* left evidence (a `job_runs` row, which the worker writes through the migrator role), the
 * page reports it, including a failure by name.
 *
 * `job_runs` and `worker_heartbeats` are **not** in `resetData()`'s truncate list (they are the
 * worker's own history, not business data), so this file clears them itself in `beforeEach` with
 * the migrator client. That is deliberate: relying on "probably empty" is how a test starts
 * passing for the wrong reason once any other test writes a run.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { uuidv7 } from "../../src/ids.js";
import { createUser, errorCode, login, request } from "../helpers/auth.js";
import {
  closeTestPool,
  migratorClient,
  prepareTestDatabase,
  resetData,
  testApp,
} from "../helpers/test-db.js";

const OWNER_IP = "198.51.100.131";
const COACH_IP = "198.51.100.132";

type HealthState = "ok" | "degraded" | "down" | "unknown";

interface HealthBody {
  db: { status: HealthState; detail?: string };
  storage: { status: HealthState; detail?: string };
  openwa: { status: HealthState; detail?: string };
  queue: { status: HealthState; detail?: string };
  scheduler: { lastRunAt: string; stale?: boolean; detail?: string };
  lastBackup: { at: string; status: "ok" | "failed" | "unknown"; detail?: string };
  version: string;
}

describe("M8 detailed system health (SYS-03)", () => {
  let app: FastifyInstance;
  let ownerCookie: string;
  let coachCookie: string;
  let coachCsrf: string;

  /** Clears the worker's own history — it is not part of `resetData()`. */
  async function clearWorkerEvidence(): Promise<void> {
    const client = await migratorClient();
    try {
      await client.query("delete from job_runs");
      await client.query("delete from worker_heartbeats");
    } finally {
      await client.end();
    }
  }

  /** Writes one `job_runs` row exactly as the worker would. */
  async function recordRun(args: {
    job: string;
    runKey: string | null;
    status: "running" | "ok" | "failed" | "skipped";
    error?: string;
  }): Promise<void> {
    const client = await migratorClient();
    try {
      await client.query(
        `insert into job_runs (id, job, run_key, status, started_at, finished_at, error)
         values ($1, $2, $3, $4, now(), case when $4 = 'running' then null else now() end, $5)`,
        [uuidv7(), args.job, args.runKey, args.status, args.error ?? null],
      );
    } finally {
      await client.end();
    }
  }

  beforeAll(async () => {
    await prepareTestDatabase();
  });

  beforeEach(async () => {
    await resetData();
    await clearWorkerEvidence();
    await createUser({ username: "sys.owner", role: "owner" });
    const coach = await createUser({ username: "sys.coach", role: "coach" });

    app = await testApp();
    ownerCookie = (await login(app, "sys.owner", "test-password-123456", OWNER_IP)).cookie;
    const coachSession = await login(app, coach.username, coach.password, COACH_IP);
    coachCookie = coachSession.cookie;
    coachCsrf = coachSession.csrfToken;
  });

  afterAll(async () => {
    await app.close();
    await closeTestPool();
  });

  const read = (cookie: string) =>
    request(app, { method: "GET", url: "/api/v1/system/health", cookie });

  it("reports every declared dependency, and no worker as stale rather than green", async () => {
    const response = await read(ownerCookie);
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json() as HealthBody;

    expect(typeof body.version).toBe("string");
    expect(body.version.length).toBeGreaterThan(0);
    expect(body.db.status).toBe("ok");

    // The blocked halves are `unknown` with a reason, never a fabricated session or queue count.
    expect(body.openwa.status).toBe("unknown");
    expect(body.openwa.detail).toMatch(/M7|provider/);
    expect(body.queue.status).toBe("unknown");
    expect(body.queue.detail).toContain("M7");

    // Storage is either usable or reported degraded with the reason — this test is not about
    // which, so it asserts the honest pair rather than pinning the dev machine's var/files.
    expect(["ok", "degraded"]).toContain(body.storage.status);
    expect(typeof body.storage.detail).toBe("string");

    // No worker has ever run here: the epoch, flagged stale, with the reason stated.
    expect(Number.isNaN(Date.parse(body.scheduler.lastRunAt))).toBe(false);
    expect(body.scheduler.stale).toBe(true);
    expect(body.scheduler.detail).toContain("No worker run");
    expect(body.lastBackup.status).toBe("unknown");
  });

  it("refuses a coach — the audit trail and the operator's page are owner-only", async () => {
    const response = await read(coachCookie);
    expect(response.statusCode, response.body).toBe(403);
    expect(errorCode(response)).toBe("FORBIDDEN");
    // And nothing about the system leaked into the refusal.
    expect(response.body).not.toContain("scheduler");
  });

  it("reports the worker's run as fresh once job_runs has evidence", async () => {
    await recordRun({ job: "billing.scheduler", runKey: "2026-01-01", status: "ok" });

    const response = await read(ownerCookie);
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json() as HealthBody;

    expect(body.scheduler.stale).toBe(false);
    // Recent because the row was written now, by this test.
    expect(Date.parse(body.scheduler.lastRunAt)).toBeGreaterThan(Date.now() - 60_000);
  });

  it("names a failing job in the scheduler detail, which is what an operator acts on", async () => {
    await recordRun({ job: "files.pdf_sweeper", runKey: "2026-01-02", status: "failed", error: "boom" });

    const response = await read(ownerCookie);
    const body = response.json() as HealthBody;

    expect(body.scheduler.detail).toContain("files.pdf_sweeper");
    expect(body.scheduler.detail).toMatch(/failing/i);
  });

  it("reports a finished backup from the worker's own job row", async () => {
    await recordRun({ job: "ops.logical_backup", runKey: "2026-01-03", status: "ok" });

    const response = await read(ownerCookie);
    const body = response.json() as HealthBody;

    expect(body.lastBackup.status).toBe("ok");
    expect(Date.parse(body.lastBackup.at)).toBeGreaterThan(Date.now() - 60_000);
  });

  it("reports a failed backup as failed, not as an old success", async () => {
    await recordRun({ job: "ops.logical_backup", runKey: "2026-01-04", status: "ok" });
    await recordRun({ job: "ops.logical_backup", runKey: "2026-01-05", status: "failed", error: "disk" });

    const response = await read(ownerCookie);
    const body = response.json() as HealthBody;

    expect(body.lastBackup.status).toBe("failed");
  });

  // `coachCsrf` is kept so the fixture proves a coach *can* act elsewhere — their refusal here is
  // about the permission, not about a broken session.
  it("does not treat a coach's valid session as an owner", async () => {
    expect(coachCsrf).toBeTruthy();
    const response = await read(coachCookie);
    expect(response.statusCode).toBe(403);
  });
});
