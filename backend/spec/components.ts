/**
 * Shared contract components (API_CONTRACTS §2) — the normative shapes every
 * endpoint section references. Registered by name so the generated document
 * emits `$ref`s instead of duplicating shapes.
 *
 * Where the verified frontend (`frontend/src/api/types.ts`) and the spec differ,
 * the choice is marked `[CONTRACT]` (follow the spec; the frontend handoffs raised
 * these as open requests) or `[ADOPTED]` (take the frontend's shape, which the
 * handoffs documented as an addition). Every one of them is listed in the M1
 * handoff §4.
 */
import { z } from "zod";
import { registry } from "./registry.js";


// ---------------------------------------------------------------------------
// Primitives and conventions (API_CONTRACTS §1)
// ---------------------------------------------------------------------------
export const Id = z.uuid().describe("UUID (UUIDv7; sorts by creation time)");
export const DateStr = z.iso.date().describe("Business date, academy-local (YYYY-MM-DD)");
export const Instant = z.iso.datetime().describe("Instant, ISO-8601 UTC");
export const Minor = z
  .number()
  .int()
  .describe("Money in integer minor units (LKR); never a float. Field names end in `Minor`.");
export const Currency = z.literal("LKR");
export const Role = z.enum(["owner", "coach"]);
export const HHmm = z
  .string()
  .regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, "HH:mm in academy-local time");

/** Standard page envelope (API_CONTRACTS §1). */
export const PageMeta = registry.register(
  "PageMeta",
  z.object({
    page: z.number().int().min(1),
    pageSize: z.number().int().min(1).max(100),
    total: z.number().int().min(0),
    totalPages: z.number().int().min(0),
  }),
);

/** `{ data: T[], meta: PageMeta }`. */
export function pageOf<T extends z.ZodType>(item: T) {
  return z.object({ data: z.array(item), meta: PageMeta }).describe("Paginated envelope");
}

/** Unpaginated small list (age groups, payment methods) — `{ data: T[] }`. */
export function listOf<T extends z.ZodType>(item: T) {
  return z.object({ data: z.array(item) });
}

