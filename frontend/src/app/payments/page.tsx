"use client";

// PAY-01 payments list (PAGE_SPECIFICATIONS §8).
// Tabs All · Pending · (Verification) · With credit, filters in the URL, and the
// label discipline from lib/billing.ts: a payment's amount reads "Pending
// verification" until an owner confirms it, and a proof label describes the
// DOCUMENTS, never the money (ADR-020/ADR-021).
//
// The **Verification** tab (CR-003/CR-004) is here and is gated by
// `SET-08.proofCheck`: with the switch off it does not exist and this page
// behaves exactly as it did before. It is a VIEW — its rows never confirm,
// reject, allocate or move money, and the amount keeps reading "Pending
// verification" until an owner decides. The per-proof verification panel on the
// payment detail page remains the place findings are read in full (CR-004).
import { Suspense, useCallback, useDeferredValue, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Plus, RefreshCw } from "lucide-react";
import {
  gdn01ListGuardians,
  pay01ListPayments,
  prf04VerifyProof,
  set04ListPaymentMethods,
  set08GetAutomations,
  type PaymentListParams,
} from "@/api/client";
import type { Payment, PaymentStatus, ProofFinding, ProofMeta } from "@/api/types";
import { RequireAuth, RequirePermissions } from "@/components/Guards";
import { PageHeader } from "@/components/PageHeader";
import { StatusChip } from "@/components/StatusChip";
import {
  Button,
  Card,
  DateText,
  EmptyState,
  ErrorState,
  ListSkeleton,
  MoneyText,
  Tabs,
  TextField,
  Toast,
  buttonClass,
} from "@/components/ui";
import {
  ASK_FOR_PDF_MESSAGE,
  findingLabel,
  paymentStatusLabel,
  proofLabel,
  sortFindings,
} from "@/lib/billing";
import { academyTime, withAcademyDayRange } from "@/lib/dates";
import { copyText } from "@/lib/download";

const PAGE_SIZE = 25;

type TabKey = "all" | "pending" | "verification" | "credit";

const TABS: { key: TabKey; label: string }[] = [
  { key: "all", label: "All" },
  { key: "pending", label: "Pending" },
  { key: "credit", label: "With credit" },
];

/** Inserted between Pending and With credit — and only when the switch is on. */
const VERIFICATION_TAB: { key: TabKey; label: string } = {
  key: "verification",
  label: "Verification",
};

const STATUSES: PaymentStatus[] = ["pending", "confirmed", "rejected", "reversed"];

function tabFromParam(value: string | null): TabKey {
  return value === "pending" || value === "credit" || value === "verification" ? value : "all";
}

function emptyCopy(tab: TabKey): { title: string; description: string } {
  if (tab === "pending") {
    return {
      title: "No payments are waiting to be confirmed",
      description:
        "Bank transfers recorded for later checking show up here. A pending payment never counts towards a balance.",
    };
  }
  if (tab === "credit") {
    return {
      title: "No payment is holding credit",
      description:
        "Credit is the part of a confirmed payment that has not been allocated to an invoice. It is never applied automatically.",
    };
  }
  if (tab === "verification") {
    // The queue renders its own empty state; this is only a fallback.
    return {
      title: "Nothing to verify — all bank transfers are confirmed",
      description: "Bank transfers waiting for a decision appear here with the checks on their receipt.",
    };
  }
  return {
    title: "No payments yet",
    description: "Record the first payment — cash is recorded as confirmed, a bank transfer can wait for checking.",
  };
}

