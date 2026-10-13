/**
 * USR-01..05 — owner-managed users and invites.
 *
 * Users are never deleted (DATABASE §6): disabling revokes sessions and keeps the audit
 * trail intact. The last active owner is protected by a deferred constraint trigger in
 * the database, so the guarantee holds even under concurrent demotions (T-AUTH-07);
 * `mapPgError` turns its refusal into the documented 409 `LAST_OWNER`.
 */
import { withTransaction } from "../db/pool.js";
import { errors } from "../errors.js";
import { mapPgError } from "../db/pg-errors.js";
import { config } from "../config.js";
import * as audit from "../audit.js";
import { revokeAllSessions } from "../auth/sessions.js";
import { generateOpaqueToken, inviteExpiry, normalizePhone } from "../auth/tokens.js";
import { uuidv7 } from "../ids.js";
import { orderByClause, parseSort } from "../http/validate.js";
import { asViewer } from "../http/context.js";
import type { Handler, HandlerResult } from "../http/router.js";
import { serializeUser, type UserRow } from "./serialize.js";
import { viewerAudit } from "./auth.js";

const USER_SELECT = `select id, username::text as username, full_name, phone_e164, role, status,
                            totp_enabled, last_login_at, created_at
                       from users`;
const SORTABLE = ["fullName", "createdAt"] as const;

export const usr01List: Handler = async ({ viewer, query }): Promise<HandlerResult> => {
  const { page, pageSize, role, status, q, sort } = query as {
    page: number;
    pageSize: number;
    role?: "owner" | "coach";
    status?: "invited" | "active" | "disabled";
    q?: string;
    sort?: string;
  };
  const order = orderByClause(parseSort(sort, SORTABLE), "id");

  const filters: string[] = [];
  const values: unknown[] = [];
  if (role) {
    values.push(role);
    filters.push(`role = $${values.length}`);
  }
  if (status) {
    values.push(status);
    filters.push(`status = $${values.length}`);
  }
  if (q) {
    values.push(`%${q}%`);
    filters.push(`(full_name ilike $${values.length} or username::text ilike $${values.length})`);
  }
  const where = filters.length ? `where ${filters.join(" and ")}` : "";

  // The list and its count share one transaction with the owner's RLS context, so both
  // see the same rows (and a coach, who holds no `users:manage`, cannot reach this).
  const { total, rows } = await asViewer(viewer, async (client) => {
    const totalResult = await client.query<{ total: string }>(
      `select count(*)::text as total from users ${where}`,
      values,
    );
    const page$ = await client.query<UserRow & { created_at: Date }>(
      `${USER_SELECT} ${where} ${order} limit $${values.length + 1} offset $${values.length + 2}`,
      [...values, pageSize, (page - 1) * pageSize],
    );
    return { total: Number(totalResult.rows[0]?.total ?? 0), rows: page$.rows };
  });

  return {
    status: 200,
    body: {
      data: rows.map(serializeUser),
      meta: {
        page,
        pageSize,
        total,
        totalPages: pageSize > 0 ? Math.ceil(total / pageSize) : 0,
      },
    },
  };
};

export const usr02Create: Handler = async ({ ctx, viewer, body }): Promise<HandlerResult> => {
  const input = body as { username: string; fullName: string; phone?: string; role: "owner" | "coach" };
  const username = input.username.toLowerCase();

  let phone: string | null = null;
  if (input.phone) {
    try {
      phone = normalizePhone(input.phone);
    } catch {
      throw errors.validation([{ field: "phone", issue: "Enter a valid phone number." }]);
    }
  }

  const token = generateOpaqueToken();
  const expiresAt = inviteExpiry();
  const userId = uuidv7();

  try {
    const created = await withTransaction({ userId: viewer.userId, role: viewer.role }, async (client) => {
      const inserted = await client.query<UserRow>(
        `insert into users (id, username, full_name, phone_e164, role, status, created_by)
         values ($1, $2, $3, $4, $5, 'invited', $6)
         returning id, username::text as username, full_name, phone_e164, role, status,
                   totp_enabled, last_login_at`,
        [userId, username, input.fullName.trim(), phone, input.role, viewer.userId],
      );
      await client.query(
        `insert into user_invites (id, user_id, token_hash, purpose, expires_at, created_by)
         values ($1, $2, $3, 'invite', $4, $5)`,
        [uuidv7(), userId, token.hash, expiresAt, viewer.userId],
      );
      await audit.record(client, viewerAudit(viewer, ctx), {
        action: "user.create",
        entityType: "user",
        entityId: userId,
        after: { username, role: input.role, status: "invited" },
      });
      return inserted.rows[0]!;
    });

    return {
      status: 201,
      body: {
        user: serializeUser(created),
        // Returned once; no email service exists in v1 (ADR-018).
        inviteUrl: `${config.appBaseUrl}/accept-invite?token=${token.token}`,
        inviteExpiresAt: expiresAt.toISOString(),
      },
    };
  } catch (err) {
    mapPgError(err);
  }
};

export const usr03Get: Handler = async ({ viewer, params }): Promise<HandlerResult> => {
  const { id } = params as { id: string };
  const user = await asViewer(viewer, async (client) => {
    const result = await client.query<UserRow>(`${USER_SELECT} where id = $1`, [id]);
    return result.rows[0] ?? null;
  });
  // A coach cannot read another user's row even by id: the policy hides it, and the
  // permission guard has already refused them, so this is the owner path only.
  if (!user) throw errors.notFound();
  return { status: 200, body: serializeUser(user) };
};

