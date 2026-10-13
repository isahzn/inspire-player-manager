"use client";

// /whatsapp/messages/[id] — MSG-02..05 (PAGE_SPECIFICATIONS §9, ROUTES §1).
//
// The row's own status/delivery words, the rendered text, the event timeline and
// the four owner actions: Retry (MSG-03), Cancel (MSG-04), Mark sent manually
// (MSG-05) and the copy / wa.me fallback. Two things this page refuses to do:
// · it never shows "Delivered" or "Read" unless the provider reported that ack
//   (`deliveryLabel` owns the mapping; OpenWA's is unconfirmed — spike S1);
// · it never pretends "Mark sent manually" is a provider confirmation. It
//   records the owner's own claim and stops the retries — nothing more.
import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, ExternalLink, RotateCcw, Send, XCircle } from "lucide-react";
import {
  ApiError,
  gdn01ListGuardians,
  idempotencyKey,
  msg02GetMessage,
  msg03RetryMessage,
  msg04CancelMessage,
  msg05ManualFallback,
} from "@/api/client";
import type { MessageJob } from "@/api/types";
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
  TextAreaField,
  Toast,
} from "@/components/ui";
import {
  deliveryIsUnproven,
  deliveryLabel,
  messageKindLabel,
  messageStatusLabel,
  messageStatusTone,
  skipReasonLabel,
  waMeLink,
} from "@/lib/messaging";

const RETRYABLE: MessageJob["status"][] = ["failed", "dead", "needs_review"];
const CANCELLABLE: MessageJob["status"][] = ["queued", "failed"];