function PaymentsList() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const rawTab = tabFromParam(searchParams.get("tab"));
  const q = searchParams.get("q") ?? "";
  const statusParam = searchParams.get("status") ?? "";
  const methodCode = searchParams.get("methodCode") ?? "";
  const guardianId = searchParams.get("guardianId") ?? "";
  const from = searchParams.get("from") ?? "";
  const to = searchParams.get("to") ?? "";
  const page = Math.max(1, Number(searchParams.get("page") ?? "1") || 1);

  const deferredQ = useDeferredValue(q);

  // SET-08 gate (CR-003). While the switch is off the tab does not exist: a URL
  // that asks for it falls back to All, exactly as the page behaved before.
  const automationsQuery = useQuery({
    queryKey: ["settings", "automations"],
    queryFn: () => set08GetAutomations(),
    staleTime: 30_000,
  });
  const proofCheckOn = automationsQuery.data?.proofCheck === true;
  const tab: TabKey = rawTab === "verification" && !proofCheckOn ? "all" : rawTab;

  const visibleTabs = useMemo(
    () =>
      proofCheckOn
        ? [TABS[0], TABS[1], VERIFICATION_TAB, TABS[2]]
        : TABS,
    [proofCheckOn]
  );

  // Same write path as /players (Step 3): `router.replace` lands a moment later,
  // so two quick filter changes would otherwise each rebuild from the query the
  // browser still reports and the second would silently undo the first.
  const lastWrite = useRef<{ query: string; at: number } | null>(null);
  const renderedQuery = searchParams.toString();

  const setParams = useCallback(
    (patch: Record<string, string | null>) => {
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
      if (!("page" in patch)) next.delete("page");
      const query = next.toString();
      lastWrite.current = { query, at: Date.now() };
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [pathname, renderedQuery, router]
  );

  // The tab owns the status filter: "Pending" must mean pending on the wire, not
  // a pending tab showing confirmed rows.
  const effectiveStatus: PaymentStatus | undefined =
    tab === "pending" ? "pending" : statusParam ? (statusParam as PaymentStatus) : undefined;

  const params: PaymentListParams = {
    q: deferredQ.trim().length >= 2 ? deferredQ.trim() : undefined,
    status: effectiveStatus,
    methodCode: methodCode || undefined,
    guardianId: guardianId || undefined,
    from: from || undefined,
    to: to || undefined,
    hasCredit: tab === "credit" ? true : undefined,
    page,
    pageSize: PAGE_SIZE,
  };

  const paymentsQuery = useQuery({
    queryKey: ["payments", params],
    // PAY-01 types `from`/`to` as instants (`format: date-time`), so the picker's business
    // dates are widened to the academy-local day on the way out. Sent raw, they are a 422
    // that replaces the whole list with "Something went wrong" — 2026-10-15 audit, defect A3.
    queryFn: () => pay01ListPayments(withAcademyDayRange(params)),
    placeholderData: (previous) => previous,
    // The queue owns its own request; the list would otherwise fetch a page of
    // rows nothing on the screen shows.
    enabled: tab !== "verification",
  });

  const methodsQuery = useQuery({
    queryKey: ["payment-methods"],
    queryFn: () => set04ListPaymentMethods(),
    staleTime: 5 * 60_000,
  });

  const guardiansQuery = useQuery({
    queryKey: ["guardians", { page: 1 }],
    queryFn: () => gdn01ListGuardians({ page: 1 }),
    staleTime: 5 * 60_000,
  });

  const rows = paymentsQuery.data?.data ?? [];
  const meta = paymentsQuery.data?.meta;
  const filterCount = useMemo(
    () =>
      [q ? 1 : 0, statusParam ? 1 : 0, methodCode ? 1 : 0, guardianId ? 1 : 0, from ? 1 : 0, to ? 1 : 0].reduce(
        (a, b) => a + b,
        0
      ),
    [q, statusParam, methodCode, guardianId, from, to]
  );

  const filterBar = (
    <Card className="mb-4">
      <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3">
        <TextField
          id="payment-q"
          label="Search"
          placeholder="Payer or reference"
          value={q}
          onChange={(e) => setParams({ q: e.target.value || null })}
          hint="Two characters or more."
        />
        <div>
          <label htmlFor="payment-status" className="mb-1 block text-[14px] font-semibold text-slate-800">
            Status
          </label>
          <select
            id="payment-status"
            value={tab === "pending" ? "pending" : statusParam}
            disabled={tab === "pending"}
            onChange={(e) => setParams({ status: e.target.value || null })}
            className="h-12 w-full rounded-xl border border-slate-300 bg-white px-3 text-[16px] disabled:bg-slate-100"
          >
            <option value="">Any status</option>
            {STATUSES.map((value) => (
              <option key={value} value={value}>
                {paymentStatusLabel(value)}
              </option>
            ))}
          </select>
          {tab === "pending" ? (
            <p className="mt-1 text-[13px] text-slate-600">The Pending tab shows pending payments only.</p>
          ) : null}
        </div>
        <div>
          <label htmlFor="payment-method" className="mb-1 block text-[14px] font-semibold text-slate-800">
            Method
          </label>
          <select
            id="payment-method"
            value={methodCode}
            onChange={(e) => setParams({ methodCode: e.target.value || null })}
            className="h-12 w-full rounded-xl border border-slate-300 bg-white px-3 text-[16px]"
          >
            <option value="">Any method</option>
            {(methodsQuery.data?.data ?? []).map((method) => (
              <option key={method.code} value={method.code}>
                {method.label}
                {method.isActive ? "" : " (inactive)"}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="payment-guardian" className="mb-1 block text-[14px] font-semibold text-slate-800">
            Payer
          </label>
          <select
            id="payment-guardian"
            value={guardianId}
            onChange={(e) => setParams({ guardianId: e.target.value || null })}
            className="h-12 w-full rounded-xl border border-slate-300 bg-white px-3 text-[16px]"
          >
            <option value="">Any payer</option>
            {(guardiansQuery.data?.data ?? []).map((guardian) => (
              <option key={guardian.id} value={guardian.id}>
                {guardian.fullName}
              </option>
            ))}
          </select>
        </div>
        <TextField
          id="payment-from"
          label="Received from"
          type="date"
          value={from}
          onChange={(e) => setParams({ from: e.target.value || null })}
        />
        <TextField
          id="payment-to"
          label="Received to"
          type="date"
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
              setParams({ q: null, status: null, methodCode: null, guardianId: null, from: null, to: null })
            }
          >
            Clear filters
          </button>
        </div>
      ) : null}
    </Card>
  );

  const empty = emptyCopy(tab);

  return (
    <>
      <PageHeader
        title="Payments"
        sub="Invoiced and collected are separate figures. A payment counts only once you confirm it."
        actions={
          <Link href="/payments/new" className={buttonClass("primary", "sm")}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            Record payment
          </Link>
        }
      />

      <Tabs
        idPrefix="payments"
        tabs={visibleTabs}
        active={tab}
        onChange={(key) => setParams({ tab: key === "all" ? null : key })}
      />

      {/* The queue names its own rows; the list filters do not apply to it. */}
      {tab === "verification" ? null : <div className="mt-4">{filterBar}</div>}

      <Card>
        {tab === "verification" ? (
          <VerificationQueue />
        ) : paymentsQuery.isLoading ? (
          <ListSkeleton rows={6} />
        ) : paymentsQuery.isError ? (
          <ErrorState error={paymentsQuery.error} onRetry={() => paymentsQuery.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState
            title={filterCount > 0 ? "No payments match these filters" : empty.title}
            description={
              filterCount > 0 ? "Try a different search term or clear the filters." : empty.description
            }
            action={
              <Link href="/payments/new" className={buttonClass("primary")}>
                Record payment
              </Link>
            }
          />
        ) : (
          <>
            {/* Desktop table (≥ 640 px) */}
            <div className="hidden md:block">
              <table className="w-full border-collapse text-[14px]">
                <caption className="sr-only">
                  Payments{meta ? `, ${meta.total} matching, page ${meta.page} of ${meta.totalPages}` : ""}
                </caption>
                <thead>
                  <tr className="border-b border-slate-200 text-left text-[13px] uppercase tracking-wide text-slate-500">
                    <th scope="col" className="px-4 py-3 font-semibold">Date received</th>
                    <th scope="col" className="px-4 py-3 font-semibold">Payer</th>
                    <th scope="col" className="px-4 py-3 font-semibold">Method</th>
                    <th scope="col" className="px-4 py-3 font-semibold">Reference</th>
                    <th scope="col" className="px-4 py-3 text-right font-semibold">Amount</th>
                    <th scope="col" className="px-4 py-3 text-right font-semibold">Allocated</th>
                    <th scope="col" className="px-4 py-3 text-right font-semibold">Credit</th>
                    <th scope="col" className="px-4 py-3 font-semibold">Status</th>
                    <th scope="col" className="px-4 py-3 font-semibold">Receipt no</th>
                    <th scope="col" className="px-4 py-3"><span className="sr-only">Open</span></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((payment) => (
                    <tr key={payment.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                      <td className="px-4 py-3 text-slate-700">
                        <DateText value={payment.receivedAt} />
                        <span className="block text-[12px] text-slate-500">
                          {academyTime(payment.receivedAt)} (academy time)
                        </span>
                      </td>
                      <td className="px-4 py-3 font-semibold text-slate-900">{payerName(payment)}</td>
                      <td className="px-4 py-3 text-slate-700">{payment.method.label}</td>
                      <td className="px-4 py-3 font-mono text-[13px] text-slate-600">
                        {payment.reference ?? "—"}
                      </td>
                      <td className="tabular px-4 py-3 text-right font-semibold text-slate-900">
                        <MoneyText minor={payment.amountMinor} />
                        {payment.status === "pending" ? (
                          <span className="block text-[12px] font-medium text-amber-800">
                            Pending verification
                          </span>
                        ) : null}
                      </td>
                      <td className="tabular px-4 py-3 text-right text-slate-700">
                        <MoneyText minor={payment.allocatedMinor} />
                      </td>
                      <td className="tabular px-4 py-3 text-right text-slate-700">
                        <MoneyText minor={payment.unallocatedMinor} />
                      </td>
                      <td className="px-4 py-3">
                        <StatusChip status={paymentStatusLabel(payment.status)} />
                        <ProofNote payment={payment} />
                      </td>
                      <td className="px-4 py-3 font-mono text-[13px] text-slate-600">
                        {payment.receipt?.receiptNumber ?? "—"}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Link
                          href={`/payments/${payment.id}`}
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

            {/* Mobile cards (< 640 px) */}
            <ul aria-label="Payments" className="divide-y divide-slate-100 md:hidden">
              {rows.map((payment) => (
                <li key={payment.id}>
                  <Link href={`/payments/${payment.id}`} className="block px-4 py-3 hover:bg-slate-50">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-[15px] font-semibold text-slate-900">{payerName(payment)}</p>
                        <p className="mt-0.5 text-[13px] text-slate-600">
                          <DateText value={payment.receivedAt} /> · {payment.method.label}
                          {payment.reference ? ` · ${payment.reference}` : ""}
                        </p>
                      </div>
                      <StatusChip status={paymentStatusLabel(payment.status)} />
                    </div>
                    <p className="tabular mt-2 text-[14px] font-semibold text-slate-900">
                      <MoneyText minor={payment.amountMinor} />
                      <span className="font-normal text-slate-600">
                        {" "}
                        · credited <MoneyText minor={payment.unallocatedMinor} />
                      </span>
                    </p>
                    {payment.status === "pending" ? (
                      <p className="mt-1 text-[13px] font-medium text-amber-800">Pending verification</p>
                    ) : null}
                    <ProofNote payment={payment} />
                    <span className="mt-2 inline-block text-[13px] font-semibold text-pitch-700 underline underline-offset-2">
                      Open
                    </span>
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
              <span className="tabular">{meta.total}</span> payments
            </p>
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                disabled={page <= 1}
                onClick={() => setParams({ page: String(page - 1) })}
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
                onClick={() => setParams({ page: String(page + 1) })}
              >
                Next
              </Button>
            </div>
          </div>
        ) : null}
      </Card>

      <p className="mt-4 text-[13px] text-slate-600">
        A proof is evidence, never a payment: checks on an uploaded receipt are advice for the owner, and only a
        confirmation changes a balance (ADR-013, ADR-020, ADR-021).
      </p>
    </>
  );
}

function payerName(payment: Payment): string {
  return payment.payer?.name ?? "Not recorded";
}

// ---------------------------------------------------------------------------
// Verification queue (CR-003 / CR-004 — PAGE_SPECIFICATIONS §8)
// ---------------------------------------------------------------------------

/**
 * Bank-transfer payments that carry a proof and are still `pending`, oldest
 * first. This is a view: every action here is a read or an advisory re-check,
 * and Confirm/Reject stay on the payment's own page — nothing on this
 * screen may confirm a payment or change a balance.
 */
function useVerificationQueue() {
  const query = useQuery({
    queryKey: ["payments", "verification-queue"],
    queryFn: () =>
      pay01ListPayments({ status: "pending", page: 1, pageSize: 100 }),
  });
  const rows = useMemo(() => {
    const all = query.data?.data ?? [];
    return all
      .filter(
        (p) =>
          p.status === "pending" &&
          p.method.code === "bank_transfer" &&
          (p.proofs?.length ?? 0) > 0
      )
      // Oldest first, in the UI: `sort` syntax is not pinned in the contract and
      // a queue whose order depends on a guess would be worse than one we sort.
      .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
  }, [query.data]);
  return { query, rows };
}

function VerificationQueue() {
  const queryClient = useQueryClient();
  const { query, rows } = useVerificationQueue();
  const [toast, setToast] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const recheck = useMutation({
    mutationFn: (input: { paymentId: string; fileId: string }) =>
      prf04VerifyProof(input.paymentId, input.fileId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["payments", "verification-queue"] });
      await queryClient.invalidateQueries({ queryKey: ["payments"] });
      setToast("Check finished — findings are advice, not a decision.");
    },
    onError: () => setToast("The check could not run. Please retry."),
    onSettled: () => setBusyId(null),
  });

  async function askForPdf(payment: Payment) {
    const text = `${ASK_FOR_PDF_MESSAGE}${
      payment.reference ? ` Reference ${payment.reference}.` : ""
    }`.trim();
    const ok = await copyText(text);
    setToast(
      ok
        ? "Message copied — send it with the guardian's WhatsApp."
        : "Copy failed — select the text and copy it manually."
    );
  }

  if (query.isLoading) return <ListSkeleton rows={5} />;
  if (query.isError) {
    return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  }
  if (rows.length === 0) {
    return (
      <EmptyState
        title="Nothing to verify — all bank transfers are confirmed"
        description="A bank transfer shows up here while it is still pending and a receipt is attached. Checks describe the receipt; only you can confirm the payment."
        action={
          <Link href="/payments?tab=pending" className={buttonClass("secondary")}>
            See pending payments
          </Link>
        }
      />
    );
  }

  return (
    <>
      <div className="hidden md:block">
        <table className="w-full border-collapse text-[14px]">
          <caption className="sr-only">
            Bank transfers with a proof, pending confirmation, oldest first
          </caption>
          <thead>
            <tr className="border-b border-slate-200 text-left text-[13px] uppercase tracking-wide text-slate-500">
              <th scope="col" className="px-4 py-3 font-semibold">Received</th>
              <th scope="col" className="px-4 py-3 font-semibold">Payer</th>
              <th scope="col" className="px-4 py-3 text-right font-semibold">Amount</th>
              <th scope="col" className="px-4 py-3 font-semibold">Checks on the receipt</th>
              <th scope="col" className="px-4 py-3"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((payment) => (
              <VerificationRow
                key={payment.id}
                payment={payment}
                busy={busyId === payment.id && recheck.isPending}
                onRecheck={(fileId) => {
                  setBusyId(payment.id);
                  recheck.mutate({ paymentId: payment.id, fileId });
                }}
                onAskForPdf={() => askForPdf(payment)}
              />
            ))}
          </tbody>
        </table>
      </div>

      <ul aria-label="Verification queue" className="divide-y divide-slate-100 md:hidden">
        {rows.map((payment) => (
          <li key={payment.id} className="px-4 py-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-[15px] font-semibold text-slate-900">
                  {payerName(payment)}
                </p>
                <p className="mt-0.5 text-[13px] text-slate-600">
                  <DateText value={payment.receivedAt} /> · {payment.method.label}
                  {payment.reference ? ` · ${payment.reference}` : ""}
                </p>
              </div>
              <p className="tabular shrink-0 text-right text-[15px] font-semibold text-slate-900">
                <MoneyText minor={payment.amountMinor} />
                <span className="block text-[12px] font-medium text-amber-800">
                  Pending verification
                </span>
              </p>
            </div>
            <VerificationFacts
              payment={payment}
              busy={busyId === payment.id && recheck.isPending}
              onRecheck={(fileId) => {
                setBusyId(payment.id);
                recheck.mutate({ paymentId: payment.id, fileId });
              }}
              onAskForPdf={() => askForPdf(payment)}
              stacked
            />
            <Link
              href={`/payments/${payment.id}`}
              className="mt-3 inline-block text-[13px] font-semibold text-pitch-700 underline underline-offset-2"
            >
              Open the payment
            </Link>
          </li>
        ))}
      </ul>

      <p className="border-t border-slate-200 px-4 py-3 text-[13px] text-slate-600">
        Checks are advice, not proof: a receipt can be edited or reused, and a successful-looking
        receipt does not mean the money is still in the account. Confirming is your decision and it
        happens on the payment itself.
      </p>

      {toast ? <Toast message={toast} onDismiss={() => setToast(null)} /> : null}
    </>
  );
}

function VerificationRow({
  payment,
  busy,
  onRecheck,
  onAskForPdf,
}: {
  payment: Payment;
  busy: boolean;
  onRecheck: (fileId: string) => void;
  onAskForPdf: () => void;
}) {
  return (
    <tr className="border-b border-slate-100 align-top last:border-0 hover:bg-slate-50">
      <td className="px-4 py-3 whitespace-nowrap text-slate-700">
        <DateText value={payment.receivedAt} />
        <span className="block text-[12px] text-slate-500">
          {academyTime(payment.receivedAt)} (academy time)
        </span>
      </td>
      <td className="px-4 py-3">
        <span className="font-semibold text-slate-900">{payerName(payment)}</span>
        {payment.reference ? (
          <span className="block font-mono text-[13px] text-slate-600">{payment.reference}</span>
        ) : null}
      </td>
      <td className="tabular px-4 py-3 text-right font-semibold whitespace-nowrap text-slate-900">
        <MoneyText minor={payment.amountMinor} />
        <span className="block text-[12px] font-medium text-amber-800">Pending verification</span>
      </td>
      <td className="px-4 py-3">
        <VerificationFacts
          payment={payment}
          busy={busy}
          onRecheck={onRecheck}
          onAskForPdf={onAskForPdf}
        />
      </td>
      <td className="px-4 py-3 text-right whitespace-nowrap">
        <Link
          href={`/payments/${payment.id}`}
          className="font-semibold text-pitch-700 underline underline-offset-2"
        >
          Open
        </Link>
      </td>
    </tr>
  );
}

/** The derived label, the findings as chips, and the one-tap ask-for-the-PDF. */
function VerificationFacts({
  payment,
  busy,
  onRecheck,
  onAskForPdf,
  stacked = false,
}: {
  payment: Payment;
  busy: boolean;
  onRecheck: (fileId: string) => void;
  onAskForPdf: () => void;
  stacked?: boolean;
}) {
  const label = proofLabel(payment);
  const proofs = payment.proofs ?? [];
  const pdfProof = proofs.find((p) => p.docKind === "bank_receipt_pdf");
  const findings = sortFindings(
    proofs.flatMap((p: ProofMeta) => p.verification?.findings ?? [])
  );
  const recheckable = pdfProof ?? proofs[0];

  return (
    <div className={stacked ? "mt-2" : ""}>
      <p className={`text-[13px] font-semibold ${labelTone(label.kind)}`}>{label.text}</p>

      {findings.length > 0 ? (
        <ul aria-label="Advisory findings" className="mt-1.5 flex flex-wrap gap-1.5">
          {findings.map((finding: ProofFinding) => (
            <li key={finding.code}>
              <span
                title={finding.detail}
                className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[12px] font-semibold ${findingTone(
                  finding.result
                )}`}
              >
                <span className="sr-only">{findingLabel(finding.result)}: </span>
                {finding.code}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-[12px] text-slate-600">
          No findings yet — run a check on the receipt, or read them on the payment.
        </p>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        {label.kind === "unverifiable" ? (
          <button
            type="button"
            onClick={onAskForPdf}
            className="touch44 inline-flex min-h-[44px] cursor-pointer items-center gap-2 rounded-xl border border-slate-300 bg-white px-3 text-[13px] font-semibold text-slate-800 hover:bg-slate-50"
          >
            <Copy className="h-4 w-4" aria-hidden="true" />
            Ask for the PDF
          </button>
        ) : null}
        {recheckable ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => onRecheck(recheckable.fileId)}
            className="touch44 inline-flex min-h-[44px] cursor-pointer items-center gap-2 rounded-xl border border-slate-300 bg-white px-3 text-[13px] font-semibold text-slate-800 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <RefreshCw className={busy ? "h-4 w-4 animate-spin" : "h-4 w-4"} aria-hidden="true" />
            {busy ? "Checking…" : "Re-check receipt"}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function findingTone(result: ProofFinding["result"]): string {
  switch (result) {
    case "fail":
      return "border-red-200 bg-red-50 text-red-700";
    case "warn":
      return "border-amber-200 bg-amber-50 text-amber-800";
    case "pass":
      return "border-emerald-200 bg-emerald-50 text-emerald-700";
    case "unknown":
      return "border-slate-200 bg-slate-50 text-slate-600";
  }
}

/**
 * Colour for the derived label. There is deliberately no green/emerald case:
 * a passing check is not a confirmation, so the strongest a label may read is
 * slate/amber text plus the words themselves (ADR-020/ADR-021).
 */
function labelTone(kind: string): string {
  if (kind === "failed") return "text-red-800";
  if (kind === "unverifiable" || kind === "warned" || kind === "not_run") return "text-amber-800";
  return "text-slate-800";
}

/**
 * The derived proof label. Only rendered when the row actually carries proof
 * data — a list response without `proofs` must not claim "No proof attached".
 */
function ProofNote({ payment }: { payment: Payment }) {
  if (!payment.proofs) return null;
  const label = proofLabel(payment);
  return <span className="mt-1 block text-[12px] text-slate-600">{label.text}</span>;
}

export default function PaymentsPage() {
  return (
    <RequireAuth>
      <RequirePermissions path="/payments">
        <Suspense fallback={<ListSkeleton rows={6} />}>
          <PaymentsList />
        </Suspense>
      </RequirePermissions>
    </RequireAuth>
  );
}
