/**
 * The **one** place a role maps to permissions (AUTH_AND_PERMISSIONS §4). Endpoints
 * declare the permission they need; nothing else in the codebase may branch on role
 * for authorization.
 */
import type { Permission } from "../../spec/registry.js";
import type { Role } from "../../spec/components.js";

const OWNER_PERMISSIONS: readonly Permission[] = [
  "users:manage",
  "settings:manage",
  "groups:manage",
  "groups:read",
  "fees:manage",
  "players:manage",
  "players:read",
  "guardians:manage",
  "sessions:manage",
  "sessions:read",
  "attendance:mark",
  "attendance:correct_any",
  "coach_attendance:self",
  "coach_attendance:manage",
  "billing:manage",
  "payments:manage",
  "files:read_sensitive",
  "messaging:manage",
  "reports:read",
  "audit:read",
  "import:manage",
];

/**
 * A coach sees and acts only inside currently assigned age groups, and reads players
 * through a restricted projection. No financial, messaging, user-admin or settings
 * permission appears here — that is the point of the list.
 */
const COACH_PERMISSIONS: readonly Permission[] = [
  "groups:read",
  "players:read_restricted",
  "sessions:read",
  "attendance:mark",
  "coach_attendance:self",
];

const BY_ROLE: Record<Role, ReadonlySet<Permission>> = {
  owner: new Set(OWNER_PERMISSIONS),
  coach: new Set(COACH_PERMISSIONS),
};

export function rolePermissions(role: Role): Permission[] {
  return [...BY_ROLE[role]];
}

export function can(role: Role, permission: Permission): boolean {
  return BY_ROLE[role].has(permission);
}

/**
 * Endpoints that serve both roles with different projections declare the owner-level
 * permission (PLY-01/03 return `Player` for an owner and `PlayerCoachView` for a
 * coach). A role holding the *restricted* alternative may proceed, and the guard
 * records that the caller must be served the restricted projection.
 *
 * This is not a loophole: the restricted permission grants strictly less (assigned
 * groups, allow-listed fields), and T-AUTH-05 asserts the payload keys directly.
 */
const RESTRICTED_ALTERNATIVE: Partial<Record<Permission, Permission>> = {
  "players:read": "players:read_restricted",
};

export interface PermissionDecision {
  allowed: boolean;
  /** True when the caller was admitted through the restricted alternative. */
  restricted: boolean;
}

export function authorize(role: Role, permission: Permission): PermissionDecision {
  if (can(role, permission)) return { allowed: true, restricted: false };
  const alternative = RESTRICTED_ALTERNATIVE[permission];
  if (alternative && can(role, alternative)) return { allowed: true, restricted: true };
  return { allowed: false, restricted: false };
}
