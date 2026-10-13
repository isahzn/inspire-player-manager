/**
 * Serializers for the M3 people surface (API_CONTRACTS §2).
 *
 * Two rules the shapes here encode, and that the tests assert directly:
 *
 *  - **The coach projection is an allow-list** (`PlayerCoachView`): a coach payload
 *    never carries a date of birth, a balance, an owner note, a guardian link or a
 *    fee. Everything the coach may see is named explicitly below; nothing is spread.
 *  - **Dates are academy-local business dates**, never UTC-shifted. `dateStr()` reads
 *    the calendar date out of the value node-postgres parsed a `date` column into.
 */
import type { UserRow } from "./serialize.js";
import { serializeUser } from "./serialize.js";

/** `date` column → `YYYY-MM-DD`. pg hands back a Date at local midnight; strings pass through. */
export function dateStr(value: Date | string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") return value.slice(0, 10);
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(
    value.getDate(),
  ).padStart(2, "0")}`;
}

/** `YYYY-MM-DD` → the calendar date parsed in UTC (so no local shift can move it). */
export function parseDateOnly(value: string): Date {
  return new Date(`${value}T00:00:00Z`);
}

// ---------------------------------------------------------------------------
// Age groups and fees (§3.3)
// ---------------------------------------------------------------------------
export interface AgeGroupRow {
  id: string;
  name: string;
  min_age: number | null;
  max_age: number | null;
  sort_order: number;
  archived_at: Date | null;
}

export interface AgeGroupExtras {
  /** Owner only — absent for a coach, who never sees a fee. */
  currentFeeMinor?: number | null;
  activePlayerCount?: number;
}

export function serializeAgeGroup(row: AgeGroupRow, extras: AgeGroupExtras = {}) {
  return {
    id: row.id,
    name: row.name,
    ...(row.min_age !== null ? { minAge: row.min_age } : {}),
    ...(row.max_age !== null ? { maxAge: row.max_age } : {}),
    sortOrder: row.sort_order,
    ...(row.archived_at ? { archivedAt: row.archived_at.toISOString() } : {}),
    ...(extras.currentFeeMinor !== undefined && extras.currentFeeMinor !== null
      ? { currentFeeMinor: Number(extras.currentFeeMinor) }
      : {}),
    ...(extras.activePlayerCount !== undefined
      ? { activePlayerCount: extras.activePlayerCount }
      : {}),
  };
}

export interface GroupFeeRow {
  id: string;
  age_group_id: string;
  amount_minor: string | number;
  effective_from: Date;
  effective_to: Date | null;
}

export function serializeGroupFee(row: GroupFeeRow) {
  return {
    id: row.id,
    ageGroupId: row.age_group_id,
    amountMinor: Number(row.amount_minor),
    effectiveFrom: dateStr(row.effective_from)!,
    ...(row.effective_to ? { effectiveTo: dateStr(row.effective_to) } : {}),
  };
}

export interface CoachAssignmentRow {
  id: string;
  coach_user_id: string;
  coach_name: string;
  age_group_id: string;
  age_group_name: string;
  assigned_from: Date;
  assigned_to: Date | null;
}

export function serializeCoachAssignment(row: CoachAssignmentRow) {
  return {
    id: row.id,
    coachUserId: row.coach_user_id,
    coachName: row.coach_name,
    ageGroup: { id: row.age_group_id, name: row.age_group_name },
    assignedFrom: dateStr(row.assigned_from)!,
    ...(row.assigned_to ? { assignedTo: dateStr(row.assigned_to) } : {}),
  };
}

/** `CoachRow`: the coach's `User` plus the groups they currently hold. */
export function serializeCoachRow(
  user: UserRow,
  groups: { id: string; name: string }[],
) {
  return { user: serializeUser(user), groups };
}

// ---------------------------------------------------------------------------
// Guardians (§3.4)
// ---------------------------------------------------------------------------
export interface GuardianRow {
  id: string;
  full_name: string;
  phone_e164: string;
  relationship: string | null;
  whatsapp_consent: "unknown" | "granted" | "revoked";
  consent_recorded_at: Date | null;
  consent_source: string | null;
  opted_out_at: Date | null;
}

export function serializeGuardian(row: GuardianRow) {
  return {
    id: row.id,
    fullName: row.full_name,
    phone: row.phone_e164,
    ...(row.relationship ? { relationship: row.relationship } : {}),
    whatsappConsent: row.whatsapp_consent,
    ...(row.consent_recorded_at ? { consentRecordedAt: row.consent_recorded_at.toISOString() } : {}),
    ...(row.consent_source ? { consentSource: row.consent_source } : {}),
    ...(row.opted_out_at ? { optedOutAt: row.opted_out_at.toISOString() } : {}),
  };
}

export function serializeGuardianWithPlayers(
  row: GuardianRow,
  players: { id: string; full_name: string }[],
) {
  return {
    ...serializeGuardian(row),
    players: players.map((p) => ({ id: p.id, fullName: p.full_name })),
  };
}

export function serializePlayerGuardianLink(
  guardian: GuardianRow,
  link: { is_primary: boolean; receives_invoices: boolean },
) {
  return {
    guardian: serializeGuardian(guardian),
    isPrimary: link.is_primary,
    receivesInvoices: link.receives_invoices,
  };
}

// ---------------------------------------------------------------------------
// Players (§3.4)
// ---------------------------------------------------------------------------
export interface PlayerRow {
  id: string;
  registration_no: string;
  full_name: string;
  date_of_birth: Date | null;
  registration_date: Date;
  billing_anchor_date: Date;
  status: "active" | "inactive" | "withdrawn";
  status_effective_date: Date;
  status_reason: string | null;
  notes: string | null;
  coach_notes: string | null;
  version: number;
}

/** Everything `select *`-shaped does not carry: the joined rows a projection needs. */
export interface PlayerExtras {
  ageOnReference?: number;
  currentGroup?: { id: string; name: string; since: Date } | null;
  guardians?: { guardian: GuardianRow; is_primary: boolean; receives_invoices: boolean }[];
  outstandingMinor?: number;
}

/** Owner projection. `notes` is owner-only; balances arrive with M5. */
export function serializePlayer(row: PlayerRow, extras: PlayerExtras = {}) {
  return {
    id: row.id,
    registrationNo: row.registration_no,
    fullName: row.full_name,
    ...(dateStr(row.date_of_birth) ? { dateOfBirth: dateStr(row.date_of_birth) } : {}),
    ...(extras.ageOnReference !== undefined ? { ageOnReference: extras.ageOnReference } : {}),
    registrationDate: dateStr(row.registration_date)!,
    status: row.status,
    statusEffectiveDate: dateStr(row.status_effective_date)!,
    ...(row.status_reason ? { statusReason: row.status_reason } : {}),
    ...(extras.currentGroup
      ? {
          currentGroup: {
            id: extras.currentGroup.id,
            name: extras.currentGroup.name,
            since: dateStr(extras.currentGroup.since)!,
          },
        }
      : {}),
    guardians: (extras.guardians ?? []).map((g) =>
      serializePlayerGuardianLink(g.guardian, g),
    ),
    ...(row.notes ? { notes: row.notes } : {}),
    ...(row.coach_notes ? { coachNotes: row.coach_notes } : {}),
    billingAnchorDate: dateStr(row.billing_anchor_date)!,
    ...(extras.outstandingMinor !== undefined ? { outstandingMinor: extras.outstandingMinor } : {}),
    version: row.version,
  };
}

export interface CoachViewExtras {
  age?: number;
  group?: { id: string; name: string };
  /** Only when coach_can_see_guardian_phone is true (OPEN-008). */
  primaryGuardian?: { fullName: string; phone: string };
}

/** Restricted coach projection — the allow-list AUTH §4 / T-AUTH-05 assert. */
export function serializePlayerCoachView(row: PlayerRow, extras: CoachViewExtras = {}) {
  return {
    id: row.id,
    registrationNo: row.registration_no,
    fullName: row.full_name,
    ...(extras.age !== undefined ? { age: extras.age } : {}),
    status: row.status,
    ...(extras.group ? { group: extras.group } : {}),
    ...(row.coach_notes ? { coachNotes: row.coach_notes } : {}),
    ...(extras.primaryGuardian ? { primaryGuardian: extras.primaryGuardian } : {}),
  };
}

export interface GroupHistoryRow {
  id: string;
  age_group_id: string;
  age_group_name: string;
  effective_from: Date;
  effective_to: Date | null;
  reason: string | null;
  changed_by: string;
  changed_by_name: string;
}

export function serializeGroupHistoryEntry(row: GroupHistoryRow) {
  return {
    id: row.id,
    ageGroup: { id: row.age_group_id, name: row.age_group_name },
    effectiveFrom: dateStr(row.effective_from)!,
    ...(row.effective_to ? { effectiveTo: dateStr(row.effective_to) } : {}),
    ...(row.reason ? { reason: row.reason } : {}),
    changedBy: { id: row.changed_by, fullName: row.changed_by_name },
  };
}
