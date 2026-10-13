/**
 * Server-side sessions (AUTH_AND_PERMISSIONS §1, ADR-004).
 *
 * The cookie carries an opaque 256-bit token; the database stores only its SHA-256,
 * so a database read cannot be replayed as a login. Lifetimes differ by role: owners
 * are short (money), coaches are long (phones at the pitch, poor signal).
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { PoolClient } from "pg";
import type { Db } from "../db/pool.js";
import { config } from "../config.js";
import type { Role } from "../../spec/components.js";

export interface IssuedSession {
  /** Raw token — goes into the cookie and is never stored. */
  token: string;
  /** SHA-256 of the token; the `user_sessions.id`. */
  sessionId: string;
  expiresAt: Date;
  idleExpiresAt: Date;
}

export function hashToken(token: string): string {
  return createHmac("sha256", config.sessionCookieSecret).update(token).digest("hex");
}

function lifetimes(role: Role, now: Date): { expiresAt: Date; idleExpiresAt: Date } {
  if (role === "owner") {
    const expiresAt = new Date(now.getTime() + config.ownerAbsoluteHours * 3_600_000);
    const idle = new Date(now.getTime() + config.ownerIdleMinutes * 60_000);
    return { expiresAt, idleExpiresAt: idle < expiresAt ? idle : expiresAt };
  }
  const expiresAt = new Date(now.getTime() + config.coachAbsoluteDays * 86_400_000);
  const idle = new Date(now.getTime() + config.coachIdleHours * 3_600_000);
  return { expiresAt, idleExpiresAt: idle < expiresAt ? idle : expiresAt };
}

/** Creates a session row. Called inside the login transaction. */
export async function createSession(
  client: PoolClient,
  opts: { userId: string; role: Role; ip?: string | null; userAgent?: string | null },
): Promise<IssuedSession> {
  const now = new Date();
  const { expiresAt, idleExpiresAt } = lifetimes(opts.role, now);
  // 256 bits of entropy, URL-safe.
  const token = randomBytes(32).toString("base64url");
  const sessionId = hashToken(token);

  await client.query(
    `insert into user_sessions (id, user_id, expires_at, idle_expires_at, ip, user_agent)
     values ($1, $2, $3, $4, $5, $6)`,
    [sessionId, opts.userId, expiresAt, idleExpiresAt, opts.ip ?? null, opts.userAgent ?? null],
  );

  return { token, sessionId, expiresAt, idleExpiresAt };
}

/**
 * Resolves a raw cookie token to a live session. Returns null for unknown, revoked,
 * expired or idle-expired sessions — the caller cannot tell those apart, which is
 * deliberate (no oracle for token validity).
 */
export async function resolveSession(
  db: Db,
  token: string,
): Promise<{ sessionId: string; userId: string; role: Role; idleExpiresAt: Date; expiresAt: Date } | null> {
  const sessionId = hashToken(token);
  // Looked up through `app.resolve_session` (migration 0004): at this point there is no
  // identity yet, so the identity-based RLS policies would hide the row entirely.
  const result = await db.query<{
    session_id: string;
    user_id: string;
    role: Role;
    status: string;
    idle_expires_at: Date;
    expires_at: Date;
  }>("select * from app.resolve_session($1)", [sessionId]);
  const row = result.rows[0];
  if (!row) return null;
  if (row.status !== "active") return null;
  return {
    sessionId: row.session_id,
    userId: row.user_id,
    role: row.role,
    idleExpiresAt: row.idle_expires_at,
    expiresAt: row.expires_at,
  };
}

/** Slides the idle window on use, never past the absolute expiry. */
export async function touchSession(
  client: PoolClient,
  opts: { sessionId: string; role: Role },
): Promise<void> {
  const now = new Date();
  const idle = new Date(
    now.getTime() + (opts.role === "owner" ? config.ownerIdleMinutes : config.coachIdleHours * 60) * 60_000,
  );
  await client.query(
    `update user_sessions
        set last_seen_at = now(),
            idle_expires_at = least($2::timestamptz, expires_at)
      where id = $1`,
    [opts.sessionId, idle],
  );
}

export async function revokeSession(
  client: PoolClient,
  opts: { sessionId: string; reason: string },
): Promise<void> {
  await client.query(
    `update user_sessions
        set revoked_at = now(), revoked_reason = $2
      where id = $1 and revoked_at is null`,
    [opts.sessionId, opts.reason],
  );
}

/** Revokes every session of a user — used on disable and password change (§1). */
export async function revokeAllSessions(
  client: PoolClient,
  opts: { userId: string; reason: string; exceptSessionId?: string },
): Promise<number> {
  const result = await client.query(
    `update user_sessions
        set revoked_at = now(), revoked_reason = $2
      where user_id = $1
        and revoked_at is null
        and ($3::text is null or id <> $3)`,
    [opts.userId, opts.reason, opts.exceptSessionId ?? null],
  );
  return result.rowCount ?? 0;
}

// ---------------------------------------------------------------------------
// CSRF (AUTH_AND_PERMISSIONS §2)
//
// The token is derived from the session id with a server secret, so it is bound to the
// session and needs no extra storage. Comparison is constant-time.
// ---------------------------------------------------------------------------
export function csrfTokenFor(sessionId: string): string {
  return createHmac("sha256", config.csrfSecret).update(`csrf:${sessionId}`).digest("base64url");
}

export function csrfMatches(sessionId: string, provided: string | undefined): boolean {
  if (!provided) return false;
  const expected = Buffer.from(csrfTokenFor(sessionId));
  const actual = Buffer.from(provided);
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}
