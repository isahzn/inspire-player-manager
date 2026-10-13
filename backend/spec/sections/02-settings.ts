/**
 * API_CONTRACTS §3.2 — Settings (SET-01..SET-08).
 *
 * Note on SET-03: the contract specifies `multipart/form-data` for the logo upload,
 * but `EndpointDef` can only declare a JSON request body, so no `body` is emitted here
 * (a JSON body would be a false claim) and the multipart part is described in prose.
 * Adding a `bodyContentType` field to the registry is the fix — reported, not guessed.
 */
import { endpoint, section, res, z, type Section } from "../registry.js";
import {
  AcademySettings,
  AutomationsResponse,
  BillingSettings,
  MessageTemplate,
  MessageTemplateList,
  MessagingSettings,
  PaymentMethod,
  PaymentMethodList,
  ReminderRule,
  ReminderRuleList,
  HHmm,
  Id,
} from "../components.js";

/** SET-01 patch body: the settings the owner may change (audit before/after). */
const AcademySettingsPatch = z.strictObject({
  name: z.string().min(1).max(120).optional(),
  shortName: z.string().max(60).optional(),
  address: z.string().max(300).optional(),
  phone: z.string().max(40).optional(),
  email: z.string().max(200).optional(),
  paymentInstructions: z
    .string()
    .max(1000)
    .optional()
    .describe("Printed on invoices (bank details etc.)"),
  beneficiaryAccounts: z
    .array(z.strictObject({ name: z.string().max(120), accountMasked: z.string().max(40) }))
    .max(5)
    .optional()
    .describe("Bank accounts a receipt's beneficiary must match (PAYMENT_VERIFICATION §3)"),
  timezone: z.string().max(64).optional(),
  ageReferenceRule: z.enum(["jan_1_of_year", "fixed_month_day", "today"]).optional(),
  ageReferenceMonthDay: z
    .string()
    .regex(/^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/)
    .optional()
    .describe("Required when ageReferenceRule = fixed_month_day"),
  allowFractionalMoney: z.boolean().optional(),
  coachCanSeeGuardianPhone: z.boolean().optional(),
  attendanceCoachEditWindowHours: z.number().int().min(0).max(720).optional(),
  coachCheckinOpensMinutesBefore: z.number().int().min(0).max(1440).optional(),
  coachCheckinClosesMinutesAfterEnd: z.number().int().min(0).max(1440).optional(),
  invoiceLinkTtlDays: z.number().int().min(1).max(365).optional(),
});

/** SET-02 patch body. A change never touches already-issued invoices (BILLING_ENGINE). */
const BillingSettingsPatch = z.strictObject({
  billingFrequency: z.enum(["weekly", "monthly"]).optional(),
  billingPeriodMode: z.enum(["calendar", "anchored"]).optional(),
  weekStartDay: z.number().int().min(1).max(7).optional(),
  invoiceIssueTiming: z.enum(["period_start", "period_end"]).optional(),
  dueRuleType: z
    .enum(["days_after_issue", "days_after_period_start", "fixed_day_of_month"])
    .optional(),
  dueRuleValue: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "Days, or day-of-month 1..28 when dueRuleType = fixed_day_of_month (which also requires billingFrequency = monthly)",
    ),
});

const MessagingSettingsPatch = z.strictObject({
  sendWindowStart: HHmm.optional(),
  sendWindowEnd: HHmm.optional(),
  invoiceMode: z
    .enum(["link", "attachment_and_link"])
    .optional()
    .describe("attachment_and_link ⇒ 422 until spike S1 passes the document-send test"),
  pacingMinSeconds: z.number().int().min(0).max(3600).optional(),
  pacingMaxSeconds: z.number().int().min(0).max(3600).optional(),
  maxPerHour: z.number().int().min(1).max(600).optional(),
  optOutKeywords: z.array(z.string().min(1).max(32)).min(1).max(20).optional(),
  consentPolicyText: z.string().max(2000).optional(),
});

const AutomationsPatch = z.strictObject({
  invoiceDelivery: z.boolean().optional(),
  reminderPreDue: z.boolean().optional(),
  reminderOverdue: z.boolean().optional(),
  proofCheck: z.boolean().optional(),
});

