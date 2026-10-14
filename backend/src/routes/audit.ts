/**
 * AUD-01 — the audit trail (API_CONTRACTS §3.8, DATABASE §3.7).
 *
 * This route is a **read of the record of everything else**, so its whole job is to lose
 * nothing and to invent nothing:
 *
 *  - **Every row is listed, including the ones with no subject.** `audit_logs.entity_id` is
 *    nullable on purpose — `auth.login` has no entity, a settings write has the singleton
 *    academy row, a scheduler-triggered billing run has nobody who did it. `AuditEntry.entityId`
 *    is therefore optional, and this route omits the key rather than sending `null` or the
 *    string `"null"`, because a client that renders `entityId` cannot tell those apart.
 *  - **An actor is only reported when there was one.** A CLI or worker row carries
 *    `actor_user_id = null`; the contract's `actor.role` is the `owner|coach` union, so a row
 *    whose stored role is neither (or whose user has since been removed) reports no actor at
 *    all instead of widening the union with a value the contract does not have.
 *  - **Nothing here is written.** Reading the trail is not itself an audited action — the table
 *    is append-only and the runtime role holds SELECT and INSERT only, so a read has nowhere to
 *    record itself, by decision (the same reasoning as PUB-01's public read in the M6 handoff §4.5).
 *
 * `from`/`to` are instants, not business dates: the column is `occurred_at timestamptz`, and the
 * M1 handoff §4 records that the contract text never said which it meant. Rather than guess a
 * timezone conversion the caller did not ask for, a value is compared as the instant it is.
 */
import { asViewer } from "../http/context.js";
import type { Handler, HandlerResult } from "../http/router.js";

interface AuditListQuery {
  page: number;
  pageSize: number;
  actorUserId?: string;
  entityType?: string;
  entityId?: string;
  action?: string;
  from?: string;
  to?: string;
  q?: string;
}

interface AuditRow {
  id: string;
  occurred_at: string;
  actor_user_id: string | null;
  actor_role: string | null;
  actor_full_name: string | null;
  actor_user_role: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  reason: string | null;
  before: unknown;
  after: unknown;
  request_id: string;
}

/** `ILIKE` with the wildcards escaped, so a search for `%` looks for a `%` (same rule as INV-01). */
function likePattern(value: string): string {
  return `%${value.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

const AUDIT_SELECT = `select al.id::text as id, al.occurred_at::text as occurred_at,
                            al.actor_user_id, al.actor_role,
                            u.full_name as actor_full_name, u.role::text as actor_user_role,
                            al.action, al.entity_type, al.entity_id, al.reason,
                            al.before, al.after, al.request_id
                       from audit_logs al
                       left join users u on u.id = al.actor_user_id`;

/** The actor, or `undefined` when the row has none we can honestly name. */
function serializeActor(row: AuditRow) {
  if (!row.actor_user_id || !row.actor_full_name) return undefined;
  const role = row.actor_role ?? row.actor_user_role;
  if (role !== "owner" && role !== "coach") return undefined;
  return { id: row.actor_user_id, fullName: row.actor_full_name, role };
}

export const aud01List: Handler = async ({ viewer, query }): Promise<HandlerResult> => {
  const { page, pageSize, actorUserId, entityType, entityId, action, from, to, q } =
    query as AuditListQuery;

  const values: unknown[] = [];
  const filters: string[] = [];

  if (actorUserId) {
    values.push(actorUserId);
    filters.push(`al.actor_user_id = $${values.length}`);
  }
  if (entityType) {
    values.push(entityType);
    filters.push(`al.entity_type = $${values.length}`);
  }
  if (entityId) {
    values.push(entityId);
    filters.push(`al.entity_id = $${values.length}`);
  }
  if (action) {
    // Contains, not equality: the frontend's own audit screen filters this way (its mock uses
    // `action.includes(...)`), and the contract's own window is an 80-character free string.
    values.push(likePattern(action));
    filters.push(`al.action ilike $${values.length} escape '\\'`);
  }
  if (from) {
    values.push(from);
    filters.push(`al.occurred_at >= $${values.length}::timestamptz`);
  }
  if (to) {
    values.push(to);
    filters.push(`al.occurred_at <= $${values.length}::timestamptz`);
  }
  if (q) {
    // One placeholder, three columns — the parameters array is shared with the count below, so
    // a placeholder the count's SQL never references would make Postgres reject the statement.
    values.push(likePattern(q));
    const pattern = `$${values.length}`;
    filters.push(
      `(al.action ilike ${pattern} escape '\\' ` +
        `or al.entity_type ilike ${pattern} escape '\\' ` +
        `or u.full_name ilike ${pattern} escape '\\')`,
    );
  }
  const where = filters.length ? `where ${filters.join(" and ")}` : "";

  const result = await asViewer(viewer, async (client) => {
    const count = await client.query<{ total: string }>(
      `select count(*)::text as total
         from audit_logs al
         left join users u on u.id = al.actor_user_id
        ${where}`,
      values,
    );
    const rows = await client.query<AuditRow>(
      `${AUDIT_SELECT} ${where}
        order by al.occurred_at desc, al.id desc
        limit $${values.length + 1} offset $${values.length + 2}`,
      [...values, pageSize, (page - 1) * pageSize],
    );
    return { total: Number(count.rows[0]?.total ?? 0), rows: rows.rows };
  });

  return {
    status: 200,
    body: {
      data: result.rows.map((row) => {
        const actor = serializeActor(row);
        return {
          id: Number(row.id),
          occurredAt: row.occurred_at,
          ...(actor ? { actor } : {}),
          action: row.action,
          entityType: row.entity_type,
          ...(row.entity_id ? { entityId: row.entity_id } : {}),
          ...(row.reason !== null ? { reason: row.reason } : {}),
          ...(row.before !== null ? { before: row.before } : {}),
          ...(row.after !== null ? { after: row.after } : {}),
          requestId: row.request_id,
        };
      }),
      meta: {
        page,
        pageSize,
        total: result.total,
        totalPages: pageSize > 0 ? Math.ceil(result.total / pageSize) : 0,
      },
    },
  };
};
