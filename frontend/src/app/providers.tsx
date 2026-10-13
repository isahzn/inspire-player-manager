"use client";

// Client-side providers: MSW (mock mode), Auth, TanStack Query.
// Cache defaults per API_INTEGRATION §8: 30 s lists, 5 min reference data,
// dashboards refetch on focus, /auth/me handled by AuthProvider (60 s focus).
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { AuthProvider } from "@/lib/auth";

export function Providers({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(process.env.NEXT_PUBLIC_USE_MOCKS !== "true");
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: false },
        },
      })
  );

  useEffect(() => {
    // Dynamic import keeps msw/browser (node:null export condition) out of
    // the SSR module graph — the worker only ever starts on the client.
    if (process.env.NEXT_PUBLIC_USE_MOCKS !== "true") return;
    import("@/mocks/browser")
      .then((m) => m.startMocks())
      .finally(() => setReady(true));
  }, []);

  if (!ready) return null;
  return (
    <QueryClientProvider client={client}>
      <AuthProvider>{children}</AuthProvider>
    </QueryClientProvider>
  );
}
