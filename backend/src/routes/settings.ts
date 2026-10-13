/**
 * SET-01 (academy profile) and SET-02 (billing configuration), both owner-only.
 *
 * These are the only two settings rows the M2 contract serves; SET-03..SET-08 belong to
 * M5/M6/M7. Two rules shape the code:
 *
 *  - **Partial updates are validated against the merged row, not the patch.** A change to
 *    `ageReferenceRule` or `dueRuleType` can only be judged together with the stored
 *    value (a `fixed_day_of_month` rule is legal or not depending on the frequency), so
 *    the row is read `FOR UPDATE`, merged in one place, and written as a whole. Holding
 *    the row also means two concurrent patches cannot interleave into a state neither
 *    asked for.
 *  - **A change never rewrites history.** Billing settings apply to invoices issued
 *    after now (ADR-014: issued invoices are immutable snapshots), which is what the
 *    `effectNote` on SET-02 states, and the reason this endpoint touches no invoice.
 *
 * Reads go through `asViewer`: `academy_settings` carries FORCE ROW LEVEL SECURITY and
 * only the owner policy can see it (a coach gets name/timezone/logo from `/auth/me`).
 */
import { createHash } from "node:crypto";
import { ApiError, errors } from "../errors.js";
import { mapPgError } from "../db/pg-errors.js";
import { uuidv7 } from "../ids.js";
import * as audit from "../audit.js";
import { asViewer } from "../http/context.js";
import type { Handler, HandlerResult } from "../http/router.js";
import { viewerAudit } from "./auth.js";
import { academyLogoUrl } from "./academy-brand.js";
import { writeStoredFile } from "../files/storage.js";
import { extensionFor, readUpload } from "../files/upload.js";

type AgeReferenceRule = "jan_1_of_year" | "fixed_month_day" | "today";
type DueRuleType = "days_after_issue" | "days_after_period_start" | "fixed_day_of_month";

interface SettingsRow {
  name: string;
  short_name: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  timezone: string;
  payment_instructions: string | null;
  beneficiary_accounts: { name: string; accountMasked: string }[];
  age_reference_rule: AgeReferenceRule;
  age_reference_month_day: string | null;
  allow_fractional_money: boolean;
  coach_can_see_guardian_phone: boolean;
  attendance_coach_edit_window_hours: number;
  coach_checkin_opens_minutes_before: number;
  coach_checkin_closes_minutes_after_end: number;
  invoice_link_ttl_days: number;
  billing_frequency: "weekly" | "monthly";
  billing_period_mode: "calendar" | "anchored";
  week_start_day: number;
  invoice_issue_timing: "period_start" | "period_end";
  due_rule_type: DueRuleType;
  due_rule_value: number;
}

/** Every column the two serializers read. Kept in one place so `select *` is not needed. */
const SETTINGS_SELECT = `select name, short_name, address, phone, email, timezone,
                                payment_instructions, beneficiary_accounts,
                                age_reference_rule, age_reference_month_day,
                                allow_fractional_money, coach_can_see_guardian_phone,
                                attendance_coach_edit_window_hours,
                                coach_checkin_opens_minutes_before,
                                coach_checkin_closes_minutes_after_end,
                                invoice_link_ttl_days,
                                billing_frequency, billing_period_mode, week_start_day,
                                invoice_issue_timing, due_rule_type, due_rule_value
                           from academy_settings
                          where id = 1`;

const EFFECT_NOTE = "Applies to invoices issued after now";

/**
 * `AcademySettings` (API_CONTRACTS §2). `paymentInstructions` is a required string in the
 * contract but a nullable column: an academy that has not filled it in gets `""` rather
 * than a missing field the frontend would have to guard (flagged in the M2 handoff).
 */
function serializeAcademy(row: SettingsRow) {
  return {
    name: row.name,
    ...(row.short_name ? { shortName: row.short_name } : {}),
    ...(row.address ? { address: row.address } : {}),
    ...(row.phone ? { phone: row.phone } : {}),
    ...(row.email ? { email: row.email } : {}),
    paymentInstructions: row.payment_instructions ?? "",
    beneficiaryAccounts: row.beneficiary_accounts,
    timezone: row.timezone,
    ageReferenceRule: row.age_reference_rule,
    ...(row.age_reference_month_day ? { ageReferenceMonthDay: row.age_reference_month_day } : {}),
    allowFractionalMoney: row.allow_fractional_money,
    coachCanSeeGuardianPhone: row.coach_can_see_guardian_phone,
    attendanceCoachEditWindowHours: row.attendance_coach_edit_window_hours,
    coachCheckinOpensMinutesBefore: row.coach_checkin_opens_minutes_before,
    coachCheckinClosesMinutesAfterEnd: row.coach_checkin_closes_minutes_after_end,
    invoiceLinkTtlDays: row.invoice_link_ttl_days,
  };
}

