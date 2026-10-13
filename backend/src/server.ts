/**
 * API entrypoint.
 *
 * Startup order matters: the runtime role is checked for superuser/BYPASSRLS **before**
 * the server accepts traffic (BACKEND_BUILD_GUIDE §4). A server that silently ran as a
 * privileged role would make every RLS assertion in the test suite meaningless.
 */
import { buildApp } from "./app.js";
import { config } from "./config.js";
import { assertRuntimeRoleIsUnprivileged, closePool } from "./db/pool.js";
import { messagingProvider } from "./messaging/provider.js";

async function main(): Promise<void> {
  await assertRuntimeRoleIsUnprivileged();
  // Instantiated eagerly so an unusable provider configuration fails at boot, not at
  // the first send (M7 will add the OpenWA adapter; M2 supports the mock only).
  messagingProvider();

  const app = await buildApp();

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, "shutting down");
    try {
      await app.close();
      await closePool();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, "shutdown failed");
      process.exit(1);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await app.listen({ port: config.port, host: "0.0.0.0" });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
