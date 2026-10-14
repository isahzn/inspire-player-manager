/**
 * AUD-01 — the audit trail read through the real HTTP stack.
 *
 * The assertions are about what an audit screen must be able to trust: that a real mutation
 * appears with its own action and entity id, that a row with **no** subject is still listed
 * (without an invented `entityId`), that the filters narrow rather than widen, and that a coach
 * cannot read the trail at all.
 *
 * The two "no subject" rows are inserted directly with the migrator role on purpose: no API
 * route can produce an `audit_logs` row with a null `entity_id` for `age_group`, and a fixture
 * that pretended otherwise would be testing a scenario the product does not have. `audit_logs`
 * is append-only, so the rows are never deleted — each test uses its own action string and
 * filters on it.
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

const OWNER_IP = "198.51.100.131";
const COACH_IP = "198.51.100.132";

interface AuditEntryBody {
  id: number;
  occurredAt: string;
  actor?: { id: string; fullName: string; role: "owner" | "coach" };
  action: string;
  entityType: string;
  entityId?: string;
  reason?: string;
  before?: unknown;
  after?: unknown;
  requestId: string;
}

interface AuditBody {
  data: AuditEntryBody[];
  meta: { page: number; pageSize: number; total: number; totalPages: number };
}

describe("M8 audit trail (AUD-01)", () => {
  let app: FastifyInstance;
  let ownerCookie: string;
  let ownerCsrf: string;
  let coachCookie: string;

  beforeAll(async () => {
    await prepareTestDatabase();
  });

  beforeEach(async () => {
    await resetData();
    // A second owner keeps the "at least one active owner" trigger satisfied while the fixture
    // users are created and removed.
    await createUser({ username: "audit.owner", role: "owner" });
    const owner = await createUser({ username: "audit.owner2", role: "owner" });
    const coach = await createUser({ username: "audit.coach", role: "coach" });

    app = await testApp();
    const ownerSession = await login(app, owner.username, owner.password, OWNER_IP);
    ownerCookie = ownerSession.cookie;
    ownerCsrf = ownerSession.csrfToken;
    const coachSession = await login(app, coach.username, coach.password, COACH_IP);
    coachCookie = coachSession.cookie;
  });

  afterAll(async () => {
    await app.close();
    await closeTestPool();
  });

  const listAudit = (query = "", cookie = ownerCookie) =>
    request(app, { method: "GET", url: `/api/v1/audit-logs${query}`, cookie });

  /** Inserts an audit row with no subject, through the migration role (bypasses RLS). */
  async function insertSubjectless(action: string, occurredAtSql?: string) {
    const client = await migratorClient();
    try {
      await client.query(
        `insert into audit_logs
           (actor_user_id, actor_role, action, entity_type, entity_id, reason, request_id, ip
            ${occurredAtSql ? ", occurred_at" : ""})
         values (null, null, $1, 'test', null, null, 'audit-surface-fixture', null
            ${occurredAtSql ? `, ${occurredAtSql}` : ""})`,
        [action],
      );
    } finally {
      await client.end();
    }
  }

  it("returns a paginated envelope of the trail (AUD-01)", async () => {
    const response = await listAudit();
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json() as AuditBody;
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.meta.page).toBe(1);
    expect(body.meta.pageSize).toBe(25);
    expect(body.meta.total).toBeGreaterThanOrEqual(0);
  });

  it("records a real mutation with its action, entity type and entity id (AUD-01)", async () => {
    const group = await request(app, {
      method: "POST",
      url: "/api/v1/age-groups",
      cookie: ownerCookie,
      csrf: ownerCsrf,
      payload: { name: "Audit trail group" },
    });
    expect(group.statusCode, group.body).toBe(201);
    const groupId = (group.json() as { id: string }).id;

    const response = await listAudit("?action=age_group.create");
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json() as AuditBody;

    const entry = body.data.find((row) => row.entityId === groupId);
    expect(entry, "the age-group creation should appear in the audit trail").toBeDefined();
    expect(entry!.action).toBe("age_group.create");
    expect(entry!.entityType).toBe("age_group");
    // The owner who made the call is named, and the role is the contract's own union.
    expect(entry!.actor?.role).toBe("owner");
    expect(entry!.actor?.id).toBeDefined();
    expect(entry!.requestId).toBeTruthy();
    expect(typeof entry!.id).toBe("number");
  });

  it("lists a row with no subject without inventing an entityId (AUD-01)", async () => {
    await insertSubjectless("audit.test.no_entity");

    const response = await listAudit("?action=audit.test.no_entity");
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json() as AuditBody;

    expect(body.data).toHaveLength(1);
    const row = body.data[0]!;
    // Absent, not null and not the string "null": a client cannot tell those apart.
    expect(Object.hasOwn(row, "entityId")).toBe(false);
    // A row nobody performed names no actor rather than a placeholder one.
    expect(Object.hasOwn(row, "actor")).toBe(false);
    expect(row.action).toBe("audit.test.no_entity");
  });

  it("matches `action` as a contains and narrows by instant (AUD-01)", async () => {
    await insertSubjectless("audit.test.contains.alpha");
    await insertSubjectless("audit.test.contains.beta");
    await insertSubjectless("audit.test.old", "now() - interval '10 days'");

    const contains = await listAudit("?action=audit.test.contains");
    expect(contains.statusCode, contains.body).toBe(200);
    const containsBody = contains.json() as AuditBody;
    expect(containsBody.data.map((row) => row.action).sort()).toEqual([
      "audit.test.contains.alpha",
      "audit.test.contains.beta",
    ]);

    // `from` is an instant: the 10-day-old row is outside a 5-day window and the fresh ones are
    // inside it — asserted on the same action prefix so nothing else can be in the result.
    const from = new Date(Date.now() - 5 * 86_400_000).toISOString();
    const windowed = await listAudit(
      `?action=audit.test.&from=${encodeURIComponent(from)}`,
    );
    expect(windowed.statusCode, windowed.body).toBe(200);
    const windowedBody = windowed.json() as AuditBody;
    expect(windowedBody.data.map((row) => row.action)).not.toContain("audit.test.old");
    expect(windowedBody.data.map((row) => row.action)).toContain("audit.test.contains.alpha");

    // A `to` in the past sees only the old row.
    const to = new Date(Date.now() - 5 * 86_400_000).toISOString();
    const beforeNow = await listAudit(`?action=audit.test.old&to=${encodeURIComponent(to)}`);
    expect(beforeNow.statusCode, beforeNow.body).toBe(200);
    expect((beforeNow.json() as AuditBody).data).toHaveLength(1);
  });

  it("refuses a coach, who has no audit:read permission (AUD-01)", async () => {
    const response = await listAudit("", coachCookie);
    expect(response.statusCode, response.body).toBe(403);
    expect(errorCode(response)).toBe("FORBIDDEN");
  });

  // Query schemas are plain objects (only *bodies* are `strictObject`), so an unknown query key
  // is stripped rather than refused — what the contract does enforce is the bounds on the ones
  // it names, which is what this asserts.
  it("refuses a page size outside the contract's bound (AUD-01)", async () => {
    const response = await listAudit("?pageSize=1000");
    expect(response.statusCode, response.body).toBe(422);
    expect(errorCode(response)).toBe("VALIDATION_ERROR");
  });

  it("paginates without repeating or skipping a row (AUD-01)", async () => {
    await insertSubjectless("audit.test.page.gamma");
    await insertSubjectless("audit.test.page.delta");

    const first = await listAudit("?action=audit.test.page&pageSize=1&page=1");
    expect(first.statusCode, first.body).toBe(200);
    const firstBody = first.json() as AuditBody;
    expect(firstBody.meta.total).toBe(2);
    expect(firstBody.meta.totalPages).toBe(2);
    expect(firstBody.data).toHaveLength(1);

    const second = await listAudit("?action=audit.test.page&pageSize=1&page=2");
    const secondBody = second.json() as AuditBody;
    expect(secondBody.data).toHaveLength(1);
    // Newest first, and the two pages hold two different rows.
    expect(firstBody.data[0]!.id).not.toBe(secondBody.data[0]!.id);
    expect(firstBody.data[0]!.id).toBeGreaterThan(secondBody.data[0]!.id);
  });
});
