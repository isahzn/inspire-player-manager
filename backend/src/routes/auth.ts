/**
 * AUTH-01..07 — sign-in, sessions, password change, invites, owner TOTP.
 *
 * Security properties this file is responsible for:
 *  - one generic error for every credential failure, so accounts cannot be enumerated
 *    (AUTH §1) and a missing account costs the same as a wrong password;
 *  - lockout after N consecutive failures, per account, cleared on success;
 *  - the session token is stored only as a hash and rotated on every login;
 *  - password change revokes every *other* session;
 *  - every attempt (success and failure) writes an audit row.
 */
import type { FastifyReply } from "fastify";
import { pool, withTransaction, type Db } from "../db/pool.js";
import { errors, ApiError } from "../errors.js";
import { mapPgError } from "../db/pg-errors.js";
import { config } from "../config.js";
import * as audit from "../audit.js";
import { checkPasswordPolicy, hashPassword, verifyPassword } from "../auth/password.js";
import {
  createSession,
  revokeAllSessions,
  revokeSession,
  type IssuedSession,
} from "../auth/sessions.js";
import { decryptSecret, encryptSecret, generateSecret, otpauthUri, verifyTotp } from "../auth/totp.js";
import { generateOpaqueToken, hashOpaqueToken, inviteExpiry, normalizePhone } from "../auth/tokens.js";
import { rolePermissions } from "../auth/permissions.js";
import type { Handler, HandlerArgs, HandlerResult } from "../http/router.js";
import type { Role } from "../../spec/components.js";
import { serializeMe, serializeUser, type UserRow } from "./serialize.js";

/**
 * A valid argon2id hash of a random string. Verifying against it when no account
 * matched keeps the failure path's cost similar to a real wrong-password check.
 */
const DUMMY_HASH =
  "$argon2id$v=19$m=19456,t=2,p=1$c29tZS1zYWx0LXZhbHVl$Y2FsaWJyYXRpb24taGFzaC1ub3QtYS1yZWFsLXBhc3N3b3Jk";

interface LoginUser extends UserRow {
  password_hash: string | null;
  failed_login_count: number;
  locked_until: Date | null;
  totp_secret_enc: Buffer | null;
}

function setSessionCookie(reply: FastifyReply, issued: IssuedSession): void {
  reply.setCookie(config.cookieName, issued.token, {
    path: "/",
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: "lax",
    ...(config.cookieDomain ? { domain: config.cookieDomain } : {}),
    expires: issued.expiresAt,
  });
}

async function findUserForLogin(username: string): Promise<LoginUser | null> {
  const result = await pool.query<LoginUser>("select * from app.find_user_for_login($1)", [
    username.toLowerCase(),
  ]);
  return result.rows[0] ?? null;
}

function loginAudit(ctx: HandlerArgs["ctx"], user: LoginUser | null, username: string) {
  return {
    actorUserId: user?.id ?? null,
    actorRole: (user?.role as Role | undefined) ?? null,
    requestId: ctx.requestId,
    ip: ctx.ip,
  };
}

/** Records a failed attempt and, when the threshold is reached, the lockout. */
async function registerFailure(user: LoginUser, ctx: HandlerArgs["ctx"], reason: string): Promise<number> {
  const failures = user.failed_login_count + 1;
  const shouldLock = failures >= config.loginMaxFailures;
  try {
    await withTransaction({ userId: user.id, role: user.role }, async (client) => {
      await client.query(
        `update users
            set failed_login_count = $2,
                locked_until = $3,
                updated_at = now()
          where id = $1`,
        [
          user.id,
          shouldLock ? 0 : failures,
          shouldLock ? new Date(Date.now() + config.loginLockMinutes * 60_000) : null,
        ],
      );
      await audit.record(client, loginAudit(ctx, user, user.username), {
        action: "auth.login",
        entityType: "user",
        entityId: user.id,
        after: { result: reason, failures },
      });
    });
  } catch (err) {
    mapPgError(err);
  }
  return failures;
}

