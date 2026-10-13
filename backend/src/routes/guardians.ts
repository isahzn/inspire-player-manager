/**
 * GDN-01..05 — guardians and their links to players (API_CONTRACTS §3.4).
 *
 * Guardians are owner-only: no coach policy exists on `guardians` or `player_guardians`,
 * so a coach is denied by RLS as well as by the permission guard (T-AUTH-01). A guardian
 * row is shared by siblings (one consent record per guardian), and a player must keep at
 * least one guardian — GDN-04.delete refuses the last unlink rather than leaving a player
 * unreachable.
 */
import type { PoolClient } from "pg";
import { withTransaction } from "../db/pool.js";
import { errors } from "../errors.js";
import { mapPgError } from "../db/pg-errors.js";
import * as audit from "../audit.js";
import { uuidv7 } from "../ids.js";
import { asViewer } from "../http/context.js";
import type { Handler, HandlerResult } from "../http/router.js";
import {
  serializeGuardian,
  serializeGuardianWithPlayers,
  serializePlayerGuardianLink,
  type GuardianRow,
} from "./people-serialize.js";
import { normalizePhoneOrThrow } from "./people-helpers.js";
import { viewerAudit } from "./auth.js";
import {
  INVOICE_FULL_SELECT,
  creditForGuardians,
  playerBalanceTotals,
} from "./money-helpers.js";
import { serializeInvoice, type InvoiceFullRow } from "./money-serialize.js";

const GUARDIAN_COLUMNS = `id, full_name, phone_e164, relationship, whatsapp_consent,
                          consent_recorded_at, consent_source, opted_out_at`;