export const settingsSection: Section = section("3.2 Settings", [
  // --- SET-01 academy profile ----------------------------------------------
  endpoint({
    id: "SET-01",
    operationId: "SET-01.read",
    method: "get",
    path: "/settings/academy",
    auth: "owner",
    permission: "settings:manage",
    summary: "Read academy settings",
    description:
      "Owner only. Coaches receive only the name, logo and timezone through AUTH-03 `/auth/me` (AUTH_AND_PERMISSIONS §4).",
    tags: ["Settings"],
    responses: [res.json(200, AcademySettings, "Current academy settings")],
    milestone: "m2",
  }),
  endpoint({
    id: "SET-01",
    operationId: "SET-01.update",
    method: "patch",
    path: "/settings/academy",
    auth: "owner",
    permission: "settings:manage",
    summary: "Update academy settings",
    description:
      "Partial update; unknown fields are rejected. Writes an audit row with before/after. Changes to the age rule or coach visibility affect future computations only.",
    tags: ["Settings"],
    body: AcademySettingsPatch,
    mutating: true,
    audit: "settings.academy.update",
    responses: [res.json(200, AcademySettings, "Updated settings")],
    milestone: "m2",
  }),

  // --- SET-02 billing configuration ----------------------------------------
  endpoint({
    id: "SET-02",
    operationId: "SET-02.read",
    method: "get",
    path: "/settings/billing",
    auth: "owner",
    permission: "settings:manage",
    summary: "Read billing configuration",
    tags: ["Settings"],
    responses: [
      res.json(200, BillingSettings, "Billing configuration plus `effectNote`"),
    ],
    milestone: "m2",
  }),
  endpoint({
    id: "SET-02",
    operationId: "SET-02.update",
    method: "patch",
    path: "/settings/billing",
    auth: "owner",
    permission: "settings:manage",
    summary: "Update billing configuration",
    description:
      "Applies to invoices issued after now — issued invoices are immutable snapshots (ADR-014), so no stored invoice, PDF or balance changes. `fixed_day_of_month` requires monthly frequency and a value in 1..28 (422 otherwise).",
    tags: ["Settings"],
    body: BillingSettingsPatch,
    mutating: true,
    audit: "settings.billing.update",
    responses: [res.json(200, BillingSettings, "Updated billing configuration")],
    milestone: "m2",
  }),

  // --- SET-03 logo ---------------------------------------------------------
  endpoint({
    id: "SET-03",
    method: "post",
    path: "/settings/logo",
    auth: "owner",
    permission: "settings:manage",
    summary: "Upload the academy logo",
    description:
      "`multipart/form-data` with a single `file` part: PNG, JPEG or SVG up to 1 MB. The bytes are sniffed by magic number (a mislabelled file is 415) and stored in the private bucket; only the resulting URL is public through `/auth/me` and PDFs. Writes an audit row.",
    tags: ["Settings"],
    mutating: true,
    audit: "settings.logo.upload",
    responses: [
      res.json(200, z.object({ logoUrl: z.string() }), "Stored logo URL"),
    ],
    errors: ["FILE_TOO_LARGE", "UNSUPPORTED_FILE_TYPE", "DEPENDENCY_UNAVAILABLE"],
    milestone: "m6",
  }),

  /**
   * The read side of SET-03, and the reason it exists: the contract promises that a logo's URL
   * is "public through `/auth/me` and PDFs", and a private object store cannot mint a public URL
   * (OPEN-016 has no bucket). So the URL names this route, which serves the academy's own logo
   * with **no session** — it takes no parameter, so it can only ever answer with the logo the
   * owner uploaded and cannot be pointed at anything else in private storage.
   */
  endpoint({
    id: "PUB-02",
    method: "get",
    path: "/public/academy/logo",
    auth: "public",
    summary: "Fetch the academy logo",
    description:
      "The one public brand asset. Serves the current logo as uploaded (PNG/JPEG/SVG) with a 5-minute cache, so a settings screen can render it straight in an `<img>`; `404` while no logo has been uploaded, and the UI falls back to the name as a text wordmark. No parameter is accepted: the response is always the academy's own logo.",
    tags: ["Public"],
    responses: [
      {
        status: 200,
        description: "The logo bytes",
        contentType: "image/png",
        schema: z.string().openapi({ format: "binary" }),
      },
      { status: 404, description: "NOT_FOUND — no logo has been uploaded." },
    ],
    milestone: "m6",
  }),

  // --- SET-04 payment methods ---------------------------------------------
  endpoint({
    id: "SET-04",
    operationId: "SET-04.list",
    method: "get",
    path: "/settings/payment-methods",
    auth: "owner",
    permission: "settings:manage",
    summary: "List payment methods",
    description: "Unpaginated small list (§1). Includes inactive methods so history stays explainable.",
    tags: ["Settings"],
    responses: [res.json(200, PaymentMethodList, "Payment methods")],
    milestone: "m5",
  }),
  endpoint({
    id: "SET-04",
    operationId: "SET-04.create",
    method: "post",
    path: "/settings/payment-methods",
    auth: "owner",
    permission: "settings:manage",
    summary: "Create a payment method",
    description:
      "`code` is immutable after creation and unique (a duplicate is rejected). New methods are created active by default. Writes an audit row.",
    tags: ["Settings"],
    body: z.strictObject({
      code: z
        .string()
        .regex(/^[a-z][a-z0-9_]{1,31}$/, "lower_snake_case, e.g. bank_transfer")
        .describe("Immutable identifier"),
      label: z.string().min(1).max(60),
      requiresReference: z.boolean().default(false),
      isActive: z.boolean().default(true),
      sortOrder: z.number().int().min(0).max(100).optional(),
    }),
    mutating: true,
    audit: "settings.payment_method.create",
    responses: [res.json(201, PaymentMethod, "Created payment method")],
    milestone: "m5",
  }),
  endpoint({
    id: "SET-04",
    operationId: "SET-04.update",
    method: "patch",
    path: "/settings/payment-methods/{code}",
    auth: "owner",
    permission: "settings:manage",
    summary: "Update a payment method",
    description:
      "`code` cannot be changed — deactivate instead of deleting, because payments and invoices reference it. Writes an audit row.",
    tags: ["Settings"],
    params: z.object({ code: z.string() }),
    body: z.strictObject({
      label: z.string().min(1).max(60).optional(),
      requiresReference: z.boolean().optional(),
      isActive: z.boolean().optional(),
      sortOrder: z.number().int().min(0).max(100).optional(),
    }),
    mutating: true,
    audit: "settings.payment_method.update",
    responses: [res.json(200, PaymentMethod, "Updated payment method")],
    milestone: "m5",
  }),

  // --- SET-05 reminder rules ----------------------------------------------
  endpoint({
    id: "SET-05",
    operationId: "SET-05.list",
    method: "get",
    path: "/settings/reminder-rules",
    auth: "owner",
    permission: "messaging:manage",
    summary: "List reminder rules",
    description:
      "Unpaginated small list. Defaults: `pre_due` 3 and 1 days, `overdue` 1, 7 and 14 days (DATABASE §3.6).",
    tags: ["Settings"],
    responses: [res.json(200, ReminderRuleList, "Reminder rules")],
    milestone: "m7",
  }),
  endpoint({
    id: "SET-05",
    operationId: "SET-05.create",
    method: "post",
    path: "/settings/reminder-rules",
    auth: "owner",
    permission: "messaging:manage",
    summary: "Create a reminder rule",
    description:
      "`(kind, offsetDays)` is unique (DATABASE §3.6). NOTE: the contract does not name an error code for a duplicate rule — the M1 handoff raises this; the server rejects it as a 422 `VALIDATION_ERROR` on `offsetDays` until the catalogue says otherwise. Writes an audit row.",
    tags: ["Settings"],
    body: z.strictObject({
      kind: z.enum(["pre_due", "overdue"]),
      offsetDays: z
        .number()
        .int()
        .min(0)
        .max(90)
        .describe("Days before due (`pre_due`) or after due (`overdue`)"),
      isActive: z.boolean().default(true),
    }),
    mutating: true,
    audit: "settings.reminder_rule.create",
    responses: [res.json(201, ReminderRule, "Created reminder rule")],
    milestone: "m7",
  }),
  endpoint({
    id: "SET-05",
    operationId: "SET-05.update",
    method: "patch",
    path: "/settings/reminder-rules/{id}",
    auth: "owner",
    permission: "messaging:manage",
    summary: "Update a reminder rule",
    description:
      "`kind` is not patchable — delete and recreate instead. Note that `isActive` here means \"this rule exists\"; the per-automation switch that decides whether late reminders are sent at all is SET-08 (CR-003). Writes an audit row.",
    tags: ["Settings"],
    params: z.object({ id: Id }),
    body: z.strictObject({
      offsetDays: z.number().int().min(0).max(90).optional(),
      isActive: z.boolean().optional(),
    }),
    mutating: true,
    audit: "settings.reminder_rule.update",
    responses: [res.json(200, ReminderRule, "Updated reminder rule")],
    milestone: "m7",
  }),
  endpoint({
    id: "SET-05",
    operationId: "SET-05.delete",
    method: "delete",
    path: "/settings/reminder-rules/{id}",
    auth: "owner",
    permission: "messaging:manage",
    summary: "Delete a reminder rule",
    description:
      "Deleting a rule stops future enqueues; already-queued jobs are not retroactively cancelled (that is SET-08/MSG-04). Writes an audit row.",
    tags: ["Settings"],
    params: z.object({ id: Id }),
    mutating: true,
    audit: "settings.reminder_rule.delete",
    responses: [res.empty(204, "Deleted")],
    milestone: "m7",
  }),

  // --- SET-06 message templates -------------------------------------------
  endpoint({
    id: "SET-06",
    operationId: "SET-06.list",
    method: "get",
    path: "/settings/message-templates",
    auth: "owner",
    permission: "messaging:manage",
    summary: "List message templates",
    description: "Unpaginated small list; each entry carries the allowed `{{variables}}`.",
    tags: ["Settings"],
    responses: [res.json(200, MessageTemplateList, "Templates")],
    milestone: "m7",
  }),
  endpoint({
    id: "SET-06",
    operationId: "SET-06.update",
    method: "put",
    path: "/settings/message-templates/{key}",
    auth: "owner",
    permission: "messaging:manage",
    summary: "Replace a message template body",
    description:
      "Allowed variables: `{{guardianName}} {{playerName}} {{invoiceNumber}} {{amountDue}} {{dueDate}} {{invoiceLink}} {{academyName}}`. An unknown variable is a 422 (never silently stripped). The response echoes `preview` rendered with sample data; amounts are rendered at send time, not at save time. Writes an audit row.",
    tags: ["Settings"],
    params: z.object({ key: z.enum(["invoice_delivery", "reminder_pre_due", "reminder_overdue"]) }),
    body: z.strictObject({ body: z.string().min(1).max(2000) }),
    mutating: true,
    audit: "settings.message_template.update",
    responses: [res.json(200, MessageTemplate, "Template with rendered preview")],
    milestone: "m7",
  }),

  // --- SET-07 messaging configuration -------------------------------------
  endpoint({
    id: "SET-07",
    operationId: "SET-07.read",
    method: "get",
    path: "/settings/messaging",
    auth: "owner",
    permission: "messaging:manage",
    summary: "Read messaging settings",
    description:
      "The **master** pause/resume is MSG-07 and the per-automation switches are SET-08; this row is pacing, send window and delivery mode only.",
    tags: ["Settings"],
    responses: [res.json(200, MessagingSettings, "Messaging settings")],
    milestone: "m7",
  }),
  endpoint({
    id: "SET-07",
    operationId: "SET-07.update",
    method: "patch",
    path: "/settings/messaging",
    auth: "owner",
    permission: "messaging:manage",
    summary: "Update messaging settings",
    description:
      "`invoiceMode: 'attachment_and_link'` is rejected (422) until spike S1 has confirmed document sending on the deployed engine (OPENWA_INTEGRATION §4). Pacing values must satisfy min ≤ max. Writes an audit row.",
    tags: ["Settings"],
    body: MessagingSettingsPatch,
    mutating: true,
    audit: "settings.messaging.update",
    responses: [res.json(200, MessagingSettings, "Updated messaging settings")],
    milestone: "m7",
  }),

  // --- SET-08 per-automation switches (CR-003 / ADR-019) -------------------
  endpoint({
    id: "SET-08",
    operationId: "SET-08.read",
    method: "get",
    path: "/settings/automations",
    auth: "owner",
    permission: "messaging:manage",
    summary: "Read per-automation switches",
    description:
      "All four switches default to **false**. `masterPaused` is a read-only mirror of MSG-07 and is not settable here. CR-003 surfaces ship while ADR-019 is still *Proposed*.",
    tags: ["Settings"],
    responses: [res.json(200, AutomationsResponse, "Switches plus the master mirror")],
    milestone: "m7",
  }),
  endpoint({
    id: "SET-08",
    operationId: "SET-08.update",
    method: "patch",
    path: "/settings/automations",
    auth: "owner",
    permission: "messaging:manage",
    summary: "Toggle per-automation switches",
    description:
      "Takes effect immediately: switching a kind off stops new enqueues **and** cancels that kind's not-yet-sent jobs (`cancelled`, `skipReason='AUTOMATION_DISABLED'`); re-enabling never back-fills missed sends. `proofCheck` runs the deterministic L1/L2 bank-receipt checks on upload and can never confirm a payment (ADR-020/ADR-021) — an explicit re-check is PRF-04 and always allowed. Every toggle writes an audit row.",
    tags: ["Settings"],
    body: AutomationsPatch,
    mutating: true,
    audit: "settings.automations.update",
    responses: [res.json(200, AutomationsResponse, "Updated switches plus the master mirror")],
    milestone: "m7",
  }),
]);