export const auth01Login: Handler = async ({ ctx, body, req, reply }): Promise<HandlerResult> => {
  const { username, password, totpCode } = body as {
    username: string;
    password: string;
    totpCode?: string;
  };
  const user = await findUserForLogin(username);

  if (!user) {
    await verifyPassword(DUMMY_HASH, password);
    await withTransaction({ userId: null, role: null }, async (client) => {
      await audit.record(client, loginAudit(ctx, null, username), {
        action: "auth.login",
        entityType: "user",
        entityId: null,
        after: { result: "no_such_user", username },
      });
    });
    throw errors.invalidCredentials();
  }

  if (user.locked_until && user.locked_until.getTime() > Date.now()) {
    await withTransaction({ userId: null, role: null }, async (client) => {
      await audit.record(client, loginAudit(ctx, user, username), {
        action: "auth.login",
        entityType: "user",
        entityId: user.id,
        after: { result: "locked" },
      });
    });
    throw errors.accountLocked();
  }

  if (user.status === "disabled") {
    await withTransaction({ userId: null, role: null }, async (client) => {
      await audit.record(client, loginAudit(ctx, user, username), {
        action: "auth.login",
        entityType: "user",
        entityId: user.id,
        after: { result: "disabled" },
      });
    });
    throw errors.accountDisabled();
  }

  const passwordOk = user.password_hash
    ? await verifyPassword(user.password_hash, password)
    : // An invited user has no password yet; still spend the time so the path is uniform.
      ((await verifyPassword(DUMMY_HASH, password)) && false);

  if (!passwordOk) {
    const failures = await registerFailure(user, ctx, "bad_password");
    if (failures >= config.loginMaxFailures) throw errors.accountLocked();
    throw errors.invalidCredentials();
  }

  if (user.totp_enabled) {
    if (!user.totp_secret_enc) {
      // Data inconsistency: fail closed rather than skipping the second factor.
      throw errors.invalidCredentials();
    }
    if (!totpCode) {
      // The contract defines no TOTP_REQUIRED code (raised as a contract gap in the
      // M1/M2 handoffs); INVALID_CREDENTIALS with a directing message is used.
      throw new ApiError(
        "INVALID_CREDENTIALS",
        "Enter the 6-digit code from your authenticator app.",
      );
    }
    if (!verifyTotp(decryptSecret(user.totp_secret_enc), totpCode)) {
      const failures = await registerFailure(user, ctx, "bad_totp");
      if (failures >= config.loginMaxFailures) throw errors.accountLocked();
      throw errors.invalidCredentials();
    }
  }

  const issued = await withTransaction({ userId: user.id, role: user.role }, async (client) => {
    const session = await createSession(client, {
      userId: user.id,
      role: user.role,
      ip: ctx.ip,
      userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null,
    });
    await client.query(
      `update users
          set failed_login_count = 0, locked_until = null, last_login_at = now(), updated_at = now()
        where id = $1`,
      [user.id],
    );
    await audit.record(client, loginAudit(ctx, user, user.username), {
      action: "auth.login",
      entityType: "user",
      entityId: user.id,
      after: { result: "success", sessionId: session.sessionId },
    });
    return session;
  });

  setSessionCookie(reply, issued);

  const academy = await pool.query<{
    name: string;
    timezone: string;
    logo_file_id: string | null;
    age_reference_rule: "jan_1_of_year" | "fixed_month_day" | "today";
    age_reference_month_day: string | null;
    coach_can_see_guardian_phone: boolean;
  }>(
    `select name, timezone, logo_file_id, age_reference_rule, age_reference_month_day,
            coach_can_see_guardian_phone
       from app.academy_public`,
  );
  const summary = academy.rows[0] ?? {
    name: "Inspire Academy",
    timezone: "Asia/Colombo",
    logo_file_id: null,
    age_reference_rule: "jan_1_of_year" as const,
    age_reference_month_day: null,
    coach_can_see_guardian_phone: false,
  };

  return {
    status: 200,
    body: serializeMe({
      userId: user.id,
      username: user.username,
      fullName: user.full_name,
      phone: user.phone_e164,
      role: user.role,
      status: "active",
      totpEnabled: user.totp_enabled,
      permissions: rolePermissions(user.role),
      restricted: false,
      sessionId: issued.sessionId,
      csrfToken: (await import("../auth/sessions.js")).csrfTokenFor(issued.sessionId),
      academy: {
        name: summary.name,
        timezone: summary.timezone,
        logoFileId: summary.logo_file_id,
        ageReferenceRule: summary.age_reference_rule,
        ageReferenceMonthDay: summary.age_reference_month_day,
        coachCanSeeGuardianPhone: summary.coach_can_see_guardian_phone,
      },
    }),
  };
};

