/**
 * Postgres → contract error mapping.
 *
 * The database is the last line of defence, so its refusals must surface as the
 * documented codes rather than a 500. This is deliberately conservative: an error we do
 * not recognise stays a 500 and is logged with the request id, because guessing a code
 * would tell the caller something we have not verified.
 */
import { ApiError, errors } from "../errors.js";

interface PgError {
  code?: string;
  message?: string;
  constraint?: string;
  detail?: string;
}

export function isPgError(err: unknown): err is PgError {
  return typeof err === "object" && err !== null && typeof (err as PgError).code === "string";
}

/** Unique-violation constraint names we can name honestly in a response. */
const UNIQUE_CONSTRAINTS: Record<string, () => ApiError> = {
  users_username_key: () =>
    errors.validation([{ field: "username", issue: "That username is already taken." }]),
  // One live payment per (method, reference). Two bank transfers quoting the same slip
  // number is how a receipt gets used twice, so this is a domain conflict rather than a
  // generic "already in use" (PAY-02/PAY-03.update, BILLING_ENGINE §11).
  payments_reference_uq: () =>
    new ApiError(
      "PAYMENT_DUPLICATE_REFERENCE",
      "Another pending or confirmed payment already uses that reference.",
    ),
};

export function mapPgError(err: unknown): never {
  if (!isPgError(err)) throw err;

  switch (err.code) {
    case "23505": {
      // unique_violation
      const mapped = err.constraint ? UNIQUE_CONSTRAINTS[err.constraint] : undefined;
      if (mapped) throw mapped();
      throw errors.validation([{ issue: "That value is already in use." }]);
    }
    case "23514": {
      // check_violation — the deferred owner invariant raises with LAST_OWNER in its text.
      if (err.message?.includes("LAST_OWNER")) throw errors.lastOwner();
      throw errors.validation([{ issue: "That value is not allowed." }]);
    }
    case "23503":
      // foreign_key_violation: the referenced row does not exist (or is out of scope).
      throw errors.notFound();
    case "23502":
      throw errors.validation([{ issue: "A required value is missing." }]);
    case "40001":
    case "40P01":
      // Serialization failure / deadlock: the caller should retry. Handled by the
      // service layer in M5 (T1–T10) with up to 3 attempts; here it is honest.
      throw new ApiError("DEPENDENCY_UNAVAILABLE", "The request conflicted. Please retry.");
    default:
      throw err;
  }
}
