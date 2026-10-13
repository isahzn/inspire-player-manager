"use client";

// Invoice detail (PAGE_SPECIFICATIONS §7 "Invoice detail", INV-02..08).
// Owner-only. An issued invoice is an immutable snapshot (BILLING_ENGINE §1):
// this page can void it, append a NEGATIVE adjustment, stream its PDF and queue
// a WhatsApp delivery — it can never edit an amount, and it never adds Invoiced,
// Collected and Outstanding together.
//
// Idempotency (API_INTEGRATION §4): each dialog generates its key when it OPENS
// (the component mounts on open) and reuses it for every retry, so a retried
// void cannot void twice.
import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, FileText, RotateCcw } from "lucide-react";
import {
  ApiError,
  gdn01ListGuardians,
  idempotencyKey,
  inv02GetInvoice,
  inv04VoidInvoice,
  inv05AddAdjustment,
  inv06DownloadInvoicePdf,
  inv07RegenerateInvoicePdf,
  inv08SendInvoice,
  set02GetBillingSettings,
} from "@/api/client";
import type { Invoice, MessageJob } from "@/api/types";
import { RequireAuth, RequirePermissions } from "@/components/Guards";
import { PageHeader } from "@/components/PageHeader";
import { StatusChip } from "@/components/StatusChip";
import {
  BackLink,
  Button,
  Card,
  DateText,
  EmptyState,
  ErrorState,
  InlineAlert,
  ListSkeleton,
  Modal,
  MoneyText,
  SectionTitle,
  TextField,
  Toast,
  Toggle,
  buttonClass,
} from "@/components/ui";
import { invoiceStatusLabel } from "@/lib/billing";
import { formatDateRange } from "@/lib/dates";
import { openBlob } from "@/lib/download";
import { formatMoneyMinor, parseMoneyInput } from "@/lib/money";

const REASON_MIN = 5;
const REASON_MAX = 200;
/** API_INTEGRATION §9: PDF_NOT_READY is polled every 2 s for up to 20 s. */
const PDF_POLL_MS = 2000;
const PDF_POLL_LIMIT_MS = 20_000;

export default function InvoiceDetailPage() {
  return (
    <RequireAuth>
      <RequirePermissions path="/billing">
        <InvoiceDetail />
      </RequirePermissions>
    </RequireAuth>
  );
}