/** `BillingSettings` (API_CONTRACTS §2) plus the mandatory `effectNote`. */
function serializeBilling(row: SettingsRow) {
  return {
    billingFrequency: row.billing_frequency,
    billingPeriodMode: row.billing_period_mode,
    weekStartDay: row.week_start_day,
    invoiceIssueTiming: row.invoice_issue_timing,
    dueRuleType: row.due_rule_type,
    dueRuleValue: row.due_rule_value,
    effectNote: EFFECT_NOTE,
  };
}

export const set01Read: Handler = async ({ viewer }): Promise<HandlerResult> => {
  const row = await asViewer(viewer, async (client) => {
    const result = await client.query<SettingsRow>(SETTINGS_SELECT);
    return result.rows[0] ?? null;
  });
  if (!row) throw errors.notFound();
  return { status: 200, body: serializeAcademy(row) };
};

export const set02Read: Handler = async ({ viewer }): Promise<HandlerResult> => {
  const row = await asViewer(viewer, async (client) => {
    const result = await client.query<SettingsRow>(SETTINGS_SELECT);
    return result.rows[0] ?? null;
  });
  if (!row) throw errors.notFound();
  return { status: 200, body: serializeBilling(row) };
};

export const set01Update: Handler = async ({ ctx, viewer, body }): Promise<HandlerResult> => {
  const input = body as {
    name?: string;
    shortName?: string;
    address?: string;
    phone?: string;
    email?: string;
    paymentInstructions?: string;
    beneficiaryAccounts?: { name: string; accountMasked: string }[];
    timezone?: string;
    ageReferenceRule?: AgeReferenceRule;
    ageReferenceMonthDay?: string;
    allowFractionalMoney?: boolean;
    coachCanSeeGuardianPhone?: boolean;
    attendanceCoachEditWindowHours?: number;
    coachCheckinOpensMinutesBefore?: number;
    coachCheckinClosesMinutesAfterEnd?: number;
    invoiceLinkTtlDays?: number;
  };

  try {
    return await asViewer(viewer, async (client) => {
      const current = await client.query<SettingsRow>(`${SETTINGS_SELECT} for update`);
      const before = current.rows[0];
      if (!before) throw errors.notFound();

      // Merge, then judge the result: the rules below compare fields to each other.
      const next = {
        name: input.name ?? before.name,
        short_name: input.shortName !== undefined ? input.shortName : before.short_name,
        address: input.address !== undefined ? input.address : before.address,
        phone: input.phone !== undefined ? input.phone : before.phone,
        email: input.email !== undefined ? input.email : before.email,
        timezone: input.timezone ?? before.timezone,
        payment_instructions:
          input.paymentInstructions !== undefined
            ? input.paymentInstructions
            : before.payment_instructions,
        beneficiary_accounts: input.beneficiaryAccounts ?? before.beneficiary_accounts,
        age_reference_rule: input.ageReferenceRule ?? before.age_reference_rule,
        age_reference_month_day:
          input.ageReferenceMonthDay !== undefined
            ? input.ageReferenceMonthDay
            : before.age_reference_month_day,
        allow_fractional_money: input.allowFractionalMoney ?? before.allow_fractional_money,
        coach_can_see_guardian_phone:
          input.coachCanSeeGuardianPhone ?? before.coach_can_see_guardian_phone,
        attendance_coach_edit_window_hours:
          input.attendanceCoachEditWindowHours ?? before.attendance_coach_edit_window_hours,
        coach_checkin_opens_minutes_before:
          input.coachCheckinOpensMinutesBefore ?? before.coach_checkin_opens_minutes_before,
        coach_checkin_closes_minutes_after_end:
          input.coachCheckinClosesMinutesAfterEnd ?? before.coach_checkin_closes_minutes_after_end,
        invoice_link_ttl_days: input.invoiceLinkTtlDays ?? before.invoice_link_ttl_days,
      };

      if (next.age_reference_rule === "fixed_month_day") {
        if (!next.age_reference_month_day) {
          throw errors.validation([
            {
              field: "ageReferenceMonthDay",
              issue: "Give the fixed MM-DD date the age rule refers to.",
            },
          ]);
        }
      } else {
        // Otherwise the stored date would be a stale value nothing refers to any more.
        next.age_reference_month_day = null;
      }

      const updated = await client.query<SettingsRow>(
        `update academy_settings
            set name = $1, short_name = $2, address = $3, phone = $4, email = $5,
                timezone = $6, payment_instructions = $7, beneficiary_accounts = $8,
                age_reference_rule = $9, age_reference_month_day = $10,
                allow_fractional_money = $11, coach_can_see_guardian_phone = $12,
                attendance_coach_edit_window_hours = $13,
                coach_checkin_opens_minutes_before = $14,
                coach_checkin_closes_minutes_after_end = $15,
                invoice_link_ttl_days = $16,
                updated_by = $17, updated_at = now()
          where id = 1
        returning name, short_name, address, phone, email, timezone, payment_instructions,
                  beneficiary_accounts, age_reference_rule, age_reference_month_day,
                  allow_fractional_money, coach_can_see_guardian_phone,
                  attendance_coach_edit_window_hours, coach_checkin_opens_minutes_before,
                  coach_checkin_closes_minutes_after_end, invoice_link_ttl_days,
                  billing_frequency, billing_period_mode, week_start_day,
                  invoice_issue_timing, due_rule_type, due_rule_value`,
        [
          next.name,
          next.short_name,
          next.address,
          next.phone,
          next.email,
          next.timezone,
          next.payment_instructions,
          JSON.stringify(next.beneficiary_accounts),
          next.age_reference_rule,
          next.age_reference_month_day,
          next.allow_fractional_money,
          next.coach_can_see_guardian_phone,
          next.attendance_coach_edit_window_hours,
          next.coach_checkin_opens_minutes_before,
          next.coach_checkin_closes_minutes_after_end,
          next.invoice_link_ttl_days,
          viewer.userId,
        ],
      );

      const after = updated.rows[0]!;
      await audit.record(client, viewerAudit(viewer, ctx), {
        action: "settings.academy.update",
        entityType: "academy_settings",
        // `audit_logs.entity_id` is a uuid and the settings row is the single-row
        // `id = 1` (ADR-015), so the entity is named by `entity_type` and the before/after
        // pair carries the change itself.
        entityId: null,
        before: serializeAcademy(before),
        after: serializeAcademy(after),
      });
      return { status: 200, body: serializeAcademy(after) };
    });
  } catch (err) {
    // The table's own CHECK constraints (timezone shape, MM-DD pattern, non-negative
    // windows) are the last line; mapPgError turns them into a field-level 422.
    mapPgError(err);
  }
};

