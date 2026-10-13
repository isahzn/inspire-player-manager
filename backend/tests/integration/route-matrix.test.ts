/**
 * T-AUTH-01 (route matrix) and T-AUTH-02 (deny by default).
 *
 * The matrix is **generated from the contract registry**, so a new endpoint cannot be
 * added without its permission and cannot silently escape the role checks — the failure
 * mode the spec calls out ("generated from the route registry so new routes can't be
 * skipped").
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { allEndpoints } from "../../spec/index.js";
import { handlers } from "../../src/routes/index.js";
import { contractRoutes } from "../../src/app.js";
import { createUser, errorCode, login, request } from "../helpers/auth.js";
import { closeTestPool, prepareTestDatabase, resetData, testApp } from "../helpers/test-db.js";

const DUMMY_UUID = "01890f4a-0000-7000-8000-000000000000";

/** Fills path parameters so a request can reach the guard (which runs before validation). */
function concretePath(path: string): string {
  return path.replace(/\{([^}]+)\}/g, (_m, name: string) =>
    name === "token" || name === "name" ? "not-a-real-value" : DUMMY_UUID,
  );
}

describe("route matrix (T-AUTH-01, T-AUTH-02)", () => {
  let app: FastifyInstance;
  let coachCookie: string;
  let coachCsrf: string;

  beforeAll(async () => {
    await prepareTestDatabase();
  });

  beforeEach(async () => {
    await resetData();
    // Two owners, so creating this coach never trips the last-owner invariant.
    await createUser({ username: "matrix.owner", role: "owner" });
    await createUser({ username: "matrix.owner2", role: "owner" });
    const coach = await createUser({ username: "matrix.coach", role: "coach" });
    app = await testApp();
    const session = await login(app, coach.username, coach.password);
    coachCookie = session.cookie;
    coachCsrf = session.csrfToken;
  });

  afterAll(async () => {
    await closeTestPool();
  });

  it("declares a permission for every role-gated endpoint (deny by default)", () => {
    const missing = allEndpoints
      .filter((ep) => ep.auth === "owner" || ep.auth === "coach_scoped")
      .filter((ep) => !ep.permission)
      .map((ep) => ep.operationId ?? ep.id);
    expect(missing, "role-gated endpoints without a permission").toEqual([]);
  });

  it("keeps operation ids unique, and every handler inside the contract", () => {
    const operationIds = allEndpoints.map((ep) => ep.operationId ?? ep.id);
    expect(new Set(operationIds).size).toBe(operationIds.length);

    const contractIds = new Set(operationIds);
    const orphans = [...handlers.keys()].filter((id) => !contractIds.has(id));
    expect(orphans, "handlers with no contract entry").toEqual([]);
  });

  it("serves no route that is not in the contract", () => {
    const declared = new Set(
      allEndpoints
        .filter((ep) => handlers.has(ep.operationId ?? ep.id))
        .map((ep) => `${ep.method.toUpperCase()} ${ep.path}`),
    );
    for (const route of contractRoutes()) {
      expect(declared.has(route), `${route} is registered but not declared for M2`).toBe(true);
    }
  });

  it("returns 401 for every implemented protected endpoint without a session", async () => {
    const protectedEndpoints = allEndpoints.filter(
      (ep) =>
        handlers.has(ep.operationId ?? ep.id) &&
        ["session", "owner", "coach_scoped"].includes(ep.auth),
    );
    expect(protectedEndpoints.length).toBeGreaterThan(0);

    const wrong: string[] = [];
    for (const ep of protectedEndpoints) {
      const response = await request(app, {
        method: ep.method.toUpperCase() as "GET",
        url: `/api/v1${concretePath(ep.path)}`,
        cookie: null,
        ...(ep.method !== "get" ? { payload: {} } : {}),
      });
      if (response.statusCode !== 401) {
        wrong.push(`${ep.operationId ?? ep.id} → ${response.statusCode}`);
      }
    }
    expect(wrong, "protected endpoints that did not answer 401 anonymously").toEqual([]);
  });

  it("forbids a coach on every owner-only endpoint, leaking no body (T-AUTH-01)", async () => {
    const ownerOnly = allEndpoints.filter(
      (ep) => ep.auth === "owner" && handlers.has(ep.operationId ?? ep.id),
    );
    expect(ownerOnly.length).toBeGreaterThan(0);

    const wrong: string[] = [];
    for (const ep of ownerOnly) {
      const response = await request(app, {
        method: ep.method.toUpperCase() as "GET",
        url: `/api/v1${concretePath(ep.path)}`,
        cookie: coachCookie,
        csrf: coachCsrf,
        ...(ep.method !== "get" ? { payload: {} } : {}),
      });
      if (response.statusCode !== 403) {
        wrong.push(`${ep.operationId ?? ep.id} → ${response.statusCode}`);
        continue;
      }
      if (errorCode(response) !== "FORBIDDEN") wrong.push(`${ep.operationId ?? ep.id} → wrong code`);
      // The refusal must not carry data.
      const body = JSON.parse(response.body) as { data?: unknown; error?: { message?: string } };
      if (body.data !== undefined) wrong.push(`${ep.operationId ?? ep.id} → leaked data`);
    }
    expect(wrong, "owner-only endpoints a coach was not cleanly refused").toEqual([]);
  });

  it("allows a coach on the endpoints that are meant for them", async () => {
    // `/auth/me` is the session-level self-service case (AUTH §4 grants it to both roles).
    const me = await request(app, { method: "GET", url: "/api/v1/auth/me", cookie: coachCookie });
    expect(me.statusCode).toBe(200);
    const body = me.json() as { user: { username: string; role: string }; permissions: string[] };
    expect(body.user.username).toBe("matrix.coach");
    expect(body.user.role).toBe("coach");

    // A coach's permission set must not contain a single financial or admin permission.
    for (const forbidden of ["users:manage", "billing:manage", "payments:manage", "settings:manage", "audit:read"]) {
      expect(body.permissions).not.toContain(forbidden);
    }
  });
});
