import type { Metadata, Viewport } from "next";
import { Suspense } from "react";
import { AppShell } from "@/components/AppShell";
import { Providers } from "./providers";
import "./globals.css";

// Fonts: system stack (Poppins/Inter names first, graceful fallback offline).
// Self-host via next/font/local once brand fonts are final (OPEN-001).
// globals.css already maps --font-heading/--font-body accordingly.

export const metadata: Metadata = {
  title: "Inspire Academy — Management System",
  description:
    "Players, attendance, billing, payments and WhatsApp reminders for Inspire Academy.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

/**
 * Shown while the shell streams in, and used as the Suspense fallback below. Deliberately plain:
 * it is on screen for a moment on a cold load and needs no layout of its own.
 */
function AppLoading() {
  return (
    <div className="grid min-h-screen place-items-center p-6">
      <p role="status" className="text-[14px] text-slate-500">
        Loading…
      </p>
    </div>
  );
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="h-full">
      <body className="min-h-full antialiased">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-white focus:px-4 focus:py-2 focus:font-semibold"
        >
          Skip to content
        </a>
        <Providers>
          {/*
            The shell reads `usePathname()`/`useRouter()` to pick the navigation and highlight the
            current page, and the pages inside it read `useParams()`. With `cacheComponents` on
            (next.config.ts) a client component that touches those hooks while a page is being
            prerendered has to sit inside a Suspense boundary — otherwise `next build` aborts the
            whole export with `CLIENT_HOOK_DYNAMIC`, which is exactly what it did the first time
            this app was ever built with `NEXT_PUBLIC_USE_MOCKS=false`.

            That is why it was not caught earlier, and it is worth knowing: in mock mode
            `Providers` renders `null` until the MSW worker has started, so prerendering never
            reached the shell and the hooks were never called. Every build until this deployment
            ran in mock mode.
          */}
          <Suspense fallback={<AppLoading />}>
            <AppShell>{children}</AppShell>
          </Suspense>
        </Providers>
      </body>
    </html>
  );
}
