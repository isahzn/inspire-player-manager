// Hand-written from docs/architecture/API_CONTRACTS.md §2 (AUTH/USR + PLY/GRP/
// FEE/CCH/GDN/IMP rows). Deleted and replaced by generated
// openapi-typescript output at M1 exit. Field names are the contract's own —
// nothing here is invented (API_INTEGRATION §11).
export type Role = "owner" | "coach";
export type DateStr = string; // "YYYY-MM-DD", academy-local
export type Instant = string; // ISO-8601 UTC
export type Minor = number; // integer minor units (LKR)

export interface Page<T> {
  data: T[];
  meta: { page: number; pageSize: number; total: number; totalPages: number };
}

export interface User {
  id: string;
  username: string;
  fullName: string;
  phone?: string;
  role: Role;
  status: "invited" | "active" | "disabled";
  totpEnabled: boolean;
  lastLoginAt?: string;
}

export interface Me {
  user: User;
  csrfToken: string;
  academy: { name: string; timezone: string; logoUrl?: string };
  permissions: string[];
  assignedGroupIds?: string[];
}

export interface AuthSession {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  ip?: string;
  userAgent?: string;
  current: boolean;
}

export interface ApiErrorDetail {
  field?: string;
  issue?: string;
  meta?: Record<string, unknown>;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: ApiErrorDetail[];
    requestId?: string;
  };
}

// --- Age groups, fees (GRP-01..05, FEE-01/02) -------------------------------
export interface AgeGroup {
  id: string;
  name: string;
  minAge?: number;
  maxAge?: number;
  sortOrder: number;
  archivedAt?: Instant;
  /** owner only — absent in a coach's GRP-01 response */
  currentFeeMinor?: Minor;
  activePlayerCount?: number;
}

export interface GroupFee {
  id: string;
  ageGroupId: string;
  amountMinor: Minor;
  effectiveFrom: DateStr;
  effectiveTo?: DateStr;
}

export interface AgeGroupSuggestion {
  referenceDate: DateStr;
  ageOnReference: number;
  suggestions: { ageGroupId: string; name: string }[];
}

// --- Guardians (GDN-01..06) -------------------------------------------------
export type ConsentStatus = "unknown" | "granted" | "revoked";

export interface Guardian {
  id: string;
  fullName: string;
  phone: string; // E.164
  relationship?: string;
  whatsappConsent: ConsentStatus;
  consentRecordedAt?: Instant;
  consentSource?: string;
  optedOutAt?: Instant;
}

export interface PlayerGuardianLink {
  guardian: Guardian;
  isPrimary: boolean;
  receivesInvoices: boolean;
}

export interface GuardianWithPlayers extends Guardian {
  players: { id: string; fullName: string }[];
}

export interface GuardianBalance {
  outstandingMinor: Minor;
  overdueMinor: Minor;
  creditMinor: Minor;
  openInvoices?: Invoice[];
}

// --- Players (PLY-01..11) ---------------------------------------------------
export type PlayerStatus = "active" | "inactive" | "withdrawn";

export interface Player {
  id: string;
  registrationNo: string;
  fullName: string;
  dateOfBirth?: DateStr;
  ageOnReference?: number;
  registrationDate: DateStr;
  status: PlayerStatus;
  statusEffectiveDate: DateStr;
  statusReason?: string;
  currentGroup?: { id: string; name: string; since: DateStr };
  guardians: PlayerGuardianLink[];
  notes?: string;
  coachNotes?: string;
  billingAnchorDate: DateStr;
  outstandingMinor?: Minor;
  version: number;
}

/** What a coach's PLY-01/PLY-03 returns: no DOB, guardians, notes or balances. */
export interface PlayerCoachView {
  id: string;
  registrationNo: string;
  fullName: string;
  age?: number;
  status: PlayerStatus;
  group?: { id: string; name: string };
  coachNotes?: string;
  primaryGuardian?: { fullName: string; phone: string };
}

export type PlayerListItem = Player | PlayerCoachView;

/** True for the owner projection (has guardians), false for PlayerCoachView. */
export function isOwnerPlayer(p: PlayerListItem): p is Player {
  return "guardians" in p;
}

export interface GroupHistoryEntry {
  id: string;
  ageGroup: { id: string; name: string };
  effectiveFrom: DateStr;
  effectiveTo?: DateStr;
  reason?: string;
  changedBy: { id: string; fullName: string };
}

