/**
 * M4 (first half) — training schedules, generation and sessions, driven through the real
 * HTTP stack.
 *
 * The two things worth testing hardest here are the ones a status code cannot show:
 * **generation is idempotent** (a second run creates nothing) and **the academy-local
 * 09:00 becomes the right instant** (the conversion happens in SQL, not by guessing an
 * offset). The coach scope is asserted as a row-level fact, not a post-filter.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createUser, errorCode, login, request } from "../helpers/auth.js";
import { closeTestPool, prepareTestDatabase, resetData, testApp } from "../helpers/test-db.js";

const OWNER_IP = "198.51.100.41";
const COACH_IP = "198.51.100.42";

/** ISO day-of-week, 1 = Monday … 7 = Sunday (what `extract(isodow …)` returns). */
function isoDow(iso: string): number {
  return ((new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
}

/** The days in `[from, to]` whose ISO weekday is `dow`. */
function daysWithDow(from: string, to: string, dow: number): string[] {
  const out: string[] = [];
  const cursor = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (cursor <= end) {
    const iso = cursor.toISOString().slice(0, 10);
    if (isoDow(iso) === dow) out.push(iso);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

describe("M4 sessions and schedules (first half)", () => {
  let app: FastifyInstance;
  let ownerCookie: string;
  let ownerCsrf: string;
  let coachCookie: string;
  let coachCsrf: string;
  let coachId: string;

  beforeAll(async () => {
    await prepareTestDatabase();
  });

  beforeEach(async () => {
    await resetData();
    await createUser({ username: "m4.owner", role: "owner" });
    const owner = await createUser({ username: "m4.owner2", role: "owner" });
    const coach = await createUser({ username: "m4.coach", role: "coach" });
    coachId = coach.id;
    app = await testApp();
    const ownerSession = await login(app, owner.username, owner.password, OWNER_IP);
    ownerCookie = ownerSession.cookie;
    ownerCsrf = ownerSession.csrfToken;
    const coachSession = await login(app, coach.username, coach.password, COACH_IP);
    coachCookie = coachSession.cookie;
    coachCsrf = coachSession.csrfToken;
  });

  afterAll(async () => {
    await app.close();
    await closeTestPool();
  });

  async function createGroup(name: string) {
    const response = await request(app, {
      method: "POST",
      url: "/api/v1/age-groups",
      cookie: ownerCookie,
      csrf: ownerCsrf,
      payload: { name },
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json() as { id: string; name: string };
  }

  async function assignCoach(ageGroupId: string, from = "2026-01-01") {
    const response = await request(app, {
      method: "POST",
      url: "/api/v1/coach-assignments",
      cookie: ownerCookie,
      csrf: ownerCsrf,
      payload: { coachUserId: coachId, ageGroupId, assignedFrom: from },
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json() as { id: string };
  }

  async function createSchedule(ageGroupId: string, weekday: number) {
    const response = await request(app, {
      method: "POST",
      url: "/api/v1/training-schedules",
      cookie: ownerCookie,
      csrf: ownerCsrf,
      payload: {
        ageGroupId,
        weekday,
        startTime: "09:00",
        endTime: "10:30",
        venue: "Pitch 1",
        validFrom: "2026-01-01",
      },
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json() as { id: string; startTime: string; isActive: boolean };
  }

  function generate(scheduleId: string, from: string, to: string, key: string) {
    return request(app, {
      method: "POST",
      url: `/api/v1/training-schedules/${scheduleId}/generate`,
      cookie: ownerCookie,
      csrf: ownerCsrf,
      headers: { "idempotency-key": key },
      payload: { from, to },
    });
  }

  it("creates a schedule and generates its sessions idempotently (SCH-01/02)", async () => {
    const group = await createGroup("Under 12");
    const schedule = await createSchedule(group.id, isoDow("2026-10-02"));
    expect(schedule.startTime).toBe("09:00");

    const list = await request(app, {
      method: "GET",
      url: "/api/v1/training-schedules",
      cookie: ownerCookie,
    });
    const rows = (list.json() as { data: { id: string; startTime: string; venue?: string }[] }).data;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.startTime).toBe("09:00");
    expect(rows[0]!.venue).toBe("Pitch 1");

    const from = "2026-10-01";
    const to = "2026-10-31";
    const expected = daysWithDow(from, to, isoDow("2026-10-02"));
    expect(expected.length).toBeGreaterThan(0);

    // The endpoint is idempotent by contract, so the key is required.
    const noKey = await request(app, {
      method: "POST",
      url: `/api/v1/training-schedules/${schedule.id}/generate`,
      cookie: ownerCookie,
      csrf: ownerCsrf,
      payload: { from, to },
    });
    expect(noKey.statusCode).toBe(400);
    expect(errorCode(noKey)).toBe("IDEMPOTENCY_KEY_REQUIRED");

    const first = await generate(schedule.id, from, to, "gen-0001");
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json() as { created: number; skipped: number }).toEqual({
      created: expected.length,
      skipped: 0,
    });

    // A second run over the same window creates nothing — the (schedule_id, session_date)
    // unique index is what makes the operation safe to retry.
    const second = await generate(schedule.id, from, to, "gen-0002");
    expect(second.json() as { created: number; skipped: number }).toEqual({
      created: 0,
      skipped: expected.length,
    });

    // The academy-local 09:00 became the right instant (Asia/Colombo is UTC+05:30), and
    // the business date is the local one.
    const sessions = await request(app, {
      method: "GET",
      url: `/api/v1/sessions?from=${from}&to=${to}&sort=startsAt`,
      cookie: ownerCookie,
    });
    expect(sessions.statusCode, sessions.body).toBe(200);
    const page = sessions.json() as {
      data: { sessionDate: string; startsAt: string; endsAt: string; status: string }[];
      meta: { total: number };
    };
    expect(page.meta.total).toBe(expected.length);
    expect(page.data.map((s) => s.sessionDate)).toEqual(expected);
    expect(page.data[0]!.startsAt).toBe(`${expected[0]}T03:30:00.000Z`);
    expect(page.data[0]!.endsAt).toBe(`${expected[0]}T05:00:00.000Z`);
  });

  it("stops generating once the schedule is deactivated (SCH-01.deactivate)", async () => {
    const group = await createGroup("Under 14");
    const schedule = await createSchedule(group.id, isoDow("2026-10-02"));

    const deactivated = await request(app, {
      method: "POST",
      url: `/api/v1/training-schedules/${schedule.id}/deactivate`,
      cookie: ownerCookie,
      csrf: ownerCsrf,
    });
    expect(deactivated.statusCode, deactivated.body).toBe(200);
    expect((deactivated.json() as { isActive: boolean }).isActive).toBe(false);

    const attempt = await generate(schedule.id, "2026-10-01", "2026-10-31", "gen-1001");
    expect(attempt.statusCode).toBe(422);
    expect(errorCode(attempt)).toBe("VALIDATION_ERROR");

    // A deactivated schedule drops out of the default list but is still reachable.
    const list = await request(app, {
      method: "GET",
      url: "/api/v1/training-schedules",
      cookie: ownerCookie,
    });
    expect((list.json() as { data: unknown[] }).data).toHaveLength(0);
    const withInactive = await request(app, {
      method: "GET",
      url: "/api/v1/training-schedules?includeInactive=true",
      cookie: ownerCookie,
    });
    expect((withInactive.json() as { data: unknown[] }).data).toHaveLength(1);
  });

  it("scopes a coach to the sessions of the group they hold on that date (SES-01/03)", async () => {
    const groupA = await createGroup("Group A");
    const groupB = await createGroup("Group B");
    // The coach holds group A only, and only from October.
    await assignCoach(groupA.id, "2026-10-01");

    const inScope = await createSchedule(groupA.id, isoDow("2026-10-02"));
    const outOfScope = await createSchedule(groupB.id, isoDow("2026-10-02"));

    await generate(inScope.id, "2026-10-01", "2026-10-31", "gen-2001");
    await generate(outOfScope.id, "2026-10-01", "2026-10-31", "gen-2002");

    const all = await request(app, {
      method: "GET",
      url: "/api/v1/sessions?from=2026-10-01&to=2026-10-31",
      cookie: ownerCookie,
    });
    const allRows = (all.json() as { data: { id: string; ageGroup: { id: string } }[] }).data;
    expect(allRows.length).toBeGreaterThan(0);

    const coachList = await request(app, {
      method: "GET",
      url: "/api/v1/sessions?from=2026-10-01&to=2026-10-31",
      cookie: coachCookie,
    });
    expect(coachList.statusCode, coachList.body).toBe(200);
    const coachRows = (coachList.json() as { data: { id: string; ageGroup: { id: string } }[] }).data;
    expect(coachRows.length).toBeGreaterThan(0);
    expect(coachRows.every((s) => s.ageGroup.id === groupA.id)).toBe(true);
    expect(coachRows.length).toBeLessThan(allRows.length);

    // A session of an unassigned group is invisible, so reading it is a 404 — not a 403.
    const theirs = allRows.find((s) => s.ageGroup.id === groupB.id)!;
    const readOut = await request(app, {
      method: "GET",
      url: `/api/v1/sessions/${theirs.id}`,
      cookie: coachCookie,
    });
    expect(readOut.statusCode).toBe(404);
    expect(errorCode(readOut)).toBe("NOT_FOUND");

    const readIn = await request(app, {
      method: "GET",
      url: `/api/v1/sessions/${coachRows[0]!.id}`,
      cookie: coachCookie,
    });
    expect(readIn.statusCode).toBe(200);
  });

  it("refuses a duplicate one-off session, a stale update and a double cancel (SES-02/03/04)", async () => {
    const group = await createGroup("Under 16");

    const created = await request(app, {
      method: "POST",
      url: "/api/v1/sessions",
      cookie: ownerCookie,
      csrf: ownerCsrf,
      payload: {
        ageGroupId: group.id,
        startsAt: "2026-11-01T04:00:00.000Z",
        endsAt: "2026-11-01T05:30:00.000Z",
        venue: "Pitch 2",
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const session = created.json() as { id: string; sessionDate: string; version: number };
    // 04:00 UTC is 09:30 in Colombo.
    expect(session.sessionDate).toBe("2026-11-01");

    const duplicate = await request(app, {
      method: "POST",
      url: "/api/v1/sessions",
      cookie: ownerCookie,
      csrf: ownerCsrf,
      payload: {
        ageGroupId: group.id,
        startsAt: "2026-11-01T04:00:00.000Z",
        endsAt: "2026-11-01T06:00:00.000Z",
      },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(errorCode(duplicate)).toBe("SESSION_DUPLICATE");

    const updated = await request(app, {
      method: "PATCH",
      url: `/api/v1/sessions/${session.id}`,
      cookie: ownerCookie,
      csrf: ownerCsrf,
      payload: { venue: "Pitch 3", version: session.version },
    });
    expect(updated.statusCode, updated.body).toBe(200);
    expect((updated.json() as { venue: string }).venue).toBe("Pitch 3");

    const stale = await request(app, {
      method: "PATCH",
      url: `/api/v1/sessions/${session.id}`,
      cookie: ownerCookie,
      csrf: ownerCsrf,
      payload: { venue: "Pitch 4", version: session.version },
    });
    expect(stale.statusCode).toBe(409);
    expect(errorCode(stale)).toBe("VERSION_CONFLICT");

    const cancelled = await request(app, {
      method: "POST",
      url: `/api/v1/sessions/${session.id}/cancel`,
      cookie: ownerCookie,
      csrf: ownerCsrf,
      payload: { reason: "Heavy rain" },
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    const after = cancelled.json() as { status: string; cancelReason: string };
    expect(after.status).toBe("cancelled");
    expect(after.cancelReason).toBe("Heavy rain");

    const again = await request(app, {
      method: "POST",
      url: `/api/v1/sessions/${session.id}/cancel`,
      cookie: ownerCookie,
      csrf: ownerCsrf,
      payload: { reason: "Double cancel" },
    });
    expect(again.statusCode).toBe(409);
    expect(errorCode(again)).toBe("INVALID_STATE_TRANSITION");
  });

  it("rejects an unknown sort with INVALID_SORT and refuses a coach on owner-only routes", async () => {
    const badSort = await request(app, {
      method: "GET",
      url: "/api/v1/sessions?sort=fullName",
      cookie: ownerCookie,
    });
    expect(badSort.statusCode).toBe(422);
    expect(errorCode(badSort)).toBe("INVALID_SORT");

    const group = await createGroup("Under 18");
    const coachCreate = await request(app, {
      method: "POST",
      url: "/api/v1/training-schedules",
      cookie: coachCookie,
      csrf: coachCsrf,
      payload: { ageGroupId: group.id, weekday: 1, startTime: "17:00", endTime: "18:00", validFrom: "2026-01-01" },
    });
    expect(coachCreate.statusCode).toBe(403);
    expect(errorCode(coachCreate)).toBe("FORBIDDEN");

    const coachSession = await request(app, {
      method: "POST",
      url: "/api/v1/sessions",
      cookie: coachCookie,
      csrf: coachCsrf,
      payload: { ageGroupId: group.id, startsAt: "2026-12-01T04:00:00.000Z", endsAt: "2026-12-01T05:00:00.000Z" },
    });
    expect(coachSession.statusCode).toBe(403);
  });
});
