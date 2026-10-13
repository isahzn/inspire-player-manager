"use client";

// /whatsapp — Step 6 slice (MSG-01..08, SET-05..08). Tabs: Status · Messages ·
// Reminders & templates · Settings (PAGE_SPECIFICATIONS §9, ROUTES §1).
//
// Two rules this screen exists to keep:
// · **Delivery is never inferred.** The Delivery word comes from
//   `deliveryLabel(deliveryState)`; "Delivered" needs `device_delivered` and
//   "Read" needs `read`. Because OpenWA's ack mapping is unconfirmed (spike S1,
//   OPENWA_INTEGRATION §9 / OPEN-019) the adapter may only emit
//   `server_accepted`/`unknown`, so those two labels stay unreachable rather
//   than guessed — the Messages tab says so out loud.
// · **A switch that is off says what it does NOT do.** SET-08 disables new
//   sends AND cancels that kind's unsent jobs; re-enabling never back-fills.
//
// All wording lives in `lib/messaging.ts` — this file never invents a status,
// delivery or automation string of its own.
import { Suspense, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FlaskConical, Pause, Play } from "lucide-react";
import {
  ApiError,
  inv01ListInvoices,
  msg01ListMessages,
  msg06GetMessagingStatus,
  msg07PauseMessaging,
  msg07ResumeMessaging,
  msg08SendTestMessage,
  ply01ListPlayers,
  set05CreateReminderRule,
  set05DeleteReminderRule,
  set05ListReminderRules,
  set05PatchReminderRule,
  set06ListMessageTemplates,
  set06PutMessageTemplate,
  set07GetMessagingSettings,
  set07PatchMessagingSettings,
  set08GetAutomations,
  set08PatchAutomations,
} from "@/api/client";
import type {
  AutomationKey,
  Automations,
  AutomationsResponse,
  MessageJob,
  MessageTemplate,
  MessagingSettings,
  MessagingStatus,
  ReminderRule,
} from "@/api/types";
import { RequireAuth, RequirePermissions } from "@/components/Guards";
import { PageHeader } from "@/components/PageHeader";
import { StatusChip } from "@/components/StatusChip";
import {
  Button,
  Card,
  DateText,
  EmptyState,
  ErrorState,
  InlineAlert,
  ListSkeleton,
  Modal,
  SectionTitle,
  SelectField,
  Tabs,
  TextAreaField,
  TextField,
  Toast,
  Toggle,
} from "@/components/ui";
import { useAuth } from "@/lib/auth";
import {
  AUTOMATIONS,
  automationMeta,
  automationStateLine,
  automationWarning,
  deliveryLabel,
  MESSAGE_STATUSES,
  messageKindLabel,
  messageStatusLabel,
  messageStatusTone,
  renderTemplate,
  SAMPLE_TEMPLATE_VALUES,
  sessionStatusLabel,
  sessionStatusTone,
  skipReasonLabel,
  templateVars,
  unknownTemplateVars,
} from "@/lib/messaging";

const TABS = [
  { key: "status", label: "Status" },
  { key: "messages", label: "Messages" },
  { key: "reminders", label: "Reminders & templates" },
  { key: "settings", label: "Settings" },
];

const PAGE_SIZE = 25;

function errorMessage(error: unknown): string | null {
  if (error instanceof ApiError) return error.message;
  if (error) return "Something went wrong. Please retry.";
  return null;
}

function WhatsappScreen() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();

  const tab = searchParams.get("tab") ?? "status";
  const setTab = (next: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (next === "status") params.delete("tab");
    else params.set("tab", next);
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  };

  const statusQuery = useQuery({
    queryKey: ["messaging", "status"],
    queryFn: msg06GetMessagingStatus,
  });
  const automationsQuery = useQuery({
    queryKey: ["messaging", "automations"],
    queryFn: set08GetAutomations,
  });

  // R-20 needs the count of invoices that still carry a balance. Two honest
  // reads of INV-01 rather than a sum of everything (paid/void invoices are not
  // "unpaid"), because "Invoiced" and "Collected" are never combined here either.
  const issuedQuery = useQuery({
    queryKey: ["invoices", "count", "issued"],
    queryFn: () => inv01ListInvoices({ status: "issued", page: 1, pageSize: 1 }),
  });
  const partialQuery = useQuery({
    queryKey: ["invoices", "count", "partially_paid"],
    queryFn: () => inv01ListInvoices({ status: "partially_paid", page: 1, pageSize: 1 }),
  });
  const unpaidCount = (issuedQuery.data?.meta.total ?? 0) + (partialQuery.data?.meta.total ?? 0);

  return (
    <>
      <PageHeader
        title="WhatsApp"
        sub="Invoices, reminders and templates sent through OpenWA. Delivery is only reported when the provider reports it."
      />

      <Tabs idPrefix="wa" tabs={TABS} active={tab} onChange={setTab} />

      <div className="mt-4" id={`wa-panel-${tab}`} role="tabpanel" aria-labelledby={`wa-tab-${tab}`}>
        {tab === "status" ? (
          <StatusTab
            statusQuery={statusQuery}
            automationsQuery={automationsQuery}
            unpaidCount={unpaidCount}
            onChanged={() => {
              void queryClient.invalidateQueries({ queryKey: ["messaging"] });
              void queryClient.invalidateQueries({ queryKey: ["messages"] });
            }}
          />
        ) : null}
        {tab === "messages" ? <MessagesTab /> : null}
        {tab === "reminders" ? <RemindersTab /> : null}
        {tab === "settings" ? <SettingsTab /> : null}
      </div>
    </>
  );
}

