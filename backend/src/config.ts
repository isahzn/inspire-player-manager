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

  /**
   * Object storage (FILES_AND_PDF §5, DEPLOYMENT §4).
   *
   * `local` keeps the v1 behaviour (a private directory under `FILES_DIR`); `s3` is an
   * S3-compatible bucket (R2/S3/Supabase Storage/MinIO). The variable names are the ones
   * DEPLOYMENT §4 freezes; the driver name itself was ours to choose, which is why it is
   * listed in the handoff rather than assumed.
   *
   * Only `local` is the default because a bucket that is not there must not silently become
   * a requirement: `s3` without its five variables is a **startup failure** for the worker
   * and the API (see below), never a quiet fallback to a directory nobody backs up.
   */
  storage: {
    driver: optional("STORAGE_DRIVER", "local") as "local" | "s3",
    endpoint: process.env["STORAGE_ENDPOINT"]?.trim() || undefined,
    region: optional("STORAGE_REGION", "auto"),
    bucket: process.env["STORAGE_BUCKET"]?.trim() || undefined,
    accessKeyId: process.env["STORAGE_ACCESS_KEY_ID"]?.trim() || undefined,
    secretAccessKey: process.env["STORAGE_SECRET_ACCESS_KEY"]?.trim() || undefined,
    /** MinIO and some S3-compatible services need path-style addressing. */
    forcePathStyle: boolean("STORAGE_FORCE_PATH_STYLE", false),
    prefix: process.env["STORAGE_PREFIX"]?.trim() || undefined,
    /** Local driver only: the private directory objects live in. */
    filesDir: process.env["FILES_DIR"]?.trim() || undefined,
  },

  /**
   * The worker (DEPLOYMENT §8). It talks to the database through the **migrator** role, like the
   * operator CLIs: there is no session to authenticate and no per-user RLS context to fake, and
   * none of its jobs are a user action. Unset in the API process, which never needs it.
   */
  worker: {
    migratorDatabaseUrl: process.env["DATABASE_MIGRATOR_URL"]?.trim() || undefined,
    /** How often the scheduler looks for due jobs. */
    tickMs: integer("WORKER_TICK_MS", 15_000),
    heartbeatMs: integer("WORKER_HEARTBEAT_MS", 60_000),
    /** A run still `running` after this long is a stuck job. */
    stuckMinutes: integer("WORKER_STUCK_MINUTES", 10),
    /** SYS-03 alerts when the last worker activity is older than this. */
    heartbeatStaleMinutes: integer("WORKER_STALE_MINUTES", 5),
    /** `BACKUP_DIR` is where the nightly logical dump is written (DEPLOYMENT §7). */
    backupDir: process.env["BACKUP_DIR"]?.trim() || undefined,
    retention: {
      /** FILES_AND_PDF §8 / DATABASE §6 defaults; the owner's accountant confirms them. */
      jobRunDays: integer("RETENTION_JOB_RUN_DAYS", 14),
      failedJobRunDays: integer("RETENTION_FAILED_JOB_RUN_DAYS", 90),
      idempotencyDays: integer("RETENTION_IDEMPOTENCY_DAYS", 3),
      invoiceLinkExpiredDays: integer("RETENTION_INVOICE_LINK_DAYS", 30),
      proofMonths: integer("RETENTION_PROOF_MONTHS", 24),
      financialYears: integer("RETENTION_FINANCIAL_YEARS", 7),
    },
  },
} as const;

export type Config = typeof config;
