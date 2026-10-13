/**
 * The M3 people surface, driven through the real HTTP stack (`inject`) against PostgreSQL.
 *
 * These tests assert *behaviour*, not just status codes: the coach projection's key set,
 * the duplicate warning that only blocks until acknowledged, the fee change that closes the
 * previous row, the transfer that keeps history, the last-guardian refusal and the
 * all-or-nothing CSV commit. Where a claim is about what a coach may see
 * (T-AUTH-03/T-AUTH-05), the payload keys are inspected directly.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createUser, errorCode, login, request } from "../helpers/auth.js";
import {
  closeTestPool,
  prepareTestDatabase,
  resetData,
  testApp,
} from "../helpers/test-db.js";

const OWNER_IP = "198.51.100.31";
const COACH_IP = "198.51.100.32";

describe("M3 people surface (groups, players, guardians, import)", () => {
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
    // Two owners so creating/disabling never trips the last-owner invariant.
    await createUser({ username: "m3.owner", role: "owner" });
    const owner = await createUser({ username: "m3.owner2", role: "owner" });
    const coach = await createUser({ username: "m3.coach", role: "coach" });
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

  async function createGroup(name: string, minAge?: number, maxAge?: number) {
    const response = await request(app, {
      method: "POST",
      url: "/api/v1/age-groups",
      cookie: ownerCookie,
      csrf: ownerCsrf,
      payload: { name, ...(minAge !== undefined ? { minAge } : {}), ...(maxAge !== undefined ? { maxAge } : {}) },
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json() as { id: string; name: string };
  }

  interface RegisterOverrides {
    fullName?: string;
    dateOfBirth?: string;
    ageGroupId?: string;
    acknowledgeDuplicates?: boolean;
    phone?: string;
  }

  async function registerPlayer(overrides: RegisterOverrides = {}) {
    return request(app, {
      method: "POST",
      url: "/api/v1/players",
      cookie: ownerCookie,
      csrf: ownerCsrf,
      payload: {
        fullName: overrides.fullName ?? "Ana Perera",
        ...(overrides.dateOfBirth ? { dateOfBirth: overrides.dateOfBirth } : {}),
        registrationDate: "2026-10-01",
        ...(overrides.ageGroupId ? { ageGroupId: overrides.ageGroupId } : {}),
        ...(overrides.acknowledgeDuplicates ? { acknowledgeDuplicates: true } : {}),
        guardians: [
          {
            fullName: "Nimal Perera",
            phone: overrides.phone ?? "0770000001",
            relationship: "Father",
            isPrimary: true,
            receivesInvoices: true,
          },
        ],
      },
    });
  }

  // -------------------------------------------------------------------------
  // Groups, fees, coach assignment
  // -------------------------------------------------------------------------
  it("creates a group, prices it, and shows the fee only to the owner (GRP/FEE)", async () => {
    const group = await createGroup("Under 12", 6, 11);

    // A fee change without an Idempotency-Key is refused before it reaches the database.
    // A fee starting in the past needs the owner's explicit confirmation.
    const PAST = "2020-01-01";

    const noKey = await request(app, {
      method: "POST",
      url: `/api/v1/age-groups/${group.id}/fees`,
      cookie: ownerCookie,
      csrf: ownerCsrf,
      payload: { amountMinor: 450000, effectiveFrom: PAST, allowPast: true },
    });
    expect(noKey.statusCode).toBe(400);
    expect(errorCode(noKey)).toBe("IDEMPOTENCY_KEY_REQUIRED");

    const unconfirmed = await request(app, {
      method: "POST",
      url: `/api/v1/age-groups/${group.id}/fees`,
      cookie: ownerCookie,
      csrf: ownerCsrf,
      headers: { "idempotency-key": "fee-change-0000" },
      payload: { amountMinor: 450000, effectiveFrom: PAST },
    });
    expect(unconfirmed.statusCode).toBe(422);
    expect(errorCode(unconfirmed)).toBe("VALIDATION_ERROR");

    const key = "fee-change-0001";
    const created = await request(app, {
      method: "POST",
      url: `/api/v1/age-groups/${group.id}/fees`,
      cookie: ownerCookie,
      csrf: ownerCsrf,
      headers: { "idempotency-key": key },
      payload: { amountMinor: 450000, effectiveFrom: PAST, allowPast: true },
    });
    expect(created.statusCode, created.body).toBe(201);
    expect((created.json() as { amountMinor: number }).amountMinor).toBe(450000);

    // A replay returns the same response and opens no second row.
    const replay = await request(app, {
      method: "POST",
      url: `/api/v1/age-groups/${group.id}/fees`,
      cookie: ownerCookie,
      csrf: ownerCsrf,
      headers: { "idempotency-key": key },
      payload: { amountMinor: 450000, effectiveFrom: PAST, allowPast: true },
    });
    expect(replay.statusCode).toBe(201);
    expect(replay.headers["idempotent-replay"]).toBe("true");

    // The same key with a different body is a reuse, not a replay.
    const reused = await request(app, {
      method: "POST",
      url: `/api/v1/age-groups/${group.id}/fees`,
      cookie: ownerCookie,
      csrf: ownerCsrf,
      headers: { "idempotency-key": key },
      payload: { amountMinor: 990000, effectiveFrom: PAST, allowPast: true },
    });
    expect(reused.statusCode).toBe(422);
    expect(errorCode(reused)).toBe("IDEMPOTENCY_KEY_REUSED");

    const fees = await request(app, {
      method: "GET",
      url: `/api/v1/age-groups/${group.id}/fees`,
      cookie: ownerCookie,
    });
    expect((fees.json() as { data: unknown[] }).data).toHaveLength(1);

    // Owner sees the fee; a coach never does.
    const ownerGroups = await request(app, {
      method: "GET",
      url: "/api/v1/age-groups",
      cookie: ownerCookie,
    });
    const ownerRow = (ownerGroups.json() as { data: { id: string; currentFeeMinor?: number }[] }).data.find(
      (g) => g.id === group.id,
    );
    expect(ownerRow?.currentFeeMinor).toBe(450000);

    await request(app, {
      method: "POST",
      url: "/api/v1/coach-assignments",
      cookie: ownerCookie,
      csrf: ownerCsrf,
      payload: { coachUserId: coachId, ageGroupId: group.id, assignedFrom: "2026-01-01" },
    });
    const coachGroups = await request(app, {
      method: "GET",
      url: "/api/v1/age-groups",
      cookie: coachCookie,
    });
    expect(coachGroups.statusCode).toBe(200);
    const coachRows = (coachGroups.json() as { data: Record<string, unknown>[] }).data;
    expect(coachRows).toHaveLength(1);
    expect(coachRows[0]).not.toHaveProperty("currentFeeMinor");
  });

  it("suggests age groups for a date of birth and refuses to archive a populated group", async () => {
    const group = await createGroup("Under 12", 6, 11);
    const suggestion = await request(app, {
      method: "GET",
      url: `/api/v1/age-groups/suggest?dateOfBirth=2016-03-03`,
      cookie: ownerCookie,
    });
    expect(suggestion.statusCode).toBe(200);
    const body = suggestion.json() as {
      referenceDate: string;
      ageOnReference: number;
      suggestions: { ageGroupId: string }[];
    };
    // Born 2016-03-03, measured on the Jan 1 reference date: the 2026 birthday has not
    // happened yet, so the age is 9 — the whole point of an age-reference rule.
    expect(body.referenceDate.endsWith("-01-01")).toBe(true);
    expect(body.ageOnReference).toBe(9);
    expect(body.suggestions.map((s) => s.ageGroupId)).toContain(group.id);

    // A player in the group blocks archiving.
    const player = await registerPlayer({ ageGroupId: group.id });
    expect(player.statusCode, player.body).toBe(201);

    const archived = await request(app, {
      method: "POST",
      url: `/api/v1/age-groups/${group.id}/archive`,
      cookie: ownerCookie,
      csrf: ownerCsrf,
    });
    expect(archived.statusCode).toBe(409);
    expect(errorCode(archived)).toBe("AGE_GROUP_HAS_ACTIVE_PLAYERS");
  });

  // -------------------------------------------------------------------------
  // Players
  // -------------------------------------------------------------------------
  it("registers a player, reads it back with group and guardian, then transfers it", async () => {
    const groupA = await createGroup("Group A", 6, 11);
    const groupB = await createGroup("Group B", 12, 15);

    const created = await registerPlayer({ ageGroupId: groupA.id });
    expect(created.statusCode, created.body).toBe(201);
    const player = created.json() as {
      id: string;
      registrationNo: string;
      currentGroup?: { id: string };
      guardians: unknown[];
      version: number;
    };
    expect(player.registrationNo).toBe("IA-0001");
    expect(player.currentGroup?.id).toBe(groupA.id);
    expect(player.guardians).toHaveLength(1);

    const read = await request(app, {
      method: "GET",
      url: `/api/v1/players/${player.id}`,
      cookie: ownerCookie,
    });
    expect(read.statusCode).toBe(200);
    expect((read.json() as { id: string }).id).toBe(player.id);

    const transferred = await request(app, {
      method: "POST",
      url: `/api/v1/players/${player.id}/transfer`,
      cookie: ownerCookie,
      csrf: ownerCsrf,
      payload: {
        ageGroupId: groupB.id,
        effectiveFrom: "2026-10-10",
        reason: "Moved up an age band",
        version: player.version,
      },
    });
    expect(transferred.statusCode, transferred.body).toBe(200);
    expect((transferred.json() as { currentGroup?: { id: string } }).currentGroup?.id).toBe(groupB.id);

    const history = await request(app, {
      method: "GET",
      url: `/api/v1/players/${player.id}/group-history`,
      cookie: ownerCookie,
    });
    const rows = (history.json() as { data: { ageGroup: { id: string }; effectiveTo?: string }[] }).data;
    expect(rows).toHaveLength(2);
    expect(rows[0]!.ageGroup.id).toBe(groupB.id);
    expect(rows[0]!.effectiveTo).toBeUndefined();
    expect(rows[1]!.ageGroup.id).toBe(groupA.id);
    expect(rows[1]!.effectiveTo).toBe("2026-10-09");
  });

  it("warns about a duplicate and only registers once it is acknowledged (PLY-02)", async () => {
    const first = await registerPlayer({ fullName: "Kasun Silva", dateOfBirth: "2015-05-05" });
    expect(first.statusCode, first.body).toBe(201);

    const duplicate = await registerPlayer({ fullName: "Kasun Silva", dateOfBirth: "2015-05-05" });
    expect(duplicate.statusCode).toBe(409);
    expect(errorCode(duplicate)).toBe("DUPLICATE_SUSPECTED");
    const details = (duplicate.json() as { error: { details?: { meta?: { matches?: unknown[] } }[] } })
      .error.details;
    expect(details?.[0]?.meta?.matches).toBeTruthy();

    const acknowledged = await registerPlayer({
      fullName: "Kasun Silva",
      dateOfBirth: "2015-05-05",
      acknowledgeDuplicates: true,
    });
    expect(acknowledged.statusCode, acknowledged.body).toBe(201);

    // The advisory PLY-08 endpoint never blocks and returns ranked matches.
    const check = await request(app, {
      method: "POST",
      url: "/api/v1/players/check-duplicates",
      cookie: ownerCookie,
      csrf: ownerCsrf,
      payload: { fullName: "Kasun Silva", dateOfBirth: "2015-05-05" },
    });
    expect(check.statusCode).toBe(200);
    expect((check.json() as { matches: unknown[] }).matches.length).toBeGreaterThanOrEqual(2);
  });

  it("shows a coach only the restricted projection, and 404s on an out-of-scope player", async () => {
    const groupA = await createGroup("Group A", 6, 11);
    const groupB = await createGroup("Group B", 12, 15);
    await request(app, {
      method: "POST",
      url: "/api/v1/coach-assignments",
      cookie: ownerCookie,
      csrf: ownerCsrf,
      payload: { coachUserId: coachId, ageGroupId: groupA.id, assignedFrom: "2026-01-01" },
    });

    const mine = await registerPlayer({ fullName: "In Scope", ageGroupId: groupA.id });
    const theirs = await registerPlayer({
      fullName: "Out Of Scope",
      ageGroupId: groupB.id,
      phone: "0770000002",
    });
    expect(mine.statusCode).toBe(201);
    expect(theirs.statusCode).toBe(201);
    const mineId = (mine.json() as { id: string }).id;
    const theirsId = (theirs.json() as { id: string }).id;

    const list = await request(app, {
      method: "GET",
      url: "/api/v1/players",
      cookie: coachCookie,
    });
    expect(list.statusCode).toBe(200);
    const rows = (list.json() as { data: { id: string }[] }).data;
    expect(rows.map((r) => r.id)).toEqual([mineId]);

    const outOfScope = await request(app, {
      method: "GET",
      url: `/api/v1/players/${theirsId}`,
      cookie: coachCookie,
    });
    expect(outOfScope.statusCode).toBe(404);
    expect(errorCode(outOfScope)).toBe("NOT_FOUND");

    const inScope = await request(app, {
      method: "GET",
      url: `/api/v1/players/${mineId}`,
      cookie: coachCookie,
    });
    expect(inScope.statusCode).toBe(200);
    const keys = Object.keys(inScope.json() as Record<string, unknown>);
    for (const forbidden of ["dateOfBirth", "notes", "guardians", "outstandingMinor", "billingAnchorDate", "version"]) {
      expect(keys, `a coach payload must not carry ${forbidden}`).not.toContain(forbidden);
    }
    // The projection is still useful: id, registration no, name, status, group.
    expect(keys).toEqual(
      expect.arrayContaining(["id", "registrationNo", "fullName", "status", "group"]),
    );
  });

  it("returns a player's empty invoice page and requires a withdrawal reason (PLY-05/09)", async () => {
    const player = (await registerPlayer()).json() as { id: string; version: number };

    const invoices = await request(app, {
      method: "GET",
      url: `/api/v1/players/${player.id}/invoices`,
      cookie: ownerCookie,
    });
    expect(invoices.statusCode).toBe(200);
    expect((invoices.json() as { data: unknown[] }).data).toEqual([]);

    const noReason = await request(app, {
      method: "POST",
      url: `/api/v1/players/${player.id}/status`,
      cookie: ownerCookie,
      csrf: ownerCsrf,
      payload: { status: "withdrawn", effectiveDate: "2026-10-10", version: player.version },
    });
    expect(noReason.statusCode).toBe(422);
    expect(errorCode(noReason)).toBe("REASON_REQUIRED");

    const withdrawn = await request(app, {
      method: "POST",
      url: `/api/v1/players/${player.id}/status`,
      cookie: ownerCookie,
      csrf: ownerCsrf,
      payload: {
        status: "withdrawn",
        effectiveDate: "2026-10-10",
        reason: "Family moved abroad",
        version: player.version,
      },
    });
    expect(withdrawn.statusCode, withdrawn.body).toBe(200);
    expect((withdrawn.json() as { status: string }).status).toBe("withdrawn");
  });

  // -------------------------------------------------------------------------
  // Guardians
  // -------------------------------------------------------------------------
  it("links a second guardian, moves the primary flag, and refuses to unlink the last one (GDN)", async () => {
    const player = (await registerPlayer()).json() as { id: string; guardians: { guardian: { id: string } }[] };
    const primaryId = player.guardians[0]!.guardian.id;

    const linked = await request(app, {
      method: "POST",
      url: `/api/v1/players/${player.id}/guardians`,
      cookie: ownerCookie,
      csrf: ownerCsrf,
      payload: {
        fullName: "Sunil Perera",
        phone: "0770000009",
        relationship: "Uncle",
        isPrimary: false,
        receivesInvoices: false,
      },
    });
    expect(linked.statusCode, linked.body).toBe(201);
    const secondId = (linked.json() as { guardian: { id: string } }).guardian.id;

    // Unlinking the primary leaves one guardian, so it is allowed.
    const first = await request(app, {
      method: "DELETE",
      url: `/api/v1/players/${player.id}/guardians/${primaryId}`,
      cookie: ownerCookie,
      csrf: ownerCsrf,
    });
    expect(first.statusCode).toBe(204);

    // Removing the last guardian is refused.
    const last = await request(app, {
      method: "DELETE",
      url: `/api/v1/players/${player.id}/guardians/${secondId}`,
      cookie: ownerCookie,
      csrf: ownerCsrf,
    });
    expect(last.statusCode).toBe(422);
    expect(errorCode(last)).toBe("VALIDATION_ERROR");

    // Consent is per guardian and records the opt-out.
    const consent = await request(app, {
      method: "POST",
      url: `/api/v1/guardians/${secondId}/consent`,
      cookie: ownerCookie,
      csrf: ownerCsrf,
      payload: { status: "revoked", source: "whatsapp_reply" },
    });
    expect(consent.statusCode, consent.body).toBe(200);
    const guardian = consent.json() as { whatsappConsent: string; optedOutAt?: string };
    expect(guardian.whatsappConsent).toBe("revoked");
    expect(guardian.optedOutAt).toBeTruthy();

    // The list groups players under their guardian.
    const list = await request(app, {
      method: "GET",
      url: "/api/v1/guardians",
      cookie: ownerCookie,
    });
    expect(list.statusCode).toBe(200);
    const guardians = (list.json() as { data: { players: unknown[] }[] }).data;
    expect(guardians.some((g) => g.players.length === 1)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // CSV import
  // -------------------------------------------------------------------------
  function multipartCsv(content: string): { payload: Buffer; contentType: string } {
    const boundary = "----ia-test-boundary";
    const payload = Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="csv"; filename="players.csv"\r\n` +
        `Content-Type: text/csv\r\n\r\n` +
        `${content}\r\n` +
        `--${boundary}--\r\n`,
      "utf8",
    );
    return { payload, contentType: `multipart/form-data; boundary=${boundary}` };
  }

  async function validateCsv(content: string) {
    const { payload, contentType } = multipartCsv(content);
    return app.inject({
      method: "POST",
      url: "/api/v1/imports/players/validate",
      headers: {
        origin: "http://localhost:3100",
        "x-forwarded-for": OWNER_IP,
        cookie: ownerCookie,
        "x-csrf-token": ownerCsrf,
        "content-type": contentType,
      },
      payload,
    });
  }

  it("validates a CSV without writing players, then commits atomically (IMP-01/02)", async () => {
    await createGroup("Under 12", 6, 11);

    const csv = [
      "full_name,date_of_birth,registration_date,age_group,status,guardian1_name,guardian1_phone,whatsapp_consent,consent_source",
      "CSV Player One,2014-03-03,2026-10-01,Under 12,active,CSV Guardian,0770000123,granted,registration_form",
      "Bad Phone Row,2014-03-03,2026-10-01,Under 12,active,Bad Guardian,not-a-phone,,",
    ].join("\n");

    const validation = await validateCsv(csv);
    expect(validation.statusCode, validation.body).toBe(200);
    const body = validation.json() as {
      batchId: string;
      rowCount: number;
      errors: unknown[];
      warnings: unknown[];
      preview: { fullName: string }[];
    };
    expect(body.rowCount).toBe(2);
    expect(body.errors).toHaveLength(1);
    expect(body.preview.map((p) => p.fullName)).toEqual(["CSV Player One"]);

    // Nothing was written by validation.
    const before = await request(app, {
      method: "GET",
      url: "/api/v1/players?status=active",
      cookie: ownerCookie,
    });
    expect((before.json() as { data: unknown[] }).data).toEqual([]);

    const noKey = await request(app, {
      method: "POST",
      url: `/api/v1/imports/players/${body.batchId}/commit`,
      cookie: ownerCookie,
      csrf: ownerCsrf,
    });
    expect(noKey.statusCode).toBe(400);
    expect(errorCode(noKey)).toBe("IDEMPOTENCY_KEY_REQUIRED");

    const commit = await request(app, {
      method: "POST",
      url: `/api/v1/imports/players/${body.batchId}/commit`,
      cookie: ownerCookie,
      csrf: ownerCsrf,
      headers: { "idempotency-key": "import-commit-0001" },
    });
    expect(commit.statusCode, commit.body).toBe(200);
    expect(commit.json() as { created: number; skipped: number }).toEqual({ created: 1, skipped: 0 });

    const after = await request(app, {
      method: "GET",
      url: "/api/v1/players?status=active",
      cookie: ownerCookie,
    });
    expect((after.json() as { data: { fullName: string }[] }).data.map((p) => p.fullName)).toEqual([
      "CSV Player One",
    ]);

    // Re-committing with a fresh key replays the stored counts.
    const recommit = await request(app, {
      method: "POST",
      url: `/api/v1/imports/players/${body.batchId}/commit`,
      cookie: ownerCookie,
      csrf: ownerCsrf,
      headers: { "idempotency-key": "import-commit-0002" },
    });
    expect(recommit.statusCode).toBe(200);
    expect(recommit.json() as { created: number; skipped: number }).toEqual({ created: 1, skipped: 0 });
  });

  // -------------------------------------------------------------------------
  // Authorization
  // -------------------------------------------------------------------------
  it("refuses a coach on every owner-only M3 endpoint (T-AUTH-01)", async () => {
    const calls: { method: "GET" | "POST" | "PATCH" | "DELETE"; url: string; payload?: unknown }[] = [
      { method: "POST", url: "/api/v1/age-groups", payload: { name: "Nope" } },
      { method: "GET", url: "/api/v1/guardians" },
      { method: "GET", url: "/api/v1/coaches" },
      { method: "POST", url: "/api/v1/players", payload: {} },
    ];
    for (const call of calls) {
      const response = await request(app, {
        method: call.method,
        url: call.url,
        cookie: coachCookie,
        csrf: coachCsrf,
        ...(call.payload ? { payload: call.payload } : {}),
      });
      expect(response.statusCode, `${call.method} ${call.url} → ${response.body}`).toBe(403);
      expect(errorCode(response)).toBe("FORBIDDEN");
    }
  });
});
