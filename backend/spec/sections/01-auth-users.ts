/**
 * API_CONTRACTS §3.1 — Auth and users.
 *
 * ## One required change outside this file (reported to the coordinator)
 *
 * Five routes here are **self-service**: AUTH-02 (logout), AUTH-03 (`/auth/me`),
 * AUTH-04 (change password), AUTH-06 (own sessions), AUTH-07 (TOTP). AUTH §4 grants
 * "Own profile / change password / sessions" to **both** roles, and the permission
 * list in AUTH §4 deliberately contains no `self:` entry — the `session` auth level
 * *is* the authorization for them. `endpoint()` in `spec/registry.ts` currently
 * requires a `permission` for every non-public route, so those five declarations
 * throw `"<ID>: an authenticated endpoint must declare a permission"` when this
 * module is imported.
 *
 * They are left without a permission on purpose: inventing one (e.g. `users:manage`)
 * would put a false permission into the generated document and into the future
 * route-matrix test, where a coach would then be *forbidden* from logging out. The
 * one-line fix belongs in `spec/registry.ts`:
 *
 *     if (def.auth !== "public" && def.auth !== "session" && def.auth !== "webhook_hmac" && !def.permission)
 *
 * (`auth: "session"` = any authenticated user, acting on their own account.)
 */
import {
  endpoint,
  section,
  res,
  z,
  type Section,
  type EndpointDef,
} from "../registry.js";
import {
  AuthSession,
  CreateUserResponse,
  Id,
  Instant,
  Me,
  Role,
  SessionListResponse,
  User,
  pageOf,
  pageQuery,
  qParam,
  sortParam,
} from "../components.js";

const usersPage = pageOf(User);

/** `{ username, password, totpCode? }` — username is the login identifier (ADR-018). */
const LoginRequest = z.strictObject({
  username: z
    .string()
    .regex(/^[a-z0-9._-]{3,32}$/)
    .describe("Case-insensitive; stored lower-case (ADR-018)"),
  password: z.string().min(1),
  totpCode: z
    .string()
    .regex(/^[0-9]{6}$/)
    .optional()
    .describe("Required when the account has TOTP enabled; missing ⇒ 401 TOTP_REQUIRED is NOT used — see handoff"),
});

/** USR-02 request. The owner picks the username and passes the invite link out-of-band. */
const UserCreateRequest = z.strictObject({
  username: z.string().regex(/^[a-z0-9._-]{3,32}$/),
  fullName: z.string().min(2).max(120),
  phone: z.string().optional().describe("Local (077…) or E.164; normalized to E.164, LK default"),
  role: Role,
});

const UserUpdateRequest = z.strictObject({
  fullName: z.string().min(2).max(120).optional(),
  phone: z.string().optional(),
  role: Role.optional().describe("Demoting the last active owner ⇒ 409 LAST_OWNER"),
});

const PasswordChangeRequest = z.strictObject({
  currentPassword: z.string().min(1),
  newPassword: z
    .string()
    .min(12)
    .describe("≥ 12 chars, not the username, not in the bundled common-password list"),
});

const AcceptInviteRequest = z.strictObject({
  token: z.string().min(16),
  password: z.string().min(12),
});

const TotpConfirmRequest = z.strictObject({
  code: z.string().regex(/^[0-9]{6}$/),
});

const TotpDisableRequest = z.strictObject({
  password: z.string().min(1),
});

const ResetPasswordResponse = z.object({
  inviteUrl: z.string(),
  inviteExpiresAt: Instant,
});

const idParam = z.object({ id: Id });

const sessionIdParam = z.object({ id: z.string().describe("Session id from AUTH-06") });

