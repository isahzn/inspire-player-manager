/**
 * Shared logic for the M3 people surface.
 *
 * The age rules and the registration-number allocator are here rather than in a route so
 * the same expression cannot drift between PLY-02, PLY-03, GRP-05 and the CSV import.
 * Nothing in this file trusts input: phones go through `normalizePhone`, dates are
 * parsed as UTC calendar dates, and duplicate detection is advisory only — it never
 * blocks a write (DATABASE §3.2).
 */
import type { PoolClient } from "pg";
import { normalizePhone } from "../auth/tokens.js";
import { errors } from "../errors.js";
import type { PlayerRow } from "./people-serialize.js";

export type AgeReferenceRule = "jan_1_of_year" | "fixed_month_day" | "today";

/** Today's calendar date *in the academy's timezone* (ISO `YYYY-MM-DD`). */
export function todayInTimeZone(timeZone: string, now: Date = new Date()): string {
  // en-CA renders as YYYY-MM-DD, which is exactly the business-date format we store.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** The date an age is measured on, per `academy_settings.age_reference_rule`. */
export function ageReferenceDate(
  rule: AgeReferenceRule,
  monthDay: string | null,
  today: string,
): string {
  if (rule === "today") return today;
  const year = today.slice(0, 4);
  if (rule === "fixed_month_day" && monthDay) return `${year}-${monthDay}`;
  return `${year}-01-01`;
}

/** Whole years between a date of birth and a reference date (calendar arithmetic). */
export function ageOn(dateOfBirth: string, onDate: string): number {
  const dob = new Date(`${dateOfBirth}T00:00:00Z`);
  const ref = new Date(`${onDate}T00:00:00Z`);
  let age = ref.getUTCFullYear() - dob.getUTCFullYear();
  const monthDiff = ref.getUTCMonth() - dob.getUTCMonth();
  if (monthDiff < 0 || (monthDiff === 0 && ref.getUTCDate() < dob.getUTCDate())) age -= 1;
  return age;
}

/** `normalizePhone`, but a 422 with the field name instead of a thrown Error. */
export function normalizePhoneOrThrow(input: string, field: string): string {
  try {
    return normalizePhone(input);
  } catch {
    throw errors.validation([{ field, issue: "Enter a valid phone number." }]);
  }
}

export interface AcademySettingsRow {
  age_reference_rule: AgeReferenceRule;
  age_reference_month_day: string | null;
  timezone: string;
  coach_can_see_guardian_phone: boolean;
  allow_fractional_money: boolean;
}

/** Reads the academy row through the caller's context (owner-only table). */
export async function loadAcademySettings(client: PoolClient): Promise<AcademySettingsRow> {
  const result = await client.query<AcademySettingsRow>(
    `select age_reference_rule, age_reference_month_day, timezone,
            coach_can_see_guardian_phone, allow_fractional_money
       from academy_settings
      where id = 1`,
  );
  const row = result.rows[0];
  if (!row) throw errors.notFound();
  return row;
}

/**
 * Allocates the next `player_reg` number for a year from `document_counters` (row lock,
 * so concurrent registrations cannot collide and a rollback leaves no gap).
 */
export async function allocatePlayerRegistrationNo(
  client: PoolClient,
  year: number,
): Promise<string> {
  const result = await client.query<{ value: string }>(
    `insert into document_counters (name, year, next_value)
     values ('player_reg', $1, 2)
     on conflict (name, year)
     do update set next_value = document_counters.next_value + 1
     returning next_value - 1 as value`,
    [year],
  );
  const value = Number(result.rows[0]!.value);
  return `IA-${String(value).padStart(4, "0")}`;
}

export interface DuplicateProbe {
  fullName: string;
  dateOfBirth?: string;
  /** Already normalized to E.164. */
  guardianPhones?: string[];
}

export interface DuplicateHit {
  row: PlayerRow;
  reason: "same_name_and_dob" | "similar_name_shared_phone";
  score: number;
}

/**
 * Advisory duplicate detection (DATABASE §3.2): same normalized name + DOB, or trigram
 * similarity ≥ 0.6 combined with a shared guardian phone. Never a unique constraint and
 * never a block — PLY-02 refuses only because the caller did not acknowledge.
 */
export async function findDuplicatePlayers(
  client: PoolClient,
  probe: DuplicateProbe,
): Promise<DuplicateHit[]> {
  const phones = probe.guardianPhones ?? [];
  const result = await client.query<PlayerRow & { reason: DuplicateHit["reason"]; score: number }>(
    `select p.*,
            case
              when $2::date is not null
                   and p.date_of_birth = $2::date
                   and lower(btrim(p.full_name)) = lower(btrim($1))
                then 'same_name_and_dob'
              else 'similar_name_shared_phone'
            end as reason,
            greatest(
              similarity(p.full_name, $1),
              case when lower(btrim(p.full_name)) = lower(btrim($1)) then 1 else 0 end
            ) as score
       from players p
      where p.anonymized_at is null
        and (
          ($2::date is not null
            and p.date_of_birth = $2::date
            and lower(btrim(p.full_name)) = lower(btrim($1)))
          or (similarity(p.full_name, $1) >= 0.6
              and cardinality($3::text[]) > 0
              and exists (
                select 1
                  from player_guardians pg
                  join guardians g on g.id = pg.guardian_id
                 where pg.player_id = p.id
                   and g.phone_e164 = any ($3::text[])
              ))
        )
      order by score desc
      limit 20`,
    [probe.fullName, probe.dateOfBirth ?? null, phones],
  );
  return result.rows.map((row) => ({ row, reason: row.reason, score: Number(row.score) }));
}

/** Human wording for a duplicate reason (the API never returns the machine token). */
export function duplicateReasonText(reason: DuplicateHit["reason"]): string {
  return reason === "same_name_and_dob"
    ? "Same name and date of birth as an existing player."
    : "Similar name and a shared guardian phone number with an existing player.";
}