export const set02Update: Handler = async ({ ctx, viewer, body }): Promise<HandlerResult> => {
  const input = body as {
    billingFrequency?: "weekly" | "monthly";
    billingPeriodMode?: "calendar" | "anchored";
    weekStartDay?: number;
    invoiceIssueTiming?: "period_start" | "period_end";
    dueRuleType?: DueRuleType;
    dueRuleValue?: number;
  };

  try {
    return await asViewer(viewer, async (client) => {
      const current = await client.query<SettingsRow>(`${SETTINGS_SELECT} for update`);
      const before = current.rows[0];
      if (!before) throw errors.notFound();

      const next = {
        billing_frequency: input.billingFrequency ?? before.billing_frequency,
        billing_period_mode: input.billingPeriodMode ?? before.billing_period_mode,
        week_start_day: input.weekStartDay ?? before.week_start_day,
        invoice_issue_timing: input.invoiceIssueTiming ?? before.invoice_issue_timing,
        due_rule_type: input.dueRuleType ?? before.due_rule_type,
        due_rule_value: input.dueRuleValue ?? before.due_rule_value,
      };

      // Contract: `fixed_day_of_month` requires monthly frequency and a day in 1..28
      // (days 29-31 would silently skip months).
      if (next.due_rule_type === "fixed_day_of_month") {
        if (next.billing_frequency !== "monthly") {
          throw errors.validation([
            {
              field: "billingFrequency",
              issue: "A fixed day of the month needs monthly billing.",
            },
          ]);
        }
        if (next.due_rule_value < 1 || next.due_rule_value > 28) {
          throw errors.validation([
            { field: "dueRuleValue", issue: "Use a day between 1 and 28." },
          ]);
        }
      }

      const updated = await client.query<SettingsRow>(
        `update academy_settings
            set billing_frequency = $1, billing_period_mode = $2, week_start_day = $3,
                invoice_issue_timing = $4, due_rule_type = $5, due_rule_value = $6,
                updated_by = $7, updated_at = now()
          where id = 1
        returning name, short_name, address, phone, email, timezone, payment_instructions,
                  beneficiary_accounts, age_reference_rule, age_reference_month_day,
                  allow_fractional_money, coach_can_see_guardian_phone,
                  attendance_coach_edit_window_hours, coach_checkin_opens_minutes_before,
                  coach_checkin_closes_minutes_after_end, invoice_link_ttl_days,
                  billing_frequency, billing_period_mode, week_start_day,
                  invoice_issue_timing, due_rule_type, due_rule_value`,
        [
          next.billing_frequency,
          next.billing_period_mode,
          next.week_start_day,
          next.invoice_issue_timing,
          next.due_rule_type,
          next.due_rule_value,
          viewer.userId,
        ],
      );

      const after = updated.rows[0]!;
      // The audit row records the billing configuration before and after, which is what
      // makes an invoice issued later explainable.
      await audit.record(client, viewerAudit(viewer, ctx), {
        action: "settings.billing.update",
        entityType: "academy_settings",
        entityId: null,
        before: serializeBilling(before),
        after: serializeBilling(after),
      });
      return { status: 200, body: serializeBilling(after) };
    });
  } catch (err) {
    mapPgError(err);
  }
};

