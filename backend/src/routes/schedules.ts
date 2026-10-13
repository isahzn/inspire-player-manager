/**
 * SCH-01 (list/create/update/deactivate) and SCH-02 (generate) — recurring training
 * schedules (API_CONTRACTS §3.5, M4).
 *
 * A schedule is a **rule**, never the sessions themselves: creating or editing one
 * rewrites no existing session. Only SCH-02 writes sessions, and it writes nothing that
 * already exists — `(schedule_id, session_date)` is unique in the database, so a second
 * run of the same range is a no-op and a manually edited session is never overwritten
 * (T-ATT-01).
 *
 * The one place an academy-local wall-clock time becomes a real instant is the generator,
 * and it happens in SQL (`(date + time) at time zone academy_settings.timezone`). The API
 * never guesses a UTC offset, which is why no date arithmetic appears in this file.
 */
import { withTransaction } from "../db/pool.js";
import { errors } from "../errors.js";
import { mapPgError } from "../db/pg-errors.js";
import * as audit from "../audit.js";
import { uuidv7 } from "../ids.js";
import { asViewer } from "../http/context.js";
import { withIdempotency } from "../http/idempotency.js";
import type { Handler, HandlerResult } from "../http/router.js";
import { viewerAudit } from "./auth.js";
import { dateStr } from "./people-serialize.js";
import { serializeTrainingSchedule, type TrainingScheduleRow } from "./attendance-serialize.js";

/** Joined read of a schedule; `time` columns arrive as `HH:mm:ss` and are trimmed by the serializer. */
const SCHEDULE_SELECT = `select s.id, s.age_group_id, g.name as age_group_name, s.weekday,
                                s.start_time, s.end_time, s.venue, s.valid_from, s.valid_to,
                                s.is_active
                           from training_schedules s
                           join age_groups g on g.id = s.age_group_id`;

const DAY_MS = 86_400_000;
const MAX_GENERATE_DAYS = 90;

interface ScheduleInput {
  ageGroupId?: string;
  weekday?: number;
  startTime?: string;
  endTime?: string;
  venue?: string;
  validFrom?: string;
  validTo?: string;
  isActive?: boolean;
}

export const sch01List: Handler = async ({ viewer, query }): Promise<HandlerResult> => {
  const { ageGroupId, includeInactive } = query as {
    ageGroupId?: string;
    includeInactive?: boolean;
  };

  const filters: string[] = [];
  const values: unknown[] = [];
  if (ageGroupId) {
    values.push(ageGroupId);
    filters.push(`s.age_group_id = $${values.length}`);
  }
  if (includeInactive !== true) filters.push("s.is_active");

  return await asViewer(viewer, async (client) => {
    const rows = await client.query<TrainingScheduleRow>(
      `${SCHEDULE_SELECT}
       ${filters.length ? `where ${filters.join(" and ")}` : ""}
       order by s.weekday asc, s.start_time asc, s.id asc`,
      values,
    );
    return { status: 200, body: { data: rows.rows.map(serializeTrainingSchedule) } };
  });
};

export const sch01Create: Handler = async ({ ctx, viewer, body }): Promise<HandlerResult> => {
  const input = body as Required<Pick<ScheduleInput, "ageGroupId" | "weekday" | "startTime" | "endTime" | "validFrom">> &
    ScheduleInput;

  try {
    return await withTransaction({ userId: viewer.userId, role: viewer.role }, async (client) => {
      const group = await client.query<{ id: string }>(
        "select id from age_groups where id = $1",
        [input.ageGroupId],
      );
      if (!group.rows[0]) throw errors.notFound();

      const id = uuidv7();
      const inserted = await client.query<TrainingScheduleRow>(
        `with ins as (
           insert into training_schedules
             (id, age_group_id, weekday, start_time, end_time, venue, valid_from, valid_to, created_by)
           values ($1, $2, $3, $4::time, $5::time, $6, $7::date, $8::date, $9)
           returning id, age_group_id, weekday, start_time, end_time, venue, valid_from, valid_to, is_active
         )
         select ins.id, ins.age_group_id, g.name as age_group_name, ins.weekday, ins.start_time,
                ins.end_time, ins.venue, ins.valid_from, ins.valid_to, ins.is_active
           from ins
           join age_groups g on g.id = ins.age_group_id`,
        [
          id,
          input.ageGroupId,
          input.weekday,
          input.startTime,
          input.endTime,
          input.venue ?? null,
          input.validFrom,
          input.validTo ?? null,
          viewer.userId,
        ],
      );
      const row = inserted.rows[0]!;
      await audit.record(client, viewerAudit(viewer, ctx), {
        action: "training_schedule.create",
        entityType: "training_schedule",
        entityId: id,
        after: serializeTrainingSchedule(row),
      });
      return { status: 201, body: serializeTrainingSchedule(row) };
    });
  } catch (err) {
    mapPgError(err);
  }
};

