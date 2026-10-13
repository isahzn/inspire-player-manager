/**
 * PLY-01..10 — players (API_CONTRACTS §3.4).
 *
 * Scope is the load-bearing part: a coach reaches only players whose current group is in
 * an assignment they hold today (enforced by RLS, so an out-of-scope id is invisible and
 * the API can answer 404 without confirming existence), and reads them through the
 * `PlayerCoachView` allow-list — no date of birth, no guardian, no owner note, no balance.
 *
 * `players.version` and `updated_at` are maintained by a trigger (migration 0007), so no
 * statement here writes them; optimistic locking compares `version` in the WHERE clause.
 */
import type { PoolClient } from "pg";
import { withTransaction } from "../db/pool.js";
import { asViewer } from "../http/context.js";
import { errors, ApiError } from "../errors.js";
import { mapPgError } from "../db/pg-errors.js";
import * as audit from "../audit.js";
import { uuidv7 } from "../ids.js";
import type { Handler, HandlerResult } from "../http/router.js";
import { viewerAudit } from "./auth.js";
import {
  dateStr,
  serializeGroupHistoryEntry,
  serializePlayer,
  serializePlayerCoachView,
  type GroupHistoryRow,
  type GuardianRow,
  type PlayerRow,
} from "./people-serialize.js";
import {
  ageOn,
  ageReferenceDate,
  allocatePlayerRegistrationNo,
  duplicateReasonText,
  findDuplicatePlayers,
  normalizePhoneOrThrow,
  todayInTimeZone,
} from "./people-helpers.js";
import {
  INVOICE_FULL_SELECT,
  creditForGuardians,
  playerBalanceTotals,
} from "./money-helpers.js";
import { serializeInvoice, type InvoiceFullRow } from "./money-serialize.js";

type ViewerLike = Parameters<Handler>[0]["viewer"];

type PlayerStatus = "active" | "inactive" | "withdrawn";

const PLAYER_COLUMNS = `id, registration_no, full_name, date_of_birth, registration_date,
                        billing_anchor_date, status, status_effective_date, status_reason,
                        notes, coach_notes, version`;
const GUARDIAN_COLUMNS = `id, full_name, phone_e164, relationship, whatsapp_consent,
                          consent_recorded_at, consent_source, opted_out_at`;

/** Sort allow-list (PLY-01). Anything else is INVALID_SORT, never interpolated SQL. */
const SORT_COLUMNS: Record<string, string> = {
  fullName: "full_name",
  registrationDate: "registration_date",
  registrationNo: "registration_no",
};

function orderBy(sort: string | undefined): string {
  if (!sort) return "order by id asc";
  const parts: string[] = [];
  for (const token of sort.split(",")) {
    const trimmed = token.trim();
    if (!trimmed) continue;
    const direction = trimmed.startsWith("-") ? "desc" : "asc";
    const field = trimmed.replace(/^-/, "");
    const column = SORT_COLUMNS[field];
    if (!column) throw new ApiError("INVALID_SORT", `Unknown sort field "${field}".`);
    parts.push(`${column} ${direction}`);
  }
  parts.push("id asc");
  return `order by ${parts.join(", ")}`;
}

function referenceDateFor(viewer: ViewerLike): string {
  const today = todayInTimeZone(viewer.academy.timezone);
  return ageReferenceDate(
    viewer.academy.ageReferenceRule,
    viewer.academy.ageReferenceMonthDay,
    today,
  );
}

function ageOf(dateOfBirth: Date | null, referenceDate: string): number | undefined {
  const dob = dateStr(dateOfBirth);
  return dob ? ageOn(dob, referenceDate) : undefined;
}

/** NFC-normalized, trimmed text (DATABASE §1: names are Unicode, trimmed in the API). */
function nfc(value: string): string {
  return value.normalize("NFC").trim();
}

/** A `YYYY-MM-DD` string as a local-midnight Date, so `dateStr()` round-trips it. */
function localDate(value: string): Date {
  const [y, m, d] = value.split("-").map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
}

interface OpenGroupRow {
  player_id: string;
  id: string;
  name: string;
  effective_from: Date;
}

interface GuardianLinkRow extends GuardianRow {
  player_id: string;
  is_primary: boolean;
  receives_invoices: boolean;
}

interface ExtrasMaps {
  groups: Map<string, { id: string; name: string; since: Date }>;
  guardians: Map<string, { guardian: GuardianRow; is_primary: boolean; receives_invoices: boolean }[]>;
}