export const auth02Logout: Handler = async ({ ctx, viewer, reply }): Promise<HandlerResult> => {
  await withTransaction({ userId: viewer.userId, role: viewer.role }, async (client) => {
    await revokeSession(client, { sessionId: viewer.sessionId, reason: "logout" });
    // `viewer.sessionId` is the session's primary key, which is `sha256(token)` — a text
    // column — while `audit_logs.entity_id` is a `uuid`. Passing it directly made Postgres
    // raise 22P02 inside this transaction, so the revoke rolled back and a sign-out left the
    // session alive (found by the 2026-10-15 UI audit, §A1). The record therefore names the
    // **user**, exactly as `auth.login` does, and keeps the session key in `after` where a
    // text column cannot break the chain.
    await audit.record(client, { ...viewerAudit(viewer, ctx), }, {
      action: "auth.logout",
      entityType: "user",
      entityId: viewer.userId,
      after: { result: "logout", sessionId: viewer.sessionId },
    });
  });
  reply.clearCookie(config.cookieName, { path: "/" });
  return { status: 204 };
};

export const auth03Me: Handler = async ({ viewer }): Promise<HandlerResult> => {
  // `assignedGroupIds` is the coach-only projection of `Me`. It was omitted in M2 because
  // `coach_group_assignments` did not exist yet; M3 introduces it, so the field is filled
  // from the assignments held today (the same window the RLS helper uses).
  let assignedGroupIds: string[] | undefined;
  if (viewer.role === "coach") {
    assignedGroupIds = await withTransaction(
      { userId: viewer.userId, role: viewer.role },
      async (client) => {
        const rows = await client.query<{ age_group_id: string }>(
          `select a.age_group_id
             from coach_group_assignments a
            where a.coach_user_id = $1
              and a.assigned_from <= current_date
              and (a.assigned_to is null or a.assigned_to >= current_date)`,
          [viewer.userId],
        );
        return rows.rows.map((row) => row.age_group_id);
      },
    );
  }
  return { status: 200, body: serializeMe(viewer, assignedGroupIds) };
};

export const auth04ChangePassword: Handler = async ({ ctx, viewer, body }): Promise<HandlerResult> => {
  const { currentPassword, newPassword } = body as { currentPassword: string; newPassword: string };
  const policy = checkPasswordPolicy(newPassword, viewer.username);
  if (!policy.ok) {
    throw errors.validation([{ field: "newPassword", issue: policy.issue ?? "Weak password." }]);
  }
  try {
    await withTransaction({ userId: viewer.userId, role: viewer.role }, async (client) => {
      const row = await client.query<{ password_hash: string | null }>(
        "select password_hash from users where id = $1",
        [viewer.userId],
      );
      const current = row.rows[0]?.password_hash;
      if (!current || !(await verifyPassword(current, currentPassword))) {
        throw errors.validation([{ field: "currentPassword", issue: "Current password is incorrect." }]);
      }
      const hash = await hashPassword(newPassword);
      await client.query(
        `update users set password_hash = $2, password_changed_at = now(), updated_at = now()
          where id = $1`,
        [viewer.userId, hash],
      );
      // Every other session dies with the old password (AUTH §1).
      await revokeAllSessions(client, {
        userId: viewer.userId,
        reason: "password_change",
        exceptSessionId: viewer.sessionId,
      });
      await audit.record(client, viewerAudit(viewer, ctx), {
        action: "auth.change_password",
        entityType: "user",
        entityId: viewer.userId,
      });
    });
  } catch (err) {
    mapPgError(err);
  }
  return { status: 204 };
};

