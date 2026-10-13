/**
 * Contract-driven routing.
 *
 * Every route is built from the **same** registry entry that generates
 * `api/openapi.yaml`, which is why the document cannot drift from the server:
 *   - params/query/body are validated with the contract's Zod schemas, so unknown
 *     fields are rejected (T-SEC-02) and error details match the documented shape;
 *   - a route declares its permission in the contract, so a route without one cannot
 *     be registered (T-AUTH-02, deny by default);
 *   - handlers are keyed by operation id, so an endpoint that is documented but not yet
 *     implemented simply has no handler and is not served (no fake 501s).
 *
 * Guard order is AUTH_AND_PERMISSIONS §5: authenticate → CSRF/Origin → permission →
 * (handler: validate → transaction with RLS context → audit → serialize).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { allEndpoints } from "../../spec/index.js";
import type { EndpointDef } from "../../spec/registry.js";
import { config } from "../config.js";
import { ApiError, errors } from "../errors.js";
import { parse } from "./validate.js";
import { authorize, rolePermissions } from "../auth/permissions.js";
import { csrfMatches, csrfTokenFor, resolveSession } from "../auth/sessions.js";
import { pool, withTransaction } from "../db/pool.js";
import type { AppContext, Viewer } from "./context.js";

export interface HandlerArgs<P = unknown, Q = unknown, B = unknown> {
  req: FastifyRequest;
  reply: FastifyReply;
  ctx: AppContext;
  /** Present for every endpoint whose contract auth is not "public"/"webhook_hmac". */
  viewer: Viewer;
  params: P;
  query: Q;
  body: B;
}

export interface HandlerResult {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export type Handler = (args: HandlerArgs<never, never, never>) => Promise<HandlerResult>;

/** Routes registered from the contract, for the "no route outside the contract" test. */
export const registeredRoutes = new Set<string>();

function isSessionAuth(ep: EndpointDef): boolean {
  return ep.auth === "session" || ep.auth === "owner" || ep.auth === "coach_scoped";
}

/**
 * The rate limits API_CONTRACTS §1 names explicitly, keyed by the contract's `rateLimit` label.
 *
 * An endpoint with no entry keeps the global limit (300/min, keyed by user once authenticated /
 * by IP before that). Both entries here are per **IP**, which the global `keyGenerator` already
 * produces for an unauthenticated request — and that is the point for PUB-01, whose whole defence
 * against a token being brute-forced is that it cannot be tried 300 times a minute.
 */
const RATE_LIMIT_ROUTES: Record<string, { max: number; timeWindow: string }> = {
  login: { max: 10, timeWindow: "1 minute" },
  public_invoice: { max: 30, timeWindow: "1 minute" },
  exports: { max: 10, timeWindow: "1 hour" },
};

/**
 * Loads the authenticated user. Runs as one transaction with the RLS context set, so
 * the identity policies (not a service-role bypass) decide what is readable.
 */
async function loadViewer(
  ctx: AppContext,
  session: { sessionId: string; userId: string; role: "owner" | "coach" },
  restricted: boolean,
): Promise<Viewer> {
  return withTransaction({ userId: session.userId, role: session.role }, async (client) => {
    const userResult = await client.query<{
      id: string;
      username: string;
      full_name: string;
      phone_e164: string | null;
      role: "owner" | "coach";
      status: "invited" | "active" | "disabled";
      totp_enabled: boolean;
    }>(
      `select id, username::text as username, full_name, phone_e164, role, status, totp_enabled
         from users where id = $1`,
      [session.userId],
    );
    const user = userResult.rows[0];
    if (!user || user.status !== "active") throw errors.unauthenticated();

    const academyResult = await client.query<{
      name: string;
      timezone: string;
      logo_file_id: string | null;
      age_reference_rule: "jan_1_of_year" | "fixed_month_day" | "today";
      age_reference_month_day: string | null;
      coach_can_see_guardian_phone: boolean;
    }>(
      `select name, timezone, logo_file_id, age_reference_rule, age_reference_month_day,
              coach_can_see_guardian_phone
         from app.academy_public`,
    );
    const academy = academyResult.rows[0] ?? {
      name: "Inspire Academy",
      timezone: "Asia/Colombo",
      logo_file_id: null,
      age_reference_rule: "jan_1_of_year" as const,
      age_reference_month_day: null,
      coach_can_see_guardian_phone: false,
    };

    return {
      userId: user.id,
      username: user.username,
      fullName: user.full_name,
      phone: user.phone_e164,
      role: user.role,
      status: user.status,
      totpEnabled: user.totp_enabled,
      permissions: rolePermissions(user.role),
      restricted,
      sessionId: session.sessionId,
      csrfToken: csrfTokenFor(session.sessionId),
      academy: {
        name: academy.name,
        timezone: academy.timezone,
        logoFileId: academy.logo_file_id,
        ageReferenceRule: academy.age_reference_rule,
        ageReferenceMonthDay: academy.age_reference_month_day,
        coachCanSeeGuardianPhone: academy.coach_can_see_guardian_phone,
      },
    };
  });
}

function originAllowed(request: FastifyRequest): boolean {
  const origin = request.headers.origin;
  const referer = request.headers.referer;
  if (origin) return config.corsOrigins.includes(origin);
  if (referer) {
    try {
      return config.corsOrigins.includes(new URL(referer).origin);
    } catch {
      return false;
    }
  }
  // No Origin/Referer: allowed only for non-browser callers in development, where the
  // test suite and curl live. Production requires the header (AUTH §2).
  return !config.isProduction;
}

/**
 * The contract writes paths the OpenAPI way (`/users/{id}`); Fastify's router wants
 * `:id`. Without this translation a parameterised path is registered as a **literal**
 * `{id}` segment, so `/api/v1/users/<uuid>` never matches and answers 404 — the route
 * exists, is documented, has a guard, and is unreachable. Path params are validated
 * afterwards against the contract's own schema, so nothing is loosened here.
 */
export function fastifyPath(path: string): string {
  return path.replace(/\{([^}]+)\}/g, ":$1");
}

