"use client";

// Settings — SET-01 academy, SET-02 billing, SET-04 payment methods and
// SET-03 branding (PAGE_SPECIFICATIONS §11).
//
// Rules this screen must not soften:
// · every save is a real PATCH and nothing reads "saved" until the API answered;
// · the billing save says exactly "Applies to invoices issued after now.
//   Existing invoices won't change." — a fee/setting change is never back-dated
//   onto invoices that already exist;
// · a payment method is deactivated, never deleted, and its code is immutable
//   (the code is what a payment's reference and reports hang off);
// · branding shows the academy's real logo or the plain words "Using text
//   header" — the mock has no logo asset and none is invented.
import { Suspense, useEffect, useState } from "react";
import Image from "next/image";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Banknote, CheckCircle2, Image as ImageIcon, Plus, Upload } from "lucide-react";
import {
  ApiError,
  set01GetAcademySettings,
  set01PatchAcademySettings,
  set02GetBillingSettings,
  set02PatchBillingSettings,
  set03UploadLogo,
  set04CreatePaymentMethod,
  set04ListPaymentMethods,
  set04PatchPaymentMethod,
} from "@/api/client";
import type { AcademySettings, BillingSettings, PaymentMethod } from "@/api/types";
import { RequireAuth, RequirePermissions } from "@/components/Guards";
import { PageHeader } from "@/components/PageHeader";
import { StatusChip } from "@/components/StatusChip";
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  InlineAlert,
  ListSkeleton,
  Modal,
  SectionTitle,
  SelectField,
  TextAreaField,
  TextField,
  Toast,
  Toggle,
} from "@/components/ui";
import { useAuth } from "@/lib/auth";
import { formatInstant } from "@/lib/dates";

const TABS = [
  { key: "academy", label: "Academy" },
  { key: "billing", label: "Billing" },
  { key: "payment-methods", label: "Payment methods" },
  { key: "branding", label: "Branding" },
];

const BILLING_SAVE_NOTE = "Applies to invoices issued after now. Existing invoices won't change.";

const TIMEZONES = [
  "Asia/Colombo",
  "Asia/Kolkata",
  "Asia/Dubai",
  "Asia/Singapore",
  "UTC",
];

const MAX_LOGO_BYTES = 1024 * 1024;
const LOGO_TYPES = ["image/png", "image/jpeg", "image/svg+xml"];

export default function SettingsPage() {
  return (
    <RequireAuth>
      <RequirePermissions path="/settings">
        <Suspense fallback={<ListSkeleton rows={6} />}>
          <Settings />
        </Suspense>
      </RequirePermissions>
    </RequireAuth>
  );
}

