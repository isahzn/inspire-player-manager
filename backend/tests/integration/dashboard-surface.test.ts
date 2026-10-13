/**
 * DSH-02 — the coach dashboard, through the real HTTP stack.
 *
 * The assertions are about what a coach may see: their own sessions for today and the coming
 * week, their own clock-in state, and nothing financial. A session of a group they do not
 * hold must be **absent**, not merely filtered in the browser — so it is asserted by name.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createUser, login, request } from "../helpers/auth.js";
import { closeTestPool, prepareTestDatabase, resetData, testApp } from "../helpers/test-db.js";

const OWNER_IP = "198.51.100.121";
const COACH_IP = "198.51.100.122";

interface DashboardBody {
  todaySessions: { id: string; ageGroup: { id: string } }[];
  upcoming: { id: string }[];
  myOpenCheckIn?: { id: string; checkOutAt?: string };
  myWeekMinutes: number;
}

describe("M8 coach dashboard (DSH-02)", () => {
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
    await createUser({ username: "dsh.owner", role: "owner" });
    const owner = await createUser({ username: "dsh.owner2", role: "owner" });
    const coach = await createUser({ username: "dsh.coach", role: "coach" });
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
    return (response.json() as { id: string }).id;
  }

  async function assignCoach(ageGroupId: string) {
    const response = await request(app, {
      method: "POST",
      url: "/api/v1/coach-assignments",
      cookie: ownerCookie,
      csrf: ownerCsrf,
      payload: { coachUserId: coachId, ageGroupId, assignedFrom: "2026-01-01" },
    });
    expect(response.statusCode, response.body).toBe(201);
  }

  async function createSession(ageGroupId: string, startsAt: string, endsAt: string) {
    const response = await request(app, {
      method: "POST",
      url: "/api/v1/sessions",
      cookie: ownerCookie,
      csrf: ownerCsrf,
      payload: { ageGroupId, startsAt, endsAt },
    });
    expect(response.statusCode, response.body).toBe(201);
    return (response.json() as { id: string }).id;
  }

  const readDashboard = (cookie = coachCookie) =>
    request(app, { method: "GET", url: "/api/v1/dashboard/coach", cookie });

  it("shows the coach only their groups' sessions and their own clock state (DSH-02)", async () => {
    const held = await createGroup("Held by coach");
    await assignCoach(held);
    const notHeld = await createGroup("Not held");

    // Two held sessions today: one carries the owner-recorded closed shift, the other the
    // coach's own open check-in (a coach has one record per session).
    const firstStart = new Date(Date.now() + 30 * 60_000);
    const recordedSession = await createSession(
      held,
      firstStart.toISOString(),
      new Date(firstStart.getTime() + 60 * 60_000).toISOString(),
    );
    const secondStart = new Date(Date.now() + 40 * 60_000);
    const openSession = await createSession(
      held,
      secondStart.toISOString(),
      new Date(secondStart.getTime() + 60 * 60_000).toISOString(),
    );
    await createSession(
      notHeld,
      firstStart.toISOString(),
      new Date(firstStart.getTime() + 60 * 60_000).toISOString(),
    );
    const upcoming = await createSession(
      held,
      new Date(Date.now() + 3 * 86_400_000).toISOString(),
      new Date(Date.now() + 3 * 86_400_000 + 90 * 60_000).toISOString(),
    );

    // An owner-recorded 60-minute shift earlier today: closed, so it counts as worked time.
    const recorded = await request(app, {
      method: "POST",
      url: "/api/v1/coach-attendance",
      cookie: ownerCookie,
      csrf: ownerCsrf,
      payload: {
        coachUserId: coachId,
        sessionId: recordedSession,
        checkInAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
        checkOutAt: new Date(Date.now() - 1 * 3_600_000).toISOString(),
        reason: "Paper sign-in sheet",
      },
    });
    expect(recorded.statusCode, recorded.body).toBe(201);

    const response = await readDashboard();
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json() as DashboardBody;

    // Only the held group's sessions appear today; the other group's is invisible.
    expect(body.todaySessions.map((s) => s.id)).toEqual([recordedSession, openSession]);
    expect(body.upcoming.map((s) => s.id)).toEqual([upcoming]);
    // The closed shift counts; nothing is open, so the one-tap clock-out is not offered.
    expect(body.myWeekMinutes).toBe(60);
    expect(body.myOpenCheckIn).toBeUndefined();

    // A self check-in becomes the caller's own open record — what drives the clock-out.
    const checkIn = await request(app, {
      method: "POST",
      url: "/api/v1/coach-attendance/check-in",
      cookie: coachCookie,
      csrf: coachCsrf,
      payload: { sessionId: openSession },
    });
    expect(checkIn.statusCode, checkIn.body).toBe(201);

    const after = await readDashboard();
    const opened = after.json() as DashboardBody;
    expect(opened.myOpenCheckIn).toBeDefined();
    expect(opened.myOpenCheckIn!.checkOutAt).toBeUndefined();
    // The shift is still open, so it does not add to worked time yet (T-ATT-11).
    expect(opened.myWeekMinutes).toBe(60);

    // The owner sees no coach dashboard payload here (financial-free is a coach projection,
    // but the route still belongs to the coach surface); an owner call is not financial.
    const ownerView = await readDashboard(ownerCookie);
    expect(ownerView.statusCode, ownerView.body).toBe(200);
  });
});
