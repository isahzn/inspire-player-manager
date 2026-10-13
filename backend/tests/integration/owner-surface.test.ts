/**
 * The owner read/write surface that M2 serves: USR-01/USR-03 and SET-01/SET-02.
 *
 * Two of these tests exist because of bugs found by driving the real HTTP surface instead
 * of checking a status code:
 *
 *  - USR-01/USR-03 read `users` with the *owner* RLS context. Run against the bare pool
 *    (no `app.role` set) the policies match nothing, so the list came back empty and a
 *    lookup answered 404 — a silent wrong answer, not an error.
 *  - The settings endpoints are the first surface that reads `academy_settings`, which is
 *    FORCE ROW LEVEL SECURITY and owner-only: a coach must be refused by the permission
 *    guard before any row is read.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createUser, errorCode, login, request } from "../helpers/auth.js";
import {
  closeTestPool,
  migratorClient,
  prepareTestDatabase,
  resetData,
  testApp,
} from "../helpers/test-db.js";

describe("owner surface (USR-01/03, SET-01/02)", () => {
  let app: FastifyInstance;
  let ownerCookie: string;
  let ownerCsrf: string;
  let ownerId: string;
  let coachCookie: string;
  let coachCsrf: string;

  beforeAll(async () => {
    await prepareTestDatabase();
  });

  beforeEach(async () => {
    await resetData();
    const owner = await createUser({ username: "surface.owner", role: "owner" });
    const coach = await createUser({ username: "surface.coach", role: "coach" });
    ownerId = owner.id;
    app = await testApp();
    // Distinct client addresses keep each test's logins under the per-IP 10/min limit.
    const ownerSession = await login(app, owner.username, owner.password, "198.51.100.11");
    ownerCookie = ownerSession.cookie;
    ownerCsrf = ownerSession.csrfToken;
    const coachSession = await login(app, coach.username, coach.password, "198.51.100.12");
    coachCookie = coachSession.cookie;
    coachCsrf = coachSession.csrfToken;
  });

  afterAll(async () => {
    await app.close();
    // The API pool is module-level; leaving it open keeps the test process alive.
    await closeTestPool();
  });

  it("lists users for the owner instead of silently returning none (USR-01)", async () => {
    const response = await request(app, { method: "GET", url: "/api/v1/users", cookie: ownerCookie });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      data: { username: string }[];
      meta: { total: number };
    };
    // The fixtures exist, so an empty list means the read ran without its RLS context.
    expect(body.meta.total).toBe(2);
    expect(body.data.map((u) => u.username).sort()).toEqual(["surface.coach", "surface.owner"]);
  });

  it("reads one user by id, and answers 404 for an unknown id (USR-03)", async () => {
    const found = await request(app, {
      method: "GET",
      url: `/api/v1/users/${ownerId}`,
      cookie: ownerCookie,
    });
    expect(found.statusCode).toBe(200);
    expect((found.json() as { username: string }).username).toBe("surface.owner");

    const missing = await request(app, {
      method: "GET",
      url: "/api/v1/users/01890f4a-0000-7000-8000-000000000000",
      cookie: ownerCookie,
    });
    expect(missing.statusCode).toBe(404);
    expect(errorCode(missing)).toBe("NOT_FOUND");
  });

  it("reads the academy profile, patches it and audits the change (SET-01)", async () => {
    const before = await request(app, {
      method: "GET",
      url: "/api/v1/settings/academy",
      cookie: ownerCookie,
    });
    expect(before.statusCode).toBe(200);
    const settings = before.json() as {
      name: string;
      timezone: string;
      coachCanSeeGuardianPhone: boolean;
      beneficiaryAccounts: unknown[];
      ageReferenceRule: string;
    };
    expect(settings.name.length).toBeGreaterThan(0);
    expect(settings.timezone).toBe("Asia/Colombo");
    expect(Array.isArray(settings.beneficiaryAccounts)).toBe(true);

    const patched = await request(app, {
      method: "PATCH",
      url: "/api/v1/settings/academy",
      cookie: ownerCookie,
      csrf: ownerCsrf,
      payload: { shortName: "IA", coachCanSeeGuardianPhone: true, timezone: "Asia/Colombo" },
    });
    expect(patched.statusCode).toBe(200);
    const after = patched.json() as { shortName: string; coachCanSeeGuardianPhone: boolean };
    expect(after.shortName).toBe("IA");
    expect(after.coachCanSeeGuardianPhone).toBe(true);

    // The change and its audit row commit together (DATABASE §3.7).
    const migrator = await migratorClient();
    try {
      const audit = await migrator.query<{ count: string }>(
        `select count(*)::text as count from audit_logs where action = 'settings.academy.update'`,
      );
      expect(Number(audit.rows[0]!.count)).toBe(1);
    } finally {
      await migrator.end();
    }
  });

  it("rejects a partial update that would leave a fixed age rule without its date (SET-01)", async () => {
    const response = await request(app, {
      method: "PATCH",
      url: "/api/v1/settings/academy",
      cookie: ownerCookie,
      csrf: ownerCsrf,
      payload: { ageReferenceRule: "fixed_month_day" },
    });
    expect(response.statusCode).toBe(422);
    expect(errorCode(response)).toBe("VALIDATION_ERROR");
    const body = response.json() as { error: { details?: { field?: string }[] } };
    expect(body.error.details?.map((d) => d.field)).toContain("ageReferenceMonthDay");
  });

  it("reads and updates the billing configuration (SET-02)", async () => {
    const before = await request(app, {
      method: "GET",
      url: "/api/v1/settings/billing",
      cookie: ownerCookie,
    });
    expect(before.statusCode).toBe(200);
    expect((before.json() as { effectNote: string }).effectNote).toBe(
      "Applies to invoices issued after now",
    );

    const patched = await request(app, {
      method: "PATCH",
      url: "/api/v1/settings/billing",
      cookie: ownerCookie,
      csrf: ownerCsrf,
      payload: { billingFrequency: "weekly", weekStartDay: 2 },
    });
    expect(patched.statusCode).toBe(200);
    expect((patched.json() as { billingFrequency: string }).billingFrequency).toBe("weekly");

    // A fixed day of the month only exists in a monthly calendar (1..28).
    const invalid = await request(app, {
      method: "PATCH",
      url: "/api/v1/settings/billing",
      cookie: ownerCookie,
      csrf: ownerCsrf,
      payload: { dueRuleType: "fixed_day_of_month", dueRuleValue: 15 },
    });
    expect(invalid.statusCode).toBe(422);
    const details = (invalid.json() as { error: { details?: { field?: string }[] } }).error.details;
    expect(details?.map((d) => d.field)).toContain("billingFrequency");
  });

  it("refuses a coach on settings, reading no row (T-AUTH-01)", async () => {
    const read = await request(app, {
      method: "GET",
      url: "/api/v1/settings/academy",
      cookie: coachCookie,
    });
    expect(read.statusCode).toBe(403);
    expect(errorCode(read)).toBe("FORBIDDEN");

    const write = await request(app, {
      method: "PATCH",
      url: "/api/v1/settings/billing",
      cookie: coachCookie,
      csrf: coachCsrf,
      payload: { billingFrequency: "weekly" },
    });
    expect(write.statusCode).toBe(403);
  });
});