export interface DuplicateMatch {
  player: PlayerListItem;
  reason: string;
  score: number;
}

export interface PlayerCreate {
  fullName: string;
  dateOfBirth?: DateStr;
  registrationDate: DateStr;
  ageGroupId?: string;
  notes?: string;
  coachNotes?: string;
  guardians: (PlayerGuardianLinkInput & {
    isPrimary: boolean;
    receivesInvoices: boolean;
  })[];
  acknowledgeDuplicates?: boolean;
}

export type PlayerGuardianLinkInput =
  | { guardianId: string }
  | {
      fullName: string;
      phone: string;
      relationship?: string;
      whatsappConsent?: { status: "granted" | "unknown"; source: string };
    };

export interface PlayerBalance {
  outstandingMinor: Minor;
  overdueMinor: Minor;
  creditMinor: Minor;
}

export interface PlayerAttendance {
  summary: { present: number; absent: number; late: number; excused: number; unmarked?: number };
  data: {
    sessionId: string;
    sessionDate: DateStr;
    status: "present" | "absent" | "late" | "excused";
    note?: string;
  }[];
}

// --- Invoices (PLY-09 reads these; billing screens own the rest in Step 5) ---
export interface Invoice {
  id: string;
  invoiceNumber: string;
  kind: "periodic" | "manual";
  status: "issued" | "partially_paid" | "paid" | "void";
  isOverdue: boolean;
  daysOverdue: number;
  player: { id: string; fullName: string; registrationNo: string };
  guardian?: { id: string; fullName: string };
  ageGroup: { id: string; name: string };
  periodStart?: DateStr;
  periodEnd?: DateStr;
  issueDate: DateStr;
  dueDate: DateStr;
  currency: "LKR";
  subtotalMinor: Minor;
  adjustmentsMinor: Minor;
  totalMinor: Minor;
  paidMinor: Minor;
  balanceMinor: Minor;
  /** INV-02 only — absent in the INV-01 list response (API_CONTRACTS §3.6). */
  items?: InvoiceItem[];
  /** INV-02 only. Reversed allocations stay visible, flagged (BILLING_ENGINE §11). */
  allocations?: Allocation[];
  hasPdf: boolean;
  voidedAt?: Instant;
  voidReason?: string;
  version: number;
}

// --- Coaches and assignments (CCH-01..05) ----------------------------------
export interface CoachRow {
  user: User;
  groups: { id: string; name: string }[];
}

export interface CoachAssignment {
  id: string;
  coachUserId: string;
  coachName: string;
  ageGroup: { id: string; name: string };
  assignedFrom: DateStr;
  assignedTo?: DateStr;
}

export interface CreateUserResponse {
  user: User;
  inviteUrl: string;
  inviteExpiresAt: Instant;
}

// --- CSV import (IMP-01/02) -------------------------------------------------
export interface ImportIssue {
  row: number;
  field?: string;
  message: string;
}

/** One row of IMP-01's `preview[]`. The contract calls the array "preview"
 *  without fixing its fields, so the shape is declared here and must be
 *  confirmed by the backend (Step 3 handoff §4). Columns follow
 *  CSV_IMPORT.md §2. */
export interface ImportPreviewRow {
  row: number;
  fullName: string;
  dateOfBirth?: DateStr;
  registrationDate?: DateStr;
  ageGroupName?: string;
  status?: PlayerStatus;
  guardianName: string;
  guardianPhone: string;
  guardianRelationship?: string;
  whatsappConsent?: "granted" | "unknown";
  consentSource?: string;
  notes?: string;
}

export interface ImportValidation {
  batchId: string;
  rowCount: number;
  errors: ImportIssue[];
  warnings: ImportIssue[];
  preview: ImportPreviewRow[];
}

export interface ImportCommitResult {
  created: number;
  skipped: number;
}

// --- Sessions, attendance, coach attendance (SES/ATT/CAT) -------------------
// API_CONTRACTS §2 (`Session`, `AttendanceStatus`, `RosterRow`,
// `CoachAttendance`) and §3.5 (SES-01..04, ATT-01..03, CAT-01..05).
export type SessionStatus = "scheduled" | "completed" | "cancelled";

