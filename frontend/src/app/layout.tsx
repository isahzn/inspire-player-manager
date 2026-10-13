import type { Metadata, Viewport } from "next";
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
          <AppShell>{children}</AppShell>
        </Providers>
      </body>
    </html>
  );
}
