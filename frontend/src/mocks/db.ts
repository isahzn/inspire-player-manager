"use client";

// Mock store for Step 3 (players, guardians, groups, fees, coaches, imports),
// Step 4 (sessions, player attendance, coach check-in/out) and Step 5 (billing
// runs, invoices, payments, allocations, proofs, receipts).
// MOCK-ONLY: this is not the backend. It keeps the seeded fixtures in module
// memory and mirrors them to localStorage (`ia_mock_people_v1`) so a reload
// does not undo a registration or a saved attendance sheet, exactly like the
// real cookie session does not. Shapes come from MOCK_DATA.md + API_CONTRACTS
// §2/§3.5 — no invented fields.
//
// Deviations that are deliberate and documented in the handoffs:
// · the demo clock is relative (`todayISO() ± n`) so "overdue" stays meaningful
//   whenever the app is run; only DOBs and registration dates are fixed values;
// · today's Under-11 session is anchored to "now" so the check-in window and the
//   attendance sheet are usable whenever the app is run (Step 4 handoff §3).

import type {
  AgeGroup,
  AgeGroupSuggestion,
  Allocation,
  AttendanceRecordInput,
  AttendanceStatus,
  BillingRun,
  CoachAssignment,
  CoachAttendance,
  CoachRow,
  DuplicateMatch,
  GroupFee,
  GroupHistoryEntry,
  Guardian,
  GuardianWithPlayers,
  ImportIssue,
  ImportValidation,
  Invoice,
  InvoiceItem,
  MessageJob,
  PaymentMethod,
  PaymentStatus,
  Player,
  PlayerAttendance,
  PlayerBalance,
  PlayerCoachView,
  PlayerCreate,
  PlayerListItem,
  PlayerStatus,
  ProofDocKind,
  ProofVerification,
  RosterRow,
  Session,
  SessionAttendance,
  SessionStatus,
  User,
} from "@/api/types";
import {
  academyDateOf,
  academyLocalToInstant,
  addDaysISO,
  addMinutes,
  ageOn,
  minutesBetween,
  todayISO,
} from "@/lib/dates";
import { normalizeLkPhone } from "@/lib/phone";

