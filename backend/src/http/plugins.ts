/**
 * Cross-cutting HTTP concerns: request ids, security headers, CORS, cookies, rate
 * limiting and the one place an error becomes a response body.
 */
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import { ZodError } from "zod";
import { config } from "../config.js";
import { ApiError, errors } from "../errors.js";

const REQUEST_ID_HEADER = "x-request-id";

export async function registerPlugins(app: FastifyInstance): Promise<void> {
  // `trustProxy` is set on the Fastify factory in app.ts (it is a constructor option).

  // ---- Request id (API_CONTRACTS §1: every response carries X-Request-Id) ----
  app.addHook("onRequest", async (request, reply) => {
    const inbound = request.headers[REQUEST_ID_HEADER];
    const candidate = typeof inbound === "string" ? inbound : undefined;
    // Only a well-formed id is echoed; anything else could inject into logs.
    const requestId =
      candidate && /^[A-Za-z0-9._-]{8,64}$/.test(candidate) ? candidate : randomUUID();
    request.ia = { requestId, ip: request.ip ?? null, viewer: null };
    reply.header(REQUEST_ID_HEADER, requestId);
    reply.header("Cache-Control", "no-store");
  });

  // ---- Security headers (SECURITY_AND_PRIVACY §3.2). The API serves JSON only. ----
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        "default-src": ["'none'"],
        "frame-ancestors": ["'none'"],
        "base-uri": ["'none'"],
      },
    },
    referrerPolicy: { policy: "no-referrer" },
    crossOriginResourcePolicy: { policy: "same-site" },
    hsts: config.isProduction ? { maxAge: 15_552_000, includeSubDomains: true } : false,
  });

  // ---- CORS: exact origins only, credentials on, never `*` (AUTH §2) ----
  await app.register(cors, {
    origin: (origin, callback) => {
      if (!origin) return callback(null, true); // same-origin/server-to-server
      callback(null, config.corsOrigins.includes(origin));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "X-CSRF-Token", "Idempotency-Key", REQUEST_ID_HEADER],
    exposedHeaders: [REQUEST_ID_HEADER, "Idempotent-Replay", "Retry-After"],
    maxAge: 600,
  });

  await app.register(cookie, { secret: config.sessionCookieSecret });

  // ---- Multipart uploads ----
  // Registered with `attachFieldsToBody: false`, so a handler reads the file parts itself and
  // each endpoint's own size/type rules stay visible at the call site rather than in a plugin
  // default. The streaming limit here is the hard backstop against buffering an unbounded body,
  // so it is the **largest** limit any endpoint declares (PRF-01's 5 MB proof); the smaller,
  // endpoint-specific limits (IMP-01's 2 MB CSV, SET-03's 1 MB logo) are applied by the handler
  // before the bytes are stored, where the refusal can name the right number for that endpoint.
  await app.register(multipart, {
    limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 20 },
    attachFieldsToBody: false,
  });

  // ---- Rate limiting (API_CONTRACTS §1) ----
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: "1 minute",
    // Keyed by user once authenticated, by IP before that.
    keyGenerator: (request) => request.ia?.viewer?.userId ?? request.ip,
    errorResponseBuilder: () => new ApiError("RATE_LIMITED"),
    allowList: [],
  });

  // ---- Errors: one handler, no internals leaked (T-SEC-05) ----
  app.setErrorHandler((error, request, reply) => {
    const requestId = request.ia?.requestId ?? randomUUID();

    if (error instanceof ApiError) {
      // A header the contract attaches to this failure (INV-06's `Retry-After`) travels with
      // the error, so the body and the retry hint cannot be forgotten independently.
      if (error.headers) {
        for (const [name, value] of Object.entries(error.headers)) reply.header(name, value);
      }
      return reply.status(error.status).send({
        error: {
          code: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
          requestId,
        },
      });
    }

    // Fastify's own errors carry a statusCode we trust only for 4xx.
    const fastifyStatus = (error as { statusCode?: number }).statusCode;
    if (fastifyStatus === 429) {
      return reply.status(429).send({
        error: { code: "RATE_LIMITED", message: "Too many requests. Please slow down.", requestId },
      });
    }
    if (error instanceof ZodError) {
      return reply.status(422).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "Some fields need attention.",
          details: error.issues.map((i) => ({
            ...(i.path.length ? { field: i.path.map(String).join(".") } : {}),
            issue: i.message,
          })),
          requestId,
        },
      });
    }
    if (fastifyStatus && fastifyStatus >= 400 && fastifyStatus < 500) {
      const code = fastifyStatus === 400 ? "MALFORMED_JSON" : "NOT_FOUND";
      return reply.status(fastifyStatus).send({
        error: {
          code,
          message: fastifyStatus === 400 ? "Malformed JSON body." : "Not found.",
          requestId,
        },
      });
    }

    // Unexpected: log with the request id, return a generic body. Never echo the
    // message, stack, SQL or parameters.
    request.log.error({ err: error, requestId }, "unhandled error");
    return reply.status(500).send({
      error: { code: "INTERNAL_ERROR", message: "Something went wrong.", requestId },
    });
  });

  app.setNotFoundHandler((request, reply) =>
    reply.status(404).send({
      error: {
        code: "NOT_FOUND",
        message: "Not found.",
        requestId: request.ia?.requestId ?? randomUUID(),
      },
    }),
  );
}
