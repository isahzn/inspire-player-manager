"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import {
  Activity,
  BarChart3,
  CalendarCheck,
  History,
  LayoutDashboard,
  Layers,
  LogOut,
  MessageCircle,
  Receipt,
  Settings,
  Shield,
  ShieldCheck,
  Timer,
  Trophy,
  Users,
} from "lucide-react";
import { useAuth } from "@/lib/auth";
import { canAccess } from "@/lib/permissions";

const PUBLIC_ROUTES = ["/login", "/accept-invite", "/forgot-password"];

const ALL_NAV = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard, perm: null as string | null },
  { href: "/players", label: "Players", icon: Users, perm: null },
  { href: "/age-groups", label: "Age Groups", icon: Layers, perm: null },
  { href: "/sessions", label: "Sessions", icon: CalendarCheck, perm: null },
  { href: "/coach-attendance", label: "Coach Time", icon: Timer, perm: null },
  { href: "/billing", label: "Billing", icon: Receipt, perm: "billing:manage" },
  { href: "/whatsapp", label: "WhatsApp", icon: MessageCircle, perm: "messaging:manage" },
  { href: "/reports", label: "Reports", icon: BarChart3, perm: "reports:read" },
  { href: "/users", label: "Users", icon: Shield, perm: "users:manage" },
  { href: "/settings", label: "Settings", icon: Settings, perm: "settings:manage" },
  { href: "/audit", label: "Audit", icon: History, perm: "audit:read" },
  { href: "/system", label: "System", icon: Activity, perm: "settings:manage" },
];