function Settings() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const requested = searchParams.get("tab") ?? "academy";
  const tab = TABS.some((t) => t.key === requested) ? requested : "academy";

  function selectTab(next: string) {
    // The URL is the source of truth for the open tab, so a link into Settings
    // (or a reload) lands on the same section.
    const params = new URLSearchParams(searchParams.toString());
    if (next === "academy") params.delete("tab");
    else params.set("tab", next);
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }

  return (
    <div>
      <PageHeader
        title="Settings"
        sub="Academy details, billing rules, how families can pay, and the academy's logo."
      />

      <div role="tablist" aria-label="Settings sections" className="flex gap-1 overflow-x-auto border-b border-slate-200">
        {TABS.map((item) => {
          const selected = item.key === tab;
          return (
            <button
              key={item.key}
              id={`settings-tab-${item.key}`}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={`settings-panel-${item.key}`}
              onClick={() => selectTab(item.key)}
              className={`touch44 -mb-px shrink-0 cursor-pointer border-b-2 px-3 py-2 text-[14px] font-semibold ${
                selected ? "border-pitch-600 text-pitch-700" : "border-transparent text-slate-600 hover:text-slate-900"
              }`}
            >
              {item.label}
            </button>
          );
        })}
      </div>

      <div
        id={`settings-panel-${tab}`}
        role="tabpanel"
        aria-labelledby={`settings-tab-${tab}`}
        tabIndex={0}
        className="pt-5"
      >
        {tab === "academy" ? <AcademyTab /> : null}
        {tab === "billing" ? <BillingTab /> : null}
        {tab === "payment-methods" ? <PaymentMethodsTab /> : null}
        {tab === "branding" ? <BrandingTab /> : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Academy (SET-01)
// ---------------------------------------------------------------------------

type AcademyDraft = Omit<AcademySettings, "beneficiaryAccounts">;
type BillingDraft = Omit<BillingSettings, "effectNote">;

function AcademyTab() {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["settings", "academy"], queryFn: set01GetAcademySettings });
  // The loaded settings are the base and `edits` holds only what the owner
  // changed, so nothing is copied into state from an effect: copying there would
  // cascade a render on every refetch (react-hooks/set-state-in-effect) and would
  // also throw away an in-progress edit behind a background refetch.
  const [edits, setEdits] = useState<Partial<AcademyDraft> | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [toast, setToast] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (next: AcademyDraft) => set01PatchAcademySettings(next),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["settings", "academy"] });
      // Drop the edits only once the refetch has landed, so the form shows the
      // server's own values rather than a stale copy of them.
      setEdits(null);
      setToast("Academy settings saved.");
    },
    onError: (error) => {
      if (error instanceof ApiError) setErrors(error.fieldErrors());
    },
  });

  if (query.isLoading) return <Card><ListSkeleton rows={6} /></Card>;
  if (query.error) return <Card><ErrorState error={query.error} onRetry={() => query.refetch()} /></Card>;

  const workspace = query.data;
  const base: AcademyDraft | null = workspace ? stripBeneficiaries(workspace) : null;
  const draft: AcademyDraft | null = base ? { ...base, ...(edits ?? {}) } : null;
  if (!draft) return <Card><ListSkeleton rows={3} /></Card>;

  const invalid =
    draft.academyName.trim().length < 2 ||
    (draft.ageReferenceRule === "fixed_date" && !/^\d{2}-\d{2}$/.test(draft.ageReferenceMonthDay ?? ""));

  // A merge of a Partial draft — never a computed-key spread, so the state stays
  // typed without a cast.
  function patch(next: Partial<AcademyDraft>) {
    setEdits((current) => ({ ...(current ?? {}), ...next }));
  }

  return (
    <div className="space-y-5">
      {toast ? <Toast message={toast} onDismiss={() => setToast(null)} /> : null}

      <Card>
        <SectionTitle>Academy details</SectionTitle>
        <div className="grid gap-4 p-4 sm:grid-cols-2">
          <TextField
            id="academy-name"
            label="Academy name"
            required
            value={draft.academyName}
            error={errors.academyName}
            onChange={(e) => patch({ academyName: e.target.value })}
          />
          <TextField
            id="academy-phone"
            label="Phone"
            value={draft.phone ?? ""}
            error={errors.phone}
            onChange={(e) => patch({ phone: e.target.value })}
          />
          <TextField
            id="academy-email"
            label="Email"
            type="email"
            hint="Appears on invoices and receipts."
            value={draft.email ?? ""}
            error={errors.email}
            onChange={(e) => patch({ email: e.target.value })}
          />
          <TextField
            id="academy-address"
            label="Address"
            value={draft.address ?? ""}
            error={errors.address}
            onChange={(e) => patch({ address: e.target.value })}
          />
        </div>
      </Card>

      <Card>
        <SectionTitle>Payment instructions</SectionTitle>
        <div className="grid gap-4 p-4 lg:grid-cols-2">
          <TextAreaField
            id="academy-payment-instructions"
            label="Shown to families on invoices and PDFs"
            rows={6}
            value={draft.paymentInstructions}
            error={errors.paymentInstructions}
            onChange={(e) => patch({ paymentInstructions: e.target.value })}
          />
          <div>
            <p className="mb-1 text-[14px] font-semibold text-slate-800">Preview on a PDF</p>
            <div className="rounded-xl border border-slate-300 bg-slate-50 p-4 text-[13px] text-slate-700">
              <p className="font-heading text-[15px] font-bold text-navy-900">
                {draft.academyName || "Academy name"}
              </p>
              <p className="text-[12px] text-slate-500">
                Invoice INV-2026-0001 · {draft.phone || "phone"} · {draft.email || "email"}
              </p>
              <p className="mt-3 whitespace-pre-wrap">
                {draft.paymentInstructions || "Payment instructions appear here."}
              </p>
            </div>
            <p className="mt-2 text-[13px] text-slate-600">
              This is a mock preview of the PDF footer — the real PDF is rendered by the backend.
            </p>
          </div>
        </div>
      </Card>

      <Card>
        <SectionTitle>Age rule</SectionTitle>
        <div className="space-y-4 p-4">
          <SelectField
            id="academy-age-rule"
            label="A player's age is measured"
            value={draft.ageReferenceRule}
            error={errors.ageReferenceRule}
            onChange={(e) => patch({ ageReferenceRule: e.target.value as AcademyDraft["ageReferenceRule"] })}
          >
            <option value="jan_1">On 1 January each year</option>
            <option value="fixed_date">On a fixed date each year</option>
            <option value="today">On today&apos;s date</option>
          </SelectField>

          {draft.ageReferenceRule === "fixed_date" ? (
            <TextField
              id="academy-age-rule-date"
              label="Fixed date (MM-DD)"
              placeholder="09-01"
              value={draft.ageReferenceMonthDay ?? ""}
              error={errors.ageReferenceMonthDay}
              onChange={(e) => patch({ ageReferenceMonthDay: e.target.value })}
            />
          ) : null}

          <InlineAlert tone="info" title="What this changes">
            {draft.ageReferenceRule === "jan_1" ? (
              <>
                Every player&apos;s age is taken on 1 January of the current year, so a whole group
                moves up together once a year. Example: a player born 2015-03-14 is{" "}
                <strong>11</strong> for the whole of 2026, and the Under-12 suggestion uses that age.
              </>
            ) : draft.ageReferenceRule === "fixed_date" ? (
              <>
                Ages are taken on {(draft.ageReferenceMonthDay || "MM-DD").replace("-", "/")} each
                year. Example: with 09-01, a player born 2015-03-14 turns <strong>11</strong> on that
                date and keeps it until the next one.
              </>
            ) : (
              <>
                Ages are taken from today&apos;s date, so a player&apos;s age changes on their
                birthday. Age-group suggestions will move mid-year.
              </>
            )}
          </InlineAlert>
        </div>
      </Card>

      <Card>
        <SectionTitle>Visibility and windows</SectionTitle>
        <div className="space-y-5 p-4">
          <Toggle
            id="academy-coach-phone"
            label="Coaches can see guardian phone numbers"
            hint="Turn this off and a coach only sees the guardian's name on the roster. Owners always see the number."
            checked={draft.coachCanSeeGuardianPhone}
            onChange={(next) => patch({ coachCanSeeGuardianPhone: next })}
          />
          <div className="grid gap-4 sm:grid-cols-3">
            <TextField
              id="academy-attendance-window"
              label="Attendance edit window (hours)"
              type="number"
              min={0}
              value={String(draft.attendanceCoachEditWindowHours)}
              error={errors.attendanceCoachEditWindowHours}
              onChange={(e) => patch({ attendanceCoachEditWindowHours: Number(e.target.value) })}
              hint="After this, a coach's sheet is read-only."
            />
            <TextField
              id="academy-checkin-opens"
              label="Check-in opens (minutes before)"
              type="number"
              min={0}
              value={String(draft.coachCheckinOpensMinutesBefore)}
              error={errors.coachCheckinOpensMinutesBefore}
              onChange={(e) => patch({ coachCheckinOpensMinutesBefore: Number(e.target.value) })}
            />
            <TextField
              id="academy-checkin-closes"
              label="Check-in closes (minutes after end)"
              type="number"
              min={0}
              value={String(draft.coachCheckinClosesMinutesAfterEnd)}
              error={errors.coachCheckinClosesMinutesAfterEnd}
              onChange={(e) => patch({ coachCheckinClosesMinutesAfterEnd: Number(e.target.value) })}
            />
          </div>
        </div>
      </Card>

      <Card>
        <SectionTitle>Region and links</SectionTitle>
        <div className="grid gap-4 p-4 sm:grid-cols-2">
          <SelectField
            id="academy-timezone"
            label="Timezone"
            hint="All dates and times in the app are shown in this timezone."
            value={draft.timezone}
            error={errors.timezone}
            onChange={(e) => patch({ timezone: e.target.value })}
          >
            {TIMEZONES.map((tz) => (
              <option key={tz} value={tz}>
                {tz}
              </option>
            ))}
          </SelectField>
          <TextField
            id="academy-link-ttl"
            label="Invoice link validity (days)"
            type="number"
            min={1}
            value={String(draft.invoiceLinkTtlDays)}
            error={errors.invoiceLinkTtlDays}
            onChange={(e) => patch({ invoiceLinkTtlDays: Number(e.target.value) })}
          />
        </div>
      </Card>

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-[13px] text-slate-600">
          {query.dataUpdatedAt
            ? `Loaded ${formatInstant(new Date(query.dataUpdatedAt).toISOString())}`
            : null}
        </p>
        <div className="flex gap-2">
          <Button
            variant="secondary"
            onClick={() => {
              // Falling back to the server's own values *is* the discard.
              setEdits(null);
              setErrors({});
            }}
            disabled={save.isPending}
          >
            Discard changes
          </Button>
          <Button
            pending={save.isPending}
            disabled={invalid}
            onClick={() => {
              setErrors({});
              save.mutate(draft);
            }}
          >
            Save academy settings
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * Drop one key without binding a throwaway variable — the destructure-and-ignore
 * idiom trips `no-unused-vars` here. Neither dropped field may travel in a PATCH
 * body: the accounts a receipt is matched against are read-only in v1, and
 * `effectNote` is the server's own wording about the change.
 */
function omitKey<T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> {
  const copy: Partial<T> = { ...value };
  delete copy[key];
  return copy as Omit<T, K>;
}

function stripBeneficiaries(settings: AcademySettings): AcademyDraft {
  return omitKey(settings, "beneficiaryAccounts");
}

function stripEffectNote(settings: BillingSettings): BillingDraft {
  return omitKey(settings, "effectNote");
}

// ---------------------------------------------------------------------------
// Billing (SET-02)
// ---------------------------------------------------------------------------

function BillingTab() {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["settings", "billing"], queryFn: set02GetBillingSettings });
  // Same shape as the academy tab: server values are the base, `edits` are the
  // owner's own changes, and no render is triggered from an effect.
  const [edits, setEdits] = useState<Partial<BillingDraft> | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (next: Omit<BillingSettings, "effectNote">) => set02PatchBillingSettings(next),
    onSuccess: async () => {
      setConfirmOpen(false);
      await queryClient.invalidateQueries({ queryKey: ["settings", "billing"] });
      setEdits(null);
      setToast(`Billing settings saved. ${BILLING_SAVE_NOTE}`);
    },
    onError: (error) => {
      setConfirmOpen(false);
      if (error instanceof ApiError) setErrors(error.fieldErrors());
    },
  });

  if (query.isLoading) return <Card><ListSkeleton rows={5} /></Card>;
  if (query.error) return <Card><ErrorState error={query.error} onRetry={() => query.refetch()} /></Card>;

  const base: BillingDraft | null = query.data ? stripEffectNote(query.data) : null;
  const draft: BillingDraft | null = base ? { ...base, ...(edits ?? {}) } : null;
  if (!draft) return <Card><ListSkeleton rows={3} /></Card>;

  function patch(next: Partial<BillingDraft>) {
    setEdits((current) => ({ ...(current ?? {}), ...next }));
  }

  const monthly = draft.billingFrequency === "monthly";

  return (
    <div className="space-y-5">
      {toast ? <Toast message={toast} onDismiss={() => setToast(null)} /> : null}

      <InlineAlert tone="info" title="Rules apply to new invoices only">
        {BILLING_SAVE_NOTE}
      </InlineAlert>

      <Card>
        <SectionTitle>Frequency and period</SectionTitle>
        <div className="grid gap-4 p-4 sm:grid-cols-2">
          <SelectField
            id="billing-frequency"
            label="How often invoices are issued"
            value={draft.billingFrequency}
            error={errors.billingFrequency}
            onChange={(e) => patch({ billingFrequency: e.target.value as BillingSettings["billingFrequency"] })}
          >
            <option value="monthly">Monthly</option>
            <option value="weekly">Weekly</option>
          </SelectField>

          <SelectField
            id="billing-mode"
            label="How the period is worked out"
            value={draft.billingPeriodMode}
            error={errors.billingPeriodMode}
            onChange={(e) => patch({ billingPeriodMode: e.target.value as BillingSettings["billingPeriodMode"] })}
          >
            <option value="calendar">Calendar — the 1st to the last day</option>
            <option value="anchored">Anchored — a month from each player&apos;s own date</option>
          </SelectField>
        </div>
        <div className="border-t border-slate-100 px-4 py-3 text-[13px] text-slate-600">
          {draft.billingPeriodMode === "calendar" ? (
            <p>
              <strong>Calendar:</strong> every {monthly ? "month" : "week"} covers the same dates for
              everyone, so all invoices for a period line up on the same day.
            </p>
          ) : (
            <p>
              <strong>Anchored:</strong> each player&apos;s period starts on their own anchor date
              (usually their registration date), so invoices are spread across the{" "}
              {monthly ? "month" : "week"}. Example: a player registered on the 10th is billed the
              10th to the 9th.
            </p>
          )}
        </div>

        {!monthly ? (
          <div className="border-t border-slate-100 p-4">
            <SelectField
              id="billing-week-start"
              label="Week starts on"
              value={String(draft.weekStartDay)}
              error={errors.weekStartDay}
              onChange={(e) => patch({ weekStartDay: Number(e.target.value) })}
            >
              {["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map(
                (day, index) => (
                  <option key={day} value={index}>
                    {day}
                  </option>
                )
              )}
            </SelectField>
          </div>
        ) : null}
      </Card>

      <Card>
        <SectionTitle>Due date and issue timing</SectionTitle>
        <div className="grid gap-4 p-4 sm:grid-cols-3">
          <SelectField
            id="billing-due-rule"
            label="Due date is"
            value={draft.dueRuleType}
            error={errors.dueRuleType}
            onChange={(e) => patch({ dueRuleType: e.target.value as BillingSettings["dueRuleType"] })}
          >
            <option value="days_after_issue">Days after the issue date</option>
            <option value="days_after_period_start">Days after the period starts</option>
            <option value="fixed_day_of_month">A fixed day of the month</option>
          </SelectField>
          <TextField
            id="billing-due-value"
            label={
              draft.dueRuleType === "fixed_day_of_month" ? "Day of month" : "Number of days"
            }
            type="number"
            min={1}
            value={String(draft.dueRuleValue)}
            error={errors.dueRuleValue}
            onChange={(e) => patch({ dueRuleValue: Number(e.target.value) })}
          />
          <SelectField
            id="billing-issue-timing"
            label="Invoice is issued"
            value={draft.invoiceIssueTiming}
            error={errors.invoiceIssueTiming}
            onChange={(e) =>
              patch({ invoiceIssueTiming: e.target.value as BillingSettings["invoiceIssueTiming"] })
            }
          >
            <option value="period_start">At the start of the period</option>
            <option value="period_end">At the end of the period</option>
          </SelectField>
        </div>
        <div className="border-t border-slate-100 px-4 py-3 text-[13px] text-slate-600">
          {draft.dueRuleType === "days_after_issue" ? (
            <p>Example: issued on the 1st with {draft.dueRuleValue} days → due on the{" "}
              {Math.min(1 + draft.dueRuleValue, 28)}th.</p>
          ) : draft.dueRuleType === "days_after_period_start" ? (
            <p>Example: the period starts on the 1st, so the due date is{" "}
              {draft.dueRuleValue} days later.</p>
          ) : (
            <p>Every invoice in a period falls due on day {draft.dueRuleValue} of the following month.</p>
          )}
        </div>
      </Card>

      <Card>
        <SectionTitle>Whole rupees</SectionTitle>
        <div className="p-4">
          <Toggle
            id="billing-fractional"
            label="Allow amounts with cents"
            hint="Off: every fee and payment is a whole LKR amount. This matches the academy's practice."
            checked={draft.allowFractionalMoney}
            onChange={(next) => patch({ allowFractionalMoney: next })}
          />
        </div>
      </Card>

      <div className="flex justify-end">
        <Button onClick={() => setConfirmOpen(true)} disabled={save.isPending}>
          Save billing settings
        </Button>
      </div>

      <Modal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title="Save billing settings?"
        description={BILLING_SAVE_NOTE}
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button pending={save.isPending} onClick={() => save.mutate(draft)}>
              Save settings
            </Button>
          </>
        }
      >
        <p className="text-[14px] text-slate-700">
          Invoices that already exist keep the fees and dates they were issued with. The new rules
          are used the next time an invoice is created.
        </p>
      </Modal>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Payment methods (SET-04)
