"use client";

// Billing hub (PAGE_SPECIFICATIONS §7, ROUTES_AND_NAVIGATION §1): the Invoices
// tab (INV-01) and the Runs tab (BIL-03).
//
// Money rules that are visible in this file on purpose:
// · Invoiced, collected and outstanding are separate figures everywhere — this
//   screen never sums them into one number (BILLING_ENGINE §14).
// · The KPI cards are computed from the LOADED page and say so, because
//   `Page<Invoice>` carries no totals (raised as contract drift in the Step 3
//   handoff §4 and again for coach hours in Step 4).
// · A payment proof is evidence, never a payment: nothing here prints the word
//   "verified", and no chip stands in for an owner's confirmation.
//
// Filter/tab/sort/page state lives in the URL so it is shareable and
// back-button safe, and two quick changes merge into the query that was
// actually requested (the stale-URL race fixed twice already — see
// src/app/players/page.tsx).
import { Suspense, useCallback, useDeferredValue, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, FileText, MessageCircle, Plus } from "lucide-react";
import {
  ApiError,
  bil03ListRuns,
  grp01ListAgeGroups,
  idempotencyKey,
  inv01ListInvoices,
  inv06DownloadInvoicePdf,
  inv08SendInvoice,
} from "@/api/client";
import type { Invoice, MessageJob } from "@/api/types";
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
  MoneyText,
  SectionTitle,
  TextField,
  Toast,
  Toggle,
  buttonClass,
} from "@/components/ui";
import { invoiceStatusLabel } from "@/lib/billing";
import { formatDateRange, formatDateStr } from "@/lib/dates";
import { openBlob } from "@/lib/download";
import { formatMoneyMinor } from "@/lib/money";

const PAGE_SIZE = 25;

/** INV-01 `sort` whitelist (API_CONTRACTS §3.6). */
const SORT_OPTIONS: { value: string; label: string }[] = [
  { value: "dueDate", label: "Due date (soonest first)" },
  { value: "-dueDate", label: "Due date (latest first)" },
  { value: "-issueDate", label: "Issued (newest first)" },
  { value: "issueDate", label: "Issued (oldest first)" },
  { value: "invoiceNumber", label: "Invoice number" },
  { value: "-balanceMinor", label: "Balance (largest first)" },
  { value: "playerName", label: "Player name" },
];

const STATUSES = ["issued", "partially_paid", "paid", "void"] as const;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Why a message job was not queued. The contract fixes the JOB statuses but not
 * the `skipReason` strings, so unknown values are printed as they came (never
 * guessed at) — raised as contract drift in the Step 5 handoff.
 */
function skipReasonText(reason?: string): string {
  switch (reason) {
    case "SESSION_NOT_CONNECTED":
      return "WhatsApp is not connected — the session is waiting for a QR scan.";
    case "NO_CONSENT":
      return "This guardian has not given WhatsApp consent.";
    case "AUTOMATION_DISABLED":
      return "Automatic invoice delivery is switched off.";
    case "MASTER_PAUSED":
      return "Messaging is paused.";
    case "INVOICE_VOID":
      return "The invoice is void.";
    case "NO_PHONE":
      return "No phone number is recorded for this guardian.";
    default:
      return reason ? `Skipped (${reason}).` : "Skipped.";
  }
}

