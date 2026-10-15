/**
 * AUTH-02 (logout), plus the two contract shapes the 2026-10-15 VPS UI audit found the
 * frontend guessing at wrongly. All three exist because something that looked right failed
 * on the live box:
 *
 *  - **A1 — logout never worked.** `auth02Logout` passed `viewer.sessionId`, which is
 *    `sha256(token)` (a *text* primary key on `user_sessions`), into `audit_logs.entity_id`,
 *    which is a **uuid**. Postgres raised 22P02, the enclosing transaction rolled back, the
 *    revoke never committed and the cookie was never cleared — so "Sign out" left the session
 *    alive, and **no test mentioned logout at all**, which is why 260 green tests missed it.
 *    The test below asserts the thing a user actually depends on: after logging out, the old
 *    cookie is rejected.
 *  - **A2 — the academy profile's field names.** SET-01 reads `name` and
 *    `ageReferenceRule ∈ {jan_1_of_year, fixed_month_day, today}`. The frontend's hand-written
 *    types said `academyName` / `jan_1` / `fixed_date`, and `/settings` threw on load. Pinning
 *    the server's shape here is what makes the frontend's spelling a test-visible contract.
 *  - **A3 — `from`/`to` are instants, not business dates.** Sending `2026-10-01` to PAY-01 is
 *    a 422 that took the whole payments list down; the audit route's own header comment says
 *    the same about AUD-01. Both are asserted below so the frontend cannot drift back.
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

describe("auth surface (AUTH-02, SET-01 shape, instant list filters)", () => {
  let app: FastifyInstance;
  let ownerCookie: string;
  let ownerCsrf: string;
  let ownerId: string;

  beforeAll(async () => {
    await prepareTestDatabase();
  });

  beforeEach(async () => {
    await resetData();
    const owner = await createUser({ username: "auth.owner", role: "owner" });
    ownerId = owner.id;
    app = await testApp();
    const session = await login(app, owner.username, owner.password, "198.51.100.71");
    ownerCookie = session.cookie;
    ownerCsrf = session.csrfToken;
  });

  afterAll(async () => {
    await app.close();
    await closeTestPool();
  });

  it("ends the session on logout, so the old cookie is refused afterwards (AUTH-02)", async () => {
    // Present to begin with — otherwise the assertion below would pass for the wrong reason.
    const before = await request(app, { method: "GET", url: "/api/v1/auth/me", cookie: ownerCookie });
    expect(before.statusCode).toBe(200);

    const out = await request(app, {
      method: "POST",
      url: "/api/v1/auth/logout",
      cookie: ownerCookie,
      csrf: ownerCsrf,
      payload: {},
    });
    expect(out.statusCode).toBe(204);

    // The regression the audit found: this used to answer 500 and the cookie kept working.
    // A revoked session reads as `SESSION_EXPIRED`, not `UNAUTHENTICATED` — the deliberate
    // choice that a revoked session and an expired one are indistinguishable to the holder.
    const after = await request(app, { method: "GET", url: "/api/v1/auth/me", cookie: ownerCookie });
    expect(after.statusCode).toBe(401);
    expect(errorCode(after)).toBe("SESSION_EXPIRED");
  });

  it("records the logout against the user, not the session key (AUTH-02)", async () => {
    const out = await request(app, {
      method: "POST",
      url: "/api/v1/auth/logout",
      cookie: ownerCookie,
      csrf: ownerCsrf,
      payload: {},
    });
    expect(out.statusCode).toBe(204);

    // `audit_logs.entity_id` is a uuid and the session key is not one, so the row has to name
    // the user. Read as the migrator, which is how the other surface tests read rows the
    // viewer's own RLS would hide.
    const client = await migratorClient();
    try {
      const rows = await client.query<{ entity_type: string; entity_id: string | null; after: unknown }>(
        `select entity_type, entity_id, after
           from audit_logs
          where action = 'auth.logout' and actor_user_id = $1
          order by id desc
          limit 1`,
        [ownerId],
      );
      expect(rows.rowCount).toBe(1);
      expect(rows.rows[0]!.entity_type).toBe("user");
      expect(rows.rows[0]!.entity_id).toBe(ownerId);
    } finally {
      await client.end();
    }
  });

  it("serves SET-01 under the contract's own field names (A2)", async () => {
    const response = await request(app, {
      method: "GET",
      url: "/api/v1/settings/academy",
      cookie: ownerCookie,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as Record<string, unknown>;

    // The names the frontend must use. `academyName` is deliberately not accepted: it is what
    // `/settings` read while it was throwing on every load.
    expect(typeof body["name"]).toBe("string");
    expect(body["academyName"]).toBeUndefined();
    expect(["jan_1_of_year", "fixed_month_day", "today"]).toContain(body["ageReferenceRule"]);
    expect(body).not.toHaveProperty("ageReferenceRule", "fixed_date");
  });

  it("refuses a business date for a list filter that is typed as an instant (A3)", async () => {
    const asDate = await request(app, {
      method: "GET",
      url: "/api/v1/payments?from=2026-10-01&to=2026-10-01",
      cookie: ownerCookie,
    });
    expect(asDate.statusCode).toBe(422);
    expect(errorCode(asDate)).toBe("VALIDATION_ERROR");

    const asInstant = await request(app, {
      method: "GET",
      url: "/api/v1/payments?from=2026-10-01T00:00:00.000Z&to=2026-10-01T23:59:59.999Z",
      cookie: ownerCookie,
    });
    expect(asInstant.statusCode).toBe(200);

    const auditAsDate = await request(app, {
      method: "GET",
      url: "/api/v1/audit-logs?from=2026-10-01",
      cookie: ownerCookie,
    });
    expect(auditAsDate.statusCode).toBe(422);
  });
});