export const usr03Update: Handler = async ({ ctx, viewer, params, body }): Promise<HandlerResult> => {
  const { id } = params as { id: string };
  const input = body as { fullName?: string; phone?: string; role?: "owner" | "coach" };

  let phone: string | null | undefined;
  if (input.phone !== undefined) {
    try {
      phone = normalizePhone(input.phone);
    } catch {
      throw errors.validation([{ field: "phone", issue: "Enter a valid phone number." }]);
    }
  }

  try {
    return await withTransaction({ userId: viewer.userId, role: viewer.role }, async (client) => {
      const before = await client.query<UserRow>(`${USER_SELECT} where id = $1`, [id]);
      const existing = before.rows[0];
      if (!existing) throw errors.notFound();

      const updated = await client.query<UserRow>(
        `update users
            set full_name = coalesce($2, full_name),
                phone_e164 = case when $3::boolean then $4 else phone_e164 end,
                role = coalesce($5, role),
                updated_at = now()
          where id = $1
        returning id, username::text as username, full_name, phone_e164, role, status,
                  totp_enabled, last_login_at`,
        [id, input.fullName?.trim() ?? null, input.phone !== undefined, phone ?? null, input.role ?? null],
      );

      await audit.record(client, viewerAudit(viewer, ctx), {
        action: "user.update",
        entityType: "user",
        entityId: id,
        before: serializeUser(existing),
        after: serializeUser(updated.rows[0]!),
      });
      // The deferred owner-invariant trigger fires at COMMIT; mapPgError below turns
      // its refusal into 409 LAST_OWNER.
      return { status: 200, body: serializeUser(updated.rows[0]!) };
    });
  } catch (err) {
    mapPgError(err);
  }
};

async function setStatus(
  ctx: Parameters<Handler>[0]["ctx"],
  viewer: Parameters<Handler>[0]["viewer"],
  id: string,
  next: "active" | "disabled",
  reason: string | undefined,
): Promise<HandlerResult> {
  try {
    return await withTransaction({ userId: viewer.userId, role: viewer.role }, async (client) => {
      const before = await client.query<UserRow>(`${USER_SELECT} where id = $1`, [id]);
      const existing = before.rows[0];
      if (!existing) throw errors.notFound();
      if (existing.status === next) {
        throw errors.validation([{ field: "status", issue: `User is already ${next}.` }]);
      }
      if (next === "active" && existing.status === "invited") {
        // Enabling an invited user would make them active with no password.
        throw new (await import("../errors.js")).ApiError(
          "INVALID_STATE_TRANSITION",
          "This user has not accepted their invite yet. Send a reset link instead.",
        );
      }

      const updated = await client.query<UserRow>(
        `update users set status = $2, updated_at = now()
          where id = $1
        returning id, username::text as username, full_name, phone_e164, role, status,
                  totp_enabled, last_login_at`,
        [id, next],
      );

      if (next === "disabled") {
        // Disabling cuts access immediately (AUTH §1).
        await revokeAllSessions(client, { userId: id, reason: "user_disabled" });
      }

      await audit.record(client, viewerAudit(viewer, ctx), {
        action: next === "disabled" ? "user.disable" : "user.enable",
        entityType: "user",
        entityId: id,
        before: serializeUser(existing),
        after: serializeUser(updated.rows[0]!),
        ...(reason ? { reason } : {}),
      });
      return { status: 200, body: serializeUser(updated.rows[0]!) };
    });
  } catch (err) {
    mapPgError(err);
  }
}

export const usr04Disable: Handler = async ({ ctx, viewer, params, body }) =>
  setStatus(ctx, viewer, (params as { id: string }).id, "disabled", (body as { reason?: string }).reason);

export const usr04Enable: Handler = async ({ ctx, viewer, params, body }) =>
  setStatus(ctx, viewer, (params as { id: string }).id, "active", (body as { reason?: string }).reason);

export const usr05ResetPassword: Handler = async ({ ctx, viewer, params }): Promise<HandlerResult> => {
  const { id } = params as { id: string };
  const token = generateOpaqueToken();
  const expiresAt = inviteExpiry();

  try {
    await withTransaction({ userId: viewer.userId, role: viewer.role }, async (client) => {
      const existing = await client.query<{ id: string; status: string }>(
        "select id, status from users where id = $1",
        [id],
      );
      if (!existing.rows[0]) throw errors.notFound();

      await client.query(
        `insert into user_invites (id, user_id, token_hash, purpose, expires_at, created_by)
         values ($1, $2, $3, 'password_reset', $4, $5)`,
        [uuidv7(), id, token.hash, expiresAt, viewer.userId],
      );
      // A reset invalidates existing sessions: the old credential may be compromised.
      await revokeAllSessions(client, { userId: id, reason: "password_reset" });
      await audit.record(client, viewerAudit(viewer, ctx), {
        action: "user.reset_password",
        entityType: "user",
        entityId: id,
      });
    });
  } catch (err) {
    mapPgError(err);
  }

  return {
    status: 200,
    body: {
      inviteUrl: `${config.appBaseUrl}/accept-invite?token=${token.token}`,
      inviteExpiresAt: expiresAt.toISOString(),
    },
  };
};
