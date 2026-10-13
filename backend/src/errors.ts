/**
 * Domain errors and the contract error envelope (API_CONTRACTS §1.1).
 *
 * Every non-2xx response body is `{ error: { code, message, details?, requestId } }`.
 * Errors carry no stack traces, SQL or file paths (T-SEC-05) and unknown failures are
 * reported as a generic INTERNAL_ERROR, logged server-side with the request id.
 */
import { ERROR_STATUS, type ErrorCode } from "../spec/registry.js";

export interface ErrorDetail {
  field?: string;
  issue: string;
  meta?: Record<string, unknown>;
}

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: ErrorDetail[];
  /**
   * Response headers the error itself requires.
   *
   * INV-06 is why this exists: the contract pairs `409 PDF_NOT_READY` with a `Retry-After`, and
   * a client that is told to come back has to be told *when*. Carrying the header on the error
   * keeps it next to the reason for it, rather than making each caller re-implement the pair.
   */
  readonly headers?: Record<string, string>;

  constructor(
    code: ErrorCode,
    message?: string,
    details?: ErrorDetail[],
    headers?: Record<string, string>,
  ) {
    super(message ?? DEFAULT_MESSAGES[code] ?? code);
    this.name = "ApiError";
    this.code = code;
    this.status = ERROR_STATUS[code];
    this.details = details;
    this.headers = headers;
  }
}

/** Safe, human-readable defaults; nothing here leaks internals. */
const DEFAULT_MESSAGES: Partial<Record<ErrorCode, string>> = {
  UNAUTHENTICATED: "Sign in to continue.",
  INVALID_CREDENTIALS: "Username or password is incorrect.",
  SESSION_EXPIRED: "Your session has expired. Sign in again.",
  FORBIDDEN: "You do not have access to this.",
  CSRF_FAILED: "Your session token is stale. Reload and try again.",
  ACCOUNT_DISABLED: "This account is disabled.",
  ACCOUNT_LOCKED: "Too many failed attempts. Try again later.",
  NOT_FOUND: "Not found.",
  VALIDATION_ERROR: "Some fields need attention.",
  RATE_LIMITED: "Too many requests. Please slow down.",
  INTERNAL_ERROR: "Something went wrong.",
  LAST_OWNER: "The last active owner cannot be removed.",
  VERSION_CONFLICT: "This record changed since you loaded it.",
  INVALID_STATE_TRANSITION: "That action is not allowed from the current state.",
  IDEMPOTENCY_KEY_REQUIRED: "Idempotency-Key header is required.",
  IDEMPOTENCY_KEY_REUSED: "That Idempotency-Key was already used with a different request.",
  INVALID_SORT: "Unknown sort field.",
  MALFORMED_JSON: "Malformed JSON body.",
  DEPENDENCY_UNAVAILABLE: "A dependency is unavailable. Try again shortly.",
  PDF_NOT_READY: "The document is still being prepared. Try again in a moment.",
  FILE_TOO_LARGE: "That file is too large.",
  UNSUPPORTED_FILE_TYPE: "That file type is not supported.",
};

/** Convenience constructors for the codes used across the M2 surface. */
export const errors = {
  unauthenticated: () => new ApiError("UNAUTHENTICATED"),
  invalidCredentials: () => new ApiError("INVALID_CREDENTIALS"),
  sessionExpired: () => new ApiError("SESSION_EXPIRED"),
  forbidden: (message?: string) => new ApiError("FORBIDDEN", message),
  csrf: () => new ApiError("CSRF_FAILED"),
  notFound: () => new ApiError("NOT_FOUND"),
  accountDisabled: () => new ApiError("ACCOUNT_DISABLED"),
  accountLocked: () => new ApiError("ACCOUNT_LOCKED"),
  lastOwner: () => new ApiError("LAST_OWNER"),
  validation: (details: ErrorDetail[]) => new ApiError("VALIDATION_ERROR", undefined, details),
  versionConflict: () => new ApiError("VERSION_CONFLICT"),
};