export interface Session {
  id: string;
  ageGroup: { id: string; name: string };
  sessionDate: DateStr;
  startsAt: Instant;
  endsAt: Instant;
  venue?: string;
  status: SessionStatus;
  cancelReason?: string;
  leadCoach?: { id: string; fullName: string };
  attendanceSummary?: {
    present: number;
    absent: number;
    late: number;
    excused: number;
    unmarked: number;
  };
  version: number;
}

/**
 * SCH-01 `TrainingSchedule` — a recurring rule, never the sessions themselves.
 * `weekday` is ISO (1 = Monday … 7 = Sunday); `startTime`/`endTime` are academy-local
 * `HH:mm` wall-clock strings. Creating or editing a rule rewrites no existing session;
 * only SCH-02 generates (API_CONTRACTS §3.5).
 */
export interface TrainingSchedule {
  id: string;
  ageGroup: { id: string; name: string };
  weekday: number;
  startTime: string;
  endTime: string;
  venue?: string;
  validFrom: DateStr;
  validTo?: DateStr;
  isActive: boolean;
}

/** SCH-02 response — created vs already-existing sessions in the requested range. */
export interface ScheduleGenerateResult {
  created: number;
  skipped: number;
}

export type AttendanceStatus = "present" | "absent" | "late" | "excused";

/** One roster line. `record` is absent while the player is unmarked. */
export interface RosterRow {
  player: { id: string; fullName: string; registrationNo: string };
  record?: {
    status: AttendanceStatus;
    note?: string;
    markedAt: Instant;
    markedBy: string;
    version: number;
  };
}

/** ATT-01 response. `editableUntil` is the coach's window; owner edits ignore it. */
export interface SessionAttendance {
  session: Session;
  roster: RosterRow[];
  editableUntil: Instant;
  canEdit: boolean;
}

/** ATT-02 request line. `reason` is required when changing an existing record. */
export interface AttendanceRecordInput {
  playerId: string;
  status: AttendanceStatus;
  note?: string;
  version?: number;
  reason?: string;
}

export interface CoachAttendance {
  id: string;
  coach: { id: string; fullName: string };
  session: { id: string; ageGroupName: string; startsAt: Instant };
  checkInAt: Instant;
  checkOutAt?: Instant;
  enteredBy: "self" | "owner";
  corrected: boolean;
  checkInNote?: string;
  version: number;
}

// --- Billing, invoices, payments, proofs (API_CONTRACTS §2/§3.6) -------------
// Hand-written from the contract. Payment state, allocation rules and the
// "proof is evidence, not payment" boundary come from BILLING_ENGINE §10–§12,
// ADR-013/ADR-020/ADR-021 and PAYMENT_VERIFICATION §1/§5 — never soften these
// shapes: a passing check may never look like a confirmation.

export interface InvoiceItem {
  id: string;
  lineNo: number;
  itemType: "fee" | "adjustment";
  description: string;
  quantity: number;
  unitAmountMinor: Minor;
  amountMinor: Minor;
  reason?: string;
}

export interface PaymentMethod {
  code: string;
  label: string;
  requiresReference: boolean;
  isActive: boolean;
}

export interface Allocation {
  id: string;
  paymentId: string;
  invoice: { id: string; invoiceNumber: string };
  amountMinor: Minor;
  allocatedAt: Instant;
  reversedAt?: Instant;
}

export type ProofDocKind = "bank_receipt_pdf" | "bank_receipt_image" | "other";

export type ProofFindingResult = "pass" | "warn" | "fail" | "unknown";

/** One advisory finding (PAYMENT_VERIFICATION §5). Codes are stable strings. */
export interface ProofFinding {
  code: string;
  level: 1 | 2 | 3;
  result: ProofFindingResult;
  detail: string;
  meta?: Record<string, unknown>;
}

/** What the parser read out of a bank PDF receipt. Absent field ⇒ not extracted. */
export interface ProofExtract {
  bankName?: string;
  documentType?: string;
  reference?: string;
  transactionAt?: Instant;
  amountMinor?: Minor;
  currency?: string;
  payerName?: string;
  payerAccountMasked?: string;
  beneficiaryName?: string;
  beneficiaryAccountMasked?: string;
  channel?: string;
  status?: string;
  remarks?: string;
}

export type ProofVerificationStatus = "not_run" | "checked" | "unverifiable" | "failed";