export const auth05AcceptInvite: Handler = async ({ ctx, body, reply }): Promise<HandlerResult> => {
  const { token, password } = body as { token: string; password: string };
  const invite = await pool.query<{
    id: string;
    user_id: string;
    purpose: string;
    expires_at: Date;
    used_at: Date | null;
  }>("select * from app.find_invite($1)", [hashOpaqueToken(token)]);

  const row = invite.rows[0];
  // Uniform failure for unknown, used and expired links, inside the codes the contract
  // declares for this endpoint (no INVITE_INVALID exists — M1 handoff §4).
  const invalid = () =>
    errors.validation([{ field: "token", issue: "This invitation link is invalid or has expired." }]);

  if (!row || row.used_at || row.expires_at.getTime() <= Date.now()) {
    await withTransaction({ userId: null, role: null }, async (client) => {
      await audit.record(client, { actorUserId: null, actorRole: null, requestId: ctx.requestId, ip: ctx.ip }, {
        action: "auth.accept_invite",
        entityType: "user_invite",
        entityId: row?.id ?? null,
        after: { result: "invalid" },
      });
    });
    throw invalid();
  }

  const userResult = await pool.query<{ username: string; role: Role; status: string }>(
    "select username::text as username, role, status from users where id = $1",
    [row.user_id],
  );
  const target = userResult.rows[0];
  if (!target) throw invalid();

  const policy = checkPasswordPolicy(password, target.username);
  if (!policy.ok) {
    throw errors.validation([{ field: "password", issue: policy.issue ?? "Weak password." }]);
  }

  const issued = await withTransaction({ userId: row.user_id, role: null }, async (client) => {
    const hash = await hashPassword(password);
    await client.query(
      `update users
          set password_hash = $2, status = 'active', failed_login_count = 0,
              locked_until = null, password_changed_at = now(), updated_at = now()
        where id = $1`,
      [row.user_id, hash],
    );
    // Single use: the predicate is part of the statement, so a replay finds nothing.
    const consumed = await client.query(
      "update user_invites set used_at = now() where id = $1 and used_at is null",
      [row.id],
    );
    if (consumed.rowCount === 0) throw invalid();

    const session = await createSession(client, {
      userId: row.user_id,
      role: target.role,
      ip: ctx.ip,
      userAgent: null,
    });
    await audit.record(
      client,
      { actorUserId: row.user_id, actorRole: target.role, requestId: ctx.requestId, ip: ctx.ip },
      {
        action: "auth.accept_invite",
        entityType: "user",
        entityId: row.user_id,
        after: { result: "accepted", purpose: row.purpose },
      },
    );
    return session;
  });

  setSessionCookie(reply, issued);

  const sessions = await import("../auth/sessions.js");
  const academy = await pool.query<{
    name: string;
    timezone: string;
    logo_file_id: string | null;
    age_reference_rule: "jan_1_of_year" | "fixed_month_day" | "today";
    age_reference_month_day: string | null;
    coach_can_see_guardian_phone: boolean;
  }>(
    `select name, timezone, logo_file_id, age_reference_rule, age_reference_month_day,
            coach_can_see_guardian_phone
       from app.academy_public`,
  );
  const summary = academy.rows[0] ?? {
    name: "Inspire Academy",
    timezone: "Asia/Colombo",
    logo_file_id: null,
    age_reference_rule: "jan_1_of_year" as const,
    age_reference_month_day: null,
    coach_can_see_guardian_phone: false,
  };

  return {
    status: 200,
    body: serializeMe({
      userId: row.user_id,
      username: target.username,
      fullName: "",
      phone: null,
      role: target.role,
      status: "active",
      totpEnabled: false,
      permissions: rolePermissions(target.role),
      restricted: false,
      sessionId: issued.sessionId,
      csrfToken: sessions.csrfTokenFor(issued.sessionId),
      academy: {
        name: summary.name,
        timezone: summary.timezone,
        logoFileId: summary.logo_file_id,
        ageReferenceRule: summary.age_reference_rule,
        ageReferenceMonthDay: summary.age_reference_month_day,
        coachCanSeeGuardianPhone: summary.coach_can_see_guardian_phone,
      },
    }),
  };
};

export const auth06ListSessions: Handler = async ({ viewer }): Promise<HandlerResult> => {
  const rows = await withTransaction({ userId: viewer.userId, role: viewer.role }, async (client) =>
    client.query<{
      id: string;
      created_at: Date;
      last_seen_at: Date;
      ip: string | null;
      user_agent: string | null;
    }>(
      `select id, created_at, last_seen_at, host(ip) as ip, user_agent
         from user_sessions
        where user_id = $1 and revoked_at is null
        order by created_at desc`,
      [viewer.userId],
    ),
  );
  return {
    status: 200,
    body: {
      data: rows.rows.map((s) => ({
        id: s.id,
        createdAt: s.created_at.toISOString(),
        lastSeenAt: s.last_seen_at.toISOString(),
        ...(s.ip ? { ip: s.ip } : {}),
        ...(s.user_agent ? { userAgent: s.user_agent } : {}),
        current: s.id === viewer.sessionId,
      })),
    },
  };
};

