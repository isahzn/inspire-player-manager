/**
 * `Idempotency-Key` handling for the mutating endpoints the contract marks idempotent
 * (FEE-02, IMP-02; the money endpoints in M5 use the same helper).
 *
 * The guarantee: **the same key returns the same response.** A retry after a lost reply
 * must not create a second fee row or a second import batch, so the outcome of the first
 * attempt — success *or* a documented 4xx — is stored and replayed verbatim. Only a key
 * reused with a *different* request is refused (422 `IDEMPOTENCY_KEY_REUSED`).
 *
 * The record lives in its own transaction from the handler's own work: a failed handler
 * must still leave the record behind, otherwise a retry would run the work again.
 */
import { createHash } from "node:crypto";
import type { Viewer } from "./context.js";
import { ApiError } from "../errors.js";
import { withTransaction } from "../db/pool.js";
import type { Handler, HandlerResult } from "./router.js";

interface StoredRow {
  state: "in_progress" | "completed";
  request_hash: string;
  response_status: number | null;
  response_body: unknown;
}

const MIN_KEY_LENGTH = 8;
const MAX_KEY_LENGTH = 128;

/** Wraps a handler so it runs at most once per (user, Idempotency-Key). */
export function withIdempotency(handler: Handler): Handler {
  return async (args): Promise<HandlerResult> => {
    const raw = args.req.headers["idempotency-key"];
    const key = typeof raw === "string" ? raw.trim() : "";
    if (key.length < MIN_KEY_LENGTH || key.length > MAX_KEY_LENGTH) {
      throw new ApiError(
        "IDEMPOTENCY_KEY_REQUIRED",
        `Idempotency-Key header is required (${MIN_KEY_LENGTH}–${MAX_KEY_LENGTH} characters).`,
      );
    }

    const { viewer, ctx } = args;
    const requestHash = createHash("sha256")
      .update(
        JSON.stringify({
          method: args.req.method,
          url: args.req.url,
          body: args.body ?? null,
        }),
      )
      .digest("hex");

    const existing = await inViewer(viewer, async (client) => {
      const inserted = await client.query(
        `insert into idempotency_keys
           (user_id, key, method, path, request_hash, state, created_at, expires_at)
         values ($1, $2, $3, $4, $5, 'in_progress', now(), now() + interval '72 hours')
         on conflict (user_id, key) do nothing`,
        [viewer.userId, key, args.req.method, args.req.url, requestHash],
      );
      if (inserted.rowCount === 1) return null;
      const found = await client.query<StoredRow>(
        `select state, request_hash, response_status, response_body
           from idempotency_keys
          where user_id = $1 and key = $2`,
        [viewer.userId, key],
      );
      return found.rows[0] ?? null;
    });

    if (existing) {
      if (existing.request_hash !== requestHash) {
        throw new ApiError(
          "IDEMPOTENCY_KEY_REUSED",
          "That Idempotency-Key was already used with a different request.",
        );
      }
      if (existing.state === "completed") {
        return {
          status: existing.response_status ?? 200,
          body: replayBody(existing.response_body, ctx.requestId),
          headers: { "Idempotent-Replay": "true" },
        };
      }
      // A concurrent request holds the key (the first attempt has not finished).
      throw new ApiError(
        "INVALID_STATE_TRANSITION",
        "The same request is still being processed. Wait a moment and retry.",
      );
    }

    try {
      const result = await handler(args);
      await store(viewer, key, result.status ?? 200, result.body ?? null);
      return result;
    } catch (err) {
      // Store the documented failure so the retry is deterministic, then rethrow.
      const status = err instanceof ApiError ? err.status : 500;
      const body =
        err instanceof ApiError
          ? {
              error: {
                code: err.code,
                message: err.message,
                ...(err.details ? { details: err.details } : {}),
                requestId: ctx.requestId,
              },
            }
          : { error: { code: "INTERNAL_ERROR", message: "Something went wrong.", requestId: ctx.requestId } };
      await store(viewer, key, status, body).catch(() => undefined);
      throw err;
    }
  };
}

function inViewer<T>(viewer: Viewer, fn: Parameters<typeof withTransaction<T>>[1]): Promise<T> {
  return withTransaction({ userId: viewer.userId, role: viewer.role }, fn);
}

async function store(viewer: Viewer, key: string, status: number, body: unknown): Promise<void> {
  await inViewer(viewer, async (client) => {
    await client.query(
      `update idempotency_keys
          set state = 'completed', response_status = $3, response_body = $4::jsonb
        where user_id = $1 and key = $2`,
      [viewer.userId, key, status, body === null || body === undefined ? null : JSON.stringify(body)],
    );
  });
}

/** Deep-copies a stored body and refreshes the request id so it matches this response. */
function replayBody(stored: unknown, requestId: string): unknown {
  if (stored === null || stored === undefined) return undefined;
  const clone = JSON.parse(JSON.stringify(stored)) as unknown;
  if (clone && typeof clone === "object" && "error" in clone) {
    const error = (clone as { error?: { requestId?: string } }).error;
    if (error && typeof error === "object") error.requestId = requestId;
  }
  return clone;
}
