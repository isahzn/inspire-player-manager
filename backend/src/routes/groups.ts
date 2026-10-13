/**
 * GRP-01..05, FEE-01/02, CCH-01..05 — age groups, their fee history and coach
 * assignments (API_CONTRACTS §3.3, M3).
 *
 * Three rules shape this file:
 *
 *  - **A coach never sees a fee, a balance or a player count.** The owner adds
 *    `currentFeeMinor`/`activePlayerCount`; the coach branch omits them entirely
 *    (the serializer only emits what it is given). RLS already limits which groups a
 *    coach can reach, so the list needs no scope predicate of its own.
 *  - **A fee change closes the current row and opens a new one** in one transaction
 *    (DATABASE §8 T6), locking the group so two concurrent changes cannot interleave
 *    into overlapping ranges. No fee row's amount is ever edited.
 *  - **The database owns the overlap rules** (btree_gist exclusion constraints). An
 *    exclusion violation (`23P01`) is translated into the documented 409 rather than
 *    surfacing as a 500.
 */
import type { PoolClient } from "pg";
import { withTransaction } from "../db/pool.js";
import { errors, ApiError } from "../errors.js";
import { isPgError, mapPgError } from "../db/pg-errors.js";
import * as audit from "../audit.js";
import { uuidv7 } from "../ids.js";
import { asViewer } from "../http/context.js";
import { withIdempotency } from "../http/idempotency.js";
import type { Handler, HandlerResult } from "../http/router.js";
import type { UserRow } from "./serialize.js";
import { viewerAudit } from "./auth.js";
import {
  dateStr,
  serializeAgeGroup,
  serializeCoachAssignment,
  serializeCoachRow,
  serializeGroupFee,
  type AgeGroupRow,
  type CoachAssignmentRow,
  type GroupFeeRow,
} from "./people-serialize.js";
import {
  ageOn,
  ageReferenceDate,
  loadAcademySettings,
  todayInTimeZone,
} from "./people-helpers.js";

const AGE_GROUP_SELECT = `select id, name, min_age, max_age, sort_order, archived_at
                            from age_groups`;

const COACH_SELECT = `select id, username::text as username, full_name, phone_e164, role, status,
                             totp_enabled, last_login_at
                        from users`;

/** Active-player count per group: an open history row and a player still `active`. */
const ACTIVE_PLAYER_COUNTS = `select h.age_group_id, count(*)::text as count
                                from player_group_history h
                                join players p on p.id = h.player_id
                               where h.age_group_id = any ($1::uuid[])
                                 and h.effective_to is null
                                 and p.status = 'active'
                               group by h.age_group_id`;