// ===========================================================================
// Status tab
// ===========================================================================
/** The read result a tab needs, so the props stay honest without a cast. */
interface AsyncView<T> {
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  data?: T;
  refetch: () => void;
}

function StatusTab({
  statusQuery,
  automationsQuery,
  unpaidCount,
  onChanged,
}: {
  statusQuery: AsyncView<MessagingStatus>;
  automationsQuery: AsyncView<AutomationsResponse>;
  unpaidCount: number;
  onChanged: () => void;
}) {
  const { me } = useAuth();
  const [pauseOpen, setPauseOpen] = useState(false);
  const [pauseReason, setPauseReason] = useState("");
  const [confirmKey, setConfirmKey] = useState<{ key: AutomationKey; next: boolean } | null>(null);
  const [testOpen, setTestOpen] = useState(false);
  const [testPhone, setTestPhone] = useState(me?.user.phone ?? "");
  const [toast, setToast] = useState<string | null>(null);

  const pause = useMutation({
    mutationFn: (reason: string) => msg07PauseMessaging({ reason: reason || undefined }),
    onSuccess: () => {
      setPauseOpen(false);
      setPauseReason("");
      setToast("Automation paused. Queued messages stay queued until you resume.");
      onChanged();
    },
  });

  const resume = useMutation({
    mutationFn: () => msg07ResumeMessaging(),
    onSuccess: () => {
      setToast("Automation resumed. Messages missed while paused are not sent retroactively.");
      onChanged();
    },
  });

  const toggleAutomation = useMutation({
    mutationFn: (input: { key: AutomationKey; next: boolean }) =>
      set08PatchAutomations({ [input.key]: input.next } as Partial<Automations>),
    onSuccess: (_data, input) => {
      const meta = automationMeta(input.key);
      setConfirmKey(null);
      setToast(
        input.next
          ? `${meta.label} switched on. Messages missed while it was off are not sent retroactively.`
          : `${meta.label} switched off. Unsent messages of this kind were cancelled.`
      );
      onChanged();
    },
  });

  const sendTest = useMutation({
    mutationFn: (phone: string) => msg08SendTestMessage({ phone }),
    onSuccess: () => {
      setTestOpen(false);
      setToast("Test message queued to your own number.");
      onChanged();
    },
  });

  if (statusQuery.isLoading || automationsQuery.isLoading) return <ListSkeleton rows={4} />;
  if (statusQuery.isError)
    return <ErrorState error={statusQuery.error} onRetry={() => statusQuery.refetch()} />;
  if (automationsQuery.isError)
    return <ErrorState error={automationsQuery.error} onRetry={() => automationsQuery.refetch()} />;

  const status = statusQuery.data;
  const automations = automationsQuery.data;
  if (!status || !automations) return <ListSkeleton rows={4} />;

  const masterPaused = !status.automationEnabled;
  const connected = status.session.status === "connected";
  const warning = automationWarning(automations, masterPaused, unpaidCount);
  const confirmMeta = confirmKey ? automationMeta(confirmKey.key) : null;

  return (
    <div className="space-y-4">
      <Card>
        <SectionTitle
          right={
            masterPaused ? (
              <Button
                size="sm"
                pending={resume.isPending}
                onClick={() => resume.mutate()}
                disabled={!connected}
                title={connected ? undefined : "Connect WhatsApp first — a resume only starts new sends."}
              >
                <Play className="h-4 w-4" aria-hidden="true" />
                Resume sending
              </Button>
            ) : (
              <Button variant="secondary" size="sm" onClick={() => setPauseOpen(true)}>
                <Pause className="h-4 w-4" aria-hidden="true" />
                Pause all sending
              </Button>
            )
          }
        >
          Connection
        </SectionTitle>

        <div className="grid gap-4 p-4 lg:grid-cols-2">
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <StatusChip status={sessionStatusTone(status.session.status)} />
              <span className="text-[14px] font-semibold text-slate-900">
                {sessionStatusLabel(status.session.status)}
              </span>
              <span className="text-[13px] text-slate-600">
                · provider <span className="font-mono">openwa</span> · last checked{" "}
                <DateText value={status.session.checkedAt} withTime />
              </span>
            </div>

            <p className="text-[14px] text-slate-700">
              Automation is{" "}
              <strong>{masterPaused ? "paused (master)" : "on"}</strong>.{" "}
              {masterPaused
                ? "No new messages are queued, and nothing already queued is being sent."
                : connected
                  ? "New invoices and reminders are queued inside the send window."
                  : "Reminders are held until WhatsApp reconnects."}
            </p>

            {!connected ? (
              <InlineAlert
                tone="warning"
                title="WhatsApp is not connected"
              >
                <p>
                  Reminders are paused. Open the OpenWA dashboard and reconnect — scan the QR
                  code or enter the pairing code. Queued messages are kept, not lost, and nothing
                  is retried until the session is back.
                </p>
                <p className="mt-1 text-[13px]">
                  The status word above is <em>our</em> normalized label. The provider&apos;s own
                  lifecycle strings are unverified until spike S1 confirms them.
                </p>
              </InlineAlert>
            ) : null}

            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              <QueueStat label="Queued" value={status.queue.queued} />
              <QueueStat label="Sending now" value={status.queue.sending} />
              <QueueStat label="Failed (24 h)" value={status.queue.failedLast24h} />
              <QueueStat label="Failed permanently" value={status.queue.dead} />
              <QueueStat label="Needs review" value={status.queue.needsReview} />
              <QueueStat
                label="Last sent"
                value={status.lastSentAt ? <DateText value={status.lastSentAt} withTime /> : "—"}
              />
            </div>

            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" onClick={() => setTestOpen(true)}>
                <FlaskConical className="h-4 w-4" aria-hidden="true" />
                Send test to my number
              </Button>
            </div>
          </div>

          <div className="space-y-3">
            <InlineAlert tone="info" title="What this channel is">
              <p>
                Unofficial WhatsApp automation via a reverse-engineered client — delivery is not
                guaranteed, and a number that is not on WhatsApp cannot be reached at all. Every
                reminder has a manual fallback: copy the text and send it yourself.
              </p>
            </InlineAlert>
            <InlineAlert tone="info" title="Delivery labels">
              <p>
                A message reads <strong>Delivered</strong> only when the provider reports{" "}
                <span className="font-mono">device_delivered</span>, and <strong>Read</strong> only
                for a read receipt. While the mapping is unconfirmed, messages can only read{" "}
                <em>Accepted by server</em> or <em>Unknown</em> — the other two labels are not
                guessed at.
              </p>
            </InlineAlert>
          </div>
        </div>
      </Card>

      {warning ? (
        <InlineAlert tone="warning" title="Something is switched off while money is outstanding">
          {warning}
        </InlineAlert>
      ) : null}

      <Card>
        <SectionTitle
          right={
            <span className="text-[13px] text-slate-600">
              Master: {automationStateLine(true, masterPaused, status.session.status)}
            </span>
          }
        >
          Automations
        </SectionTitle>
        <ul className="divide-y divide-slate-100">
          {AUTOMATIONS.map((meta) => {
            const enabled = automations[meta.key];
            const state = automationStateLine(enabled, masterPaused, status.session.status);
            return (
              <li key={meta.key} className="px-4 py-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-[15px] font-semibold text-slate-900">{meta.label}</p>
                    <p className="mt-0.5 text-[13px] text-slate-600">{meta.effect}</p>
                    <p className="mt-1 text-[13px] text-slate-600">
                      Off: {meta.whenOff}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-2">
                    <StatusChip status={enabled && !masterPaused ? "On" : masterPaused ? "Pending" : "Off"} />
                    <Toggle
                      id={`automation-${meta.key}`}
                      label={meta.label}
                      checked={enabled}
                      disabled={toggleAutomation.isPending}
                      onChange={(next) => setConfirmKey({ key: meta.key, next })}
                    />
                    <span className="text-[12px] text-slate-500">State: {state}</span>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
        <p className="border-t border-slate-200 px-4 py-3 text-[13px] text-slate-600">
          Each switch takes effect immediately and is recorded in the audit history. Turning one
          off cancels that kind&apos;s unsent messages; turning it back on never sends what was
          missed.
        </p>
      </Card>

      <Modal
        open={pauseOpen}
        onClose={() => setPauseOpen(false)}
        title="Pause all sending?"
        description="Queued messages stay queued and nothing new is sent. Resuming continues the queue; it does not send anything that was missed."
        footer={
          <>
            <Button variant="secondary" onClick={() => setPauseOpen(false)}>
              Keep sending
            </Button>
            <Button pending={pause.isPending} onClick={() => pause.mutate(pauseReason.trim())}>
              Pause sending
            </Button>
          </>
        }
      >
        <TextAreaField
          id="pause-reason"
          label="Reason (optional)"
          hint="Recorded in the audit history, e.g. “reconnecting the phone”."
          value={pauseReason}
          onChange={(e) => setPauseReason(e.target.value)}
        />
        {errorMessage(pause.error) ? (
          <InlineAlert tone="danger">{errorMessage(pause.error)}</InlineAlert>
        ) : null}
      </Modal>

      <Modal
        open={confirmKey !== null}
        onClose={() => setConfirmKey(null)}
        title={confirmKey?.next ? `Switch on ${confirmMeta?.label}?` : `Switch off ${confirmMeta?.label}?`}
        description={confirmKey?.next ? confirmMeta?.effect : `Off: ${confirmMeta?.whenOff}`}
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmKey(null)}>
              Cancel
            </Button>
            <Button
              variant={confirmKey?.next ? "primary" : "danger"}
              pending={toggleAutomation.isPending}
              onClick={() => confirmKey && toggleAutomation.mutate(confirmKey)}
            >
              {confirmKey?.next ? "Switch on" : "Switch off"}
            </Button>
          </>
        }
      >
        <p className="text-[14px] text-slate-700">
          {confirmKey?.next
            ? "Nothing missed while it was off is sent retroactively — that is a rule, not a setting."
            : "Messages of this kind that were not sent yet are cancelled now. They are not re-queued when you switch it back on."}
        </p>
        {errorMessage(toggleAutomation.error) ? (
          <InlineAlert tone="danger">{errorMessage(toggleAutomation.error)}</InlineAlert>
        ) : null}
      </Modal>

      <Modal
        open={testOpen}
        onClose={() => setTestOpen(false)}
        title="Send a test message"
        description="A test can only go to an owner's own number (MSG-08) — never to a guardian."
        footer={
          <>
            <Button variant="secondary" onClick={() => setTestOpen(false)}>
              Cancel
            </Button>
            <Button
              pending={sendTest.isPending}
              disabled={testPhone.trim().length < 8}
              onClick={() => sendTest.mutate(testPhone.trim())}
            >
              Queue test message
            </Button>
          </>
        }
      >
        <TextField
          id="test-phone"
          label="Your WhatsApp number"
          hint="E.164, e.g. +94770000009."
          value={testPhone}
          onChange={(e) => setTestPhone(e.target.value)}
        />
        {!connected ? (
          <div className="mt-3">
            <InlineAlert tone="warning">
              WhatsApp is not connected, so the test will sit queued until it reconnects.
            </InlineAlert>
          </div>
        ) : null}
        {errorMessage(sendTest.error) ? (
          <div className="mt-3">
            <InlineAlert tone="danger">{errorMessage(sendTest.error)}</InlineAlert>
          </div>
        ) : null}
      </Modal>

      {toast ? <Toast message={toast} onDismiss={() => setToast(null)} /> : null}
    </div>
  );
}

function QueueStat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-slate-200 px-3 py-2">
      <p className="text-[12px] font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <p className="tabular mt-0.5 text-[15px] font-semibold text-slate-900">{value}</p>
    </div>
  );
}