/** Batch-loads current groups and guardian links for a set of player ids (no N+1). */
async function loadExtras(client: PoolClient, ids: string[]): Promise<ExtrasMaps> {
  const groups = new Map<string, { id: string; name: string; since: Date }>();
  const guardians = new Map<
    string,
    { guardian: GuardianRow; is_primary: boolean; receives_invoices: boolean }[]
  >();
  if (ids.length === 0) return { groups, guardians };

  const groupRows = await client.query<OpenGroupRow>(
    `select h.player_id, h.age_group_id as id, g.name, h.effective_from
       from player_group_history h
       join age_groups g on g.id = h.age_group_id
      where h.player_id = any ($1::uuid[]) and h.effective_to is null`,
    [ids],
  );
  for (const row of groupRows.rows) {
    groups.set(row.player_id, { id: row.id, name: row.name, since: row.effective_from });
  }

  const linkRows = await client.query<GuardianLinkRow>(
    `select pg.player_id, pg.is_primary, pg.receives_invoices,
            g.id, g.full_name, g.phone_e164, g.relationship, g.whatsapp_consent,
            g.consent_recorded_at, g.consent_source, g.opted_out_at
       from player_guardians pg
       join guardians g on g.id = pg.guardian_id
      where pg.player_id = any ($1::uuid[])
      order by pg.is_primary desc, g.full_name`,
    [ids],
  );
  for (const row of linkRows.rows) {
    const list = guardians.get(row.player_id) ?? [];
    list.push({ guardian: row, is_primary: row.is_primary, receives_invoices: row.receives_invoices });
    guardians.set(row.player_id, list);
  }

  return { groups, guardians };
}

/** The owner projection of one player, with its joined rows. */
async function serializeOwnerPlayer(
  client: PoolClient,
  row: PlayerRow,
  referenceDate: string,
) {
  const { groups, guardians } = await loadExtras(client, [row.id]);
  return serializePlayer(row, {
    ageOnReference: ageOf(row.date_of_birth, referenceDate),
    currentGroup: groups.get(row.id) ?? null,
    guardians: guardians.get(row.id) ?? [],
  });
}

// ---------------------------------------------------------------------------
// PLY-01 — list
// ---------------------------------------------------------------------------
export const ply01List: Handler = async ({ viewer, query }): Promise<HandlerResult> => {
  const { page, pageSize, q, status, ageGroupId, hasOutstanding, sort } = query as {
    page: number;
    pageSize: number;
    q?: string;
    status?: PlayerStatus;
    ageGroupId?: string;
    hasOutstanding?: boolean;
    sort?: string;
  };
  const isCoach = viewer.role === "coach";
  const order = orderBy(sort);
  const referenceDate = referenceDateFor(viewer);

  // Outstanding is derived from invoices, which M5 introduces; until then no player has
  // one, so the filter honestly matches nothing rather than ignoring the caller.
  if (!isCoach && hasOutstanding === true) {
    return {
      status: 200,
      body: { data: [], meta: { page, pageSize, total: 0, totalPages: 0 } },
    };
  }

  const filters: string[] = [];
  const values: unknown[] = [];
  values.push(status ?? "active");
  filters.push(`status = $${values.length}`);
  if (q) {
    values.push(`%${q}%`);
    filters.push(
      `(full_name ilike $${values.length} or registration_no ilike $${values.length})`,
    );
  }
  if (ageGroupId) {
    values.push(ageGroupId);
    filters.push(
      `exists (select 1 from player_group_history h
                where h.player_id = players.id
                  and h.effective_to is null
                  and h.age_group_id = $${values.length})`,
    );
  }
  const where = `where ${filters.join(" and ")}`;

  const result = await asViewer(viewer, async (client) => {
    const countResult = await client.query<{ total: string }>(
      `select count(*)::text as total from players ${where}`,
      values,
    );
    const pageResult = await client.query<PlayerRow>(
      `select ${PLAYER_COLUMNS} from players ${where} ${order}
         limit $${values.length + 1} offset $${values.length + 2}`,
      [...values, pageSize, (page - 1) * pageSize],
    );
    const ids = pageResult.rows.map((r) => r.id);
    const extras = await loadExtras(client, ids);
    const coachGuardians = new Map<string, { fullName: string; phone: string }>();
    if (isCoach && viewer.academy.coachCanSeeGuardianPhone && ids.length > 0) {
      // `guardians` has no coach policy; the phone reaches a coach only through this
      // SECURITY DEFINER view, and only because the academy turned the setting on.
      const primary = await client.query<{ player_id: string; full_name: string; phone_e164: string }>(
        `select player_id, full_name, phone_e164
           from app.player_primary_guardian
          where player_id = any ($1::uuid[])`,
        [ids],
      );
      for (const row of primary.rows) {
        coachGuardians.set(row.player_id, { fullName: row.full_name, phone: row.phone_e164 });
      }
    }
    return {
      total: Number(countResult.rows[0]!.total),
      rows: pageResult.rows,
      extras,
      coachGuardians,
    };
  });

  const data = result.rows.map((row) => {
    if (isCoach) {
      const group = result.extras.groups.get(row.id);
      const guardian = result.coachGuardians.get(row.id);
      return serializePlayerCoachView(row, {
        age: ageOf(row.date_of_birth, referenceDate),
        ...(group ? { group: { id: group.id, name: group.name } } : {}),
        ...(guardian ? { primaryGuardian: guardian } : {}),
      });
    }
    return serializePlayer(row, {
      ageOnReference: ageOf(row.date_of_birth, referenceDate),
      currentGroup: result.extras.groups.get(row.id) ?? null,
      guardians: result.extras.guardians.get(row.id) ?? [],
    });
  });

  return {
    status: 200,
    body: {
      data,
      meta: {
        page,
        pageSize,
        total: result.total,
        totalPages: pageSize > 0 ? Math.ceil(result.total / pageSize) : 0,
      },
    },
  };
};

