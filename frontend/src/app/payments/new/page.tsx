"use client";

// Record payment — PAY-02 + PAY-08 + PRF-01 (PAGE_SPECIFICATIONS §8,
// BILLING_ENGINE §11).
//
// The rules this screen must not soften:
// · money is integer minor units, parsed by lib/money.ts — never a float;
// · only a CONFIRMED payment can carry allocations, a receipt or a balance;
// · a proof is uploaded AFTER the payment exists, and a failed upload is
//   reported as a failed upload — never as a payment that looks complete;
// · nothing here writes the word "verified", and a pending amount reads
//   "Pending verification" (ADR-020/ADR-021).
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Paperclip, X } from "lucide-react";
import {
  ApiError,
  gdn01ListGuardians,
  gdn06GuardianBalance,
  idempotencyKey,
  pay01ListPayments,
  pay02CreatePayment,
  pay08AllocationSuggestion,
  prf01UploadProof,
  set02GetBillingSettings,
  set04ListPaymentMethods,
} from "@/api/client";
import type { Invoice, Payment } from "@/api/types";
import { RequireAuth, RequirePermissions } from "@/components/Guards";
import { PageHeader } from "@/components/PageHeader";
import {
  BackLink,
  Button,
  Card,
  InlineAlert,
  ListSkeleton,
  MoneyText,
  SectionTitle,
  TextAreaField,
  TextField,
  Toast,
  Toggle,
  buttonClass,
} from "@/components/ui";
import { PROOF_EVIDENCE_NOTE } from "@/lib/billing";
import {
  academyLocalToInstant,
  addDaysISO,
  formatDateStr,
  formatInstant,
  todayISO,
} from "@/lib/dates";
import { formatMoneyMinor, moneyMinorToEditText, parseMoneyInput } from "@/lib/money";

const MAX_PROOF_BYTES = 5 * 1024 * 1024;
const PROOF_TYPES = ["application/pdf", "image/jpeg", "image/png", "image/webp"];
const PAYER_NOT_LINKED = "__none__";

export default function NewPaymentPage() {
  return (
    <RequireAuth>
      <RequirePermissions path="/payments">
        <Suspense fallback={<ListSkeleton rows={6} />}>
          <RecordPayment />
        </Suspense>
      </RequirePermissions>
    </RequireAuth>
  );
}