// ===========================================================================
// Messages tab (MSG-01)
// ===========================================================================
function MessagesTab() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const status = searchParams.get("status") ?? "";
  const kind = searchParams.get("kind") ?? "";
  const from = searchParams.get("from") ?? "";
  const to = searchParams.get("to") ?? "";
  const invoiceId = searchParams.get("invoiceId") ?? "";
  const playerId = searchParams.get("playerId") ?? "";
  const page = Math.max(1, Number(searchParams.get("page") ?? "1") || 1);

  const setParams = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(patch)) {
      if (value === null || value === "") next.delete(key);
      else next.set(key, value);
    }
    if (!("page" in patch)) next.delete("page");
    const query = next.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  };

  const messagesQuery = useQuery({
    queryKey: ["messages", { status, kind, from, to, invoiceId, playerId, page }],
    queryFn: () =>
      msg01ListMessages({
        status: (status || undefined) as MessageJob["status"] | undefined,
        kind: (kind || undefined) as MessageJob["kind"] | undefined,
        from: from || undefined,
        to: to || undefined,
        invoiceId: invoiceId || undefined,
        playerId: playerId || undefined,
        page,
        pageSize: PAGE_SIZE,
      }),
    placeholderData: (previous) => previous,
  });

  // Picker sources for the two filters MSG-01 actually accepts (invoiceId /
  // playerId). Nothing is filtered in the DOM behind the user's back.
  const invoiceOptions = useQuery({
    queryKey: ["invoices", "picker"],
    queryFn: () => inv01ListInvoices({ page: 1, pageSize: 50 }),
  });
  const playerOptions = useQuery({
    queryKey: ["players", "picker"],
    queryFn: () => ply01ListPlayers({ page: 1, pageSize: 50, sort: "fullName" }),
  });

  const rows = messagesQuery.data?.data ?? [];
  const meta = messagesQuery.data?.meta;
  const filterCount = [status, kind, from, to, invoiceId, playerId].filter(Boolean).length;

  return (
    <div className="space-y-4">
      <Card>
        <SectionTitle>Filters</SectionTitle>
        <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <label htmlFor="msg-status" className="mb-1 block text-[14px] font-semibold text-slate-800">
              Status
            </label>
            <select
              id="msg-status"
              value={status}
              onChange={(e) => setParams({ status: e.target.value })}
              className="h-12 w-full rounded-xl border border-slate-300 bg-white px-3 text-[16px]"
            >
              <option value="">All statuses</option>
              {MESSAGE_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {messageStatusLabel(s)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="msg-kind" className="mb-1 block text-[14px] font-semibold text-slate-800">
              Kind
            </label>
            <select
              id="msg-kind"
              value={kind}
              onChange={(e) => setParams({ kind: e.target.value })}
              className="h-12 w-full rounded-xl border border-slate-300 bg-white px-3 text-[16px]"
            >
              <option value="">All kinds</option>
              <option value="invoice_delivery">Invoice</option>
              <option value="reminder_pre_due">Pre-due reminder</option>
              <option value="reminder_overdue">Late reminder</option>
              <option value="test">Test message</option>
            </select>
          </div>
          <div>
            <label htmlFor="msg-invoice" className="mb-1 block text-[14px] font-semibold text-slate-800">
              Invoice
            </label>
            <select
              id="msg-invoice"
              value={invoiceId}
              onChange={(e) => setParams({ invoiceId: e.target.value || null })}
              className="h-12 w-full rounded-xl border border-slate-300 bg-white px-3 text-[16px]"
            >
              <option value="">All invoices</option>
              {(invoiceOptions.data?.data ?? []).map((inv) => (
                <option key={inv.id} value={inv.id}>
                  {inv.invoiceNumber} · {inv.player.fullName}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="msg-player" className="mb-1 block text-[14px] font-semibold text-slate-800">
              Player
            </label>
            <select
              id="msg-player"
              value={playerId}
              onChange={(e) => setParams({ playerId: e.target.value || null })}
              className="h-12 w-full rounded-xl border border-slate-300 bg-white px-3 text-[16px]"
            >
              <option value="">All players</option>
              {(playerOptions.data?.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.fullName}
                </option>
              ))}
            </select>
          </div>
          <TextField
            id="msg-from"
            type="date"
            label="Scheduled from"
            value={from}
            onChange={(e) => setParams({ from: e.target.value || null })}
          />
          <TextField
            id="msg-to"
            type="date"
            label="Scheduled to"
            value={to}
            onChange={(e) => setParams({ to: e.target.value || null })}
          />
        </div>
        {filterCount > 0 ? (
          <div className="border-t border-slate-200 px-4 py-2">
            <button
              type="button"
              className="cursor-pointer text-[13px] font-semibold text-pitch-700 underline underline-offset-2"
              onClick={() =>
                setParams({ status: null, kind: null, from: null, to: null, invoiceId: null, playerId: null })
              }
            >
              Clear filters
            </button>
          </div>
        ) : null}
      </Card>

      <InlineAlert tone="info" title="How to read the Delivery column">
        <p>
          <strong>Delivered</strong> is only shown when the provider reports{" "}
          <span className="font-mono">device_delivered</span>, and <strong>Read</strong> only for a
          read receipt. A &quot;Sent&quot; status on its own means the server accepted the message — never
          that the guardian&apos;s phone showed it.
        </p>
      </InlineAlert>

      <Card>
        <SectionTitle
          right={
            <span className="text-[13px] text-slate-600">
              {meta ? `${meta.total} message${meta.total === 1 ? "" : "s"}` : ""}
            </span>
          }
        >
          Messages
        </SectionTitle>

        {messagesQuery.isLoading ? (
          <ListSkeleton rows={6} />
        ) : messagesQuery.isError ? (
          <ErrorState error={messagesQuery.error} onRetry={() => messagesQuery.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState
            title={filterCount ? "No messages match these filters" : "No messages yet"}
            description={
              filterCount
                ? "Clear a filter or widen the date range."
                : "Issue an invoice or let a reminder rule fire and it will appear here."
            }
          />
        ) : (
          <>
            <div className="hidden md:block">
              <table className="w-full border-collapse text-[14px]">
                <caption className="sr-only">
                  Message jobs{meta ? `, ${meta.total} matching, page ${meta.page} of ${meta.totalPages}` : ""}
                </caption>
                <thead>
                  <tr className="border-b border-slate-200 text-left text-[13px] uppercase tracking-wide text-slate-500">
                    <th scope="col" className="px-4 py-3 font-semibold">Scheduled / sent</th>
                    <th scope="col" className="px-4 py-3 font-semibold">Kind</th>
                    <th scope="col" className="px-4 py-3 font-semibold">Player</th>
                    <th scope="col" className="px-4 py-3 font-semibold">Guardian</th>
                    <th scope="col" className="px-4 py-3 font-semibold">Invoice</th>
                    <th scope="col" className="px-4 py-3 font-semibold">Status</th>
                    <th scope="col" className="px-4 py-3 font-semibold">Delivery</th>
                    <th scope="col" className="px-4 py-3 text-right font-semibold">Attempts</th>
                    <th scope="col" className="px-4 py-3 font-semibold">Error</th>
                    <th scope="col" className="px-4 py-3"><span className="sr-only">Open</span></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((job) => (
                    <tr key={job.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                      <td className="px-4 py-3 text-slate-700">
                        <DateText value={job.sentAt ?? job.scheduledFor} withTime />
                        <span className="block text-[12px] text-slate-500">
                          {job.sentAt ? "sent" : "scheduled"}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-slate-700">{messageKindLabel(job.kind)}</td>
                      <td className="px-4 py-3 font-semibold text-slate-900">{job.player.fullName}</td>
                      <td className="px-4 py-3 text-slate-700">
                        {job.guardian.fullName}
                        <span className="block font-mono text-[12px] text-slate-500">
                          {job.guardian.phoneMasked}
                        </span>
                      </td>
                      <td className="px-4 py-3 font-mono text-[13px] text-slate-600">
                        {job.invoice.invoiceNumber}
                      </td>
                      <td className="px-4 py-3">
                        <StatusChip status={messageStatusTone(job.status, job.skipReason)} />
                        <span className="mt-1 block text-[12px] text-slate-600">
                          {messageStatusLabel(job.status, job.skipReason && skipReasonLabel(job.skipReason))}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-slate-700">{deliveryLabel(job.deliveryState)}</td>
                      <td className="tabular px-4 py-3 text-right text-slate-700">
                        {job.attempts} / {job.maxAttempts}
                      </td>
                      <td className="px-4 py-3 text-slate-600">
                        {job.lastError ? (
                          <span title={job.lastError.code}>{job.lastError.message}</span>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Link
                          href={`/whatsapp/messages/${job.id}`}
                          className="font-semibold text-pitch-700 underline underline-offset-2"
                        >
                          Open
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <ul className="divide-y divide-slate-100 md:hidden">
              {rows.map((job) => (
                <li key={job.id}>
                  <Link href={`/whatsapp/messages/${job.id}`} className="block px-4 py-3 hover:bg-slate-50">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-[15px] font-semibold text-slate-900">
                          {job.player.fullName}
                        </p>
                        <p className="mt-0.5 text-[13px] text-slate-600">
                          {messageKindLabel(job.kind)} · <DateText value={job.sentAt ?? job.scheduledFor} withTime />
                        </p>
                      </div>
                      <StatusChip status={messageStatusTone(job.status, job.skipReason)} />
                    </div>
                    <p className="mt-2 text-[13px] text-slate-700">
                      {messageStatusLabel(job.status, job.skipReason && skipReasonLabel(job.skipReason))} ·{" "}
                      {deliveryLabel(job.deliveryState)} · {job.guardian.phoneMasked}
                    </p>
                    {job.lastError ? (
                      <p className="mt-1 text-[13px] text-red-700">{job.lastError.message}</p>
                    ) : null}
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}

        {meta && meta.total > 0 ? (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 px-4 py-3 text-[14px]">
            <p className="text-slate-600">
              Showing <span className="tabular">{rows.length}</span> of{" "}
              <span className="tabular">{meta.total}</span>
            </p>
            <div className="flex items-center gap-2">
              <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setParams({ page: String(page - 1) })}>
                Previous
              </Button>
              <span className="tabular text-slate-600">
                {meta.page} / {meta.totalPages}
              </span>
              <Button
                variant="secondary"
                size="sm"
                disabled={page >= meta.totalPages}
                onClick={() => setParams({ page: String(page + 1) })}
              >
                Next
              </Button>
            </div>
          </div>
        ) : null}
      </Card>
    </div>
  );
}

// ===========================================================================
// Reminders & templates tab (SET-05, SET-06)
// ===========================================================================
function RemindersTab() {
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<ReminderRule["kind"]>("reminder_pre_due");
  const [offsetDays, setOffsetDays] = useState("3");
  const [newActive, setNewActive] = useState(true);
  const [confirmDelete, setConfirmDelete] = useState<ReminderRule | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [body, setBody] = useState("");
  const [loadedKey, setLoadedKey] = useState<string | null>(null);

  const rulesQuery = useQuery({ queryKey: ["reminder-rules"], queryFn: set05ListReminderRules });
  const templatesQuery = useQuery({ queryKey: ["message-templates"], queryFn: set06ListMessageTemplates });

  const templates = templatesQuery.data?.data ?? [];
  const activeTemplate: MessageTemplate | null =
    templates.find((t) => t.key === (selectedKey ?? templates[0]?.key)) ?? null;

  // Load the selected template into the editor once (never clobber what the
  // owner is typing while a background refetch lands).
  if (activeTemplate && loadedKey !== activeTemplate.key) {
    setLoadedKey(activeTemplate.key);
    setBody(activeTemplate.body);
  }

  const createRule = useMutation({
    mutationFn: () =>
      set05CreateReminderRule({ kind, offsetDays: Number(offsetDays), isActive: newActive }),
    onSuccess: () => {
      setToast("Reminder rule added.");
      void queryClient.invalidateQueries({ queryKey: ["reminder-rules"] });
    },
  });

  const patchRule = useMutation({
    mutationFn: (input: { id: string; patch: Partial<Pick<ReminderRule, "kind" | "offsetDays" | "isActive">> }) =>
      set05PatchReminderRule(input.id, input.patch),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["reminder-rules"] });
    },
  });

  const deleteRule = useMutation({
    mutationFn: (id: string) => set05DeleteReminderRule(id),
    onSuccess: () => {
      setConfirmDelete(null);
      setToast("Reminder rule removed.");
      void queryClient.invalidateQueries({ queryKey: ["reminder-rules"] });
    },
  });

  const saveTemplate = useMutation({
    mutationFn: (input: { key: string; body: string }) => set06PutMessageTemplate(input.key, { body: input.body }),
    onSuccess: () => {
      setToast("Template saved.");
      void queryClient.invalidateQueries({ queryKey: ["message-templates"] });
    },
  });

  const unknownVars = activeTemplate ? unknownTemplateVars(body, activeTemplate.variables) : [];
  const createError = createRule.error instanceof ApiError ? createRule.error : null;
  const createFieldError = createError?.fieldErrors().offsetDays;
  const saveError = saveTemplate.error instanceof ApiError ? saveTemplate.error : null;

  return (
    <div className="space-y-4">
      <Card>
        <SectionTitle>Reminder rules</SectionTitle>
        {rulesQuery.isLoading ? (
          <ListSkeleton rows={4} />
        ) : rulesQuery.isError ? (
          <ErrorState error={rulesQuery.error} onRetry={() => rulesQuery.refetch()} />
        ) : (
          <>
            <ul className="divide-y divide-slate-100">
              {(rulesQuery.data?.data ?? []).length === 0 ? (
                <li>
                  <EmptyState
                    title="No reminder rules"
                    description="Add one below — nothing is sent until a rule exists and its automation is on."
                  />
                </li>
              ) : (
                (rulesQuery.data?.data ?? []).map((rule) => (
                  <li key={rule.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                    <div className="min-w-0">
                      <p className="text-[15px] font-semibold text-slate-900">
                        {rule.kind === "reminder_pre_due" ? "Pre-due reminder" : "Late (overdue) reminder"}
                      </p>
                      <p className="mt-0.5 text-[13px] text-slate-600">
                        {rule.offsetDays} {rule.offsetDays === 1 ? "day" : "days"}{" "}
                        {rule.kind === "reminder_pre_due" ? "before" : "after"} the due date
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      <Toggle
                        id={`rule-${rule.id}`}
                        label="Active"
                        checked={rule.isActive}
                        disabled={patchRule.isPending}
                        onChange={(next) => patchRule.mutate({ id: rule.id, patch: { isActive: next } })}
                      />
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setConfirmDelete(rule)}
                        aria-label={`Remove the ${rule.offsetDays}-day rule`}
                      >
                        Remove
                      </Button>
                    </div>
                  </li>
                ))
              )}
            </ul>

            <div className="grid gap-3 border-t border-slate-200 p-4 sm:grid-cols-3">
              <SelectField
                id="rule-kind"
                label="Kind"
                value={kind}
                onChange={(e) => setKind(e.target.value as ReminderRule["kind"])}
              >
                <option value="reminder_pre_due">Pre-due reminder</option>
                <option value="reminder_overdue">Late (overdue) reminder</option>
              </SelectField>
              <TextField
                id="rule-offset"
                type="number"
                min={0}
                max={60}
                label="Offset (days)"
                value={offsetDays}
                error={createFieldError}
                onChange={(e) => setOffsetDays(e.target.value)}
              />
              <div className="flex items-end">
                <Toggle id="rule-active" label="Active" checked={newActive} onChange={setNewActive} />
              </div>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 px-4 py-3">
              <p className="text-[13px] text-slate-600">
                One rule per (kind, offset) pair — the server refuses a duplicate.
              </p>
              <Button
                pending={createRule.isPending}
                disabled={offsetDays === ""}
                onClick={() => createRule.mutate()}
              >
                Add rule
              </Button>
            </div>
            {createError ? (
              <div className="px-4 pb-4">
                <InlineAlert tone="danger">{createError.message}</InlineAlert>
              </div>
            ) : null}
          </>
        )}
      </Card>

      <Card>
        <SectionTitle
          right={
            <div className="flex flex-wrap gap-1">
              {templates.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => setSelectedKey(t.key)}
                  aria-current={t.key === activeTemplate?.key ? "true" : undefined}
                  className={`touch44 cursor-pointer rounded-lg px-3 text-[13px] font-semibold ${
                    t.key === activeTemplate?.key
                      ? "bg-navy-900 text-white"
                      : "border border-slate-300 text-slate-700 hover:bg-slate-50"
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
          }
        >
          Template editor
        </SectionTitle>

        {templatesQuery.isLoading ? (
          <ListSkeleton rows={4} />
        ) : templatesQuery.isError ? (
          <ErrorState error={templatesQuery.error} onRetry={() => templatesQuery.refetch()} />
        ) : !activeTemplate ? (
          <EmptyState title="No templates" description="The message templates are set up on the server." />
        ) : (
          <div className="grid gap-4 p-4 lg:grid-cols-2">
            <div>
              <p className="mb-2 text-[13px] font-semibold uppercase tracking-wide text-slate-500">
                Variables
              </p>
              <div className="flex flex-wrap gap-1">
                {activeTemplate.variables.map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setBody((current) => `${current}{{${v}}}`)}
                    className="touch44 cursor-pointer rounded-full border border-slate-300 px-3 text-[13px] font-mono text-slate-700 hover:bg-slate-50"
                  >
                    {`{{${v}}}`}
                  </button>
                ))}
              </div>
              <div className="mt-3">
                <TextAreaField
                  id="template-body"
                  label="Message"
                  rows={8}
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  hint={`${body.length} characters`}
                  error={
                    unknownVars.length
                      ? `Unknown variable${unknownVars.length > 1 ? "s" : ""}: ${unknownVars
                          .map((v) => `{{${v}}}`)
                          .join(", ")} — the server refuses these (422).`
                      : undefined
                  }
                />
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Button
                  pending={saveTemplate.isPending}
                  disabled={unknownVars.length > 0 || body.trim().length === 0}
                  onClick={() => saveTemplate.mutate({ key: activeTemplate.key, body })}
                >
                  Save template
                </Button>
                <Button variant="secondary" onClick={() => setBody(activeTemplate.body)}>
                  Reset
                </Button>
                <span className="text-[13px] text-slate-600">
                  {templateVars(body).length} variable{templateVars(body).length === 1 ? "" : "s"} used
                </span>
              </div>
              {saveError ? (
                <div className="mt-3">
                  <InlineAlert tone="danger">{saveError.message}</InlineAlert>
                </div>
              ) : null}
            </div>

            <div>
              <p className="mb-2 text-[13px] font-semibold uppercase tracking-wide text-slate-500">
                Preview with sample values
              </p>
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
                <div className="rounded-xl bg-white p-3 text-[14px] text-slate-800 shadow-card">
                  <p className="whitespace-pre-wrap">{renderTemplate(body, SAMPLE_TEMPLATE_VALUES)}</p>
                </div>
                <p className="mt-2 text-[12px] text-slate-600">
                  Sample data only — the real message fills the guardian&apos;s own name, invoice
                  number and a short-lived link.
                </p>
              </div>
            </div>
          </div>
        )}
      </Card>

      <Modal
        open={confirmDelete !== null}
        onClose={() => setConfirmDelete(null)}
        title="Remove this reminder rule?"
        description="No further messages of this kind will be queued. Already-queued messages are not withdrawn."
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmDelete(null)}>
              Keep rule
            </Button>
            <Button
              variant="danger"
              pending={deleteRule.isPending}
              onClick={() => confirmDelete && deleteRule.mutate(confirmDelete.id)}
            >
              Remove rule
            </Button>
          </>
        }
      >
        <p className="text-[14px] text-slate-700">
          {confirmDelete
            ? `${confirmDelete.offsetDays} ${confirmDelete.offsetDays === 1 ? "day" : "days"} ${
                confirmDelete.kind === "reminder_pre_due" ? "before" : "after"
              } the due date.`
            : null}
        </p>
      </Modal>

      {toast ? <Toast message={toast} onDismiss={() => setToast(null)} /> : null}
    </div>
  );
}

// ===========================================================================
// Settings tab (SET-07)
// ===========================================================================
function SettingsTab() {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<MessagingSettings | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const settingsQuery = useQuery({ queryKey: ["messaging", "settings"], queryFn: set07GetMessagingSettings });
  const loaded = settingsQuery.data;
  if (loaded && draft === null) setDraft(loaded);

  const save = useMutation({
    mutationFn: (input: MessagingSettings) =>
      set07PatchMessagingSettings({
        sendWindowStart: input.sendWindowStart,
        sendWindowEnd: input.sendWindowEnd,
        invoiceMode: input.invoiceMode,
        pacingMinSeconds: input.pacingMinSeconds,
        pacingMaxSeconds: input.pacingMaxSeconds,
        maxPerHour: input.maxPerHour,
        optOutKeywords: input.optOutKeywords,
      }),
    onSuccess: (data) => {
      setDraft(data);
      setToast("Messaging settings saved.");
      void queryClient.invalidateQueries({ queryKey: ["messaging"] });
    },
  });

  if (settingsQuery.isLoading || !draft) return <ListSkeleton rows={4} />;
  if (settingsQuery.isError)
    return <ErrorState error={settingsQuery.error} onRetry={() => settingsQuery.refetch()} />;

  const error = save.error instanceof ApiError ? save.error : null;
  const fieldError = error?.fieldErrors() ?? {};
  const attachmentDisabled = true; // until spike S1 proves document sending

  return (
    <div className="space-y-4">
      <Card>
        <SectionTitle>Send window & pacing</SectionTitle>
        <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3">
          <TextField
            id="send-window-start"
            type="time"
            label="Send from"
            value={draft.sendWindowStart}
            error={fieldError.sendWindowStart}
            onChange={(e) => setDraft({ ...draft, sendWindowStart: e.target.value })}
          />
          <TextField
            id="send-window-end"
            type="time"
            label="Send until"
            value={draft.sendWindowEnd}
            error={fieldError.sendWindowEnd}
            onChange={(e) => setDraft({ ...draft, sendWindowEnd: e.target.value })}
          />
          <TextField
            id="max-per-hour"
            type="number"
            min={1}
            label="Max per hour"
            value={String(draft.maxPerHour)}
            error={fieldError.maxPerHour}
            onChange={(e) => setDraft({ ...draft, maxPerHour: Number(e.target.value) })}
          />
          <TextField
            id="pacing-min"
            type="number"
            min={5}
            label="Minimum gap (seconds)"
            value={String(draft.pacingMinSeconds)}
            error={fieldError.pacingMinSeconds}
            onChange={(e) => setDraft({ ...draft, pacingMinSeconds: Number(e.target.value) })}
          />
          <TextField
            id="pacing-max"
            type="number"
            min={5}
            label="Maximum gap (seconds)"
            value={String(draft.pacingMaxSeconds)}
            error={fieldError.pacingMaxSeconds}
            onChange={(e) => setDraft({ ...draft, pacingMaxSeconds: Number(e.target.value) })}
          />
        </div>
        <p className="border-t border-slate-200 px-4 py-3 text-[13px] text-slate-600">
          Messages are queued 24/7 but only sent inside the window. Pacing spreads the queue so a
          billing run of 60 invoices does not look like a broadcast.
        </p>
      </Card>

      <Card>
        <SectionTitle>Invoice mode & opt-out</SectionTitle>
        <div className="grid gap-3 p-4 sm:grid-cols-2">
          <SelectField
            id="invoice-mode"
            label="Invoice messages"
            value={draft.invoiceMode}
            error={fieldError.invoiceMode}
            onChange={(e) => setDraft({ ...draft, invoiceMode: e.target.value as MessagingSettings["invoiceMode"] })}
          >
            <option value="link">Send a link to the invoice page</option>
            <option value="attachment_and_link" disabled={attachmentDisabled}>
              Attach the PDF and send the link (not available yet)
            </option>
          </SelectField>
          <TextField
            id="opt-out-keywords"
            label="Opt-out keywords"
            hint="Comma separated. A reply matching one of these records an opt-out and stops all sends to that guardian."
            value={draft.optOutKeywords.join(", ")}
            error={fieldError.optOutKeywords}
            onChange={(e) =>
              setDraft({
                ...draft,
                optOutKeywords: e.target.value
                  .split(",")
                  .map((k) => k.trim().toUpperCase())
                  .filter(Boolean),
              })
            }
          />
        </div>
        <div className="px-4 pb-4">
          <InlineAlert tone="info" title="Why the attachment mode is disabled">
            <p>
              OpenWA is MIT with no paid tier, so document sending is a capability to prove, not to
              buy. It stays off until the spike-S1 media test passes on the deployed engine.
            </p>
          </InlineAlert>
        </div>
      </Card>

      <Card>
        <SectionTitle>Consent policy text for forms</SectionTitle>
        <div className="p-4">
          <p className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-[14px] text-slate-800">
            {draft.consentPolicyText}
          </p>
          <p className="mt-2 text-[13px] text-slate-600">
            Shown on the registration form. Consent is recorded per guardian; a revoked consent
            cancels that guardian&apos;s queued messages and is never overridden by a batch run.
          </p>
        </div>
      </Card>

      <div className="flex flex-wrap items-center gap-2">
        <Button pending={save.isPending} onClick={() => save.mutate(draft)}>
          Save settings
        </Button>
        <Button variant="secondary" disabled={!loaded} onClick={() => setDraft(loaded ?? draft)}>
          Reset
        </Button>
      </div>
      {error ? <InlineAlert tone="danger">{error.message}</InlineAlert> : null}

      {toast ? <Toast message={toast} onDismiss={() => setToast(null)} /> : null}
    </div>
  );
}

// ===========================================================================
export default function Page() {
  return (
    <RequireAuth>
      <RequirePermissions path="/whatsapp">
        <Suspense fallback={<ListSkeleton rows={6} />}>
          <WhatsappScreen />
        </Suspense>
      </RequirePermissions>
    </RequireAuth>
  );
}
