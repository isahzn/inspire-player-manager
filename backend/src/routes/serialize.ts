/**
 * Serializers. Role-specific projections live together so a field can never leak by
 * being added to one call site only (BACKEND_BUILD_GUIDE §4: never return full rows).
 */
import type { Viewer } from "../http/context.js";
import { academyLogoUrl } from "./academy-brand.js";

export interface UserRow {
  id: string;
  username: string;
  full_name: string;
  phone_e164: string | null;
  role: "owner" | "coach";
  status: "invited" | "active" | "disabled";
  totp_enabled: boolean;
  last_login_at: Date | null;
}

/** `User` (API_CONTRACTS §2). Never includes a hash, a secret or an invite token. */
export function serializeUser(row: UserRow) {
  return {
    id: row.id,
    username: row.username,
    fullName: row.full_name,
    ...(row.phone_e164 ? { phone: row.phone_e164 } : {}),
    role: row.role,
    status: row.status,
    totpEnabled: row.totp_enabled,
    ...(row.last_login_at ? { lastLoginAt: row.last_login_at.toISOString() } : {}),
  };
}

/**
 * `Me` (API_CONTRACTS §2). `assignedGroupIds` is a coach-only projection; it is omitted
 * until M3 introduces `coach_group_assignments` (noted in the M2 handoff).
 */
export function serializeMe(viewer: Viewer, assignedGroupIds?: string[]) {
  return {
    user: {
      id: viewer.userId,
      username: viewer.username,
      fullName: viewer.fullName,
      ...(viewer.phone ? { phone: viewer.phone } : {}),
      role: viewer.role,
      status: viewer.status,
      totpEnabled: viewer.totpEnabled,
    },
    csrfToken: viewer.csrfToken,
    academy: {
      name: viewer.academy.name,
      timezone: viewer.academy.timezone,
      // Absent until the owner uploads a logo (SET-03): the UI then shows the name as a plain
      // wordmark, which is exactly what the PDFs do (FILES_AND_PDF §1 — never invent a logo).
      ...(viewer.academy.logoFileId ? { logoUrl: academyLogoUrl() } : {}),
    },
    permissions: viewer.permissions,
    ...(viewer.role === "coach" && assignedGroupIds ? { assignedGroupIds } : {}),
  };
}