function BillingHub() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();

  const tab = searchParams.get("tab") === "runs" ? "runs" : "invoices";
  const q = searchParams.get("q") ?? "";
  const status = searchParams.get("status") ?? "";
  const overdue = searchParams.get("overdue") === "true";
  const ageGroupId = searchParams.get("ageGroupId") ?? "";
  const issueFrom = searchParams.get("issueFrom") ?? "";
  const issueTo = searchParams.get("issueTo") ?? "";
  const sort = searchParams.get("sort") ?? "dueDate";
  const page = Math.max(1, Number(searchParams.get("page") ?? "1") || 1);

  const deferredQ = useDeferredValue(q);

  // URL-first state: while a write is in flight, merge into the query we asked
  // for so a second change cannot undo the first (see players/page.tsx).
  const lastWrite = useRef<{ query: string; at: number } | null>(null);
  const renderedQuery = searchParams.toString();

  const setParams = useCallback(
    (patch: Record<string, string | null>, opts: { keepPage?: boolean } = {}) => {
      const inFlight = lastWrite.current;
      const pending =
        Boolean(inFlight) &&
        Date.now() - (inFlight?.at ?? 0) < 1500 &&
        inFlight?.query !== renderedQuery;
      const next = new URLSearchParams(pending ? (inFlight?.query ?? "") : renderedQuery);
      for (const [key, value] of Object.entries(patch)) {
        if (value === null || value === "") next.delete(key);
        else next.set(key, value);
      }
      if (!opts.keepPage && !("page" in patch)) next.delete("page");
      const query = next.toString();
      lastWrite.current = { query, at: Date.now() };
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [pathname, renderedQuery, router]
  );

  const invoicesQuery = useQuery({
    queryKey: [
      "invoices",
      { q: deferredQ, status, overdue, ageGroupId, issueFrom, issueTo, sort, page },
    ],
    queryFn: () =>
      inv01ListInvoices({
        // The contract applies `q` from 2 characters.
        q: deferredQ.trim().length >= 2 ? deferredQ.trim() : undefined,
        status: status ? (status as Invoice["status"]) : undefined,
        overdue: overdue || undefined,
        ageGroupId: ageGroupId || undefined,
        issueFrom: issueFrom || undefined,
        issueTo: issueTo || undefined,
        sort,
        page,
        pageSize: PAGE_SIZE,
      }),
    enabled: tab === "invoices",
    placeholderData: (previous) => previous,
  });

  const groupsQuery = useQuery({
    queryKey: ["age-groups", { includeArchived: false }],
    queryFn: () => grp01ListAgeGroups({ includeArchived: false }),
  });

  const runsQuery = useQuery({
    queryKey: ["billing-runs", { page: 1 }],
    queryFn: () => bil03ListRuns({ page: 1, pageSize: PAGE_SIZE }),
    enabled: tab === "runs",
  });

  const [toast, setToast] = useState<string | null>(null);
  const [pdfBusyId, setPdfBusyId] = useState<string | null>(null);
  const [pdfNote, setPdfNote] = useState<{ id: string; text: string; tone: "info" | "danger" } | null>(
    null
  );
  const [sendTarget, setSendTarget] = useState<Invoice | null>(null);

  const rows = invoicesQuery.data?.data ?? [];
  const meta = invoicesQuery.data?.meta;
  const filtersActive = Boolean(q || status || overdue || ageGroupId || issueFrom || issueTo);

  // Outstanding / overdue over the loaded page only — labelled as such.
  const pageOutstanding = rows
    .filter((invoice) => invoice.status !== "void")
    .reduce((sum, invoice) => sum + invoice.balanceMinor, 0);
  const overdueRows = rows.filter((invoice) => invoice.isOverdue && invoice.status !== "void");
  const pageOverdue = overdueRows.reduce((sum, invoice) => sum + invoice.balanceMinor, 0);

  /**
   * INV-06: stream the PDF and open it from an object URL (API_INTEGRATION §9 —
   * one method everywhere, no stored signed URLs). `409 PDF_NOT_READY` means the
   * job is still running: poll every 2 s for up to 20 s.
   */
  async function handleDownloadPdf(invoice: Invoice) {
    setPdfBusyId(invoice.id);
    setPdfNote(null);
    try {
      const blob = await inv06DownloadInvoicePdf(invoice.id);
      openBlob(blob, `${invoice.invoiceNumber}.pdf`);
    } catch (error) {
      if (error instanceof ApiError && error.code === "PDF_NOT_READY") {
        setPdfNote({ id: invoice.id, text: "Preparing PDF…", tone: "info" });
        for (let attempt = 0; attempt < 10; attempt += 1) {
          await sleep(2000);
          try {
            const blob = await inv06DownloadInvoicePdf(invoice.id);
            openBlob(blob, `${invoice.invoiceNumber}.pdf`);
            setPdfNote(null);
            return;
          } catch (retryError) {
            const stillPreparing =
              retryError instanceof ApiError && retryError.code === "PDF_NOT_READY";
            if (!stillPreparing) {
              setPdfNote({
                id: invoice.id,
                text:
                  retryError instanceof ApiError
                    ? retryError.message
                    : "The PDF could not be prepared. Please retry.",
                tone: "danger",
              });
              return;
            }
          }
        }
        setPdfNote({
          id: invoice.id,
          text: "The PDF is still being prepared. Retry in a moment, or ask for a regeneration.",
          tone: "danger",
        });
        return;
      }
      setPdfNote({
        id: invoice.id,
        text:
          error instanceof ApiError ? error.message : "The PDF could not be prepared. Please retry.",
        tone: "danger",
      });
    } finally {
      setPdfBusyId(null);
    }
  }

  return (
    <>
      <PageHeader
        title="Billing"
        sub="Issue invoices from a preview, then collect against them. Issued invoices are immutable — correct one by voiding or by a negative adjustment."
        actions={
          <>
            <Link href="/billing/invoices/new" className={buttonClass("secondary", "sm")}>
              <FileText className="h-4 w-4" aria-hidden="true" />
              Manual invoice
            </Link>
            <Link href="/billing/new" className={buttonClass("primary", "sm")}>
              <Plus className="h-4 w-4" aria-hidden="true" />
              New billing run
            </Link>
          </>
        }
      />

      <div className="mb-4 flex gap-1 overflow-x-auto border-b border-slate-200">
        {[
          { key: "invoices", label: "Invoices" },
          { key: "runs", label: "Runs" },
        ].map((item) => {
          const selected = tab === item.key;
          return (
            <button
              key={item.key}
              id={`billing-tab-${item.key}`}
              role="tab"
              type="button"
              aria-selected={selected}
              onClick={() => setParams({ tab: item.key === "invoices" ? null : item.key })}
              className={`touch44 -mb-px shrink-0 cursor-pointer border-b-2 px-3 py-2 text-[14px] font-semibold ${
                selected
                  ? "border-pitch-600 text-pitch-700"
                  : "border-transparent text-slate-600 hover:text-slate-900"
              }`}
            >
              {item.label}
            </button>
          );
        })}
      </div>

      {tab === "invoices" ? (
        <>
          <div className="mb-4 grid gap-4 sm:grid-cols-2">
            <Card className="p-4">
              <p className="text-[13px] font-semibold uppercase tracking-wide text-slate-500">
                Outstanding
              </p>
              <p className="tabular mt-1 text-2xl font-semibold text-slate-900">
                {formatMoneyMinor(pageOutstanding)}
              </p>
              <p className="mt-1 text-[12px] text-slate-500">
                From the invoices shown on this page — the contract carries no totals for a page.
              </p>
            </Card>
            <Card className="p-4">
              <p className="text-[13px] font-semibold uppercase tracking-wide text-slate-500">
                Overdue
              </p>
              <p className="tabular mt-1 text-2xl font-semibold text-red-700">
                {formatMoneyMinor(pageOverdue)}
              </p>
              <p className="mt-1 text-[12px] text-slate-500">
                {overdueRows.length} {overdueRows.length === 1 ? "invoice" : "invoices"} past the due
                date, of those shown. As of now — never mixed with invoiced or collected.
              </p>
            </Card>
          </div>

          <Card className="mb-4">
            <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3">
              <TextField
                id="invoice-q"
                label="Search"
                placeholder="Invoice no., player or guardian"
                value={q}
                onChange={(event) => setParams({ q: event.target.value || null })}
                hint="Two characters or more."
              />
              <div>
                <label
                  htmlFor="invoice-status"
                  className="mb-1 block text-[14px] font-semibold text-slate-800"
                >
                  Status
                </label>
                <select
                  id="invoice-status"
                  value={status}
                  onChange={(event) => setParams({ status: event.target.value || null })}
                  className="h-12 w-full rounded-xl border border-slate-300 bg-white px-3 text-[16px]"
                >
                  <option value="">All statuses</option>
                  {STATUSES.map((value) => (
                    <option key={value} value={value}>
                      {value === "partially_paid" ? "Partially paid" : value.charAt(0).toUpperCase() + value.slice(1)}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label
                  htmlFor="invoice-group"
                  className="mb-1 block text-[14px] font-semibold text-slate-800"
                >
                  Age group
                </label>
                <select
                  id="invoice-group"
                  value={ageGroupId}
                  onChange={(event) => setParams({ ageGroupId: event.target.value || null })}
                  className="h-12 w-full rounded-xl border border-slate-300 bg-white px-3 text-[16px]"
                >
                  <option value="">All groups</option>
                  {(groupsQuery.data?.data ?? []).map((group) => (
                    <option key={group.id} value={group.id}>
                      {group.name}
                    </option>
                  ))}
                </select>
              </div>
              <TextField
                id="invoice-issue-from"
                label="Issued from"
                type="date"
                value={issueFrom}
                onChange={(event) => setParams({ issueFrom: event.target.value || null })}
              />
              <TextField
                id="invoice-issue-to"
                label="Issued to"
                type="date"
                value={issueTo}
                onChange={(event) => setParams({ issueTo: event.target.value || null })}
              />
              <div>
                <label
                  htmlFor="invoice-sort"
                  className="mb-1 block text-[14px] font-semibold text-slate-800"
                >
                  Sort
                </label>
                <select
                  id="invoice-sort"
                  value={sort}
                  onChange={(event) => setParams({ sort: event.target.value })}
                  className="h-12 w-full rounded-xl border border-slate-300 bg-white px-3 text-[16px]"
                >
                  {SORT_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex items-end">
                <Toggle
                  id="invoice-overdue"
                  label="Overdue only"
                  hint="Issued or partly paid, past the due date."
                  checked={overdue}
                  onChange={(next) => setParams({ overdue: next ? "true" : null })}
                />
              </div>
            </div>
            {filtersActive ? (
              <div className="border-t border-slate-200 px-4 py-2">
                <button
                  type="button"
                  className="cursor-pointer text-[13px] font-semibold text-pitch-700 underline underline-offset-2"
                  onClick={() =>
                    setParams({
                      q: null,
                      status: null,
                      overdue: null,
                      ageGroupId: null,
                      issueFrom: null,
                      issueTo: null,
                    })
                  }
                >
                  Clear filters
                </button>
              </div>
            ) : null}
          </Card>

          <Card>
            {invoicesQuery.isLoading ? (
              <ListSkeleton rows={6} />
            ) : invoicesQuery.isError ? (
              <ErrorState error={invoicesQuery.error} onRetry={() => invoicesQuery.refetch()} />
            ) : rows.length === 0 ? (
              <EmptyState
                title={filtersActive ? "No invoices match these filters" : "No invoices yet"}
                description={
                  filtersActive
                    ? "Try a different status, group or date range."
                    : "Issue the first invoices from a billing run, or create a one-off manual invoice."
                }
                action={
                  <div className="flex flex-wrap justify-center gap-2">
                    <Link href="/billing/new" className={buttonClass("primary")}>
                      New billing run
                    </Link>
                    <Link href="/billing/invoices/new" className={buttonClass("secondary")}>
                      Manual invoice
                    </Link>
                  </div>
                }
              />
            ) : (
              <>
                {/* Desktop table (≥ 640 px) */}
                <div className="hidden md:block">
                  <table className="w-full border-collapse text-[14px]">
                    <caption className="sr-only">
                      Invoices
                      {meta ? `, ${meta.total} matching, page ${meta.page} of ${meta.totalPages}` : ""}
                    </caption>
                    <thead>
                      <tr className="border-b border-slate-200 text-left text-[13px] uppercase tracking-wide text-slate-500">
                        <th scope="col" className="px-4 py-3 font-semibold">Invoice</th>
                        <th scope="col" className="px-4 py-3 font-semibold">Player</th>
                        <th scope="col" className="px-4 py-3 font-semibold">Guardian</th>
                        <th scope="col" className="px-4 py-3 font-semibold">Group</th>
                        <th scope="col" className="px-4 py-3 font-semibold">Period</th>
                        <th scope="col" className="px-4 py-3 font-semibold">Issued</th>
                        <th scope="col" className="px-4 py-3 font-semibold">Due</th>
                        <th scope="col" className="px-4 py-3 text-right font-semibold">Total</th>
                        <th scope="col" className="px-4 py-3 text-right font-semibold">Paid</th>
                        <th scope="col" className="px-4 py-3 text-right font-semibold">Balance</th>
                        <th scope="col" className="px-4 py-3 font-semibold">Status</th>
                        <th scope="col" className="px-4 py-3 font-semibold">
                          <span className="sr-only">Actions</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((invoice) => (
                        <tr key={invoice.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                          <td className="px-4 py-3 font-mono text-[13px] text-slate-700">
                            <Link
                              href={`/billing/invoices/${invoice.id}`}
                              className="font-semibold text-pitch-700 underline underline-offset-2"
                            >
                              {invoice.invoiceNumber}
                            </Link>
                          </td>
                          <td className="px-4 py-3 text-slate-900">{invoice.player.fullName}</td>
                          <td className="px-4 py-3 text-slate-700">{invoice.guardian?.fullName ?? "—"}</td>
                          <td className="px-4 py-3 text-slate-700">{invoice.ageGroup.name}</td>
                          <td className="px-4 py-3 text-slate-700">
                            {formatDateRange(invoice.periodStart, invoice.periodEnd)}
                          </td>
                          <td className="px-4 py-3 text-slate-700">{formatDateStr(invoice.issueDate)}</td>
                          <td className="px-4 py-3 text-slate-700">
                            {formatDateStr(invoice.dueDate)}
                            {invoice.isOverdue && invoice.daysOverdue > 0 ? (
                              <span className="ml-1 font-semibold text-red-700">
                                ({invoice.daysOverdue}d late)
                              </span>
                            ) : null}
                          </td>
                          <td className="tabular px-4 py-3 text-right text-slate-700">
                            <MoneyText minor={invoice.totalMinor} />
                          </td>
                          <td className="tabular px-4 py-3 text-right text-slate-700">
                            <MoneyText minor={invoice.paidMinor} />
                          </td>
                          <td className="tabular px-4 py-3 text-right font-semibold text-slate-900">
                            <MoneyText minor={invoice.balanceMinor} />
                          </td>
                          <td className="px-4 py-3">
                            <StatusChip status={invoiceStatusLabel(invoice)} />
                          </td>
                          <td className="px-4 py-3">
                            <InvoiceActions
                              invoice={invoice}
                              pdfBusy={pdfBusyId === invoice.id}
                              onSend={() => setSendTarget(invoice)}
                              onPdf={() => handleDownloadPdf(invoice)}
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Mobile cards (< 640 px) */}
                <ul aria-label="Invoices" className="divide-y divide-slate-100 md:hidden">
                  {rows.map((invoice) => (
                    <li key={invoice.id} className="px-4 py-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="font-mono text-[13px] font-semibold text-slate-900">
                            {invoice.invoiceNumber}
                          </p>
                          <p className="mt-0.5 truncate text-[15px] text-slate-900">
                            {invoice.player.fullName}
                          </p>
                          <p className="mt-0.5 text-[13px] text-slate-600">
                            {invoice.ageGroup.name} · due {formatDateStr(invoice.dueDate)}
                            {invoice.isOverdue && invoice.daysOverdue > 0
                              ? ` · ${invoice.daysOverdue}d late`
                              : ""}
                          </p>
                        </div>
                        <StatusChip status={invoiceStatusLabel(invoice)} />
                      </div>
                      <p className="tabular mt-2 text-[13px] text-slate-700">
                        Total <MoneyText minor={invoice.totalMinor} /> · Paid{" "}
                        <MoneyText minor={invoice.paidMinor} /> · Balance{" "}
                        <span className="font-semibold text-slate-900">
                          <MoneyText minor={invoice.balanceMinor} />
                        </span>
                      </p>
                      <div className="mt-2">
                        <InvoiceActions
                          invoice={invoice}
                          pdfBusy={pdfBusyId === invoice.id}
                          onSend={() => setSendTarget(invoice)}
                          onPdf={() => handleDownloadPdf(invoice)}
                        />
                      </div>
                    </li>
                  ))}
                </ul>

                {meta && meta.total > 0 ? (
                  <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 px-4 py-3 text-[14px]">
                    <p className="text-slate-600">
                      Showing <span className="tabular">{rows.length}</span> of{" "}
                      <span className="tabular">{meta.total}</span> invoices
                      {q ? " matching" : ""}
                    </p>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={page <= 1}
                        onClick={() => setParams({ page: String(page - 1) }, { keepPage: true })}
                      >
                        Previous
                      </Button>
                      <span className="tabular text-slate-600">
                        {meta.page} / {meta.totalPages}
                      </span>
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={page >= meta.totalPages}
                        onClick={() => setParams({ page: String(page + 1) }, { keepPage: true })}
                      >
                        Next
                      </Button>
                    </div>
                  </div>
                ) : null}
              </>
            )}
          </Card>

          {pdfNote ? (
            <div className="mt-3">
              <InlineAlert tone={pdfNote.tone === "danger" ? "danger" : "info"}>
                {pdfNote.text}
              </InlineAlert>
            </div>
          ) : null}
        </>
      ) : (
        <Card>
          {runsQuery.isLoading ? (
            <ListSkeleton rows={5} />
          ) : runsQuery.isError ? (
            <ErrorState error={runsQuery.error} onRetry={() => runsQuery.refetch()} />
          ) : (runsQuery.data?.data ?? []).length === 0 ? (
            <EmptyState
              title="No billing runs yet"
              description="A run previews who will be invoiced, then issues the invoices in one transaction — nothing is stored until you issue."
              action={
                <Link href="/billing/new" className={buttonClass("primary")}>
                  New billing run
                </Link>
              }
            />
          ) : (
            <>
              <SectionTitle
                right={
                  <Link href="/billing/new" className={buttonClass("secondary", "sm")}>
                    New run
                  </Link>
                }
              >
                Billing runs
              </SectionTitle>
              <table className="w-full border-collapse text-[14px]">
                <caption className="sr-only">Billing runs</caption>
                <thead>
                  <tr className="border-b border-slate-200 text-left text-[13px] uppercase tracking-wide text-slate-500">
                    <th scope="col" className="px-4 py-3 font-semibold">Run key</th>
                    <th scope="col" className="px-4 py-3 font-semibold">Target date</th>
                    <th scope="col" className="px-4 py-3 text-right font-semibold">Created</th>
                    <th scope="col" className="px-4 py-3 text-right font-semibold">Skipped</th>
                    <th scope="col" className="px-4 py-3 font-semibold">Status</th>
                    <th scope="col" className="px-4 py-3 font-semibold">Started</th>
                  </tr>
                </thead>
                <tbody>
                  {(runsQuery.data?.data ?? []).map((run) => (
                    <tr key={run.id} className="border-b border-slate-100 last:border-0">
                      <td className="px-4 py-3 font-mono text-[13px] text-slate-700">{run.runKey}</td>
                      <td className="px-4 py-3 text-slate-700">{formatDateStr(run.targetDate)}</td>
                      <td className="tabular px-4 py-3 text-right font-semibold text-slate-900">
                        {run.invoicesCreated}
                      </td>
                      <td className="tabular px-4 py-3 text-right text-slate-700">
                        {run.invoicesSkipped}
                      </td>
                      <td className="px-4 py-3">
                        <StatusChip
                          status={run.status.charAt(0).toUpperCase() + run.status.slice(1)}
                        />
                      </td>
                      <td className="px-4 py-3 text-slate-700">{formatDateStr(run.startedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="border-t border-slate-200 px-4 py-3 text-[13px] text-slate-600">
                A run is a record of what happened, not a draft: re-running the same period reports
                every player as already invoiced instead of creating a second invoice.
              </p>
            </>
          )}
        </Card>
      )}

      {toast ? <Toast message={toast} onDismiss={() => setToast(null)} /> : null}

      {sendTarget ? (
        <SendInvoiceDialog
          invoice={sendTarget}
          onClose={() => setSendTarget(null)}
          onQueued={(message) => {
            // The dialog stays open so the owner can read the per-job result;
            // the queue itself is refetched once they close it.
            setToast(message);
            queryClient.invalidateQueries({ queryKey: ["invoices"] });
            queryClient.invalidateQueries({ queryKey: ["messages"] });
          }}
        />
      ) : null}
    </>
  );
}

/** Row actions. Every target is ≥ 44 px and the words match PAGE_SPEC §7. */
function InvoiceActions({
  invoice,
  pdfBusy,
  onSend,
  onPdf,
}: {
  invoice: Invoice;
  pdfBusy: boolean;
  onSend: () => void;
  onPdf: () => void;
}) {
  const moneyActionsDisabled = invoice.status === "void";
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Link
        href={`/billing/invoices/${invoice.id}`}
        className="touch44 inline-flex min-h-[44px] items-center font-semibold text-pitch-700 underline underline-offset-2"
      >
        Open
      </Link>
      {moneyActionsDisabled ? (
        <span className="text-[13px] text-slate-500">Void — no money actions</span>
      ) : (
        <>
          <Link
            href={`/payments/new?invoiceId=${invoice.id}${
              invoice.guardian ? `&guardianId=${invoice.guardian.id}` : ""
            }`}
            className="touch44 inline-flex min-h-[44px] items-center font-semibold text-slate-700 underline underline-offset-2"
          >
            Record payment
          </Link>
          <Button variant="ghost" size="sm" onClick={onSend}>
            <MessageCircle className="h-4 w-4" aria-hidden="true" />
            Send WhatsApp
          </Button>
          <Button variant="ghost" size="sm" onClick={onPdf} pending={pdfBusy}>
            <Download className="h-4 w-4" aria-hidden="true" />
            Download PDF
          </Button>
        </>
      )}
    </div>
  );
}

/** INV-08 — guardian picker + the honest result of the enqueue. */
function SendInvoiceDialog({
  invoice,
  onClose,
  onQueued,
}: {
  invoice: Invoice;
  onClose: () => void;
  /** Called once per successful enqueue so the parent can refresh and toast. */
  onQueued: (message: string) => void;
}) {
  // The key belongs to this dialog instance: a retry reuses it (API_INTEGRATION §4).
  const keyRef = useRef(idempotencyKey());
  const [selected, setSelected] = useState<string[]>(invoice.guardian ? [invoice.guardian.id] : []);
  const [alert, setAlert] = useState<string | null>(null);
  const [jobs, setJobs] = useState<MessageJob[] | null>(null);

  const mutation = useMutation({
    mutationFn: () =>
      inv08SendInvoice(
        invoice.id,
        { guardianIds: selected.length ? selected : undefined },
        keyRef.current
      ),
    onSuccess: (result) => {
      setJobs(result.messageJobs);
      const queued = result.messageJobs.filter((job) => job.status === "queued").length;
      const skipped = result.messageJobs.length - queued;
      onQueued(
        queued === 0
          ? `Nothing was queued — ${skipped} ${skipped === 1 ? "message was" : "messages were"} skipped.`
          : `${queued} ${queued === 1 ? "message" : "messages"} queued${skipped ? `, ${skipped} skipped` : ""}.`
      );
    },
    onError: (error) => {
      setAlert(
        error instanceof ApiError ? error.message : "Could not queue the message. Please retry."
      );
    },
  });

  const guardians = invoice.guardian ? [invoice.guardian] : [];

  return (
    <Modal
      open
      onClose={onClose}
      title="Send invoice"
      description={`${invoice.invoiceNumber} · ${invoice.player.fullName}`}
      footer={
        <>
          <Button variant="secondary" type="button" onClick={onClose}>
            Close
          </Button>
          <Button
            type="button"
            onClick={() => mutation.mutate()}
            pending={mutation.isPending}
            disabled={jobs !== null}
          >
            Queue message
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {alert ? (
          <InlineAlert tone="danger" title="Could not queue the message">
            {alert}
          </InlineAlert>
        ) : null}

        {guardians.length === 0 ? (
          <InlineAlert tone="warning" title="No guardian on this invoice">
            The invoice records no guardian, so there is nobody to send it to. Add one on the player
            profile first.
          </InlineAlert>
        ) : (
          <fieldset className="space-y-2">
            <legend className="text-[14px] font-semibold text-slate-800">Send to</legend>
            {guardians.map((guardian) => (
              <label
                key={guardian.id}
                className="flex min-h-[44px] cursor-pointer items-center gap-3 text-[14px]"
              >
                <input
                  type="checkbox"
                  className="h-6 w-6 cursor-pointer rounded border-slate-400"
                  checked={selected.includes(guardian.id)}
                  onChange={(event) =>
                    setSelected(
                      event.target.checked
                        ? [...selected, guardian.id]
                        : selected.filter((id) => id !== guardian.id)
                    )
                  }
                />
                {guardian.fullName}
              </label>
            ))}
          </fieldset>
        )}

        <InlineAlert tone="info" title="What happens on send">
          The server re-checks consent, the invoice state, the master pause and the WhatsApp
          connection. A message that cannot be sent comes back as a <em>skipped</em> job with its
          reason — a skipped message has <strong>not</strong> been delivered, and nothing is sent
          retrospectively.
        </InlineAlert>

        {jobs ? (
          <div>
            <p className="text-[14px] font-semibold text-slate-900">Result</p>
            <ul aria-label="Message jobs" className="mt-2 space-y-2">
              {jobs.map((job) => (
                <li key={job.id} className="rounded-xl bg-slate-50 px-3 py-2 text-[13px]">
                  <span className="font-semibold">
                    {job.guardian.fullName} · {job.status}
                  </span>
                  <br />
                  {job.status === "queued"
                    ? "Queued for delivery. Delivery is only proved by the provider's own event — “sent” alone is not “delivered”."
                    : skipReasonText(job.skipReason)}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

export default function BillingPage() {
  return (
    <RequireAuth>
      <RequirePermissions path="/billing">
        <Suspense fallback={<ListSkeleton rows={6} />}>
          <BillingHub />
        </Suspense>
      </RequirePermissions>
    </RequireAuth>
  );
}
