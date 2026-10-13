/**
 * Audit recording (DATABASE §3.7, AUTH §5 step 7).
 *
 * `audit.record()` is called **inside the same transaction** as the mutation it
 * describes, so a change and its audit row commit or roll back together. The table is
 * append-only with a hash chain and the runtime role has INSERT + SELECT only.
 *
 * Privacy: phone numbers in before/after are masked (SECURITY_AND_PRIVACY §3.5). The
 * masking lives here rather than at each call site so it cannot be forgotten.
 */
import type { Client, Pool, PoolClient } from "pg";
import type { Role } from "../spec/components.js";

/** Anything with a `query` method: the pooled client, a transaction client, or a CLI client. */
export type AnyQueryable = Pool | PoolClient | Client;

export interface AuditContext {
  actorUserId: string | null;
  actorRole: Role | null;
  requestId: string;
  ip?: string | null;
}

export interface AuditEntryInput {
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
}

/** `+94771234567` → `+9477****567` (keeps the country code and last digits readable). */
export function maskPhone(value: string): string {
  if (value.length < 8) return "****";
  return `${value.slice(0, 5)}****${value.slice(-3)}`;
}

const SENSITIVE_KEYS = /^(password|passwordHash|token|tokenHash|csrfToken|secret|totpSecretEnc|apiKey)$/i;

/**
 * Redacts secrets and masks phones recursively before anything is written to the audit
 * trail. Returns a new value; the caller's object is untouched.
 */
export function sanitizeForAudit(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => sanitizeForAudit(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEYS.test(key)) {
      out[key] = "[redacted]";
      continue;
    }
    if (/^(phone|phoneE164|toPhoneE164)$/.test(key) && typeof raw === "string") {
      out[key] = maskPhone(raw);
      continue;
    }
    if (key === "mentions" || key === "elapsedMinutes") {
      out[key] = raw;
      continue;
    }
    out[key] = sanitizeForAudit(raw, depth + 1);
  }
  return out;
}

/** Writes one audit row. Must be called with the transaction's client. */
export async function record(
  client: AnyQueryable,
  ctx: AuditContext,
  entry: AuditEntryInput,
): Promise<void> {
  await client.query(
    `insert into audit_logs
       (actor_user_id, actor_role, action, entity_type, entity_id, before, after, reason, request_id, ip)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      ctx.actorUserId,
      ctx.actorRole,
      entry.action,
      entry.entityType,
      entry.entityId ?? null,
      entry.before === undefined ? null : JSON.stringify(sanitizeForAudit(entry.before)),
      entry.after === undefined ? null : JSON.stringify(sanitizeForAudit(entry.after)),
      entry.reason ?? null,
      ctx.requestId,
      ctx.ip ?? null,
    ],
  );
}