// ---------------------------------------------------------------------------
// SET-04 — payment methods (the small, owner-editable list the money surface reads)
// ---------------------------------------------------------------------------
/**
 * A payment method's `code` is the immutable identifier a payment references, so it is never
 * changed: a method is **deactivated**, not deleted (a delete would orphan the payments that
 * name it). The list is deliberately unpaginated and includes inactive methods, so a payment
 * recorded under one that has since been turned off still explains itself.
 */
interface PaymentMethodRow {
  code: string;
  label: string;
  requires_reference: boolean;
  is_active: boolean;
}

const PAYMENT_METHOD_SELECT = `select code, label, requires_reference, is_active
                                 from payment_methods`;

function serializePaymentMethod(row: PaymentMethodRow) {
  return {
    code: row.code,
    label: row.label,
    requiresReference: row.requires_reference,
    isActive: row.is_active,
  };
}

export const set04List: Handler = async ({ viewer }): Promise<HandlerResult> => {
  const rows = await asViewer(viewer, async (client) => {
    const result = await client.query<PaymentMethodRow>(
      `${PAYMENT_METHOD_SELECT} order by sort_order asc, code asc`,
    );
    return result.rows;
  });
  return { status: 200, body: { data: rows.map(serializePaymentMethod) } };
};

export const set04Create: Handler = async ({ ctx, viewer, body }): Promise<HandlerResult> => {
  const input = body as {
    code: string;
    label: string;
    requiresReference?: boolean;
    isActive?: boolean;
    sortOrder?: number;
  };

  try {
    return await asViewer(viewer, async (client) => {
      const inserted = await client.query<PaymentMethodRow>(
        `insert into payment_methods (code, label, requires_reference, is_active, sort_order)
         values ($1, $2, $3, $4, $5)
         returning code, label, requires_reference, is_active`,
        [
          input.code,
          input.label.trim(),
          input.requiresReference ?? false,
          input.isActive ?? true,
          input.sortOrder ?? 0,
        ],
      );
      const row = inserted.rows[0]!;
      await audit.record(client, viewerAudit(viewer, ctx), {
        action: "settings.payment_method.create",
        entityType: "payment_method",
        // The key is a text `code`, and `audit_logs.entity_id` is a uuid, so the entity is
        // named by `entity_type` and the row itself carries the code (the academy_settings
        // pattern).
        entityId: null,
        after: serializePaymentMethod(row),
      });
      return { status: 201, body: serializePaymentMethod(row) };
    });
  } catch (err) {
    // A duplicate `code` is a unique violation (23505) and maps to 422; a CHECK failure maps
    // to a field-level 422. Either way the code is never silently changed.
    mapPgError(err);
  }
};

