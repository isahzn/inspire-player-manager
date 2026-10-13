/**
 * Shared plumbing for the server-side admin CLIs (`create-owner`, `reset-owner`).
 *
 * These run on the server by an operator (DEPLOYMENT_AND_OPERATIONS §9), so they connect
 * with the **migration** role rather than the runtime role: there is no session to
 * authenticate and the operator already holds server access. Every action still writes an
 * audit row, so a CLI change appears in the same trail as an API change — with no actor
 * claimed, because a CLI run has no authenticated identity to name.
 */
import { Client, type ClientConfig } from "pg";
import * as audit from "../../src/audit.js";

/** Loads DATABASE_MIGRATOR_URL (falls back to the runtime URL on a dev box). */
function migratorConfig(): ClientConfig {
  const url = process.env["DATABASE_MIGRATOR_URL"] ?? process.env["DATABASE_URL"];
  if (!url) throw new Error("DATABASE_MIGRATOR_URL (or DATABASE_URL) is required");
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 5432),
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: decodeURIComponent(parsed.pathname.replace(/^\//, "")),
    // Windows defaults the client encoding to the console code page.
    client_encoding: "UTF8",
  };
}

export async function withCliTransaction<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client(migratorConfig());
  await client.connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback").catch(() => undefined);
    throw err;
  } finally {
    await client.end();
  }
}

export interface CliAuditInput {
  action: string;
  entityType: string;
  entityId: string | null;
  after?: unknown;
  reason?: string;
}

/** Writes an audit row for a CLI action. */
export async function recordCliAudit(client: Client, entry: CliAuditInput): Promise<void> {
  await audit.record(
    client,
    { actorUserId: null, actorRole: null, requestId: `cli:${entry.action}`, ip: null },
    {
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      after: entry.after,
      reason: entry.reason ?? "server-side CLI (no authenticated actor)",
    },
  );
}

export interface ParsedArgs {
  [key: string]: string | boolean;
}

/** Minimal `--key value` / `--flag` parser; no dependency and no surprises. */
export function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = true;
    }
  }
  return out;
}

export function requireString(args: ParsedArgs, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`--${key} is required`);
  }
  return value.trim();
}