export const sch01Update: Handler = async ({ ctx, viewer, params, body }): Promise<HandlerResult> => {
  const { id } = params as { id: string };
  const input = body as ScheduleInput;

  try {
    return await withTransaction({ userId: viewer.userId, role: viewer.role }, async (client) => {
      const beforeResult = await client.query<TrainingScheduleRow>(
        `${SCHEDULE_SELECT} where s.id = $1`,
        [id],
      );
      const before = beforeResult.rows[0];
      if (!before) throw errors.notFound();

      const updated = await client.query<TrainingScheduleRow>(
        `with upd as (
           update training_schedules
              set start_time = case when $2::boolean then $3::time else start_time end,
                  end_time   = case when $4::boolean then $5::time else end_time end,
                  venue      = case when $6::boolean then $7::text else venue end,
                  valid_from = case when $8::boolean then $9::date else valid_from end,
                  valid_to   = case when $10::boolean then $11::date else valid_to end,
                  is_active  = coalesce($12, is_active)
            where id = $1
           returning id, age_group_id, weekday, start_time, end_time, venue, valid_from, valid_to, is_active
         )
         select upd.id, upd.age_group_id, g.name as age_group_name, upd.weekday, upd.start_time,
                upd.end_time, upd.venue, upd.valid_from, upd.valid_to, upd.is_active
           from upd
           join age_groups g on g.id = upd.age_group_id`,
        [
          id,
          input.startTime !== undefined,
          input.startTime ?? null,
          input.endTime !== undefined,
          input.endTime ?? null,
          input.venue !== undefined,
          input.venue ?? null,
          input.validFrom !== undefined,
          input.validFrom ?? null,
          input.validTo !== undefined,
          input.validTo ?? null,
          input.isActive ?? null,
        ],
      );
      const row = updated.rows[0]!;
      await audit.record(client, viewerAudit(viewer, ctx), {
        action: "training_schedule.update",
        entityType: "training_schedule",
        entityId: id,
        before: serializeTrainingSchedule(before),
        after: serializeTrainingSchedule(row),
      });
      return { status: 200, body: serializeTrainingSchedule(row) };
    });
  } catch (err) {
    mapPgError(err);
  }
};

export const sch01Deactivate: Handler = async ({ ctx, viewer, params }): Promise<HandlerResult> => {
  const { id } = params as { id: string };

  try {
    return await withTransaction({ userId: viewer.userId, role: viewer.role }, async (client) => {
      const beforeResult = await client.query<TrainingScheduleRow>(
        `${SCHEDULE_SELECT} where s.id = $1`,
        [id],
      );
      const before = beforeResult.rows[0];
      if (!before) throw errors.notFound();

      // Existing sessions are untouched; only future generation stops.
      const updated = await client.query<TrainingScheduleRow>(
        `with upd as (
           update training_schedules set is_active = false
            where id = $1
           returning id, age_group_id, weekday, start_time, end_time, venue, valid_from, valid_to, is_active
         )
         select upd.id, upd.age_group_id, g.name as age_group_name, upd.weekday, upd.start_time,
                upd.end_time, upd.venue, upd.valid_from, upd.valid_to, upd.is_active
           from upd
           join age_groups g on g.id = upd.age_group_id`,
        [id],
      );
      const row = updated.rows[0]!;
      await audit.record(client, viewerAudit(viewer, ctx), {
        action: "training_schedule.deactivate",
        entityType: "training_schedule",
        entityId: id,
        before: serializeTrainingSchedule(before),
        after: serializeTrainingSchedule(row),
      });
      return { status: 200, body: serializeTrainingSchedule(row) };
    });
  } catch (err) {
    mapPgError(err);
  }
};

