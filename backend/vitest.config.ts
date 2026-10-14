/**
 * Three projects, because the layers need different things:
 *   unit        — pure logic, no database (fast, always runs)
 *   db          — real PostgreSQL, RLS/constraint behaviour asserted **without** the API
 *                 (T-DB-RLS-*): proof the database denies a coach independently of the
 *                 server, which an API-level test cannot give.
 *   integration — the built Fastify app driven through `inject()`, against the same
 *                 real database (T-AUTH-*, T-SEC-*).
 *
 * All of them point at `ia_test`; the app tests and the db tests never share the dev
 * database, so a test run cannot damage seeded dev data.
 */
import { defineConfig } from "vitest/config";
import { config as loadEnv } from "dotenv";

loadEnv();

/** Rewrites the database name in a connection URL (ia_dev → ia_test). */
function testUrl(url: string | undefined): string {
  if (!url) throw new Error("a database URL is required to run the backend tests");
  const parsed = new URL(url);
  parsed.pathname = "/ia_test";
  return parsed.toString();
}

const testEnv: Record<string, string> = {
  NODE_ENV: "test",
  DATABASE_URL: testUrl(process.env["DATABASE_URL"]),
  DATABASE_MIGRATOR_URL: testUrl(process.env["DATABASE_MIGRATOR_URL"]),
  // Deterministic secrets so tokens are reproducible within a run (never used in prod).
  SESSION_COOKIE_SECRET: "test-session-cookie-secret-value-32-chars",
  CSRF_SECRET: "test-csrf-secret-value-32-characters-ok",
  TOTP_ENCRYPTION_KEY: "test-totp-encryption-key-32-characters-ok",
  COOKIE_SECURE: "false",
  MESSAGING_PROVIDER: "mock",
  CORS_ALLOWED_ORIGINS: "http://localhost:3100",
  LOG_LEVEL: "silent",
  // Test-only: trusting the proxy header lets each test present its own client IP, so
  // the documented per-IP login limit (10/min) can be asserted deliberately instead of
  // tripping across unrelated tests sharing 127.0.0.1. Production sets this explicitly.
  TRUST_PROXY: "true",
};

export default defineConfig({
  test: {
    // All three projects run against the same `ia_test`. Vitest runs projects **in
    // parallel**, and `resetData()` takes an ACCESS EXCLUSIVE lock across twenty-odd
    // tables, so the db project and the integration project's live API traffic can meet:
    // observed as `error: deadlock detected` out of the `truncate`, and as logins answering
    // 500 because the truncate deleted `users` underneath them. `fileParallelism: false`
    // below only orders files *within* a project, so the projects themselves are serialised
    // here. One worker means exactly one writer-project touching the database at a time.
    maxWorkers: 1,
    fileParallelism: false,
    projects: [
      {
        test: {
          name: "unit",
          include: ["tests/unit/**/*.test.ts"],
          env: testEnv,
        },
      },
      {
        test: {
          name: "db",
          include: ["tests/db/**/*.test.ts"],
          env: testEnv,
          // Database setup and teardown must not race between files.
          fileParallelism: false,
          hookTimeout: 60_000,
          testTimeout: 30_000,
        },
      },
      {
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          env: testEnv,
          fileParallelism: false,
          hookTimeout: 60_000,
          testTimeout: 30_000,
        },
      },
    ],
  },
});