function RecordPayment() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();

  // The Idempotency-Key is generated when the form OPENS and reused on every
  // retry of the same intent (API_INTEGRATION §4) — a double click or a network
  // retry can never record the payment twice.
  const keyRef = useRef<string>(idempotencyKey());

  const [payerGuardianId, setPayerGuardianId] = useState(searchParams.get("guardianId") ?? "");
  const [payerName, setPayerName] = useState("");
  const [amountText, setAmountText] = useState("");
  const [methodCode, setMethodCode] = useState("");
  const [reference, setReference] = useState("");
  const [receivedAt, setReceivedAt] = useState(todayISO());
  const [oldConfirm, setOldConfirm] = useState(false);
  const [status, setStatus] = useState<"confirmed" | "pending">("confirmed");
  const [notes, setNotes] = useState("");
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [proofFile, setProofFile] = useState<File | null>(null);
  const [proofError, setProofError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [alert, setAlert] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  // A payment that exists but whose proof did not land: shown plainly, with a retry.
  const [needsProof, setNeedsProof] = useState<{ payment: Payment; message: string } | null>(null);

  const prefillInvoiceId = searchParams.get("invoiceId") ?? "";
  const today = todayISO();
  const oldestAllowed = addDaysISO(today, -365);
  const prefilled = useRef(false);
  // A date input gives a business date; `receivedAt` is an instant, so it is
  // anchored to 12:00 in the ACADEMY timezone (never the device clock).
  const receivedInstant = receivedAt ? academyLocalToInstant(receivedAt, "12:00") : "";

  const settingsQuery = useQuery({
    queryKey: ["billing-settings"],
    queryFn: () => set02GetBillingSettings(),
    staleTime: 5 * 60_000,
  });
  const allowFractional = settingsQuery.data?.allowFractionalMoney !== false;

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

  const methods = useMemo(
    () => (methodsQuery.data?.data ?? []).filter((m) => m.isActive),
    [methodsQuery.data]
  );
  const method = methods.find((m) => m.code === methodCode);

  const amountResult = amountText.trim()
    ? parseMoneyInput(amountText, { allowFractional })
    : null;
  const amountMinor = amountResult && "minor" in amountResult ? amountResult.minor : 0;

  // Allocations need a payer we can look up and a CONFIRMED payment (BILLING_ENGINE §11).
  const allocationsEnabled = Boolean(payerGuardianId) && status === "confirmed";

  const balanceQuery = useQuery({
    queryKey: ["guardian-balance", payerGuardianId],
    queryFn: () => gdn06GuardianBalance(payerGuardianId),
    enabled: allocationsEnabled,
  });

  const suggestionQuery = useQuery({
    queryKey: ["allocation-suggestion", "new", payerGuardianId],
    queryFn: () => pay08AllocationSuggestion("new", { guardianId: payerGuardianId }),
    enabled: allocationsEnabled,
  });

  const openInvoices = useMemo<Invoice[]>(() => {
    const rows = [...(balanceQuery.data?.openInvoices ?? [])];
    // Oldest due date first (BILLING_ENGINE §11 default suggestion).
    return rows.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.invoiceNumber.localeCompare(b.invoiceNumber));
  }, [balanceQuery.data]);

  // Prefill once per payer: the server's suggestion, except for the invoice the
  // owner arrived from (a "Record payment" row action), which takes its balance.
  useEffect(() => {
    if (prefilled.current || !suggestionQuery.data || openInvoices.length === 0) return;
    const next: Record<string, string> = {};
    for (const invoice of openInvoices) {
      const suggested = suggestionQuery.data.suggested.find((s) => s.invoiceId === invoice.id);
      next[invoice.id] = suggested ? moneyMinorToEditText(suggested.amountMinor) : "";
    }
    if (prefillInvoiceId) {
      const target = openInvoices.find((i) => i.id === prefillInvoiceId);
      if (target) next[target.id] = moneyMinorToEditText(target.balanceMinor);
    }
    setAmounts(next);
    prefilled.current = true;
  }, [openInvoices, prefillInvoiceId, suggestionQuery.data]);

  const allocationRows = openInvoices.map((invoice) => {
    const text = amounts[invoice.id] ?? "";
    const parsed = text.trim() ? parseMoneyInput(text, { allowFractional, allowZero: true }) : null;
    const minor = parsed && "minor" in parsed ? parsed.minor : 0;
    return { invoice, text, minor, bad: Boolean(parsed && "error" in parsed) };
  });
  const sentRows = allocationRows.filter((row) => row.minor > 0);
  const allocationSum = sentRows.reduce((sum, row) => sum + row.minor, 0);
  const creditMinor = Math.max(0, amountMinor - allocationSum);
  const overPayment = allocationsEnabled && amountMinor > 0 && allocationSum > amountMinor;
  const overInvoice = allocationRows.filter((row) => row.minor > row.invoice.balanceMinor);

  // Non-blocking duplicate hint: same payer, same amount, same day (BILLING_ENGINE §9).
  const duplicateQuery = useQuery({
    queryKey: ["payments", "duplicate-check", { guardianId: payerGuardianId, date: receivedAt }],
    queryFn: () => pay01ListPayments({ guardianId: payerGuardianId, from: receivedAt, to: receivedAt, pageSize: 25 }),
    enabled: Boolean(payerGuardianId) && amountMinor > 0 && Boolean(receivedAt),
  });
  const duplicates = (duplicateQuery.data?.data ?? []).filter(
    (p) => p.amountMinor === amountMinor && p.status !== "rejected" && p.status !== "reversed"
  );

  function pickProof(file: File | null) {
    setProofError(null);
    if (!file) {
      setProofFile(null);
      return;
    }
    if (!PROOF_TYPES.includes(file.type)) {
      setProofError("Use a PDF, JPEG, PNG or WebP file.");
      setProofFile(null);
      return;
    }
    if (file.size > MAX_PROOF_BYTES) {
      setProofError("That file is larger than 5 MB.");
      setProofFile(null);
      return;
    }
    setProofFile(file);
  }

  function buildPayload() {
    return {
      amountMinor,
      methodCode,
      reference: reference.trim() || undefined,
      receivedAt: receivedInstant,
      payerGuardianId: payerGuardianId || undefined,
      payerName: payerGuardianId ? undefined : payerName.trim() || undefined,
      notes: notes.trim() || undefined,
      status,
      allocations:
        allocationsEnabled && sentRows.length > 0
          ? sentRows.map((row) => ({ invoiceId: row.invoice.id, amountMinor: row.minor }))
          : undefined,
    } as const;
  }

  const mutation = useMutation({
    mutationFn: async () => {
      const payment = await pay02CreatePayment(buildPayload(), keyRef.current);
      if (!proofFile) return { payment, uploadError: null as string | null };
      try {
        await prf01UploadProof(payment.id, proofFile);
        return { payment, uploadError: null as string | null };
      } catch (error) {
        return {
          payment,
          uploadError:
            error instanceof ApiError
              ? error.message
              : "The proof did not upload. The payment was recorded without it.",
        };
      }
    },
    onSuccess: ({ payment, uploadError }) => {
      queryClient.invalidateQueries({ queryKey: ["payments"] });
      queryClient.invalidateQueries({ queryKey: ["invoices"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      if (uploadError) {
        setNeedsProof({ payment, message: uploadError });
        return;
      }
      setToast("Payment recorded.");
      router.push(`/payments/${payment.id}`);
    },
    onError: (error) => {
      if (error instanceof ApiError) {
        if (error.code === "VALIDATION_ERROR" || error.code === "REASON_REQUIRED") {
          const fields = error.fieldErrors();
          if (Object.keys(fields).length) {
            setErrors(fields);
            setAlert("Please correct the highlighted fields.");
            return;
          }
        }
        if (error.code === "ALLOCATION_EXCEEDS_BALANCE") {
          setErrors(error.fieldErrors());
          setAlert("An allocation is larger than that invoice's balance.");
          return;
        }
        if (error.code === "ALLOCATION_EXCEEDS_PAYMENT") {
          setAlert("The allocations add up to more than the payment amount.");
          return;
        }
        if (error.code === "PAYMENT_DUPLICATE_REFERENCE") {
          setErrors({ reference: error.message });
          return;
        }
        if (error.code === "INVOICE_VOID" || error.code === "PAYMENT_NOT_CONFIRMED") {
          setAlert(error.message);
          return;
        }
        setAlert(error.message);
        return;
      }
      setAlert("Could not record the payment. Your entries are kept — retry when the connection is back.");
    },
  });

  const retryProof = useMutation({
    mutationFn: async () => {
      if (!needsProof || !proofFile) return null;
      await prf01UploadProof(needsProof.payment.id, proofFile);
      return needsProof.payment;
    },
    onSuccess: (payment) => {
      if (!payment) return;
      setNeedsProof(null);
      setToast("Proof uploaded.");
      router.push(`/payments/${payment.id}`);
    },
    onError: (error) => {
      setNeedsProof((current) =>
        current
          ? {
              payment: current.payment,
              message: error instanceof ApiError ? error.message : "The proof did not upload.",
            }
          : current
      );
    },
  });

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const next: Record<string, string> = {};
    if (!payerGuardianId && payerName.trim().length < 2) {
      next.payer = "Choose a guardian, or type the payer's name";
    }
    if (!amountText.trim()) next.amount = "Enter an amount";
    else if (!amountResult || "error" in amountResult) next.amount = amountResult?.error ?? "Enter an amount";
    if (!methodCode) next.method = "Choose how the money was paid";
    if (method?.requiresReference && !reference.trim()) next.reference = "This method needs a reference";
    if (!receivedAt) next.receivedAt = "Enter the date the money was received";
    else if (receivedAt > today) next.receivedAt = "The date cannot be in the future";
    else if (receivedAt < oldestAllowed && !oldConfirm) {
      next.receivedAt = "Tick the box to confirm a date more than a year ago";
    }
    if (allocationsEnabled) {
      for (const row of overInvoice) {
        const index = sentRows.findIndex((r) => r.invoice.id === row.invoice.id);
        if (index >= 0) {
          next[`allocations.${index}.amountMinor`] = "More than this invoice's balance";
        } else {
          next[`allocations.${row.invoice.id}.amountMinor`] = "More than this invoice's balance";
        }
      }
      if (overPayment) next.allocations = "The allocations add up to more than the payment";
    }
    setErrors(next);
    if (Object.keys(next).length > 0) {
      setAlert("Please correct the highlighted fields.");
      return;
    }
    setAlert(null);
    mutation.mutate();
  }

  if (needsProof) {
    return (
      <>
        <BackLink href="/payments">Payments</BackLink>
        <PageHeader title="Payment recorded — proof missing" />
        <InlineAlert tone="warning" title="The payment was recorded without its proof">
          {needsProof.message} The payment exists and is unaffected; attach the receipt again from the payment page
          (or retry here while the file is still selected).
        </InlineAlert>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            onClick={() => retryProof.mutate()}
            pending={retryProof.isPending}
            disabled={!proofFile}
          >
            Retry upload
          </Button>
          <Link href={`/payments/${needsProof.payment.id}`} className={buttonClass("secondary")}>
            Open the payment
          </Link>
        </div>
        {!proofFile ? (
          <p className="mt-2 text-[13px] text-slate-600">
            The file was cleared, so retry from the payment page instead.
          </p>
        ) : null}
      </>
    );
  }

  return (
    <>
      <BackLink href="/payments">Payments</BackLink>
      <PageHeader
        title="Record payment"
        sub="Cash is confirmed as you record it. A bank transfer can wait for you to check the bank statement."
      />

      <form onSubmit={submit} className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card>
            <SectionTitle>Who paid</SectionTitle>
            <div className="grid gap-3 p-4 sm:grid-cols-2">
              <div>
                <label htmlFor="pay-payer" className="mb-1 block text-[14px] font-semibold text-slate-800">
                  Guardian
                </label>
                <select
                  id="pay-payer"
                  value={payerGuardianId}
                  aria-invalid={errors.payer ? true : undefined}
                  aria-describedby={errors.payer ? "pay-payer-error" : undefined}
                  onChange={(e) => {
                    const value = e.target.value;
                    setPayerGuardianId(value === PAYER_NOT_LINKED ? "" : value);
                    prefilled.current = false;
                    setAmounts({});
                    setErrors((current) => ({ ...current, payer: "" }));
                  }}
                  className="h-12 w-full rounded-xl border border-slate-300 bg-white px-3 text-[16px]"
                >
                  <option value="">Choose a guardian…</option>
                  {(guardiansQuery.data?.data ?? []).map((guardian) => (
                    <option key={guardian.id} value={guardian.id}>
                      {guardian.fullName} · {guardian.phone}
                    </option>
                  ))}
                  <option value={PAYER_NOT_LINKED}>Not linked to a guardian</option>
                </select>
                {errors.payer ? (
                  <p id="pay-payer-error" className="mt-1 text-[13px] font-medium text-red-700">
                    {errors.payer}
                  </p>
                ) : (
                  <p className="mt-1 text-[13px] text-slate-600">
                    A linked guardian is what lets credit be applied to their invoices.
                  </p>
                )}
              </div>
              <TextField
                id="pay-payer-name"
                label="Payer name (when not linked)"
                value={payerName}
                error={errors.payer && !payerGuardianId ? errors.payer : undefined}
                hint="Record exactly who paid — siblings and relatives often pay."
                onChange={(e) => setPayerName(e.target.value)}
              />
            </div>
          </Card>

          <Card>
            <SectionTitle>How much, how and when</SectionTitle>
            <div className="grid gap-3 p-4 sm:grid-cols-2">
              <div>
                <TextField
                  id="pay-amount"
                  label="Amount (LKR)"
                  inputMode="decimal"
                  required
                  value={amountText}
                  error={errors.amount}
                  hint={allowFractional ? "Like 4000 or 4000.50" : "Whole rupees only for this academy"}
                  onChange={(e) => setAmountText(e.target.value)}
                />
                {amountMinor > 0 ? (
                  <p className="mt-1 text-[13px] text-slate-600">
                    Recorded as <strong className="tabular">{formatMoneyMinor(amountMinor, { full: true })}</strong>
                  </p>
                ) : null}
              </div>
              <div>
                <label htmlFor="pay-method" className="mb-1 block text-[14px] font-semibold text-slate-800">
                  Method <span className="text-red-600">*</span>
                </label>
                <select
                  id="pay-method"
                  required
                  value={methodCode}
                  aria-invalid={errors.method ? true : undefined}
                  aria-describedby={errors.method ? "pay-method-error" : undefined}
                  onChange={(e) => {
                    setMethodCode(e.target.value);
                    setErrors((current) => ({ ...current, method: "", reference: "" }));
                  }}
                  className="h-12 w-full rounded-xl border border-slate-300 bg-white px-3 text-[16px]"
                >
                  <option value="">Choose a method…</option>
                  {methods.map((option) => (
                    <option key={option.code} value={option.code}>
                      {option.label}
                    </option>
                  ))}
                </select>
                {errors.method ? (
                  <p id="pay-method-error" className="mt-1 text-[13px] font-medium text-red-700">
                    {errors.method}
                  </p>
                ) : null}
                {methodsQuery.isError ? (
                  <p className="mt-1 text-[13px] text-amber-800">
                    The method list could not be loaded, so no method can be chosen yet.
                  </p>
                ) : null}
              </div>
              <TextField
                id="pay-reference"
                label="Reference"
                required={Boolean(method?.requiresReference)}
                value={reference}
                error={errors.reference}
                hint={
                  method?.requiresReference
                    ? "This method requires a reference — the bank's transaction reference."
                    : "Optional for this method."
                }
                onChange={(e) => setReference(e.target.value)}
              />
              <TextField
                id="pay-received-at"
                label="Date received"
                type="date"
                required
                value={receivedAt}
                max={today}
                error={errors.receivedAt}
                hint={`Today is ${formatDateStr(today)} in the academy timezone.`}
                onChange={(e) => setReceivedAt(e.target.value)}
              />
            </div>
            <div className="px-4 pb-2">
              {receivedAt < oldestAllowed ? (
                <Toggle
                  id="pay-old-confirm"
                  label="Confirm a date more than a year ago"
                  hint="Anything older than a year needs this explicit confirmation."
                  checked={oldConfirm}
                  onChange={setOldConfirm}
                />
              ) : null}
            </div>
            <div className="px-4 pb-4">
              <TextAreaField
                id="pay-notes"
                label="Notes"
                rows={2}
                value={notes}
                hint="Optional — for example who handed the money over."
                onChange={(e) => setNotes(e.target.value)}
              />
            </div>
          </Card>

          <Card>
            <SectionTitle>Proof (optional)</SectionTitle>
            <div className="space-y-3 p-4">
              <div>
                <label htmlFor="pay-proof" className="mb-1 block text-[14px] font-semibold text-slate-800">
                  Receipt or slip
                </label>
                <input
                  id="pay-proof"
                  type="file"
                  accept=".pdf,.jpg,.jpeg,.png,.webp,application/pdf,image/jpeg,image/png,image/webp"
                  onChange={(e) => pickProof(e.target.files?.[0] ?? null)}
                  className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-[15px]"
                />
                {proofError ? (
                  <p className="mt-1 text-[13px] font-medium text-red-700">{proofError}</p>
                ) : proofFile ? (
                  <p className="mt-1 flex items-center gap-2 text-[13px] text-slate-700">
                    <Paperclip className="h-4 w-4" aria-hidden="true" />
                    {proofFile.name} · {(proofFile.size / 1024).toFixed(0)} KB
                    <button
                      type="button"
                      onClick={() => pickProof(null)}
                      className="cursor-pointer text-[13px] font-semibold text-slate-600 underline underline-offset-2"
                    >
                      Remove
                    </button>
                  </p>
                ) : (
                  <p className="mt-1 text-[13px] text-slate-600">PDF, JPEG, PNG or WebP · up to 5 MB.</p>
                )}
              </div>
              <InlineAlert tone="info" title="A proof is not a payment">
                {PROOF_EVIDENCE_NOTE}
              </InlineAlert>
              {method?.code === "bank_transfer" ? (
                <InlineAlert tone="warning" title="Ask for the bank's PDF e-receipt">
                  A photo or screenshot is kept as supporting evidence only and cannot be verified — ask the payer
                  to send the receipt as a PDF from their bank app.
                </InlineAlert>
              ) : null}
              <p className="text-[13px] text-slate-600">
                The file is uploaded right after the payment is recorded. If the upload fails, this page says so and
                the payment is left without a proof rather than pretending it has one.
              </p>
            </div>
          </Card>

          <Card>
            <SectionTitle>Apply to invoices</SectionTitle>
            <div className="space-y-3 p-4">
              {!allocationsEnabled ? (
                <InlineAlert tone="info" title="Allocations come with a confirmation">
                  Only a <strong>confirmed</strong> payment can be applied to invoices. Choose a guardian payer and
                  set the status to Confirmed to see their open invoices.
                </InlineAlert>
              ) : balanceQuery.isLoading ? (
                <ListSkeleton rows={3} />
              ) : balanceQuery.isError ? (
                <InlineAlert tone="danger" title="Could not load this payer's invoices">
                  Nothing will be applied. Retry before you save if you meant to allocate this payment.
                </InlineAlert>
              ) : openInvoices.length === 0 ? (
                <InlineAlert tone="info" title="No open invoices for this payer">
                  The whole amount will stay on the payment as credit. Credit is never applied automatically.
                </InlineAlert>
              ) : (
                <>
                  <p className="text-[13px] text-slate-600">
                    Oldest due date first, prefilled from the recorded balances. Edit or clear any row — each amount
                    must be within that invoice&apos;s balance and the total must not exceed the payment.
                  </p>
                  <ul aria-label="Allocation rows" className="divide-y divide-slate-100">
                    {allocationRows.map((row, index) => {
                      const sentIndex = sentRows.findIndex((r) => r.invoice.id === row.invoice.id);
                      const fieldError = sentIndex >= 0 ? errors[`allocations.${sentIndex}.amountMinor`] : undefined;
                      const overBalance = row.minor > row.invoice.balanceMinor;
                      return (
                        <li key={row.invoice.id} className="py-3">
                          <div className="flex flex-wrap items-start justify-between gap-3">
                            <div className="min-w-0">
                              <p className="text-[14px] font-semibold text-slate-900">
                                {row.invoice.invoiceNumber}
                                {row.invoice.id === prefillInvoiceId ? (
                                  <span className="ml-2 text-[12px] font-medium text-pitch-700">
                                    from the invoice you opened
                                  </span>
                                ) : null}
                              </p>
                              <p className="text-[13px] text-slate-600">
                                {row.invoice.player.fullName} · due {formatDateStr(row.invoice.dueDate)} · balance{" "}
                                <MoneyText minor={row.invoice.balanceMinor} />
                              </p>
                            </div>
                            <div className="w-full sm:w-40">
                              <label htmlFor={`alloc-${index}`} className="sr-only">
                                Apply to {row.invoice.invoiceNumber}
                              </label>
                              <input
                                id={`alloc-${index}`}
                                data-allocation-invoice={row.invoice.id}
                                inputMode="decimal"
                                value={row.text}
                                placeholder="0.00"
                                aria-invalid={fieldError || overBalance ? true : undefined}
                                onChange={(e) =>
                                  setAmounts((current) => ({ ...current, [row.invoice.id]: e.target.value }))
                                }
                                className={`h-12 w-full rounded-xl border px-3 text-[16px] ${
                                  fieldError || overBalance ? "border-red-500" : "border-slate-300"
                                }`}
                              />
                              {fieldError || overBalance || row.bad ? (
                                <p className="mt-1 text-[13px] font-medium text-red-700">
                                  {fieldError ?? (overBalance ? "More than this invoice's balance" : "Check this amount")}
                                </p>
                              ) : null}
                            </div>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                  {errors.allocations ? (
                    <p className="text-[13px] font-medium text-red-700">{errors.allocations}</p>
                  ) : null}
                </>
              )}
            </div>
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <SectionTitle>Status of this payment</SectionTitle>
            <div className="space-y-2 p-4">
              <fieldset id="pay-status">
                <legend className="sr-only">Payment status</legend>
                <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-slate-200 p-3">
                  <input
                    type="radio"
                    name="pay-status"
                    value="confirmed"
                    checked={status === "confirmed"}
                    onChange={() => setStatus("confirmed")}
                    className="mt-1 h-5 w-5"
                  />
                  <span>
                    <span className="block text-[14px] font-semibold text-slate-900">Confirmed</span>
                    <span className="block text-[13px] text-slate-600">
                      You have checked that the money arrived. Only a confirmed payment can be applied to invoices.
                    </span>
                  </span>
                </label>
                <label className="mt-2 flex cursor-pointer items-start gap-3 rounded-xl border border-slate-200 p-3">
                  <input
                    type="radio"
                    name="pay-status"
                    value="pending"
                    checked={status === "pending"}
                    onChange={() => setStatus("pending")}
                    className="mt-1 h-5 w-5"
                  />
                  <span>
                    <span className="block text-[14px] font-semibold text-slate-900">Pending verification</span>
                    <span className="block text-[13px] text-slate-600">
                      To be checked later. It changes no balance until you confirm it.
                    </span>
                  </span>
                </label>
              </fieldset>
              {status === "pending" ? (
                <InlineAlert tone="info" title="No balance changes yet">
                  The amount stays <strong>pending</strong> and is left unapplied until an owner confirms it.
                </InlineAlert>
              ) : null}
            </div>
          </Card>

          <Card>
            <SectionTitle>Summary</SectionTitle>
            <dl className="space-y-2 p-4 text-[14px]">
              <SummaryRow label="Amount">
                <MoneyText minor={amountMinor} full />
              </SummaryRow>
              <SummaryRow label="Applied to invoices">
                <MoneyText minor={allocationsEnabled ? allocationSum : 0} full />
              </SummaryRow>
              <SummaryRow label="Credit (held, not applied)">
                <MoneyText minor={allocationsEnabled ? creditMinor : amountMinor} full />
              </SummaryRow>
              <SummaryRow label="Date received">
                <span>{formatInstant(receivedInstant)}</span>
              </SummaryRow>
            </dl>
            {overPayment ? (
              <div className="px-4 pb-4">
                <InlineAlert tone="danger" title="Allocations exceed the payment">
                  Reduce the rows to {formatMoneyMinor(amountMinor)} or less.
                </InlineAlert>
              </div>
            ) : null}
            {duplicates.length > 0 ? (
              <div className="px-4 pb-4">
                <InlineAlert tone="warning" title="A similar payment already exists">
                  The same payer was already recorded with {formatMoneyMinor(amountMinor)} on{" "}
                  {formatDateStr(receivedAt)}. Check it is not the same payment before saving — this is a warning,
                  not a block.
                </InlineAlert>
              </div>
            ) : null}
            {alert ? (
              <div className="px-4 pb-4">
                <InlineAlert tone="danger" title="Could not record the payment">
                  {alert}
                </InlineAlert>
              </div>
            ) : null}
            <div className="border-t border-slate-200 p-4">
              <Button type="submit" pending={mutation.isPending} className="w-full">
                <CheckCircle2 className="h-5 w-5" aria-hidden="true" />
                Record payment
              </Button>
              <p className="mt-2 text-[12px] text-slate-500">
                One <span className="font-mono">Idempotency-Key</span> guards this form, so a retry cannot record the
                payment twice.
              </p>
            </div>
          </Card>
        </div>
      </form>

      {toast ? <Toast message={toast} onDismiss={() => setToast(null)} /> : null}

      <div className="mt-4 flex items-center gap-2 text-[13px] text-slate-600">
        <X className="h-4 w-4" aria-hidden="true" />
        Nothing is deleted: a wrong payment is reversed with a reason, never edited away.
      </div>
    </>
  );
}

function SummaryRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-slate-600">{label}</dt>
      <dd className="tabular font-medium text-slate-900">{children}</dd>
    </div>
  );
}
