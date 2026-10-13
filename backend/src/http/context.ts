/**
 * Per-request state. Populated by the guards in `router.ts`:
 * requestId/ip always, the viewer once a session is resolved.
 */
import type { PoolClient } from "pg";
import type { Permission } from "../../spec/registry.js";
import type { Role } from "../../spec/components.js";
import { withTransaction } from "../db/pool.js";

export interface Viewer {
  userId: string;
  username: string;
  fullName: string;
  phone: string | null;
  role: Role;
  status: "invited" | "active" | "disabled";
  totpEnabled: boolean;
  permissions: Permission[];
  /** True when the caller was admitted through a restricted permission (coach). */
  restricted: boolean;
  sessionId: string;
  csrfToken: string;
  /**
   * Read from `app.academy_public` (a narrow SECURITY DEFINER view), so a coach can
   * reach the two settings the restricted projection needs without any policy on the
   * owner-only `academy_settings` table being widened.
   */
  academy: {
    name: string;
    timezone: string;
    logoFileId: string | null;
    ageReferenceRule: "jan_1_of_year" | "fixed_month_day" | "today";
    ageReferenceMonthDay: string | null;
    coachCanSeeGuardianPhone: boolean;
  };
}

export interface AppContext {
  requestId: string;
  ip: string | null;
  viewer: Viewer | null;
}

declare module "fastify" {
  interface FastifyRequest {
    ia: AppContext;
  }
}

/** Narrowing helper: routes behind the auth guard always have a viewer. */
export function requireViewer(ctx: AppContext): Viewer {
  if (!ctx.viewer) throw new Error("viewer missing: route is not behind the auth guard");
  return ctx.viewer;
}

/**
 * Runs `fn` in one transaction with the viewer's identity applied to the RLS context
 * (`app.user_id`, `app.role`).
 *
 * Handler bodies must use this or `withTransaction` rather than the bare pool: with no
 * context set, `app.app_role()` is empty, the identity policies match nothing and a read
 * silently returns **zero rows** instead of failing — which looks like "not found" at the
 * edge and is invisible in a passing test that only checks status codes.
 */
export async function asViewer<T>(
  viewer: Pick<Viewer, "userId" | "role">,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return withTransaction({ userId: viewer.userId, role: viewer.role }, fn);
}