interface GenerateInput {
  from: string;
  to: string;
}

const generate: Handler = async ({ ctx, viewer, params, body }): Promise<HandlerResult> => {
  const { id } = params as { id: string };
  const input = body as GenerateInput;

  try {
    return await withTransaction({ userId: viewer.userId, role: viewer.role }, async (client) => {
      const found = await client.query<{
        id: string;
        age_group_id: string;
        weekday: number;
        start_time: string;
        end_time: string;
        venue: string | null;
        valid_from: Date;
        valid_to: Date | null;
        is_active: boolean;
      }>(
        `select id, age_group_id, weekday, start_time, end_time, venue, valid_from, valid_to, is_active
           from training_schedules
          where id = $1`,
        [id],
      );
      const schedule = found.rows[0];
      if (!schedule) throw errors.notFound();

      if (input.to < input.from) {
        throw errors.validation([{ field: "to", issue: "The end date cannot be before the start date." }]);
      }
      const spanDays = (Date.parse(`${input.to}T00:00:00Z`) - Date.parse(`${input.from}T00:00:00Z`)) / DAY_MS;
      if (spanDays > MAX_GENERATE_DAYS) {
        throw errors.validation([
          { field: "to", issue: `Generate at most ${MAX_GENERATE_DAYS} days at a time.` },
        ]);
      }
      if (!schedule.is_active) {
        throw errors.validation([
          { field: "id", issue: "This schedule is deactivated, so it generates no sessions." },
        ]);
      }

      // The matching dates are computed by the database, so the ISO weekday and the
      // academy-local date agree by construction.
      const days = await client.query<{ day: Date }>(
        `select d::date as day
           from generate_series($1::date, $2::date, interval '1 day') d
          where extract(isodow from d) = $3
            and d::date >= $4::date
            and ($5::date is null or d::date <= $5::date)
          order by d asc`,
        [input.from, input.to, schedule.weekday, schedule.valid_from, schedule.valid_to],
      );

      const timezone = viewer.academy.timezone;
      let created = 0;
      for (const row of days.rows) {
        // `on conflict do nothing` with no target honours both unique indexes: the
        // schedule/date one makes this idempotent, the group/instant one refuses to
        // collide with a one-off session someone already created.
        const inserted = await client.query(
          `insert into sessions
             (id, age_group_id, schedule_id, session_date, starts_at, ends_at, venue, status, created_by)
           values ($1, $2, $3, $4::date,
                   (($4::date + $5::time) at time zone $8),
                   (($4::date + $6::time) at time zone $8),
                   $7, 'scheduled', $9)
           on conflict do nothing`,
          [
            uuidv7(),
            schedule.age_group_id,
            schedule.id,
            dateStr(row.day)!,
            schedule.start_time,
            schedule.end_time,
            schedule.venue,
            timezone,
            viewer.userId,
          ],
        );
        if (inserted.rowCount === 1) created += 1;
      }

      const skipped = days.rows.length - created;
      await audit.record(client, viewerAudit(viewer, ctx), {
        action: "session.generate",
        entityType: "training_schedule",
        entityId: schedule.id,
        after: { created, skipped, from: input.from, to: input.to },
      });
      return { status: 200, body: { created, skipped } };
    });
  } catch (err) {
    mapPgError(err);
  }
};

/** SCH-02 is idempotent: the same range with the same key cannot create a second batch. */
export const sch02Generate: Handler = withIdempotency(generate);