export function registerContractRoutes(app: FastifyInstance, handlers: Map<string, Handler>): void {
  for (const ep of allEndpoints) {
    const operationId = ep.operationId ?? ep.id;
    const handler = handlers.get(operationId);
    if (!handler) continue;

    registeredRoutes.add(`${ep.method.toUpperCase()} ${ep.path}`);

    app.route({
      method: ep.method.toUpperCase() as "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
      url: `/api/v1${fastifyPath(ep.path)}`,
      config:
        ep.rateLimit && RATE_LIMIT_ROUTES[ep.rateLimit]
          ? { rateLimit: RATE_LIMIT_ROUTES[ep.rateLimit]! }
          : {},
      handler: async (request, reply) => {
        const ctx = request.ia;

        // --- 0. Origin allow-list on every state-changing method (AUTH §2) ----
        // Applies to public routes too: signing in from a foreign origin is refused
        // even though no CSRF token exists yet. GET/HEAD carry no CSRF requirement.
        if (ep.method !== "get" && !originAllowed(request)) throw errors.csrf();

        // --- 1. Authenticate -------------------------------------------------
        if (isSessionAuth(ep)) {
          const token = request.cookies[config.cookieName];
          if (!token) throw errors.unauthenticated();
          const session = await resolveSession(pool, token);
          if (!session) throw errors.sessionExpired();
          if (!ctx.viewer) {
            // Permission decided after the viewer exists (it depends on the role).
            ctx.viewer = await loadViewer(ctx, session, false);
          }

          // --- 2. CSRF + Origin on state-changing methods (AUTH §2) ----------
          if (ep.method !== "get") {
            const provided = request.headers["x-csrf-token"];
            if (typeof provided !== "string" || !csrfMatches(session.sessionId, provided)) {
              throw errors.csrf();
            }
          }

          // --- 3. Coarse permission guard -----------------------------------
          if (ep.permission) {
            const decision = authorize(ctx.viewer.role, ep.permission);
            if (!decision.allowed) throw errors.forbidden();
            if (decision.restricted) ctx.viewer.restricted = true;
          }
        }

        // --- 4. Validate against the contract's own schemas ------------------
        const params = ep.params ? parse(ep.params, request.params, "params") : undefined;
        const queryData = ep.query ? parse(ep.query, request.query, "query") : undefined;
        const body =
          ep.body && ep.bodyContentType !== "multipart/form-data"
            ? parse(ep.body, request.body, "body")
            : request.body;

        // --- 5. Handler ------------------------------------------------------
        const result = await handler({
          req: request,
          reply,
          ctx,
          viewer: ctx.viewer as Viewer,
          params: params as never,
          query: queryData as never,
          body: body as never,
        });

        if (result.headers) {
          for (const [name, value] of Object.entries(result.headers)) reply.header(name, value);
        }
        const status = result.status ?? 200;
        if (status === 204) return reply.status(204).send();
        return reply.status(status).send(result.body);
      },
    });
  }
}

export { ApiError };