/** Creates a guardian inline (GDN-03 new-guardian branch) and returns its id. */
async function createGuardian(
  client: PoolClient,
  input: {
    fullName: string;
    phone: string;
    relationship?: string;
    whatsappConsent?: { status: "granted" | "unknown"; source: string };
  },
): Promise<string> {
  const phone = normalizePhoneOrThrow(input.phone, "phone");
  const id = uuidv7();
  const consent = input.whatsappConsent;
  await client.query(
    `insert into guardians
       (id, full_name, phone_e164, relationship, whatsapp_consent, consent_recorded_at, consent_source)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      id,
      input.fullName.trim(),
      phone,
      input.relationship?.trim() ?? null,
      consent?.status ?? "unknown",
      consent ? new Date() : null,
      consent ? consent.source : null,
    ],
  );
  return id;
}

export const gdn01List: Handler = async ({ viewer, query }): Promise<HandlerResult> => {
  const { page, pageSize, q } = query as { page: number; pageSize: number; q?: string };

  const filters: string[] = [];
  const values: unknown[] = [];
  if (q) {
    values.push(`%${q}%`);
    filters.push(`(full_name ilike $${values.length} or phone_e164 ilike $${values.length})`);
  }
  const where = filters.length ? `where ${filters.join(" and ")}` : "";

  const { total, rows } = await asViewer(viewer, async (client) => {
    const totalResult = await client.query<{ total: string }>(
      `select count(*)::text as total from guardians ${where}`,
      values,
    );
    const pageResult = await client.query<GuardianRow>(
      `select ${GUARDIAN_COLUMNS}
         from guardians ${where}
        order by full_name asc, id asc
        limit $${values.length + 1} offset $${values.length + 2}`,
      [...values, pageSize, (page - 1) * pageSize],
    );
    return { total: Number(totalResult.rows[0]?.total ?? 0), rows: pageResult.rows };
  });

  // One query for every page guardian's players — never one per row (DATABASE §9).
  const byGuardian = new Map<string, { id: string; full_name: string }[]>();
  if (rows.length > 0) {
    const links = await asViewer(viewer, async (client) =>
      client.query<{ guardian_id: string; id: string; full_name: string }>(
        `select pg.guardian_id, p.id, p.full_name
           from player_guardians pg
           join players p on p.id = pg.player_id
          where pg.guardian_id = any ($1::uuid[])
          order by p.full_name asc`,
        [rows.map((row) => row.id)],
      ),
    );
    for (const link of links.rows) {
      const list = byGuardian.get(link.guardian_id) ?? [];
      list.push({ id: link.id, full_name: link.full_name });
      byGuardian.set(link.guardian_id, list);
    }
  }

  return {
    status: 200,
    body: {
      data: rows.map((guardian) =>
        serializeGuardianWithPlayers(guardian, byGuardian.get(guardian.id) ?? []),
      ),
      meta: {
        page,
        pageSize,
        total,
        totalPages: pageSize > 0 ? Math.ceil(total / pageSize) : 0,
      },
    },
  };
};

export const gdn02Update: Handler = async ({ ctx, viewer, params, body }): Promise<HandlerResult> => {
  const { id } = params as { id: string };
  const input = body as { fullName?: string; phone?: string; relationship?: string };
  const phone = input.phone !== undefined ? normalizePhoneOrThrow(input.phone, "phone") : undefined;

  try {
    return await withTransaction({ userId: viewer.userId, role: viewer.role }, async (client) => {
      const beforeResult = await client.query<GuardianRow>(
        `select ${GUARDIAN_COLUMNS} from guardians where id = $1`,
        [id],
      );
      const before = beforeResult.rows[0];
      if (!before) throw errors.notFound();

      const updated = await client.query<GuardianRow>(
        `update guardians
            set full_name = coalesce($2, full_name),
                phone_e164 = case when $3::boolean then $4 else phone_e164 end,
                relationship = case when $5::boolean then $6 else relationship end
          where id = $1
        returning ${GUARDIAN_COLUMNS}`,
        [
          id,
          input.fullName?.trim() ?? null,
          input.phone !== undefined,
          phone ?? null,
          input.relationship !== undefined,
          input.relationship?.trim() ?? null,
        ],
      );
      const after = updated.rows[0]!;

      // `audit.record` masks any key named `phone`, so the phone is stored as
      // `+9477****567` rather than in full (SECURITY_AND_PRIVACY §3.5).
      await audit.record(client, viewerAudit(viewer, ctx), {
        action: "guardian.update",
        entityType: "guardian",
        entityId: id,
        before: { fullName: before.full_name, phone: before.phone_e164 },
        after: { fullName: after.full_name, phone: after.phone_e164 },
      });
      return { status: 200, body: serializeGuardian(after) };
    });
  } catch (err) {
    mapPgError(err);
  }
};

export const gdn03Link: Handler = async ({ ctx, viewer, params, body }): Promise<HandlerResult> => {
  const { id: playerId } = params as { id: string };
  const input = body as
    | { guardianId: string; isPrimary: boolean; receivesInvoices: boolean }
    | {
        fullName: string;
        phone: string;
        relationship?: string;
        whatsappConsent?: { status: "granted" | "unknown"; source: string };
        isPrimary: boolean;
        receivesInvoices: boolean;
      };

  try {
    return await withTransaction({ userId: viewer.userId, role: viewer.role }, async (client) => {
      const player = await client.query<{ id: string }>("select id from players where id = $1", [
        playerId,
      ]);
      if (!player.rows[0]) throw errors.notFound();

      let guardianId: string;
      if ("guardianId" in input) {
        const found = await client.query<GuardianRow>(
          `select ${GUARDIAN_COLUMNS} from guardians where id = $1`,
          [input.guardianId],
        );
        if (!found.rows[0]) throw errors.notFound();
        guardianId = input.guardianId;
      } else {
        guardianId = await createGuardian(client, input);
      }

      // Exactly one primary per player: move the flag before the link is written.
      if (input.isPrimary) {
        await client.query(
          `update player_guardians set is_primary = false
            where player_id = $1 and is_primary`,
          [playerId],
        );
      }
      await client.query(
        `insert into player_guardians (player_id, guardian_id, is_primary, receives_invoices)
         values ($1, $2, $3, $4)
         on conflict (player_id, guardian_id)
         do update set is_primary = excluded.is_primary,
                       receives_invoices = excluded.receives_invoices`,
        [playerId, guardianId, input.isPrimary, input.receivesInvoices],
      );

      const guardian = await client.query<GuardianRow>(
        `select ${GUARDIAN_COLUMNS} from guardians where id = $1`,
        [guardianId],
      );
      await audit.record(client, viewerAudit(viewer, ctx), {
        action: "player.guardian.link",
        entityType: "player",
        entityId: playerId,
        after: { guardianId, isPrimary: input.isPrimary, receivesInvoices: input.receivesInvoices },
      });
      return {
        status: 201,
        body: serializePlayerGuardianLink(guardian.rows[0]!, {
          is_primary: input.isPrimary,
          receives_invoices: input.receivesInvoices,
        }),
      };
    });
  } catch (err) {
    mapPgError(err);
  }
};

export const gdn04Update: Handler = async ({ ctx, viewer, params, body }): Promise<HandlerResult> => {
  const { id: playerId, guardianId } = params as { id: string; guardianId: string };
  const input = body as { isPrimary?: boolean; receivesInvoices?: boolean };

  try {
    return await withTransaction({ userId: viewer.userId, role: viewer.role }, async (client) => {
      const linkResult = await client.query<{ is_primary: boolean; receives_invoices: boolean }>(
        `select is_primary, receives_invoices
           from player_guardians
          where player_id = $1 and guardian_id = $2`,
        [playerId, guardianId],
      );
      const before = linkResult.rows[0];
      if (!before) throw errors.notFound();

      if (input.isPrimary === true) {
        await client.query(
          `update player_guardians set is_primary = false
            where player_id = $1 and is_primary and guardian_id <> $2`,
          [playerId, guardianId],
        );
      }
      const updated = await client.query<{ is_primary: boolean; receives_invoices: boolean }>(
        `update player_guardians
            set is_primary = coalesce($3, is_primary),
                receives_invoices = coalesce($4, receives_invoices)
          where player_id = $1 and guardian_id = $2
        returning is_primary, receives_invoices`,
        [playerId, guardianId, input.isPrimary ?? null, input.receivesInvoices ?? null],
      );

      const guardian = await client.query<GuardianRow>(
        `select ${GUARDIAN_COLUMNS} from guardians where id = $1`,
        [guardianId],
      );
      if (!guardian.rows[0]) throw errors.notFound();
      const after = updated.rows[0]!;

      await audit.record(client, viewerAudit(viewer, ctx), {
        action: "player.guardian.update",
        entityType: "player",
        entityId: playerId,
        before: {
          guardianId,
          isPrimary: before.is_primary,
          receivesInvoices: before.receives_invoices,
        },
        after: {
          guardianId,
          isPrimary: after.is_primary,
          receivesInvoices: after.receives_invoices,
        },
      });
      return { status: 200, body: serializePlayerGuardianLink(guardian.rows[0], after) };
    });
  } catch (err) {
    mapPgError(err);
  }
};

export const gdn04Delete: Handler = async ({ ctx, viewer, params }): Promise<HandlerResult> => {
  const { id: playerId, guardianId } = params as { id: string; guardianId: string };

  try {
    return await withTransaction({ userId: viewer.userId, role: viewer.role }, async (client) => {
      const link = await client.query(
        `select 1 from player_guardians where player_id = $1 and guardian_id = $2`,
        [playerId, guardianId],
      );
      if (!link.rows[0]) throw errors.notFound();

      const remaining = await client.query<{ count: string }>(
        `select count(*)::text as count from player_guardians where player_id = $1`,
        [playerId],
      );
      if (Number(remaining.rows[0]?.count ?? 0) <= 1) {
        throw errors.validation([
          { field: "guardianId", issue: "A player must keep at least one guardian." },
        ]);
      }

      await client.query(
        `delete from player_guardians where player_id = $1 and guardian_id = $2`,
        [playerId, guardianId],
      );
      await audit.record(client, viewerAudit(viewer, ctx), {
        action: "player.guardian.unlink",
        entityType: "player",
        entityId: playerId,
        before: { guardianId },
      });
      return { status: 204 };
    });
  } catch (err) {
    mapPgError(err);
  }
};

export const gdn05Consent: Handler = async ({ ctx, viewer, params, body }): Promise<HandlerResult> => {
  const { id } = params as { id: string };
  const input = body as {
    status: "granted" | "revoked" | "unknown";
    source: string;
    note?: string;
  };

  try {
    return await withTransaction({ userId: viewer.userId, role: viewer.role }, async (client) => {
      const beforeResult = await client.query<GuardianRow>(
        `select ${GUARDIAN_COLUMNS} from guardians where id = $1`,
        [id],
      );
      const before = beforeResult.rows[0];
      if (!before) throw errors.notFound();

      // 'revoked' must immediately cancel that guardian's queued/failed jobs
      // (OPENWA_INTEGRATION §11). `message_jobs` arrives in M7, so there is nothing to
      // cancel yet — the consent record is written now, so no automation can act on a
      // guardian who has not consented once the queue exists.
      const updated = await client.query<GuardianRow>(
        `update guardians
            set whatsapp_consent = $2,
                consent_source = $3,
                consent_recorded_at = now(),
                opted_out_at = case
                  when $2 = 'revoked' then now()
                  when $2 = 'granted' then null
                  else opted_out_at
                end
          where id = $1
        returning ${GUARDIAN_COLUMNS}`,
        [id, input.status, input.source],
      );
      const after = updated.rows[0]!;

      await audit.record(client, viewerAudit(viewer, ctx), {
        action: "guardian.consent",
        entityType: "guardian",
        entityId: id,
        before: { whatsappConsent: before.whatsapp_consent },
        after: { whatsappConsent: after.whatsapp_consent, source: input.source },
        ...(input.note ? { reason: input.note } : {}),
      });
      return { status: 200, body: serializeGuardian(after) };
    });
  } catch (err) {
    mapPgError(err);
  }
};

// ---------------------------------------------------------------------------
// GDN-06 — a guardian's balance across their players
// ---------------------------------------------------------------------------
/**
 * One guardian's outstanding and overdue totals across every player they are linked to, the
 * credit they personally hold, and the open invoices behind the outstanding figure
 * (BILLING_ENGINE §12). The totals span the guardian's **players** — the family — rather than
 * only the invoices billed to this guardian, because a sibling's bill is this guardian's bill
 * too; `openInvoices` is the detail behind that number.
 */
export const gdn06Balance: Handler = async ({ viewer, params }): Promise<HandlerResult> => {
  const { id } = params as { id: string };

  const body = await asViewer(viewer, async (client) => {
    const guardian = await client.query("select id from guardians where id = $1", [id]);
    if (!guardian.rows[0]) throw errors.notFound();

    const links = await client.query<{ player_id: string }>(
      `select player_id from player_guardians where guardian_id = $1`,
      [id],
    );
    const playerIds = links.rows.map((row) => row.player_id);

    const totals = await playerBalanceTotals(client, playerIds);
    const creditMinor = await creditForGuardians(client, [id]);
    const open = playerIds.length
      ? (
          await client.query<InvoiceFullRow>(
            `${INVOICE_FULL_SELECT}
              where i.player_id = any ($1::uuid[])
                and i.status in ('issued', 'partially_paid')
              order by i.due_date asc, i.invoice_number asc`,
            [playerIds],
          )
        ).rows
      : [];

    return { ...totals, creditMinor, openInvoices: open.map((row) => serializeInvoice(row)) };
  });

  return { status: 200, body };
};