/** Result of `PRF-04`. Advisory only — it can never move money (ADR-021). */
export interface ProofVerification {
  docKind: ProofDocKind;
  status: ProofVerificationStatus;
  findings: ProofFinding[];
  extracted?: ProofExtract;
  parserVersion?: string;
  checkedAt?: Instant;
}

export interface ProofMeta {
  fileId: string;
  originalName?: string;
  mimeType: string;
  sizeBytes: number;
  uploadedAt: Instant;
  uploadedBy: { id: string; fullName: string };
  docKind: ProofDocKind;
  verification?: ProofVerification;
}

export type PaymentStatus = "pending" | "confirmed" | "rejected" | "reversed";

export interface Payment {
  id: string;
  amountMinor: Minor;
  currency: "LKR";
  method: PaymentMethod;
  reference?: string;
  receivedAt: Instant;
  payer?: { guardianId?: string; name: string };
  status: PaymentStatus;
  allocatedMinor: Minor;
  unallocatedMinor: Minor;
  allocations?: Allocation[];
  proofs?: ProofMeta[];
  receipt?: { id: string; receiptNumber: string };
  notes?: string;
  rejectReason?: string;
  reverseReason?: string;
  /** Rollup of the proof findings — never a confirmation (MOCK_DATA note). */
  proofVerification?: {
    status: "none" | "passed" | "warned" | "failed" | "unverifiable";
    checkedAt?: Instant;
  };
  version: number;
}

export interface ReceiptSummary {
  id: string;
  receiptNumber: string;
  paymentId: string;
  issuedAt: Instant;
  voided: boolean;
}

export interface BillingPreviewLine {
  playerId: string;
  playerName: string;
  registrationNo: string;
  ageGroup: { id: string; name: string };
  periodStart: DateStr;
  periodEnd: DateStr;
  issueDate: DateStr;
  dueDate: DateStr;
  feeMinor: Minor;
  feeId: string;
  guardian?: { id: string; fullName: string };
  warnings: string[];
}

export type BillingSkipReason =
  | "NO_GROUP"
  | "NO_FEE"
  | "NOT_ACTIVE"
  | "ALREADY_INVOICED"
  | "NOT_YET_REGISTERED";

export interface BillingPreviewSkipped {
  playerId: string;
  playerName: string;
  reason: BillingSkipReason;
}

export interface BillingPreview {
  previewHash: string;
  targetDate: DateStr;
  frequency: "weekly" | "monthly";
  mode: "calendar" | "anchored";
  lines: BillingPreviewLine[];
  skipped: BillingPreviewSkipped[];
  totals: { count: number; totalMinor: Minor };
}

export interface BillingRun {
  id: string;
  runKey: string;
  status: "issued" | "partial" | "failed";
  targetDate: DateStr;
  invoicesCreated: number;
  invoicesSkipped: number;
  invoiceIds: string[];
  startedAt: Instant;
  completedAt?: Instant;
}

export interface BillingAdjustment {
  playerId: string;
  amountMinor: Minor; // negative only, after issue (BILLING_ENGINE §10)
  reason: string;
}

/** SET-02 read — the wizard shows these read-only (PAGE_SPECIFICATIONS §7). */
export interface BillingSettings {
  billingFrequency: "weekly" | "monthly";
  billingPeriodMode: "calendar" | "anchored";
  weekStartDay: number;
  invoiceIssueTiming: "period_start" | "period_end";
  dueRuleType: "days_after_issue" | "days_after_period_start" | "fixed_day_of_month";
  dueRuleValue: number;
  allowFractionalMoney: boolean;
  effectNote: string;
}

/** SET-01 subset the billing screens must be honest about. */
export interface AcademyPaymentSettings {
  /** SET-01's own field name — the API returns `name`, not `academyName` (2026-10-15 audit §A2). */
  name: string;
  paymentInstructions: string;
  /** Academy accounts a bank receipt's beneficiary must match (PAYMENT_VERIFICATION §3). */
  beneficiaryAccounts: { name: string; accountMasked: string }[];
}

/**
 * Message job (API_CONTRACTS §2). Added here because `INV-08` returns jobs;
 * the WhatsApp screens (Step 6) own the rest of the surface. `deliveryState`
 * never infers "Delivered" from `sent` alone (OPENWA_INTEGRATION §9).
 */