export const ApiErrorDetail = z.object({
  field: z.string().optional(),
  issue: z.string(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

/** Error envelope (API_CONTRACTS §1.1) — identical for every non-2xx response. */
export const ApiError = registry.register(
  "ApiError",
  z.object({
    error: z.object({
      code: z.string().describe("Stable machine code, UPPER_SNAKE"),
      message: z.string().describe("Safe, human-readable English message"),
      details: z.array(ApiErrorDetail).optional(),
      requestId: z.string(),
    }),
  }),
);

// ---------------------------------------------------------------------------
// Shared query fragments (§1 pagination/sorting/filtering)
// ---------------------------------------------------------------------------
export const pageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export const dateRangeQuery = z.object({
  from: DateStr.optional(),
  to: DateStr.optional(),
});

/** `sort=-dueDate,fullName`; the allow-list is enforced per endpoint and unknown ⇒ 422 INVALID_SORT. */
export const sortParam = z.string().optional();

export const qParam = z.string().min(2).optional().describe("Free-text search (min 2 chars)");

// ---------------------------------------------------------------------------
// Identity and auth (§3.1)
// ---------------------------------------------------------------------------
export const User = registry.register(
  "User",
  z.object({
    id: Id,
    username: z
      .string()
      .regex(/^[a-z0-9._-]{3,32}$/)
      .describe("Login identifier; case-insensitive unique; immutable (ADR-018)"),
    fullName: z.string().max(120),
    phone: z.string().optional().describe("E.164"),
    role: Role,
    status: z.enum(["invited", "active", "disabled"]),
    totpEnabled: z.boolean(),
    lastLoginAt: Instant.optional(),
  }),
);

export const AcademySummary = z.object({
  name: z.string(),
  timezone: z.string(),
  logoUrl: z.string().optional(),
});

export const Me = registry.register(
  "Me",
  z.object({
    user: User,
    csrfToken: z.string().describe("Bound to the session; echo on X-CSRF-Token for non-GET"),
    academy: AcademySummary,
    permissions: z.array(z.string()).describe("Permission strings for this role (AUTH §4)"),
    assignedGroupIds: z.array(Id).optional().describe("Coach only"),
  }),
);

export const AuthSession = registry.register(
  "AuthSession",
  z.object({
    id: z.string().describe("Opaque session id (the raw token lives only in the cookie)"),
    createdAt: Instant,
    lastSeenAt: Instant,
    ip: z.string().optional(),
    userAgent: z.string().optional(),
    current: z.boolean().describe("True for the session making the request"),
  }),
);

export const CreateUserResponse = registry.register(
  "CreateUserResponse",
  z.object({
    user: User,
    inviteUrl: z.string().describe("Shown once; contains the single-use invite token"),
    inviteExpiresAt: Instant,
  }),
);

export const SessionListResponse = listOf(AuthSession);

// ---------------------------------------------------------------------------
// Settings (§3.2)
// ---------------------------------------------------------------------------
export const PaymentMethod = registry.register(
  "PaymentMethod",
  z.object({
    code: z.string().describe("Immutable after creation; deactivate instead of deleting"),
    label: z.string(),
    requiresReference: z.boolean(),
    isActive: z.boolean(),
  }),
);

export const PaymentMethodList = listOf(PaymentMethod);

/** SET-01. `[CONTRACT]` keeps API_CONTRACTS' `name`; the frontend calls it `academyName`. */
export const AcademySettings = registry.register(
  "AcademySettings",
  z.object({
    name: z.string(),
    shortName: z.string().optional(),
    address: z.string().optional(),
    phone: z.string().optional(),
    email: z.string().optional(),
    paymentInstructions: z.string().describe("Printed on invoices (bank details etc.)"),
    beneficiaryAccounts: z
      .array(z.object({ name: z.string(), accountMasked: z.string() }))
      .describe(
        "[ADOPTED] Academy accounts a bank receipt's beneficiary must match (PAYMENT_VERIFICATION §3).",
      ),
    timezone: z.string(),
    ageReferenceRule: z.enum(["jan_1_of_year", "fixed_month_day", "today"]),
    ageReferenceMonthDay: z
      .string()
      .regex(/^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/)
      .optional()
      .describe("MM-DD; required when ageReferenceRule = fixed_month_day"),
    allowFractionalMoney: z
      .boolean()
      .describe("false ⇒ every amount must be a multiple of 100 minor units"),
    coachCanSeeGuardianPhone: z.boolean(),
    attendanceCoachEditWindowHours: z.number().int().min(0),
    coachCheckinOpensMinutesBefore: z.number().int().min(0),
    coachCheckinClosesMinutesAfterEnd: z.number().int().min(0),
    invoiceLinkTtlDays: z.number().int().min(1),
  }),
);

export const BillingSettings = registry.register(
  "BillingSettings",
  z.object({
    billingFrequency: z.enum(["weekly", "monthly"]),
    billingPeriodMode: z.enum(["calendar", "anchored"]),
    weekStartDay: z.number().int().min(1).max(7),
    invoiceIssueTiming: z.enum(["period_start", "period_end"]),
    dueRuleType: z.enum(["days_after_issue", "days_after_period_start", "fixed_day_of_month"]),
    dueRuleValue: z.number().int().min(0),
    effectNote: z.string().describe('Always: "Applies to invoices issued after now"'),
  }),
);

export const ReminderRule = registry.register(
  "ReminderRule",
  z.object({
    id: Id,
    // `[CONTRACT]` DATABASE §3.6 stores `pre_due`/`overdue`; the frontend used
    // `reminder_pre_due`/`reminder_overdue`. Spec values win; see M1 handoff §4.
    kind: z.enum(["pre_due", "overdue"]),
    offsetDays: z.number().int().describe("Days before due (pre_due) or after due (overdue)"),
    isActive: z.boolean(),
  }),
);

export const ReminderRuleList = listOf(ReminderRule);

export const MessageTemplate = registry.register(
  "MessageTemplate",
  z.object({
    key: z.enum(["invoice_delivery", "reminder_pre_due", "reminder_overdue"]),
    label: z.string().optional(),
    body: z.string(),
    variables: z.array(z.string()).describe("Allowed {{variables}} for this template"),
    preview: z.string().optional().describe("Rendered server-side with sample data"),
  }),
);

export const MessageTemplateList = listOf(MessageTemplate);

export const MessagingSettings = registry.register(
  "MessagingSettings",
  z.object({
    sendWindowStart: HHmm,
    sendWindowEnd: HHmm,
    invoiceMode: z
      .enum(["link", "attachment_and_link"])
      .describe("attachment_and_link is rejected (422) until spike S1 confirms document sends"),
    pacingMinSeconds: z.number().int().min(0),
    pacingMaxSeconds: z.number().int().min(0),
    maxPerHour: z.number().int().min(1),
    optOutKeywords: z.array(z.string()),
    consentPolicyText: z
      .string()
      .optional()
      .describe("[ADOPTED] Consent wording the forms ship with (PAGE_SPECIFICATIONS §9)"),
  }),
);

/** SET-08 per-automation switches under the MSG-07 master pause (CR-003/ADR-019). */
export const Automations = registry.register(
  "Automations",
  z.object({
    invoiceDelivery: z.boolean(),
    reminderPreDue: z.boolean(),
    reminderOverdue: z.boolean(),
    proofCheck: z.boolean(),
  }),
);

export const AutomationsResponse = registry.register(
  "AutomationsResponse",
  Automations.extend({
    masterPaused: z
      .boolean()
      .describe("Read-only mirror of messaging_automation_enabled (MSG-07), inverted"),
  }),
);

// ---------------------------------------------------------------------------
// Groups, fees, coaches (§3.3)
// ---------------------------------------------------------------------------
export const AgeGroup = registry.register(
  "AgeGroup",
  z.object({
    id: Id,
    name: z.string().max(120),
    minAge: z.number().int().optional(),
    maxAge: z.number().int().optional(),
    sortOrder: z.number().int(),
    archivedAt: Instant.optional(),
    currentFeeMinor: Minor.optional().describe("Owner only — absent for coaches"),
    activePlayerCount: z.number().int().optional(),
  }),
);

export const AgeGroupList = listOf(AgeGroup);

export const GroupFee = registry.register(
  "GroupFee",
  z.object({
    id: Id,
    ageGroupId: Id,
    amountMinor: Minor,
    effectiveFrom: DateStr,
    effectiveTo: DateStr.optional(),
  }),
);

export const GroupFeeList = listOf(GroupFee);

export const AgeGroupSuggestion = registry.register(
  "AgeGroupSuggestion",
  z.object({
    referenceDate: DateStr,
    ageOnReference: z.number().int(),
    suggestions: z.array(z.object({ ageGroupId: Id, name: z.string() })),
  }),
);

export const CoachRow = registry.register(
  "CoachRow",
  z.object({
    user: User,
    groups: z.array(z.object({ id: Id, name: z.string() })),
  }),
);

export const CoachAssignment = registry.register(
  "CoachAssignment",
  z.object({
    id: Id,
    coachUserId: Id,
    coachName: z.string(),
    ageGroup: z.object({ id: Id, name: z.string() }),
    assignedFrom: DateStr,
    assignedTo: DateStr.optional(),
  }),
);

export const CoachGroupRef = z.object({
  id: Id,
  name: z.string(),
  playerCount: z.number().int(),
});
export const MyGroupsResponse = listOf(CoachGroupRef);

// ---------------------------------------------------------------------------
// People (§3.4)
// ---------------------------------------------------------------------------
export const ConsentStatus = z.enum(["unknown", "granted", "revoked"]);

export const Guardian = registry.register(
  "Guardian",
  z.object({
    id: Id,
    fullName: z.string().max(120),
    phone: z.string().describe("E.164"),
    relationship: z.string().optional(),
    whatsappConsent: ConsentStatus,
    consentRecordedAt: Instant.optional(),
    consentSource: z.string().optional(),
    optedOutAt: Instant.optional(),
  }),
);

export const PlayerGuardianLink = registry.register(
  "PlayerGuardianLink",
  z.object({
    guardian: Guardian,
    isPrimary: z.boolean(),
    receivesInvoices: z.boolean(),
  }),
);

export const GuardianWithPlayers = registry.register(
  "GuardianWithPlayers",
  Guardian.extend({
    players: z.array(z.object({ id: Id, fullName: z.string() })),
  }),
);

export const Player = registry.register(
  "Player",
  z.object({
    id: Id,
    registrationNo: z.string(),
    fullName: z.string().max(120),
    dateOfBirth: DateStr.optional(),
    ageOnReference: z.number().int().optional(),
    registrationDate: DateStr,
    status: z.enum(["active", "inactive", "withdrawn"]),
    statusEffectiveDate: DateStr,
    statusReason: z.string().optional(),
    currentGroup: z.object({ id: Id, name: z.string(), since: DateStr }).optional(),
    guardians: z.array(PlayerGuardianLink),
    notes: z.string().max(1000).optional().describe("Owner only"),
    coachNotes: z.string().max(500).optional(),
    billingAnchorDate: DateStr,
    outstandingMinor: Minor.optional(),
    version: z.number().int(),
  }),
);

/** Restricted coach projection (AUTH §4, T-AUTH-05): no DOB, guardians, notes or balances. */
export const PlayerCoachView = registry.register(
  "PlayerCoachView",
  z
    .object({
      id: Id,
      registrationNo: z.string(),
      fullName: z.string(),
      age: z.number().int().optional(),
      status: z.enum(["active", "inactive", "withdrawn"]),
      group: z.object({ id: Id, name: z.string() }).optional(),
      coachNotes: z.string().optional(),
      primaryGuardian: z
        .object({ fullName: z.string(), phone: z.string() })
        .optional()
        .describe("Only when academy_settings.coach_can_see_guardian_phone is true"),
    })
    .describe("Strict allow-list: a coach payload never carries a financial or DOB field"),
);

/** Union returned by PLY-01/PLY-03 depending on the caller's role. */
export const PlayerListItem = registry.register(
  "PlayerListItem",
  z.union([Player, PlayerCoachView]),
);

export const PlayerGuardianLinkInput = z.union([
  z.strictObject({ guardianId: Id }),
  z.strictObject({
    fullName: z.string().min(2).max(120),
    phone: z.string().describe("Local (077…) or E.164; normalized to E.164, LK default"),
    relationship: z.string().optional(),
    whatsappConsent: z
      .object({ status: z.enum(["granted", "unknown"]), source: z.string() })
      .optional(),
  }),
]);

/**
 * One entry of PLY-02's `guardians[]`.
 *
 * API_CONTRACTS declares this as `({guardianId} | {fullName, phone, …})[] & {isPrimary, receivesInvoices}[]`,
 * which is not valid TypeScript and was raised as a contract gap in the frontend
 * Step 3 handoff §4. It is expressed here as one object per entry whose link flags
 * are required and whose identity is either an existing `guardianId` **or** a new
 * guardian (`fullName` + `phone`) — exactly one of the two, enforced by a
 * validator so the rule cannot be lost in a schema rewrite.
 */
export const PlayerGuardianCreate = z
  .strictObject({
    guardianId: Id.optional().describe("Link an existing guardian"),
    fullName: z.string().min(2).max(120).optional().describe("Create a new guardian"),
    phone: z.string().optional().describe("Required with fullName; normalized to E.164"),
    relationship: z.string().max(60).optional(),
    whatsappConsent: z
      .object({ status: z.enum(["granted", "unknown"]), source: z.string() })
      .optional(),
    isPrimary: z.boolean().describe("Exactly one entry per player must be primary"),
    receivesInvoices: z.boolean(),
  })
  .refine(
    (g) => (g.guardianId !== undefined) !== (g.fullName !== undefined && g.phone !== undefined),
    { message: "provide either guardianId, or both fullName and phone" },
  );

/** PLY-02 request body (contract-complete, no invented fields). */
export const PlayerCreate = registry.register(
  "PlayerCreate",
  z.strictObject({
    fullName: z.string().min(2).max(120),
    dateOfBirth: DateStr.optional(),
    registrationDate: DateStr,
    ageGroupId: Id.optional(),
    notes: z.string().max(1000).optional(),
    coachNotes: z.string().max(500).optional(),
    guardians: z.array(PlayerGuardianCreate).min(1),
    acknowledgeDuplicates: z.boolean().optional().describe("Required to pass a duplicate warning"),
  }),
);

export const GuardianInput = z.union([
  z.strictObject({ guardianId: Id, isPrimary: z.boolean(), receivesInvoices: z.boolean() }),
  z.strictObject({
    fullName: z.string().min(2).max(120),
    phone: z.string(),
    relationship: z.string().optional(),
    whatsappConsent: z
      .object({ status: z.enum(["granted", "unknown"]), source: z.string() })
      .optional(),
    isPrimary: z.boolean(),
    receivesInvoices: z.boolean(),
  }),
]);

export const GroupHistoryEntry = registry.register(
  "GroupHistoryEntry",
  z.object({
    id: Id,
    ageGroup: z.object({ id: Id, name: z.string() }),
    effectiveFrom: DateStr,
    effectiveTo: DateStr.optional(),
    reason: z.string().optional(),
    changedBy: z.object({ id: Id, fullName: z.string() }),
  }),
);

export const DuplicateMatch = registry.register(
  "DuplicateMatch",
  z.object({
    player: PlayerListItem,
    reason: z.string(),
    score: z.number().describe("Advisory similarity score (0–1)"),
  }),
);

export const GuardianBalance = registry.register(
  "GuardianBalance",
  z.object({
    outstandingMinor: Minor,
    overdueMinor: Minor,
    creditMinor: Minor,
    openInvoices: z
      .array(z.lazy(() => Invoice))
      .optional()
      .describe("Open invoices behind the outstanding figure (GDN-06)"),
  }),
);

export const PlayerBalance = registry.register(
  "PlayerBalance",
  z.object({
    outstandingMinor: Minor,
    overdueMinor: Minor,
    creditMinor: Minor,
  }),
);

export const PlayerAttendance = registry.register(
  "PlayerAttendance",
  z.object({
    summary: z.object({
      present: z.number().int(),
      absent: z.number().int(),
      late: z.number().int(),
      excused: z.number().int(),
      unmarked: z.number().int(),
    }),
    data: z.array(
      z.object({
        sessionId: Id,
        sessionDate: DateStr,
        status: z.enum(["present", "absent", "late", "excused"]),
        note: z.string().optional(),
      }),
    ),
  }),
);

// ---------------------------------------------------------------------------
// Money (§3.6)
// ---------------------------------------------------------------------------
export const InvoiceItem = registry.register(
  "InvoiceItem",
  z.object({
    id: Id,
    lineNo: z.number().int(),
    itemType: z.enum(["fee", "adjustment"]),
    description: z.string(),
    quantity: z.number().int(),
    unitAmountMinor: Minor,
    amountMinor: Minor,
    reason: z.string().optional().describe("Required for an adjustment"),
  }),
);

export const Allocation = registry.register(
  "Allocation",
  z.object({
    id: Id,
    paymentId: Id,
    invoice: z.object({ id: Id, invoiceNumber: z.string() }),
    amountMinor: Minor,
    allocatedAt: Instant,
    reversedAt: Instant.optional(),
  }),
);

export const ProofDocKind = z.enum(["bank_receipt_pdf", "bank_receipt_image", "other"]);

export const ProofFinding = registry.register(
  "ProofFinding",
  z.object({
    code: z.string(),
    level: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    result: z.enum(["pass", "warn", "fail", "unknown"]),
    detail: z.string(),
    meta: z.record(z.string(), z.unknown()).optional(),
  }),
);

export const ProofExtract = registry.register(
  "ProofExtract",
  z.object({
    bankName: z.string().optional(),
    documentType: z.string().optional(),
    reference: z.string().optional(),
    transactionAt: Instant.optional(),
    amountMinor: Minor.optional(),
    currency: z.string().optional(),
    payerName: z.string().optional(),
    payerAccountMasked: z.string().optional(),
    beneficiaryName: z.string().optional(),
    beneficiaryAccountMasked: z.string().optional(),
    channel: z.string().optional(),
    status: z.string().optional(),
    remarks: z.string().optional(),
  }),
);

export const ProofVerification = registry.register(
  "ProofVerification",
  z.object({
    docKind: ProofDocKind,
    status: z.enum(["not_run", "checked", "unverifiable", "failed"]),
    findings: z.array(ProofFinding),
    extracted: ProofExtract.optional(),
    parserVersion: z.string().optional(),
    checkedAt: Instant.optional(),
  }),
);

export const ProofMeta = registry.register(
  "ProofMeta",
  z.object({
    fileId: Id,
    originalName: z.string().optional(),
    mimeType: z.string(),
    sizeBytes: z.number().int(),
    uploadedAt: Instant,
    uploadedBy: z.object({ id: Id, fullName: z.string() }),
    docKind: ProofDocKind,
    verification: ProofVerification.optional(),
  }),
);

export const Payment = registry.register(
  "Payment",
  z.object({
    id: Id,
    amountMinor: Minor,
    currency: Currency,
    method: PaymentMethod,
    reference: z.string().optional(),
    receivedAt: Instant,
    payer: z.object({ guardianId: Id.optional(), name: z.string() }).optional(),
    status: z.enum(["pending", "confirmed", "rejected", "reversed"]),
    allocatedMinor: Minor,
    unallocatedMinor: Minor.describe("Credit held on this payment when confirmed"),
    allocations: z.array(Allocation).optional(),
    proofs: z.array(ProofMeta).optional(),
    receipt: z.object({ id: Id, receiptNumber: z.string() }).optional(),
    notes: z.string().optional(),
    rejectReason: z.string().optional(),
    reverseReason: z.string().optional(),
    proofVerification: z
      .object({
        status: z.enum(["none", "passed", "warned", "failed", "unverifiable"]),
        checkedAt: Instant.optional(),
      })
      .optional()
      .describe("Advisory rollup of the proof findings — never a confirmation (ADR-020/021)"),
    version: z.number().int(),
  }),
);

export const Invoice = registry.register(
  "Invoice",
  z.object({
    id: Id,
    invoiceNumber: z.string(),
    kind: z.enum(["periodic", "manual"]),
    status: z.enum(["issued", "partially_paid", "paid", "void"]),
    isOverdue: z.boolean().describe("Derived, never stored (ADR-010)"),
    daysOverdue: z.number().int(),
    player: z.object({ id: Id, fullName: z.string(), registrationNo: z.string() }),
    guardian: z.object({ id: Id, fullName: z.string() }).optional(),
    ageGroup: z.object({ id: Id, name: z.string() }),
    periodStart: DateStr.optional(),
    periodEnd: DateStr.optional(),
    issueDate: DateStr,
    dueDate: DateStr,
    currency: Currency,
    subtotalMinor: Minor,
    adjustmentsMinor: Minor,
    totalMinor: Minor,
    paidMinor: Minor,
    balanceMinor: Minor,
    items: z.array(InvoiceItem).optional().describe("INV-02 only; absent in list responses"),
    allocations: z.array(Allocation).optional().describe("INV-02 only"),
    hasPdf: z.boolean(),
    voidedAt: Instant.optional(),
    voidReason: z.string().optional(),
    version: z.number().int(),
  }),
);

export const BillingPreviewLine = z.object({
  playerId: Id,
  playerName: z.string(),
  registrationNo: z.string(),
  ageGroup: z.object({ id: Id, name: z.string() }),
  periodStart: DateStr,
  periodEnd: DateStr,
  issueDate: DateStr,
  dueDate: DateStr,
  feeMinor: Minor,
  feeId: Id,
  guardian: z.object({ id: Id, fullName: z.string() }).optional(),
  warnings: z.array(z.string()),
});

export const BillingSkipReason = z.enum([
  "NO_GROUP",
  "NO_FEE",
  "NOT_ACTIVE",
  "ALREADY_INVOICED",
  "NOT_YET_REGISTERED",
]);

export const BillingPreview = registry.register(
  "BillingPreview",
  z.object({
    previewHash: z.string().describe("Echoed to BIL-02; a mismatch ⇒ 409 PREVIEW_STALE"),
    targetDate: DateStr,
    frequency: z.enum(["weekly", "monthly"]),
    mode: z.enum(["calendar", "anchored"]),
    lines: z.array(BillingPreviewLine),
    skipped: z.array(
      z.object({ playerId: Id, playerName: z.string(), reason: BillingSkipReason }),
    ),
    totals: z.object({ count: z.number().int(), totalMinor: Minor }),
  }),
);

export const BillingAdjustment = z.strictObject({
  playerId: Id,
  amountMinor: Minor.describe("Negative only — BILLING_ENGINE §10"),
  reason: z.string(),
});

export const BillingRun = registry.register(
  "BillingRun",
  z.object({
    id: Id,
    runKey: z.string().describe("scheduler:{date} | manual:{Idempotency-Key}; UNIQUE"),
    status: z.enum(["issued", "partial", "failed"]),
    targetDate: DateStr,
    invoicesCreated: z.number().int(),
    invoicesSkipped: z.number().int(),
    invoiceIds: z.array(Id),
    startedAt: Instant,
    completedAt: Instant.optional(),
  }),
);

export const ReceiptSummary = registry.register(
  "ReceiptSummary",
  z.object({
    id: Id,
    receiptNumber: z.string(),
    paymentId: Id,
    issuedAt: Instant,
    voided: z.boolean(),
  }),
);

// ---------------------------------------------------------------------------
// Sessions, attendance, coach time (§3.5)
// ---------------------------------------------------------------------------
export const TrainingSchedule = registry.register(
  "TrainingSchedule",
  z.object({
    id: Id,
    ageGroup: z.object({ id: Id, name: z.string() }),
    weekday: z.number().int().min(1).max(7),
    startTime: HHmm,
    endTime: HHmm,
    venue: z.string().optional(),
    validFrom: DateStr,
    validTo: DateStr.optional(),
    isActive: z.boolean(),
  }),
);

export const Session = registry.register(
  "Session",
  z.object({
    id: Id,
    ageGroup: z.object({ id: Id, name: z.string() }),
    sessionDate: DateStr,
    startsAt: Instant,
    endsAt: Instant,
    venue: z.string().optional(),
    status: z.enum(["scheduled", "completed", "cancelled"]),
    cancelReason: z.string().optional(),
    leadCoach: z.object({ id: Id, fullName: z.string() }).optional(),
    attendanceSummary: z
      .object({
        present: z.number().int(),
        absent: z.number().int(),
        late: z.number().int(),
        excused: z.number().int(),
        unmarked: z.number().int(),
      })
      .optional(),
    version: z.number().int(),
  }),
);

export const AttendanceStatus = z.enum(["present", "absent", "late", "excused"]);

export const RosterRow = registry.register(
  "RosterRow",
  z.object({
    player: z.object({ id: Id, fullName: z.string(), registrationNo: z.string() }),
    record: z
      .object({
        status: AttendanceStatus,
        note: z.string().optional(),
        markedAt: Instant,
        markedBy: z.string(),
        version: z.number().int(),
      })
      .optional()
      .describe("Absent while the player is unmarked"),
  }),
);

export const SessionAttendance = registry.register(
  "SessionAttendance",
  z.object({
    session: Session,
    roster: z.array(RosterRow),
    editableUntil: Instant,
    canEdit: z.boolean(),
  }),
);

export const AttendanceRecordInput = z.strictObject({
  playerId: Id,
  status: AttendanceStatus,
  note: z.string().max(500).optional(),
  version: z.number().int().optional(),
  reason: z.string().min(5).max(200).optional().describe("Required when changing an existing mark"),
});

export const CoachAttendance = registry.register(
  "CoachAttendance",
  z.object({
    id: Id,
    coach: z.object({ id: Id, fullName: z.string() }),
    session: z.object({ id: Id, ageGroupName: z.string(), startsAt: Instant }),
    checkInAt: Instant,
    checkOutAt: Instant.optional(),
    enteredBy: z.enum(["self", "owner"]),
    corrected: z.boolean(),
    checkInNote: z.string().optional(),
    version: z.number().int(),
  }),
);

// ---------------------------------------------------------------------------
// Messaging (§3.7)
// ---------------------------------------------------------------------------
/**
 * OUR provider-neutral label set (API_CONTRACTS §2). OpenWA's own lifecycle
 * strings are unconfirmed until spike S1 (O18); anything unrecognized maps here
 * to `unknown` and must never be presented as provider text.
 */
export const SessionStatusLabel = z.enum([
  "connected",
  "awaiting_qr",
  "starting",
  "stopped",
  "failed",
  "unknown",
]);

export const MessageJob = registry.register(
  "MessageJob",
  z.object({
    // [ADOPTED] `test` (MSG-08 returns a MessageJob, which needs a representable kind).
    kind: z.enum(["invoice_delivery", "reminder_pre_due", "reminder_overdue", "test"]),
    status: z.enum([
      "queued",
      "sending",
      "sent",
      "failed",
      "dead",
      "needs_review",
      "cancelled",
      "skipped",
    ]),
    skipReason: z
      .string()
      .optional()
      .describe(
        "no_consent | opted_out | invoice_paid | invoice_void | automation_paused | no_phone | player_withdrawn | AUTOMATION_DISABLED",
      ),
    deliveryState: z
      .enum(["unknown", "server_accepted", "device_delivered", "read", "provider_error"])
      .describe("device_delivered/read only from a provider-reported ack (OPENWA §9)"),
    invoice: z.object({ id: Id, invoiceNumber: z.string() }),
    player: z.object({ id: Id, fullName: z.string() }),
    guardian: z.object({ id: Id, fullName: z.string(), phoneMasked: z.string() }),
    scheduledFor: Instant,
    nextAttemptAt: Instant.optional(),
    attempts: z.number().int(),
    maxAttempts: z.number().int(),
    sentAt: Instant.optional(),
    lastError: z.object({ code: z.string(), message: z.string() }).optional(),
    manualFallback: z
      .object({ at: Instant, by: z.string(), note: z.string().optional() })
      .optional(),
    renderedBody: z.string().optional(),
    events: z
      .array(
        z.object({
          eventType: z.string(),
          at: Instant,
          providerAck: z.number().optional(),
        }),
      )
      .optional(),
  }),
);

export const MessageQueueCounts = z.object({
  queued: z.number().int(),
  sending: z.number().int(),
  failedLast24h: z.number().int(),
  dead: z.number().int(),
  needsReview: z.number().int(),
});

export const MessagingStatus = registry.register(
  "MessagingStatus",
  z.object({
    automationEnabled: z.boolean(),
    automations: Automations,
    provider: z.literal("openwa"),
    session: z.object({ status: SessionStatusLabel, checkedAt: Instant }),
    queue: MessageQueueCounts,
    lastSentAt: Instant.optional(),
  }),
);

// ---------------------------------------------------------------------------
// Dashboards, reports, admin (§3.8)
// ---------------------------------------------------------------------------
export const OwnerDashboard = registry.register(
  "OwnerDashboard",
  z.object({
    range: z.object({ from: DateStr, to: DateStr }),
    players: z.object({
      active: z.number().int(),
      inactive: z.number().int(),
      withdrawn: z.number().int(),
      byGroup: z.array(
        z.object({ ageGroupId: Id, name: z.string(), count: z.number().int() }),
      ),
    }),
    coachTime: z.object({
      checkedInNow: z.array(
        z.object({
          coach: z.object({ id: Id, fullName: z.string() }),
          session: z.object({ id: Id, ageGroupName: z.string(), startsAt: Instant }),
          checkInAt: Instant,
          elapsedMinutes: z.number().int(),
        }),
      ),
      todayMinutes: z.number().int().describe("Closed records only (T-ATT-11)"),
      weekMinutes: z.number().int(),
      openNeedingCorrection: z.number().int(),
    }),
    sessions: z.object({
      today: z.array(Session),
      next7Days: z.array(Session),
      todayAttendance: z.object({
        present: z.number().int(),
        absent: z.number().int(),
        late: z.number().int(),
        excused: z.number().int(),
        unmarked: z.number().int(),
      }),
    }),
    money: z.object({
      invoicedMinor: Minor,
      invoicesIssuedCount: z.number().int(),
      collectedMinor: Minor.describe("Confirmed payments received in range — invoiced ≠ collected"),
      outstandingMinor: Minor.describe("As of now"),
      overdueMinor: Minor.describe("As of now"),
      overdueCount: z.number().int(),
      dueSoon: z.object({
        days: z.number().int(),
        count: z.number().int(),
        totalMinor: Minor,
      }),
      creditHeldMinor: Minor,
    }),
    messaging: z.object({
      automationEnabled: z.boolean(),
      automations: Automations,
      sessionStatus: SessionStatusLabel,
      failed24h: z.number().int(),
      dead: z.number().int(),
      needsReview: z.number().int(),
    }),
    alerts: z.array(
      z.object({
        code: z.string(),
        severity: z.enum(["info", "warning", "critical"]),
        message: z.string(),
        link: z.string().optional(),
      }),
    ),
  }),
);

export const CoachDashboard = registry.register(
  "CoachDashboard",
  z.object({
    todaySessions: z.array(Session),
    upcoming: z.array(Session),
    myOpenCheckIn: CoachAttendance.optional(),
    myWeekMinutes: z
      .number()
      .int()
      .describe("[ADOPTED] CR-003: the coach's own closed check-ins this week (T-UI-10)"),
  }),
);

export const ReportName = z.enum([
  "players",
  "attendance-summary",
  "attendance-detail",
  "invoices",
  "payments",
  "outstanding",
  "collections",
  "coach-attendance",
]);

/** One flat CSV cell — never an object (RPT-02 streams flat rows). */
export const ReportCell = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const ReportColumn = registry.register(
  "ReportColumn",
  z.object({
    key: z.string(),
    label: z.string(),
    type: z.enum(["text", "date", "instant", "money", "number", "percent"]),
  }),
);

export const ReportResult = registry.register(
  "ReportResult",
  pageOf(z.record(z.string(), ReportCell)).extend({
    totals: z.record(z.string(), z.number()).optional(),
    columns: z.array(ReportColumn).describe("[ADOPTED] column metadata the table needs"),
    generatedAt: Instant,
    filters: z.record(z.string(), z.string().optional()),
  }),
);

export const AuditEntry = registry.register(
  "AuditEntry",
  z.object({
    id: z.number().int(),
    occurredAt: Instant,
    actor: z.object({ id: Id, fullName: z.string(), role: Role }).optional(),
    action: z.string(),
    entityType: z.string(),
    entityId: Id,
    reason: z.string().optional(),
    before: z.unknown().optional(),
    after: z.unknown().optional(),
    requestId: z.string(),
  }),
);

export const HealthState = z.enum(["ok", "degraded", "down", "unknown"]);

export const SystemHealth = registry.register(
  "SystemHealth",
  z.object({
    db: z.object({ status: HealthState, detail: z.string().optional() }),
    storage: z.object({ status: HealthState, detail: z.string().optional() }),
    openwa: z.object({ status: HealthState, detail: z.string().optional() }),
    queue: z.object({ status: HealthState, detail: z.string().optional() }),
    scheduler: z.object({ lastRunAt: Instant }),
    lastBackup: z.object({ at: Instant, status: z.enum(["ok", "failed", "unknown"]) }),
    version: z.string(),
  }),
);

export const ImportIssue = z.object({
  row: z.number().int(),
  field: z.string().optional(),
  message: z.string(),
});

/**
 * [ADOPTED] The contract fixes `preview[]` without its fields; this is the shape the
 * frontend declared and the CSV columns in CSV_IMPORT §2 define. Listed in M1 §4.
 */
export const ImportPreviewRow = registry.register(
  "ImportPreviewRow",
  z.object({
    row: z.number().int(),
    fullName: z.string(),
    dateOfBirth: DateStr.optional(),
    registrationDate: DateStr.optional(),
    ageGroupName: z.string().optional(),
    status: z.enum(["active", "inactive", "withdrawn"]).optional(),
    guardianName: z.string(),
    guardianPhone: z.string(),
    guardianRelationship: z.string().optional(),
    whatsappConsent: z.enum(["granted", "unknown"]).optional(),
    consentSource: z.string().optional(),
    notes: z.string().optional(),
  }),
);

export const ImportValidation = registry.register(
  "ImportValidation",
  z.object({
    batchId: Id,
    rowCount: z.number().int(),
    errors: z.array(ImportIssue),
    warnings: z.array(ImportIssue),
    preview: z.array(ImportPreviewRow),
  }),
);

export const ImportCommitResult = registry.register(
  "ImportCommitResult",
  z.object({ created: z.number().int(), skipped: z.number().int() }),
);

// ---------------------------------------------------------------------------
// Type aliases for the primitives above.
//
// Each schema is also its own TypeScript type, so server code imports one name for both
// (`Role` the zod enum for validation, `Role` the union for signatures). A value and a
// type may share a name in TypeScript, which keeps the contract module the single place
// either comes from.
// ---------------------------------------------------------------------------
export type Role = z.infer<typeof Role>;
export type SessionStatusLabel = z.infer<typeof SessionStatusLabel>;
export type AttendanceStatus = z.infer<typeof AttendanceStatus>;
export type ConsentStatus = z.infer<typeof ConsentStatus>;
export type ProofDocKind = z.infer<typeof ProofDocKind>;
export type ProofVerificationStatus = z.infer<typeof ProofVerification>["status"];
export type ReportName = z.infer<typeof ReportName>;
export type User = z.infer<typeof User>;
export type Me = z.infer<typeof Me>;
export type Invoice = z.infer<typeof Invoice>;
export type Payment = z.infer<typeof Payment>;
export type MessageJob = z.infer<typeof MessageJob>;
export type Session = z.infer<typeof Session>;
export type CoachAttendance = z.infer<typeof CoachAttendance>;