// ---------------------------------------------------------------------------
// PLY-02 — register
// ---------------------------------------------------------------------------
interface GuardianCreateInput {
  guardianId?: string;
  fullName?: string;
  phone?: string;
  relationship?: string;
  whatsappConsent?: { status: "granted" | "unknown"; source: string };
  isPrimary: boolean;
  receivesInvoices: boolean;
}

export const ply02Create: Handler = async ({ ctx, viewer, body }): Promise<HandlerResult> => {
  const input = body as {
    fullName: string;
    dateOfBirth?: string;
    registrationDate: string;
    ageGroupId?: string;
    notes?: string;
    coachNotes?: string;
    guardians: GuardianCreateInput[];
    acknowledgeDuplicates?: boolean;
  };
  const fullName = nfc(input.fullName);
  const today = todayInTimeZone(viewer.academy.timezone);

  if (input.dateOfBirth && input.dateOfBirth > today) {
    throw errors.validation([{ field: "dateOfBirth", issue: "A date of birth cannot be in the future." }]);
  }
  const latestRegistration = new Date(`${today}T00:00:00Z`);
  latestRegistration.setUTCDate(latestRegistration.getUTCDate() + 30);
  if (input.registrationDate > latestRegistration.toISOString().slice(0, 10)) {
    throw errors.validation([
      { field: "registrationDate", issue: "A registration date cannot be more than 30 days ahead." },
    ]);
  }
  const primaryCount = input.guardians.filter((g) => g.isPrimary).length;
  if (primaryCount !== 1) {
    throw errors.validation([
      { field: "guardians", issue: "Exactly one guardian must be marked primary." },
    ]);
  }

  // Advisory only: it refuses the request because the caller has not acknowledged, not
  // because the database forbids the row (PLY-08, DATABASE §3.2).
  const phones = input.guardians
    .filter((g) => Boolean(g.phone))
    .map((g) => normalizePhoneOrThrow(g.phone as string, "guardians.phone"));
  const hits = await asViewer(viewer, (client) =>
    findDuplicatePlayers(client, {
      fullName,
      ...(input.dateOfBirth ? { dateOfBirth: input.dateOfBirth } : {}),
      guardianPhones: phones,
    }),
  );
  if (hits.length > 0 && input.acknowledgeDuplicates !== true) {
    throw new ApiError("DUPLICATE_SUSPECTED", "Possible duplicate players found.", [
      {
        issue:
          "A player with the same name and date of birth already exists, or a shared guardian phone was found. Confirm to register anyway.",
        meta: {
          matches: hits.map((hit) => ({
            playerId: hit.row.id,
            fullName: hit.row.full_name,
            reason: duplicateReasonText(hit.reason),
            score: hit.score,
          })),
        },
      },
    ]);
  }

  try {
    const created = await withTransaction({ userId: viewer.userId, role: viewer.role }, async (client) => {
      const id = uuidv7();
      const registrationNo = await allocatePlayerRegistrationNo(
        client,
        Number(input.registrationDate.slice(0, 4)),
      );
      const inserted = await client.query<PlayerRow>(
        `insert into players
           (id, registration_no, full_name, date_of_birth, registration_date,
            billing_anchor_date, status, status_effective_date, notes, coach_notes, created_by)
         values ($1, $2, $3, $4, $5, $5, 'active', $5, $6, $7, $8)
         returning ${PLAYER_COLUMNS}`,
        [
          id,
          registrationNo,
          fullName,
          input.dateOfBirth ?? null,
          input.registrationDate,
          input.notes ? nfc(input.notes) : null,
          input.coachNotes ? nfc(input.coachNotes) : null,
          viewer.userId,
        ],
      );
      const player = inserted.rows[0]!;

      const links: {
        guardian: GuardianRow;
        is_primary: boolean;
        receives_invoices: boolean;
      }[] = [];
      for (const entry of input.guardians) {
        let guardian: GuardianRow;
        if (entry.guardianId) {
          const found = await client.query<GuardianRow>(
            `select ${GUARDIAN_COLUMNS} from guardians where id = $1`,
            [entry.guardianId],
          );
          if (!found.rows[0]) throw errors.notFound();
          guardian = found.rows[0]!;
        } else {
          const phone = normalizePhoneOrThrow(entry.phone as string, "guardians.phone");
          const consent = entry.whatsappConsent;
          const newGuardian = await client.query<GuardianRow>(
            `insert into guardians
               (id, full_name, phone_e164, relationship, whatsapp_consent,
                consent_recorded_at, consent_source)
             values ($1, $2, $3, $4, $5, $6, $7)
             returning ${GUARDIAN_COLUMNS}`,
            [
              uuidv7(),
              nfc(entry.fullName as string),
              phone,
              entry.relationship ?? null,
              consent?.status ?? "unknown",
              consent ? new Date() : null,
              consent?.source ?? null,
            ],
          );
          guardian = newGuardian.rows[0]!;
        }
        await client.query(
          `insert into player_guardians (player_id, guardian_id, is_primary, receives_invoices)
           values ($1, $2, $3, $4)`,
          [id, guardian.id, entry.isPrimary, entry.receivesInvoices],
        );
        links.push({ guardian, is_primary: entry.isPrimary, receives_invoices: entry.receivesInvoices });
      }

      let currentGroup: { id: string; name: string; since: Date } | null = null;
      if (input.ageGroupId) {
        const group = await client.query<{ id: string; name: string }>(
          `select id, name from age_groups where id = $1 and archived_at is null`,
          [input.ageGroupId],
        );
        const groupRow = group.rows[0];
        if (!groupRow) {
          throw errors.validation([{ field: "ageGroupId", issue: "Unknown or archived age group." }]);
        }
        await client.query(
          `insert into player_group_history (id, player_id, age_group_id, effective_from, changed_by)
           values ($1, $2, $3, $4, $5)`,
          [uuidv7(), id, input.ageGroupId, input.registrationDate, viewer.userId],
        );
        currentGroup = {
          id: input.ageGroupId,
          name: groupRow.name,
          since: localDate(input.registrationDate),
        };
      }

      const serialized = serializePlayer(player, {
        ageOnReference: ageOf(player.date_of_birth, referenceDateFor(viewer)),
        currentGroup,
        guardians: links,
      });
      await audit.record(client, viewerAudit(viewer, ctx), {
        action: "player.create",
        entityType: "player",
        entityId: id,
        after: serialized,
      });
      return serialized;
    });

    return { status: 201, body: created };
  } catch (err) {
    mapPgError(err);
  }
};

