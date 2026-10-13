/**
 * Application factory. Used by `server.ts` and by the test suite, so tests exercise the
 * same wiring (plugins, guards, contract routes) that runs in production.
 */
import Fastify, { type FastifyInstance } from "fastify";
import { config } from "./config.js";
import { registerPlugins } from "./http/plugins.js";
import { registerContractRoutes, registeredRoutes } from "./http/router.js";
import { handlers } from "./routes/index.js";

export interface BuildOptions {
  logger?: boolean;
}

export async function buildApp(options: BuildOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    // `DEBUG_TESTS=1` turns logging on inside the test suite, which is how an
    // unexpected 500 is diagnosed without guessing.
    logger:
      options.logger === false || (config.isTest && process.env["DEBUG_TESTS"] !== "1")
        ? false
        : {
            level: config.logLevel,
            // Never log credentials; phones appear masked (SECURITY_AND_PRIVACY §3.5).
            redact: {
              paths: [
                "req.headers.cookie",
                "req.headers.authorization",
                'req.headers["x-csrf-token"]',
                'req.headers["idempotency-key"]',
                "res.headers['set-cookie']",
              ],
              censor: "[redacted]",
            },
          },
    // JSON only; uploads come through dedicated multipart routes later (M6).
    bodyLimit: 256 * 1024,
    trustProxy: config.trustProxy,
  });

  await registerPlugins(app);
  registerContractRoutes(app, handlers);

  return app;
}

/** Route paths registered from the contract — asserted against the registry in tests. */
export function contractRoutes(): string[] {
  return [...registeredRoutes].sort();
}
