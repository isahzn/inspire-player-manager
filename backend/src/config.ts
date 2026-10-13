/**
 * Configuration, validated once at startup (BACKEND_BUILD_GUIDE §8: fail fast).
 *
 * Names marked "documented" are frozen by DEPLOYMENT_AND_OPERATIONS §4; the rest are
 * implementation details listed in the M2 handoff §4. The backend refuses to start on
 * a missing or weak secret rather than falling back to a default that would silently
 * run production without security (SECURITY_AND_PRIVACY §5).
 */
import { config as loadEnv } from "dotenv";

loadEnv();

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required environment variable ${name}`);
  return value;
}

function optional(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

/** Secrets must carry real entropy: the spec's floor is 32 bytes (AUTH §1, SECURITY §5). */
function secret(name: string, { minLength = 32 }: { minLength?: number } = {}): string {
  const value = required(name);
  if (value.length < minLength) {
    throw new Error(`${name} must be at least ${minLength} characters of random data`);
  }
  if (/^(dev-only|changeme|secret|test)/i.test(value) && process.env["NODE_ENV"] === "production") {
    throw new Error(`${name} still holds a development placeholder while NODE_ENV=production`);
  }
  return value;
}

function integer(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) throw new Error(`${name} must be an integer`);
  return parsed;
}

function boolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return raw === "true" || raw === "1";
}

const nodeEnv = optional("NODE_ENV", "development");
const isProduction = nodeEnv === "production";

export const config = {
  nodeEnv,
  appEnv: optional("APP_ENV", nodeEnv),
  isProduction,
  isTest: nodeEnv === "test" || process.env["VITEST"] === "true",

  port: integer("PORT", 3200),
  apiBaseUrl: optional("API_BASE_URL", "http://localhost:3200"),
  appBaseUrl: optional("APP_BASE_URL", "http://localhost:3100"),
  /** Exact origins only — CORS is never `*` (AUTH §2). */
  corsOrigins: optional("CORS_ALLOWED_ORIGINS", "http://localhost:3100")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean),
  trustProxy: boolean("TRUST_PROXY", false),
  logLevel: optional("LOG_LEVEL", "info"),

  databaseUrl: required("DATABASE_URL"),
  statementTimeoutMs: integer("DB_STATEMENT_TIMEOUT_MS", 5000),
  poolMax: integer("DB_POOL_MAX", 10),

  cookieName: optional("SESSION_COOKIE_NAME", "ia_session"),
  cookieDomain: process.env["COOKIE_DOMAIN"]?.trim() || undefined,
  cookieSecure: boolean("COOKIE_SECURE", isProduction),
  sessionCookieSecret: secret("SESSION_COOKIE_SECRET"),
  csrfSecret: secret("CSRF_SECRET"),

  /** Session lifetimes (AUTH_AND_PERMISSIONS §1). Coaches get long sessions: phones at the pitch. */
  ownerIdleMinutes: integer("OWNER_IDLE_MINUTES", 120),
  ownerAbsoluteHours: integer("OWNER_ABSOLUTE_HOURS", 12),
  coachIdleHours: integer("COACH_IDLE_HOURS", 24),
  coachAbsoluteDays: integer("COACH_ABSOLUTE_DAYS", 14),
  loginMaxFailures: integer("LOGIN_MAX_FAILURES", 5),
  loginLockMinutes: integer("LOGIN_LOCK_MINUTES", 15),

  totpEncryptionKey: secret("TOTP_ENCRYPTION_KEY"),

  messagingProvider: optional("MESSAGING_PROVIDER", "mock"),
  openwa: {
    baseUrl: process.env["OPENWA_BASE_URL"]?.trim() || undefined,
    apiKey: process.env["OPENWA_API_KEY"]?.trim() || undefined,
    sessionId: process.env["OPENWA_SESSION_ID"]?.trim() || undefined,
    webhookSecret: process.env["OPENWA_WEBHOOK_SECRET"]?.trim() || undefined,
  },

  /** Version string surfaced by SYS-03; CI sets it from the git SHA. */
  version: optional("APP_VERSION", "0.1.0-dev"),
} as const;

export type Config = typeof config;
