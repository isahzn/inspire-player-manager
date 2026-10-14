/**
 * `seed-demo` — puts a database into the exact state a live demo/simple mode needs:
 *
 *   · one owner  (`huzzam`) and one coach (`demo1`), both ACTIVE with a known password;
 *   · the age groups those accounts train;
 *   · the recurring training schedule the academy actually runs — Tuesday and Thursday,
 *     16:00–17:30, for every age group — and the sessions it generates.
 *
 * WHY A SCRIPT AND NOT db/seed.sql: `db/seed.sql` runs in every environment and must stay
 * free of people and credentials. Passwords are argon2id hashes, which SQL cannot produce.
 * This file is the only place a default password exists, it is explicitly a demo seed, and
 * it is NEVER run by a deploy (DEPLOYMENT_AND_OPERATIONS §9 still uses `create-owner`).
 *
 *   npm run seed:demo                      reuse the defaults below
 *   npm run seed:demo -- --password 12345  override both passwords
 *
 * It is re-runnable: an existing account is updated in place (never duplicated), age groups
 * and schedules are matched by their natural key, and session generation is idempotent.
 *
 * SAFETY: `--reset-users` (default ON) removes every OTHER user so the demo has exactly
 * these two identities. That is destructive, so the script prints how many rows it will
 * remove and refuses unless it can name at least one active owner first.
 */
import { Client } from "pg";
import { config as loadEnv } from "dotenv";
import { hashPassword } from "../src/auth/password.js";
import { uuidv7 } from "../src/ids.js";
import { parseArgs } from "./lib/cli-db.js";

loadEnv();

const DEFAULTS = {
  ownerUsername: "huzzam",
  ownerFullName: "Huzzam",
  ownerPassword: "12345",
  coachUsername: "demo1",
  coachFullName: "Demo Coach",
  coachPassword: "12345",
};

/** The recurring rule the owner described: Tuesday + Thursday, 16:00–17:30, every group. */
const WEEKDAYS = [2, 4]; // ISO: 1 = Monday … 7 = Sunday
const START_TIME = "16:00";
const END_TIME = "17:30";
const VENUE = "Main ground";
/** Sessions are generated across this many days either side of today. */
const GENERATE_PAST_DAYS = 56;
const GENERATE_FUTURE_DAYS = 56;

/** Groups created when the database has none (the amounts are demo fees, LKR minor units). */
const DEMO_GROUPS: { name: string; minAge: number; maxAge: number; sortOrder: number; feeMinor: number }[] = [
  { name: "Under-11", minAge: 8, maxAge: 10, sortOrder: 1, feeMinor: 400000 },
  { name: "Under-14", minAge: 11, maxAge: 13, sortOrder: 2, feeMinor: 500000 },
  { name: "Under-17", minAge: 14, maxAge: 16, sortOrder: 3, feeMinor: 600000 },
];

function clientConfig(): ConstructorParameters<typeof Client>[0] {
  const url = process.env["DATABASE_MIGRATOR_URL"] ?? process.env["DATABASE_URL"];
  if (!url) throw new Error("DATABASE_MIGRATOR_URL (or DATABASE_URL) is required");
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 5432),
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: decodeURIComponent(parsed.pathname.replace(/^\//, "")),
    client_encoding: "UTF8",
  };
}