async function activePlayerCount(client: PoolClient, groupId: string): Promise<number> {
  const result = await client.query<{ count: string }>(
    `select count(*)::text as count
       from player_group_history h
       join players p on p.id = h.player_id
      where h.age_group_id = $1
        and h.effective_to is null
        and p.status = 'active'`,
    [groupId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

/** The fee in force on `today`, or null when the group has never been priced. */
async function currentFeeMinor(
  client: PoolClient,
  groupId: string,
  today: string,
): Promise<number | null> {
  const result = await client.query<{ amount_minor: string }>(
    `select amount_minor
       from group_fees
      where age_group_id = $1
        and effective_from <= $2::date
        and (effective_to is null or effective_to >= $2::date)
      order by effective_from desc
      limit 1`,
    [groupId, today],
  );
  const row = result.rows[0];
  return row ? Number(row.amount_minor) : null;
}

// ---------------------------------------------------------------------------
// GRP-01..05 — age groups
// ---------------------------------------------------------------------------
export const grp01List: Handler = async ({ viewer, query }): Promise<HandlerResult> => {
  const { includeArchived } = query as { includeArchived?: boolean };
  const isOwner = viewer.role === "owner";
  const today = todayInTimeZone(viewer.academy.timezone);

  return await asViewer(viewer, async (client) => {
    const groups = await client.query<AgeGroupRow>(
      `${AGE_GROUP_SELECT}
       ${includeArchived ? "" : "where archived_at is null"}
       order by sort_order asc, name asc`,
    );

    // One query per derived field for the whole page — never one per row (DATABASE §9).
    const fees = new Map<string, number>();
    const counts = new Map<string, number>();
    const ids = groups.rows.map((g) => g.id);
    if (isOwner && ids.length > 0) {
      const feeRows = await client.query<{ age_group_id: string; amount_minor: string }>(
        `select distinct on (age_group_id) age_group_id, amount_minor
           from group_fees
          where age_group_id = any ($1::uuid[])
            and effective_from <= $2::date
            and (effective_to is null or effective_to >= $2::date)
          order by age_group_id, effective_from desc`,
        [ids, today],
      );
      for (const row of feeRows.rows) fees.set(row.age_group_id, Number(row.amount_minor));

      const countRows = await client.query<{ age_group_id: string; count: string }>(
        ACTIVE_PLAYER_COUNTS,
        [ids],
      );
      for (const row of countRows.rows) counts.set(row.age_group_id, Number(row.count));
    }

    return {
      status: 200,
      body: {
        data: groups.rows.map((group) =>
          serializeAgeGroup(
            group,
            isOwner
              ? { currentFeeMinor: fees.get(group.id) ?? null, activePlayerCount: counts.get(group.id) ?? 0 }
              : {},
          ),
        ),
      },
    };
  });
};

export const grp02Create: Handler = async ({ ctx, viewer, body }): Promise<HandlerResult> => {
  const input = body as { name: string; minAge?: number; maxAge?: number; sortOrder?: number };
  const id = uuidv7();

  try {
    return await withTransaction({ userId: viewer.userId, role: viewer.role }, async (client) => {
      const inserted = await client.query<AgeGroupRow>(
        `insert into age_groups (id, name, min_age, max_age, sort_order)
         values ($1, $2, $3, $4, $5)
         returning id, name, min_age, max_age, sort_order, archived_at`,
        [
          id,
          input.name.normalize("NFC").trim(),
          input.minAge ?? null,
          input.maxAge ?? null,
          input.sortOrder ?? 0,
        ],
      );
      const row = inserted.rows[0]!;
      await audit.record(client, viewerAudit(viewer, ctx), {
        action: "age_group.create",
        entityType: "age_group",
        entityId: id,
        after: serializeAgeGroup(row),
      });
      return { status: 201, body: serializeAgeGroup(row) };
    });
  } catch (err) {
    mapPgError(err);
  }
};

export const grp03Read: Handler = async ({ viewer, params }): Promise<HandlerResult> => {
  const { id } = params as { id: string };
  const isOwner = viewer.role === "owner";
  const today = todayInTimeZone(viewer.academy.timezone);

  return await asViewer(viewer, async (client) => {
    const found = await client.query<AgeGroupRow>(`${AGE_GROUP_SELECT} where id = $1`, [id]);
    const row = found.rows[0];
    if (!row) throw errors.notFound();
    if (!isOwner) return { status: 200, body: serializeAgeGroup(row) };

    return {
      status: 200,
      body: serializeAgeGroup(row, {
        currentFeeMinor: await currentFeeMinor(client, id, today),
        activePlayerCount: await activePlayerCount(client, id),
      }),
    };
  });
};

export const grp03Update: Handler = async ({ ctx, viewer, params, body }): Promise<HandlerResult> => {
  const { id } = params as { id: string };
  const input = body as { name?: string; minAge?: number; maxAge?: number; sortOrder?: number };

  try {
    return await withTransaction({ userId: viewer.userId, role: viewer.role }, async (client) => {
      const before = await client.query<AgeGroupRow>(`${AGE_GROUP_SELECT} where id = $1`, [id]);
      const existing = before.rows[0];
      if (!existing) throw errors.notFound();

      const updated = await client.query<AgeGroupRow>(
        `update age_groups
            set name = coalesce($2, name),
                min_age = case when $3::boolean then $4 else min_age end,
                max_age = case when $5::boolean then $6 else max_age end,
                sort_order = coalesce($7, sort_order)
          where id = $1
        returning id, name, min_age, max_age, sort_order, archived_at`,
        [
          id,
          input.name === undefined ? null : input.name.normalize("NFC").trim(),
          input.minAge !== undefined,
          input.minAge ?? null,
          input.maxAge !== undefined,
          input.maxAge ?? null,
          input.sortOrder ?? null,
        ],
      );
      const row = updated.rows[0]!;
      await audit.record(client, viewerAudit(viewer, ctx), {
        action: "age_group.update",
        entityType: "age_group",
        entityId: id,
        before: serializeAgeGroup(existing),
        after: serializeAgeGroup(row),
      });
      return { status: 200, body: serializeAgeGroup(row) };
    });
  } catch (err) {
    mapPgError(err);
  }
};

export const grp04Archive: Handler = async ({ ctx, viewer, params }): Promise<HandlerResult> => {
  const { id } = params as { id: string };

  try {
    return await withTransaction({ userId: viewer.userId, role: viewer.role }, async (client) => {
      const before = await client.query<AgeGroupRow>(`${AGE_GROUP_SELECT} where id = $1`, [id]);
      const existing = before.rows[0];
      if (!existing) throw errors.notFound();

      if ((await activePlayerCount(client, id)) > 0) {
        throw new ApiError(
          "AGE_GROUP_HAS_ACTIVE_PLAYERS",
          "This group still has active players. Move them to another group first.",
        );
      }

      const updated = await client.query<AgeGroupRow>(
        `update age_groups set archived_at = coalesce(archived_at, now())
          where id = $1
        returning id, name, min_age, max_age, sort_order, archived_at`,
        [id],
      );
      const row = updated.rows[0]!;
      await audit.record(client, viewerAudit(viewer, ctx), {
        action: "age_group.archive",
        entityType: "age_group",
        entityId: id,
        before: serializeAgeGroup(existing),
        after: serializeAgeGroup(row),
      });
      return { status: 200, body: serializeAgeGroup(row) };
    });
  } catch (err) {
    mapPgError(err);
  }
};

export const grp04Unarchive: Handler = async ({ ctx, viewer, params }): Promise<HandlerResult> => {
  const { id } = params as { id: string };

  try {
    return await withTransaction({ userId: viewer.userId, role: viewer.role }, async (client) => {
      const before = await client.query<AgeGroupRow>(`${AGE_GROUP_SELECT} where id = $1`, [id]);
      const existing = before.rows[0];
      if (!existing) throw errors.notFound();

      const updated = await client.query<AgeGroupRow>(
        `update age_groups set archived_at = null
          where id = $1
        returning id, name, min_age, max_age, sort_order, archived_at`,
        [id],
      );
      const row = updated.rows[0]!;
      await audit.record(client, viewerAudit(viewer, ctx), {
        action: "age_group.unarchive",
        entityType: "age_group",
        entityId: id,
        before: serializeAgeGroup(existing),
        after: serializeAgeGroup(row),
      });
      return { status: 200, body: serializeAgeGroup(row) };
    });
  } catch (err) {
    mapPgError(err);
  }
};

export const grp05Suggest: Handler = async ({ viewer, query }): Promise<HandlerResult> => {
  const { dateOfBirth } = query as { dateOfBirth: string };

  return await asViewer(viewer, async (client) => {
    const settings = await loadAcademySettings(client);
    const today = todayInTimeZone(settings.timezone);
    const referenceDate = ageReferenceDate(
      settings.age_reference_rule,
      settings.age_reference_month_day,
      today,
    );
    const ageOnReference = ageOn(dateOfBirth, referenceDate);

    const groups = await client.query<{ id: string; name: string }>(
      `select id, name
         from age_groups
        where archived_at is null
          and (min_age is null or $1 >= min_age)
          and (max_age is null or $1 <= max_age)
        order by sort_order asc, name asc`,
      [ageOnReference],
    );

    return {
      status: 200,
      body: {
        referenceDate,
        ageOnReference,
        suggestions: groups.rows.map((g) => ({ ageGroupId: g.id, name: g.name })),
      },
    };
  });
};

// ---------------------------------------------------------------------------
// FEE-01/02 — the fee history of a group
// ---------------------------------------------------------------------------
export const fee01List: Handler = async ({ viewer, params }): Promise<HandlerResult> => {
  const { id } = params as { id: string };

  return await asViewer(viewer, async (client) => {
    const rows = await client.query<GroupFeeRow>(
      `select id, age_group_id, amount_minor, effective_from, effective_to
         from group_fees
        where age_group_id = $1
        order by effective_from desc, id desc`,
      [id],
    );
    // An empty history is a valid answer; an unknown group is not.
    if (rows.rows.length === 0) {
      const group = await client.query("select 1 from age_groups where id = $1", [id]);
      if (!group.rows[0]) throw errors.notFound();
    }
    return { status: 200, body: { data: rows.rows.map(serializeGroupFee) } };
  });
};

/**
 * FEE-02 closes the current fee row and inserts the new one (T6). Wrapped in
 * `withIdempotency` because a retried change must not open a second row.
 */
const fee02Change: Handler = async ({ ctx, viewer, params, body }): Promise<HandlerResult> => {
  const { id } = params as { id: string };
  const input = body as { amountMinor: number; effectiveFrom: string; allowPast?: boolean };

  try {
    return await withTransaction({ userId: viewer.userId, role: viewer.role }, async (client) => {
      // Lock the group first so two changes cannot produce overlapping ranges.
      const group = await client.query<{ id: string }>(
        "select id from age_groups where id = $1 for update",
        [id],
      );
      if (!group.rows[0]) throw errors.notFound();

      const today = todayInTimeZone(viewer.academy.timezone);
      if (input.effectiveFrom < today && input.allowPast !== true) {
        throw errors.validation([
          {
            field: "effectiveFrom",
            issue: "Choose today or a later date, or confirm a past date.",
          },
        ]);
      }

      const open = await client.query<{ id: string; effective_from: Date }>(
        `select id, effective_from
           from group_fees
          where age_group_id = $1 and effective_to is null
          order by effective_from desc
          limit 1
          for update`,
        [id],
      );
      const current = open.rows[0];
      if (current) {
        // Closing the current row with an inclusive end date (newFrom − 1 day).
        if (input.effectiveFrom <= dateStr(current.effective_from)!) {
          throw new ApiError(
            "FEE_OVERLAP",
            "This group already has a fee covering that period. Choose a later start date.",
          );
        }
        await client.query(
          "update group_fees set effective_to = ($2::date - 1) where id = $1",
          [current.id, input.effectiveFrom],
        );
      }

      const inserted = await client.query<GroupFeeRow>(
        `insert into group_fees (id, age_group_id, amount_minor, effective_from, created_by)
         values ($1, $2, $3, $4, $5)
         returning id, age_group_id, amount_minor, effective_from, effective_to`,
        [uuidv7(), id, input.amountMinor, input.effectiveFrom, viewer.userId],
      );
      const row = inserted.rows[0]!;
      await audit.record(client, viewerAudit(viewer, ctx), {
        action: "group_fee.create",
        entityType: "group_fee",
        entityId: row.id,
        after: serializeGroupFee(row),
      });
      return { status: 201, body: serializeGroupFee(row) };
    });
  } catch (err) {
    if (isPgError(err) && err.code === "23P01") {
      throw new ApiError(
        "FEE_OVERLAP",
        "This group already has a fee covering that period. Choose a later start date.",
      );
    }
    mapPgError(err);
  }
};

export const fee02Create: Handler = withIdempotency(fee02Change);

// ---------------------------------------------------------------------------
// CCH-01..05 — coach assignments
// ---------------------------------------------------------------------------
export const cch01List: Handler = async ({ viewer, query }): Promise<HandlerResult> => {
  const { page, pageSize, q } = query as { page: number; pageSize: number; q?: string };
  const today = todayInTimeZone(viewer.academy.timezone);

  return await asViewer(viewer, async (client) => {
    const filters: string[] = ["role = 'coach'"];
    const values: unknown[] = [];
    if (q) {
      values.push(`%${q}%`);
      filters.push(`(full_name ilike $${values.length} or username::text ilike $${values.length})`);
    }
    const where = `where ${filters.join(" and ")}`;

    const totalResult = await client.query<{ total: string }>(
      `select count(*)::text as total from users ${where}`,
      values,
    );
    const rows = await client.query<UserRow>(
      `${COACH_SELECT} ${where} order by full_name asc, id asc
        limit $${values.length + 1} offset $${values.length + 2}`,
      [...values, pageSize, (page - 1) * pageSize],
    );

    const groupsByCoach = new Map<string, { id: string; name: string }[]>();
    const ids = rows.rows.map((r) => r.id);
    if (ids.length > 0) {
      const groupRows = await client.query<{ coach_user_id: string; id: string; name: string }>(
        `select a.coach_user_id, g.id, g.name
           from coach_group_assignments a
           join age_groups g on g.id = a.age_group_id
          where a.coach_user_id = any ($1::uuid[])
            and a.assigned_from <= $2::date
            and (a.assigned_to is null or a.assigned_to >= $2::date)
          order by g.name asc`,
        [ids, today],
      );
      for (const row of groupRows.rows) {
        const list = groupsByCoach.get(row.coach_user_id) ?? [];
        list.push({ id: row.id, name: row.name });
        groupsByCoach.set(row.coach_user_id, list);
      }
    }

    const total = Number(totalResult.rows[0]?.total ?? 0);
    return {
      status: 200,
      body: {
        data: rows.rows.map((user) => serializeCoachRow(user, groupsByCoach.get(user.id) ?? [])),
        meta: {
          page,
          pageSize,
          total,
          totalPages: pageSize > 0 ? Math.ceil(total / pageSize) : 0,
        },
      },
    };
  });
};

export const cch02List: Handler = async ({ viewer, query }): Promise<HandlerResult> => {
  const { coachUserId, ageGroupId, activeOn } = query as {
    coachUserId?: string;
    ageGroupId?: string;
    activeOn?: string;
  };

  return await asViewer(viewer, async (client) => {
    const filters: string[] = [];
    const values: unknown[] = [];
    if (coachUserId) {
      values.push(coachUserId);
      filters.push(`a.coach_user_id = $${values.length}`);
    }
    if (ageGroupId) {
      values.push(ageGroupId);
      filters.push(`a.age_group_id = $${values.length}`);
    }
    if (activeOn) {
      values.push(activeOn);
      filters.push(
        `a.assigned_from <= $${values.length}::date
         and (a.assigned_to is null or a.assigned_to >= $${values.length}::date)`,
      );
    }

    const rows = await client.query<CoachAssignmentRow>(
      `select a.id, a.coach_user_id, u.full_name as coach_name, a.age_group_id,
              g.name as age_group_name, a.assigned_from, a.assigned_to
         from coach_group_assignments a
         join users u on u.id = a.coach_user_id
         join age_groups g on g.id = a.age_group_id
         ${filters.length ? `where ${filters.join(" and ")}` : ""}
        order by a.assigned_from desc, a.id desc`,
      values,
    );
    return { status: 200, body: { data: rows.rows.map(serializeCoachAssignment) } };
  });
};

export const cch03Create: Handler = async ({ ctx, viewer, body }): Promise<HandlerResult> => {
  const input = body as { coachUserId: string; ageGroupId: string; assignedFrom: string };

  try {
    return await withTransaction({ userId: viewer.userId, role: viewer.role }, async (client) => {
      const coach = await client.query<{ id: string }>(
        "select id from users where id = $1 and role = 'coach'",
        [input.coachUserId],
      );
      if (!coach.rows[0]) throw errors.notFound();
      const group = await client.query<{ id: string }>("select id from age_groups where id = $1", [
        input.ageGroupId,
      ]);
      if (!group.rows[0]) throw errors.notFound();

      const id = uuidv7();
      const inserted = await client.query<CoachAssignmentRow>(
        `with ins as (
           insert into coach_group_assignments
             (id, coach_user_id, age_group_id, assigned_from, created_by)
           values ($1, $2, $3, $4, $5)
           returning id, coach_user_id, age_group_id, assigned_from, assigned_to
         )
         select ins.id, ins.coach_user_id, u.full_name as coach_name, ins.age_group_id,
                g.name as age_group_name, ins.assigned_from, ins.assigned_to
           from ins
           join users u on u.id = ins.coach_user_id
           join age_groups g on g.id = ins.age_group_id`,
        [id, input.coachUserId, input.ageGroupId, input.assignedFrom, viewer.userId],
      );
      const row = inserted.rows[0]!;
      await audit.record(client, viewerAudit(viewer, ctx), {
        action: "coach_assignment.create",
        entityType: "coach_assignment",
        entityId: id,
        after: serializeCoachAssignment(row),
      });
      return { status: 201, body: serializeCoachAssignment(row) };
    });
  } catch (err) {
    if (isPgError(err) && err.code === "23P01") {
      throw new ApiError(
        "INVALID_STATE_TRANSITION",
        "That coach already covers this group in an overlapping period.",
      );
    }
    mapPgError(err);
  }
};

export const cch04End: Handler = async ({ ctx, viewer, params, body }): Promise<HandlerResult> => {
  const { id } = params as { id: string };
  const { assignedTo } = body as { assignedTo: string };

  try {
    return await withTransaction({ userId: viewer.userId, role: viewer.role }, async (client) => {
      const before = await client.query<{ id: string; assigned_from: Date; assigned_to: Date | null }>(
        "select id, assigned_from, assigned_to from coach_group_assignments where id = $1 for update",
        [id],
      );
      const existing = before.rows[0];
      if (!existing) throw errors.notFound();
      if (assignedTo < dateStr(existing.assigned_from)!) {
        throw errors.validation([
          { field: "assignedTo", issue: "The end date cannot be before the start date." },
        ]);
      }

      const updated = await client.query<CoachAssignmentRow>(
        `with upd as (
           update coach_group_assignments
              set assigned_to = $2::date
            where id = $1
           returning id, coach_user_id, age_group_id, assigned_from, assigned_to
         )
         select upd.id, upd.coach_user_id, u.full_name as coach_name, upd.age_group_id,
                g.name as age_group_name, upd.assigned_from, upd.assigned_to
           from upd
           join users u on u.id = upd.coach_user_id
           join age_groups g on g.id = upd.age_group_id`,
        [id, assignedTo],
      );
      const row = updated.rows[0]!;
      await audit.record(client, viewerAudit(viewer, ctx), {
        action: "coach_assignment.end",
        entityType: "coach_assignment",
        entityId: id,
        before: { assignedFrom: dateStr(existing.assigned_from), assignedTo: dateStr(existing.assigned_to) },
        after: serializeCoachAssignment(row),
      });
      return { status: 200, body: serializeCoachAssignment(row) };
    });
  } catch (err) {
    if (isPgError(err) && err.code === "23P01") {
      throw new ApiError(
        "INVALID_STATE_TRANSITION",
        "That end date would overlap another assignment for the same coach and group.",
      );
    }
    mapPgError(err);
  }
};

export const cch05MyGroups: Handler = async ({ viewer }): Promise<HandlerResult> => {
  const today = todayInTimeZone(viewer.academy.timezone);

  return await asViewer(viewer, async (client) => {
    const rows = await client.query<{ id: string; name: string; player_count: string }>(
      `select g.id, g.name,
              (select count(*)::text
                 from player_group_history h
                 join players p on p.id = h.player_id
                where h.age_group_id = g.id
                  and h.effective_to is null
                  and p.status = 'active') as player_count
         from coach_group_assignments a
         join age_groups g on g.id = a.age_group_id
        where a.coach_user_id = $1
          and a.assigned_from <= $2::date
          and (a.assigned_to is null or a.assigned_to >= $2::date)
        order by g.name asc`,
      [viewer.userId, today],
    );
    return {
      status: 200,
      body: {
        data: rows.rows.map((row) => ({
          id: row.id,
          name: row.name,
          playerCount: Number(row.player_count),
        })),
      },
    };
  });
};