// ---------------------------------------------------------------------------

function PaymentMethodsTab() {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["settings", "payment-methods"], queryFn: set04ListPaymentMethods });
  const [code, setCode] = useState("");
  const [label, setLabel] = useState("");
  const [requiresReference, setRequiresReference] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [toast, setToast] = useState<string | null>(null);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["settings", "payment-methods"] });

  const create = useMutation({
    mutationFn: () => set04CreatePaymentMethod({ code, label, requiresReference }),
    onSuccess: async () => {
      await invalidate();
      setCode("");
      setLabel("");
      setRequiresReference(false);
      setErrors({});
      setToast("Payment method added.");
    },
    onError: (error) => {
      if (error instanceof ApiError) setErrors(error.fieldErrors());
    },
  });

  const patch = useMutation({
    mutationFn: (input: { code: string; patch: { label?: string; requiresReference?: boolean; isActive?: boolean } }) =>
      set04PatchPaymentMethod(input.code, input.patch),
    onSuccess: async (_method, input) => {
      await invalidate();
      setToast(input.patch.isActive === false ? "Payment method deactivated." : "Payment method updated.");
    },
    onError: (error) => {
      if (error instanceof ApiError) setErrors(error.fieldErrors());
    },
  });

  const methods: PaymentMethod[] = query.data?.data ?? [];
  const codeLooksValid = /^[a-z][a-z0-9_]{2,31}$/.test(code);

  return (
    <div className="space-y-5">
      {toast ? <Toast message={toast} onDismiss={() => setToast(null)} /> : null}

      {patch.error instanceof ApiError && Object.keys(errors).length === 0 ? (
        <InlineAlert tone="danger" title="That change was refused">
          {patch.error.message}
        </InlineAlert>
      ) : null}

      <Card>
        <SectionTitle
          right={
            <span className="text-[13px] text-slate-600">
              {methods.filter((m) => m.isActive).length} active
            </span>
          }
        >
          Methods families can use
        </SectionTitle>
        {query.isLoading ? (
          <ListSkeleton rows={3} />
        ) : query.error ? (
          <ErrorState error={query.error} onRetry={() => query.refetch()} />
        ) : methods.length === 0 ? (
          <EmptyState
            title="No payment methods yet"
            description="Add the ways families actually pay — cash, bank transfer — so payments can be recorded against them."
          />
        ) : (
          <ul className="divide-y divide-slate-100">
            {methods.map((method) => (
              <li key={method.code} className="grid gap-3 p-4 sm:grid-cols-[1fr_auto] sm:items-center">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-slate-900">{method.label}</span>
                    <StatusChip status={method.isActive ? "Active" : "Inactive"} />
                  </div>
                  <p className="mt-1 text-[13px] text-slate-600">
                    Code <span className="font-mono">{method.code}</span> — codes can never be
                    changed once a payment uses them.
                  </p>
                  <p className="mt-1 text-[13px] text-slate-600">
                    {method.requiresReference
                      ? "A reference (slip or receipt number) is required."
                      : "No reference required."}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={patch.isPending}
                    onClick={() =>
                      patch.mutate({
                        code: method.code,
                        patch: { requiresReference: !method.requiresReference },
                      })
                    }
                  >
                    {method.requiresReference ? "Don't require a reference" : "Require a reference"}
                  </Button>
                  <Button
                    size="sm"
                    variant={method.isActive ? "secondary" : "primary"}
                    disabled={patch.isPending}
                    onClick={() =>
                      patch.mutate({ code: method.code, patch: { isActive: !method.isActive } })
                    }
                  >
                    {method.isActive ? "Deactivate" : "Reactivate"}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
        <div className="border-t border-slate-100 px-4 py-3 text-[13px] text-slate-600">
          A method is deactivated, never deleted — old payments keep pointing at it.
        </div>
      </Card>

      <Card>
        <SectionTitle>Add a payment method</SectionTitle>
        <div className="grid gap-4 p-4 sm:grid-cols-2">
          <TextField
            id="method-code"
            label="Code"
            required
            placeholder="bank_transfer"
            hint="Lowercase letters, numbers and underscores. Cannot be changed later."
            value={code}
            error={errors.code}
            onChange={(e) => setCode(e.target.value)}
          />
          <TextField
            id="method-label"
            label="Label"
            required
            placeholder="Bank transfer"
            hint="The name families and staff see."
            value={label}
            error={errors.label}
            onChange={(e) => setLabel(e.target.value)}
          />
          <div className="sm:col-span-2">
            <Toggle
              id="method-reference"
              label="A reference is required"
              hint="Tick this for bank transfers — the slip number is what the proof is checked against."
              checked={requiresReference}
              onChange={setRequiresReference}
            />
          </div>
        </div>
        <div className="flex justify-end border-t border-slate-100 p-4">
          <Button
            pending={create.isPending}
            disabled={!codeLooksValid || label.trim().length < 2}
            onClick={() => create.mutate()}
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            Add method
          </Button>
        </div>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Branding (SET-03)
// ---------------------------------------------------------------------------

function BrandingTab() {
  const queryClient = useQueryClient();
  const { me } = useAuth();
  // SET-01 is read here too (rather than reaching into another tab's cache) so a
  // direct link to ?tab=branding still shows the academy name and its accounts.
  const academyQuery = useQuery({ queryKey: ["settings", "academy"], queryFn: set01GetAcademySettings });
  // Only the *uploaded* url is local state; the academy's own logo is read
  // straight from the auth context, so nothing is copied into state by an effect
  // and an upload can still override it until the next AUTH-03 refetch.
  const [uploadedLogoUrl, setUploadedLogoUrl] = useState<string | undefined>(undefined);
  const [file, setFile] = useState<File | null>(null);
  const [localPreview, setLocalPreview] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const academyName = academyQuery.data?.academyName ?? me?.academy.name ?? "Inspire Academy";

  // The picked file is previewed from the browser's own object URL, so the owner
  // sees their real file before anything is uploaded. The url is created where
  // the file is picked — not in an effect — and this effect only revokes the url
  // it is replacing (or the last one on unmount), so it never calls setState.
  useEffect(() => {
    if (!localPreview) return;
    return () => URL.revokeObjectURL(localPreview);
  }, [localPreview]);

  const logoUrl = uploadedLogoUrl ?? me?.academy.logoUrl;

  const upload = useMutation({
    mutationFn: (picked: File) => set03UploadLogo(picked),
    onSuccess: async (result) => {
      setUploadedLogoUrl(result.logoUrl);
      setFile(null);
      setLocalPreview(null);
      await queryClient.invalidateQueries({ queryKey: ["settings", "academy"] });
      setToast("Logo uploaded.");
    },
  });

  function pick(picked: File | null) {
    setLocalError(null);
    upload.reset();
    if (!picked) {
      setFile(null);
      setLocalPreview(null);
      return;
    }
    if (!LOGO_TYPES.includes(picked.type)) {
      setFile(null);
      setLocalPreview(null);
      setLocalError("Use a PNG, JPEG or SVG file.");
      return;
    }
    if (picked.size > MAX_LOGO_BYTES) {
      setFile(null);
      setLocalPreview(null);
      setLocalError("The file is larger than 1 MB. Please use a smaller one.");
      return;
    }
    setFile(picked);
    setLocalPreview(URL.createObjectURL(picked));
  }

  const error = upload.error instanceof ApiError ? upload.error.message : null;
  const previewSrc = localPreview ?? logoUrl;

  return (
    <div className="space-y-5">
      {toast ? <Toast message={toast} onDismiss={() => setToast(null)} /> : null}

      <Card>
        <SectionTitle>Sample invoice header</SectionTitle>
        <div className="p-4">
          <div className="rounded-xl border border-slate-300 bg-slate-50 p-4">
            <div className="flex items-center gap-3">
              {previewSrc ? (
                <Image
                  src={previewSrc}
                  alt={`${academyName} logo`}
                  width={160}
                  height={48}
                  unoptimized
                  className="h-12 w-auto"
                />
              ) : (
                <div className="flex h-12 items-center">
                  <span className="font-heading text-[19px] font-bold text-navy-900">{academyName}</span>
                </div>
              )}
              <div className="ml-auto text-right text-[12px] text-slate-500">
                <p>Invoice INV-2026-0001</p>
                <p>Issued 2026-11-01</p>
              </div>
            </div>
          </div>
          <p className="mt-2 text-[13px] text-slate-600">
            {localPreview
              ? "Preview of the file you picked — not uploaded yet."
              : logoUrl
                ? "This logo appears above the academy name on PDFs."
                : "Using text header"}
          </p>
        </div>
      </Card>

      <Card>
        <SectionTitle>Upload a logo</SectionTitle>
        <div className="space-y-3 p-4">
          <div>
            <label htmlFor="branding-logo" className="mb-1 block text-[14px] font-semibold text-slate-800">
              Logo file
            </label>
            <input
              id="branding-logo"
              type="file"
              accept="image/png,image/jpeg,image/svg+xml"
              onChange={(e) => pick(e.target.files?.[0] ?? null)}
              className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-[15px]"
            />
            {localError ? (
              <p className="mt-1 text-[13px] font-medium text-red-700">{localError}</p>
            ) : file ? (
              <p className="mt-1 flex items-center gap-2 text-[13px] text-slate-700">
                <ImageIcon className="h-4 w-4" aria-hidden="true" />
                {file.name} · {(file.size / 1024).toFixed(0)} KB
              </p>
            ) : (
              <p className="mt-1 text-[13px] text-slate-600">PNG, JPEG or SVG · up to 1 MB.</p>
            )}
          </div>

          {error ? (
            <InlineAlert tone="danger" title="The upload failed">
              {error}
            </InlineAlert>
          ) : null}

          <InlineAlert tone="info" title="No logo? Nothing is invented">
            There is no placeholder logo in the app. Until a file is uploaded, invoices print the
            academy name as plain text — which is exactly what families see now.
          </InlineAlert>

          <div className="flex justify-end">
            <Button
              pending={upload.isPending}
              disabled={!file}
              onClick={() => {
                if (file) upload.mutate(file);
              }}
            >
              <Upload className="h-4 w-4" aria-hidden="true" />
              Upload logo
            </Button>
          </div>
        </div>
      </Card>

      <Card>
        <SectionTitle>Academy accounts on receipts</SectionTitle>
        <div className="p-4">
          <p className="text-[13px] text-slate-600">
            A bank receipt&apos;s beneficiary is checked against these accounts when a proof is
            checked. They are read-only here; changing them needs the account details confirmed by
            the academy.
          </p>
          {academyQuery.isLoading ? (
            <div className="mt-3">
              <ListSkeleton rows={1} />
            </div>
          ) : academyQuery.error ? (
            <div className="mt-3">
              <ErrorState error={academyQuery.error} onRetry={() => academyQuery.refetch()} />
            </div>
          ) : (
            <ul className="mt-3 space-y-2">
              {(academyQuery.data?.beneficiaryAccounts ?? []).map((account) => (
                <li
                  key={account.accountMasked}
                  className="flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-[14px]"
                >
                  <Banknote className="h-4 w-4 text-slate-500" aria-hidden="true" />
                  <span className="font-semibold">{account.name}</span>
                  <span className="ml-auto font-mono text-slate-600">{account.accountMasked}</span>
                </li>
              ))}
              {(academyQuery.data?.beneficiaryAccounts ?? []).length === 0 ? (
                <li className="text-[13px] text-slate-600">No accounts recorded.</li>
              ) : null}
            </ul>
          )}
        </div>
      </Card>

      <div className="flex items-center gap-2 text-[13px] text-slate-600">
        <CheckCircle2 className="h-4 w-4 text-pitch-600" aria-hidden="true" />
        Logo uploads are audited, and the previous file is kept by the server.
      </div>
    </div>
  );
}