// ---------------------------------------------------------------------------
// PLY-03 — read
// ---------------------------------------------------------------------------
export const ply03Read: Handler = async ({ viewer, params }): Promise<HandlerResult> => {
  const { id } = params as { id: string };
  const referenceDate = referenceDateFor(viewer);
  const isCoach = viewer.role === "coach";

  const found = await asViewer(viewer, async (client) => {
    const result = await client.query<PlayerRow>(
      `select ${PLAYER_COLUMNS} from players where id = $1`,
      [id],
    );
    const player = result.rows[0];
    if (!player) return null;
    const { groups, guardians } = await loadExtras(client, [id]);
    let primaryGuardian: { fullName: string; phone: string } | undefined;
    if (isCoach && viewer.academy.coachCanSeeGuardianPhone) {
      // As in PLY-01: a coach reads the guardian only through the SECURITY DEFINER view.
      const primary = await client.query<{ full_name: string; phone_e164: string }>(
        `select full_name, phone_e164 from app.player_primary_guardian where player_id = $1`,
        [id],
      );
      const row = primary.rows[0];
      if (row) primaryGuardian = { fullName: row.full_name, phone: row.phone_e164 };
    }
    return { player, group: groups.get(id), guardians: guardians.get(id) ?? [], primaryGuardian };
  });
  if (!found) throw errors.notFound();

  if (isCoach) {
    return {
      status: 200,
      body: serializePlayerCoachView(found.player, {
        age: ageOf(found.player.date_of_birth, referenceDate),
        ...(found.group ? { group: { id: found.group.id, name: found.group.name } } : {}),
        ...(found.primaryGuardian ? { primaryGuardian: found.primaryGuardian } : {}),
      }),
    };
  }

  return {
    status: 200,
    body: serializePlayer(found.player, {
      ageOnReference: ageOf(found.player.date_of_birth, referenceDate),
      currentGroup: found.group ?? null,
      guardians: found.guardians,
    }),
  };
};

