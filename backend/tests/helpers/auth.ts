/**
 * Test factories and request helpers.
 *
 * Users are inserted with the migration role so a test can set up any state (including
 * "invited" users); requests go through the real HTTP surface with `inject()`, including
 * cookies and CSRF headers, so the guards under test are the shipped ones.
 */
import type { FastifyInstance } from "fastify";
import { hashPassword } from "../../src/auth/password.js";
import { generateOpaqueToken, inviteExpiry } from "../../src/auth/tokens.js";
import { uuidv7 } from "../../src/ids.js";
import { migratorClient } from "./test-db.js";

export interface TestUser {
  id: string;
  username: string;
  password: string;
  role: "owner" | "coach";
}

export async function createUser(opts: {
  username: string;
  role: "owner" | "coach";
  password?: string;
  fullName?: string;
  status?: "invited" | "active" | "disabled";
  totpEnabled?: boolean;
}): Promise<TestUser> {
  const password = opts.password ?? "test-password-123456";
  const status = opts.status ?? "active";
  const id = uuidv7();
  const client = await migratorClient();
  try {
    await client.query(
      `insert into users (id, username, full_name, phone_e164, role, status, password_hash, totp_enabled)
       values ($1, $2, $3, null, $4, $5, $6, $7)`,
      [
        id,
        opts.username,
        opts.fullName ?? `${opts.username} (test)`,
        opts.role,
        status,
        status === "invited" ? null : await hashPassword(password),
        opts.totpEnabled ?? false,
      ],
    );
  } finally {
    await client.end();
  }
  return { id, username: opts.username, password, role: opts.role };
}

/** Inserts an invite (or password-reset) token and returns the raw URL token. */
export async function createInvite(
  userId: string,
  purpose: "invite" | "password_reset" = "invite",
  opts: { expired?: boolean; used?: boolean } = {},
): Promise<string> {
  const token = generateOpaqueToken();
  const expiresAt = opts.expired
    ? new Date(Date.now() - 60_000)
    : inviteExpiry();
  const client = await migratorClient();
  try {
    await client.query(
      `insert into user_invites (id, user_id, token_hash, purpose, expires_at, used_at)
       values ($1, $2, $3, $4, $5, $6)`,
      [uuidv7(), userId, token.hash, purpose, expiresAt, opts.used ? new Date() : null],
    );
  } finally {
    await client.end();
  }
  return token.token;
}

export interface LoggedIn {
  cookie: string;
  csrfToken: string;
  body: Record<string, unknown>;
}

/**
 * Signs in through AUTH-01 and returns the session cookie and CSRF token.
 *
 * `ip` lets a test present its own client address, because AUTH-01 is rate limited per IP
 * (10/min) and a file that signs in several times would otherwise trip the limiter and
 * fail for a reason it is not testing.
 */
export async function login(
  app: FastifyInstance,
  username: string,
  password: string,
  ip?: string,
): Promise<LoggedIn> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    ...(ip ? { headers: { "x-forwarded-for": ip } } : {}),
    payload: { username, password },
  });
  if (response.statusCode !== 200) {
    throw new Error(`login failed for ${username}: ${response.statusCode} ${response.body}`);
  }
  const cookies = response.cookies;
  const session = cookies.find((c) => c.name === "ia_session");
  if (!session) throw new Error("login did not set the session cookie");
  const body = response.json() as Record<string, unknown>;
  return {
    cookie: `ia_session=${session.value}`,
    csrfToken: String(body["csrfToken"]),
    body,
  };
}

export interface InjectOptions {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  payload?: unknown;
  cookie?: string | null;
  csrf?: string | null;
  headers?: Record<string, string>;
  /** Client IP; the test env trusts the proxy header so per-IP limits are isolatable. */
  ip?: string;
}

/** Issues a request with the cookie/CSRF plumbing the frontend uses. */
export async function request(app: FastifyInstance, opts: InjectOptions) {
  const headers: Record<string, string> = {
    origin: "http://localhost:3100",
    "x-forwarded-for": opts.ip ?? "203.0.113.10",
    ...opts.headers,
  };
  if (opts.cookie) headers["cookie"] = opts.cookie;
  if (opts.csrf && opts.method !== "GET") headers["x-csrf-token"] = opts.csrf;
  return app.inject({
    method: opts.method,
    url: opts.url,
    headers,
    ...(opts.payload !== undefined ? { payload: opts.payload as object } : {}),
  });
}

/** Reads the error code from a response body, or null when it is not an error. */
export function errorCode(response: { body: string }): string | null {
  try {
    const parsed = JSON.parse(response.body) as { error?: { code?: string } };
    return parsed.error?.code ?? null;
  } catch {
    return null;
  }
}
