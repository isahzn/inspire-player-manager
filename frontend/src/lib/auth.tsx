"use client";

// Auth state per docs/frontend/API_INTEGRATION.md §2.
// Me + CSRF token live in memory only (never localStorage). Window-focus
// re-fetch (throttled 60 s) detects disabled users / role changes.
// SESSION_EXPIRED mid-action → re-login modal, draft preserved, retry after.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ApiError,
  auth01Login,
  auth02Logout,
  auth03Me,
  setCsrfToken,
} from "@/api/client";
import type { Me } from "@/api/types";

type Status = "loading" | "authenticated" | "unauthenticated";

interface AuthCtx {
  me: Me | null;
  status: Status;
  sessionExpired: boolean;
  login: (input: {
    username: string;
    password: string;
    totpCode?: string;
  }) => Promise<void>;
  logout: () => Promise<void>;
  resolveReLogin: (password: string) => Promise<void>;
  dismissReLogin: () => void;
  /** mock-mode only: re-login as the other demo user to demo role guards */
  switchMockRole: () => Promise<void>;
}

const Ctx = createContext<AuthCtx | null>(null);
const MOCKS_ON = process.env.NEXT_PUBLIC_USE_MOCKS === "true";

export function useAuth(): AuthCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [sessionExpired, setSessionExpired] = useState(false);
  const lastFocusFetch = useRef(0);
  const channel = useRef<BroadcastChannel | null>(null);

  const applyMe = useCallback((next: Me) => {
    setMe(next);
    setCsrfToken(next.csrfToken);
    setStatus("authenticated");
    setSessionExpired(false);
  }, []);

  const clearState = useCallback(() => {
    setMe(null);
    setCsrfToken(null);
    setStatus("unauthenticated");
    // Clear drafts that may contain PII (§2: logout clears local drafts),
    // plus the mock-mode session store (real backend clears via cookie).
    localStorage.removeItem("ia_mock_role");
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key?.startsWith("ia-attendance-draft:")) localStorage.removeItem(key);
    }
  }, []);

  // App start: GET /auth/me. 401 means logged out; anything else (worker
  // still warming up, offline) is retried once before giving up — a network
  // failure must never be mistaken for "logged out" (§3 error map).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const fresh = await auth03Me();
          if (!cancelled) applyMe(fresh);
          return;
        } catch (err) {
          const loggedOut = err instanceof ApiError && err.status === 401;
          if (loggedOut || attempt === 1) {
            if (!cancelled) setStatus("unauthenticated");
            return;
          }
          await new Promise((r) => setTimeout(r, 800));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [applyMe]);

  // Multi-tab: broadcast logout.
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    channel.current = new BroadcastChannel("ia-auth");
    channel.current.onmessage = (e) => {
      if (e.data === "logout") clearState();
    };
    return () => channel.current?.close();
  }, [clearState]);

  // Window focus: re-fetch AUTH-03 throttled to 60 s.
  useEffect(() => {
    const onFocus = async () => {
      if (status !== "authenticated") return;
      const now = Date.now();
      if (now - lastFocusFetch.current < 60_000) return;
      lastFocusFetch.current = now;
      try {
        const fresh = await auth03Me();
        applyMe(fresh);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) clearState();
      }
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [status, applyMe, clearState]);

  const login = useCallback(
    async (input: { username: string; password: string; totpCode?: string }) => {
      const next = await auth01Login(input);
      applyMe(next);
    },
    [applyMe]
  );

  const logout = useCallback(async () => {
    try {
      await auth02Logout();
    } catch {
      // Server logout failing must not trap the user signed in.
    }
    clearState();
    channel.current?.postMessage("logout");
  }, [clearState]);

  /** Re-login from the SESSION_EXPIRED modal, then the caller retries. */
  const resolveReLogin = useCallback(
    async (password: string) => {
      if (!me) return;
      const next = await auth01Login({ username: me.user.username, password });
      applyMe(next);
    },
    [me, applyMe]
  );

  const dismissReLogin = useCallback(() => {
    setSessionExpired(false);
    clearState();
  }, [clearState]);

  const switchMockRole = useCallback(async () => {
    if (!MOCKS_ON || !me) return;
    // Re-login through the mock endpoint so the session cookie and the
    // in-memory Me stay consistent across reloads.
    const other = me.user.role === "owner" ? "coach" : "owner";
    const next = await auth01Login({
      username: other,
      password: "mock",
    });
    applyMe(next);
  }, [me, applyMe]);

  // Surface server-driven session expiry to the modal.
  useEffect(() => {
    (window as unknown as { __iaSessionExpired?: () => void }).__iaSessionExpired =
      () => {
        if (status === "authenticated") setSessionExpired(true);
        else clearState();
      };
  }, [status, clearState]);

  const value = useMemo<AuthCtx>(
    () => ({
      me,
      status,
      sessionExpired,
      login,
      logout,
      resolveReLogin,
      dismissReLogin,
      switchMockRole,
    }),
    [me, status, sessionExpired, login, logout, resolveReLogin, dismissReLogin, switchMockRole]
  );

  return (
    <Ctx.Provider value={value}>
      {children}
      {sessionExpired && me ? <ReLoginModal /> : null}
    </Ctx.Provider>
  );
}

function ReLoginModal() {
  const { me, resolveReLogin, dismissReLogin } = useAuth();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      await resolveReLogin(password);
    } catch {
      setError("Username or password is incorrect.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Session expired — sign in again"
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
    >
      <div className="absolute inset-0 bg-navy-900/55" aria-hidden="true" />
      <div className="relative w-full max-w-sm rounded-2xl bg-white p-6 shadow-pop">
        <h2 className="font-heading text-[17px] font-semibold">Session expired</h2>
        <p className="mt-1 text-[14px] text-slate-600">
          Your work is preserved. Sign in again as {me?.user.username} to continue —
          the failed action is retried with the same idempotency key.
        </p>
        <form onSubmit={onSubmit} className="mt-4 space-y-3">
          <div>
            <label htmlFor="relogin-password" className="mb-1 block text-[14px] font-semibold">
              Password
            </label>
            <input
              id="relogin-password"
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="touch44 h-12 w-full rounded-xl border border-slate-300 px-3 text-[16px]"
            />
          </div>
          {error ? (
            <p role="alert" className="rounded-xl bg-red-50 px-3 py-2 text-[14px] font-medium text-red-700">
              {error}
            </p>
          ) : null}
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={dismissReLogin}
              className="touch44 h-12 cursor-pointer rounded-xl border border-slate-200 font-semibold"
            >
              Sign out
            </button>
            <button
              type="submit"
              disabled={pending}
              className="touch44 h-12 cursor-pointer rounded-xl bg-pitch-600 font-semibold text-white hover:bg-pitch-700 disabled:opacity-60"
            >
              {pending ? "Signing in…" : "Continue"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/** Global hook for apiClient 401s: modal when mid-session, else redirect. */
export function reportSessionExpired() {
  (window as unknown as { __iaSessionExpired?: () => void }).__iaSessionExpired?.();
}