// ---------------------------------------------------------------------------
// PLY-04 — update
// ---------------------------------------------------------------------------
export const ply04Update: Handler = async ({ ctx, viewer, params, body }): Promise<HandlerResult> => {
  const { id } = params as { id: string };
  const input = body as {
    fullName?: string;
    dateOfBirth?: string;
    registrationDate?: string;
    notes?: string;
    coachNotes?: string;
    billingAnchorDate?: string;
    version: number;
  };
  const referenceDate = referenceDateFor(viewer);

  try {
    return await withTransaction({ userId: viewer.userId, role: viewer.role }, async (client) => {
      const existing = await client.query<PlayerRow>(
        `select ${PLAYER_COLUMNS} from players where id = $1`,
        [id],
      );
      const before = existing.rows[0];
      if (!before) throw errors.notFound();

      // `billingAnchorDate` is only meaningful before the player's first invoice; there
      // are no invoices until M5, so every change is currently allowed (ALREADY_INVOICED
      // becomes reachable when `invoices` exists).
      const updated = await client.query<PlayerRow>(
        `update players
            set full_name = coalesce($3, full_name),
                date_of_birth = case when $4::boolean then $5::date else date_of_birth end,
                registration_date = coalesce($6::date, registration_date),
                billing_anchor_date = coalesce($7::date, billing_anchor_date),
                notes = case when $8::boolean then $9::text else notes end,
                coach_notes = case when $10::boolean then $11::text else coach_notes end
          where id = $1 and version = $2
        returning ${PLAYER_COLUMNS}`,
        [
          id,
          input.version,
          input.fullName !== undefined ? nfc(input.fullName) : null,
          input.dateOfBirth !== undefined,
          input.dateOfBirth ?? null,
          input.registrationDate ?? null,
          input.billingAnchorDate ?? null,
          input.notes !== undefined,
          input.notes !== undefined ? nfc(input.notes) : null,
          input.coachNotes !== undefined,
          input.coachNotes !== undefined ? nfc(input.coachNotes) : null,
        ],
      );
      const after = updated.rows[0];
      if (!after) throw errors.versionConflict();

      const serialized = await serializeOwnerPlayer(client, after, referenceDate);
      await audit.record(client, viewerAudit(viewer, ctx), {
        action: "player.update",
        entityType: "player",
        entityId: id,
        before: await serializeOwnerPlayer(client, before, referenceDate),
        after: serialized,
      });
      return { status: 200, body: serialized };
    });
  } catch (err) {
    mapPgError(err);
  }
};

