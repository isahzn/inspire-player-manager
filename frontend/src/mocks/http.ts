"use client";

// Shared MSW plumbing for every mock slice: the auth/scope guards, the error
// envelope, and `Idempotency-Key` replay. One implementation on purpose — a
// second copy is how the slices drift apart.
import { COACH_ID, MockError, OWNER_ID } from "./db";
import { err, roleFromStore, type MockRole } from "./session";

export interface Ctx {
  request: Request;
  // Mirrors MSW's PathParams (a param may be absent or a repeat).
  params: Record<string, string | readonly string[] | undefined>;
}

export type Handler = (ctx: Ctx) => Promise<Response> | Response;

export type Viewer = { role: MockRole; userId: string };

async function run(handler: Handler, ctx: Ctx): Promise<Response> {
  try {
    return await handler(ctx);
  } catch (error) {
    if (error instanceof MockError) {
      return err(error.code, error.message, error.status, error.details);
    }
    throw error;
  }
}

/** Owner-only route. Returns the 401/403 envelope before the handler runs. */
export function ownerOnly(handler: Handler): Handler {
  return async (ctx) => {
    const role = roleFromStore();
    if (!role) return err("UNAUTHENTICATED", "Sign in to continue.", 401);
    if (role !== "owner") return err("FORBIDDEN", "Owners only.", 403);
    return run(handler, ctx);
  };
}

/** Any signed-in user; the handler receives the viewer for scoping. */
export function authed(handler: (ctx: Ctx & { viewer: Viewer }) => Promise<Response> | Response): Handler {
  return async (ctx) => {
    const role = roleFromStore();
    if (!role) return err("UNAUTHENTICATED", "Sign in to continue.", 401);
    const viewer: Viewer = { role, userId: role === "owner" ? OWNER_ID : COACH_ID };
    return run((c) => handler({ ...c, viewer }), ctx);
  };
}

export async function json<T>(body: T, status = 200, extraHeaders?: Record<string, string>) {
  return Response.json(body as unknown as Record<string, unknown>, {
    status,
    headers: extraHeaders,
  });
}

export function jsonBody<T>(request: Request): Promise<T> {
  return request.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Idempotency (API_CONTRACTS §1): the header is REQUIRED on endpoints marked
// "Idem" (400 IDEMPOTENCY_KEY_REQUIRED), and a replay returns the original
// response plus `Idempotent-Replay: true`. The retention window is 72 h in the
// contract; the mock keeps results for the life of the page (a reload re-seeds
// the store anyway).
// ---------------------------------------------------------------------------
const replayStore = new Map<string, { status: number; body: unknown }>();

/** Dev helper: the E2E script clears replays between runs. */
export function resetIdempotency() {
  replayStore.clear();
}

export async function idempotent<T>(
  request: Request,
  produce: () => Promise<T> | T,
  opts: { status?: number } = {}
): Promise<Response> {
  const key = request.headers.get("Idempotency-Key");
  if (!key || key.trim().length === 0) {
    return err(
      "IDEMPOTENCY_KEY_REQUIRED",
      "This request needs an Idempotency-Key header.",
      400
    );
  }
  const seen = replayStore.get(key);
  if (seen) {
    return json(seen.body, seen.status, { "Idempotent-Replay": "true" });
  }
  const body = await produce();
  const status = opts.status ?? 200;
  replayStore.set(key, { status, body });
  return json(body, status);
}
