"use client";

// Guards per ROUTES_AND_NAVIGATION §3: no session → /login?next=; coach on an
// owner route → /403 content WITHOUT calling owner APIs; API 403 → inline
// permission-denied state; 404 (incl. out-of-scope) → not-found state.

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { useAuth } from "@/lib/auth";
import { canAccess } from "@/lib/permissions";

export function AuthLoading() {
  return (
    <div aria-busy="true" aria-label="Loading">
      <div className="skeleton h-8 w-48 rounded-lg" />
      <div className="mt-4 grid grid-cols-2 gap-3 xl:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="skeleton h-28 rounded-2xl" />
        ))}
      </div>
    </div>
  );
}

/** Redirects to /login?next= when signed out. Renders children when signed in. */
export function RequireAuth({ children }: { children: React.ReactNode }) {
  const { status } = useAuth();
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    if (status === "unauthenticated") {
      router.replace(`/login?next=${encodeURIComponent(pathname)}`);
    }
  }, [status, pathname, router]);

  if (status === "loading") return <AuthLoading />;
  if (status === "unauthenticated") return <AuthLoading />;
  return <>{children}</>;
}

/**
 * Owner-only gate. Checks Me.permissions BEFORE any data fetch, so coach
 * views never call owner APIs. Renders the /403 state inline (not redirect).
 */
export function RequirePermissions({
  path,
  children,
}: {
  path: string;
  children: React.ReactNode;
}) {
  const { me, status } = useAuth();
  if (status !== "authenticated" || !me) return <AuthLoading />;
  if (!canAccess(me.permissions, path)) return <PermissionDeniedInline />;
  return <>{children}</>;
}

/**
 * Owner-only action gate driven by a single permission (never a hard-coded
 * role), for routes whose rule is not in ROUTE_PERMISSIONS (e.g. /players/new).
 */
export function RequirePermission({
  permission,
  children,
}: {
  permission: string;
  children: React.ReactNode;
}) {
  const { me, status } = useAuth();
  if (status !== "authenticated" || !me) return <AuthLoading />;
  if (!me.permissions.includes(permission)) return <PermissionDeniedInline />;
  return <>{children}</>;
}

export function PermissionDeniedInline() {
  return (
    <div className="mx-auto max-w-md rounded-2xl border border-slate-200 bg-white p-6 text-center shadow-card">
      <h1 className="font-heading text-lg font-bold">No access</h1>
      <p className="mt-1 text-[14px] text-slate-600">
        You do not have permission to view this page. Access is enforced on the
        server too — hiding this link would not be enough.
      </p>
      <Link
        href="/dashboard"
        className="touch44 mt-4 inline-flex min-h-[44px] items-center font-semibold text-pitch-700 underline underline-offset-2"
      >
        Go to dashboard
      </Link>
    </div>
  );
}