// ---------------------------------------------------------------------------
// PLY-05 — status change
// ---------------------------------------------------------------------------
export const ply05Status: Handler = async ({ ctx, viewer, params, body }): Promise<HandlerResult> => {
  const { id } = params as { id: string };
  const input = body as {
    status: PlayerStatus;
    effectiveDate: string;
    reason?: string;
    stopReminders?: boolean;
    version: number;
  };
  if (input.status === "withdrawn" && !input.reason) {
    // The contract declares REASON_REQUIRED for this row (API_CONTRACTS §1.1), not the
    // generic VALIDATION_ERROR, so the frontend can bind the exact field.
    throw new ApiError("REASON_REQUIRED", "Give a reason when withdrawing a player.", [
      { field: "reason", issue: "A withdrawal needs a reason." },
    ]);
  }
  const referenceDate = referenceDateFor(viewer);
  // `stopReminders` defaults to true on withdrawal and would cancel that guardian's
  // unsent jobs; no message job exists until M7, so it is recorded in the audit only.
  const stopReminders = input.stopReminders ?? input.status === "withdrawn";

  try {
    return await withTransaction({ userId: viewer.userId, role: viewer.role }, async (client) => {
      const existing = await client.query<PlayerRow>(
        `select ${PLAYER_COLUMNS} from players where id = $1`,
        [id],
      );
      const before = existing.rows[0];
      if (!before) throw errors.notFound();

      const updated = await client.query<PlayerRow>(
        `update players
            set status = $3, status_effective_date = $4::date, status_reason = $5::text
          where id = $1 and version = $2
        returning ${PLAYER_COLUMNS}`,
        [id, input.version, input.status, input.effectiveDate, input.reason ?? null],
      );
      const after = updated.rows[0];
      if (!after) throw errors.versionConflict();

      const serialized = await serializeOwnerPlayer(client, after, referenceDate);
      await audit.record(client, viewerAudit(viewer, ctx), {
        action: "player.status.change",
        entityType: "player",
        entityId: id,
        before: await serializeOwnerPlayer(client, before, referenceDate),
        after: { ...serialized, stopReminders },
        reason: input.reason ?? null,
      });
      return { status: 200, body: serialized };
    });
  } catch (err) {
    mapPgError(err);
  }
};

// ---------------------------------------------------------------------------
// PLY-06 — transfer
// ---------------------------------------------------------------------------
export const ply06Transfer: Handler = async ({ ctx, viewer, params, body }): Promise<HandlerResult> => {
  const { id } = params as { id: string };
  const input = body as {
    ageGroupId: string;
    effectiveFrom: string;
    reason: string;
    version: number;
  };
  const referenceDate = referenceDateFor(viewer);

  try {
    return await withTransaction({ userId: viewer.userId, role: viewer.role }, async (client) => {
      const locked = await client.query<PlayerRow>(
        `select ${PLAYER_COLUMNS} from players where id = $1 for update`,
        [id],
      );
      const player = locked.rows[0];
      if (!player) throw errors.notFound();
      if (player.version !== input.version) throw errors.versionConflict();

      const open = await client.query<{ id: string; effective_from: Date; age_group_id: string }>(
        `select id, effective_from, age_group_id
           from player_group_history
          where player_id = $1 and effective_to is null
          for update`,
        [id],
      );
      const openRow = open.rows[0];
      if (openRow && input.effectiveFrom <= (dateStr(openRow.effective_from) as string)) {
        throw errors.validation([
          {
            field: "effectiveFrom",
            issue: "The transfer date must be after the current group started.",
          },
        ]);
      }

      const group = await client.query<{ id: string; name: string }>(
        `select id, name from age_groups where id = $1 and archived_at is null`,
        [input.ageGroupId],
      );
      const groupRow = group.rows[0];
      if (!groupRow) {
        throw errors.validation([{ field: "ageGroupId", issue: "Unknown or archived age group." }]);
      }

      if (openRow) {
        await client.query(
          `update player_group_history set effective_to = $2::date - 1 where id = $1`,
          [openRow.id, input.effectiveFrom],
        );
      }
      await client.query(
        `insert into player_group_history
           (id, player_id, age_group_id, effective_from, reason, changed_by)
         values ($1, $2, $3, $4, $5, $6)`,
        [uuidv7(), id, input.ageGroupId, input.effectiveFrom, input.reason, viewer.userId],
      );

      const serialized = serializePlayer(player, {
        ageOnReference: ageOf(player.date_of_birth, referenceDate),
        currentGroup: {
          id: input.ageGroupId,
          name: groupRow.name,
          since: localDate(input.effectiveFrom),
        },
        guardians: (await loadExtras(client, [id])).guardians.get(id) ?? [],
      });
      await audit.record(client, viewerAudit(viewer, ctx), {
        action: "player.transfer",
        entityType: "player",
        entityId: id,
        after: serialized,
        reason: input.reason,
      });
      return { status: 200, body: serialized };
    });
  } catch (err) {
    mapPgError(err);
  }
};