const OWNER_MOBILE_TABS = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard, perm: null as string | null },
  { href: "/players", label: "Players", icon: Users, perm: null },
  { href: "/billing", label: "Billing", icon: Receipt, perm: "billing:manage" },
  { href: "/whatsapp", label: "WhatsApp", icon: MessageCircle, perm: "messaging:manage" },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { me, status, logout, switchMockRole } = useAuth();
  const [moreOpen, setMoreOpen] = useState(false);
  const mocksOn = process.env.NEXT_PUBLIC_USE_MOCKS === "true";

  if (PUBLIC_ROUTES.includes(pathname)) {
    return <>{children}</>;
  }

  const permissions = me?.permissions ?? [];
  const nav = ALL_NAV.filter((i) => !i.perm || permissions.includes(i.perm));
  // Coach tab bar: first 4 permitted entries (Today · Sessions · Groups · Time).
  const tabs = (me?.user.role === "owner" ? OWNER_MOBILE_TABS : ALL_NAV.slice(0, 5)).filter(
    (i) => !i.perm || permissions.includes(i.perm)
  );

  async function onSignOut() {
    await logout();
    router.replace("/login");
  }

  return (
    <div className="min-h-dvh">
      {/* Desktop sidebar */}
      <aside
        aria-label="Primary"
        className="fixed inset-y-0 left-0 z-20 hidden w-[248px] flex-col bg-navy-900 text-white lg:flex"
      >
        <div className="flex items-center gap-3 border-b border-white/10 px-5 pb-5 pt-6">
          <div
            aria-hidden="true"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-pitch-600"
          >
            <Trophy className="h-6 w-6 text-white" />
          </div>
          <div>
            <p className="font-heading text-[17px] font-bold leading-tight">
              {me?.academy.name ?? "Inspire Academy"}
            </p>
            <p className="text-[12px] tracking-wide text-slate-300">
              FOOTBALL CLUB · MGMT
            </p>
          </div>
        </div>
        <nav aria-label="Sections" className="flex-1 space-y-1 overflow-y-auto px-3 py-4 text-[14px]">
          {status === "loading" || !me
            ? [0, 1, 2, 3, 4].map((i) => (
                <div key={i} className="skeleton h-11 rounded-lg" aria-hidden="true" />
              ))
            : nav.map((item) => {
                const active = pathname.startsWith(item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    className={`flex min-h-[44px] items-center gap-3 rounded-lg px-3 font-medium transition-colors ${
                      active
                        ? "bg-white/15 text-white"
                        : "text-slate-300 hover:bg-white/10 hover:text-white"
                    }`}
                  >
                    <item.icon className="h-5 w-5 shrink-0" aria-hidden="true" />
                    {item.label}
                  </Link>
                );
              })}
        </nav>
        <div className="border-t border-white/10 px-4 py-4">
          <div className="flex items-center gap-3">
            <div
              aria-hidden="true"
              className="flex h-10 w-10 items-center justify-center rounded-full bg-white/15 font-heading font-semibold"
            >
              {me ? me.user.fullName.slice(0, 2).toUpperCase() : "··"}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[14px] font-semibold">
                {me ? `${me.user.fullName} · ${me.user.role === "owner" ? "Owner" : "Coach"}` : "…"}
              </p>
              {mocksOn ? (
                <button
                  type="button"
                  onClick={switchMockRole}
                  className="cursor-pointer text-[12px] text-slate-300 underline underline-offset-2 hover:text-white"
                >
                  Switch to {me?.user.role === "owner" ? "Coach" : "Owner"} view (mock)
                </button>
              ) : (
                <Link href="/profile" className="text-[12px] text-slate-300 underline underline-offset-2 hover:text-white">
                  My account
                </Link>
              )}
            </div>
            <button
              type="button"
              onClick={onSignOut}
              aria-label="Sign out"
              title="Sign out"
              className="touch44 flex h-11 w-11 cursor-pointer items-center justify-center rounded-lg text-slate-300 hover:bg-white/10 hover:text-white"
            >
              <LogOut className="h-5 w-5" aria-hidden="true" />
            </button>
          </div>
          <div className="mt-3 flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-[12px]">
            <span aria-hidden="true" className="h-2 w-2 rounded-full bg-amber-400" />
            <span className="text-slate-200">OpenWA: awaiting QR scan (mock)</span>
          </div>
        </div>
      </aside>

      {/* Topbar */}
      <header className="lg:pl-[248px]">
        <div className="sticky top-0 z-30 border-b border-slate-200 bg-white/95 backdrop-blur">
          <div className="mx-auto flex h-16 max-w-7xl items-center gap-3 px-4 sm:px-6">
            <div
              aria-hidden="true"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-navy-900 lg:hidden"
            >
              <Trophy className="h-5 w-5 text-white" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[15px] font-semibold text-slate-900 sm:text-base">
                {me?.academy.name ?? "Inspire Academy"}
              </p>
              <p className="truncate text-[12px] text-slate-600">
                {me?.academy.timezone ?? "Asia/Colombo"} ·{" "}
                {mocksOn ? "mock data" : "live"}
              </p>
            </div>
            <span className="touch44 hidden h-11 items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 text-[13px] font-semibold sm:inline-flex">
              <ShieldCheck className="h-4 w-4 text-pitch-600" aria-hidden="true" />
              {me?.user.role === "owner" ? "Owner" : me?.user.role === "coach" ? "Coach" : "…"}
            </span>
          </div>
        </div>

        {/* WhatsApp banner (mock disconnected state) */}
        <div className="mx-auto max-w-7xl px-4 pt-4 sm:px-6" role="alert">
          <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-[14px] text-amber-900">
            <MessageCircle className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
            <p>
              <strong>WhatsApp needs attention (mock):</strong> session shows{" "}
              <em>awaiting_qr</em>. Reminders stay queued until you reconnect (OpenWA status strings are unverified — spike S1).{" "}
              {(!me || canAccess(permissions, "/whatsapp")) ? (
                <Link href="/whatsapp" className="font-semibold underline underline-offset-2">
                  Open WhatsApp status
                </Link>
              ) : (
                "Ask an owner to reconnect."
              )}
            </p>
          </div>
        </div>

        <main
          id="main"
          tabIndex={-1}
          className="mx-auto max-w-7xl px-4 pb-28 pt-5 sm:px-6 lg:pb-12"
        >
          {children}
        </main>
      </header>

      {/* Mobile bottom tab bar */}
      <nav
        aria-label="Mobile"
        className="fixed inset-x-0 bottom-0 z-20 border-t border-slate-200 bg-white pb-[env(safe-area-inset-bottom)] lg:hidden"
      >
        <div className="grid grid-cols-5">
          {tabs.slice(0, 4).map((item) => {
            const active = pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`touch44 flex min-h-[56px] flex-col items-center justify-center gap-1 text-[11px] font-semibold ${
                  active ? "text-pitch-700" : "text-slate-600"
                }`}
              >
                <item.icon className="h-5 w-5" aria-hidden="true" />
                {item.label === "Dashboard" && me?.user.role === "coach" ? "Today" : item.label}
              </Link>
            );
          })}
          <button
            type="button"
            onClick={() => setMoreOpen(true)}
            className="touch44 flex min-h-[56px] cursor-pointer flex-col items-center justify-center gap-1 text-[11px] font-semibold text-slate-600"
            aria-haspopup="dialog"
          >
            <Layers className="h-5 w-5" aria-hidden="true" />
            More
          </button>
        </div>
      </nav>

      {/* More sheet */}
      {moreOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="More sections"
          className="fixed inset-0 z-50 lg:hidden"
        >
          <div
            className="absolute inset-0 bg-navy-900/50"
            onClick={() => setMoreOpen(false)}
            aria-hidden="true"
          />
          <div className="absolute inset-x-0 bottom-0 max-h-[75dvh] overflow-y-auto rounded-t-2xl bg-white p-4 pb-[env(safe-area-inset-bottom)]">
            <div aria-hidden="true" className="mx-auto mb-3 h-1 w-10 rounded-full bg-slate-300" />
            <div className="grid grid-cols-3 gap-2">
              {nav.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setMoreOpen(false)}
                  className="touch44 flex min-h-[56px] flex-col items-center justify-center gap-1 rounded-xl border border-slate-200 text-[12px] font-semibold text-slate-700"
                >
                  <item.icon className="h-5 w-5" aria-hidden="true" />
                  {item.label}
                </Link>
              ))}
              <button
                type="button"
                onClick={onSignOut}
                className="touch44 flex min-h-[56px] cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border border-slate-200 text-[12px] font-semibold text-slate-700"
              >
                <LogOut className="h-5 w-5" aria-hidden="true" />
                Sign out
              </button>
            </div>
            <button
              type="button"
              onClick={() => setMoreOpen(false)}
              className="touch44 mt-3 h-12 w-full cursor-pointer rounded-xl border border-slate-200 font-semibold"
            >
              Close
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
