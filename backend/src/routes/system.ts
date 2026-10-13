/**
 * SYS-01 liveness and SYS-02 readiness.
 *
 * Liveness reveals nothing (it must not become an unauthenticated status endpoint);
 * readiness proves the database is reachable so a load balancer can take the instance
 * out of rotation (T-OPS-03). Details live in SYS-03, owner-only, in M8.
 */
import { pool } from "../db/pool.js";
import type { Handler, HandlerResult } from "../http/router.js";
import { ApiError } from "../errors.js";

export const sys01: Handler = async (): Promise<HandlerResult> => ({
  status: 200,
  body: { status: "ok" },
});

export const sys02: Handler = async (): Promise<HandlerResult> => {
  try {
    await pool.query("select 1");
    return { status: 200 };
  } catch {
    // Contract: 503 DEPENDENCY_UNAVAILABLE ("the database is not reachable").
    throw new ApiError("DEPENDENCY_UNAVAILABLE", "The database is not reachable.");
  }
};