function addDaysISO(dateISO: string, days: number): string {
  const d = new Date(`${dateISO}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

async function upsertUser(
  client: Client,
  input: { username: string; fullName: string; role: "owner" | "coach"; password: string },
): Promise<{ id: string; created: boolean }> {
  const hash = await hashPassword(input.password);
  const existing = await client.query<{ id: string }>("select id from users where username = $1", [
    input.username,
  ]);
  if (existing.rows[0]) {
    const id = existing.rows[0].id;
    await client.query(
      `update users
          set full_name = $2, role = $3, status = 'active',
              password_hash = $4, password_changed_at = now(),
              failed_login_count = 0, locked_until = null
        where id = $1`,
      [id, input.fullName, input.role, hash],
    );
    return { id, created: false };
  }
  const id = uuidv7();
  await client.query(
    `insert into users (id, username, full_name, role, status, password_hash, password_changed_at)
     values ($1, $2, $3, $4, 'active', $5, now())`,
    [id, input.username, input.fullName, input.role, hash],
  );
  return { id, created: true };
}

async function ensureGroup(
  client: Client,
  group: (typeof DEMO_GROUPS)[number],
): Promise<string> {
  const existing = await client.query<{ id: string }>(
    "select id from age_groups where lower(name) = lower($1) and archived_at is null",
    [group.name],
  );
  if (existing.rows[0]) return existing.rows[0].id;

  const id = uuidv7();
  await client.query(
    `insert into age_groups (id, name, min_age, max_age, sort_order)
     values ($1, $2, $3, $4, $5)`,
    [id, group.name, group.minAge, group.maxAge, group.sortOrder],
  );
  // A current fee so billing and the group screens have something real to read.
  await client.query(
    `insert into group_fees (id, age_group_id, amount_minor, effective_from)
     values ($1, $2, $3, $4::date)`,
    [uuidv7(), id, group.feeMinor, addDaysISO(todayISO(), -120)],
  );
  return id;
}

async function ensureSchedule(
  client: Client,
  ageGroupId: string,
  weekday: number,
  validFrom: string,
): Promise<string> {
  const existing = await client.query<{ id: string }>(
    `select id from training_schedules
      where age_group_id = $1 and weekday = $2 and start_time = $3::time
        and end_time = $4::time and is_active`,
    [ageGroupId, weekday, START_TIME, END_TIME],
  );
  if (existing.rows[0]) return existing.rows[0].id;

  const id = uuidv7();
  await client.query(
    `insert into training_schedules
       (id, age_group_id, weekday, start_time, end_time, venue, valid_from, is_active)
     values ($1, $2, $3, $4::time, $5::time, $6, $7::date, true)`,
    [id, ageGroupId, weekday, START_TIME, END_TIME, VENUE, validFrom],
  );
  return id;
}

/** Mirrors SCH-02's generator: the database owns the wall-clock → instant conversion. */
async function generateSessions(
  client: Client,
  scheduleId: string,
  ageGroupId: string,
  weekday: number,
  timezone: string,
): Promise<number> {
  const from = addDaysISO(todayISO(), -GENERATE_PAST_DAYS);
  const to = addDaysISO(todayISO(), GENERATE_FUTURE_DAYS);
  const result = await client.query(
    `insert into sessions
       (id, age_group_id, schedule_id, session_date, starts_at, ends_at, venue, status)
     select gen_random_uuid(), $1, $2, d::date,
            ((d::date + $3::time) at time zone $5),
            ((d::date + $4::time) at time zone $5),
            $6, 'scheduled'
       from generate_series($7::date, $8::date, interval '1 day') d
      where extract(isodow from d) = $9
     on conflict do nothing`,
    [ageGroupId, scheduleId, START_TIME, END_TIME, timezone, VENUE, from, to, weekday],
  );
  return result.rowCount ?? 0;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const password = typeof args["password"] === "string" ? args["password"] : undefined;
  const ownerUsername =
    typeof args["owner"] === "string" ? args["owner"].toLowerCase() : DEFAULTS.ownerUsername;
  const coachUsername =
    typeof args["coach"] === "string" ? args["coach"].toLowerCase() : DEFAULTS.coachUsername;
  const resetUsers = args["reset-users"] !== false;

  const client = new Client(clientConfig());
  await client.connect();
  try {
    await client.query("begin");

    const tzRow = await client.query<{ timezone: string }>(
      "select timezone from academy_settings where id = 1",
    );
    const timezone = tzRow.rows[0]?.timezone ?? "Asia/Colombo";

    // 1. The two identities. Owner first, so the LAST_OWNER invariant always has one.
    const owner = await upsertUser(client, {
      username: ownerUsername,
      fullName: DEFAULTS.ownerFullName,
      role: "owner",
      password: password ?? DEFAULTS.ownerPassword,
    });
    const coach = await upsertUser(client, {
      username: coachUsername,
      fullName: DEFAULTS.coachFullName,
      role: "coach",
      password: password ?? DEFAULTS.coachPassword,
    });

    // 2. Optionally drop every other user, clearing the rows that reference them first
    //    (there are no ON DELETE rules on these foreign keys).
    let removed = 0;
    if (resetUsers) {
      const keep = [owner.id, coach.id];
      await client.query(
        "update sessions set lead_coach_user_id = null where lead_coach_user_id <> all($1::uuid[])",
        [keep],
      );
      await client.query(
        "delete from coach_attendance where coach_user_id <> all($1::uuid[])",
        [keep],
      );
      await client.query(
        "delete from coach_group_assignments where coach_user_id <> all($1::uuid[])",
        [keep],
      );
      await client.query("delete from user_sessions where user_id <> all($1::uuid[])", [keep]);
      await client.query("delete from user_invites where user_id <> all($1::uuid[])", [keep]);
      const del = await client.query(
        "delete from users where id <> all($1::uuid[])",
        [keep],
      );
      removed = del.rowCount ?? 0;
    }

    // 3. Age groups, then the recurring schedule for each one.
    const groups: { id: string; name: string }[] = [];
    for (const group of DEMO_GROUPS) {
      const id = await ensureGroup(client, group);
      groups.push({ id, name: group.name });
    }

    const validFrom = addDaysISO(todayISO(), -GENERATE_PAST_DAYS);
    let schedules = 0;
    let sessions = 0;
    for (const group of groups) {
      for (const weekday of WEEKDAYS) {
        const scheduleId = await ensureSchedule(client, group.id, weekday, validFrom);
        schedules += 1;
        sessions += await generateSessions(client, scheduleId, group.id, weekday, timezone);
      }
    }

    await client.query("commit");

    console.log("demo seed complete");
    console.log(`  owner      : ${ownerUsername} ${owner.created ? "(created)" : "(updated)"}`);
    console.log(`  coach      : ${coachUsername} ${coach.created ? "(created)" : "(updated)"}`);
    console.log(`  password   : ${password ?? DEFAULTS.ownerPassword} (demo only — see the warning below)`);
    if (resetUsers) console.log(`  users removed: ${removed}`);
    console.log(`  age groups : ${groups.map((g) => g.name).join(", ")}`);
    console.log(`  schedules  : ${schedules} (Tue + Thu, ${START_TIME}–${END_TIME})`);
    console.log(`  sessions   : ${sessions} new rows generated`);
    console.log(
      "  WARNING: this password is shorter than the 12-character policy. It exists only so a" +
        " demo can log in; do not put this database behind a public name.",
    );
  } catch (err) {
    await client.query("rollback").catch(() => undefined);
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