const endpoints: EndpointDef[] = [
  // -------------------------------------------------------------------------
  // AUTH-01 — sign in
  // -------------------------------------------------------------------------
  endpoint({
    id: "AUTH-01",
    method: "post",
    path: "/auth/login",
    auth: "public",
    summary: "Sign in with username and password",
    description: [
      "Sets the `ia_session` cookie (HttpOnly; Secure; SameSite=Lax) and returns `Me`",
      "including a fresh CSRF token. The session token is rotated on every login.",
      "Failures are always the same generic `INVALID_CREDENTIALS` (no account enumeration).",
      "No `X-CSRF-Token` is required (no session exists yet), but the `Origin`/`Referer`",
      "allow-list is still enforced.",
      "Audit: every attempt is recorded (success and failure).",
    ].join(" "),
    tags: ["Auth"],
    // Not `mutating`: `mutating` means "requires X-CSRF-Token + Origin" in the registry,
    // and login legitimately cannot carry a CSRF token. It still writes an audit row.
    audit: "auth.login",
    rateLimit: "login",
    body: LoginRequest,
    responses: [res.json(200, Me, "Signed in; session cookie set and CSRF token issued")],
    errors: ["INVALID_CREDENTIALS", "ACCOUNT_LOCKED", "ACCOUNT_DISABLED", "RATE_LIMITED"],
    milestone: "m2",
  }),

  // -------------------------------------------------------------------------
  // AUTH-02 — sign out
  // -------------------------------------------------------------------------
  endpoint({
    id: "AUTH-02",
    method: "post",
    path: "/auth/logout",
    auth: "session",
    summary: "Sign out of the current session",
    description: "Revokes only the current session row; the cookie is cleared.",
    tags: ["Auth"],
    mutating: true,
    audit: "auth.logout",
    responses: [res.empty(204, "Session revoked and cookie cleared")],
    milestone: "m2",
  }),

  // -------------------------------------------------------------------------
  // AUTH-03 — current user / CSRF refresh
  // -------------------------------------------------------------------------
  endpoint({
    id: "AUTH-03",
    method: "get",
    path: "/auth/me",
    auth: "session",
    summary: "Current user, permissions and a fresh CSRF token",
    description:
      "Also the CSRF recovery path: after a 403 CSRF_FAILED the frontend calls this to obtain a new token and retries once. Coaches receive `assignedGroupIds`.",
    tags: ["Auth"],
    responses: [res.json(200, Me, "The caller's identity, permissions and academy summary")],
    milestone: "m2",
  }),

  // -------------------------------------------------------------------------
  // AUTH-04 — change own password
  // -------------------------------------------------------------------------
  endpoint({
    id: "AUTH-04",
    method: "post",
    path: "/auth/change-password",
    auth: "session",
    summary: "Change the caller's password",
    description: "Revokes every other session of this user; the current session survives.",
    tags: ["Auth"],
    mutating: true,
    audit: "auth.change_password",
    body: PasswordChangeRequest,
    responses: [res.empty(204, "Password changed; other sessions revoked")],
    errors: ["INVALID_CREDENTIALS", "RATE_LIMITED"],
    milestone: "m2",
  }),

  // -------------------------------------------------------------------------
  // AUTH-05 — accept an invite
  // -------------------------------------------------------------------------
  endpoint({
    id: "AUTH-05",
    method: "post",
    path: "/auth/accept-invite",
    auth: "public",
    summary: "Accept an invite (or password-reset link) and set a password",
    description: [
      "Single use, 72 h TTL, token stored only as a SHA-256 hash. On success the user",
      "becomes `active`, is signed in, and `Me` is returned.",
      "No CSRF token is required (no session exists yet).",
      "An invalid/expired/used token returns the same generic error for every failure kind.",
    ].join(" "),
    tags: ["Auth"],
    audit: "auth.accept_invite",
    rateLimit: "auth",
    body: AcceptInviteRequest,
    responses: [res.json(200, Me, "Password set; invite consumed; signed in")],
    errors: ["VALIDATION_ERROR", "RATE_LIMITED"],
    milestone: "m2",
  }),

  // -------------------------------------------------------------------------
  // AUTH-06 — own sessions
  // -------------------------------------------------------------------------
  endpoint({
    id: "AUTH-06",
    operationId: "AUTH-06.list",
    method: "get",
    path: "/auth/sessions",
    auth: "session",
    summary: "List the caller's active sessions",
    tags: ["Auth"],
    responses: [res.json(200, SessionListResponse, "Own sessions, newest first")],
    milestone: "m2",
  }),
  endpoint({
    id: "AUTH-06",
    operationId: "AUTH-06.revoke",
    method: "delete",
    path: "/auth/sessions/{id}",
    auth: "session",
    summary: "Revoke one of the caller's sessions",
    description: "Only the caller's own sessions can be revoked; another user's id ⇒ 404.",
    tags: ["Auth"],
    mutating: true,
    audit: "auth.session_revoke",
    params: sessionIdParam,
    responses: [res.empty(204, "Session revoked")],
    milestone: "m2",
  }),

  // -------------------------------------------------------------------------
  // AUTH-07 — owner TOTP (owners only; recommended, OPEN-010)
  // -------------------------------------------------------------------------
  endpoint({
    id: "AUTH-07",
    operationId: "AUTH-07.enroll",
    method: "post",
    path: "/auth/totp/enroll",
    auth: "session",
    summary: "Start TOTP enrolment",
    description:
      "Returns an `otpauth://` URI for the authenticator app. Nothing is enforced until AUTH-07 confirm succeeds. The secret is stored encrypted (TOTP_ENCRYPTION_KEY). Recovery for a locked-out owner is the server-side `reset-owner` CLI.",
    tags: ["Auth"],
    mutating: true,
    audit: "auth.totp_enroll",
    responses: [
      res.json(
        200,
        z.object({ secretUri: z.string().describe("otpauth:// URI, shown once") }),
        "Enrolment started",
      ),
    ],
    errors: ["INVALID_STATE_TRANSITION"],
    milestone: "m2",
  }),
  endpoint({
    id: "AUTH-07",
    operationId: "AUTH-07.confirm",
    method: "post",
    path: "/auth/totp/confirm",
    auth: "session",
    summary: "Confirm TOTP enrolment with a code",
    description: "Enables TOTP; subsequent logins require `totpCode`.",
    tags: ["Auth"],
    mutating: true,
    audit: "auth.totp_confirm",
    body: TotpConfirmRequest,
    responses: [res.empty(204, "TOTP enabled")],
    errors: ["INVALID_CREDENTIALS", "INVALID_STATE_TRANSITION"],
    milestone: "m2",
  }),
  endpoint({
    id: "AUTH-07",
    operationId: "AUTH-07.disable",
    method: "post",
    path: "/auth/totp/disable",
    auth: "session",
    summary: "Disable TOTP",
    description: "Requires the current password. Recorded in the audit log.",
    tags: ["Auth"],
    mutating: true,
    audit: "auth.totp_disable",
    body: TotpDisableRequest,
    responses: [res.empty(204, "TOTP disabled")],
    errors: ["INVALID_CREDENTIALS", "INVALID_STATE_TRANSITION"],
    milestone: "m2",
  }),

  // -------------------------------------------------------------------------
  // USR-01 — list users (owner)
  // -------------------------------------------------------------------------
  endpoint({
    id: "USR-01",
    method: "get",
    path: "/users",
    auth: "owner",
    permission: "users:manage",
    summary: "List users",
    tags: ["Users"],
    query: pageQuery.extend({
      role: Role.optional(),
      status: z.enum(["invited", "active", "disabled"]).optional(),
      q: qParam,
      sort: sortParam,
    }),
    responses: [res.json(200, usersPage, "Paginated users")],
    errors: ["INVALID_SORT"],
    milestone: "m2",
  }),

  // -------------------------------------------------------------------------
  // USR-02 — create a user and invite them
  // -------------------------------------------------------------------------
  endpoint({
    id: "USR-02",
    method: "post",
    path: "/users",
    auth: "owner",
    permission: "users:manage",
    summary: "Create a user and return a one-time invite URL",
    description: [
      "The user starts as `invited` with no password hash; the invite link (72 h, single",
      "use) is returned **once** and shown to the owner so it can be handed over out of",
      "band. No email service exists in v1 (ADR-018).",
      "The username is the login identifier, is immutable afterwards, and a rename is a",
      "new user plus a re-invite.",
    ].join(" "),
    tags: ["Users"],
    mutating: true,
    audit: "user.create",
    body: UserCreateRequest,
    responses: [res.json(201, CreateUserResponse, "User created; invite URL returned once")],
    errors: ["INVALID_STATE_TRANSITION"],
    milestone: "m2",
  }),

  // -------------------------------------------------------------------------
  // USR-03 — read / update a user
  // -------------------------------------------------------------------------
  endpoint({
    id: "USR-03",
    operationId: "USR-03.get",
    method: "get",
    path: "/users/{id}",
    auth: "owner",
    permission: "users:manage",
    summary: "Read one user",
    tags: ["Users"],
    params: idParam,
    responses: [res.json(200, User, "The user")],
    milestone: "m2",
  }),
  endpoint({
    id: "USR-03",
    operationId: "USR-03.update",
    method: "patch",
    path: "/users/{id}",
    auth: "owner",
    permission: "users:manage",
    summary: "Update a user's name, phone or role",
    description:
      "Demoting (or otherwise removing) the last active owner ⇒ 409 LAST_OWNER; guards run inside a transaction that locks the owner rows so two concurrent demotions cannot both succeed.",
    tags: ["Users"],
    mutating: true,
    audit: "user.update",
    params: idParam,
    body: UserUpdateRequest,
    responses: [res.json(200, User, "Updated user")],
    errors: ["LAST_OWNER"],
    milestone: "m2",
  }),

  // -------------------------------------------------------------------------
  // USR-04 — disable / enable a user
  // -------------------------------------------------------------------------
  endpoint({
    id: "USR-04",
    operationId: "USR-04.disable",
    method: "post",
    path: "/users/{id}/disable",
    auth: "owner",
    permission: "users:manage",
    summary: "Disable a user",
    description:
      "Sets `status='disabled'` and revokes all their sessions immediately. The last active owner cannot be disabled (409 LAST_OWNER). Users are never deleted.",
    tags: ["Users"],
    mutating: true,
    audit: "user.disable",
    params: idParam,
    body: z.strictObject({
      reason: z.string().max(500).optional(),
    }),
    responses: [res.json(200, User, "Disabled user")],
    errors: ["LAST_OWNER", "INVALID_STATE_TRANSITION"],
    milestone: "m2",
  }),
  endpoint({
    id: "USR-04",
    operationId: "USR-04.enable",
    method: "post",
    path: "/users/{id}/enable",
    auth: "owner",
    permission: "users:manage",
    summary: "Re-enable a disabled user",
    tags: ["Users"],
    mutating: true,
    audit: "user.enable",
    params: idParam,
    body: z.strictObject({
      reason: z.string().max(500).optional(),
    }),
    responses: [res.json(200, User, "Re-enabled user")],
    errors: ["INVALID_STATE_TRANSITION"],
    milestone: "m2",
  }),

  // -------------------------------------------------------------------------
  // USR-05 — reset a password (owner issues a new invite link)
  // -------------------------------------------------------------------------
  endpoint({
    id: "USR-05",
    method: "post",
    path: "/users/{id}/reset-password",
    auth: "owner",
    permission: "users:manage",
    summary: "Issue a password-reset link for a user",
    description: [
      "There is no self-service \"forgot password\": a coach asks an owner, who runs this",
      "and hands over the link. All of the user's sessions are revoked; the new link is",
      "returned once (72 h, single use).",
    ].join(" "),
    tags: ["Users"],
    mutating: true,
    audit: "user.reset_password",
    params: idParam,
    responses: [res.json(200, ResetPasswordResponse, "Reset link returned once")],
    errors: ["INVALID_STATE_TRANSITION"],
    milestone: "m2",
  }),
];

export const authUsersSection: Section = section("3.1 Auth and users", endpoints);

// Re-exported only to make the shared types obvious to reviewers of this file.
export type { AuthSession, User };
