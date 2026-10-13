/**
 * API_CONTRACTS §3.4 — players and guardians.
 *
 * Scope rules are the load-bearing part of this section (AUTH_AND_PERMISSIONS §5):
 * a coach reaches only players whose group on the relevant date is in their
 * assignments, out-of-scope ids answer 404 rather than 403, and the coach
 * projection (`PlayerCoachView`) is an allow-list that never carries dateOfBirth,
 * guardians, owner notes or balances (T-AUTH-03/05).
 */
import { endpoint, section, res, z, type Section } from "../registry.js";
import {
  DateStr,
  DuplicateMatch,
  GroupHistoryEntry,
  Guardian,
  GuardianBalance,
  GuardianInput,
  GuardianWithPlayers,
  Id,
  Invoice,
  Player,
  PlayerAttendance,
  PlayerBalance,
  PlayerCoachView,
  PlayerCreate,
  PlayerGuardianLink,
  PlayerListItem,
  dateRangeQuery,
  listOf,
  pageOf,
  pageQuery,
  qParam,
  sortParam,
} from "../components.js";

const idParam = z.object({ id: Id });
const playerGuardianParam = z.object({ id: Id, guardianId: Id });

const STATUS_VALUES = ["active", "inactive", "withdrawn"] as const;

export const playersGuardiansSection: Section = section("3.4 Players and guardians", [
  endpoint({
    id: "PLY-01",
    method: "get",
    path: "/players",
    auth: "coach_scoped",
    permission: "players:read",
    scope:
      "Coach: assigned groups only, filtered in SQL, restricted projection (players:read_restricted). `hasOutstanding` is owner-only.",
    summary: "List players",
    description:
      "Owner receives `Page<Player>`; a coach receives `Page<PlayerCoachView>` — the union is declared so the schema stays honest for both roles, and the projection is chosen server-side. Default `status=active`. Sort: `fullName,registrationDate,registrationNo`.",
    tags: ["Players"],
    query: pageQuery.extend({
      q: qParam,
      status: z.enum(STATUS_VALUES).optional(),
      ageGroupId: Id.optional(),
      hasOutstanding: z
        .coerce
        .boolean()
        .optional()
        .describe("Owner only; ignored for a coach"),
      sort: sortParam.describe("fullName | registrationDate | registrationNo; `-` prefixes desc"),
    }),
    responses: [res.json(200, pageOf(PlayerListItem), "One page of players")],
    errors: ["INVALID_SORT"],
    milestone: "m3",
  }),

  endpoint({
    id: "PLY-02",
    method: "post",
    path: "/players",
    auth: "owner",
    permission: "players:manage",
    summary: "Register a player",
    description:
      "Returns 409 `DUPLICATE_SUSPECTED` with `details[].meta.matches` unless `acknowledgeDuplicates=true`. Validation: fullName 2–120; dateOfBirth not future, age 3–25 warns outside; registrationDate ≤ today+30d; phones normalized to E.164 (LK default).",
    tags: ["Players"],
    mutating: true,
    audit: "player.create",
    body: PlayerCreate,
    responses: [res.json(201, Player, "Created")],
    errors: ["DUPLICATE_SUSPECTED"],
    milestone: "m3",
  }),

  endpoint({
    id: "PLY-03",
    method: "get",
    path: "/players/{id}",
    auth: "coach_scoped",
    permission: "players:read",
    scope: "Coach: 404 when the player's current group is not assigned to them",
    summary: "Read a player",
    description:
      "Owner receives `Player`; coach receives `PlayerCoachView`. Out-of-scope ⇒ 404 (not 403) so existence is not confirmed.",
    tags: ["Players"],
    params: idParam,
    responses: [res.json(200, PlayerListItem, "The player, projected for the caller's role")],
    milestone: "m3",
  }),

  endpoint({
    id: "PLY-04",
    method: "patch",
    path: "/players/{id}",
    auth: "owner",
    permission: "players:manage",
    summary: "Update a player",
    description:
      "`billingAnchorDate` may only change before the player's first invoice exists. `version` mismatch ⇒ 409 `VERSION_CONFLICT`.",
    tags: ["Players"],
    params: idParam,
    mutating: true,
    audit: "player.update",
    body: z.strictObject({
      fullName: z.string().min(2).max(120).optional(),
      dateOfBirth: DateStr.optional(),
      registrationDate: DateStr.optional(),
      notes: z.string().max(1000).optional(),
      coachNotes: z.string().max(500).optional(),
      billingAnchorDate: DateStr.optional(),
      version: z.number().int(),
    }),
    responses: [res.json(200, Player, "Updated player")],
    errors: ["VERSION_CONFLICT", "ALREADY_INVOICED"],
    milestone: "m3",
  }),

  endpoint({
    id: "PLY-05",
    method: "post",
    path: "/players/{id}/status",
    auth: "owner",
    permission: "players:manage",
    summary: "Change a player's status",
    description:
      "Withdrawal defaults `stopReminders` to true, which cancels that guardian's unsent jobs. Records are never deleted (ADR-016); a withdrawn player leaves future rosters and billing but stays searchable.",
    tags: ["Players"],
    params: idParam,
    mutating: true,
    audit: "player.status.change",
    body: z.strictObject({
      status: z.enum(STATUS_VALUES),
      effectiveDate: DateStr,
      reason: z.string().max(200).optional(),
      stopReminders: z.boolean().optional(),
      version: z.number().int(),
    }),
    responses: [res.json(200, Player, "Updated player")],
    errors: ["VERSION_CONFLICT", "REASON_REQUIRED"],
    milestone: "m3",
  }),

  endpoint({
    id: "PLY-06",
    method: "post",
    path: "/players/{id}/transfer",
    auth: "owner",
    permission: "players:manage",
    summary: "Transfer a player to another age group",
    description:
      "Closes the open history row and opens a new one inside one transaction (T7). Historic invoices, payments and attendance are untouched; the database's no-overlap exclusion constraint rejects overlapping history.",
    tags: ["Players"],
    params: idParam,
    mutating: true,
    audit: "player.transfer",
    body: z.strictObject({
      ageGroupId: Id,
      effectiveFrom: DateStr,
      reason: z.string().min(5).max(200),
      version: z.number().int(),
    }),
    responses: [res.json(200, Player, "Player in the new group")],
    errors: ["VERSION_CONFLICT"],
    milestone: "m3",
  }),

  endpoint({
    id: "PLY-07",
    method: "get",
    path: "/players/{id}/group-history",
    auth: "owner",
    permission: "players:manage",
    summary: "Read a player's group history",
    tags: ["Players"],
    params: idParam,
    responses: [res.json(200, listOf(GroupHistoryEntry), "History rows, newest first")],
    milestone: "m3",
  }),

  endpoint({
    id: "PLY-08",
    method: "post",
    path: "/players/check-duplicates",
    auth: "owner",
    permission: "players:manage",
    summary: "Advisory duplicate check",
    description:
      "Advisory only: same normalized name + DOB, or trigram similarity ≥ 0.6 with a shared guardian phone (DATABASE §3.2 — never a DB unique constraint). Never blocks a create.",
    tags: ["Players"],
    mutating: true,
    audit: "player.duplicate_check",
    body: z.strictObject({
      fullName: z.string().min(2).max(120),
      dateOfBirth: DateStr.optional(),
      guardianPhones: z.array(z.string()).optional(),
    }),
    responses: [res.json(200, z.object({ matches: z.array(DuplicateMatch) }), "Ranked matches")],
    milestone: "m3",
  }),

  endpoint({
    id: "PLY-09",
    method: "get",
    path: "/players/{id}/invoices",
    auth: "owner",
    permission: "players:manage",
    summary: "A player's invoices",
    tags: ["Players"],
    params: idParam,
    query: pageQuery.extend({
      status: z.enum(["issued", "partially_paid", "paid", "void"]).optional(),
    }),
    responses: [res.json(200, pageOf(Invoice), "One page of invoices")],
    milestone: "m3",
  }),

  endpoint({
    id: "PLY-10",
    method: "get",
    path: "/players/{id}/attendance",
    auth: "coach_scoped",
    permission: "players:read",
    scope: "Coach: assigned groups only; only sessions they may see",

    summary: "A player's attendance history",
    description:
      "The summary excludes excused and unmarked sessions and cancelled sessions entirely (T-ATT-10).",
    tags: ["Players"],
    params: idParam,
    query: dateRangeQuery,
    responses: [res.json(200, PlayerAttendance, "Summary plus per-session rows")],
    milestone: "m4",
  }),

  endpoint({
    id: "PLY-11",
    method: "get",
    path: "/players/{id}/balance",
    auth: "owner",
    permission: "players:manage",
    summary: "A player's balance",
    description: "Credit is reported separately, never netted into outstanding (T-RPT-02).",
    tags: ["Players"],
    params: idParam,
    responses: [res.json(200, PlayerBalance, "Outstanding, overdue and credit in minor units")],
    milestone: "m5",
  }),

  // -------------------------------------------------------------------------
  // Guardians (§3.4, GDN-01..06)
  // -------------------------------------------------------------------------
  endpoint({
    id: "GDN-01",
    method: "get",
    path: "/guardians",
    auth: "owner",
    permission: "guardians:manage",
    summary: "List guardians",
    tags: ["Players"],
    query: pageQuery.extend({ q: qParam }),
    responses: [res.json(200, pageOf(GuardianWithPlayers), "Guardians with their players")],
    milestone: "m3",
  }),

  endpoint({
    id: "GDN-02",
    method: "patch",
    path: "/guardians/{id}",
    auth: "owner",
    permission: "guardians:manage",
    summary: "Update a guardian",
    description: "Audited with the phone number masked (`+9477****567`).",
    tags: ["Players"],
    params: idParam,
    mutating: true,
    audit: "guardian.update",
    body: z.strictObject({
      fullName: z.string().min(2).max(120).optional(),
      phone: z.string().optional(),
      relationship: z.string().max(60).optional(),
    }),
    responses: [res.json(200, Guardian, "Updated guardian")],
    milestone: "m3",
  }),

  endpoint({
    id: "GDN-03",
    method: "post",
    path: "/players/{id}/guardians",
    auth: "owner",
    permission: "guardians:manage",
    summary: "Link a guardian to a player",
    description:
      "Accepts an existing `guardianId` or a new guardian inline. A player must keep at least one guardian, and exactly one primary. The response is the new link — CONTRACT GAP: this row states no response shape, so the link object is used and flagged in the M1 handoff §4.",
    tags: ["Players"],
    params: idParam,
    mutating: true,
    audit: "player.guardian.link",
    body: GuardianInput,
    responses: [res.json(201, PlayerGuardianLink, "The new link")],
    errors: ["VALIDATION_ERROR"],
    milestone: "m3",
  }),

  endpoint({
    id: "GDN-04",
    operationId: "GDN-04.update",
    method: "patch",
    path: "/players/{id}/guardians/{guardianId}",
    auth: "owner",
    permission: "guardians:manage",
    summary: "Update a player-guardian link",
    description:
      "Making another guardian primary moves the flag; the database's partial unique index allows exactly one primary per player. `receivesInvoices` controls billing messages.",
    tags: ["Players"],
    params: playerGuardianParam,
    mutating: true,
    audit: "player.guardian.update",
    body: z.strictObject({
      isPrimary: z.boolean().optional(),
      receivesInvoices: z.boolean().optional(),
    }),
    responses: [res.json(200, PlayerGuardianLink, "Updated link")],
    milestone: "m3",
  }),

  endpoint({
    id: "GDN-04",
    operationId: "GDN-04.delete",
    method: "delete",
    path: "/players/{id}/guardians/{guardianId}",
    auth: "owner",
    permission: "guardians:manage",
    summary: "Unlink a guardian from a player",
    description: "Refused while it would leave the player with no guardian.",
    tags: ["Players"],
    params: playerGuardianParam,
    mutating: true,
    audit: "player.guardian.unlink",
    responses: [res.empty(204, "Unlinked")],
    errors: ["VALIDATION_ERROR"],
    milestone: "m3",
  }),

  endpoint({
    id: "GDN-05",
    method: "post",
    path: "/guardians/{id}/consent",
    auth: "owner",
    permission: "guardians:manage",
    summary: "Record WhatsApp consent",
    description:
      "`revoked` immediately cancels that guardian's queued/failed jobs (OPENWA_INTEGRATION §11). Consent is per guardian, shared across siblings, and is independent of the MSG-07/SET-08 switches.",
    tags: ["Players"],
    params: idParam,
    mutating: true,
    audit: "guardian.consent",
    body: z.strictObject({
      status: z.enum(["granted", "revoked", "unknown"]),
      source: z.string().min(2).max(60),
      note: z.string().max(500).optional(),
    }),
    responses: [res.json(200, Guardian, "Updated guardian")],
    milestone: "m3",
  }),

  endpoint({
    id: "GDN-06",
    method: "get",
    path: "/guardians/{id}/balance",
    auth: "owner",
    permission: "guardians:manage",
    summary: "A guardian's balance across their players",
    tags: ["Players"],
    params: idParam,
    responses: [
      res.json(
        200,
        GuardianBalance.extend({ openInvoices: z.array(Invoice) }),
        "Balance plus the open invoices behind it",
      ),
    ],
    milestone: "m5",
  }),
]);