export interface MessageJob {
  id: string;
  /**
   * `test` is NOT in API_CONTRACTS §2 (which lists three kinds) although MSG-08
   * is typed `→ MessageJob`, so a test send has no representable kind there.
   * Raised as a contract gap in the Step 6 handoff rather than improvised
   * silently — see docs/engineering/handoffs/2026-10-12-frontend-step6-whatsapp.md.
   */
  kind: "invoice_delivery" | "reminder_pre_due" | "reminder_overdue" | "test";
  status:
    | "queued"
    | "sending"
    | "sent"
    | "failed"
    | "dead"
    | "needs_review"
    | "cancelled"
    | "skipped";
  skipReason?: string;
  deliveryState:
    | "unknown"
    | "server_accepted"
    | "device_delivered"
    | "read"
    | "provider_error";
  invoice: { id: string; invoiceNumber: string };
  player: { id: string; fullName: string };
  guardian: { id: string; fullName: string; phoneMasked: string };
  scheduledFor: Instant;
  nextAttemptAt?: Instant;
  attempts: number;
  maxAttempts: number;
  sentAt?: Instant;
  lastError?: { code: string; message: string };
  manualFallback?: { at: Instant; by: string; note?: string };
  renderedBody?: string;
  events?: { eventType: string; at: Instant; providerAck?: number }[];
}

// ===========================================================================
// Step 6 — WhatsApp (MSG-01..08, SET-05..08)
// ===========================================================================

/**
 * OUR normalized session label set (API_CONTRACTS §2). OpenWA's own lifecycle
 * strings are unconfirmed (spike S1, OPEN-018), so unknown maps to `unknown` and
 * nothing here may be presented as the provider's own text.
 */
export type SessionStatusLabel =
  | "connected"
  | "awaiting_qr"
  | "starting"
  | "stopped"
  | "failed"
  | "unknown";

/** SET-08. Per-automation switches under the `MSG-07` master pause (CR-003). */
export interface Automations {
  invoiceDelivery: boolean;
  reminderPreDue: boolean;
  reminderOverdue: boolean;
  proofCheck: boolean;
}

export type AutomationKey = keyof Automations;

/** SET-08 response: the four switches + the read-only master mirror. */
export type AutomationsResponse = Automations & { masterPaused: boolean };

export interface MessageQueueCounts {
  queued: number;
  sending: number;
  failedLast24h: number;
  dead: number;
  needsReview: number;
}

/** MSG-06. */
export interface MessagingStatus {
  automationEnabled: boolean;
  automations: Automations;
  provider: "openwa";
  session: { status: SessionStatusLabel; checkedAt: Instant };
  queue: MessageQueueCounts;
  lastSentAt?: Instant;
}

/** SET-05. `UQ (kind, offsetDays)` in the contract. */
export interface ReminderRule {
  id: string;
  kind: "reminder_pre_due" | "reminder_overdue";
  offsetDays: number;
  isActive: boolean;
}

/** SET-06. `preview` is rendered server-side with sample data. */
export interface MessageTemplate {
  key: string;
  label: string;
  body: string;
  variables: string[];
  preview?: string;
}

/** SET-07. The `attachment_and_link` mode stays rejected until spike S1 passes. */
export interface MessagingSettings {
  sendWindowStart: string; // "HH:mm"
  sendWindowEnd: string; // "HH:mm"
  invoiceMode: "link" | "attachment_and_link";
  pacingMinSeconds: number;
  pacingMaxSeconds: number;
  maxPerHour: number;
  optOutKeywords: string[];
  /** The consent text the forms are supposed to ship with (PAGE_SPEC §9). */
  consentPolicyText: string;
}

// ===========================================================================
// Step 7 — Dashboard (DSH-01/02) and reports (RPT-01/02)
// ===========================================================================

