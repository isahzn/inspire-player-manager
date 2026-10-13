"use client";

// My account per PAGE_SPEC §1: change password, sessions list with
// "sign out other devices", TOTP enroll (secret + 6-digit confirm).
import { useEffect, useState } from "react";
import {
  ApiError,
  auth04ChangePassword,
  auth06ListSessions,
  auth06RevokeSession,
  auth07TotpConfirm,
  auth07TotpDisable,
  auth07TotpEnroll,
} from "@/api/client";
import type { AuthSession } from "@/api/types";
import { PageHeader } from "@/components/PageHeader";
import { RequireAuth } from "@/components/Guards";
import { useAuth } from "@/lib/auth";

function ProfileContent() {
  const { me, logout } = useAuth();
  const [sessions, setSessions] = useState<AuthSession[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [pwError, setPwError] = useState<string | null>(null);
  const [pwPending, setPwPending] = useState(false);

  const [secretUri, setSecretUri] = useState<string | null>(null);
  const [totpCode, setTotpCode] = useState("");
  const [totpMsg, setTotpMsg] = useState<string | null>(null);

  async function loadSessions() {
    try {
      const res = await auth06ListSessions();
      setSessions(res.data);
    } catch {
      setSessions([]);
    }
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await auth06ListSessions();
        if (!cancelled) setSessions(res.data);
      } catch {
        if (!cancelled) setSessions([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function onChangePassword(e: React.FormEvent) {
    e.preventDefault();
    setPwError(null);
    setPwPending(true);
    try {
      await auth04ChangePassword({ currentPassword, newPassword });
      setNotice("Password changed. Other devices were signed out.");
      setCurrentPassword("");
      setNewPassword("");
      loadSessions();
    } catch (err) {
      setPwError(
        err instanceof ApiError && err.code === "VALIDATION_ERROR"
          ? "Use at least 12 characters for the new password."
          : "Can't reach the server. Retry."
      );
    } finally {
      setPwPending(false);
    }
  }

  async function onRevoke(id: string) {
    await auth06RevokeSession(id);
    loadSessions();
  }

  async function onSignOutOthers() {
    for (const s of sessions) {
      if (!s.current) await auth06RevokeSession(s.id);
    }
    setNotice("Other devices were signed out.");
    loadSessions();
  }

  async function onEnrollTotp() {
    const res = await auth07TotpEnroll();
    setSecretUri(res.secretUri);
    setTotpMsg(null);
  }

  async function onConfirmTotp(e: React.FormEvent) {
    e.preventDefault();
    await auth07TotpConfirm(totpCode);
    setSecretUri(null);
    setTotpCode("");
    setTotpMsg("Two-factor authentication is on.");
  }

  async function onDisableTotp() {
    const password = window.prompt("Enter your password to turn off two-factor auth:");
    if (!password) return;
    await auth07TotpDisable(password);
    setTotpMsg("Two-factor authentication is off.");
  }

  return (
    <div>
      <PageHeader title="My account" sub={`${me?.user.fullName} · ${me?.user.username}`} />
      {notice ? (
        <p role="status" className="mb-4 rounded-xl bg-emerald-50 px-3 py-2 text-[14px] font-medium text-emerald-800">
          {notice}
        </p>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <section aria-label="Change password" className="rounded-2xl border border-slate-200 bg-white p-4 shadow-card">
          <h2 className="font-heading text-[16px] font-semibold">Change password</h2>
          <form onSubmit={onChangePassword} className="mt-3 space-y-3">
            <div>
              <label htmlFor="current-pw" className="mb-1 block text-[14px] font-semibold">Current password</label>
              <input id="current-pw" type="password" required autoComplete="current-password"
                value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)}
                className="touch44 h-12 w-full rounded-xl border border-slate-300 px-3 text-[16px]" />
            </div>
            <div>
              <label htmlFor="new-pw" className="mb-1 block text-[14px] font-semibold">New password</label>
              <input id="new-pw" type="password" required minLength={12} autoComplete="new-password"
                value={newPassword} onChange={(e) => setNewPassword(e.target.value)}
                className="touch44 h-12 w-full rounded-xl border border-slate-300 px-3 text-[16px]" />
              <p className="mt-1 text-[12px] text-slate-600">At least 12 characters.</p>
            </div>
            {pwError ? <p role="alert" className="rounded-xl bg-red-50 px-3 py-2 text-[14px] font-medium text-red-700">{pwError}</p> : null}
            <button type="submit" disabled={pwPending}
              className="touch44 h-12 w-full cursor-pointer rounded-xl bg-pitch-600 font-semibold text-white hover:bg-pitch-700 disabled:opacity-60">
              {pwPending ? "Saving…" : "Change password"}
            </button>
          </form>
        </section>

        <section aria-label="Sessions" className="rounded-2xl border border-slate-200 bg-white p-4 shadow-card">
          <div className="flex items-center justify-between">
            <h2 className="font-heading text-[16px] font-semibold">Sessions</h2>
            <button type="button" onClick={onSignOutOthers}
              className="touch44 inline-flex min-h-[44px] cursor-pointer items-center font-semibold text-pitch-700 underline underline-offset-2">
              Sign out other devices
            </button>
          </div>
          <ul className="mt-3 space-y-2 text-[14px]">
            {sessions.length === 0 ? (
              <li className="text-slate-600">No sessions found.</li>
            ) : sessions.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-3 rounded-xl border border-slate-100 px-3 py-2">
                <span>{s.userAgent ?? s.id}{s.current ? " · this device" : ` · last seen ${s.lastSeenAt}`}</span>
                {!s.current ? (
                  <button type="button" onClick={() => onRevoke(s.id)}
                    className="touch44 inline-flex min-h-[44px] cursor-pointer items-center font-semibold text-red-700 underline underline-offset-2">
                    Revoke
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
          <button type="button" onClick={logout}
            className="touch44 mt-3 h-12 w-full cursor-pointer rounded-xl border border-slate-200 font-semibold">
            Sign out this device
          </button>
        </section>

        <section aria-label="Two-factor authentication" className="rounded-2xl border border-slate-200 bg-white p-4 shadow-card">
          <h2 className="font-heading text-[16px] font-semibold">Two-factor authentication</h2>
          <p className="mt-1 text-[14px] text-slate-600">
            Status: {me?.user.totpEnabled || totpMsg?.includes("is on") ? "on" : "off"}.
          </p>
          {totpMsg ? <p role="status" className="mt-2 text-[14px] font-medium text-emerald-800">{totpMsg}</p> : null}
          {secretUri ? (
            <form onSubmit={onConfirmTotp} className="mt-3 space-y-3">
              <p className="break-all rounded-xl bg-slate-100 px-3 py-2 text-[12px]">{secretUri}</p>
              <div>
                <label htmlFor="totp-confirm" className="mb-1 block text-[14px] font-semibold">6-digit code</label>
                <input id="totp-confirm" type="text" inputMode="numeric" required minLength={6} maxLength={6}
                  autoComplete="one-time-code" value={totpCode} onChange={(e) => setTotpCode(e.target.value)}
                  className="touch44 h-12 w-full rounded-xl border border-slate-300 px-3 text-[16px]" />
              </div>
              <button type="submit" className="touch44 h-12 w-full cursor-pointer rounded-xl bg-pitch-600 font-semibold text-white hover:bg-pitch-700">
                Confirm
              </button>
            </form>
          ) : (
            <div className="mt-3 flex gap-2">
              <button type="button" onClick={onEnrollTotp}
                className="touch44 h-12 flex-1 cursor-pointer rounded-xl bg-navy-900 font-semibold text-white">
                Set up authenticator
              </button>
              <button type="button" onClick={onDisableTotp}
                className="touch44 h-12 flex-1 cursor-pointer rounded-xl border border-slate-200 font-semibold">
                Turn off
              </button>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

export default function ProfilePage() {
  return (
    <RequireAuth>
      <ProfileContent />
    </RequireAuth>
  );
}