// ---------------------------------------------------------------------------
// PLY-07 — group history
// ---------------------------------------------------------------------------
export const ply07GroupHistory: Handler = async ({ viewer, params }): Promise<HandlerResult> => {
  const { id } = params as { id: string };
  const rows = await asViewer(viewer, async (client) => {
    const player = await client.query<{ id: string }>(`select id from players where id = $1`, [id]);
    if (!player.rows[0]) throw errors.notFound();
    return (
      await client.query<GroupHistoryRow>(
        `select h.id, h.age_group_id, g.name as age_group_name, h.effective_from,
                h.effective_to, h.reason, h.changed_by, u.full_name as changed_by_name
           from player_group_history h
           join age_groups g on g.id = h.age_group_id
           join users u on u.id = h.changed_by
          where h.player_id = $1
          order by h.effective_from desc`,
        [id],
      )
    ).rows;
  });
  return { status: 200, body: { data: rows.map(serializeGroupHistoryEntry) } };
};

// ---------------------------------------------------------------------------
// PLY-08 — advisory duplicate check
// ---------------------------------------------------------------------------
export const ply08CheckDuplicates: Handler = async ({ ctx, viewer, body }): Promise<HandlerResult> => {
  const input = body as {
    fullName: string;
    dateOfBirth?: string;
    guardianPhones?: string[];
  };
  const phones: string[] = [];
  for (const phone of input.guardianPhones ?? []) {
    try {
      phones.push(normalizePhoneOrThrow(phone, "guardianPhones"));
    } catch {
      // Advisory tool: an unparseable number is ignored rather than blocking the check.
    }
  }
  const referenceDate = referenceDateFor(viewer);

  const matches = await withTransaction({ userId: viewer.userId, role: viewer.role }, async (client) => {
    const hits = await findDuplicatePlayers(client, {
      fullName: nfc(input.fullName),
      ...(input.dateOfBirth ? { dateOfBirth: input.dateOfBirth } : {}),
      guardianPhones: phones,
    });
    const { groups, guardians } = await loadExtras(client, hits.map((hit) => hit.row.id));
    await audit.record(client, viewerAudit(viewer, ctx), {
      action: "player.duplicate_check",
      entityType: "player",
      after: { matchCount: hits.length },
    });
    return hits.map((hit) => ({
      player: serializePlayer(hit.row, {
        ageOnReference: ageOf(hit.row.date_of_birth, referenceDate),
        currentGroup: groups.get(hit.row.id) ?? null,
        guardians: guardians.get(hit.row.id) ?? [],
      }),
      reason: duplicateReasonText(hit.reason),
      score: hit.score,
    }));
  });

  return { status: 200, body: { matches } };
};

// ---------------------------------------------------------------------------
// PLY-09 — a player's invoices
// ---------------------------------------------------------------------------
/**
 * The invoices issued to one player, newest first. Owner-only (the contract gives it
 * `players:manage`), because an invoice is financial data a coach never sees (CLAUDE.md §3).
 * A void invoice is returned like any other — the list explains the player's history, and
 * INV-01's filters are what hide a void when the caller wants it hidden.
 */
export const ply09Invoices: Handler = async ({
  viewer,
  params,
  query,
}): Promise<HandlerResult> => {
  const { id } = params as { id: string };
  const { page, pageSize, status } = query as {
    page: number;
    pageSize: number;
    status?: "issued" | "partially_paid" | "paid" | "void";
  };

  const result = await asViewer(viewer, async (client) => {
    const player = await client.query("select id from players where id = $1", [id]);
    if (!player.rows[0]) throw errors.notFound();

    const values: unknown[] = [id];
    let where = "where i.player_id = $1";
    if (status) {
      values.push(status);
      where += ` and i.status = $${values.length}`;
    }
    const total = await client.query<{ total: string }>(
      `select count(*)::text as total from invoices i ${where}`,
      values,
    );
    const rows = await client.query<InvoiceFullRow>(
      `${INVOICE_FULL_SELECT} ${where}
        order by i.issue_date desc, i.invoice_number desc, i.id desc
        limit $${values.length + 1} offset $${values.length + 2}`,
      [...values, pageSize, (page - 1) * pageSize],
    );
    return { total: Number(total.rows[0]?.total ?? 0), rows: rows.rows };
  });

  return {
    status: 200,
    body: {
      data: result.rows.map((row) => serializeInvoice(row)),
      meta: {
        page,
        pageSize,
        total: result.total,
        totalPages: pageSize > 0 ? Math.ceil(result.total / pageSize) : 0,
      },
    },
  };
};