function InvoiceDetail() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? "";
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["invoice", id],
    queryFn: () => inv02GetInvoice(id),
    enabled: Boolean(id),
  });

  const [dialog, setDialog] = useState<"void" | "adjust" | "send" | null>(null);
  const [conflict, setConflict] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfPreparing, setPdfPreparing] = useState(false);
  const [pdfError, setPdfError] = useState<string | null>(null);

  if (query.isLoading) {
    return (
      <>
        <BackLink href="/billing">Billing</BackLink>
        <ListSkeleton rows={4} />
      </>
    );
  }
  if (query.isError || !query.data) {
    return (
      <>
        <BackLink href="/billing">Billing</BackLink>
        <Card>
          <ErrorState error={query.error} onRetry={() => query.refetch()} />
        </Card>
      </>
    );
  }

  const invoice = query.data;
  const isVoid = invoice.status === "void";
  const items = invoice.items ?? [];
  const allocations = invoice.allocations ?? [];
  const statusLabel = invoiceStatusLabel(invoice);

  async function refresh() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["invoice", id] }),
      queryClient.invalidateQueries({ queryKey: ["invoices"] }),
      queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
    ]);
  }

  async function downloadPdf() {
    setPdfError(null);
    setPdfBusy(true);
    setPdfPreparing(false);
    const deadline = Date.now() + PDF_POLL_LIMIT_MS;
    try {
      for (;;) {
        try {
          const blob = await inv06DownloadInvoicePdf(id);
          setPdfPreparing(false);
          openBlob(blob, `${invoice.invoiceNumber}.pdf`);
          return;
        } catch (err) {
          const notReady =
            err instanceof ApiError && (err.code === "PDF_NOT_READY" || err.status === 409);
          if (!notReady) throw err;
          if (Date.now() >= deadline) {
            setPdfError(
              "The PDF is still being prepared. Try again in a moment, or regenerate it."
            );
            return;
          }
          setPdfPreparing(true);
          await new Promise((resolve) => setTimeout(resolve, PDF_POLL_MS));
        }
      }
    } catch (err) {
      setPdfError(
        err instanceof ApiError
          ? `${err.message}${err.requestId ? ` (ref ${err.requestId})` : ""}`
          : "Could not download the PDF. Check your connection and retry."
      );
    } finally {
      setPdfBusy(false);
      setPdfPreparing(false);
    }
  }

  async function regeneratePdf() {
    setPdfError(null);
    setPdfBusy(true);
    try {
      await inv07RegenerateInvoicePdf(id);
      await refresh();
      setToast("PDF queued — it is rebuilt from the invoice snapshot.");
    } catch (err) {
      setPdfError(
        err instanceof ApiError
          ? `${err.message}${err.requestId ? ` (ref ${err.requestId})` : ""}`
          : "Could not regenerate the PDF. Please retry."
      );
    } finally {
      setPdfBusy(false);
    }
  }

  return (
    <>
      <BackLink href="/billing">Billing</BackLink>
      <PageHeader
        title={invoice.invoiceNumber}
        sub={`${invoice.player.fullName} · ${invoice.player.registrationNo} · ${invoice.ageGroup.name}`}
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <StatusChip status={statusLabel} />
        {invoice.isOverdue && invoice.daysOverdue > 0 ? (
          <span className="text-[13px] font-semibold text-red-700">
            {invoice.daysOverdue} {invoice.daysOverdue === 1 ? "day" : "days"} overdue
          </span>
        ) : null}
        <span className="tabular rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[12px] font-semibold text-slate-700">
          Balance <MoneyText minor={invoice.balanceMinor} />
        </span>
        {invoice.kind === "manual" ? (
          <span className="rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[12px] font-semibold text-slate-700">
            Manual invoice
          </span>
        ) : null}
      </div>

      {isVoid ? (
        <div className="mb-4">
          <InlineAlert tone="warning" title="This invoice is void">
            <p>
              Voided with reason: &ldquo;{invoice.voidReason ?? "not recorded"}&rdquo;. A void invoice
              never counts in outstanding, keeps its number, and its amounts cannot be edited — the
              correction is a new invoice.
            </p>
          </InlineAlert>
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <SectionTitle>Period and dates</SectionTitle>
          <dl className="divide-y divide-slate-100 p-4 text-[14px]">
            <Row label="Billing period" value={formatDateRange(invoice.periodStart, invoice.periodEnd)} />
            <Row label="Issued" value={<DateText value={invoice.issueDate} />} />
            <Row label="Due" value={<DateText value={invoice.dueDate} />} />
            <Row
              label="Guardian billed"
              value={invoice.guardian?.fullName ?? "Not recorded"}
            />
            <Row label="Currency" value={invoice.currency} />
          </dl>
        </Card>

        <Card>
          <SectionTitle>Amounts (LKR)</SectionTitle>
          <dl className="divide-y divide-slate-100 p-4 text-[14px]">
            <Row label="Subtotal" value={<MoneyText minor={invoice.subtotalMinor} full />} />
            <Row label="Adjustments" value={<MoneyText minor={invoice.adjustmentsMinor} full />} />
            <Row label="Total" value={<MoneyText minor={invoice.totalMinor} full />} />
            <Row label="Paid" value={<MoneyText minor={invoice.paidMinor} full />} />
            <Row label="Balance" value={<MoneyText minor={invoice.balanceMinor} full />} />
          </dl>
        </Card>
      </div>

      <p className="mt-4 text-[13px] text-slate-600">
        Invoiced, collected and outstanding are separate figures everywhere in this system — they are
        never summed into a single number.
      </p>

      <Card className="mt-4">
        <SectionTitle>Items</SectionTitle>
        {items.length === 0 ? (
          <EmptyState
            title="No itemised lines came back for this invoice"
            description="The totals above are the invoice's own snapshot. Nothing is guessed or reconstructed here — if lines are expected, this is a contract gap to report."
          />
        ) : (
          <>
            {/* < 640 px: each line is a card (PAGE_SPECIFICATIONS §0 tables rule). */}
            <ul className="divide-y divide-slate-100 sm:hidden">
              {items.map((item) => (
                <li key={item.id} className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <p className="text-[15px] font-semibold text-slate-900">{item.description}</p>
                    <MoneyText minor={item.amountMinor} />
                  </div>
                  <p className="mt-1 text-[13px] text-slate-600">
                    Line {item.lineNo} · {item.itemType === "adjustment" ? "Adjustment" : "Fee"} ·{" "}
                    {item.quantity} × {formatMoneyMinor(item.unitAmountMinor)}
                  </p>
                  {item.reason ? (
                    <p className="mt-1 text-[13px] text-slate-600">Reason: {item.reason}</p>
                  ) : null}
                </li>
              ))}
            </ul>
            <div className="hidden overflow-x-auto sm:block">
              <table className="w-full text-left text-[14px]">
                <caption className="sr-only">Invoice lines</caption>
                <thead className="border-b border-slate-200 text-[13px] text-slate-600">
                  <tr>
                    <th scope="col" className="px-4 py-3 font-semibold">
                      #
                    </th>
                    <th scope="col" className="px-4 py-3 font-semibold">
                      Description
                    </th>
                    <th scope="col" className="px-4 py-3 font-semibold">
                      Qty
                    </th>
                    <th scope="col" className="px-4 py-3 font-semibold">
                      Unit
                    </th>
                    <th scope="col" className="px-4 py-3 text-right font-semibold">
                      Amount
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => (
                    <tr key={item.id} className="border-b border-slate-100 last:border-0">
                      <td className="px-4 py-3 text-slate-600">{item.lineNo}</td>
                      <td className="px-4 py-3">
                        <span className="font-medium text-slate-900">{item.description}</span>
                        {item.reason ? (
                          <span className="block text-[13px] text-slate-600">{item.reason}</span>
                        ) : null}
                      </td>
                      <td className="px-4 py-3">{item.quantity}</td>
                      <td className="px-4 py-3">
                        <MoneyText minor={item.unitAmountMinor} />
                      </td>
                      <td className="px-4 py-3 text-right">
                        <MoneyText minor={item.amountMinor} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Card>

      <Card className="mt-4">
        <SectionTitle right={<span className="text-[13px] text-slate-600">Allocations</span>}>
          Payments against this invoice
        </SectionTitle>
        {allocations.length === 0 ? (
          <div className="p-4">
            {invoice.paidMinor > 0 ? (
              <InlineAlert tone="warning" title="Paid amount without allocation detail">
                This invoice shows <MoneyText minor={invoice.paidMinor} /> paid, but no allocations
                came back from the API. The balance is the invoice&apos;s own figure — no allocation
                is assumed here.
              </InlineAlert>
            ) : (
              <p className="text-[14px] text-slate-600">
                No payment has been allocated to this invoice yet. Money only counts once a payment is
                recorded and confirmed.
              </p>
            )}
          </div>
        ) : (
          <ul aria-label="Allocations" className="divide-y divide-slate-100">
            {allocations.map((allocation) => (
              <li
                key={allocation.id}
                className="flex flex-wrap items-center justify-between gap-2 p-4"
              >
                <div className="min-w-0">
                  <p className="text-[14px] font-semibold text-slate-900">
                    <MoneyText minor={allocation.amountMinor} />
                    {allocation.reversedAt ? (
                      <span className="ml-2 rounded-full border border-slate-200 bg-slate-100 px-2 py-0.5 text-[12px] font-semibold text-slate-600">
                        Reversed
                      </span>
                    ) : null}
                  </p>
                  <p className="text-[13px] text-slate-600">
                    Allocated <DateText value={allocation.allocatedAt} withTime />
                    {allocation.reversedAt ? (
                      <>
                        {" "}
                        · reversed <DateText value={allocation.reversedAt} withTime />
                      </>
                    ) : null}
                  </p>
                </div>
                <Link
                  href={`/payments/${allocation.paymentId}`}
                  className="text-[14px] font-semibold text-pitch-700 underline underline-offset-2"
                >
                  Open payment
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {pdfError ? (
        <div className="mt-4">
          <InlineAlert tone="danger" title="PDF">
            {pdfError}
          </InlineAlert>
        </div>
      ) : null}

      <Card className="mt-4">
        <SectionTitle>PDF</SectionTitle>
        <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
          <Button
            id="invoice-pdf"
            variant="secondary"
            onClick={() => void downloadPdf()}
            pending={pdfBusy}
          >
            <Download className="h-4 w-4" aria-hidden="true" />
            Download PDF
          </Button>
          <Button
            id="invoice-pdf-regenerate"
            variant="ghost"
            onClick={() => void regeneratePdf()}
            pending={pdfBusy}
          >
            <RotateCcw className="h-4 w-4" aria-hidden="true" />
            Regenerate PDF
          </Button>
          <p className="text-[13px] text-slate-600">
            {pdfPreparing
              ? "Preparing PDF…"
              : invoice.hasPdf
                ? "Regenerating rebuilds the PDF from the invoice snapshot only — no figure changes."
                : "No PDF has been generated for this invoice yet. Regenerate to build it from the snapshot."}
          </p>
        </div>
      </Card>

      <Card className="mt-4">
        <SectionTitle>Actions</SectionTitle>
        {isVoid ? (
          <div className="p-4">
            <p className="text-[14px] text-slate-600">
              Every money action is closed on a void invoice. If this invoice is still needed, issue a
              new one (a void invoice keeps its number and is never reused). Sending it to a guardian
              is disabled for the same reason.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-2 p-4 sm:flex-row sm:flex-wrap">
            <Link
              id="invoice-record-payment"
              href={`/payments/new?invoiceId=${invoice.id}${
                invoice.guardian?.id ? `&guardianId=${invoice.guardian.id}` : ""
              }`}
              className={buttonClass("primary")}
            >
              Record payment
            </Link>
            <Button id="invoice-send" variant="secondary" onClick={() => setDialog("send")}>
              <FileText className="h-4 w-4" aria-hidden="true" />
              Send via WhatsApp
            </Button>
            <Button id="invoice-adjust" variant="secondary" onClick={() => setDialog("adjust")}>
              Add discount / waiver
            </Button>
            <Button id="invoice-void" variant="danger" onClick={() => setDialog("void")}>
              Void invoice
            </Button>
          </div>
        )}
      </Card>

      <div className="mt-4 flex flex-wrap gap-2">
        <Link href={`/players/${invoice.player.id}`} className={buttonClass("secondary", "sm")}>
          Open player
        </Link>
        <Link
          href={`/billing?q=${encodeURIComponent(invoice.player.registrationNo)}`}
          className={buttonClass("secondary", "sm")}
        >
          This player&apos;s invoices
        </Link>
      </div>

      <VoidDialog
        invoice={dialog === "void" ? invoice : null}
        onClose={() => setDialog(null)}
        onVoided={async (message) => {
          setDialog(null);
          await refresh();
          setToast(message);
        }}
        onConflict={() => {
          setDialog(null);
          setConflict(true);
        }}
      />

      <AdjustDialog
        invoice={dialog === "adjust" ? invoice : null}
        onClose={() => setDialog(null)}
        onAdjusted={async (message) => {
          setDialog(null);
          await refresh();
          setToast(message);
        }}
        onConflict={() => {
          setDialog(null);
          setConflict(true);
        }}
      />

      <SendDialog
        invoice={dialog === "send" ? invoice : null}
        onClose={() => setDialog(null)}
        onQueued={async () => {
          await refresh();
        }}
      />

      <Modal
        open={conflict}
        onClose={() => setConflict(false)}
        title="Someone else changed this"
        description="This invoice changed after you opened it, so your change was not applied — nothing here overwrites the other person's work."
        footer={
          <>
            <Button variant="secondary" onClick={() => setConflict(false)}>
              Close
            </Button>
            <Button
              onClick={() => {
                void query.refetch();
                setConflict(false);
              }}
            >
              Reload this invoice
            </Button>
          </>
        }
      >
        <p className="text-[14px] text-slate-700">
          Reload to see the current version, then repeat your change on top of it.
        </p>
      </Modal>

      {toast ? <Toast message={toast} onDismiss={() => setToast(null)} /> : null}
    </>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-wrap justify-between gap-2 py-2">
      <dt className="text-slate-600">{label}</dt>
      <dd className="font-medium text-slate-900">{value}</dd>
    </div>
  );
}

/** INV-04. Reason required; release-vs-credit and re-issue are the owner's calls. */
function VoidDialog({
  invoice,
  onClose,
  onVoided,
  onConflict,
}: {
  invoice: Invoice | null;
  onClose: () => void;
  onVoided: (message: string) => void;
  onConflict: () => void;
}) {
  // The key belongs to this dialog instance: it is created when the dialog
  // opens and reused for every retry (API_INTEGRATION §4).
  const [key] = useState(() => idempotencyKey());
  const [reason, setReason] = useState("");
  const [releaseAllocations, setReleaseAllocations] = useState(false);
  const [allowReissue, setAllowReissue] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | undefined>();
  const [pending, setPending] = useState(false);

  if (!invoice) return null;
  const allocations = invoice.allocations ?? [];
  const hasAllocations = allocations.length > 0;

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!invoice) return;
    const trimmed = reason.trim();
    if (trimmed.length < REASON_MIN) {
      setFieldError(`A reason is required (at least ${REASON_MIN} characters)`);
      return;
    }
    if (trimmed.length > REASON_MAX) {
      setFieldError(`Keep the reason under ${REASON_MAX} characters`);
      return;
    }
    setFieldError(undefined);
    setError(null);
    setPending(true);
    try {
      const updated = await inv04VoidInvoice(
        invoice.id,
        { reason: trimmed, releaseAllocations, allowReissue, version: invoice.version },
        key
      );
      onVoided(`${updated.invoiceNumber} voided. It no longer counts in outstanding.`);
    } catch (err) {
      if (err instanceof ApiError && err.code === "VERSION_CONFLICT") {
        onConflict();
        return;
      }
      if (err instanceof ApiError && err.code === "INVOICE_HAS_ALLOCATIONS") {
        setError(
          "This invoice has payments allocated to it. Tick “Release payments to credit” to void it — the payments then stay on the payer as credit."
        );
        return;
      }
      const fields = err instanceof ApiError ? err.fieldErrors() : {};
      if (fields.reason) {
        setFieldError(fields.reason);
        return;
      }
      setError(
        err instanceof ApiError
          ? `${err.message}${err.requestId ? ` (ref ${err.requestId})` : ""}`
          : "Could not void the invoice. Check your connection and retry."
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Void invoice"
      description={`${invoice.invoiceNumber} · ${invoice.player.fullName}`}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="void-invoice-form" variant="danger" pending={pending}>
            {pending ? "Voiding…" : "Void invoice"}
          </Button>
        </>
      }
    >
      <form id="void-invoice-form" onSubmit={onSubmit} className="space-y-4">
        {error ? (
          <InlineAlert tone="danger" title="Could not void this invoice">
            {error}
          </InlineAlert>
        ) : null}
        <InlineAlert tone="warning" title="What voiding does">
          The invoice stops counting in outstanding and cannot be edited afterwards. It keeps its
          number (numbers are never reused) and its history stays in the audit log.
        </InlineAlert>
        <TextField
          id="void-reason"
          label="Reason"
          required
          value={reason}
          error={fieldError}
          onChange={(event) => setReason(event.target.value)}
          hint={`Shown in the audit log. ${REASON_MIN}–${REASON_MAX} characters.`}
        />
        {hasAllocations ? (
          <>
            <Toggle
              id="void-release"
              label="Release payments to credit"
              checked={releaseAllocations}
              onChange={setReleaseAllocations}
              hint={`${allocations.length} allocation${allocations.length === 1 ? "" : "s"} paid ${formatMoneyMinor(
                invoice.paidMinor
              )} against this invoice. Released money stays on the payer as credit — it is never lost.`}
            />
            {!releaseAllocations ? (
              <InlineAlert tone="info" title="Needed here">
                Without releasing, the server refuses the void because money is allocated to this
                invoice.
              </InlineAlert>
            ) : null}
          </>
        ) : null}
        <Toggle
          id="void-reissue"
          label="Allow re-issue"
          checked={allowReissue}
          onChange={setAllowReissue}
          hint="Off by default: the daily billing run will not recreate an invoice for this player and period. Turn it on only if you intend to issue this period again."
        />
      </form>
    </Modal>
  );
}

/** INV-05. Negative adjustment only — an issued invoice is never increased. */
function AdjustDialog({
  invoice,
  onClose,
  onAdjusted,
  onConflict,
}: {
  invoice: Invoice | null;
  onClose: () => void;
  onAdjusted: (message: string) => void;
  onConflict: () => void;
}) {
  const [key] = useState(() => idempotencyKey());
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);

  // Whole-rupee rule comes from the academy's own settings (BILLING_ENGINE §2).
  const settingsQuery = useQuery({
    queryKey: ["billing-settings"],
    queryFn: () => set02GetBillingSettings(),
    staleTime: 5 * 60_000,
    enabled: Boolean(invoice),
  });
  const allowFractional = settingsQuery.data?.allowFractionalMoney ?? true;

  if (!invoice) return null;
  const balance = invoice.balanceMinor;
  const parsed = parseMoneyInput(amount, { allowFractional });

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!invoice) return;
    const next: Record<string, string> = {};
    if ("error" in parsed) next.amountMinor = parsed.error;
    else if (parsed.minor > balance) {
      next.amountMinor = `Cannot be more than the balance (${formatMoneyMinor(balance)})`;
    }
    if (reason.trim().length < REASON_MIN) {
      next.reason = `A reason is required (at least ${REASON_MIN} characters)`;
    } else if (reason.trim().length > REASON_MAX) {
      next.reason = `Keep the reason under ${REASON_MAX} characters`;
    }
    setFieldErrors(next);
    if (Object.keys(next).length > 0 || "error" in parsed) return;
    setError(null);
    setPending(true);
    try {
      const updated = await inv05AddAdjustment(
        invoice.id,
        { amountMinor: -parsed.minor, reason: reason.trim(), version: invoice.version },
        key
      );
      onAdjusted(
        `Discount of ${formatMoneyMinor(parsed.minor)} recorded on ${updated.invoiceNumber}. New balance ${formatMoneyMinor(
          updated.balanceMinor
        )}.`
      );
    } catch (err) {
      if (err instanceof ApiError && err.code === "VERSION_CONFLICT") {
        onConflict();
        return;
      }
      const fields = err instanceof ApiError ? err.fieldErrors() : {};
      if (Object.keys(fields).length > 0) {
        setFieldErrors(fields);
        return;
      }
      setError(
        err instanceof ApiError
          ? `${err.message}${err.requestId ? ` (ref ${err.requestId})` : ""}`
          : "Could not record the discount. Check your connection and retry."
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Add discount"
      description={`${invoice.invoiceNumber} · balance ${formatMoneyMinor(balance)}`}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="adjust-invoice-form" pending={pending}>
            {pending ? "Recording…" : "Record discount"}
          </Button>
        </>
      }
    >
      <form id="adjust-invoice-form" onSubmit={onSubmit} className="space-y-4">
        {error ? (
          <InlineAlert tone="danger" title="Could not record the discount">
            {error}
          </InlineAlert>
        ) : null}
        <InlineAlert tone="info" title="Only ever a reduction">
          An issued invoice is never increased. A wrong amount is voided and re-issued — this dialog
          only appends a negative adjustment, up to the remaining balance.
        </InlineAlert>
        <TextField
          id="adjust-amount"
          label="Discount amount"
          required
          inputMode="decimal"
          value={amount}
          error={fieldErrors.amountMinor}
          onChange={(event) => setAmount(event.target.value)}
          hint={
            allowFractional
              ? "Rupees, e.g. 2000 or 2000.50. Sent as a negative amount."
              : "Whole rupees only — this academy records amounts without cents."
          }
        />
        <TextField
          id="adjust-reason"
          label="Reason"
          required
          value={reason}
          error={fieldErrors.reason}
          onChange={(event) => setReason(event.target.value)}
          hint={`Kept with the invoice and shown on the PDF. ${REASON_MIN}–${REASON_MAX} characters.`}
        />
        {"minor" in parsed && parsed.minor > 0 && parsed.minor <= balance ? (
          <p className="rounded-xl bg-slate-50 px-4 py-3 text-[14px] text-slate-700">
            New total {formatMoneyMinor(invoice.totalMinor - parsed.minor)} · new balance{" "}
            {formatMoneyMinor(balance - parsed.minor)}
            {balance - parsed.minor === 0 ? " — this invoice becomes paid." : ""}
          </p>
        ) : null}
      </form>
    </Modal>
  );
}

/** One guardian row in the send dialog. `phone` is absent when the list did not
 *  load and we fall back to the invoice's own guardian entry. */
type SendTarget = {
  id: string;
  fullName: string;
  phone?: string;
  consent: "unknown" | "granted" | "revoked";
};

/** INV-08. Reports queued vs skipped honestly — a skipped job is never "sent". */
function SendDialog({
  invoice,
  onClose,
  onQueued,
}: {
  invoice: Invoice | null;
  onClose: () => void;
  onQueued: () => Promise<void>;
}) {
  const [key] = useState(() => idempotencyKey());
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [result, setResult] = useState<MessageJob[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const playerId = invoice?.player.id ?? "";
  const guardiansQuery = useQuery({
    queryKey: ["guardians", { page: 1 }],
    queryFn: () => gdn01ListGuardians({ page: 1 }),
    staleTime: 5 * 60_000,
    enabled: Boolean(invoice),
  });

  if (!invoice) return null;

  const all = guardiansQuery.data?.data ?? [];
  const linked: SendTarget[] = all
    .filter((guardian) => guardian.players.some((player) => player.id === playerId))
    .map((guardian) => ({
      id: guardian.id,
      fullName: guardian.fullName,
      phone: guardian.phone,
      consent: guardian.whatsappConsent,
    }));
  // Fall back to the invoice's own guardian: the list may not have loaded, and
  // "no consent recorded" is then stated plainly instead of assumed.
  const targets: SendTarget[] =
    linked.length > 0
      ? linked
      : invoice.guardian
        ? [
            {
              id: invoice.guardian.id,
              fullName: invoice.guardian.fullName,
              consent: "unknown",
            },
          ]
        : [];

  const isSelected = (id: string) =>
    selected[id] ?? (invoice.guardian ? id === invoice.guardian.id : true);
  const chosen = targets.filter((target) => isSelected(target.id));
  const revoked = chosen.filter((target) => target.consent === "revoked");

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!invoice) return;
    if (chosen.length === 0) {
      setError("Choose at least one guardian to send to.");
      return;
    }
    setError(null);
    setPending(true);
    try {
      const response = await inv08SendInvoice(
        invoice.id,
        { guardianIds: chosen.map((target) => target.id) },
        key
      );
      setResult(response.messageJobs);
      await onQueued();
    } catch (err) {
      setError(
        err instanceof ApiError
          ? `${err.message}${err.requestId ? ` (ref ${err.requestId})` : ""}`
          : "Could not queue the message. Check your connection and retry."
      );
    } finally {
      setPending(false);
    }
  }

  const queuedJobs = (result ?? []).filter((job) => job.status !== "skipped");
  const skippedJobs = (result ?? []).filter((job) => job.status === "skipped");

  return (
    <Modal
      open
      onClose={onClose}
      title="Send invoice"
      description={`${invoice.invoiceNumber} · ${invoice.player.fullName}`}
      footer={
        result ? (
          <Button variant="secondary" onClick={onClose}>
            Done
          </Button>
        ) : (
          <>
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" form="send-invoice-form" pending={pending}>
              {pending ? "Queueing…" : "Send via WhatsApp"}
            </Button>
          </>
        )
      }
    >
      {result ? (
        <div className="space-y-3">
          <InlineAlert
            tone={queuedJobs.length > 0 ? "info" : "warning"}
            title={
              queuedJobs.length > 0
                ? `${queuedJobs.length} message${queuedJobs.length === 1 ? "" : "s"} queued`
                : "Nothing was queued"
            }
          >
            <p>
              Queued means the message is waiting to be sent. It is <strong>not</strong> delivered —
              delivery is only ever reported by the provider.
            </p>
          </InlineAlert>
          {skippedJobs.length > 0 ? (
            <div>
              <p className="text-[14px] font-semibold text-slate-900">
                Skipped ({skippedJobs.length})
              </p>
              <ul aria-label="Skipped messages" className="mt-1 divide-y divide-slate-100 text-[14px]">
                {skippedJobs.map((job) => (
                  <li key={job.id} className="py-2">
                    <span className="font-medium text-slate-900">{job.guardian.fullName}</span> —{" "}
                    {job.skipReason ?? "skipped"}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : (
        <form id="send-invoice-form" onSubmit={onSubmit} className="space-y-4">
          {error ? (
            <InlineAlert tone="danger" title="Could not queue the message">
              {error}
            </InlineAlert>
          ) : null}
          <p className="text-[14px] text-slate-700">
            Choose who receives {invoice.invoiceNumber}. Only guardians with WhatsApp consent are
            queued; the rest are reported as skipped.
          </p>
          {guardiansQuery.isLoading ? (
            <ListSkeleton rows={2} />
          ) : targets.length === 0 ? (
            <InlineAlert tone="warning" title="No guardian on file">
              This player has no guardian recorded, so there is nobody to send to.
            </InlineAlert>
          ) : (
            <ul className="divide-y divide-slate-100">
              {targets.map((target) => (
                <li key={target.id} className="py-2">
                  <Toggle
                    id={`send-guardian-${target.id}`}
                    label={`${target.fullName}${target.phone ? ` · ${target.phone}` : ""}`}
                    checked={isSelected(target.id)}
                    onChange={(next) =>
                      setSelected((current) => ({ ...current, [target.id]: next }))
                    }
                    hint={
                      target.consent === "granted"
                        ? "Consent granted."
                        : target.consent === "revoked"
                          ? "Consent revoked — this message will be skipped, not sent."
                          : "Consent not recorded — it will be skipped unless you have consent."
                    }
                  />
                </li>
              ))}
            </ul>
          )}
          {revoked.length > 0 ? (
            <InlineAlert tone="warning" title="Consent revoked">
              {revoked.length} selected guardian{revoked.length === 1 ? "" : "s"} opted out. The
              request still goes through, and the skipped jobs come back with the reason — nothing is
              sent to a guardian who has not consented.
            </InlineAlert>
          ) : null}
          <p className="text-[13px] text-slate-600">
            The message body comes from the invoice-delivery template; sending is also gated by the
            WhatsApp automation switches and the connection state (Step 6).
          </p>
        </form>
      )}
    </Modal>
  );
}