export const set04Update: Handler = async ({ ctx, viewer, params, body }): Promise<HandlerResult> => {
  const { code } = params as { code: string };
  const input = body as {
    label?: string;
    requiresReference?: boolean;
    isActive?: boolean;
    sortOrder?: number;
  };

  try {
    return await asViewer(viewer, async (client) => {
      const before = await client.query<PaymentMethodRow>(
        `${PAYMENT_METHOD_SELECT} where code = $1`,
        [code],
      );
      if (!before.rows[0]) throw errors.notFound();

      const updated = await client.query<PaymentMethodRow>(
        `update payment_methods
            set label = coalesce($2, label),
                requires_reference = case when $3::boolean then $4 else requires_reference end,
                is_active = case when $5::boolean then $6 else is_active end,
                sort_order = coalesce($7, sort_order)
          where code = $1
        returning code, label, requires_reference, is_active`,
        [
          code,
          input.label === undefined ? null : input.label.trim(),
          input.requiresReference !== undefined,
          input.requiresReference ?? null,
          input.isActive !== undefined,
          input.isActive ?? null,
          input.sortOrder ?? null,
        ],
      );
      const row = updated.rows[0]!;
      await audit.record(client, viewerAudit(viewer, ctx), {
        action: "settings.payment_method.update",
        entityType: "payment_method",
        entityId: null,
        before: serializePaymentMethod(before.rows[0]!),
        after: serializePaymentMethod(row),
      });
      return { status: 200, body: serializePaymentMethod(row) };
    });
  } catch (err) {
    mapPgError(err);
  }
};

// ---------------------------------------------------------------------------
// SET-03 — the academy logo
// ---------------------------------------------------------------------------
/** ≤ 1 MB, and PNG/JPEG/SVG only (FILES_AND_PDF §1). */
const LOGO_MAX_BYTES = 1024 * 1024;

const LOGO_UPLOAD_RULE = {
  maxBytes: LOGO_MAX_BYTES,
  tooLargeMessage: "The logo must be 1 MB or smaller.",
  allowed: ["png", "jpeg", "svg"] as const,
};

/**
 * Stores the academy's logo and points the academy row at it.
 *
 * Three details are deliberate rather than incidental:
 *
 *  - **The previous logo file is not deleted.** Issued invoices reference a logo by
 *    `snapshot.academy.logoFileId`, so removing the old object would quietly break every
 *    document that already names it (FILES_AND_PDF §8, "the old logo file is never deleted
 *    while referenced"). It is superseded, not lost.
 *  - **The response names the API's own public read** (`academyLogoUrl`), because there is no
 *    bucket and no public origin to build a URL from (OPEN-016). `Me.academy.logoUrl` returns
 *    the same string, so a client has one URL to render in both places.
 *  - **The bytes go to storage before the rows are written**, so a logo that exists in the
 *    database always has an object behind it; the reverse failure is an orphan the sweeper
 *    collects (FILES_AND_PDF §8).
 */
export const set03UploadLogo: Handler = async ({ ctx, viewer, req }): Promise<HandlerResult> => {
  const { file } = await readUpload(req, LOGO_UPLOAD_RULE);

  const fileId = uuidv7();
  const storageKey = `branding/logo/${fileId}.${extensionFor(file.type)}`;
  const sha256 = createHash("sha256").update(file.bytes).digest("hex");

  try {
    return await asViewer(viewer, async (client): Promise<HandlerResult> => {
      // `for update` so two uploads cannot interleave into a state where the academy points at a
      // logo whose row has not been written yet.
      const current = await client.query<{ logo_file_id: string | null }>(
        `select logo_file_id from academy_settings where id = 1 for update`,
      );
      const before = current.rows[0];
      if (!before) throw errors.notFound();

      if (!(await writeStoredFile(storageKey, file.bytes))) {
        throw new ApiError(
          "DEPENDENCY_UNAVAILABLE",
          "File storage is unavailable, so the logo could not be stored.",
        );
      }

      await client.query(
        `insert into files
           (id, kind, storage_key, mime_type, size_bytes, sha256, original_name, uploaded_by)
         values ($1, 'logo', $2, $3, $4, $5, $6, $7)`,
        [
          fileId,
          storageKey,
          file.mimeType,
          file.bytes.byteLength,
          sha256,
          file.originalName,
          viewer.userId,
        ],
      );
      await client.query(
        `update academy_settings
            set logo_file_id = $1, updated_by = $2, updated_at = now()
          where id = 1`,
        [fileId, viewer.userId],
      );

      await audit.record(client, viewerAudit(viewer, ctx), {
        action: "settings.logo.upload",
        entityType: "file",
        entityId: fileId,
        before: { logoFileId: before.logo_file_id },
        after: {
          logoFileId: fileId,
          mimeType: file.mimeType,
          sizeBytes: file.bytes.byteLength,
          sha256,
          originalName: file.originalName,
        },
      });

      return { status: 200, body: { logoUrl: academyLogoUrl() } };
    });
  } catch (err) {
    mapPgError(err);
  }
};