// ---------------------------------------------------------------------------
// PLY-11 — a player's balance
// ---------------------------------------------------------------------------
/**
 * Outstanding and overdue across the player's open invoices, plus the credit their guardians
 * hold — **reported separately, never netted** into outstanding (T-RPT-02, BILLING_ENGINE
 * §12). Outstanding is as of now, not as of a range.
 */
export const ply11Balance: Handler = async ({ viewer, params }): Promise<HandlerResult> => {
  const { id } = params as { id: string };

  const body = await asViewer(viewer, async (client) => {
    const player = await client.query("select id from players where id = $1", [id]);
    if (!player.rows[0]) throw errors.notFound();

    const totals = await playerBalanceTotals(client, [id]);
    const guardians = await client.query<{ guardian_id: string }>(
      `select guardian_id from player_guardians where player_id = $1`,
      [id],
    );
    const creditMinor = await creditForGuardians(
      client,
      guardians.rows.map((row) => row.guardian_id),
    );
    return { ...totals, creditMinor };
  });

  return { status: 200, body };
};

// ---------------------------------------------------------------------------
// PLY-10 — a player's attendance history
// ---------------------------------------------------------------------------
export const ply10Attendance: Handler = async ({ viewer, params, query }): Promise<HandlerResult> => {
  const { id } = params as { id: string };
  const { from, to } = query as { from?: string; to?: string };
  // "History" means up to today in the academy's timezone, and from the day the player
  // joined unless the caller narrows it: both bounds are business dates, compared in SQL.
  const upperBound = to ?? todayInTimeZone(viewer.academy.timezone);

  const result = await asViewer(viewer, async (client) => {
    const player = await client.query<{ id: string; registration_date: Date }>(
      `select id, registration_date from players where id = $1`,
      [id],
    );
    const found = player.rows[0];
    if (!found) throw errors.notFound();
    const lowerBound = from ?? dateStr(found.registration_date)!;

    // One query answers both halves. The `sessions` join is what gives a coach the right
    // scope: RLS hides a session of a group they do not hold, so those sessions are not
    // in the history at all rather than filtered out afterwards. Cancelled sessions are
    // excluded entirely, and the player must have been on the roster on that date — the
    // same two conditions ATT-01 applies to the sheet (ATTENDANCE §3, T-ATT-10).
    const rows = await client.query<{
      session_id: string;
      session_date: Date;
      status: "present" | "absent" | "late" | "excused" | null;
      note: string | null;
      present: string;
      absent: string;
      late: string;
      excused: string;
      marked: string;
    }>(
      `select s.id as session_id, s.session_date, a.status, a.note,
              (a.status = 'present')::text as present,
              (a.status = 'absent')::text  as absent,
              (a.status = 'late')::text    as late,
              (a.status = 'excused')::text as excused,
              (a.id is not null)::text     as marked
         from sessions s
         join players p
           on p.id = $1
          and (p.status = 'active' or p.status_effective_date > s.session_date)
         join player_group_history h
           on h.player_id = p.id
          and h.age_group_id = s.age_group_id
          and h.effective_from <= s.session_date
          and (h.effective_to is null or h.effective_to >= s.session_date)
         left join player_attendance a on a.session_id = s.id and a.player_id = p.id
        where s.status <> 'cancelled'
          and s.session_date between $2::date and $3::date
        order by s.session_date desc, s.id desc`,
      [id, lowerBound, upperBound],
    );

    const tally = (key: "present" | "absent" | "late" | "excused" | "marked") =>
      rows.rows.filter((row) => row[key] === "true").length;
    return {
      summary: {
        present: tally("present"),
        absent: tally("absent"),
        late: tally("late"),
        excused: tally("excused"),
        // A session the player was on the roster for but nobody marked. An excused
        // session is in `excused`; it is not also unmarked.
        unmarked: rows.rows.length - tally("marked"),
      },
      // Only marked sessions carry a `status`, and `status` is required by the contract,
      // so the per-session rows are the marked ones and `unmarked` is a count.
      data: rows.rows
        .filter((row) => row.marked === "true")
        .map((row) => ({
          sessionId: row.session_id,
          sessionDate: dateStr(row.session_date)!,
          status: row.status!,
          ...(row.note ? { note: row.note } : {}),
        })),
    };
  });

  return { status: 200, body: result };
};