/**
 * M4 (second half) — the attendance sheet, coach time and a player's attendance history,
 * driven through the real HTTP stack.
 *
 * These tests are written around the four rules a status code cannot show:
 *
 *  - **The roster is a fact about a date.** A player who joined after the session, one who
 *    transferred out before it, and one withdrawn before it are all absent from the same
 *    sheet — asserted by name, not by count.
 *  - **A bulk save is all-or-nothing.** One off-roster record must leave the sheet exactly
 *    as it was: the 422 is checked *and* re-read.
 *  - **The coach's window is a deadline, the owner's is not.** The same session refuses a
 *    coach and accepts an owner.
 *  - **Coach time is the server's.** A check-in cannot be backdated, and the window comes
 *    from settings a coach cannot read.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createUser, errorCode, login, request } from "../helpers/auth.js";
import { closeTestPool, prepareTestDatabase, resetData, testApp } from "../helpers/test-db.js";

const OWNER_IP = "198.51.100.61";
const COACH_IP = "198.51.100.62";

/** The session every roster assertion is made against (a fixed business date). */
const ROSTER_SESSION_START = "2026-10-15T04:00:00.000Z";

interface RosterRow {
  player: { id: string; fullName: string; registrationNo: string };
  record?: { status: string; markedAt: string; markedBy: string; version: number; note?: string };
}

interface AttendanceSheet {
  session: { id: string; status: string; attendanceSummary?: Record<string, number> };
  roster: RosterRow[];
  editableUntil: string;
  canEdit: boolean;
}

