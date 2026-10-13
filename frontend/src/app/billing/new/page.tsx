"use client";

// New billing run — BIL-01 (stateless preview) → BIL-02 (issue), owner only
// (PAGE_SPECIFICATIONS §7, BILLING_ENGINE §4/§6/§9/§10, ROUTES_AND_NAVIGATION §1).
//
// Nothing is stored until the run is issued (ADR-006: there is no draft invoice
// state — the preview is what a draft would be). The wizard therefore keeps the
// preview in component state, and the issue request carries the preview's
// `previewHash` so the server can answer 409 PREVIEW_STALE instead of billing
// from stale numbers, which the wizard handles by refreshing and going back a step.
import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { CalendarClock, CheckCircle2 } from "lucide-react";
import {
  ApiError,
  bil01CreatePreview,
  bil02CreateRun,
  grp01ListAgeGroups,
  idempotencyKey,
  set02GetBillingSettings,
} from "@/api/client";
import type {
  BillingAdjustment,
  BillingPreview,
  BillingPreviewLine,
  BillingRun,
  BillingSettings,
} from "@/api/types";
import { RequireAuth, RequirePermissions } from "@/components/Guards";
import { PageHeader } from "@/components/PageHeader";
import {
  Button,
  Card,
  DateText,
  EmptyState,
  InlineAlert,
  ListSkeleton,
  MoneyText,
  SectionTitle,
  SelectField,
  TextAreaField,
  TextField,
  Toast,
  Toggle,
  buttonClass,
} from "@/components/ui";
import { skipReasonText } from "@/lib/billing";
import { formatDateRange, todayISO } from "@/lib/dates";
import { formatMoneyMinor, parseMoneyInput } from "@/lib/money";

/** Exact copy the E2E script asserts for a stale preview (PAGE_SPECIFICATIONS §7). */
const STALE_NOTICE = "Data changed — preview refreshed";

const STEPS = [
  { key: "settings", label: "Target date" },
  { key: "preview", label: "Preview" },
  { key: "issue", label: "Issue" },
  { key: "done", label: "Done" },
] as const;

type StepKey = (typeof STEPS)[number]["key"];

interface Failure {
  message: string;
  requestId?: string;
  code?: string;
}

function toFailure(error: unknown): Failure {
  if (error instanceof ApiError) {
    return { message: error.message, requestId: error.requestId, code: error.code };
  }
  return { message: "We could not reach the server. Your input is kept — please retry." };
}