export const auth06RevokeSession: Handler = async ({ ctx, viewer, params }): Promise<HandlerResult> => {
  const { id } = params as { id: string };
  const revoked = await withTransaction({ userId: viewer.userId, role: viewer.role }, async (client) => {
    // Scoped to the caller's own rows: another user's id simply matches nothing (404).
    const result = await client.query(
      `update user_sessions set revoked_at = now(), revoked_reason = 'user_revoked'
        where id = $1 and user_id = $2 and revoked_at is null`,
      [id, viewer.userId],
    );
    if ((result.rowCount ?? 0) === 0) return false;
    await audit.record(client, viewerAudit(viewer, ctx), {
      action: "auth.session_revoke",
      entityType: "session",
      entityId: id,
    });
    return true;
  });
  if (!revoked) throw errors.notFound();
  return { status: 204 };
};

export const auth07Enroll: Handler = async ({ ctx, viewer }): Promise<HandlerResult> => {
  if (viewer.role !== "owner") throw errors.forbidden("TOTP is available to owners only.");
  const secret = generateSecret();
  try {
    await withTransaction({ userId: viewer.userId, role: viewer.role }, async (client) => {
      await client.query(
        "update users set totp_secret_enc = $2, totp_enabled = false, updated_at = now() where id = $1",
        [viewer.userId, encryptSecret(secret)],
      );
      await audit.record(client, viewerAudit(viewer, ctx), {
        action: "auth.totp_enroll",
        entityType: "user",
        entityId: viewer.userId,
      });
    });
  } catch (err) {
    mapPgError(err);
  }
  return { status: 200, body: { secretUri: otpauthUri(secret, viewer.username, viewer.academy.name) } };
};

export const auth07Confirm: Handler = async ({ ctx, viewer, body }): Promise<HandlerResult> => {
  const { code } = body as { code: string };
  const row = await withTransaction({ userId: viewer.userId, role: viewer.role }, async (client) =>
    client.query<{ totp_secret_enc: Buffer | null }>(
      "select totp_secret_enc from users where id = $1",
      [viewer.userId],
    ),
  );
  const encrypted = row.rows[0]?.totp_secret_enc;
  if (!encrypted) throw new ApiError("INVALID_STATE_TRANSITION", "Start enrolment first.");
  if (!verifyTotp(decryptSecret(encrypted), code)) {
    throw new ApiError("INVALID_CREDENTIALS", "That code is not valid. Try the current one.");
  }
  await withTransaction({ userId: viewer.userId, role: viewer.role }, async (client) => {
    await client.query("update users set totp_enabled = true, updated_at = now() where id = $1", [
      viewer.userId,
    ]);
    await audit.record(client, viewerAudit(viewer, ctx), {
      action: "auth.totp_confirm",
      entityType: "user",
      entityId: viewer.userId,
    });
  });
  return { status: 204 };
};

export const auth07Disable: Handler = async ({ ctx, viewer, body }): Promise<HandlerResult> => {
  const { password } = body as { password: string };
  try {
    await withTransaction({ userId: viewer.userId, role: viewer.role }, async (client) => {
      const row = await client.query<{ password_hash: string | null; totp_enabled: boolean }>(
        "select password_hash, totp_enabled from users where id = $1",
        [viewer.userId],
      );
      const current = row.rows[0];
      if (!current?.totp_enabled) {
        throw new ApiError("INVALID_STATE_TRANSITION", "TOTP is not enabled.");
      }
      if (!current.password_hash || !(await verifyPassword(current.password_hash, password))) {
        throw new ApiError("INVALID_CREDENTIALS", "Password is incorrect.");
      }
      await client.query(
        "update users set totp_enabled = false, totp_secret_enc = null, updated_at = now() where id = $1",
        [viewer.userId],
      );
      await audit.record(client, viewerAudit(viewer, ctx), {
        action: "auth.totp_disable",
        entityType: "user",
        entityId: viewer.userId,
      });
    });
  } catch (err) {
    mapPgError(err);
  }
  return { status: 204 };
};

/** Audit context for a handler that runs with an authenticated viewer. */
export function viewerAudit(viewer: { userId: string; role: Role }, ctx: HandlerArgs["ctx"]) {
  return {
    actorUserId: viewer.userId,
    actorRole: viewer.role,
    requestId: ctx.requestId,
    ip: ctx.ip,
  };
}

export { DUMMY_HASH, findUserForLogin, type LoginUser };
export type { Db, FastifyReply };
