"use client";

// Mock session helpers, shared by the auth handlers and the people handlers.
// The store of record is localStorage `ia_mock_role` (origin-scoped, survives
// reloads) because MSW page-thread resolvers cannot read the Cookie header.
// Production uses HttpOnly cookies (ADR-004).
import { HttpResponse } from "msw";

export type MockRole = "owner" | "coach";

const STORE_KEY = "ia_mock_role";

export function roleFromStore(): MockRole | null {
  try {
    const v = localStorage.getItem(STORE_KEY);
    return v === "owner" || v === "coach" ? v : null;
  } catch {
    return null;
  }
}

export function writeRoleStore(role: MockRole | null) {
  try {
    if (role) localStorage.setItem(STORE_KEY, role);
    else localStorage.removeItem(STORE_KEY);
  } catch {
    // Private-mode storage failure: session lasts until reload.
  }
}

export function sessionCookie(role: MockRole): string {
  return `ia_mock_role=${role}; Path=/; SameSite=Lax`;
}

export function clearSessionCookie(): string {
  return "ia_mock_role=; Path=/; Max-Age=0; SameSite=Lax";
}

/** Error envelope per API_CONTRACTS §1.1. */
export function err(code: string, message: string, status: number, details?: unknown[]) {
  return HttpResponse.json(
    { error: { code, message, details, requestId: "req_mock01" } },
    { status }
  );
}
