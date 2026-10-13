/**
 * Contract registry — the single source of truth for every endpoint.
 *
 * Two consumers, deliberately:
 *  1. `scripts/generate-openapi.ts` emits `api/openapi.yaml` (OpenAPI 3.1), which
 *     ADR-009 makes authoritative once M1 exits.
 *  2. The server uses the very same entries as its **route registry**: id, permission,
 *     schemas, and whether a route is mutating/idempotent. A route with no declared
 *     permission fails CI (deny by default, T-AUTH-02), and a handler for an endpoint
 *     that is not in this registry cannot be registered.
 *
 * Every endpoint carries `milestone` — the milestone that owns its implementation —
 * which is emitted as the `x-ia-milestone` extension. Endpoints documented here but
 * owned by a later milestone are intentionally absent from the running server; the
 * extension is how the frontend can tell "documented" from "implemented" before M8.
 */
import { z, type ZodObject, type ZodType } from "zod";
import { extendZodWithOpenApi, OpenAPIRegistry, type ZodContentObject } from "@asteasolutions/zod-to-openapi";

extendZodWithOpenApi(z);

export { z };
export const registry = new OpenAPIRegistry();

// ---------------------------------------------------------------------------
// Error catalogue (API_CONTRACTS §1.1). The status is part of the contract, so it
// lives here rather than in each endpoint definition.
// ---------------------------------------------------------------------------
export const ERROR_STATUS = {
  IDEMPOTENCY_KEY_REQUIRED: 400,
  MALFORMED_JSON: 400,
  UNAUTHENTICATED: 401,
  INVALID_CREDENTIALS: 401,
  SESSION_EXPIRED: 401,
  FORBIDDEN: 403,
  CSRF_FAILED: 403,
  ACCOUNT_DISABLED: 403,
  ACCOUNT_LOCKED: 403,
  NOT_FOUND: 404,
  VERSION_CONFLICT: 409,
  DUPLICATE_SUSPECTED: 409,
  PREVIEW_STALE: 409,
  ALREADY_INVOICED: 409,
  ALLOCATION_EXCEEDS_BALANCE: 409,
  ALLOCATION_EXCEEDS_PAYMENT: 409,
  INVOICE_VOID: 409,
  INVOICE_HAS_ALLOCATIONS: 409,
  PAYMENT_NOT_CONFIRMED: 409,
  PAYMENT_DUPLICATE_REFERENCE: 409,
  INVALID_STATE_TRANSITION: 409,
  LAST_OWNER: 409,
  AGE_GROUP_HAS_ACTIVE_PLAYERS: 409,
  FEE_OVERLAP: 409,
  SESSION_DUPLICATE: 409,
  ALREADY_CHECKED_IN: 409,
  NO_OPEN_CHECK_IN: 409,
  MESSAGE_NOT_RETRYABLE: 409,
  PDF_NOT_READY: 409,
  FILE_TOO_LARGE: 413,
  UNSUPPORTED_FILE_TYPE: 415,
  VALIDATION_ERROR: 422,
  INVALID_SORT: 422,
  IDEMPOTENCY_KEY_REUSED: 422,
  PLAYER_NOT_ON_ROSTER: 422,
  ATTENDANCE_WINDOW_CLOSED: 422,
  CHECKIN_WINDOW_CLOSED: 422,
  REASON_REQUIRED: 422,
  RATE_LIMITED: 429,
  DEPENDENCY_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

// ---------------------------------------------------------------------------
// Auth levels and permissions (AUTH_AND_PERMISSIONS §4)
// ---------------------------------------------------------------------------
export type AuthLevel =
  /** No session: AUTH-01/05, SYS-01/02, PUB-01 (its own token) */
  | "public"
  /** Any authenticated user (own profile, sessions) */
  | "session"
  /** Owner only */
  | "owner"
  /** Coach (scoped to assigned groups); owners also allowed unless `ownerOnly` */
  | "coach_scoped"
  /** HMAC-verified provider webhook — not a role */
  | "webhook_hmac";

export const PERMISSIONS = [
  "users:manage",
  "settings:manage",
  "groups:manage",
  "groups:read",
  "fees:manage",
  "players:manage",
  "players:read",
  "players:read_restricted",
  "guardians:manage",
  "sessions:manage",
  "sessions:read",
  "attendance:mark",
  "attendance:correct_any",
  "coach_attendance:self",
  "coach_attendance:manage",
  "billing:manage",
  "payments:manage",
  "files:read_sensitive",
  "messaging:manage",
  "reports:read",
  "audit:read",
  "import:manage",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/** Milestone that owns the implementation of an endpoint (IMPLEMENTATION_PLAN §2). */
export type Milestone = "m2" | "m3" | "m4" | "m5" | "m6" | "m7" | "m8";

export interface EndpointResponse {
  status: number;
  /** Omit for bodiless responses (204, 202). */
  schema?: ZodType;
  description: string;
  contentType?: string;
  headers?: Record<string, { description: string; schema: ZodType }>;
}

export interface EndpointDef {
  /** Contract id, e.g. `AUTH-01`. Several operations may share one id (AUTH-06 lists two). */
  id: string;
  /**
   * Unique operationId when one contract row covers several operations
   * (`AUTH-06.list`, `AUTH-06.revoke`). Defaults to `id`.
   */
  operationId?: string;
  method: "get" | "post" | "put" | "patch" | "delete";
  /** Path below the base path, e.g. `/players/{id}`. */
  path: string;
  auth: AuthLevel;
  permission?: Permission;
  /** Human note on the scope guard (AUTH §5 step 4). */
  scope?: string;
  summary: string;
  description?: string;
  tags: string[];
  /** `Idempotency-Key` is required on this route (API_CONTRACTS §1). */
  idempotent?: boolean;
  /** Writes state; requires CSRF/Origin and an audit row. */
  mutating?: boolean;
  /** Audit action name written to `audit_logs`, e.g. `user.create`. */
  audit?: string;
  /** Rate-limit bucket override, e.g. `login`. */
  rateLimit?: string;
  params?: ZodObject;
  query?: ZodObject;
  /**
   * Request body. Mutating bodies are `z.strictObject` so unknown fields are rejected
   * (T-SEC-02, mass assignment); a union is allowed only where the contract itself
   * defines alternatives (GDN-03: existing guardian or a new one).
   */
  body?: ZodType;
  /** Request content type; defaults to application/json (uploads use multipart/form-data). */
  bodyContentType?: string;
  headers?: ZodObject;
  responses: EndpointResponse[];
  /** Error codes this endpoint can return, beyond the automatic ones. */
  errors?: ErrorCode[];
  milestone: Milestone;
}

/** A milestone's slice of the contract; one module per API_CONTRACTS §3 subsection. */
export interface Section {
  name: string;
  endpoints: EndpointDef[];
}

export function section(name: string, endpoints: EndpointDef[]): Section {
  return { name, endpoints };
}

const ERROR_REF: ZodContentObject = {
  "application/json": {
    schema: { $ref: "#/components/schemas/ApiError" },
  },
};

/**
 * Renders the standard error body for a code, reusing the registered `ApiError`
 * component rather than re-declaring the envelope on every operation.
 */
function errorResponse(code: ErrorCode): EndpointResponse {
  return {
    status: ERROR_STATUS[code],
    description: `${code} — see API_CONTRACTS §1.1.`,
    // Content is attached by the generator from ErrorResponses below.
  };
}

function securityFor(def: EndpointDef): Array<Record<string, string[]>> {
  switch (def.auth) {
    case "public":
      // Explicitly empty: "this operation requires no credentials". Leaving it
      // undefined would inherit the document's default and misdescribe PUB-01,
      // AUTH-01/05 and the health endpoints.
      return [];
    case "webhook_hmac":
      return [{ webhookSignature: [] }];
    default:
      return [{ sessionCookie: [] }];
  }
}

/**
 * Registers an endpoint in the shared registry. This is the *only* way an endpoint
 * may enter the contract: it applies the auth/permission/error conventions so a
 * section cannot silently invent a shape.
 */
export function endpoint(def: EndpointDef): EndpointDef {
  // Permission is required where a role gate exists. `session` auth means "any
  // authenticated user acting on their own resources" (own profile, own sessions,
  // own password — AUTH_AND_PERMISSIONS §4 grants these to both roles), so the auth
  // level itself is the authorization and no permission string applies.
  if ((def.auth === "owner" || def.auth === "coach_scoped") && !def.permission) {
    throw new Error(
      `${def.id}: a role-gated endpoint must declare a permission (deny by default)`,
    );
  }
  if (def.idempotent && !def.mutating) {
    throw new Error(`${def.id}: idempotency is only meaningful on a mutating endpoint`);
  }

  const auto: EndpointResponse[] = [];
  if (def.auth !== "public" && def.auth !== "webhook_hmac") {
    auto.push(errorResponse("UNAUTHENTICATED"));
    auto.push(errorResponse("SESSION_EXPIRED"));
  }
  if (def.auth === "owner" || def.auth === "coach_scoped") {
    auto.push(errorResponse("FORBIDDEN"));
    auto.push(errorResponse("NOT_FOUND"));
  }
  // CSRF applies to state-changing methods only (AUTH §2). A sensitive **read**
  // (invoice PDF, proof download) is audited but must not require a CSRF token.
  if (def.mutating && def.method !== "get") {
    auto.push(errorResponse("CSRF_FAILED"), errorResponse("VALIDATION_ERROR"));
  }
  if (def.idempotent) auto.push(errorResponse("IDEMPOTENCY_KEY_REQUIRED"));
  for (const code of def.errors ?? []) auto.push(errorResponse(code));
  auto.push(errorResponse("INTERNAL_ERROR"));

  // Deduplicate by status+code so a locally declared error can't double-render.
  const seen = new Set<number>();
  const responses: EndpointResponse[] = [];
  for (const r of [...def.responses, ...auto]) {
    const key = r.status;
    // Success responses declared by the section always win over auto errors.
    if (r.status < 400) {
      responses.push(r);
      seen.add(key);
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    responses.push(r);
  }

  const rendered: Record<number, unknown> = {};
  for (const r of responses) {
    rendered[r.status] = {
      description: r.description,
      ...(r.contentType
        ? { content: { [r.contentType]: { schema: r.schema } } }
        : r.status >= 400
          ? { content: ERROR_REF }
          : r.schema
            ? { content: { "application/json": { schema: r.schema } } }
            : {}),
    };
  }

  // Documented headers: Idempotency-Key where the contract requires it. The CSRF
  // header is global (AUTH §2) and is declared once in the document description
  // rather than repeated on every mutating operation.
  const headers = def.idempotent
    ? z
        .object({ "Idempotency-Key": z.uuid().describe("Required; 72 h retention") })
        .extend(def.headers ? def.headers.shape : {})
    : def.headers;

  registry.registerPath({
    method: def.method,
    path: def.path,
    operationId: def.operationId ?? def.id,
    summary: def.summary,
    description: def.description,
    tags: def.tags,
    security: securityFor(def),
    request: {
      ...(def.params ? { params: def.params } : {}),
      ...(def.query ? { query: def.query } : {}),
      ...(def.body
        ? {
            body: {
              content: { [def.bodyContentType ?? "application/json"]: { schema: def.body } },
            },
          }
        : {}),
      ...(headers ? { headers } : {}),
    },
    responses: rendered as never,
    ...({
      "x-ia-endpoint": def.id,
      "x-ia-milestone": def.milestone,
      ...(def.permission ? { "x-ia-permission": def.permission } : {}),
      ...(def.scope ? { "x-ia-scope": def.scope } : {}),
      ...(def.audit ? { "x-ia-audit": def.audit } : {}),
      ...(def.idempotent ? { "x-ia-idempotent": true } : {}),
      ...(def.mutating ? { "x-ia-mutating": true } : {}),
      ...(def.rateLimit ? { "x-ia-ratelimit": def.rateLimit } : {}),
    } as object),
  });

  return def;
}

/** Response helpers so sections read declaratively. */
export const res = {
  json<T extends ZodType>(status: number, schema: T, description: string): EndpointResponse {
    return { status, schema, description };
  },
  empty(status: number, description: string): EndpointResponse {
    return { status, description };
  },
  pdf(description: string, status = 200): EndpointResponse {
    return {
      status,
      description,
      contentType: "application/pdf",
      schema: z.string().openapi({ format: "binary" }),
    };
  },
  csv(description: string): EndpointResponse {
    return {
      status: 200,
      description,
      contentType: "text/csv; charset=utf-8",
      schema: z.string(),
    };
  },
};
