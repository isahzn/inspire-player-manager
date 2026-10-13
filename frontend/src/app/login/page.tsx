"use client";

// Login per PAGE_SPEC §1: username + password; totpCode shown ONLY after the
// server says TOTP required. Never reveals which field is wrong.
// Username is the login identifier (ADR-018) — there is no email credential.
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { Trophy } from "lucide-react";
import { ApiError } from "@/api/client";
import { useAuth } from "@/lib/auth";
import { safeNext } from "@/lib/permissions";

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { login, status } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [needTotp, setNeedTotp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      await login({ username, password, totpCode: needTotp ? totpCode : undefined });
      router.replace(safeNext(searchParams.get("next")));
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === "TOTP_REQUIRED") {
          setNeedTotp(true);
          setError("Enter the 6-digit code from your authenticator app.");
        } else if (err.code === "ACCOUNT_LOCKED") {
          setError("Too many attempts. Try again in 15 minutes.");
        } else if (err.code === "RATE_LIMITED") {
          setError("Too many requests — try again shortly.");
        } else if (err.code === "NETWORK_ERROR" || err.code === "TIMEOUT") {
          setError("Can't reach the server. Retry — nothing was submitted twice.");
        } else {
          setError("Username or password is incorrect.");
        }
      } else {
        setError("Can't reach the server. Retry — nothing was submitted twice.");
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-4 py-10">
      <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-card">
        <div className="flex items-center gap-3">
          <div
            aria-hidden="true"
            className="flex h-11 w-11 items-center justify-center rounded-xl bg-navy-900"
          >
            <Trophy className="h-6 w-6 text-white" />
          </div>
          <div>
            <h1 className="font-heading text-lg font-bold">Inspire Academy</h1>
            <p className="text-[13px] text-slate-600">Sign in to continue</p>
          </div>
        </div>

        <form onSubmit={onSubmit} className="mt-6 space-y-4">
          <div>
            <label htmlFor="username" className="mb-1 block text-[14px] font-semibold">
              Username
            </label>
            <input
              id="username"
              name="username"
              type="text"
              required
              minLength={3}
              maxLength={32}
              // The hyphen must be escaped: with the modern `v` flag an unescaped
              // `-` is an invalid class character, so the browser logged a syntax
              // error and silently ignored the pattern (it never validated).
              pattern="[A-Za-z0-9._\-]+"
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="touch44 h-12 w-full rounded-xl border border-slate-300 bg-white px-3 text-[16px]"
              aria-describedby={error ? "login-error" : undefined}
            />
          </div>
          <div>
            <label htmlFor="password" className="mb-1 block text-[14px] font-semibold">
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="touch44 h-12 w-full rounded-xl border border-slate-300 bg-white px-3 text-[16px]"
            />
          </div>
          {needTotp ? (
            <div>
              <label htmlFor="totp" className="mb-1 block text-[14px] font-semibold">
                Authenticator code
              </label>
              <input
                id="totp"
                name="totp"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                required
                minLength={6}
                maxLength={6}
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value)}
                className="touch44 h-12 w-full rounded-xl border border-slate-300 bg-white px-3 text-[16px]"
              />
            </div>
          ) : null}

          {error ? (
            <p id="login-error" role="alert" className="rounded-xl bg-red-50 px-3 py-2 text-[14px] font-medium text-red-700">
              {error}
            </p>
          ) : null}

          <button
            type="submit"
            disabled={pending || status === "loading"}
            className="touch44 h-12 w-full cursor-pointer rounded-xl bg-pitch-600 font-semibold text-white hover:bg-pitch-700 disabled:opacity-60"
          >
            {pending ? "Signing in…" : "Sign in"}
          </button>
        </form>

        {process.env.NEXT_PUBLIC_USE_MOCKS === "true" ? (
          <p className="mt-4 text-[13px] text-slate-600">
            Mock accounts: <code>owner</code> · <code>coach</code> ·{" "}
            <code>totp</code> (asks for code) · <code>locked</code> (locked). Any password
            works. Invite token: <code>valid-invite-token</code>.
          </p>
        ) : null}
      </div>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