/** Error carrying a contract error code; handlers map it to the envelope. */
export class MockError extends Error {
  code: string;
  status: number;
  details?: unknown[];
  constructor(code: string, message: string, status: number, details?: unknown[]) {
    super(message);
    this.name = "MockError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const STORE_KEY = "ia_mock_people_v1";
// 2 (Step 4): sessions gained real times/status/venue; attendance records gained
// version + markedAt/markedBy; coach check-ins were added. 3 (Step 5): invoices
// gained items, payments/allocation ledger, proofs with findings, receipts,
// billing runs and the academy settings the money screens read. A store written
// by an older build is discarded so the seed is never half-old (readStored).
const SCHEMA = 3 as const;

export const OWNER_ID = "0192a000-0000-7000-8000-000000000001";
export const COACH_ID = "0192a000-0000-7000-8000-000000000002";
export const COACH2_ID = "0192a000-0000-7000-8000-000000000003";

interface AttendanceRecord {
  sessionId: string;
  playerId: string;
  status: AttendanceStatus;
  note?: string;
  /** Server-stamped: the client never sends a time (ATTENDANCE §3). */
  markedAt: string;
  markedBy: string;
  version: number;
}

/** A session as stored: the contract `Session` plus the group id we index on. */
type SessionRec = Session & { ageGroupId: string };

/** A coach check-in as stored: `coach_attendance` (DATABASE §3.7). */
interface CoachAttendanceRec {
  id: string;
  coachUserId: string;
  coachName: string;
  sessionId: string;
  checkInAt: string;
  checkOutAt?: string;
  checkInNote?: string;
  enteredBy: "self" | "owner";
  corrected: boolean;
  version: number;
}

interface ImportBatch {
  id: string;
  rows: ImportValidation["preview"];
  /** rows that block the commit (never imported) */
  errorRows: number[];
  /** rows that commit only when the owner ticks "import rows with warnings" */
  warningRows: number[];
  fileName: string;
}

type HistoryRow = GroupHistoryEntry & { playerId: string };

/**
 * A payment as stored (DATABASE §3.3). Allocations live here — one source of
 * truth — so an invoice's paid amount is always derived from the ledger
 * (BILLING_ENGINE §1.4: balances are derived, never hand-written).
 */
export interface PaymentRec {
  id: string;
  amountMinor: number;
  methodCode: string;
  reference?: string;
  receivedAt: string;
  payerGuardianId?: string;
  payerName?: string;
  status: PaymentStatus;
  notes?: string;
  rejectReason?: string;
  reverseReason?: string;
  allocations: Allocation[];
  proofs: ProofRec[];
  receipts: { id: string; receiptNumber: string; issuedAt: string; voided: boolean }[];
  /** Audit note for the "> 1 year in the past" confirmation (BILLING_ENGINE §15). */
  pastDateConfirmed?: boolean;
  version: number;
}

/**
 * An uploaded proof. The mock never keeps the owner's bytes: it records the
 * facts the API would (kind, size, hash) and serves a stub of the same kind on
 * download, so the flow is real without shipping a fixture PDF.
 */
export interface ProofRec {
  fileId: string;
  paymentId: string;
  originalName?: string;
  mimeType: string;
  sizeBytes: number;
  uploadedAt: string;
  uploadedById: string;
  uploadedByName: string;
  docKind: ProofDocKind;
  /** Real SHA-256 of the uploaded bytes — drives the duplicate-file finding. */
  sha256: string;
  note?: string;
  stubKind: "pdf" | "image";
  verification?: ProofVerification;
}

/** The academy settings the money screens read (SET-01/02 subset + mock facts). */
export interface MockSettings {
  billingFrequency: "weekly" | "monthly";
  billingPeriodMode: "calendar" | "anchored";
  weekStartDay: number;
  invoiceIssueTiming: "period_start" | "period_end";
  dueRuleType: "days_after_issue" | "days_after_period_start" | "fixed_day_of_month";
  dueRuleValue: number;
  allowFractionalMoney: boolean;
  effectNote: string;
  academyName: string;
  paymentInstructions: string;
  beneficiaryAccounts: { name: string; accountMasked: string }[];
  /**
   * SET-08 `proofCheck`. Stayed false: the automatic check switch is CR-003 and
   * ADR-019 is still Proposed, so nothing runs checks on upload. CR-004's
   * explicit `PRF-04` re-check is always available.
   */
  proofAutoCheck: false;
  /** The AppShell banner state; a send is skipped while it is not `connected`. */
  whatsappSession: "awaiting_qr" | "connected";
}

export interface Db {
  schema: typeof SCHEMA;
  groups: AgeGroup[];
  fees: GroupFee[];
  players: Player[];
  guardians: Guardian[];
  history: HistoryRow[];
  invoices: Invoice[];
  invoiceItems: { invoiceId: string; item: InvoiceItem }[];
  payments: PaymentRec[];
  methods: PaymentMethod[];
  billingRuns: BillingRun[];
  messages: MessageJob[];
  settings: MockSettings;
  /**
   * Server-side only (DATABASE §3.3 `suppress_reissue`): an invoice voided with
   * `allowReissue:false` must not be recreated by a later run. It is not part of
   * the API's `Invoice` shape, so it is kept here rather than on the row.
   */
  suppressedReissue: { playerId: string; periodStart: string; periodEnd: string }[];
  sessions: SessionRec[];
  attendance: AttendanceRecord[];
  coachAttendance: CoachAttendanceRec[];
  assignments: CoachAssignment[];
  coaches: { user: User; groups: { id: string; name: string }[] }[];
  importBatches: ImportBatch[];
  counters: {
    player: number;
    invoice: number;
    import: number;
    payment: number;
    receipt: number;
    run: number;
    message: number;
  };
}

let cache: Db | null = null;

// --- seeding ----------------------------------------------------------------
function seed(): Db {
  const today = todayISO();
  const jan1 = `${today.slice(0, 4)}-01-01`;
  const id = (n: string | number) =>
    `0192a000-0000-7000-8000-${String(n).padStart(12, "0")}`;
  const G11 = id("a1");
  const G14 = id("a2");
  const G17 = id("a3");

  const groups: AgeGroup[] = [
    { id: G11, name: "Under-11", minAge: 8, maxAge: 10, sortOrder: 1, currentFeeMinor: 400000, activePlayerCount: 0 },
    { id: G14, name: "Under-14", minAge: 11, maxAge: 13, sortOrder: 2, currentFeeMinor: 500000, activePlayerCount: 0 },
    { id: G17, name: "Under-17", minAge: 14, maxAge: 16, sortOrder: 3, currentFeeMinor: 600000, activePlayerCount: 0 },
  ];

  const fees: GroupFee[] = [
    { id: id("f1"), ageGroupId: G11, amountMinor: 350000, effectiveFrom: "2025-09-01", effectiveTo: "2025-12-31" },
    { id: id("f2"), ageGroupId: G11, amountMinor: 400000, effectiveFrom: "2026-01-01" },
    { id: id("f3"), ageGroupId: G14, amountMinor: 500000, effectiveFrom: "2026-01-01" },
    { id: id("f4"), ageGroupId: G17, amountMinor: 600000, effectiveFrom: "2026-01-01" },
  ];

  const guardians: Guardian[] = [
    { id: id("c1"), fullName: "Demo Guardian", phone: "+94770000001", relationship: "Mother", whatsappConsent: "granted", consentRecordedAt: "2026-01-10T05:00:00Z", consentSource: "registration_form" },
    { id: id("c2"), fullName: "Sunil Fernando", phone: "+94770000002", relationship: "Father", whatsappConsent: "granted", consentRecordedAt: "2026-02-02T05:00:00Z", consentSource: "registration_form" },
    { id: id("c3"), fullName: "Nadeesha Silva", phone: "+94770000003", relationship: "Mother", whatsappConsent: "revoked", consentRecordedAt: "2026-03-04T05:00:00Z", consentSource: "whatsapp_reply", optedOutAt: "2026-03-04T05:00:00Z" },
    { id: id("c4"), fullName: "Rizwan Ahamed", phone: "+94770000004", relationship: "Guardian", whatsappConsent: "unknown" },
    { id: id("c5"), fullName: "Kumari Jayasuriya", phone: "+94770000005", relationship: "Mother", whatsappConsent: "granted", consentRecordedAt: "2026-04-01T05:00:00Z", consentSource: "verbal" },
  ];

  const player = (
    n: string,
    registrationNo: string,
    fullName: string,
    dateOfBirth: string,
    registrationDate: string,
    status: PlayerStatus,
    guardianId: string,
    notes?: string,
    coachNotes?: string
  ): Player => ({
    id: id(n),
    registrationNo,
    fullName,
    dateOfBirth,
    ageOnReference: ageOn(dateOfBirth, jan1),
    registrationDate,
    status,
    statusEffectiveDate: registrationDate,
    guardians: [{ guardian: guardians.find((g) => g.id === guardianId)!, isPrimary: true, receivesInvoices: true }],
    notes,
    coachNotes,
    billingAnchorDate: registrationDate,
    outstandingMinor: 0,
    version: 1,
  });

  const players: Player[] = [
    player("b1", "IA-0001", "Demo Player One", "2015-03-14", "2026-01-10", "active", id("c1"), "Prefers morning sessions.", "Strong left foot."),
    player("b2", "IA-0002", "Demo Player Two", "2013-07-02", "2026-02-02", "active", id("c2")),
    player("b3", "IA-0003", "Hasitha Bandara", "2012-11-21", "2026-02-14", "withdrawn", id("c3")),
    player("b4", "IA-0004", "Amara Perera", "2015-09-05", "2026-03-01", "active", id("c4")),
    player("b5", "IA-0005", "Tharindu Silva", "2014-01-30", "2026-03-08", "active", id("c5")),
    player("b6", "IA-0006", "Ishara Nadeeshan", "2016-05-19", "2026-04-04", "inactive", id("c2")),
    player("b7", "IA-0007", "Fathima Rizwana", "2013-12-02", "2026-05-11", "active", id("c4")),
    player("b8", "IA-0008", "Kavindu Rajapaksa", "2011-08-08", "2026-06-01", "active", id("c5")),
  ];

  const groupOf: Record<string, string | undefined> = {
    b1: G11,
    b2: G14,
    b4: G11,
    b5: G11,
    b6: G14,
    b7: G14,
    b8: G17,
  };

  const history: HistoryRow[] = [];
  for (const p of players) {
    const groupId = groupOf[p.id.slice(-2)];
    if (!groupId) continue;
    history.push({
      id: `hist-${p.registrationNo}`,
      playerId: p.id,
      ageGroup: { id: groupId, name: groups.find((g) => g.id === groupId)!.name },
      effectiveFrom: p.registrationDate,
      changedBy: { id: OWNER_ID, fullName: "Demo Owner" },
    });
  }
  // A closed row so the profile timeline shows a real transfer.
  history.push({
    id: "hist-IA-0004-old",
    playerId: id("b4"),
    ageGroup: { id: G14, name: "Under-14" },
    effectiveFrom: "2026-03-01",
    effectiveTo: addDaysISO(today, -40),
    reason: "Moved down an age band after the January reference date.",
    changedBy: { id: OWNER_ID, fullName: "Demo Owner" },
  });
  history.push({
    id: "hist-IA-0003-old",
    playerId: id("b3"),
    ageGroup: { id: G14, name: "Under-14" },
    effectiveFrom: "2026-02-14",
    effectiveTo: addDaysISO(today, -10),
    reason: "Withdrawn.",
    changedBy: { id: OWNER_ID, fullName: "Demo Owner" },
  });

  const invoice = (
    n: string,
    invoiceNumber: string,
    playerId: string,
    guardianId: string | undefined,
    groupId: string,
    status: Invoice["status"],
    totalMinor: number,
    paidMinor: number,
    dueDate: string,
    periodStart: string
  ): Invoice => {
    const overdue = status !== "paid" && status !== "void" && dueDate < today;
    const daysOverdue = overdue
      ? Math.max(1, Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${dueDate}T00:00:00Z`)) / 86_400_000))
      : 0;
    const p = players.find((x) => x.id === playerId)!;
    return {
      id: id(n),
      invoiceNumber,
      kind: "periodic",
      status,
      isOverdue: overdue,
      daysOverdue,
      player: { id: p.id, fullName: p.fullName, registrationNo: p.registrationNo },
      guardian: guardianId ? { id: guardianId, fullName: guardians.find((g) => g.id === guardianId)!.fullName } : undefined,
      ageGroup: { id: groupId, name: groups.find((g) => g.id === groupId)!.name },
      periodStart,
      periodEnd: addDaysISO(periodStart, 29),
      issueDate: periodStart,
      dueDate,
      currency: "LKR",
      subtotalMinor: totalMinor,
      adjustmentsMinor: 0,
      totalMinor,
      paidMinor,
      balanceMinor: totalMinor - paidMinor,
      hasPdf: true,
      version: 1,
    };
  };

  const monthStart = (offset: number) => {
    const [y, m] = today.split("-").map(Number);
    const total = y * 12 + (m - 1) + offset;
    const yy = Math.floor(total / 12);
    const mm = (total % 12) + 1;
    return `${yy}-${String(mm).padStart(2, "0")}-01`;
  };

  const invoices: Invoice[] = [
    invoice("d1", "INV-2026-000101", id("b1"), id("c1"), G11, "partially_paid", 400000, 150000, addDaysISO(today, -4), monthStart(-1)),
    invoice("d2", "INV-2026-000102", id("b1"), id("c1"), G11, "paid", 400000, 400000, addDaysISO(today, 3), monthStart(0)),
    invoice("d3", "INV-2026-000090", id("b1"), id("c1"), G11, "void", 400000, 0, addDaysISO(today, -34), monthStart(-2)),
    invoice("d4", "INV-2026-000103", id("b2"), id("c2"), G14, "issued", 500000, 0, addDaysISO(today, 5), monthStart(0)),
    invoice("d5", "INV-2026-000104", id("b4"), id("c4"), G11, "paid", 400000, 400000, addDaysISO(today, -2), monthStart(-1)),
    invoice("d6", "INV-2026-000105", id("b5"), id("c5"), G11, "issued", 400000, 0, addDaysISO(today, 6), monthStart(0)),
    invoice("d7", "INV-2026-000106", id("b7"), id("c4"), G14, "issued", 500000, 0, addDaysISO(today, -9), monthStart(-1)),
  ];

  // One invoice whose PDF has not been generated yet, so the "Preparing PDF…"
  // state (API_INTEGRATION §9) and INV-07 regenerate are reachable in the demo.
  invoices[6].hasPdf = false;

  // --- sessions (Step 4) ------------------------------------------------------
  // Past and future sessions carry fixed wall-clock times; TODAY's Under-11
  // session is anchored to "now" (started 30 minutes ago) so the coach's check-in
  // window and the attendance sheet are usable whenever the app is run — a fixed
  // time would make them dead outside a 3-hour window each day. Mock-only; the
  // real times come from the schedule generator (SES/SCH, backend).
  const at = (dateISO: string, clock: string) => academyLocalToInstant(dateISO, clock);
  const roundDownTo5 = (ms: number) => Math.floor(ms / 300_000) * 300_000;

  const sessionRec = (
    n: string,
    ageGroupId: string,
    startsAt: string,
    endsAt: string,
    opts: { leadCoachId?: string; status?: SessionStatus; cancelReason?: string } = {}
  ): SessionRec => {
    const group = groups.find((g) => g.id === ageGroupId)!;
    const leadCoach =
      opts.leadCoachId === COACH_ID
        ? { id: COACH_ID, fullName: "Demo Coach" }
        : opts.leadCoachId === COACH2_ID
          ? { id: COACH2_ID, fullName: "Nimal Perera" }
          : undefined;
    // Status by rule (ATTENDANCE §1): completed once ends_at + 24 h has passed.
    const auto = Date.parse(endsAt) + 86_400_000 < Date.now() ? "completed" : "scheduled";
    return {
      id: id(n),
      ageGroupId,
      ageGroup: { id: group.id, name: group.name },
      sessionDate: academyDateOf(startsAt),
      startsAt,
      endsAt,
      venue: ageGroupId === G14 ? "Training ground C" : "Training ground B",
      status: opts.status ?? auto,
      cancelReason: opts.cancelReason,
      leadCoach,
      version: 1,
    };
  };

  const s7Start = new Date(roundDownTo5(Date.now() - 30 * 60_000)).toISOString();
  const s7End = addMinutes(s7Start, 90);
  const s8Start = new Date(roundDownTo5(Date.now() + 180 * 60_000)).toISOString();

  const sessions: SessionRec[] = [
    sessionRec("s1", G11, at(addDaysISO(today, -14), "16:00"), at(addDaysISO(today, -14), "17:30"), { leadCoachId: COACH_ID }),
    sessionRec("s2", G11, at(addDaysISO(today, -7), "16:00"), at(addDaysISO(today, -7), "17:30"), { leadCoachId: COACH_ID }),
    sessionRec("s3", G11, at(addDaysISO(today, -3), "16:00"), at(addDaysISO(today, -3), "17:30"), { leadCoachId: COACH_ID }),
    sessionRec("s4", G11, at(addDaysISO(today, -1), "16:00"), at(addDaysISO(today, -1), "17:30"), { leadCoachId: COACH_ID }),
    sessionRec("s5", G14, at(addDaysISO(today, -6), "17:00"), at(addDaysISO(today, -6), "18:30"), { leadCoachId: COACH2_ID }),
    sessionRec("s6", G14, at(addDaysISO(today, -2), "17:00"), at(addDaysISO(today, -2), "18:30"), { leadCoachId: COACH2_ID }),
    // Today: the coach's group (check-in window open right now) and a later one
    // that is not open yet, so the disabled state is reachable.
    sessionRec("s7", G11, s7Start, s7End, { leadCoachId: COACH_ID }),
    sessionRec("s8", G14, s8Start, addMinutes(s8Start, 90), { leadCoachId: COACH2_ID }),
    // Tomorrow .. +16 days for the owner's list (the default window is +14 d).
    sessionRec("s9", G11, at(addDaysISO(today, 2), "16:00"), at(addDaysISO(today, 2), "17:30"), { leadCoachId: COACH_ID }),
    sessionRec("s10", G11, at(addDaysISO(today, 4), "16:00"), at(addDaysISO(today, 4), "17:30"), { leadCoachId: COACH_ID }),
    sessionRec("s11", G11, at(addDaysISO(today, 7), "16:00"), at(addDaysISO(today, 7), "17:30"), { leadCoachId: COACH_ID }),
    sessionRec("s12", G11, at(addDaysISO(today, 9), "16:00"), at(addDaysISO(today, 9), "17:30"), { leadCoachId: COACH_ID }),
    sessionRec("s13", G11, at(addDaysISO(today, 11), "16:00"), at(addDaysISO(today, 11), "17:30"), { leadCoachId: COACH_ID }),
    sessionRec("s14", G11, at(addDaysISO(today, 14), "16:00"), at(addDaysISO(today, 14), "17:30"), { leadCoachId: COACH_ID }),
    sessionRec("s15", G14, at(addDaysISO(today, 3), "17:00"), at(addDaysISO(today, 3), "18:30"), { leadCoachId: COACH2_ID }),
    sessionRec("s16", G14, at(addDaysISO(today, 10), "17:00"), at(addDaysISO(today, 10), "18:30"), { leadCoachId: COACH2_ID }),
    sessionRec("s17", G17, at(addDaysISO(today, 5), "15:00"), at(addDaysISO(today, 5), "16:30")),
    // Outside the default +14 d window, and one cancelled session for the
    // read-only banner.
    sessionRec("s18", G11, at(addDaysISO(today, 16), "16:00"), at(addDaysISO(today, 16), "17:30"), { leadCoachId: COACH_ID }),
    sessionRec("s19", G11, at(addDaysISO(today, 6), "16:00"), at(addDaysISO(today, 6), "17:30"), {
      leadCoachId: COACH_ID,
      status: "cancelled",
      cancelReason: "Ground unavailable (school match).",
    }),
  ];

  const mark = (
    sessionId: string,
    playerId: string,
    status: AttendanceStatus,
    opts: { note?: string; by?: string; at: string; version?: number }
  ): AttendanceRecord => ({
    sessionId,
    playerId,
    status,
    note: opts.note,
    markedAt: opts.at,
    markedBy: opts.by ?? "Demo Coach",
    version: opts.version ?? 1,
  });

  const s1At = sessions[0].startsAt;
  const s2At = sessions[1].startsAt;
  const s3At = sessions[2].startsAt;
  const s4At = sessions[3].startsAt;
  const s5At = sessions[4].startsAt;
  const s6At = sessions[5].startsAt;
  const s7At = sessions[6].startsAt;

  const attendance: AttendanceRecord[] = [
    mark(id("s1"), id("b1"), "present", { at: s1At }),
    mark(id("s2"), id("b1"), "late", { at: s2At, note: "Traffic on the way." }),
    mark(id("s3"), id("b1"), "present", { at: s3At }),
    mark(id("s4"), id("b1"), "absent", { at: s4At, note: "School match." }),
    mark(id("s1"), id("b4"), "present", { at: s1At }),
    mark(id("s2"), id("b4"), "present", { at: s2At }),
    mark(id("s3"), id("b4"), "excused", { at: s3At, note: "Unwell." }),
    mark(id("s1"), id("b5"), "present", { at: s1At }),
    mark(id("s5"), id("b2"), "present", { at: s5At, by: "Nimal Perera" }),
    mark(id("s6"), id("b2"), "absent", { at: s6At, by: "Nimal Perera" }),
    // Today's sheet starts with exactly one SAVED row (marked by the owner), so
    // changing it must ask for a reason, while the other rows are unmarked.
    mark(id("s7"), id("b5"), "absent", { at: s7At, by: "Demo Owner", note: "Told the coach he may be late." }),
  ];

  // --- coach check-ins (Step 4) ----------------------------------------------
  // One closed record yesterday, one closed record for the second coach, and one
  // left open for two days so the "open check-in needs correction" state is real.
  const coachAttendance: CoachAttendanceRec[] = [
    {
      id: id("ca1"),
      coachUserId: COACH_ID,
      coachName: "Demo Coach",
      sessionId: id("s4"),
      checkInAt: addMinutes(s4At, -10),
      checkOutAt: addMinutes(s4At, 100),
      enteredBy: "self",
      corrected: false,
      version: 1,
    },
    {
      id: id("ca2"),
      coachUserId: COACH2_ID,
      coachName: "Nimal Perera",
      sessionId: id("s5"),
      checkInAt: addMinutes(s5At, -5),
      checkOutAt: addMinutes(s5At, 95),
      checkInNote: "Set up the cones first.",
      enteredBy: "self",
      corrected: false,
      version: 1,
    },
    {
      id: id("ca3"),
      coachUserId: COACH2_ID,
      coachName: "Nimal Perera",
      sessionId: id("s6"),
      checkInAt: addMinutes(s6At, -8),
      enteredBy: "self",
      corrected: false,
      version: 1,
    },
  ];

  const coaches: Db["coaches"] = [
    {
      user: { id: COACH_ID, username: "coach", fullName: "Demo Coach", phone: "+94771111111", role: "coach", status: "active", totpEnabled: false, lastLoginAt: addDaysISO(today, -1) + "T03:00:00Z" },
      groups: [{ id: G11, name: "Under-11" }],
    },
    {
      user: { id: COACH2_ID, username: "nimal", fullName: "Nimal Perera", phone: "+94772222222", role: "coach", status: "active", totpEnabled: false, lastLoginAt: addDaysISO(today, -2) + "T03:00:00Z" },
      groups: [{ id: G14, name: "Under-14" }],
    },
  ];

  const assignments: CoachAssignment[] = [
    { id: "as-1", coachUserId: COACH_ID, coachName: "Demo Coach", ageGroup: { id: G11, name: "Under-11" }, assignedFrom: addDaysISO(today, -180) },
    { id: "as-2", coachUserId: COACH2_ID, coachName: "Nimal Perera", ageGroup: { id: G14, name: "Under-14" }, assignedFrom: addDaysISO(today, -120) },
  ];

  // --- payment methods, academy settings (SET-02/04 reads; screens are Step 8) -
  const methods: PaymentMethod[] = [
    { code: "cash", label: "Cash", requiresReference: false, isActive: true },
    { code: "bank_transfer", label: "Bank transfer", requiresReference: true, isActive: true },
    { code: "card", label: "Card payment", requiresReference: true, isActive: false },
  ];

  const settings: MockSettings = {
    billingFrequency: "monthly",
    billingPeriodMode: "calendar",
    weekStartDay: 1,
    invoiceIssueTiming: "period_start",
    dueRuleType: "days_after_issue",
    dueRuleValue: 7,
    allowFractionalMoney: false,
    effectNote: "Applies to invoices issued after now.",
    academyName: "Inspire Academy",
    paymentInstructions:
      "Demo Bank · Account 0001 2345 6789 · Branch Colombo 07 · Quote your invoice number as the reference.",
    beneficiaryAccounts: [{ name: "Inspire Academy", accountMasked: "****0001" }],
    // CR-003's automatic-check switch is not approved, so nothing runs checks on
    // upload (ADR-019 Proposed); the explicit PRF-04 re-check is always allowed.
    proofAutoCheck: false,
    whatsappSession: "awaiting_qr",
  };

  // --- one fee line per seeded invoice (INV-02 returns `items`) ---------------
  const monthLabel = (dateISO?: string) => {
    if (!dateISO) return "";
    const [y, m] = dateISO.split("-");
    const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const index = Number(m) - 1;
    return names[index] ? `${names[index]} ${y}` : "";
  };

  const invoiceItems: { invoiceId: string; item: InvoiceItem }[] = invoices.map((inv) => ({
    invoiceId: inv.id,
    item: {
      id: `${inv.id}-item1`,
      lineNo: 1,
      itemType: "fee" as const,
      description: `Monthly fee – ${inv.ageGroup.name} (${monthLabel(inv.periodStart)})`,
      quantity: 1,
      unitAmountMinor: inv.totalMinor,
      amountMinor: inv.totalMinor,
    },
  }));

  // --- payments (Step 5) ------------------------------------------------------
  // The seeded ledger reproduces exactly the invoice balances the Step 3 fixtures
  // showed (INV-101 part paid 1,500; INV-102 and INV-104 paid) — balances are
  // DERIVED from these allocations on every read (BILLING_ENGINE §1.4), so the
  // two can never drift apart. Demo coverage: a cleaned bank transfer holding
  // credit, two payments awaiting verification (one PDF to check, one photo that
  // cannot be verified), a rejected one and a reversed one.
  const allocation = (
    paymentId: string,
    invoiceId: string,
    amountMinor: number,
    allocatedAt: string,
    reversedAt?: string
  ): Allocation => ({
    id: `al-${paymentId}-${invoiceId}`,
    paymentId,
    invoice: {
      id: invoiceId,
      invoiceNumber: invoices.find((i) => i.id === invoiceId)!.invoiceNumber,
    },
    amountMinor,
    allocatedAt,
    reversedAt,
  });

  const atDays = (offset: number, clock = "04:00:00Z") => `${addDaysISO(today, offset)}T${clock}`;

  const payments: PaymentRec[] = [
    {
      id: id("p1"),
      amountMinor: 1000000,
      methodCode: "bank_transfer",
      reference: "TRX99",
      receivedAt: atDays(-3),
      payerGuardianId: id("c1"),
      payerName: "Demo Guardian",
      status: "confirmed",
      notes: "Covers the October balance and November in advance.",
      allocations: [
        allocation(id("p1"), id("d1"), 150000, atDays(-3, "04:05:00Z")),
        allocation(id("p1"), id("d2"), 400000, atDays(-3, "04:05:00Z")),
      ],
      proofs: [
        {
          fileId: id("h1"),
          paymentId: id("p1"),
          originalName: "demo-bank-receipt.pdf",
          mimeType: "application/pdf",
          sizeBytes: 96421,
          uploadedAt: atDays(-3, "04:02:00Z"),
          uploadedById: OWNER_ID,
          uploadedByName: "Demo Owner",
          docKind: "bank_receipt_pdf",
          sha256: "seed-proof-1",
          stubKind: "pdf",
          // Already checked by hand earlier — and its reference is what makes the
          // pending transfer below a REUSED receipt (PAYMENT_VERIFICATION §4.2).
          verification: {
            docKind: "bank_receipt_pdf",
            status: "checked",
            parserVersion: "mock-bank@0.1.0",
            checkedAt: atDays(-3, "04:06:00Z"),
            extracted: {
              bankName: "Demo Bank",
              documentType: "Fund Transfer Confirmation",
              reference: "DEMO-REF-0001",
              transactionAt: atDays(-3, "04:00:00Z"),
              amountMinor: 1000000,
              currency: "LKR",
              payerName: "Demo Guardian",
              payerAccountMasked: "****0000",
              beneficiaryName: "Inspire Academy",
              beneficiaryAccountMasked: "****0001",
              channel: "CEFT",
              status: "Successful",
              remarks: "INV-2026-000101, INV-2026-000102",
            },
            findings: [
              { code: "AMOUNT_MATCH", level: 2, result: "pass", detail: "Receipt amount equals the recorded amount." },
              { code: "BENEFICIARY_MATCH", level: 2, result: "pass", detail: "Beneficiary matches an academy account." },
              { code: "REFERENCE_MATCH", level: 2, result: "pass", detail: "Receipt reference equals the recorded reference." },
              { code: "STATUS_SUCCESSFUL", level: 2, result: "pass", detail: "The receipt reports a successful transfer." },
              { code: "RECEIPT_NOT_REUSED", level: 2, result: "pass", detail: "This receipt is not attached to another payment." },
            ],
          },
        },
      ],
      receipts: [
        { id: id("t1"), receiptNumber: "RCT-2026-000001", issuedAt: atDays(-3, "04:05:30Z"), voided: false },
      ],
      version: 1,
    },
    {
      id: id("p2"),
      amountMinor: 400000,
      methodCode: "cash",
      receivedAt: atDays(-2, "10:15:00Z"),
      payerGuardianId: id("c4"),
      payerName: "Rizwan Ahamed",
      status: "confirmed",
      allocations: [allocation(id("p2"), id("d5"), 400000, atDays(-2, "10:16:00Z"))],
      proofs: [],
      receipts: [
        { id: id("t2"), receiptNumber: "RCT-2026-000002", issuedAt: atDays(-2, "10:16:30Z"), voided: false },
      ],
      version: 1,
    },
    {
      id: id("p3"),
      amountMinor: 500000,
      methodCode: "bank_transfer",
      reference: "DEMO-REF-0001",
      receivedAt: atDays(-1, "05:30:00Z"),
      payerGuardianId: id("c1"),
      payerName: "Demo Guardian",
      status: "pending",
      notes: "Guardian sent a PDF receipt for the Under-14 fee.",
      allocations: [],
      proofs: [
        {
          fileId: id("h2"),
          paymentId: id("p3"),
          originalName: "receipt.pdf",
          mimeType: "application/pdf",
          sizeBytes: 88210,
          uploadedAt: atDays(-1, "05:28:00Z"),
          uploadedById: OWNER_ID,
          uploadedByName: "Demo Owner",
          docKind: "bank_receipt_pdf",
          sha256: "seed-proof-2",
          stubKind: "pdf",
          // No verification yet: the owner presses Verify (PRF-04) and sees the
          // reused-reference failure — the check never confirms anything.
        },
      ],
      receipts: [],
      version: 1,
    },
    {
      id: id("p4"),
      amountMinor: 400000,
      methodCode: "bank_transfer",
      reference: "TRX-PHOTO-77",
      receivedAt: atDays(-2, "06:00:00Z"),
      payerGuardianId: id("c5"),
      payerName: "Kumari Jayasuriya",
      status: "pending",
      notes: "Guardian sent a photo of the slip, not the PDF.",
      allocations: [],
      proofs: [
        {
          fileId: id("h3"),
          paymentId: id("p4"),
          originalName: "slip-photo.jpg",
          mimeType: "image/jpeg",
          sizeBytes: 402113,
          uploadedAt: atDays(-2, "05:59:00Z"),
          uploadedById: OWNER_ID,
          uploadedByName: "Demo Owner",
          docKind: "bank_receipt_image",
          sha256: "seed-proof-3",
          stubKind: "image",
        },
      ],
      receipts: [],
      version: 1,
    },
    {
      id: id("p5"),
      amountMinor: 500000,
      methodCode: "cash",
      receivedAt: atDays(-6, "09:00:00Z"),
      payerGuardianId: id("c2"),
      payerName: "Sunil Fernando",
      status: "rejected",
      rejectReason: "Recorded against the wrong child — re-entered under the right guardian.",
      allocations: [],
      proofs: [],
      receipts: [],
      version: 1,
    },
    {
      id: id("p6"),
      amountMinor: 400000,
      methodCode: "cash",
      receivedAt: atDays(-9, "11:30:00Z"),
      payerGuardianId: id("c5"),
      payerName: "Kumari Jayasuriya",
      status: "reversed",
      reverseReason: "Owner reversed it after the guardian asked for a cash refund.",
      allocations: [allocation(id("p6"), id("d6"), 400000, atDays(-9, "11:31:00Z"), addDaysISO(today, -5) + "T03:00:00Z")],
      proofs: [],
      receipts: [
        { id: id("t3"), receiptNumber: "RCT-2026-000003", issuedAt: atDays(-9, "11:32:00Z"), voided: true },
      ],
      version: 1,
    },
  ];

  const billingRuns: BillingRun[] = [
    {
      id: id("r1"),
      runKey: `scheduler:${monthStart(-1)}`,
      status: "issued",
      targetDate: monthStart(-1),
      invoicesCreated: 3,
      invoicesSkipped: 2,
      invoiceIds: [id("d1"), id("d2"), id("d3")],
      startedAt: `${monthStart(-1)}T02:00:00Z`,
      completedAt: `${monthStart(-1)}T02:00:12Z`,
    },
  ];

  const messages: MessageJob[] = [];

  return {
    schema: SCHEMA,
    groups,
    fees,
    players,
    guardians,
    history,
    invoices,
    invoiceItems,
    payments,
    methods,
    billingRuns,
    messages,
    settings,
    suppressedReissue: [],
    sessions,
    attendance,
    coachAttendance,
    assignments,
    coaches,
    importBatches: [],
    counters: { player: 8, invoice: 106, import: 0, payment: 7, receipt: 3, run: 1, message: 0 },
  };
}

function readStored(): Db | null {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Db;
    return parsed.schema === SCHEMA ? parsed : null;
  } catch {
    return null;
  }
}

function persist(db: Db) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(db));
  } catch {
    // Storage unavailable: the store still works for this document.
  }
}

export function getDb(): Db {
  if (cache) return cache;
  cache = readStored() ?? seed();
  persist(cache);
  return cache;
}

/** Billing logic writes through here (src/mocks/billing.ts) and saves. */
export function saveDb(): Db {
  const db = getDb();
  persist(db);
  return db;
}

function changed(): Db {
  const db = getDb();
  persist(db);
  return db;
}

/** Dev helper: drop the mirrored store (used by the E2E script for a clean run). */
export function resetMockPeople() {
  cache = null;
  try {
    localStorage.removeItem(STORE_KEY);
  } catch {
    // ignore
  }
}

// --- derived helpers --------------------------------------------------------
function nextId(prefix: string, n: number): string {
  return `0192a000-0000-7000-8000-${prefix}${String(n).padStart(11, "0")}`;
}

function outstandingOf(db: Db, playerId: string): number {
  return db.invoices
    .filter((i) => i.player.id === playerId && i.status !== "void")
    .reduce((sum, i) => sum + i.balanceMinor, 0);
}

function currentGroupOf(db: Db, playerId: string): GroupHistoryEntry | undefined {
  return db.history.find((h) => h.playerId === playerId && !h.effectiveTo);
}

function referenceDate(): string {
  return `${todayISO().slice(0, 4)}-01-01`;
}

function coachGroupIds(db: Db, coachUserId: string): string[] {
  return db.coaches.find((c) => c.user.id === coachUserId)?.groups.map((g) => g.id) ?? [];
}

export function coachView(p: Player, groupName?: string): PlayerCoachView {
  const primary = p.guardians.find((g) => g.isPrimary)?.guardian;
  return {
    id: p.id,
    registrationNo: p.registrationNo,
    fullName: p.fullName,
    age: p.dateOfBirth ? ageOn(p.dateOfBirth, referenceDate()) : undefined,
    status: p.status,
    group: p.currentGroup ? { id: p.currentGroup.id, name: groupName ?? p.currentGroup.name } : undefined,
    coachNotes: p.coachNotes,
    primaryGuardian: primary ? { fullName: primary.fullName, phone: primary.phone } : undefined,
  };
}

function withComputed(db: Db, p: Player): Player {
  const open = currentGroupOf(db, p.id);
  return {
    ...p,
    currentGroup: open
      ? { id: open.ageGroup.id, name: open.ageGroup.name, since: open.effectiveFrom }
      : undefined,
    outstandingMinor: outstandingOf(db, p.id),
  };
}

// --- queries ----------------------------------------------------------------
export function listPlayers(
  params: {
    q?: string;
    status?: PlayerStatus;
    ageGroupId?: string;
    hasOutstanding?: boolean;
    page?: number;
    pageSize?: number;
    sort?: string;
  },
  viewer: { role: "owner" | "coach"; userId: string }
): { data: PlayerListItem[]; meta: { page: number; pageSize: number; total: number; totalPages: number } } {
  const db = getDb();
  const scope = viewer.role === "coach" ? coachGroupIds(db, viewer.userId) : null;
  let rows = db.players.map((p) => withComputed(db, p));

  if (scope) rows = rows.filter((p) => p.currentGroup && scope.includes(p.currentGroup.id));
  const status = params.status ?? "active";
  rows = rows.filter((p) => p.status === status);
  if (params.ageGroupId) rows = rows.filter((p) => p.currentGroup?.id === params.ageGroupId);
  if (params.hasOutstanding) rows = rows.filter((p) => (p.outstandingMinor ?? 0) > 0);
  const q = params.q?.trim().toLowerCase();
  if (q && q.length >= 2) {
    rows = rows.filter(
      (p) =>
        p.fullName.toLowerCase().includes(q) ||
        p.registrationNo.toLowerCase().includes(q)
    );
  }

  const sort = params.sort ?? "fullName";
  const dir = sort.startsWith("-") ? -1 : 1;
  const key = sort.replace(/^-/, "");
  rows.sort((a, b) => {
    const av = key === "registrationDate" ? a.registrationDate : key === "registrationNo" ? a.registrationNo : a.fullName;
    const bv = key === "registrationDate" ? b.registrationDate : key === "registrationNo" ? b.registrationNo : b.fullName;
    return av.localeCompare(bv) * dir || a.id.localeCompare(b.id);
  });

  const page = Math.max(1, params.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, params.pageSize ?? 25));
  const paged = rows.slice((page - 1) * pageSize, page * pageSize);

  const data: PlayerListItem[] =
    viewer.role === "coach"
      ? paged.map((p) => coachView(p, p.currentGroup?.name))
      : paged;

  return {
    data,
    meta: { page, pageSize, total: rows.length, totalPages: Math.max(1, Math.ceil(rows.length / pageSize)) },
  };
}

/** PLY-03 — coach out of scope returns undefined (handler answers 404). */
export function getPlayer(
  playerId: string,
  viewer: { role: "owner" | "coach"; userId: string }
): PlayerListItem | undefined {
  const db = getDb();
  const p = db.players.find((x) => x.id === playerId);
  if (!p) return undefined;
  const full = withComputed(db, p);
  if (viewer.role === "coach") {
    const scope = coachGroupIds(db, viewer.userId);
    if (!full.currentGroup || !scope.includes(full.currentGroup.id)) return undefined;
    return coachView(full, full.currentGroup.name);
  }
  return full;
}

export function underlyingPlayer(playerId: string): Player | undefined {
  const db = getDb();
  const p = db.players.find((x) => x.id === playerId);
  return p ? withComputed(db, p) : undefined;
}

export function playerHistory(playerId: string): GroupHistoryEntry[] {
  const db = getDb();
  return db.history
    .filter((h) => h.playerId === playerId)
    .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));
}

/** INV-02 read — the Step 3 profile links to an invoice detail page. */
export function getInvoice(invoiceId: string): Invoice | undefined {
  return getDb().invoices.find((i) => i.id === invoiceId);
}

export function playerInvoices(playerId: string): Invoice[] {
  return getDb()
    .invoices.filter((i) => i.player.id === playerId)
    .sort((a, b) => b.issueDate.localeCompare(a.issueDate));
}

export function playerAttendance(playerId: string, from?: string, to?: string): PlayerAttendance {
  const db = getDb();
  const rows = db.attendance
    .filter((a) => a.playerId === playerId)
    .map((a) => ({ record: a, session: db.sessions.find((s) => s.id === a.sessionId) }))
    .filter((r) => r.session)
    .filter((r) => (!from || r.session!.sessionDate >= from) && (!to || r.session!.sessionDate <= to))
    .sort((a, b) => b.session!.sessionDate.localeCompare(a.session!.sessionDate));
  const count = (s: PlayerAttendance["data"][number]["status"]) =>
    rows.filter((r) => r.record.status === s).length;
  return {
    summary: {
      present: count("present"),
      absent: count("absent"),
      late: count("late"),
      excused: count("excused"),
    },
    data: rows.map((r) => ({
      sessionId: r.session!.id,
      sessionDate: r.session!.sessionDate,
      status: r.record.status,
      note: r.record.note,
    })),
  };
}

export function playerBalance(playerId: string): PlayerBalance {
  const db = getDb();
  const today = todayISO();
  const open = db.invoices.filter(
    (i) => i.player.id === playerId && (i.status === "issued" || i.status === "partially_paid")
  );
  return {
    outstandingMinor: open.reduce((s, i) => s + i.balanceMinor, 0),
    overdueMinor: open.filter((i) => i.dueDate < today).reduce((s, i) => s + i.balanceMinor, 0),
    creditMinor: 0,
  };
}

export function listGroups(
  includeArchived: boolean,
  viewer: { role: "owner" | "coach"; userId: string }
): AgeGroup[] {
  const db = getDb();
  let groups = db.groups.filter((g) => includeArchived || !g.archivedAt);
  if (viewer.role === "coach") {
    const scope = coachGroupIds(db, viewer.userId);
    groups = groups.filter((g) => scope.includes(g.id));
  }
  return groups
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((g) => {
      const active = db.players.filter(
        (p) => p.status === "active" && currentGroupOf(db, p.id)?.ageGroup.id === g.id
      ).length;
      const fee = db.fees
        .filter((f) => f.ageGroupId === g.id && !f.effectiveTo && f.effectiveFrom <= todayISO())
        .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0];
      return {
        ...g,
        activePlayerCount: active,
        currentFeeMinor: viewer.role === "coach" ? undefined : fee?.amountMinor ?? g.currentFeeMinor,
      };
    });
}

export function getGroup(groupId: string): AgeGroup | undefined {
  return listGroups(true, { role: "owner", userId: OWNER_ID }).find((g) => g.id === groupId);
}

export function groupFees(ageGroupId: string): GroupFee[] {
  return getDb()
    .fees.filter((f) => f.ageGroupId === ageGroupId)
    .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));
}

export function groupRoster(ageGroupId: string): Player[] {
  const db = getDb();
  return db.players
    .filter((p) => currentGroupOf(db, p.id)?.ageGroup.id === ageGroupId)
    .map((p) => withComputed(db, p))
    .sort((a, b) => a.fullName.localeCompare(b.fullName));
}

export function suggestGroup(dateOfBirth: string): AgeGroupSuggestion {
  const db = getDb();
  const ref = referenceDate();
  const age = ageOn(dateOfBirth, ref);
  return {
    referenceDate: ref,
    ageOnReference: age,
    suggestions: db.groups
      .filter(
        (g) =>
          !g.archivedAt &&
          (g.minAge === undefined || age >= g.minAge) &&
          (g.maxAge === undefined || age <= g.maxAge)
      )
      .map((g) => ({ ageGroupId: g.id, name: g.name })),
  };
}

export function checkDuplicates(input: {
  fullName: string;
  dateOfBirth?: string;
  guardianPhones?: string[];
}): DuplicateMatch[] {
  const db = getDb();
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
  const name = norm(input.fullName);
  const phones = new Set(input.guardianPhones ?? []);
  const matches: DuplicateMatch[] = [];
  for (const p of db.players) {
    const reasons: string[] = [];
    let score = 0;
    if (norm(p.fullName) === name) {
      reasons.push("Same name");
      score += 0.6;
    }
    if (input.dateOfBirth && p.dateOfBirth === input.dateOfBirth) {
      reasons.push("Same date of birth");
      score += 0.3;
    }
    const sharedPhone = p.guardians.some((l) => phones.has(l.guardian.phone));
    if (sharedPhone) {
      reasons.push("Same guardian phone");
      score += 0.3;
    }
    if (reasons.length && score >= 0.6) {
      matches.push({ player: withComputed(db, p), reason: reasons.join(" · "), score: Math.min(1, score) });
    }
  }
  return matches.sort((a, b) => b.score - a.score);
}

export function listGuardians(q?: string): GuardianWithPlayers[] {
  const db = getDb();
  const term = q?.trim().toLowerCase();
  return db.guardians
    .filter((g) => !term || term.length < 2 || g.fullName.toLowerCase().includes(term) || g.phone.includes(term))
    .map((g) => ({
      ...g,
      players: db.players
        .filter((p) => p.guardians.some((l) => l.guardian.id === g.id))
        .map((p) => ({ id: p.id, fullName: p.fullName })),
    }));
}

export function guardianBalance(guardianId: string) {
  const db = getDb();
  const playerIds = db.players
    .filter((p) => p.guardians.some((l) => l.guardian.id === guardianId))
    .map((p) => p.id);
  const open = db.invoices.filter(
    (i) => playerIds.includes(i.player.id) && (i.status === "issued" || i.status === "partially_paid")
  );
  const today = todayISO();
  return {
    outstandingMinor: open.reduce((s, i) => s + i.balanceMinor, 0),
    overdueMinor: open.filter((i) => i.dueDate < today).reduce((s, i) => s + i.balanceMinor, 0),
    creditMinor: 0,
    openInvoices: open,
  };
}

export function listCoaches(q?: string): CoachRow[] {
  const db = getDb();
  const term = q?.trim().toLowerCase();
  return db.coaches
    .filter((c) => !term || c.user.fullName.toLowerCase().includes(term) || c.user.username.includes(term))
    .map((c) => ({ user: c.user, groups: c.groups }));
}

export function listAssignments(params: {
  coachUserId?: string;
  ageGroupId?: string;
}): CoachAssignment[] {
  const db = getDb();
  return db.assignments.filter(
    (a) =>
      (!params.coachUserId || a.coachUserId === params.coachUserId) &&
      (!params.ageGroupId || a.ageGroup.id === params.ageGroupId)
  );
}

// --- mutations --------------------------------------------------------------
export function createPlayer(input: PlayerCreate): Player {
  const db = getDb();
  const matches = checkDuplicates({
    fullName: input.fullName,
    dateOfBirth: input.dateOfBirth,
    guardianPhones: input.guardians
      .map((g) => ("phone" in g ? g.phone : undefined))
      .filter((p): p is string => Boolean(p)),
  });
  if (matches.length && !input.acknowledgeDuplicates) {
    throw new MockError(
      "DUPLICATE_SUSPECTED",
      "A player with these details may already exist.",
      409,
      [{ field: "fullName", issue: "Possible duplicate", meta: { matches } }]
    );
  }

  const guardianLinks = input.guardians.map((entry) => {
    if ("guardianId" in entry) {
      const guardian = db.guardians.find((g) => g.id === entry.guardianId);
      if (!guardian) throw new MockError("VALIDATION_ERROR", "Guardian not found.", 422, [{ field: "guardians", issue: "Unknown guardian" }]);
      return { guardian, isPrimary: entry.isPrimary, receivesInvoices: entry.receivesInvoices };
    }
    const existing = db.guardians.find((g) => g.phone === entry.phone) ?? null;
    const guardian: Guardian = existing ?? {
      id: nextId("c", db.guardians.length + 10),
      fullName: entry.fullName,
      phone: entry.phone,
      relationship: entry.relationship,
      whatsappConsent: entry.whatsappConsent?.status ?? "unknown",
      consentRecordedAt: entry.whatsappConsent ? `${todayISO()}T03:00:00Z` : undefined,
      consentSource: entry.whatsappConsent?.source,
    };
    if (!existing) db.guardians.push(guardian);
    return { guardian, isPrimary: entry.isPrimary, receivesInvoices: entry.receivesInvoices };
  });

  db.counters.player += 1;
  const registrationNo = `IA-${String(db.counters.player).padStart(4, "0")}`;
  const player: Player = {
    id: nextId("b", db.counters.player + 10),
    registrationNo,
    fullName: input.fullName,
    dateOfBirth: input.dateOfBirth,
    ageOnReference: input.dateOfBirth ? ageOn(input.dateOfBirth, referenceDate()) : undefined,
    registrationDate: input.registrationDate,
    status: "active",
    statusEffectiveDate: input.registrationDate,
    guardians: guardianLinks,
    notes: input.notes,
    coachNotes: input.coachNotes,
    billingAnchorDate: input.registrationDate,
    outstandingMinor: 0,
    version: 1,
  };
  db.players.push(player);

  if (input.ageGroupId) {
    const group = db.groups.find((g) => g.id === input.ageGroupId);
    if (!group) throw new MockError("VALIDATION_ERROR", "Age group not found.", 422, [{ field: "ageGroupId", issue: "Unknown group" }]);
    db.history.push({
      id: `hist-${registrationNo}`,
      playerId: player.id,
      ageGroup: { id: group.id, name: group.name },
      effectiveFrom: input.registrationDate,
      changedBy: { id: OWNER_ID, fullName: "Demo Owner" },
    });
  }
  changed();
  return withComputed(db, player);
}

function assertVersion(current: number, sent: number | undefined) {
  if (sent !== undefined && sent !== current) {
    throw new MockError("VERSION_CONFLICT", "This record was changed by someone else.", 409);
  }
}

export function patchPlayer(playerId: string, input: Partial<Player> & { version?: number }): Player {
  const db = getDb();
  const p = db.players.find((x) => x.id === playerId);
  if (!p) throw new MockError("NOT_FOUND", "Player not found.", 404);
  assertVersion(p.version, input.version);
  if (input.billingAnchorDate && input.billingAnchorDate !== p.billingAnchorDate) {
    const invoiced = db.invoices.some((i) => i.player.id === p.id);
    if (invoiced) {
      throw new MockError(
        "VALIDATION_ERROR",
        "The billing anchor cannot change once an invoice has been issued.",
        422,
        [{ field: "billingAnchorDate", issue: "Blocked: the player already has invoices" }]
      );
    }
  }
  for (const key of ["fullName", "dateOfBirth", "registrationDate", "notes", "coachNotes", "billingAnchorDate"] as const) {
    if (input[key] !== undefined) {
      (p as unknown as Record<string, unknown>)[key] = input[key];
    }
  }
  if (input.dateOfBirth) p.ageOnReference = ageOn(input.dateOfBirth, referenceDate());
  p.version += 1;
  changed();
  return withComputed(db, p);
}

export function setPlayerStatus(
  playerId: string,
  input: { status: PlayerStatus; effectiveDate: string; reason?: string; version?: number }
): Player {
  const db = getDb();
  const p = db.players.find((x) => x.id === playerId);
  if (!p) throw new MockError("NOT_FOUND", "Player not found.", 404);
  assertVersion(p.version, input.version);
  p.status = input.status;
  p.statusEffectiveDate = input.effectiveDate;
  p.statusReason = input.reason;
  p.version += 1;
  if (input.status === "withdrawn") {
    const open = db.history.find((h) => h.playerId === p.id && !h.effectiveTo);
    if (open) open.effectiveTo = addDaysISO(input.effectiveDate, -1);
  }
  changed();
  return withComputed(db, p);
}

export function transferPlayer(
  playerId: string,
  input: { ageGroupId: string; effectiveFrom: string; reason: string; version?: number }
): Player {
  const db = getDb();
  const p = db.players.find((x) => x.id === playerId);
  if (!p) throw new MockError("NOT_FOUND", "Player not found.", 404);
  assertVersion(p.version, input.version);
  const group = db.groups.find((g) => g.id === input.ageGroupId);
  if (!group) throw new MockError("VALIDATION_ERROR", "Age group not found.", 422, [{ field: "ageGroupId", issue: "Unknown group" }]);
  const open = db.history.find((h) => h.playerId === p.id && !h.effectiveTo);
  if (open && open.ageGroup.id === group.id) {
    throw new MockError("VALIDATION_ERROR", "The player is already in this group.", 422, [{ field: "ageGroupId", issue: "Same group" }]);
  }
  if (open) open.effectiveTo = addDaysISO(input.effectiveFrom, -1);
  db.history.push({
    id: `hist-${p.registrationNo}-${db.history.length + 1}`,
    playerId: p.id,
    ageGroup: { id: group.id, name: group.name },
    effectiveFrom: input.effectiveFrom,
    reason: input.reason,
    changedBy: { id: OWNER_ID, fullName: "Demo Owner" },
  });
  p.version += 1;
  changed();
  return withComputed(db, p);
}

export function patchGuardian(
  guardianId: string,
  input: { fullName?: string; phone?: string; relationship?: string }
): Guardian {
  const db = getDb();
  const g = db.guardians.find((x) => x.id === guardianId);
  if (!g) throw new MockError("NOT_FOUND", "Guardian not found.", 404);
  Object.assign(g, input);
  changed();
  return g;
}

export function linkGuardian(
  playerId: string,
  input: { guardianId: string; isPrimary: boolean; receivesInvoices: boolean }
): Player {
  const db = getDb();
  const p = db.players.find((x) => x.id === playerId);
  if (!p) throw new MockError("NOT_FOUND", "Player not found.", 404);
  const guardian = db.guardians.find((g) => g.id === input.guardianId);
  if (!guardian) throw new MockError("VALIDATION_ERROR", "Guardian not found.", 422, [{ field: "guardianId", issue: "Unknown guardian" }]);
  if (p.guardians.some((l) => l.guardian.id === guardian.id)) {
    throw new MockError("VALIDATION_ERROR", "This guardian is already linked.", 422, [{ field: "guardianId", issue: "Already linked" }]);
  }
  if (input.isPrimary) p.guardians = p.guardians.map((l) => ({ ...l, isPrimary: false }));
  p.guardians.push({ guardian, isPrimary: input.isPrimary, receivesInvoices: input.receivesInvoices });
  p.version += 1;
  changed();
  return withComputed(db, p);
}

export function patchLink(
  playerId: string,
  guardianId: string,
  input: { isPrimary?: boolean; receivesInvoices?: boolean }
): Player {
  const db = getDb();
  const p = db.players.find((x) => x.id === playerId);
  if (!p) throw new MockError("NOT_FOUND", "Player not found.", 404);
  const link = p.guardians.find((l) => l.guardian.id === guardianId);
  if (!link) throw new MockError("NOT_FOUND", "Guardian link not found.", 404);
  if (input.isPrimary) p.guardians = p.guardians.map((l) => ({ ...l, isPrimary: l.guardian.id === guardianId }));
  if (input.receivesInvoices !== undefined) link.receivesInvoices = input.receivesInvoices;
  p.version += 1;
  changed();
  return withComputed(db, p);
}

export function removeLink(playerId: string, guardianId: string): void {
  const db = getDb();
  const p = db.players.find((x) => x.id === playerId);
  if (!p) throw new MockError("NOT_FOUND", "Player not found.", 404);
  if (p.guardians.length <= 1) {
    throw new MockError("VALIDATION_ERROR", "A player needs at least one guardian.", 422, [{ field: "guardianId", issue: "Cannot remove the last guardian" }]);
  }
  p.guardians = p.guardians.filter((l) => l.guardian.id !== guardianId);
  if (!p.guardians.some((l) => l.isPrimary) && p.guardians[0]) p.guardians[0].isPrimary = true;
  p.version += 1;
  changed();
}

export function setConsent(
  guardianId: string,
  input: { status: "granted" | "revoked" | "unknown"; source: string; note?: string }
): Guardian {
  const db = getDb();
  const g = db.guardians.find((x) => x.id === guardianId);
  if (!g) throw new MockError("NOT_FOUND", "Guardian not found.", 404);
  g.whatsappConsent = input.status;
  g.consentRecordedAt = `${todayISO()}T03:00:00Z`;
  g.consentSource = input.source;
  g.optedOutAt = input.status === "revoked" ? g.consentRecordedAt : undefined;
  changed();
  return g;
}

export function createGroup(input: {
  name: string;
  minAge?: number;
  maxAge?: number;
  sortOrder?: number;
}): AgeGroup {
  const db = getDb();
  if (db.groups.some((g) => !g.archivedAt && g.name.toLowerCase() === input.name.trim().toLowerCase())) {
    throw new MockError("VALIDATION_ERROR", "An active group already uses this name.", 422, [{ field: "name", issue: "Name must be unique" }]);
  }
  if (input.minAge !== undefined && input.maxAge !== undefined && input.minAge > input.maxAge) {
    throw new MockError("VALIDATION_ERROR", "Minimum age must not exceed maximum age.", 422, [{ field: "minAge", issue: "Min > max" }]);
  }
  const group: AgeGroup = {
    id: nextId("a", db.groups.length + 10),
    name: input.name.trim(),
    minAge: input.minAge,
    maxAge: input.maxAge,
    sortOrder: input.sortOrder ?? db.groups.length + 1,
    activePlayerCount: 0,
  };
  db.groups.push(group);
  changed();
  return group;
}

export function patchGroup(
  groupId: string,
  input: { name?: string; minAge?: number; maxAge?: number; sortOrder?: number }
): AgeGroup {
  const db = getDb();
  const g = db.groups.find((x) => x.id === groupId);
  if (!g) throw new MockError("NOT_FOUND", "Age group not found.", 404);
  if (
    input.name &&
    db.groups.some((x) => x.id !== groupId && !x.archivedAt && x.name.toLowerCase() === input.name!.trim().toLowerCase())
  ) {
    throw new MockError("VALIDATION_ERROR", "An active group already uses this name.", 422, [{ field: "name", issue: "Name must be unique" }]);
  }
  const next = { ...g, ...input, name: input.name?.trim() ?? g.name };
  if (next.minAge !== undefined && next.maxAge !== undefined && next.minAge > next.maxAge) {
    throw new MockError("VALIDATION_ERROR", "Minimum age must not exceed maximum age.", 422, [{ field: "minAge", issue: "Min > max" }]);
  }
  Object.assign(g, next);
  changed();
  return g;
}

export function archiveGroup(groupId: string, archive: boolean): AgeGroup {
  const db = getDb();
  const g = db.groups.find((x) => x.id === groupId);
  if (!g) throw new MockError("NOT_FOUND", "Age group not found.", 404);
  if (archive) {
    const active = db.players.filter(
      (p) => p.status === "active" && currentGroupOf(db, p.id)?.ageGroup.id === groupId
    ).length;
    if (active > 0) {
      throw new MockError(
        "AGE_GROUP_HAS_ACTIVE_PLAYERS",
        `${active} active ${active === 1 ? "player is" : "players are"} still in this group. Move them first.`,
        409,
        [{ field: "id", issue: "Group still has active players", meta: { active } }]
      );
    }
  }
  g.archivedAt = archive ? `${todayISO()}T03:00:00Z` : undefined;
  changed();
  return g;
}

export function addFee(
  ageGroupId: string,
  input: { amountMinor: number; effectiveFrom: string; allowPast?: boolean }
): GroupFee {
  const db = getDb();
  const g = db.groups.find((x) => x.id === ageGroupId);
  if (!g) throw new MockError("NOT_FOUND", "Age group not found.", 404);
  if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) {
    throw new MockError("VALIDATION_ERROR", "Enter an amount greater than zero.", 422, [{ field: "amountMinor", issue: "Must be greater than zero" }]);
  }
  if (input.effectiveFrom < todayISO() && !input.allowPast) {
    throw new MockError(
      "VALIDATION_ERROR",
      "This start date is in the past. Confirm that issued invoices are not changed.",
      422,
      [{ field: "effectiveFrom", issue: "Past date needs confirmation" }]
    );
  }
  const current = db.fees.find((f) => f.ageGroupId === ageGroupId && !f.effectiveTo);
  if (current && input.effectiveFrom <= current.effectiveFrom) {
    throw new MockError("FEE_OVERLAP", "A fee already applies from that date.", 409, [{ field: "effectiveFrom", issue: `Current fee starts ${current.effectiveFrom}` }]);
  }
  const fee: GroupFee = {
    id: nextId("f", db.fees.length + 10),
    ageGroupId,
    amountMinor: input.amountMinor,
    effectiveFrom: input.effectiveFrom,
  };
  if (current) current.effectiveTo = addDaysISO(input.effectiveFrom, -1);
  db.fees.push(fee);
  g.currentFeeMinor = input.amountMinor;
  changed();
  return fee;
}

export function createAssignment(input: {
  coachUserId: string;
  ageGroupId: string;
  assignedFrom: string;
}): CoachAssignment {
  const db = getDb();
  const coach = db.coaches.find((c) => c.user.id === input.coachUserId);
  if (!coach) throw new MockError("VALIDATION_ERROR", "Coach not found.", 422, [{ field: "coachUserId", issue: "Unknown coach" }]);
  const group = db.groups.find((g) => g.id === input.ageGroupId);
  if (!group) throw new MockError("VALIDATION_ERROR", "Age group not found.", 422, [{ field: "ageGroupId", issue: "Unknown group" }]);
  if (coach.groups.some((g) => g.id === group.id)) {
    throw new MockError("VALIDATION_ERROR", "This coach already covers the group.", 422, [{ field: "ageGroupId", issue: "Assignment overlaps" }]);
  }
  const assignment: CoachAssignment = {
    id: nextId("as", db.assignments.length + 10),
    coachUserId: coach.user.id,
    coachName: coach.user.fullName,
    ageGroup: { id: group.id, name: group.name },
    assignedFrom: input.assignedFrom,
  };
  db.assignments.push(assignment);
  coach.groups.push({ id: group.id, name: group.name });
  changed();
  return assignment;
}

export function endAssignment(assignmentId: string, assignedTo: string): CoachAssignment {
  const db = getDb();
  const a = db.assignments.find((x) => x.id === assignmentId);
  if (!a) throw new MockError("NOT_FOUND", "Assignment not found.", 404);
  a.assignedTo = assignedTo;
  const coach = db.coaches.find((c) => c.user.id === a.coachUserId);
  if (coach) coach.groups = coach.groups.filter((g) => g.id !== a.ageGroup.id);
  changed();
  return a;
}

export function createCoachUser(input: {
  username: string;
  fullName: string;
  phone?: string;
}): { user: User; inviteUrl: string; inviteExpiresAt: string } {
  const db = getDb();
  const username = input.username.trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,32}$/.test(username)) {
    throw new MockError("VALIDATION_ERROR", "Usernames are 3–32 characters: a–z, 0–9, dot, underscore, hyphen.", 422, [{ field: "username", issue: "Invalid format" }]);
  }
  if (db.coaches.some((c) => c.user.username === username)) {
    throw new MockError("VALIDATION_ERROR", "That username is taken.", 422, [{ field: "username", issue: "Already used" }]);
  }
  const user: User = {
    id: nextId("u", db.coaches.length + 10),
    username,
    fullName: input.fullName.trim(),
    phone: input.phone,
    role: "coach",
    status: "invited",
    totpEnabled: false,
  };
  db.coaches.push({ user, groups: [] });
  changed();
  const token = `invite-${Math.random().toString(36).slice(2, 10)}`;
  return { user, inviteUrl: `http://localhost:3100/accept-invite?token=${token}`, inviteExpiresAt: `${todayISO()}T12:00:00Z` };
}

// --- CSV import (IMP-01/02) — mock-only parser ------------------------------
// Columns follow docs/engineering/CSV_IMPORT.md §2 exactly (snake_case). The
// real server parses the file; this mock parses the same columns in the browser
// so the wizard is testable end to end.
const REQUIRED_COLUMNS = ["full_name", "guardian1_name", "guardian1_phone"] as const;
const IMPORT_LIMIT_ROWS = 1000;
const CONSENT_SOURCES = ["registration_form", "verbal", "owner_entry"];
const STATUSES = ["active", "inactive", "withdrawn"];

function splitCsvLine(line: string, delimiter: string): string[] {
  return line.split(delimiter).map((cell) => cell.trim());
}

function isDateStr(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export function validateImport(fileName: string, text: string): ImportValidation {
  const db = getDb();
  const today = todayISO();
  const errors: ImportIssue[] = [];
  const warnings: ImportIssue[] = [];
  const preview: ImportValidation["preview"] = [];
  const errorRows: number[] = [];
  const warningRows: number[] = [];
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return {
      batchId: "batch-0",
      rowCount: 0,
      errors: [{ row: 1, field: "file", message: "The file is empty" }],
      warnings,
      preview,
    };
  }

  // Delimiter auto-detection (CSV_IMPORT §1: comma or semicolon).
  const commas = (lines[0].match(/,/g) ?? []).length;
  const semicolons = (lines[0].match(/;/g) ?? []).length;
  const delimiter = semicolons > commas ? ";" : ",";
  const header = splitCsvLine(lines[0], delimiter).map((h) => h.toLowerCase());
  const missing = REQUIRED_COLUMNS.filter((column) => !header.includes(column));
  if (missing.length > 0) {
    return {
      batchId: "batch-0",
      rowCount: 0,
      errors: [
        {
          row: 1,
          field: "header",
          message: `Missing required column(s): ${missing.join(", ")}. Expected header (CSV_IMPORT §2): full_name,date_of_birth,registration_date,age_group,status,guardian1_name,guardian1_phone,guardian1_relationship,guardian2_name,guardian2_phone,whatsapp_consent,consent_source,notes`,
        },
      ],
      warnings,
      preview,
    };
  }

  const cell = (cells: string[], column: string): string => {
    const index = header.indexOf(column);
    return index === -1 ? "" : (cells[index] ?? "").trim();
  };

  const dataLines = lines.slice(1);
  if (dataLines.length > IMPORT_LIMIT_ROWS) {
    errors.push({
      row: IMPORT_LIMIT_ROWS + 2,
      field: "file",
      message: `The file has more than ${IMPORT_LIMIT_ROWS} rows`,
    });
  }

  dataLines.slice(0, IMPORT_LIMIT_ROWS).forEach((line, index) => {
    const row = index + 2;
    const cells = splitCsvLine(line, delimiter);
    const fullName = cell(cells, "full_name");
    const dateOfBirth = cell(cells, "date_of_birth");
    const registrationDate = cell(cells, "registration_date") || today;
    const ageGroupName = cell(cells, "age_group");
    const status = (cell(cells, "status") || "active").toLowerCase();
    const guardianName = cell(cells, "guardian1_name");
    const guardianPhone = cell(cells, "guardian1_phone");
    const guardianRelationship = cell(cells, "guardian1_relationship");
    const guardian2Name = cell(cells, "guardian2_name");
    const guardian2Phone = cell(cells, "guardian2_phone");
    const consent = (cell(cells, "whatsapp_consent") || "unknown").toLowerCase();
    const consentSource = cell(cells, "consent_source");
    const notes = cell(cells, "notes");

    const rowErrors: ImportIssue[] = [];
    if (fullName.length < 2 || fullName.length > 120) {
      rowErrors.push({ row, field: "full_name", message: "Name must be 2–120 characters" });
    }
    if (dateOfBirth && !isDateStr(dateOfBirth)) {
      rowErrors.push({ row, field: "date_of_birth", message: "Use YYYY-MM-DD" });
    }
    if (dateOfBirth && dateOfBirth > today) {
      rowErrors.push({ row, field: "date_of_birth", message: "The date of birth cannot be in the future" });
    }
    if (!isDateStr(registrationDate)) {
      rowErrors.push({ row, field: "registration_date", message: "Use YYYY-MM-DD" });
    }
    if (ageGroupName && !db.groups.some((g) => !g.archivedAt && g.name.toLowerCase() === ageGroupName.toLowerCase())) {
      rowErrors.push({ row, field: "age_group", message: `No active age group named "${ageGroupName}"` });
    }
    if (!STATUSES.includes(status)) {
      rowErrors.push({ row, field: "status", message: "Use active, inactive or withdrawn" });
    }
    if (guardianName.length < 2) {
      rowErrors.push({ row, field: "guardian1_name", message: "Guardian name is required" });
    }
    const normalizedPhone = normalizeLkPhone(guardianPhone);
    if (!normalizedPhone) {
      rowErrors.push({ row, field: "guardian1_phone", message: "Enter a valid Sri Lankan phone number" });
    }
    if ((guardian2Name && !guardian2Phone) || (!guardian2Name && guardian2Phone)) {
      rowErrors.push({ row, field: "guardian2_name", message: "Guardian 2 needs both a name and a phone" });
    }
    if (!["granted", "unknown"].includes(consent)) {
      rowErrors.push({ row, field: "whatsapp_consent", message: "Use granted or unknown" });
    }
    if (consent === "granted" && !CONSENT_SOURCES.includes(consentSource)) {
      rowErrors.push({
        row,
        field: "consent_source",
        message: "Granted consent needs a source: registration_form, verbal or owner_entry",
      });
    }
    if (notes.length > 1000) {
      rowErrors.push({ row, field: "notes", message: "Keep notes under 1000 characters" });
    }

    if (rowErrors.length > 0) {
      errors.push(...rowErrors);
      errorRows.push(row);
      return;
    }

    // Warnings never block a row — the commit decides (CSV_IMPORT §3 step 3).
    const duplicates = checkDuplicates({
      fullName,
      dateOfBirth: dateOfBirth || undefined,
      guardianPhones: normalizedPhone ? [normalizedPhone] : [],
    });
    if (duplicates.length > 0) {
      warnings.push({
        row,
        field: "full_name",
        message: `Possible duplicate of ${duplicates[0].player.fullName} (${duplicates[0].reason})`,
      });
    }
    if (dateOfBirth) {
      const age = ageOn(dateOfBirth, today);
      if (age < 3 || age > 25) {
        warnings.push({ row, field: "date_of_birth", message: `Age ${age} is outside the usual 3–25 range` });
      }
    }
    if (warnings.some((w) => w.row === row)) warningRows.push(row);

    preview.push({
      row,
      fullName,
      dateOfBirth: dateOfBirth || undefined,
      registrationDate,
      ageGroupName: ageGroupName || undefined,
      status: status as PlayerStatus,
      guardianName,
      guardianPhone: normalizedPhone ?? guardianPhone,
      guardianRelationship: guardianRelationship || undefined,
      whatsappConsent: consent as "granted" | "unknown",
      consentSource: consentSource || undefined,
      notes: notes || undefined,
    });
  });

  db.counters.import += 1;
  const batch: ImportBatch = {
    id: `batch-${db.counters.import}`,
    rows: preview,
    errorRows,
    warningRows,
    fileName,
  };
  db.importBatches.push(batch);
  changed();
  return {
    batchId: batch.id,
    rowCount: preview.length + errorRows.length,
    errors,
    warnings,
    preview,
  };
}

/** IMP-02. Rows with warnings commit only when the owner asked for them. */
export function commitImport(
  batchId: string,
  importRowsWithWarnings = false
): { created: number; skipped: number } {
  const db = getDb();
  const batch = db.importBatches.find((b) => b.id === batchId);
  if (!batch) throw new MockError("NOT_FOUND", "That import batch has expired. Upload the file again.", 404);
  let created = 0;
  let skipped = batch.errorRows.length;
  for (const row of batch.rows) {
    if (batch.warningRows.includes(row.row) && !importRowsWithWarnings) {
      skipped += 1;
      continue;
    }
    const group = db.groups.find(
      (g) => !g.archivedAt && g.name.toLowerCase() === row.ageGroupName?.toLowerCase()
    );
    const player = createPlayer({
      fullName: row.fullName,
      dateOfBirth: row.dateOfBirth,
      registrationDate: row.registrationDate ?? todayISO(),
      ageGroupId: group?.id,
      notes: row.notes,
      guardians: [
        {
          fullName: row.guardianName,
          phone: row.guardianPhone,
          relationship: row.guardianRelationship,
          whatsappConsent:
            row.whatsappConsent === "granted"
              ? { status: "granted", source: row.consentSource ?? "registration_form" }
              : undefined,
          isPrimary: true,
          receivesInvoices: true,
        },
      ],
      acknowledgeDuplicates: true,
    });
    // The file's status (default active) is applied through the same rule as the
    // status screen, so history and audit behave identically.
    if (row.status && row.status !== "active") {
      setPlayerStatus(player.id, {
        status: row.status,
        effectiveDate: row.registrationDate ?? todayISO(),
        reason: `Imported from ${batch.fileName}`,
      });
    }
    created += 1;
  }
  db.importBatches = db.importBatches.filter((b) => b.id !== batchId);
  changed();
  return { created, skipped };
}

// --- Step 4: sessions, player attendance, coach time -------------------------
// Rules come from ATTENDANCE §1–§5. The mock enforces the same ones the server
// will: the roster is derived from group history at the session date, a coach is
// scoped to their assigned groups (out of scope ⇒ undefined ⇒ 404), changing an
// existing attendance record needs a reason, and coach times are always stamped
// from the mock's own clock (a client-sent time is ignored).

/** academy_settings.attendance_coach_edit_window_hours */
const COACH_EDIT_WINDOW_HOURS = 24;
/** academy_settings.coach_checkin_opens_minutes_before */
const CHECKIN_OPENS_MINUTES_BEFORE = 60;
/** academy_settings.coach_checkin_closes_minutes_after_end */
const CHECKIN_CLOSES_MINUTES_AFTER_END = 120;

const inScope = (db: Db, viewer: { role: "owner" | "coach"; userId: string }, ageGroupId: string) =>
  viewer.role === "owner" || coachGroupIds(db, viewer.userId).includes(ageGroupId);

function findSession(db: Db, sessionId: string): SessionRec | undefined {
  return db.sessions.find((s) => s.id === sessionId);
}

/** SES-01. Default window is today..+14 d; the coach sees assigned groups only. */
export function listSessions(
  params: { from?: string; to?: string; ageGroupId?: string; status?: SessionStatus },
  viewer: { role: "owner" | "coach"; userId: string }
): { data: Session[]; meta: { page: number; pageSize: number; total: number; totalPages: number } } {
  const db = getDb();
  const from = params.from ?? todayISO();
  const to = params.to ?? addDaysISO(from, 14);
  let rows = db.sessions.filter((s) => s.sessionDate >= from && s.sessionDate <= to);
  if (viewer.role === "coach") {
    const scope = coachGroupIds(db, viewer.userId);
    rows = rows.filter((s) => scope.includes(s.ageGroupId));
  }
  if (params.ageGroupId) rows = rows.filter((s) => s.ageGroupId === params.ageGroupId);
  if (params.status) rows = rows.filter((s) => s.status === params.status);
  rows = rows.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  const data = rows.map((s) => withSummary(db, s));
  return {
    data,
    meta: { page: 1, pageSize: data.length || 25, total: data.length, totalPages: 1 },
  };
}

export function getSessionFor(
  sessionId: string,
  viewer: { role: "owner" | "coach"; userId: string }
): Session | undefined {
  const db = getDb();
  const s = findSession(db, sessionId);
  if (!s) return undefined;
  if (!inScope(db, viewer, s.ageGroupId)) return undefined;
  return withSummary(db, s);
}

/** ATT-01 / ATT-03: the session plus its roster at the session date. */
export function sessionAttendanceFor(
  sessionId: string,
  viewer: { role: "owner" | "coach"; userId: string }
): SessionAttendance | undefined {
  const db = getDb();
  const s = findSession(db, sessionId);
  if (!s || !inScope(db, viewer, s.ageGroupId)) return undefined;
  return attendancePayload(db, s, viewer);
}

function withSummary(db: Db, s: SessionRec): Session {
  const counts = countsFor(db, s);
  return { ...s, attendanceSummary: counts };
}

function countsFor(db: Db, s: SessionRec) {
  const roster = rosterAt(db, s.ageGroupId, s.sessionDate);
  const count = (status: AttendanceStatus) =>
    db.attendance.filter((a) => a.sessionId === s.id && a.status === status).length;
  const present = count("present");
  const absent = count("absent");
  const late = count("late");
  const excused = count("excused");
  return { present, absent, late, excused, unmarked: Math.max(0, roster.length - (present + absent + late + excused)) };
}

/** Players on the roster at that date: group history covers the date (ATTENDANCE §3). */
function rosterAt(db: Db, ageGroupId: string, date: string): Player[] {
  return db.players
    .filter((p) => {
      const covered = db.history.some(
        (h) =>
          h.playerId === p.id &&
          h.ageGroup.id === ageGroupId &&
          h.effectiveFrom <= date &&
          (!h.effectiveTo || h.effectiveTo >= date)
      );
      if (!covered) return false;
      // Withdrawn players disappear from rosters on/after their status date; an
      // inactive player is not on a roster either.
      if (p.status === "withdrawn") return p.statusEffectiveDate > date;
      return p.status === "active";
    })
    .sort((a, b) => a.fullName.localeCompare(b.fullName));
}

function rosterRows(db: Db, s: SessionRec): RosterRow[] {
  return rosterAt(db, s.ageGroupId, s.sessionDate).map((p) => {
    const rec = db.attendance.find((a) => a.sessionId === s.id && a.playerId === p.id);
    return {
      player: { id: p.id, fullName: p.fullName, registrationNo: p.registrationNo },
      record: rec
        ? {
            status: rec.status,
            note: rec.note,
            markedAt: rec.markedAt,
            markedBy: rec.markedBy,
            version: rec.version,
          }
        : undefined,
    };
  });
}

/** Coach edit window: 24 h after starts_at; the owner may edit at any time. */
function editableUntilOf(s: SessionRec): string {
  return addMinutes(s.startsAt, COACH_EDIT_WINDOW_HOURS * 60);
}

function canEditAs(s: SessionRec, viewer: { role: "owner" | "coach" }): boolean {
  if (s.status === "cancelled") return false;
  if (viewer.role === "owner") return true;
  return Date.now() < Date.parse(editableUntilOf(s));
}

function attendancePayload(
  db: Db,
  s: SessionRec,
  viewer: { role: "owner" | "coach"; userId: string }
): SessionAttendance {
  return {
    session: withSummary(db, s),
    roster: rosterRows(db, s),
    editableUntil: editableUntilOf(s),
    canEdit: canEditAs(s, viewer),
  };
}

function actorName(db: Db, viewer: { role: "owner" | "coach"; userId: string }): string {
  if (viewer.role === "owner") return "Demo Owner";
  return db.coaches.find((c) => c.user.id === viewer.userId)?.user.fullName ?? "Coach";
}

/** ATT-02. Bulk upsert, all-or-nothing, one transaction's worth of validation. */
export function saveAttendance(
  sessionId: string,
  records: AttendanceRecordInput[],
  viewer: { role: "owner" | "coach"; userId: string }
): { saved: number; roster: RosterRow[] } {
  const db = getDb();
  const s = findSession(db, sessionId);
  if (!s || !inScope(db, viewer, s.ageGroupId)) {
    throw new MockError("NOT_FOUND", "Session not found.", 404);
  }
  if (s.status === "cancelled") {
    throw new MockError("INVALID_STATE_TRANSITION", "This session was cancelled; attendance is read-only.", 409);
  }
  if (viewer.role === "coach" && !canEditAs(s, viewer)) {
    throw new MockError(
      "ATTENDANCE_WINDOW_CLOSED",
      "The editing window for this session has closed. Ask an owner to correct it.",
      422,
      [{ field: "records", issue: `Coach edits close at ${editableUntilOf(s)}` }]
    );
  }

  const rosterIds = new Set(rosterAt(db, s.ageGroupId, s.sessionDate).map((p) => p.id));
  const seen = new Set<string>();
  const errors: { field: string; issue: string; meta?: unknown }[] = [];

  for (const rec of records) {
    if (seen.has(rec.playerId)) {
      errors.push({ field: rec.playerId, issue: "The same player appears twice" });
    }
    seen.add(rec.playerId);
    if (!rosterIds.has(rec.playerId)) {
      throw new MockError("PLAYER_NOT_ON_ROSTER", "That player is not on this session's roster.", 422, [
        { field: rec.playerId, issue: "Not on the roster for this date" },
      ]);
    }
    if (!["present", "absent", "late", "excused"].includes(rec.status)) {
      errors.push({ field: rec.playerId, issue: "Unknown attendance status" });
    }
    const existing = db.attendance.find((a) => a.sessionId === s.id && a.playerId === rec.playerId);
    if (existing) {
      if (rec.version !== undefined && rec.version !== existing.version) {
        // The contract hands the current record back so the UI can say who won.
        throw new MockError("VERSION_CONFLICT", "This record was changed by someone else.", 409, [
          {
            field: rec.playerId,
            issue: `Marked ${existing.status} by ${existing.markedBy}`,
            meta: { current: existing },
          },
        ]);
      }
      if (existing.status !== rec.status && (!rec.reason || rec.reason.trim().length < 5)) {
        errors.push({
          field: rec.playerId,
          issue: "Give a reason for changing an attendance record (at least 5 characters)",
        });
      }
    }
  }

  if (errors.length > 0) {
    const reasonOnly = errors.every((e) => e.issue.startsWith("Give a reason"));
    throw new MockError(
      reasonOnly ? "REASON_REQUIRED" : "VALIDATION_ERROR",
      reasonOnly ? "A reason is required to change an existing record." : "Please correct the highlighted fields.",
      422,
      errors
    );
  }

  // Nothing is written until every record has passed (all-or-nothing).
  const stamp = new Date().toISOString();
  const by = actorName(db, viewer);
  let saved = 0;
  for (const rec of records) {
    const existing = db.attendance.find((a) => a.sessionId === s.id && a.playerId === rec.playerId);
    if (existing) {
      if (existing.status === rec.status && (existing.note ?? "") === (rec.note ?? "")) continue;
      existing.status = rec.status;
      existing.note = rec.note;
      existing.markedAt = stamp;
      existing.markedBy = by;
      existing.version += 1;
    } else {
      db.attendance.push({
        sessionId: s.id,
        playerId: rec.playerId,
        status: rec.status,
        note: rec.note,
        markedAt: stamp,
        markedBy: by,
        version: 1,
      });
    }
    saved += 1;
  }
  changed();
  return { saved, roster: rosterRows(db, s) };
}

/** ATT-03. Single correction; always needs a reason and the current version. */
export function patchAttendance(
  sessionId: string,
  playerId: string,
  input: { status?: AttendanceStatus; note?: string; reason: string; version: number },
  viewer: { role: "owner" | "coach"; userId: string }
): RosterRow {
  const db = getDb();
  const s = findSession(db, sessionId);
  if (!s || !inScope(db, viewer, s.ageGroupId)) {
    throw new MockError("NOT_FOUND", "Session not found.", 404);
  }
  if (viewer.role === "coach" && !canEditAs(s, viewer)) {
    throw new MockError("ATTENDANCE_WINDOW_CLOSED", "The editing window for this session has closed.", 422);
  }
  const existing = db.attendance.find((a) => a.sessionId === sessionId && a.playerId === playerId);
  if (!existing) throw new MockError("NOT_FOUND", "That player is not marked in this session.", 404);
  if (input.version !== existing.version) {
    throw new MockError("VERSION_CONFLICT", "This record was changed by someone else.", 409, [
      { field: playerId, issue: `Marked ${existing.status} by ${existing.markedBy}`, meta: { current: existing } },
    ]);
  }
  if (!input.reason || input.reason.trim().length < 5) {
    throw new MockError("REASON_REQUIRED", "A reason is required to change an existing record.", 422, [
      { field: "reason", issue: "At least 5 characters" },
    ]);
  }
  const statusChanged = input.status !== undefined && input.status !== existing.status;
  if (input.status) existing.status = input.status;
  if (input.note !== undefined) existing.note = input.note;
  if (statusChanged || input.note !== undefined) existing.version += 1;
  existing.markedAt = new Date().toISOString();
  existing.markedBy = actorName(db, viewer);
  changed();
  return rosterRows(db, s).find((r) => r.player.id === playerId)!;
}

// --- CAT-01..05: coach check-in / check-out ---------------------------------
function toCoachAttendance(db: Db, rec: CoachAttendanceRec): CoachAttendance {
  const s = findSession(db, rec.sessionId);
  return {
    id: rec.id,
    coach: { id: rec.coachUserId, fullName: rec.coachName },
    session: {
      id: rec.sessionId,
      ageGroupName: s?.ageGroup.name ?? "—",
      startsAt: s?.startsAt ?? "",
    },
    checkInAt: rec.checkInAt,
    checkOutAt: rec.checkOutAt,
    enteredBy: rec.enteredBy,
    corrected: rec.corrected,
    checkInNote: rec.checkInNote,
    version: rec.version,
  };
}

function checkinWindow(s: SessionRec): { opensAt: string; closesAt: string } {
  return {
    opensAt: addMinutes(s.startsAt, -CHECKIN_OPENS_MINUTES_BEFORE),
    closesAt: addMinutes(s.endsAt, CHECKIN_CLOSES_MINUTES_AFTER_END),
  };
}

/** CAT-01. Times come from the server clock; the client cannot send them. */
export function checkIn(
  sessionId: string,
  note: string | undefined,
  viewer: { role: "owner" | "coach"; userId: string }
): CoachAttendance {
  const db = getDb();
  const s = findSession(db, sessionId);
  if (!s || !inScope(db, viewer, s.ageGroupId)) {
    throw new MockError("NOT_FOUND", "Session not found.", 404);
  }
  const already = db.coachAttendance.find((c) => c.coachUserId === viewer.userId && c.sessionId === sessionId);
  if (already) {
    throw new MockError("ALREADY_CHECKED_IN", "You are already checked in for this session.", 409);
  }
  const open = db.coachAttendance.find((c) => c.coachUserId === viewer.userId && !c.checkOutAt);
  if (open) {
    throw new MockError(
      "ALREADY_CHECKED_IN",
      "You still have an open check-in. Check out of that session first.",
      409,
      [{ field: "sessionId", issue: "Open check-in", meta: { coachAttendanceId: open.id, sessionId: open.sessionId } }]
    );
  }
  const window = checkinWindow(s);
  const now = new Date().toISOString();
  if (now < window.opensAt || now > window.closesAt) {
    throw new MockError(
      "CHECKIN_WINDOW_CLOSED",
      "Check-in opens 60 minutes before the session and closes 2 hours after it ends.",
      422,
      [{ field: "sessionId", issue: `Window ${window.opensAt} – ${window.closesAt}` }]
    );
  }
  const rec: CoachAttendanceRec = {
    id: nextId("ca", db.coachAttendance.length + 10),
    coachUserId: viewer.userId,
    coachName: actorName(db, viewer),
    sessionId,
    checkInAt: now,
    checkInNote: note,
    enteredBy: "self",
    corrected: false,
    version: 1,
  };
  db.coachAttendance.push(rec);
  changed();
  return toCoachAttendance(db, rec);
}

/** CAT-02. Closes the caller's own open check-in for that session. */
export function checkOut(
  sessionId: string,
  viewer: { role: "owner" | "coach"; userId: string }
): CoachAttendance {
  const db = getDb();
  const rec = db.coachAttendance.find(
    (c) => c.coachUserId === viewer.userId && c.sessionId === sessionId && !c.checkOutAt
  );
  if (!rec) {
    throw new MockError("NO_OPEN_CHECK_IN", "You have no open check-in for this session.", 409);
  }
  const now = new Date().toISOString();
  if (now <= rec.checkInAt) {
    throw new MockError("VALIDATION_ERROR", "The check-out time must be after the check-in time.", 422);
  }
  rec.checkOutAt = now;
  rec.version += 1;
  changed();
  return toCoachAttendance(db, rec);
}

/** The caller's own open check-in, if any (drives the check-in bar state). */
export function openCheckInFor(userId: string, sessionId?: string): CoachAttendance | undefined {
  const db = getDb();
  const rec = db.coachAttendance.find(
    (c) => c.coachUserId === userId && !c.checkOutAt && (!sessionId || c.sessionId === sessionId)
  );
  return rec ? toCoachAttendance(db, rec) : undefined;
}

/** Closed spans in a range, for the "Σ hours (closed only)" line (ATTENDANCE §5). */
export function closedMinutesIn(db: Db, rows: CoachAttendance[]): number {
  return rows
    .filter((r) => r.checkOutAt)
    .reduce((sum, r) => sum + minutesBetween(r.checkInAt, r.checkOutAt!), 0);
}

/** CAT-03. A coach sees only their own rows; an owner sees everyone. */
export function listCoachAttendance(
  params: { from?: string; to?: string; coachUserId?: string },
  viewer: { role: "owner" | "coach"; userId: string }
): { data: CoachAttendance[]; meta: { page: number; pageSize: number; total: number; totalPages: number } } {
  const db = getDb();
  const from = params.from ?? addDaysISO(todayISO(), -14);
  const to = params.to ?? addDaysISO(todayISO(), 14);
  let rows = db.coachAttendance.map((c) => toCoachAttendance(db, c));
  if (viewer.role === "coach") {
    rows = rows.filter((r) => r.coach.id === viewer.userId);
  } else if (params.coachUserId) {
    rows = rows.filter((r) => r.coach.id === params.coachUserId);
  }
  const dateOf = (instant: string) => academyDateOf(instant);
  rows = rows.filter((r) => {
    const d = dateOf(r.checkInAt);
    return d >= from && d <= to;
  });
  rows.sort((a, b) => b.checkInAt.localeCompare(a.checkInAt));
  return {
    data: rows,
    meta: { page: 1, pageSize: rows.length || 25, total: rows.length, totalPages: 1 },
  };
}

/** CAT-04. Owner manual entry; audited, `enteredBy: owner`. */
export function createCoachAttendanceEntry(input: {
  coachUserId: string;
  sessionId: string;
  checkInAt: string;
  checkOutAt?: string;
  reason: string;
}): CoachAttendance {
  const db = getDb();
  const coach = db.coaches.find((c) => c.user.id === input.coachUserId);
  if (!coach) {
    throw new MockError("VALIDATION_ERROR", "Coach not found.", 422, [{ field: "coachUserId", issue: "Unknown coach" }]);
  }
  const s = findSession(db, input.sessionId);
  if (!s) {
    throw new MockError("VALIDATION_ERROR", "Session not found.", 422, [{ field: "sessionId", issue: "Unknown session" }]);
  }
  const errors: { field: string; issue: string }[] = [];
  if (!input.checkInAt || Number.isNaN(Date.parse(input.checkInAt))) {
    errors.push({ field: "checkInAt", issue: "Enter a check-in time" });
  }
  if (input.checkOutAt) {
    if (Number.isNaN(Date.parse(input.checkOutAt))) {
      errors.push({ field: "checkOutAt", issue: "Enter a valid check-out time" });
    } else if (Date.parse(input.checkOutAt) <= Date.parse(input.checkInAt)) {
      errors.push({ field: "checkOutAt", issue: "Check-out must be after check-in" });
    }
  }
  if (!input.reason || input.reason.trim().length < 5) {
    errors.push({ field: "reason", issue: "Give a reason (at least 5 characters)" });
  }
  if (errors.length) throw new MockError("VALIDATION_ERROR", "Please correct the highlighted fields.", 422, errors);
  if (db.coachAttendance.some((c) => c.coachUserId === input.coachUserId && c.sessionId === input.sessionId)) {
    throw new MockError("ALREADY_CHECKED_IN", "This coach already has a record for that session.", 409);
  }
  const rec: CoachAttendanceRec = {
    id: nextId("ca", db.coachAttendance.length + 10),
    coachUserId: input.coachUserId,
    coachName: coach.user.fullName,
    sessionId: input.sessionId,
    checkInAt: input.checkInAt,
    checkOutAt: input.checkOutAt,
    enteredBy: "owner",
    corrected: false,
    version: 1,
  };
  db.coachAttendance.push(rec);
  changed();
  return toCoachAttendance(db, rec);
}

/** CAT-05. Owner correction; requires a reason and sets `corrected`. */
export function patchCoachAttendance(
  id: string,
  input: { checkInAt?: string; checkOutAt?: string | null; reason: string; version: number }
): CoachAttendance {
  const db = getDb();
  const rec = db.coachAttendance.find((c) => c.id === id);
  if (!rec) throw new MockError("NOT_FOUND", "Check-in not found.", 404);
  if (input.version !== undefined && input.version !== rec.version) {
    throw new MockError("VERSION_CONFLICT", "This record was changed by someone else.", 409);
  }
  if (!input.reason || input.reason.trim().length < 5) {
    throw new MockError("REASON_REQUIRED", "A reason is required for a correction.", 422, [
      { field: "reason", issue: "At least 5 characters" },
    ]);
  }
  const nextIn = input.checkInAt ?? rec.checkInAt;
  const nextOut = input.checkOutAt === null ? undefined : (input.checkOutAt ?? rec.checkOutAt);
  if (Number.isNaN(Date.parse(nextIn))) {
    throw new MockError("VALIDATION_ERROR", "Enter a valid check-in time.", 422, [
      { field: "checkInAt", issue: "Invalid instant" },
    ]);
  }
  if (nextOut && Date.parse(nextOut) <= Date.parse(nextIn)) {
    throw new MockError("VALIDATION_ERROR", "Check-out must be after check-in.", 422, [
      { field: "checkOutAt", issue: "Must be after check-in" },
    ]);
  }
  if (db.coachAttendance.some((c) => c.id !== id && c.coachUserId === rec.coachUserId && !nextOut)) {
    throw new MockError("ALREADY_CHECKED_IN", "That coach already has an open check-in.", 409);
  }
  rec.checkInAt = nextIn;
  rec.checkOutAt = nextOut;
  rec.corrected = true;
  rec.version += 1;
  changed();
  return toCoachAttendance(db, rec);
}

export function totalClosedMinutes(rows: CoachAttendance[]): number {
  return closedMinutesIn(getDb(), rows);
}

/** SES-02. Owner-created ad-hoc session; UQ (age_group_id, starts_at). */
export function createSession(input: {
  ageGroupId: string;
  startsAt: string;
  endsAt: string;
  venue?: string;
  leadCoachUserId?: string;
}): Session {
  const db = getDb();
  const group = db.groups.find((g) => g.id === input.ageGroupId && !g.archivedAt);
  if (!group) {
    throw new MockError("VALIDATION_ERROR", "Choose an active age group.", 422, [
      { field: "ageGroupId", issue: "Unknown or archived group" },
    ]);
  }
  const errors: { field: string; issue: string }[] = [];
  const starts = Date.parse(input.startsAt);
  const ends = Date.parse(input.endsAt);
  if (Number.isNaN(starts)) errors.push({ field: "startsAt", issue: "Enter a start time" });
  if (Number.isNaN(ends)) errors.push({ field: "endsAt", issue: "Enter an end time" });
  if (!Number.isNaN(starts) && !Number.isNaN(ends) && ends <= starts) {
    errors.push({ field: "endsAt", issue: "The end time must be after the start time" });
  }
  if (errors.length) throw new MockError("VALIDATION_ERROR", "Please correct the highlighted fields.", 422, errors);
  if (
    db.sessions.some(
      (s) => s.ageGroupId === input.ageGroupId && s.startsAt === input.startsAt && s.status !== "cancelled"
    )
  ) {
    throw new MockError("SESSION_DUPLICATE", "This group already has a session at that time.", 409);
  }
  const leadCoach = input.leadCoachUserId
    ? db.coaches.find((c) => c.user.id === input.leadCoachUserId)?.user
    : undefined;
  const rec: SessionRec = {
    id: nextId("s", db.sessions.length + 10),
    ageGroupId: group.id,
    ageGroup: { id: group.id, name: group.name },
    sessionDate: academyDateOf(input.startsAt),
    startsAt: input.startsAt,
    endsAt: input.endsAt,
    venue: input.venue,
    status: "scheduled",
    leadCoach: leadCoach ? { id: leadCoach.id, fullName: leadCoach.fullName } : undefined,
    version: 1,
  };
  db.sessions.push(rec);
  changed();
  return withSummary(db, rec);
}

/** SES-04. Cancel with a reason; cancelled sessions are read-only history. */
export function cancelSession(sessionId: string, reason: string): Session {
  const db = getDb();
  const s = findSession(db, sessionId);
  if (!s) throw new MockError("NOT_FOUND", "Session not found.", 404);
  if (!reason || reason.trim().length < 5) {
    throw new MockError("VALIDATION_ERROR", "Give a reason (at least 5 characters).", 422, [
      { field: "reason", issue: "At least 5 characters" },
    ]);
  }
  if (s.status === "cancelled") {
    throw new MockError("INVALID_STATE_TRANSITION", "This session is already cancelled.", 409);
  }
  s.status = "cancelled";
  s.cancelReason = reason;
  s.version += 1;
  changed();
  return withSummary(db, s);
}