function MessageDetail() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? "";
  const queryClient = useQueryClient();

  // The replay key is taken ONCE for this page, so a double-click on Retry
  // replays the same request instead of queueing a second send (MSG-03 `Idem`).
  const [retryKey] = useState(() => idempotencyKey());
  const [manualOpen, setManualOpen] = useState(false);
  const [manualNote, setManualNote] = useState("");
  const [toast, setToast] = useState<string | null>(null);

  const messageQuery = useQuery({
    queryKey: ["message", id],
    queryFn: () => msg02GetMessage(id),
    enabled: id.length > 0,
  });
  const job = messageQuery.data;

  // The contract only ever gives the browser a MASKED guardian phone, so a real
  // wa.me link needs the guardian record itself (GDN-01). If it is not there, the
  // copy path still works and the link is simply not offered.
  const guardianQuery = useQuery({
    queryKey: ["guardians", { q: job?.guardian.fullName }],
    queryFn: () => gdn01ListGuardians({ q: job?.guardian.fullName, page: 1 }),
    enabled: Boolean(job?.guardian.fullName),
  });
  const guardianPhone =
    guardianQuery.data?.data.find((g) => g.id === job?.guardian.id)?.phone ?? null;

  const applyJob = (next: MessageJob) => {
    queryClient.setQueryData(["message", id], next);
    void queryClient.invalidateQueries({ queryKey: ["messages"] });
    void queryClient.invalidateQueries({ queryKey: ["messaging", "status"] });
  };

  const retry = useMutation({
    mutationFn: () => msg03RetryMessage(id, retryKey),
    onSuccess: (next) => {
      applyJob(next);
      setToast("Retry queued. The message keeps its place and is not sent twice.");
    },
  });

  const cancel = useMutation({
    mutationFn: () => msg04CancelMessage(id),
    onSuccess: (next) => {
      applyJob(next);
      setToast("Message cancelled.");
    },
  });

  const manual = useMutation({
    mutationFn: () => msg05ManualFallback(id, { note: manualNote.trim() || undefined }),
    onSuccess: (next) => {
      applyJob(next);
      setManualOpen(false);
      setManualNote("");
      setToast("Recorded that you sent this yourself. Automatic retries are stopped.");
    },
  });

  if (messageQuery.isLoading) return <ListSkeleton rows={5} />;
  if (messageQuery.isError)
    return <ErrorState error={messageQuery.error} onRetry={() => messageQuery.refetch()} />;
  if (!job) return <EmptyState title="Message not found" description="It may have been removed." />;

  const retryError = retry.error instanceof ApiError ? retry.error : null;
  const cancelError = cancel.error instanceof ApiError ? cancel.error : null;
  const canRetry = RETRYABLE.includes(job.status);
  const canCancel = CANCELLABLE.includes(job.status);
  const bodyText = job.renderedBody ?? "";

  return (
    <>
      <PageHeader
        title={messageKindLabel(job.kind)}
        sub={`${job.player.fullName} · guardian ${job.guardian.fullName} (${job.guardian.phoneMasked})`}
        actions={
          <Link
            href="/whatsapp?tab=messages"
            className="min-h-[44px] inline-flex items-center text-[14px] font-semibold text-pitch-700 underline underline-offset-2"
          >
            All messages
          </Link>
        }
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card>
            <SectionTitle
              right={
                <div className="flex flex-wrap items-center gap-2">
                  <StatusChip status={messageStatusTone(job.status, job.skipReason)} />
                  <StatusChip status={deliveryLabel(job.deliveryState)} />
                </div>
              }
            >
              Message
            </SectionTitle>
            <div className="space-y-3 p-4">
              <dl className="grid gap-3 text-[14px] sm:grid-cols-2">
                <Field label="Status">
                  {messageStatusLabel(job.status, job.skipReason ? skipReasonLabel(job.skipReason) : undefined)}
                </Field>
                <Field label="Delivery">{deliveryLabel(job.deliveryState)}</Field>
                <Field label="Invoice">
                  <Link
                    href={`/billing/invoices/${job.invoice.id}`}
                    className="font-semibold text-pitch-700 underline underline-offset-2"
                  >
                    {job.invoice.invoiceNumber}
                  </Link>
                </Field>
                <Field label="Attempts">
                  {job.attempts} of {job.maxAttempts}
                </Field>
                <Field label="Scheduled">
                  <DateText value={job.scheduledFor} withTime />
                </Field>
                <Field label="Sent">
                  {job.sentAt ? <DateText value={job.sentAt} withTime /> : "—"}
                </Field>
                {job.nextAttemptAt ? (
                  <Field label="Next attempt">
                    <DateText value={job.nextAttemptAt} withTime />
                  </Field>
                ) : null}
                {job.manualFallback ? (
                  <Field label="Sent manually">
                    <DateText value={job.manualFallback.at} withTime /> by {job.manualFallback.by}
                    {job.manualFallback.note ? ` — ${job.manualFallback.note}` : ""}
                  </Field>
                ) : null}
              </dl>

              {deliveryIsUnproven(job.deliveryState) ? (
                <InlineAlert tone="info" title="What this delivery state means">
                  <p>
                    The provider has not reported that the guardian&apos;s phone received this
                    message. <strong>Delivered</strong> and <strong>Read</strong> are only shown
                    when the provider reports that acknowledgement, and mapping those events is
                    unverified until spike S1 lands.
                  </p>
                </InlineAlert>
              ) : null}

              {job.lastError ? (
                <InlineAlert
                  tone={job.status === "dead" ? "danger" : "warning"}
                  title={job.status === "dead" ? "Failed permanently" : "Last error"}
                >
                  <p>{job.lastError.message}</p>
                  <p className="mt-1 font-mono text-[12px]">{job.lastError.code}</p>
                </InlineAlert>
              ) : null}

              <div>
                <p className="mb-1 text-[13px] font-semibold uppercase tracking-wide text-slate-500">
                  Message as it was rendered
                </p>
                {bodyText ? (
                  <p className="whitespace-pre-wrap rounded-xl border border-slate-200 bg-slate-50 p-3 text-[14px] text-slate-800">
                    {bodyText}
                  </p>
                ) : (
                  <p className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-[14px] text-slate-600">
                    The rendered text is only kept for jobs that were rendered. Nothing is guessed
                    at here.
                  </p>
                )}
              </div>

              <div className="flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  onClick={() => {
                    void navigator.clipboard
                      .writeText(bodyText)
                      .then(() => setToast("Message copied."))
                      .catch(() => setToast("Copy failed — select the text and copy it by hand."));
                  }}
                  disabled={!bodyText}
                >
                  <Copy className="h-4 w-4" aria-hidden="true" />
                  Copy message
                </Button>
                {guardianPhone ? (
                  <a
                    href={waMeLink(guardianPhone, bodyText)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="min-h-[44px] inline-flex items-center justify-center gap-2 rounded-xl border border-slate-300 bg-white px-4 text-[15px] font-semibold text-slate-800 hover:bg-slate-50"
                  >
                    <ExternalLink className="h-4 w-4" aria-hidden="true" />
                    Open wa.me
                  </a>
                ) : (
                  <span className="self-center text-[13px] text-slate-600">
                    wa.me needs the guardian&apos;s number, which the browser is not given — copy
                    the text and send it from your own WhatsApp.
                  </span>
                )}
              </div>
            </div>
          </Card>

          <Card>
            <SectionTitle>What you can do</SectionTitle>
            <div className="space-y-3 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  pending={retry.isPending}
                  disabled={!canRetry}
                  onClick={() => retry.mutate()}
                >
                  <RotateCcw className="h-4 w-4" aria-hidden="true" />
                  Retry
                </Button>
                <Button
                  variant="secondary"
                  pending={cancel.isPending}
                  disabled={!canCancel}
                  onClick={() => cancel.mutate()}
                >
                  <XCircle className="h-4 w-4" aria-hidden="true" />
                  Cancel
                </Button>
                <Button variant="secondary" onClick={() => setManualOpen(true)}>
                  <Send className="h-4 w-4" aria-hidden="true" />
                  Mark sent manually
                </Button>
              </div>
              <p className="text-[13px] text-slate-600">
                Retry is offered for <em>Failed</em>, <em>Needs review</em> and{" "}
                <em>Failed permanently</em> — retrying re-checks consent and the invoice state
                first. Cancel is offered while the message is <em>Queued</em> or <em>Failed</em>.
              </p>

              {retryError ? (
                <InlineAlert tone="danger" title="Cannot retry this message">
                  {retryError.message}
                </InlineAlert>
              ) : null}
              {cancelError ? (
                <InlineAlert tone="danger" title="Cannot cancel this message">
                  {cancelError.message}
                </InlineAlert>
              ) : null}

              <InlineAlert tone="info" title="Manual fallback is your own claim">
                <p>
                  &quot;Mark sent manually&quot; records that <em>you</em> sent the message from
                  your own WhatsApp and stops the retries. It is not a provider acknowledgement,
                  so the Delivery column stays <em>Unknown</em>.
                </p>
              </InlineAlert>
            </div>
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <SectionTitle>Events</SectionTitle>
            {job.events && job.events.length > 0 ? (
              <ol className="space-y-3 p-4">
                {job.events.map((event, i) => (
                  <li key={`${event.eventType}-${event.at}-${i}`} className="flex gap-3">
                    <span
                      aria-hidden="true"
                      className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-pitch-600"
                    />
                    <div className="min-w-0">
                      <p className="text-[14px] font-semibold text-slate-900">
                        {event.eventType}
                      </p>
                      <p className="text-[13px] text-slate-600">
                        <DateText value={event.at} withTime />
                        {typeof event.providerAck === "number"
                          ? ` · provider ack ${event.providerAck}`
                          : ""}
                      </p>
                    </div>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="px-4 py-6 text-[14px] text-slate-600">
                No provider events recorded for this message.
              </p>
            )}
          </Card>

          <Card>
            <SectionTitle>Reminders</SectionTitle>
            <p className="px-4 py-4 text-[13px] text-slate-600">
              Delivery is never inferred from &quot;Sent&quot;, and a message that was skipped stays
              skipped: re-enabling an automation in Settings does not send anything that was
              missed. Running low on delivery reports? Check the connection on the{" "}
              <Link href="/whatsapp" className="font-semibold text-pitch-700 underline underline-offset-2">
                Status tab
              </Link>
              .
            </p>
          </Card>
        </div>
      </div>

      <Modal
        open={manualOpen}
        onClose={() => setManualOpen(false)}
        title="Mark this message sent manually"
        description="Use this after you have sent the text yourself (copy it above). Automatic retries stop."
        footer={
          <>
            <Button variant="secondary" onClick={() => setManualOpen(false)}>
              Cancel
            </Button>
            <Button
              pending={manual.isPending}
              onClick={() => manual.mutate()}
            >
              <Check className="h-4 w-4" aria-hidden="true" />
              Mark sent manually
            </Button>
          </>
        }
      >
        <TextAreaField
          id="manual-note"
          label="Note (optional)"
          hint="E.g. “sent from my phone, guardian replied”."
          value={manualNote}
          onChange={(e) => setManualNote(e.target.value)}
        />
        {manual.error instanceof ApiError ? (
          <div className="mt-3">
            <InlineAlert tone="danger">{manual.error.message}</InlineAlert>
          </div>
        ) : null}
      </Modal>

      {toast ? <Toast message={toast} onDismiss={() => setToast(null)} /> : null}
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[12px] font-semibold uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-0.5 text-slate-800">{children}</dd>
    </div>
  );
}

export default function Page() {
  return (
    <RequireAuth>
      <RequirePermissions path="/whatsapp">
        <MessageDetail />
      </RequirePermissions>
    </RequireAuth>
  );
}
