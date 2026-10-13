// Route guards per docs/frontend/ROUTES_AND_NAVIGATION.md §3.
// Guard source is Me.permissions (not hard-coded roles). Hiding a link is
// cosmetic — every route also handles 401/403/404 from the API.

/** Owner-only route prefixes → required permission. Coach routes are open. */
export const ROUTE_PERMISSIONS: Record<string, string> = {
  "/billing": "billing:manage",
  "/payments": "payments:manage",
  "/whatsapp": "messaging:manage",
  "/reports": "reports:read",
  "/users": "users:manage",
  "/settings": "settings:manage",
  "/audit": "audit:read",
  "/system": "settings:manage",
  "/coaches": "users:manage",
  "/imports": "players:manage",
  "/schedules": "settings:manage",
};

/** True when permissions grant access to path (exact or nested). */
export function canAccess(permissions: string[], path: string): boolean {
  for (const [prefix, required] of Object.entries(ROUTE_PERMISSIONS)) {
    if (path === prefix || path.startsWith(`${prefix}/`)) {
      return permissions.includes(required);
    }
  }
  return true;
}

/** Same-origin check for login ?next= round-trips. */
export function safeNext(next: string | null): string {
  if (next && next.startsWith("/") && !next.startsWith("//")) return next;
  return "/dashboard";
}
