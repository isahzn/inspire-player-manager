"use client";

// Accept invite per PAGE_SPEC §1: password ≥ 12 chars with strength meter,
// confirm match; invalid/expired token → "ask an owner for a new link".
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { Trophy } from "lucide-react";
import { ApiError, auth05AcceptInvite, setCsrfToken } from "@/api/client";

function strength(password: string): { label: string; width: string } {
  let score = 0;
  if (password.length >= 12) score += 1;
  if (password.length >= 16) score += 1;
  if (/[A-Z]/.test(password) && /[a-z]/.test(password)) score += 1;
  if (/\d/.test(password)) score += 1;
  if (/[^A-Za-z0-9]/.test(password)) score += 1;
  if (score <= 2) return { label: "Weak", width: "w-1/4" };
  if (score <= 3) return { label: "Fair", width: "w-2/4" };
  if (score <= 4) return { label: "Good", width: "w-3/4" };
  return { label: "Strong", width: "w-full" };
}

function AcceptInviteForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get("token") ?? "";
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const meter = strength(password);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    setPending(true);
    try {
      const me = await auth05AcceptInvite({ token, password });
      setCsrfToken(me.csrfToken);
      router.replace("/dashboard");
    } catch (err) {
      if (err instanceof ApiError && err.code === "INVITE_INVALID") {
        setError("This invite link is invalid or expired. Ask an owner for a new link.");
      } else if (err instanceof ApiError && err.code === "VALIDATION_ERROR") {
        setError("Use at least 12 characters and avoid common passwords.");
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
            <h1 className="font-heading text-lg font-bold">Set your password</h1>
            <p className="text-[13px] text-slate-600">Accept your Inspire Academy invite</p>
          </div>
        </div>

        {!token ? (
          <p role="alert" className="mt-6 rounded-xl bg-red-50 px-3 py-2 text-[14px] font-medium text-red-700">
            This invite link is invalid or expired. Ask an owner for a new link.
          </p>
        ) : (
          <form onSubmit={onSubmit} className="mt-6 space-y-4">
            <div>
              <label htmlFor="new-password" className="mb-1 block text-[14px] font-semibold">
                New password
              </label>
              <input
                id="new-password"
                type="password"
                required
                minLength={12}
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="touch44 h-12 w-full rounded-xl border border-slate-300 bg-white px-3 text-[16px]"
                aria-describedby="pw-strength"
              />
              <div id="pw-strength" className="mt-2 flex items-center gap-2" aria-live="polite">
                <div className="h-1.5 flex-1 rounded-full bg-slate-200">
                  <div className={`h-1.5 rounded-full bg-pitch-600 ${meter.width}`} />
                </div>
                <span className="text-[12px] font-semibold text-slate-600">{meter.label}</span>
              </div>
              <p className="mt-1 text-[12px] text-slate-600">At least 12 characters.</p>
            </div>
            <div>
              <label htmlFor="confirm-password" className="mb-1 block text-[14px] font-semibold">
                Confirm password
              </label>
              <input
                id="confirm-password"
                type="password"
                required
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                className="touch44 h-12 w-full rounded-xl border border-slate-300 bg-white px-3 text-[16px]"
              />
            </div>
            {error ? (
              <p role="alert" className="rounded-xl bg-red-50 px-3 py-2 text-[14px] font-medium text-red-700">
                {error}
              </p>
            ) : null}
            <button
              type="submit"
              disabled={pending}
              className="touch44 h-12 w-full cursor-pointer rounded-xl bg-pitch-600 font-semibold text-white hover:bg-pitch-700 disabled:opacity-60"
            >
              {pending ? "Setting password…" : "Set password"}
            </button>
          </form>
        )}
      </div>
    </main>
  );
}

export default function AcceptInvitePage() {
  return (
    <Suspense>
      <AcceptInviteForm />
    </Suspense>
  );
}