/** The due rule spelled out, because "days_after_issue 7" means nothing to an owner. */
function dueRuleText(settings: BillingSettings): string {
  switch (settings.dueRuleType) {
    case "days_after_issue":
      return `Due ${settings.dueRuleValue} day${settings.dueRuleValue === 1 ? "" : "s"} after the issue date`;
    case "days_after_period_start":
      return `Due ${settings.dueRuleValue} day${settings.dueRuleValue === 1 ? "" : "s"} after the period starts`;
    case "fixed_day_of_month":
      return `Due on day ${settings.dueRuleValue} of the month`;
  }
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function periodModeText(settings: BillingSettings): string {
  if (settings.billingPeriodMode === "anchored") {
    return "Anchored to each player's registration date";
  }
  return settings.billingFrequency === "weekly"
    ? `Calendar weeks starting ${WEEKDAYS[settings.weekStartDay % 7] ?? "Monday"}`
    : "Calendar months (1st to the last day)";
}

function issueTimingText(settings: BillingSettings): string {
  return settings.invoiceIssueTiming === "period_end"
    ? "Issued in arrears, after the period ends"
    : "Issued in advance, when the period starts";
}

function StepIndicator({ current }: { current: StepKey }) {
  const currentIndex = STEPS.findIndex((step) => step.key === current);
  return (
    <ol aria-label="Billing run progress" className="mb-4 flex flex-wrap gap-2">
      {STEPS.map((step, index) => {
        const state = index < currentIndex ? "done" : index === currentIndex ? "current" : "todo";
        return (
          <li
            key={step.key}
            aria-current={state === "current" ? "step" : undefined}
            className={`flex min-h-[44px] items-center gap-2 rounded-xl border px-3 text-[13px] font-semibold ${
              state === "current"
                ? "border-pitch-600 bg-pitch-50 text-pitch-700"
                : state === "done"
                  ? "border-slate-200 bg-white text-slate-700"
                  : "border-slate-200 bg-white text-slate-500"
            }`}
          >
            <span
              aria-hidden="true"
              className={`flex h-6 w-6 items-center justify-center rounded-full text-[12px] ${
                state === "current" ? "bg-pitch-600 text-white" : "bg-slate-100 text-slate-600"
              }`}
            >
              {state === "done" ? "✓" : index + 1}
            </span>
            {step.label}
          </li>
        );
      })}
    </ol>
  );
}

interface AdjustmentDraft {
  open: boolean;
  amount: string;
  reason: string;
}

interface AdjustmentCheck {
  /** Positive minor units the owner wants taken off; `undefined` when unset. */
  minor?: number;
  reason?: string;
  error?: string;
}

/**
 * A per-line adjustment is the ONLY way to prorate: BILLING_ENGINE §6 says the
 * owner enters it (no automatic part-month fee). It is negative-only and can
 * never exceed the line's fee, which is the same rule the API enforces.
 */
function checkAdjustment(line: BillingPreviewLine, draft: AdjustmentDraft | undefined): AdjustmentCheck {
  if (!draft) return {};
  const amount = draft.amount.trim();
  const reason = draft.reason.trim();
  if (!amount && !reason) return {};
  if (!amount) return { error: "Enter the amount to take off this invoice" };
  const parsed = parseMoneyInput(amount);
  if ("error" in parsed) return { error: parsed.error };
  if (parsed.minor > line.feeMinor) {
    return { error: `Cannot take off more than the fee (${formatMoneyMinor(line.feeMinor)})` };
  }
  if (reason.length < 5) {
    return { error: "A reason is required for an adjustment (at least 5 characters)" };
  }
  return { minor: parsed.minor, reason };
}

function BillingRunWizard() {
  const [step, setStep] = useState<StepKey>("settings");
  const [targetDate, setTargetDate] = useState(todayISO());
  const [ageGroupId, setAgeGroupId] = useState("");
  const [preview, setPreview] = useState<BillingPreview | null>(null);
  const [drafts, setDrafts] = useState<Record<string, AdjustmentDraft>>({});
  const [queueWhatsApp, setQueueWhatsApp] = useState(false);
  const [run, setRun] = useState<BillingRun | null>(null);
  // Generated when the Issue step is first shown and reused on every retry of
  // that intent (API_INTEGRATION §4) — a retry must never create a second run.
  const [issueKey, setIssueKey] = useState<string | null>(null);
  const [busy, setBusy] = useState<"preview" | "issue" | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [stale, setStale] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const settingsQuery = useQuery({
    queryKey: ["settings-billing"],
    queryFn: set02GetBillingSettings,
    staleTime: 5 * 60_000,
  });
  const groupsQuery = useQuery({
    queryKey: ["age-groups"],
    queryFn: () => grp01ListAgeGroups(),
    staleTime: 5 * 60_000,
  });

  const settings = settingsQuery.data;
  const groups = groupsQuery.data?.data ?? [];

  const checks = (preview?.lines ?? []).map((line) => ({
    line,
    check: checkAdjustment(line, drafts[line.playerId]),
  }));
  const adjustmentError = checks.find((c) => c.check.error)?.check.error;
  const adjustments: BillingAdjustment[] = checks
    .filter((c) => c.check.minor !== undefined && c.check.reason !== undefined)
    .map((c) => ({
      playerId: c.line.playerId,
      amountMinor: -(c.check.minor ?? 0),
      reason: c.check.reason ?? "",
    }));
  const adjustmentTotal = adjustments.reduce((sum, a) => sum + a.amountMinor, 0);
  const billableCount = preview?.lines.length ?? 0;
  const billableTotal = preview?.totals.totalMinor ?? 0;
  const nothingToBill = preview !== null && billableCount === 0;

  async function loadPreview(nextTarget: string) {
    setFailure(null);
    setBusy("preview");
    try {
      const result = await bil01CreatePreview({
        targetDate: nextTarget,
        ageGroupIds: ageGroupId ? [ageGroupId] : undefined,
      });
      setPreview(result);
      // Keep only the adjustments that still have a line (BILLING_ENGINE §9).
      setDrafts((prev) => {
        const keep: Record<string, AdjustmentDraft> = {};
        for (const line of result.lines) {
          if (prev[line.playerId]) keep[line.playerId] = prev[line.playerId];
        }
        return keep;
      });
      setIssueKey(null);
      setStep("preview");
    } catch (error) {
      setFailure(toFailure(error));
    } finally {
      setBusy(null);
    }
  }

  async function issueRun() {
    if (!preview) return;
    const key = issueKey ?? idempotencyKey();
    if (!issueKey) setIssueKey(key);
    setFailure(null);
    setBusy("issue");
    try {
      const result = await bil02CreateRun(
        {
          targetDate: preview.targetDate,
          previewHash: preview.previewHash,
          ageGroupIds: ageGroupId ? [ageGroupId] : undefined,
          adjustments: adjustments.length > 0 ? adjustments : undefined,
          queueWhatsApp,
        },
        key
      );
      setRun(result);
      setStep("done");
      setToast(
        `${result.invoicesCreated} invoice${result.invoicesCreated === 1 ? "" : "s"} issued.`
      );
    } catch (error) {
      if (error instanceof ApiError && error.code === "PREVIEW_STALE") {
        // The data moved under the preview: nothing was created. Say so, refresh,
        // and let the owner look again — the issue key is dropped because the
        // payload is about to change.
        setIssueKey(null);
        setStale(true);
        await loadPreview(preview.targetDate);
        return;
      }
      setFailure(toFailure(error));
    } finally {
      setBusy(null);
    }
  }

  function restart() {
    setStep("settings");
    setPreview(null);
    setDrafts({});
    setRun(null);
    setIssueKey(null);
    setFailure(null);
    setStale(false);
    setQueueWhatsApp(false);
  }

  return (
    <>
      <PageHeader
        title="New billing run"
        sub="Preview first — nothing is created until you issue the run."
        actions={
          <Link href="/billing" className={buttonClass("secondary", "sm")}>
            Back to billing
          </Link>
        }
      />

      <StepIndicator current={step} />

      {stale ? (
        <div className="mb-4">
          <InlineAlert tone="warning" title={STALE_NOTICE}>
            <p>
              Details changed while you were looking (a player, group, fee or an existing invoice).
              Nothing was created — the preview below is the fresh one.
            </p>
          </InlineAlert>
        </div>
      ) : null}

      {failure ? (
        <div className="mb-4">
          <InlineAlert
            tone="danger"
            title={failure.code === "PREVIEW_STALE" ? STALE_NOTICE : "The run was not created"}
            action={
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void issueRun()}
                pending={busy === "issue"}
              >
                Try again
              </Button>
            }
          >
            <p>{failure.message}</p>
            {failure.requestId ? (
              <p className="mt-1 text-[12px]">
                Reference: <span className="font-mono">{failure.requestId}</span>
              </p>
            ) : null}
          </InlineAlert>
        </div>
      ) : null}

      {/* 1 · Target date and the rules in force ------------------------------- */}
      {step === "settings" ? (
        <Card>
          <SectionTitle right={<span className="text-[13px] text-slate-600">read-only</span>}>
            1 · What this run will use
          </SectionTitle>
          {settingsQuery.isLoading ? (
            <ListSkeleton rows={3} />
          ) : settingsQuery.isError || !settings ? (
            <div className="p-4">
              <InlineAlert tone="danger" title="Billing settings could not be loaded">
                <p>The run needs the academy&rsquo;s billing settings before it can preview anything.</p>
                <Button
                  variant="secondary"
                  size="sm"
                  className="mt-2"
                  onClick={() => void settingsQuery.refetch()}
                >
                  Retry
                </Button>
              </InlineAlert>
            </div>
          ) : (
            <div className="space-y-4 p-4">
              <dl className="grid gap-3 text-[14px] sm:grid-cols-2">
                <div className="rounded-xl border border-slate-200 px-3 py-2">
                  <dt className="text-[12px] uppercase tracking-wide text-slate-500">Frequency</dt>
                  <dd className="font-medium text-slate-900">
                    {settings.billingFrequency === "monthly" ? "Monthly" : "Weekly"}
                  </dd>
                </div>
                <div className="rounded-xl border border-slate-200 px-3 py-2">
                  <dt className="text-[12px] uppercase tracking-wide text-slate-500">Periods</dt>
                  <dd className="font-medium text-slate-900">{periodModeText(settings)}</dd>
                </div>
                <div className="rounded-xl border border-slate-200 px-3 py-2">
                  <dt className="text-[12px] uppercase tracking-wide text-slate-500">Issue timing</dt>
                  <dd className="font-medium text-slate-900">{issueTimingText(settings)}</dd>
                </div>
                <div className="rounded-xl border border-slate-200 px-3 py-2">
                  <dt className="text-[12px] uppercase tracking-wide text-slate-500">Due rule</dt>
                  <dd className="font-medium text-slate-900">{dueRuleText(settings)}</dd>
                </div>
                <div className="rounded-xl border border-slate-200 px-3 py-2">
                  <dt className="text-[12px] uppercase tracking-wide text-slate-500">Amounts</dt>
                  <dd className="font-medium text-slate-900">
                    {settings.allowFractionalMoney
                      ? "Cents are allowed"
                      : "Whole rupees only"}
                  </dd>
                </div>
                <div className="rounded-xl border border-slate-200 px-3 py-2">
                  <dt className="text-[12px] uppercase tracking-wide text-slate-500">Fee used</dt>
                  <dd className="font-medium text-slate-900">
                    The fee effective on the reference date
                  </dd>
                </div>
              </dl>

              <InlineAlert tone="info" title="Changing a setting later">
                <p>{settings.effectNote} — existing invoices are never rewritten.</p>
              </InlineAlert>

              <div className="grid gap-3 sm:grid-cols-2">
                <TextField
                  id="run-target-date"
                  label="Target date"
                  type="date"
                  required
                  value={targetDate}
                  hint="The date the run is billed as of. A past date catches a missed period up."
                  onChange={(event) => setTargetDate(event.target.value)}
                />
                <SelectField
                  id="run-group"
                  label="Age group"
                  value={ageGroupId}
                  hint="Leave as “All groups” to bill every active player."
                  onChange={(event) => setAgeGroupId(event.target.value)}
                >
                  <option value="">All groups</option>
                  {groups.map((group) => (
                    <option key={group.id} value={group.id}>
                      {group.name}
                    </option>
                  ))}
                </SelectField>
              </div>

              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button
                  id="run-preview"
                  onClick={() => void loadPreview(targetDate)}
                  pending={busy === "preview"}
                  disabled={!targetDate}
                >
                  <CalendarClock className="h-4 w-4" aria-hidden="true" />
                  Preview
                </Button>
              </div>
            </div>
          )}
        </Card>
      ) : null}

      {/* 2 · Preview (BIL-01) ------------------------------------------------- */}
      {step === "preview" && preview ? (
        <div className="space-y-4">
          <Card>
            <SectionTitle
              right={
                <span className="tabular text-[13px] font-semibold text-slate-700">
                  {billableCount} line{billableCount === 1 ? "" : "s"} ·{" "}
                  {formatMoneyMinor(billableTotal, { full: true })}
                </span>
              }
            >
              2 · Preview for {preview.targetDate}
            </SectionTitle>

            <div className="space-y-3 p-4">
              <p className="text-[13px] text-slate-600">
                {preview.frequency === "monthly" ? "Monthly" : "Weekly"} ·{" "}
                {preview.mode === "anchored" ? "anchored to the player" : "calendar periods"} ·
                nothing is stored yet.
              </p>

              {nothingToBill ? (
                <InlineAlert tone="warning" title="Nothing to bill for this target date">
                  <p>
                    No player is billable for this date. The reasons are listed below — a group or a
                    fee is usually missing, or the period is already invoiced.
                  </p>
                </InlineAlert>
              ) : (
                <ul aria-label="Billing preview lines" className="divide-y divide-slate-100">
                  {preview.lines.map((line) => {
                    const draft = drafts[line.playerId];
                    const check = checkAdjustment(line, draft);
                    return (
                      <li key={line.playerId} className="py-3">
                        <p className="text-[15px] font-semibold text-slate-900">{line.playerName}</p>
                        <p className="mt-0.5 text-[13px] text-slate-600">
                          {line.registrationNo} · {line.ageGroup.name} ·{" "}
                          {formatDateRange(line.periodStart, line.periodEnd)}
                        </p>
                        <dl className="mt-1 grid gap-1 text-[13px] sm:grid-cols-3">
                          <div className="flex gap-2">
                            <dt className="text-slate-500">Fee</dt>
                            <dd className="font-medium text-slate-900">
                              <MoneyText minor={line.feeMinor} />
                            </dd>
                          </div>
                          <div className="flex gap-2">
                            <dt className="text-slate-500">Due</dt>
                            <dd className="font-medium text-slate-900">
                              <DateText value={line.dueDate} />
                            </dd>
                          </div>
                          <div className="flex gap-2">
                            <dt className="text-slate-500">Guardian</dt>
                            <dd className="font-medium text-slate-900">
                              {line.guardian?.fullName ?? "Not recorded"}
                            </dd>
                          </div>
                        </dl>

                        {line.warnings.length > 0 ? (
                          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[13px] text-amber-800">
                            {line.warnings.map((warning) => (
                              <li key={warning}>{warning}</li>
                            ))}
                          </ul>
                        ) : null}

                        {check.minor !== undefined && !check.error ? (
                          <p className="mt-1 text-[13px] font-medium text-slate-700">
                            Adjustment −
                            {formatMoneyMinor(check.minor)} · {check.reason}
                          </p>
                        ) : null}

                        <div className="mt-2">
                          {draft?.open ? (
                            <div className="space-y-3 rounded-xl border border-slate-200 p-3">
                              <TextField
                                id={`adjust-amount-${line.playerId}`}
                                label="Reduce by"
                                inputMode="decimal"
                                value={draft.amount}
                                error={check.error}
                                hint={`Up to ${formatMoneyMinor(line.feeMinor)}. Enter rupees, e.g. 2000 for a half month.`}
                                onChange={(event) =>
                                  setDrafts((prev) => ({
                                    ...prev,
                                    [line.playerId]: { ...draft, amount: event.target.value },
                                  }))
                                }
                              />
                              <TextAreaField
                                id={`adjust-reason-${line.playerId}`}
                                label="Reason"
                                rows={2}
                                value={draft.reason}
                                hint="Recorded on the invoice and in the audit log (at least 5 characters)."
                                onChange={(event) =>
                                  setDrafts((prev) => ({
                                    ...prev,
                                    [line.playerId]: { ...draft, reason: event.target.value },
                                  }))
                                }
                              />
                              <div className="flex flex-col-reverse gap-2 sm:flex-row">
                                <Button
                                  variant="secondary"
                                  size="sm"
                                  onClick={() =>
                                    setDrafts((prev) => ({
                                      ...prev,
                                      [line.playerId]: { open: false, amount: "", reason: "" },
                                    }))
                                  }
                                >
                                  Remove adjustment
                                </Button>
                              </div>
                            </div>
                          ) : (
                            <Button
                              id={`adjust-${line.playerId}`}
                              variant="secondary"
                              size="sm"
                              onClick={() =>
                                setDrafts((prev) => ({
                                  ...prev,
                                  [line.playerId]: {
                                    ...(prev[line.playerId] ?? { amount: "", reason: "" }),
                                    open: true,
                                  },
                                }))
                              }
                            >
                              Adjust this invoice
                            </Button>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}

              {preview.skipped.length > 0 ? (
                <div className="rounded-xl border border-slate-200 p-3">
                  <p className="text-[14px] font-semibold text-slate-900">
                    Skipped ({preview.skipped.length})
                  </p>
                  <ul aria-label="Skipped players" className="mt-2 space-y-1 text-[13px] text-slate-700">
                    {preview.skipped.map((row) => (
                      <li key={row.playerId}>
                        <span className="font-medium">{row.playerName}</span> —{" "}
                        {skipReasonText(row.reason, preview.targetDate)}
                      </li>
                    ))}
                  </ul>
                  <p className="mt-2 text-[13px] text-slate-600">
                    One skipped player never blocks the run; anything skipped here is picked up by a
                    later run once its cause is fixed.
                  </p>
                </div>
              ) : null}
            </div>

            <div className="flex flex-col gap-2 border-t border-slate-200 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-[13px] text-slate-600">
                {adjustments.length > 0
                  ? `${adjustments.length} adjustment${adjustments.length === 1 ? "" : "s"} · −${formatMoneyMinor(
                      Math.abs(adjustmentTotal)
                    )} off the run`
                  : "No automatic part-month proration — use “Adjust this invoice” if the owner agrees."}
              </p>
              <div className="flex flex-col-reverse gap-2 sm:flex-row">
                <Button
                  variant="secondary"
                  onClick={() => void loadPreview(preview.targetDate)}
                  pending={busy === "preview"}
                >
                  Refresh preview
                </Button>
                <Button variant="secondary" onClick={() => setStep("settings")}>
                  Change target date
                </Button>
                <Button
                  id="run-continue"
                  onClick={() => {
                    setIssueKey((current) => current ?? idempotencyKey());
                    setStep("issue");
                  }}
                  disabled={nothingToBill || Boolean(adjustmentError)}
                >
                  Continue
                </Button>
              </div>
            </div>
          </Card>
        </div>
      ) : null}

      {/* 3 · Issue confirmation ---------------------------------------------- */}
      {step === "issue" && preview ? (
        <Card>
          <SectionTitle>3 · Issue the run</SectionTitle>
          <div className="space-y-4 p-4">
            <p className="text-[15px] text-slate-900">
              Create <strong className="tabular">{billableCount}</strong> invoice
              {billableCount === 1 ? "" : "s"} totalling{" "}
              <strong className="tabular">
                {formatMoneyMinor(billableTotal + adjustmentTotal, { full: true })}
              </strong>
              ?
            </p>
            {adjustments.length > 0 ? (
              <p className="text-[13px] text-slate-600">
                Includes {adjustments.length} adjustment{adjustments.length === 1 ? "" : "s"} reducing
                the total by {formatMoneyMinor(Math.abs(adjustmentTotal))}.
              </p>
            ) : null}

            <Toggle
              id="run-queue-whatsapp"
              label="Send invoices by WhatsApp when ready"
              hint="Queued for the guardians who accept invoices. Guardians without recorded consent are skipped, and the message list shows why. Delivery is never guaranteed."
              checked={queueWhatsApp}
              onChange={setQueueWhatsApp}
            />

            <InlineAlert tone="info" title="What issuing does">
              <p>
                One transaction per run: invoices are numbered in order, each keeps the fee and group
                it was previewed with, and the run is recorded with its created/skipped counts.
                Existing invoices are never touched.
              </p>
            </InlineAlert>

            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button variant="secondary" onClick={() => setStep("preview")}>
                Back to preview
              </Button>
              <Button
                id="run-issue"
                onClick={() => void issueRun()}
                pending={busy === "issue"}
                disabled={billableCount === 0}
              >
                {busy === "issue" ? "Issuing…" : "Issue invoices"}
              </Button>
            </div>
          </div>
        </Card>
      ) : null}

      {/* 4 · Result (BIL-02) -------------------------------------------------- */}
      {step === "done" && run ? (
        <div className="space-y-4">
          <Card>
            <SectionTitle>4 · Done</SectionTitle>
            <div className="space-y-4 p-4">
              <InlineAlert tone="success" title="Billing run finished">
                <p>
                  <strong className="tabular">{run.invoicesCreated}</strong> invoice
                  {run.invoicesCreated === 1 ? "" : "s"} created
                  {run.invoicesSkipped > 0 ? (
                    <>
                      , <strong className="tabular">{run.invoicesSkipped}</strong> skipped
                    </>
                  ) : null}{" "}
                  for {run.targetDate}.
                </p>
                {queueWhatsApp ? (
                  <p className="mt-1">
                    Invoice messages were queued for the guardians who accept them; the message list
                    shows every job, including the ones that were skipped and why.
                  </p>
                ) : null}
              </InlineAlert>

              <p className="text-[13px] text-slate-600">
                Run {run.id.slice(0, 8)} · started <DateText value={run.startedAt} withTime />
                {run.completedAt ? (
                  <>
                    {" "}
                    · finished <DateText value={run.completedAt} withTime />
                  </>
                ) : null}
              </p>

              <div className="flex flex-col gap-2 sm:flex-row">
                <Link href="/billing?tab=invoices" className={buttonClass("primary")}>
                  <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                  View invoices
                </Link>
                <Button variant="secondary" onClick={restart}>
                  Start another run
                </Button>
              </div>
            </div>
          </Card>
        </div>
      ) : null}

      {step === "preview" && !preview && !busy ? (
        <Card>
          <EmptyState
            title="No preview yet"
            description="Pick a target date and preview the run — nothing is created by a preview."
          />
        </Card>
      ) : null}

      {toast ? <Toast message={toast} onDismiss={() => setToast(null)} /> : null}
    </>
  );
}

export default function NewBillingRunPage() {
  return (
    <RequireAuth>
      <RequirePermissions path="/billing/new">
        <BillingRunWizard />
      </RequirePermissions>
    </RequireAuth>
  );
}