export interface OwnerDashboard {
  range: { from: DateStr; to: DateStr };
  players: {
    active: number;
    inactive: number;
    withdrawn: number;
    byGroup: { ageGroupId: string; name: string; count: number }[];
  };
  coachTime: {
    checkedInNow: {
      coach: { id: string; fullName: string };
      session: { id: string; ageGroupName: string; startsAt: Instant };
      checkInAt: Instant;
      elapsedMinutes: number;
    }[];
    todayMinutes: number;
    weekMinutes: number;
    openNeedingCorrection: number;
  };
  sessions: {
    today: Session[];
    next7Days: Session[];
    todayAttendance: { present: number; absent: number; late: number; excused: number; unmarked: number };
  };
  money: {
    invoicedMinor: Minor;
    invoicesIssuedCount: number;
    /** Confirmed payments received inside the range — never added to invoiced. */
    collectedMinor: Minor;
    outstandingMinor: Minor;
    overdueMinor: Minor;
    overdueCount: number;
    dueSoon: { days: number; count: number; totalMinor: Minor };
    creditHeldMinor: Minor;
  };
  messaging: {
    automationEnabled: boolean;
    automations: Automations;
    sessionStatus: SessionStatusLabel;
    failed24h: number;
    dead: number;
    needsReview: number;
  };
  alerts: { code: string; severity: "info" | "warning" | "critical"; message: string; link?: string }[];
}

/**
 * DSH-02. The contract lists only the three collections; PAGE_SPEC §2 also
 * requires the coach's own hours this week, so `myWeekMinutes` is added and
 * recorded as a contract request in the Step 7 handoff.
 */
export interface CoachDashboard {
  todaySessions: Session[];
  upcoming: Session[];
  myOpenCheckIn?: CoachAttendance;
  myWeekMinutes: number;
}

export type ReportName =
  | "players"
  | "attendance-summary"
  | "attendance-detail"
  | "invoices"
  | "payments"
  | "outstanding"
  | "collections"
  | "coach-attendance";

/** One CSV cell. Never an object — RPT-02 streams flat rows. */
export type ReportCell = string | number | boolean | null;
export type ReportRow = Record<string, ReportCell>;

export interface ReportColumn {
  key: string;
  label: string;
  type: "text" | "date" | "instant" | "money" | "number" | "percent";
}

/** RPT-01: `Page<Row>` + `totals`, plus the column metadata the table needs. */
export interface ReportResult {
  data: ReportRow[];
  meta: { page: number; pageSize: number; total: number; totalPages: number };
  totals?: Record<string, number>;
  columns: ReportColumn[];
  generatedAt: Instant;
  /** Echoed back so the CSV filename and the UI agree (PAGE_SPEC §10). */
  filters: Record<string, string | undefined>;
}

// ===========================================================================
// Step 8 — Admin (USR-01..05, SET-01..04, AUD-01, SYS-03)
// ===========================================================================

/** SET-01 full response (the money screens read a subset of these). */
export interface AcademySettings {
  /**
   * SET-01's field names, taken from the contract rather than from the mock:
   * `openapi.yaml` `AcademySettings` requires `name` and the enum
   * `jan_1_of_year | fixed_month_day | today`. The earlier `academyName` /
   * `jan_1` / `fixed_date` spelling made `/settings` throw on load — the
   * 2026-10-15 UI audit, defect A2.
   */
  name: string;
  address?: string;
  phone?: string;
  email?: string;
  paymentInstructions: string;
  timezone: string;
  ageReferenceRule: "jan_1_of_year" | "fixed_month_day" | "today";
  /** "MM-DD", required when `ageReferenceRule` is `fixed_month_day`. */
  ageReferenceMonthDay?: string;
  coachCanSeeGuardianPhone: boolean;
  attendanceCoachEditWindowHours: number;
  coachCheckinOpensMinutesBefore: number;
  coachCheckinClosesMinutesAfterEnd: number;
  invoiceLinkTtlDays: number;
  /** Read back from the academy row so the money screens stay honest. */
  beneficiaryAccounts: { name: string; accountMasked: string }[];
}

/** AUD-01. `before`/`after` stay `unknown` — a diff, not a typed shape. */
export interface AuditEntry {
  id: number;
  occurredAt: Instant;
  actor?: { id: string; fullName: string; role: Role };
  action: string;
  entityType: string;
  entityId: string;
  reason?: string;
  before?: unknown;
  after?: unknown;
  requestId: string;
}

export type HealthState = "ok" | "degraded" | "down" | "unknown";

export interface SystemHealth {
  db: { status: HealthState; detail?: string };
  storage: { status: HealthState; detail?: string };
  openwa: { status: HealthState; detail?: string };
  queue: { status: HealthState; detail?: string };
  scheduler: { lastRunAt: Instant };
  lastBackup: { at: Instant; status: "ok" | "failed" | "unknown" };
  version: string;
}