describe("M4 attendance, coach time and player history (second half)", () => {
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
    // Two owners: the deferred "at least one active owner" trigger means a fixture set
    // never leaves the academy without one (the same pattern the M4 first-half test uses).
    await createUser({ username: "att.owner", role: "owner" });
    const owner = await createUser({ username: "att.owner2", role: "owner" });
    const coach = await createUser({ username: "att.coach", role: "coach" });
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

  // -------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------
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

  async function createSession(ageGroupId: string, startsAt: string, endsAt: string) {
    const response = await request(app, {
      method: "POST",
      url: "/api/v1/sessions",
      cookie: ownerCookie,
      csrf: ownerCsrf,
      payload: { ageGroupId, startsAt, endsAt },
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json() as { id: string; sessionDate: string; version: number };
  }

  let phoneSeq = 0;
  async function createPlayer(fullName: string, registrationDate: string, ageGroupId?: string) {
    phoneSeq += 1;
    const response = await request(app, {
      method: "POST",
      url: "/api/v1/players",
      cookie: ownerCookie,
      csrf: ownerCsrf,
      payload: {
        fullName,
        dateOfBirth: "2014-05-05",
        registrationDate,
        ...(ageGroupId ? { ageGroupId } : {}),
        guardians: [
          {
            fullName: `${fullName} Guardian`,
            phone: `0771234${String(100 + phoneSeq)}`,
            isPrimary: true,
            receivesInvoices: true,
          },
        ],
      },
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json() as { id: string; fullName: string; version: number };
  }

  function readSheet(sessionId: string, cookie = ownerCookie) {
    return request(app, {
      method: "GET",
      url: `/api/v1/sessions/${sessionId}/attendance`,
      cookie,
    });
  }

  function saveSheet(
    sessionId: string,
    records: { playerId: string; status: string; note?: string; version?: number; reason?: string }[],
    opts: { key: string; cookie?: string; csrf?: string },
  ) {
    return request(app, {
      method: "PUT",
      url: `/api/v1/sessions/${sessionId}/attendance`,
      cookie: opts.cookie ?? ownerCookie,
      csrf: opts.csrf ?? ownerCsrf,
      headers: { "idempotency-key": opts.key },
      payload: { records },
    });
  }

  /**
   * The roster fixture shared by the sheet tests: two players who belong to the group on
   * the session's date, plus three who do not, for three different reasons.
   */
  async function rosterFixture() {
    const group = await createGroup("Under 12");
    const other = await createGroup("Under 14");
    await assignCoach(group.id);

    const inGroup = await createPlayer("Ines Inroster", "2026-01-01", group.id);
    const second = await createPlayer("Sam Second", "2026-01-01", group.id);
    const joinedLate = await createPlayer("Late Joiner", "2026-10-20", group.id);
    const transferredOut = await createPlayer("Out Transfer", "2026-01-01", group.id);
    const withdrawn = await createPlayer("With Drawn", "2026-01-01", group.id);

    // Transferred to another group before the session: the history row for this group
    // closes, so they are not on this date's roster.
    const transfer = await request(app, {
      method: "POST",
      url: `/api/v1/players/${transferredOut.id}/transfer`,
      cookie: ownerCookie,
      csrf: ownerCsrf,
      payload: {
        ageGroupId: other.id,
        effectiveFrom: "2026-10-01",
        reason: "Moved up an age group",
        version: transferredOut.version,
      },
    });
    expect(transfer.statusCode, transfer.body).toBe(200);

    // Withdrawn before the session: `status_effective_date` is what makes them leave the
    // roster from that day on (they stay in every earlier roster).
    const withdrawal = await request(app, {
      method: "POST",
      url: `/api/v1/players/${withdrawn.id}/status`,
      cookie: ownerCookie,
      csrf: ownerCsrf,
      payload: {
        status: "withdrawn",
        effectiveDate: "2026-09-01",
        reason: "Left the academy",
        version: withdrawn.version,
      },
    });
    expect(withdrawal.statusCode, withdrawal.body).toBe(200);

    const session = await createSession(
      group.id,
      ROSTER_SESSION_START,
      "2026-10-15T05:30:00.000Z",
    );
    return { group, other, session, inGroup, second, joinedLate, transferredOut, withdrawn };
  }

  // -------------------------------------------------------------------------
  // ATT-01 / ATT-02
  // -------------------------------------------------------------------------
  it("builds the roster from the group history that covers the session date (ATT-01)", async () => {
    const { session, inGroup, second } = await rosterFixture();

    const response = await readSheet(session.id);
    expect(response.statusCode, response.body).toBe(200);
    const sheet = response.json() as AttendanceSheet;

    // Exactly the two who belonged to the group on 2026-10-15 — the late joiner, the
    // transfer and the withdrawal are all absent, each for its own reason.
    expect(sheet.roster.map((row) => row.player.id).sort()).toEqual(
      [inGroup.id, second.id].sort(),
    );
    expect(sheet.roster.every((row) => row.record === undefined)).toBe(true);
    // The window is the session's start plus the configured 24 hours, and an owner is
    // never windowed.
    expect(sheet.editableUntil).toBe("2026-10-16T04:00:00.000Z");
    expect(sheet.canEdit).toBe(true);
  });

  it("writes nothing at all when one record names a player off the roster (ATT-02)", async () => {
    const { session, inGroup, joinedLate } = await rosterFixture();

    const rejected = await saveSheet(
      session.id,
      [
        { playerId: inGroup.id, status: "present" },
        { playerId: joinedLate.id, status: "present" },
      ],
      { key: "att-off-roster-1" },
    );
    expect(rejected.statusCode, rejected.body).toBe(422);
    expect(errorCode(rejected)).toBe("PLAYER_NOT_ON_ROSTER");

    // All-or-nothing: the good record in the same batch was not saved either.
    const after = await readSheet(session.id);
    const sheet = after.json() as AttendanceSheet;
    expect(sheet.roster.every((row) => row.record === undefined)).toBe(true);
  });

  it("marks the sheet, requires a reason to change a mark, and refuses a stale write (ATT-02/03)", async () => {
    const { session, inGroup, second } = await rosterFixture();

    const first = await saveSheet(
      session.id,
      [
        { playerId: inGroup.id, status: "present", note: "On time" },
        { playerId: second.id, status: "late" },
      ],
      { key: "att-save-1" },
    );
    expect(first.statusCode, first.body).toBe(200);
    const saved = first.json() as { saved: number; roster: RosterRow[] };
    expect(saved.saved).toBe(2);
    expect(saved.roster).toHaveLength(2);

    // An identical repeat saves nothing (and, being unchanged, writes no audit row).
    const repeat = await saveSheet(
      session.id,
      [
        { playerId: inGroup.id, status: "present", note: "On time" },
        { playerId: second.id, status: "late" },
      ],
      { key: "att-save-1b" },
    );
    expect((repeat.json() as { saved: number }).saved).toBe(0);

    // Changing a saved mark needs a reason, for an owner too.
    const noReason = await saveSheet(
      session.id,
      [{ playerId: inGroup.id, status: "absent" }],
      { key: "att-save-2" },
    );
    expect(noReason.statusCode, noReason.body).toBe(422);
    expect(errorCode(noReason)).toBe("REASON_REQUIRED");

    const withReason = await saveSheet(
      session.id,
      [{ playerId: inGroup.id, status: "absent", reason: "Left early, unwell" }],
      { key: "att-save-3" },
    );
    expect(withReason.statusCode, withReason.body).toBe(200);

    // ATT-03 corrects one record, version-guarded.
    const current = (await readSheet(session.id)).json() as AttendanceSheet;
    const target = current.roster.find((row) => row.player.id === inGroup.id)!;
    expect(target.record?.status).toBe("absent");
    const version = target.record!.version;

    const corrected = await request(app, {
      method: "PATCH",
      url: `/api/v1/sessions/${session.id}/attendance/${inGroup.id}`,
      cookie: ownerCookie,
      csrf: ownerCsrf,
      payload: { status: "late", reason: "Rang the office, arrived late", version },
    });
    expect(corrected.statusCode, corrected.body).toBe(200);
    expect((corrected.json() as RosterRow).record?.status).toBe("late");

    const stale = await request(app, {
      method: "PATCH",
      url: `/api/v1/sessions/${session.id}/attendance/${inGroup.id}`,
      cookie: ownerCookie,
      csrf: ownerCsrf,
      payload: { status: "present", reason: "Second correction", version },
    });
    expect(stale.statusCode).toBe(409);
    expect(errorCode(stale)).toBe("VERSION_CONFLICT");
  });

  it("is idempotent: a retried save with the same key replays instead of re-writing (ATT-02)", async () => {
    const { session, inGroup } = await rosterFixture();

    const body = [{ playerId: inGroup.id, status: "present" as const }];
    const first = await saveSheet(session.id, body, { key: "att-idem-1" });
    expect(first.statusCode, first.body).toBe(200);

    const replay = await saveSheet(session.id, body, { key: "att-idem-1" });
    expect(replay.statusCode).toBe(200);
    // The replay is the stored response, so the marks are not applied twice.
    expect((replay.json() as { saved: number }).saved).toBe(1);
    expect(replay.headers["idempotent-replay"]).toBe("true");
  });

  it("refuses a coach outside the edit window but lets an owner write (ATT-02)", async () => {
    const group = await createGroup("Under 16");
    await assignCoach(group.id);
    const player = await createPlayer("Window Player", "2026-01-01", group.id);

    // Long past: `starts_at + 24h` is behind the server's clock.
    const session = await createSession(
      group.id,
      "2026-01-05T04:00:00.000Z",
      "2026-01-05T05:30:00.000Z",
    );

    // A coach may still READ the sheet — reads are not windowed — and is told they cannot edit.
    const coachRead = await readSheet(session.id, coachCookie);
    expect(coachRead.statusCode, coachRead.body).toBe(200);
    expect((coachRead.json() as AttendanceSheet).canEdit).toBe(false);

    const coachSave = await saveSheet(
      session.id,
      [{ playerId: player.id, status: "present" }],
      { key: "att-window-coach", cookie: coachCookie, csrf: coachCsrf },
    );
    expect(coachSave.statusCode, coachSave.body).toBe(422);
    expect(errorCode(coachSave)).toBe("ATTENDANCE_WINDOW_CLOSED");

    const ownerSave = await saveSheet(
      session.id,
      [{ playerId: player.id, status: "present" }],
      { key: "att-window-owner" },
    );
    expect(ownerSave.statusCode, ownerSave.body).toBe(200);
  });

  it("scopes a coach to the sheets of the groups they hold (ATT-01)", async () => {
    const { session, other } = await rosterFixture();

    const read = await readSheet(session.id, coachCookie);
    expect(read.statusCode, read.body).toBe(200);

    // A session of a group the coach does not hold is invisible: 404, not 403.
    const elsewhere = await createSession(
      other.id,
      "2026-10-16T04:00:00.000Z",
      "2026-10-16T05:30:00.000Z",
    );
    const hidden = await readSheet(elsewhere.id, coachCookie);
    expect(hidden.statusCode).toBe(404);
    expect(errorCode(hidden)).toBe("NOT_FOUND");
  });

  it("summarises the sheet on the session itself (Session.attendanceSummary)", async () => {
    const { session, inGroup } = await rosterFixture();

    await saveSheet(session.id, [{ playerId: inGroup.id, status: "present" }], {
      key: "att-summary-1",
    });

    const read = await request(app, {
      method: "GET",
      url: `/api/v1/sessions/${session.id}`,
      cookie: ownerCookie,
    });
    expect(read.statusCode, read.body).toBe(200);
    expect((read.json() as AttendanceSheet["session"]).attendanceSummary).toEqual({
      present: 1,
      absent: 0,
      late: 0,
      excused: 0,
      unmarked: 1,
    });

    // The list carries the same tally, which is what the dashboard's "today" card reads.
    const list = await request(app, {
      method: "GET",
      url: "/api/v1/sessions?from=2026-10-15&to=2026-10-15",
      cookie: ownerCookie,
    });
    const rows = (list.json() as { data: AttendanceSheet["session"][] }).data;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.attendanceSummary).toMatchObject({ present: 1, unmarked: 1 });
  });

  // -------------------------------------------------------------------------
  // CAT-01..05
  // -------------------------------------------------------------------------
  it("takes a self-reported, server-timed check-in inside the window only (CAT-01/02/03)", async () => {
    const group = await createGroup("Under 18");
    await assignCoach(group.id);

    // Starts in 30 minutes, ends in 90: the window (opens 60 before, closes 120 after
    // the end) is open now, whenever "now" is.
    const start = new Date(Date.now() + 30 * 60_000);
    const end = new Date(Date.now() + 90 * 60_000);
    const session = await createSession(group.id, start.toISOString(), end.toISOString());

    // A session ten days out is outside the window — refused before anything is written.
    const far = await createSession(
      group.id,
      "2026-12-01T04:00:00.000Z",
      "2026-12-01T05:30:00.000Z",
    );
    const early = await request(app, {
      method: "POST",
      url: "/api/v1/coach-attendance/check-in",
      cookie: coachCookie,
      csrf: coachCsrf,
      payload: { sessionId: far.id },
    });
    expect(early.statusCode, early.body).toBe(422);
    expect(errorCode(early)).toBe("CHECKIN_WINDOW_CLOSED");

    const before = Date.now();
    const checkIn = await request(app, {
      method: "POST",
      url: "/api/v1/coach-attendance/check-in",
      cookie: coachCookie,
      csrf: coachCsrf,
      payload: { sessionId: session.id, note: "Arrived early" },
    });
    expect(checkIn.statusCode, checkIn.body).toBe(201);
    const record = checkIn.json() as {
      id: string;
      enteredBy: string;
      checkInAt: string;
      checkOutAt?: string;
      version: number;
      coach: { id: string };
    };
    expect(record.enteredBy).toBe("self");
    expect(record.coach.id).toBe(coachId);
    // The timestamp is the server's, taken at request time — never a client's.
    const takenAt = new Date(record.checkInAt).getTime();
    expect(takenAt).toBeGreaterThanOrEqual(before - 1000);
    expect(takenAt).toBeLessThanOrEqual(Date.now() + 1000);

    // One open check-in per coach: a second attempt is refused, not inserted.
    const second = await request(app, {
      method: "POST",
      url: "/api/v1/coach-attendance/check-in",
      cookie: coachCookie,
      csrf: coachCsrf,
      payload: { sessionId: session.id },
    });
    expect(second.statusCode).toBe(409);
    expect(errorCode(second)).toBe("ALREADY_CHECKED_IN");

    const checkOut = await request(app, {
      method: "POST",
      url: "/api/v1/coach-attendance/check-out",
      cookie: coachCookie,
      csrf: coachCsrf,
      payload: { sessionId: session.id },
    });
    expect(checkOut.statusCode, checkOut.body).toBe(200);
    const closed = checkOut.json() as { checkOutAt?: string; version: number };
    expect(closed.checkOutAt).toBeDefined();
    expect(new Date(closed.checkOutAt!).getTime()).toBeGreaterThanOrEqual(takenAt);
    expect(closed.version).toBeGreaterThan(record.version);

    // Clocking out when nothing is open is a 409, and the closed record is in the log.
    const again = await request(app, {
      method: "POST",
      url: "/api/v1/coach-attendance/check-out",
      cookie: coachCookie,
      csrf: coachCsrf,
      payload: { sessionId: session.id },
    });
    expect(again.statusCode).toBe(409);
    expect(errorCode(again)).toBe("NO_OPEN_CHECK_IN");

    const log = await request(app, {
      method: "GET",
      url: "/api/v1/coach-attendance",
      cookie: coachCookie,
    });
    expect(log.statusCode, log.body).toBe(200);
    const page = log.json() as {
      data: { coach: { id: string }; checkInAt: string; checkOutAt?: string }[];
      meta: { total: number };
    };
    expect(page.meta.total).toBe(1);
    expect(page.data[0]!.coach.id).toBe(coachId);
    expect(page.data[0]!.checkOutAt).toBeDefined();
  });

  it("lets an owner record and then correct a coach's time, version-guarded (CAT-04/05)", async () => {
    const group = await createGroup("Under 20");
    await assignCoach(group.id);
    const session = await createSession(
      group.id,
      "2026-02-02T04:00:00.000Z",
      "2026-02-02T05:30:00.000Z",
    );

    const created = await request(app, {
      method: "POST",
      url: "/api/v1/coach-attendance",
      cookie: ownerCookie,
      csrf: ownerCsrf,
      payload: {
        coachUserId: coachId,
        sessionId: session.id,
        checkInAt: "2026-02-02T03:55:00.000Z",
        checkOutAt: "2026-02-02T05:35:00.000Z",
        reason: "Paper sign-in sheet",
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const record = created.json() as {
      id: string;
      enteredBy: string;
      corrected: boolean;
      checkInAt: string;
      checkOutAt: string;
      version: number;
    };
    expect(record.enteredBy).toBe("owner");
    expect(record.corrected).toBe(false);
    expect(record.checkInAt).toBe("2026-02-02T03:55:00.000Z");

    // A record already exists for that (coach, session), so a second one is a 409.
    const duplicate = await request(app, {
      method: "POST",
      url: "/api/v1/coach-attendance",
      cookie: ownerCookie,
      csrf: ownerCsrf,
      payload: {
        coachUserId: coachId,
        sessionId: session.id,
        checkInAt: "2026-02-02T03:50:00.000Z",
        reason: "Duplicate entry attempt",
      },
    });
    expect(duplicate.statusCode).toBe(409);

    const corrected = await request(app, {
      method: "PATCH",
      url: `/api/v1/coach-attendance/${record.id}`,
      cookie: ownerCookie,
      csrf: ownerCsrf,
      payload: {
        checkInAt: "2026-02-02T03:45:00.000Z",
        reason: "Sheet showed 09:15, not 09:25",
        version: record.version,
      },
    });
    expect(corrected.statusCode, corrected.body).toBe(200);
    const fixed = corrected.json() as {
      corrected: boolean;
      checkInAt: string;
      checkOutAt: string;
      version: number;
    };
    expect(fixed.corrected).toBe(true);
    expect(fixed.checkInAt).toBe("2026-02-02T03:45:00.000Z");
    // An untouched field keeps its value — only what was sent changes.
    expect(fixed.checkOutAt).toBe("2026-02-02T05:35:00.000Z");

    const stale = await request(app, {
      method: "PATCH",
      url: `/api/v1/coach-attendance/${record.id}`,
      cookie: ownerCookie,
      csrf: ownerCsrf,
      payload: { checkInAt: "2026-02-02T03:40:00.000Z", reason: "Stale attempt", version: record.version },
    });
    expect(stale.statusCode).toBe(409);
    expect(errorCode(stale)).toBe("VERSION_CONFLICT");

    // A coach does not hold `coach_attendance:manage`, so manual entry is owner-only.
    const coachAttempt = await request(app, {
      method: "POST",
      url: "/api/v1/coach-attendance",
      cookie: coachCookie,
      csrf: coachCsrf,
      payload: {
        coachUserId: coachId,
        sessionId: session.id,
        checkInAt: "2026-02-02T03:50:00.000Z",
        reason: "Coach trying to write their own time",
      },
    });
    expect(coachAttempt.statusCode).toBe(403);
  });

  // -------------------------------------------------------------------------
  // PLY-10
  // -------------------------------------------------------------------------
  it("reports a player's history and leaves cancelled and unmarked sessions out of it (PLY-10)", async () => {
    const { group, session, inGroup, second } = await rosterFixture();

    const later = await createSession(
      group.id,
      "2026-10-22T04:00:00.000Z",
      "2026-10-22T05:30:00.000Z",
    );
    const neverMarked = await createSession(
      group.id,
      "2026-10-29T04:00:00.000Z",
      "2026-10-29T05:30:00.000Z",
    );

    await saveSheet(
      session.id,
      [
        { playerId: inGroup.id, status: "present" },
        { playerId: second.id, status: "late" },
      ],
      { key: "att-ply10-1" },
    );
    await saveSheet(later.id, [{ playerId: inGroup.id, status: "absent" }], {
      key: "att-ply10-2",
    });

    // The absence is marked first, so cancelling the session cannot be what removed it
    // from the history — the rows stay and the maths is what ignores them (T-ATT-10).
    const cancelled = await request(app, {
      method: "POST",
      url: `/api/v1/sessions/${later.id}/cancel`,
      cookie: ownerCookie,
      csrf: ownerCsrf,
      payload: { reason: "Coach unavailable" },
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);

    // The range is explicit because the default stops at today — a future session is not
    // part of a player's history and must not count as "unmarked" either.
    const history = await request(app, {
      method: "GET",
      url: `/api/v1/players/${inGroup.id}/attendance?from=2026-10-01&to=2026-10-31`,
      cookie: ownerCookie,
    });
    expect(history.statusCode, history.body).toBe(200);
    const body = history.json() as {
      summary: Record<string, number>;
      data: { sessionId: string; sessionDate: string; status: string }[];
    };
    // Only the marked, not-cancelled session appears; the cancelled one is gone and the
    // unmarked one has no row to show.
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toEqual({
      sessionId: session.id,
      sessionDate: "2026-10-15",
      status: "present",
    });
    expect(body.summary).toEqual({
      present: 1,
      absent: 0,
      late: 0,
      excused: 0,
      // `neverMarked` only: the cancelled session is excluded from the denominator too.
      unmarked: 1,
    });

    // The other player's history is their own: late on one session, unmarked on two.
    const other = await request(app, {
      method: "GET",
      url: `/api/v1/players/${second.id}/attendance?from=2026-10-01&to=2026-10-31`,
      cookie: ownerCookie,
    });
    const otherBody = other.json() as { summary: Record<string, number>; data: unknown[] };
    expect(otherBody.data).toHaveLength(1);
    expect(otherBody.summary).toEqual({
      present: 0,
      absent: 0,
      late: 1,
      excused: 0,
      unmarked: 1,
    });
  });

  it("gives a coach only the history of players they may see (PLY-10)", async () => {
    const { inGroup, transferredOut } = await rosterFixture();

    const allowed = await request(app, {
      method: "GET",
      url: `/api/v1/players/${inGroup.id}/attendance`,
      cookie: coachCookie,
    });
    expect(allowed.statusCode, allowed.body).toBe(200);

    // The transferred player now belongs to a group the coach does not hold, so the player
    // themselves is invisible: 404, not an empty history.
    const hidden = await request(app, {
      method: "GET",
      url: `/api/v1/players/${transferredOut.id}/attendance`,
      cookie: coachCookie,
    });
    expect(hidden.statusCode).toBe(404);
    expect(errorCode(hidden)).toBe("NOT_FOUND");
  });
});
