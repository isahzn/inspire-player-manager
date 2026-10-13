"use client";

// Payment detail (PAY-03..07, PRF-01..04, RCT-01/02 — PAGE_SPECIFICATIONS §8).
//
// The rule this screen exists to protect (ADR-013 / ADR-020 / ADR-021): a proof
// is evidence, never a payment. Check results are shown as advisory findings,
// the amount keeps reading **Pending verification** until an owner confirms, and
// no green tick anywhere stands in for a confirmation. Only `payments/:id/confirm`
// moves money, and every label comes from one shared module (lib/billing.ts) so
// a second copy cannot drift into saying "verified".
//
// The verification queue TAB on /payments is deliberately NOT built: it is gated
// by `SET-08.proofCheck` (CR-003, ADR-019 still Proposed). CR-004 is accepted, so
// the per-proof panel, the manual re-check (PRF-04) and the "ask for the PDF"
// prompt are all here.
import { useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ApiError,
  gdn01ListGuardians,
  gdn06GuardianBalance,
  idempotencyKey,
  pay03GetPayment,
  pay03PatchPayment,
  pay04ConfirmPayment,
  pay05RejectPayment,
  pay06AllocatePayment,
  pay07ReversePayment,
  pay08AllocationSuggestion,
  prf01UploadProof,
  prf02ProofDownloadUrl,
  prf03DeleteProof,
  prf04VerifyProof,
  rct02DownloadReceiptPdf,
  rct02RegenerateReceiptPdf,
  set02GetBillingSettings,
} from "@/api/client";
import type { Invoice, Payment, ProofFinding, ProofMeta } from "@/api/types";
import { RequireAuth, RequirePermissions } from "@/components/Guards";
import { PageHeader } from "@/components/PageHeader";
import { StatusChip } from "@/components/StatusChip";
import {
  BackLink,
  Button,
  Card,
  DateText,
  ErrorState,
  InlineAlert,
  ListSkeleton,
  Modal,
  MoneyText,
  SectionTitle,
  TextAreaField,
  TextField,
  Toast,
  buttonClass,
} from "@/components/ui";
import {
  ASK_FOR_PDF_MESSAGE,
  PROOF_EVIDENCE_NOTE,
  findingLabel,
  paymentStatusLabel,
  proofLabel,
  sortFindings,
} from "@/lib/billing";
import { formatInstant, todayISO } from "@/lib/dates";
import { copyText, openBlob } from "@/lib/download";
import { formatMoneyMinor, moneyMinorToEditText, parseMoneyInput } from "@/lib/money";

const DOC_KIND_LABEL: Record<string, string> = {
  bank_receipt_pdf: "Bank PDF e-receipt",
  bank_receipt_image: "Photo / screenshot (supporting only)",
  other: "Supporting document",
};

const VERIFICATION_LABEL: Record<string, string> = {
  not_run: "Not checked yet",
  checked: "Checked",
  failed: "Check failed",
  unverifiable: "Not verifiable",
};

export default function PaymentDetailPage() {
  return (
    <RequireAuth>
      <RequirePermissions path="/payments">
        <PaymentDetail />
      </RequirePermissions>
    </RequireAuth>
  );
}

function PaymentDetail() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? "";
  const queryClient = useQueryClient();
  const [toast, setToast] = useState<string | null>(null);
  const [dialog, setDialog] = useState<null | "confirm" | "reject" | "reverse" | "allocate" | "edit">(
    null
  );
  const [conflict, setConflict] = useState(false);
  const [copied, setCopied] = useState(false);

  const paymentQuery = useQuery({
    queryKey: ["payment", id],
    queryFn: () => pay03GetPayment(id),
    enabled: Boolean(id),
  });
  const settingsQuery = useQuery({
    queryKey: ["settings", "billing"],
    queryFn: set02GetBillingSettings,
    staleTime: 5 * 60_000,
  });
  const payment = paymentQuery.data;

  // The guardian behind the payer, for the wa.me fallback (masked phone numbers
  // never reach the frontend, so the number comes from GDN-01 like everywhere else).
  const guardiansQuery = useQuery({
    queryKey: ["guardians", "one-page"],
    queryFn: () => gdn01ListGuardians({ page: 1 }),
    staleTime: 5 * 60_000,
  });

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: ["payment", id] });
    void queryClient.invalidateQueries({ queryKey: ["payments"] });
    void queryClient.invalidateQueries({ queryKey: ["invoices"] });
    void queryClient.invalidateQueries({ queryKey: ["player-balance"] });
    void queryClient.invalidateQueries({ queryKey: ["guardian-balance"] });
  }

  function onError(error: unknown) {
    if (error instanceof ApiError && error.code === "VERSION_CONFLICT") {
      setDialog(null);
      setConflict(true);
      return;
    }
    setToast(error instanceof ApiError ? error.message : "Something went wrong. Please retry.");
  }

  const upload = useMutation({
    mutationFn: (file: File) => prf01UploadProof(id, file),
    onSuccess: (proof) => {
      invalidate();
      setToast(
        proof.docKind === "bank_receipt_pdf"
          ? "Proof attached. Press Verify to run the checks."
          : "Photo attached as supporting evidence — it cannot be verified. Ask for the bank's PDF e-receipt."
      );
    },
    onError,
  });

  const verify = useMutation({
    mutationFn: (fileId: string) => prf04VerifyProof(id, fileId),
    onSuccess: (result) => {
      invalidate();
      setToast(
        result.status === "failed"
          ? "Checks finished with a failure — the payment still needs your decision."
          : "Checks finished. Findings are advice only."
      );
    },
    onError,
  });

  const removeProof = useMutation({
    mutationFn: (fileId: string) => prf03DeleteProof(id, fileId),
    onSuccess: () => {
      invalidate();
      setToast("Proof removed.");
    },
    onError,
  });

  if (paymentQuery.isLoading) {
    return (
      <>
        <BackLink href="/payments">Payments</BackLink>
        <ListSkeleton rows={4} />
      </>
    );
  }
  if (paymentQuery.isError || !payment) {
    return (
      <>
        <BackLink href="/payments">Payments</BackLink>
        <Card>
          <ErrorState error={paymentQuery.error} onRetry={() => paymentQuery.refetch()} />
        </Card>
      </>
    );
  }

  const label = proofLabel(payment);
  const guardianId = payment.payer?.guardianId;
  const guardian = guardiansQuery.data?.data.find((g) => g.id === guardianId);
  const parsedFileId = payment.proofs?.find((p) => p.verification)?.fileId;

  async function downloadProof(proof: ProofMeta) {
    try {
      const { url } = await prf02ProofDownloadUrl(id, proof.fileId);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (error) {
      onError(error);
    }
  }

  async function downloadReceipt() {
    if (!payment?.receipt) return;
    try {
      openBlob(await rct02DownloadReceiptPdf(payment.receipt.id), `${payment.receipt.receiptNumber}.pdf`);
    } catch (error) {
      onError(error);
    }
  }

  async function askForPdf() {
    const text = `${ASK_FOR_PDF_MESSAGE} ${payment?.reference ? `Reference ${payment.reference}.` : ""}`.trim();
    const ok = await copyText(text);
    setCopied(ok);
    setToast(ok ? "Message copied — send it with the WhatsApp button." : "Copy failed — select the text and copy it.");
  }

  const waHref =
    guardian && payment
      ? `https://wa.me/${guardian.phone.replace(/[^\d]/g, "")}?text=${encodeURIComponent(
          `${ASK_FOR_PDF_MESSAGE} ${payment.reference ? `Reference ${payment.reference}.` : ""}`.trim()
        )}`
      : undefined;

  return (
    <>
      <BackLink href="/payments">Payments</BackLink>
      <PageHeader
        title={`Payment ${formatMoneyMinor(payment.amountMinor, { full: true })}`}
        sub={`${payment.payer?.name ?? "Payer not recorded"} · ${payment.method.label}${
          payment.reference ? ` · ${payment.reference}` : ""
        }`}
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span id="payment-status" data-payment-status={payment.status}>
          <StatusChip status={paymentStatusLabel(payment.status)} />
        </span>
        <span className="tabular rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[12px] font-semibold text-slate-700">
          Allocated <MoneyText minor={payment.allocatedMinor} />
        </span>
        <span className="tabular rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[12px] font-semibold text-slate-700">
          Credit <MoneyText minor={payment.unallocatedMinor} />
        </span>
        {payment.status === "pending" ? (
          <span
            id="pending-verification"
            className="rounded-full border border-amber-300 bg-amber-50 px-2.5 py-1 text-[12px] font-semibold text-amber-900"
          >
            Pending verification
          </span>
        ) : null}
      </div>

      {/* The derived proof label: what the checks say about the DOCUMENTS, never
          about the money. It is a separate element from the status on purpose. */}
      <p
        data-payment-label={label.kind}
        className={`mb-4 rounded-xl border px-4 py-3 text-[14px] ${
          label.kind === "failed"
            ? "border-red-200 bg-red-50 text-red-900"
            : label.kind === "passed"
              ? "border-slate-200 bg-slate-50 text-slate-800"
              : "border-amber-200 bg-amber-50 text-amber-900"
        }`}
      >
        <span className="font-semibold">{label.text}</span>
        <span className="block text-[13px]">
          {PROOF_EVIDENCE_NOTE}
          {label.kind === "passed" ? " This is advice, not a confirmation." : ""}
        </span>
      </p>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <SectionTitle>Payment</SectionTitle>
          <dl className="divide-y divide-slate-100 p-4 text-[14px]">
            <Row label="Amount" value={<MoneyText minor={payment.amountMinor} full />} />
            <Row label="Method" value={payment.method.label} />
            <Row label="Reference" value={payment.reference ?? "Not recorded"} />
            <Row label="Received" value={formatInstant(payment.receivedAt)} />
            <Row
              label="Payer"
              value={
                guardianId ? (
                  <Link href={`/players`} className="font-medium text-pitch-700 underline underline-offset-2">
                    {payment.payer?.name}
                  </Link>
                ) : (
                  (payment.payer?.name ?? "Not recorded")
                )
              }
            />
            <Row label="Notes" value={payment.notes ?? "—"} />
            {payment.status === "rejected" ? (
              <Row label="Rejected because" value={payment.rejectReason ?? "—"} />
            ) : null}
            {payment.status === "reversed" ? (
              <Row label="Reversed because" value={payment.reverseReason ?? "—"} />
            ) : null}
            <Row
              label="Status"
              value={
                payment.rejectReason || payment.reverseReason
                  ? `${paymentStatusLabel(payment.status)} · reason recorded`
                  : paymentStatusLabel(payment.status)
              }
            />
          </dl>
          <div className="flex flex-wrap gap-2 px-4 pb-4">
            {payment.status === "pending" ? (
              <>
                <Button id="payment-confirm" onClick={() => setDialog("confirm")}>
                  Confirm payment
                </Button>
                <Button id="payment-reject" variant="secondary" onClick={() => setDialog("reject")}>
                  Reject
                </Button>
              </>
            ) : null}
            {payment.status === "confirmed" && payment.unallocatedMinor > 0 ? (
              <Button id="payment-allocate" variant="secondary" onClick={() => setDialog("allocate")}>
                Allocate credit
              </Button>
            ) : null}
            {payment.status === "confirmed" ? (
              <Button id="payment-reverse" variant="danger" onClick={() => setDialog("reverse")}>
                Reverse payment
              </Button>
            ) : null}
            <Button id="payment-edit" variant="ghost" onClick={() => setDialog("edit")}>
              Edit reference, notes or date
            </Button>
          </div>
          <p className="px-4 pb-4 text-[13px] text-slate-600">
            Amount, method and allocations cannot be edited — a wrong payment is reversed and
            re-recorded, never rewritten in place. Only confirming a payment moves a balance
            (ADR-013). The API exposes no per-event status history yet, so this screen shows the
            recorded facts and any reason instead of inventing a timeline.
          </p>
        </Card>

        <div className="space-y-4">
          <Card>
            <SectionTitle
              right={
                <span className="text-[13px] text-slate-600">
                  {(payment.allocations ?? []).filter((a) => !a.reversedAt).length} active
                </span>
              }
            >
              Allocations
            </SectionTitle>
            {(payment.allocations ?? []).length === 0 ? (
              <p className="px-4 py-4 text-[14px] text-slate-600">
                Nothing allocated yet
                {payment.status === "pending"
                  ? " — this payment is not confirmed, so it cannot be allocated."
                  : payment.unallocatedMinor > 0
                    ? ". The whole amount is held as credit; credit is never applied automatically."
                    : "."}
              </p>
            ) : (
              <ul aria-label="Allocations" className="divide-y divide-slate-100">
                {(payment.allocations ?? []).map((allocation) => (
                  <li key={allocation.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-[14px]">
                    <Link
                      href={`/billing/invoices/${allocation.invoice.id}`}
                      className="font-semibold text-pitch-700 underline underline-offset-2"
                    >
                      {allocation.invoice.invoiceNumber}
                    </Link>
                    <span className="tabular"><MoneyText minor={allocation.amountMinor} /></span>
                    <span className="text-slate-600">{formatInstant(allocation.allocatedAt)}</span>
                    {allocation.reversedAt ? (
                      <span className="rounded-full border border-slate-200 bg-slate-100 px-2 py-0.5 text-[12px] font-semibold text-slate-600">
                        Reversed {formatInstant(allocation.reversedAt)}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <SectionTitle>Receipt</SectionTitle>
            {payment.receipt ? (
              <div className="space-y-3 p-4 text-[14px]">
                <p>
                  Receipt <span className="font-semibold">{payment.receipt.receiptNumber}</span> — issued
                  only for a confirmed payment.
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button id="receipt-download" variant="secondary" onClick={downloadReceipt}>
                    Download PDF
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={async () => {
                      try {
                        await rct02RegenerateReceiptPdf(payment.receipt!.id);
                        setToast("Receipt PDF regeneration queued.");
                      } catch (error) {
                        onError(error);
                      }
                    }}
                  >
                    Regenerate
                  </Button>
                </div>
                {payment.status === "reversed" ? (
                  <p className="text-[13px] text-slate-600">
                    This payment was reversed, so a regenerated receipt carries a
                    “VOID – payment reversed” mark.
                  </p>
                ) : null}
              </div>
            ) : (
              <p className="px-4 py-4 text-[14px] text-slate-600">
                No receipt. A receipt exists only after an owner confirms this payment.
              </p>
            )}
          </Card>
        </div>
      </div>

      <ProofsPanel
        payment={payment}
        busy={upload.isPending || removeProof.isPending}
        verifyingId={verify.isPending ? verify.variables : undefined}
        allowFractional={settingsQuery.data?.allowFractionalMoney}
        onUpload={(file) => upload.mutate(file)}
        onVerify={(fileId) => verify.mutate(fileId)}
        onRemove={(fileId) => removeProof.mutate(fileId)}
        onDownload={(proof) => void downloadProof(proof)}
        onAskForPdf={() => void askForPdf()}
        waHref={waHref}
        copied={copied}
        highlightedFileId={parsedFileId}
      />

      {dialog === "confirm" ? (
        <AllocationDialog
          mode="confirm"
          payment={payment}
          guardianId={guardianId}
          onClose={() => setDialog(null)}
          onError={onError}
          onDone={(message) => {
            invalidate();
            setDialog(null);
            setToast(message);
          }}
        />
      ) : null}
      {dialog === "allocate" ? (
        <AllocationDialog
          mode="allocate"
          payment={payment}
          guardianId={guardianId}
          onClose={() => setDialog(null)}
          onError={onError}
          onDone={(message) => {
            invalidate();
            setDialog(null);
            setToast(message);
          }}
        />
      ) : null}
      {dialog === "reject" ? (
        <ReasonDialog
          title="Reject payment"
          description="Rejecting keeps the record and ends its life here — a rejected payment can never be allocated."
          confirmLabel="Reject payment"
          warning="The payer will not be told automatically; tell them yourself."
          run={(reason) =>
            pay05RejectPayment(id, { reason, version: payment.version }, idempotencyKey())
          }
          onClose={() => setDialog(null)}
          onError={onError}
          onDone={() => {
            invalidate();
            setDialog(null);
            setToast("Payment rejected.");
          }}
        />
      ) : null}
      {dialog === "reverse" ? (
        <ReverseDialog
          payment={payment}
          run={(reason) => pay07ReversePayment(id, { reason, version: payment.version }, idempotencyKey())}
          onClose={() => setDialog(null)}
          onError={onError}
          onDone={() => {
            invalidate();
            setDialog(null);
            setToast("Payment reversed. Any invoices it paid are open again.");
          }}
        />
      ) : null}
      {dialog === "edit" ? (
        <EditDialog
          payment={payment}
          onClose={() => setDialog(null)}
          onError={onError}
          onDone={() => {
            invalidate();
            setDialog(null);
            setToast("Payment details updated.");
          }}
        />
      ) : null}
      {conflict ? (
        <Modal
          open
          onClose={() => setConflict(false)}
          title="Someone else changed this"
          description="This payment was changed while you were working on it. Reload to see the current record before deciding again."
          footer={
            <>
              <Button variant="secondary" onClick={() => setConflict(false)}>
                Keep looking
              </Button>
              <Button onClick={() => paymentQuery.refetch()}>Reload the payment</Button>
            </>
          }
        >
          <p className="text-[14px] text-slate-700">
            Nothing you did was saved — money actions are never retried automatically.
          </p>
        </Modal>
      ) : null}
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

// ---------------------------------------------------------------------------
// Proofs + the CR-004 verification panel
// ---------------------------------------------------------------------------
function ProofsPanel({
  payment,
  busy,
  verifyingId,
  allowFractional,
  onUpload,
  onVerify,
  onRemove,
  onDownload,
  onAskForPdf,
  waHref,
  copied,
  highlightedFileId,
}: {
  payment: Payment;
  busy: boolean;
  verifyingId?: string;
  allowFractional?: boolean;
  onUpload: (file: File) => void;
  onVerify: (fileId: string) => void;
  onRemove: (fileId: string) => void;
  onDownload: (proof: ProofMeta) => void;
  onAskForPdf: () => void;
  waHref?: string;
  copied: boolean;
  highlightedFileId?: string;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const proofs = payment.proofs ?? [];
  const hasPdfReceipt = proofs.some((p) => p.docKind === "bank_receipt_pdf");
  const isBankTransfer = payment.method.code === "bank_transfer";
  const shown = proofs.find((p) => p.fileId === highlightedFileId) ?? proofs[0];
  const verification = shown?.verification;

  function pick(next: File | null) {
    setFileError(null);
    if (!next) {
      setFile(null);
      return;
    }
    if (next.size > 5 * 1024 * 1024) {
      setFileError("Files must be 5 MB or smaller.");
      return;
    }
    const ok = /^(application\/pdf|image\/(jpeg|png|webp))$/.test(next.type);
    if (!ok) {
      setFileError("Use a PDF, JPEG, PNG or WebP file.");
      return;
    }
    setFile(next);
  }

  return (
    <Card className="mt-4">
      <SectionTitle
        right={
          <span className="text-[13px] text-slate-600">
            {proofs.length} of 5 · {allowFractional === undefined ? "" : ""}
          </span>
        }
      >
        Proofs and verification
      </SectionTitle>

      <div className="space-y-4 p-4">
        {isBankTransfer && !hasPdfReceipt ? (
          <InlineAlert
            tone="warning"
            title="Not verifiable — ask for the PDF"
            action={
              <div className="flex flex-wrap gap-2">
                <Button id="ask-for-pdf" size="sm" variant="secondary" onClick={onAskForPdf}>
                  {copied ? "Copied" : "Ask for the PDF"}
                </Button>
                {waHref ? (
                  <a href={waHref} target="_blank" rel="noopener noreferrer" className={buttonClass("secondary", "sm")}>
                    Open WhatsApp
                  </a>
                ) : null}
              </div>
            }
          >
            A photo or screenshot has no text layer, so it can never be checked. It is kept as
            supporting evidence, and the payment stays pending until you confirm it by eye.
          </InlineAlert>
        ) : null}

        {proofs.length === 0 ? (
          <p className="text-[14px] text-slate-600">No proof attached.</p>
        ) : (
          <ul aria-label="Proofs" className="divide-y divide-slate-100">
            {proofs.map((proof) => (
              <li key={proof.fileId} className="flex flex-wrap items-center gap-3 py-3 text-[14px]">
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-semibold text-slate-900">
                    {proof.originalName ?? proof.fileId}
                  </span>
                  <span className="block text-[13px] text-slate-600">
                    {DOC_KIND_LABEL[proof.docKind] ?? proof.docKind} ·{" "}
                    {(proof.sizeBytes / 1024).toFixed(0)} KB · attached {formatInstant(proof.uploadedAt)}
                  </span>
                </span>
                <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[12px] font-semibold text-slate-700">
                  {proof.verification ? VERIFICATION_LABEL[proof.verification.status] : "Not checked yet"}
                </span>
                <span className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    data-verify-proof={proof.fileId}
                    pending={verifyingId === proof.fileId}
                    onClick={() => onVerify(proof.fileId)}
                  >
                    Verify
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => onDownload(proof)}>
                    Download
                  </Button>
                  {payment.status === "pending" ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      data-remove-proof={proof.fileId}
                      onClick={() => onRemove(proof.fileId)}
                    >
                      Remove
                    </Button>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}

        {verification ? (
          <div className="rounded-xl border border-slate-200">
            <div className="border-b border-slate-200 px-4 py-3">
              <h3 className="text-[14px] font-semibold text-slate-900">
                What the check read from this receipt
              </h3>
              <p className="text-[13px] text-slate-600">
                Parser {verification.parserVersion ?? "unknown"} · checked{" "}
                {verification.checkedAt ? formatInstant(verification.checkedAt) : "—"}. Only fields the
                parser actually extracted are shown.
              </p>
            </div>
            {verification.extracted ? (
              <dl data-proof-extract className="divide-y divide-slate-100 px-4 text-[14px]">
                <ExtractedRow label="Bank" value={verification.extracted.bankName} />
                <ExtractedRow label="Document" value={verification.extracted.documentType} />
                <ExtractedRow label="Reference" value={verification.extracted.reference} />
                <ExtractedRow
                  label="Transferred"
                  value={
                    verification.extracted.transactionAt
                      ? formatInstant(verification.extracted.transactionAt)
                      : undefined
                  }
                />
                <ExtractedRow
                  label="Amount"
                  value={
                    verification.extracted.amountMinor === undefined
                      ? undefined
                      : `${formatMoneyMinor(verification.extracted.amountMinor, { full: true })}${
                          verification.extracted.currency ? ` ${verification.extracted.currency}` : ""
                        }`
                  }
                />
                <ExtractedRow label="Payer" value={verification.extracted.payerName} />
                <ExtractedRow
                  label="Beneficiary"
                  value={
                    verification.extracted.beneficiaryName &&
                    verification.extracted.beneficiaryAccountMasked
                      ? `${verification.extracted.beneficiaryName} (${verification.extracted.beneficiaryAccountMasked})`
                      : verification.extracted.beneficiaryName
                  }
                />
                <ExtractedRow label="Channel" value={verification.extracted.channel} />
                <ExtractedRow label="Receipt status" value={verification.extracted.status} />
                <ExtractedRow label="Remarks" value={verification.extracted.remarks} />
              </dl>
            ) : (
              <p className="px-4 py-3 text-[14px] text-slate-600">
                Nothing could be extracted from this file — that is why it cannot be verified.
              </p>
            )}
            <ul aria-label="Findings" className="divide-y divide-slate-100 border-t border-slate-200 px-4">
              {sortFindings(verification.findings).map((finding) => (
                <FindingRow key={finding.code} finding={finding} />
              ))}
            </ul>
            <p className="border-t border-slate-200 px-4 py-3 text-[13px] text-slate-600">
              Checks are advisory. They never confirm, reject, allocate or change a balance — an owner
              confirms the payment. Statement reconciliation against the academy&rsquo;s own bank
              statement (the only check that proves money arrived) is not available yet, so a receipt
              can still be edited or reused.
            </p>
          </div>
        ) : null}

        {payment.status === "pending" ? (
          <div className="rounded-xl border border-slate-200 p-4">
            <h3 className="text-[14px] font-semibold text-slate-900">Attach a proof</h3>
            <p className="text-[13px] text-slate-600">
              For a bank transfer, attach the bank&rsquo;s PDF e-receipt. A photo is kept as supporting
              evidence only and can never produce a passing check.
            </p>
            <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
              <input
                id="proof-file"
                type="file"
                accept="application/pdf,image/jpeg,image/png,image/webp"
                onChange={(event) => pick(event.target.files?.[0] ?? null)}
                className="min-h-[44px] w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-[14px]"
              />
              <Button
                id="proof-upload"
                pending={busy}
                disabled={!file}
                onClick={() => {
                  if (file) onUpload(file);
                  setFile(null);
                }}
              >
                Upload proof
              </Button>
            </div>
            {fileError ? (
              <p className="mt-2 text-[13px] font-medium text-red-700">{fileError}</p>
            ) : null}
          </div>
        ) : (
          <p className="text-[13px] text-slate-600">
            Proofs can be added or removed only while a payment is pending.
          </p>
        )}
      </div>
    </Card>
  );
}

function ExtractedRow({ label, value }: { label: string; value?: string }) {
  if (!value) return null; // never show a field we did not actually extract
  return (
    <div className="flex flex-wrap justify-between gap-2 py-2">
      <dt className="text-slate-600">{label}</dt>
      <dd className="font-medium text-slate-900">{value}</dd>
    </div>
  );
}

function FindingRow({ finding }: { finding: ProofFinding }) {
  const tone =
    finding.result === "fail"
      ? "border-red-200 bg-red-50 text-red-900"
      : finding.result === "warn"
        ? "border-amber-200 bg-amber-50 text-amber-900"
        : finding.result === "pass"
          ? "border-slate-200 bg-slate-50 text-slate-700"
          : "border-slate-200 bg-white text-slate-600";
  return (
    <li className="flex flex-wrap items-start gap-2 py-3 text-[14px]">
      <span className={`rounded-full border px-2 py-0.5 text-[12px] font-semibold ${tone}`}>
        {findingLabel(finding.result)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="font-semibold text-slate-900">{finding.code}</span>{" "}
        <span className="text-slate-700">{finding.detail}</span>
        <span className="ml-1 text-[12px] text-slate-500">(level {finding.level})</span>
      </span>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Allocation editor (used by Confirm and Allocate credit)
// ---------------------------------------------------------------------------
function AllocationDialog({
  mode,
  payment,
  guardianId,
  onClose,
  onDone,
  onError,
}: {
  mode: "confirm" | "allocate";
  payment: Payment;
  guardianId?: string;
  onClose: () => void;
  onDone: (message: string) => void;
  onError: (error: unknown) => void;
}) {
  const capMinor = mode === "confirm" ? payment.amountMinor : payment.unallocatedMinor;
  const [lines, setLines] = useState<Record<string, string>>({});
  const [reason, setReason] = useState("");
  const [alert, setAlert] = useState<string | null>(null);
  const [key] = useState(() => idempotencyKey());

  const balanceQuery = useQuery({
    queryKey: ["guardian-balance", guardianId],
    queryFn: () => gdn06GuardianBalance(guardianId!),
    enabled: Boolean(guardianId),
  });
  const suggestionQuery = useQuery({
    queryKey: ["allocation-suggestion", payment.id, mode],
    queryFn: () => pay08AllocationSuggestion(payment.id, { guardianId }),
  });

  const openInvoices: Invoice[] = balanceQuery.data?.openInvoices ?? [];
  const suggestion = suggestionQuery.data;

  const mutation = useMutation({
    mutationFn: (allocations: { invoiceId: string; amountMinor: number }[]) =>
      mode === "confirm"
        ? pay04ConfirmPayment(payment.id, { allocations, version: payment.version }, key)
        : pay06AllocatePayment(payment.id, { allocations, version: payment.version }, key),
    onSuccess: () =>
      onDone(mode === "confirm" ? "Payment confirmed and allocated." : "Credit allocated."),
    onError: (error) => {
      if (error instanceof ApiError) {
        const fields = error.fieldErrors();
        const first = Object.values(fields)[0];
        if (first) {
          setAlert(first);
          return;
        }
        setAlert(error.message);
        return;
      }
      onError(error);
    },
  });

  const parsed = openInvoices.map((invoice) => {
    const raw = lines[invoice.id] ?? "";
    const result = raw === "" ? { minor: 0 } : parseMoneyInput(raw, { allowZero: true });
    const minor = "minor" in result ? result.minor : Number.NaN;
    const tooMuch = Number.isFinite(minor) && minor > invoice.balanceMinor;
    return { invoice, raw, minor, invalid: !Number.isFinite(minor) || tooMuch, tooMuch };
  });
  const total = parsed.reduce((sum, row) => (Number.isFinite(row.minor) ? sum + row.minor : sum), 0);
  const overCap = total > capMinor;
  const nothingChosen = total === 0;
  const invalid = parsed.some((row) => row.raw !== "" && row.invalid) || overCap;

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setAlert(null);
    if (mode === "confirm" && nothingChosen) {
      // Confirming without allocating is allowed — the money stays as credit.
      mutation.mutate([]);
      return;
    }
    if (invalid) return;
    const allocations = parsed
      .filter((row) => Number.isFinite(row.minor) && row.minor > 0)
      .map((row) => ({ invoiceId: row.invoice.id, amountMinor: row.minor }));
    if (allocations.length === 0) {
      setAlert("Enter an amount for at least one invoice.");
      return;
    }
    mutation.mutate(allocations);
  }

  function applySuggestion() {
    if (!suggestion) return;
    const next: Record<string, string> = {};
    for (const row of suggestion.suggested) {
      next[row.invoiceId] = moneyMinorToEditText(row.amountMinor);
    }
    setLines(next);
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={mode === "confirm" ? "Confirm payment" : "Allocate credit"}
      description={
        mode === "confirm"
          ? "Confirming is the owner's decision that the money arrived — it is the only thing that changes a balance."
          : "Credit is never applied automatically; you choose which invoices it pays."
      }
      footer={
        <>
          <Button variant="secondary" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="allocation-form" pending={mutation.isPending}>
            {mode === "confirm" ? "Confirm payment" : "Allocate credit"}
          </Button>
        </>
      }
    >
      <form id="allocation-form" onSubmit={submit} className="space-y-4">
        {alert ? (
          <InlineAlert tone="danger" title="Could not save">
            {alert}
          </InlineAlert>
        ) : null}
        <p className="rounded-xl bg-slate-50 px-4 py-3 text-[14px] text-slate-700">
          Available to allocate: <strong>{formatMoneyMinor(capMinor, { full: true })}</strong>
          {mode === "confirm" ? " · confirming without allocating keeps the money as credit." : ""}
        </p>
        {!guardianId ? (
          <InlineAlert tone="info" title="No payer linked">
            This payment has no linked guardian, so the open invoices could not be narrowed. Record
            the payment against a guardian to allocate it here.
          </InlineAlert>
        ) : null}
        {balanceQuery.isLoading || suggestionQuery.isLoading ? <ListSkeleton rows={2} /> : null}
        {openInvoices.length === 0 && !balanceQuery.isLoading ? (
          <p className="text-[14px] text-slate-600">
            This payer has no open invoices — nothing to allocate.
          </p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {parsed.map(({ invoice, raw, invalid: rowInvalid, tooMuch: over }) => (
              <li key={invoice.id} className="py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-[14px]">
                    <span className="font-semibold text-slate-900">{invoice.invoiceNumber}</span>{" "}
                    <span className="text-slate-600">
                      {invoice.player.fullName} · due <DateText value={invoice.dueDate} />
                      {invoice.isOverdue ? " · overdue" : ""}
                    </span>
                  </span>
                  <span className="tabular text-[14px] text-slate-700">
                    Balance <MoneyText minor={invoice.balanceMinor} />
                  </span>
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <label className="sr-only" htmlFor={`apply-${invoice.id}`}>
                    Amount to apply to {invoice.invoiceNumber}
                  </label>
                  <input
                    id={`apply-${invoice.id}`}
                    data-allocation-invoice={invoice.id}
                    inputMode="decimal"
                    value={raw}
                    onChange={(event) => setLines({ ...lines, [invoice.id]: event.target.value })}
                    placeholder="0.00"
                    className={`h-12 w-32 rounded-xl border px-3 text-[16px] tabular ${
                      rowInvalid ? "border-red-500" : "border-slate-300"
                    }`}
                  />
                  {rowInvalid ? (
                    <span className="text-[13px] font-medium text-red-700">
                      {over ? "More than the balance" : "Digits only, like 4000.00"}
                    </span>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button type="button" variant="ghost" onClick={applySuggestion} disabled={!suggestion}>
            Use the suggested amounts
          </Button>
          <p className="text-[14px]">
            Applied <span className="tabular font-semibold">{formatMoneyMinor(total, { full: true })}</span>
            {" · "}Left over{" "}
            <span className={`tabular font-semibold ${overCap ? "text-red-700" : ""}`}>
              {formatMoneyMinor(Math.max(0, capMinor - total), { full: true })}
            </span>{" "}
            as credit
          </p>
        </div>
        {mode === "confirm" ? (
          <TextAreaField
            id="confirm-reason"
            label="Note (optional)"
            rows={2}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            hint="Recorded on the payment for the audit trail — e.g. “checked the bank statement”."
          />
        ) : null}
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Reject / reverse / edit
// ---------------------------------------------------------------------------
function ReasonDialog({
  title,
  description,
  confirmLabel,
  warning,
  run,
  onClose,
  onDone,
  onError,
}: {
  title: string;
  description: string;
  confirmLabel: string;
  warning?: string;
  run: (reason: string) => Promise<Payment>;
  onClose: () => void;
  onDone: () => void;
  onError: (error: unknown) => void;
}) {
  const [reason, setReason] = useState("");
  const mutation = useMutation({
    mutationFn: (value: string) => run(value),
    onSuccess: onDone,
    onError,
  });
  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      description={description}
      footer={
        <>
          <Button variant="secondary" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="reason-form"
            variant="danger"
            pending={mutation.isPending}
            disabled={reason.trim().length < 5}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <form
        id="reason-form"
        onSubmit={(event) => {
          event.preventDefault();
          mutation.mutate(reason.trim());
        }}
        className="space-y-4"
      >
        {warning ? <InlineAlert tone="warning" title="Before you continue">{warning}</InlineAlert> : null}
        <TextAreaField
          id="reason-text"
          label="Reason"
          required
          rows={3}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          hint="Recorded in the audit log (at least 5 characters)."
          error={reason.length > 0 && reason.trim().length < 5 ? "Use at least 5 characters" : undefined}
        />
      </form>
    </Modal>
  );
}

function ReverseDialog({
  payment,
  run,
  onClose,
  onDone,
  onError,
}: {
  payment: Payment;
  run: (reason: string) => Promise<Payment>;
  onClose: () => void;
  onDone: () => void;
  onError: (error: unknown) => void;
}) {
  const active = (payment.allocations ?? []).filter((a) => !a.reversedAt);
  return (
    <ReasonDialog
      title="Reverse payment"
      description="Reversing releases the allocations, reopens the invoices it paid and voids the receipt. The record is kept."
      confirmLabel="Reverse payment"
      run={run}
      onClose={onClose}
      onDone={onDone}
      onError={onError}
      warning={
        active.length === 0
          ? "This payment has no active allocations — reversing still voids its receipt and marks it reversed."
          : `These invoices will be open again: ${active
              .map((a) => a.invoice.invoiceNumber)
              .join(", ")}. Their balances return to what they were.`
      }
    />
  );
}

function EditDialog({
  payment,
  onClose,
  onDone,
  onError,
}: {
  payment: Payment;
  onClose: () => void;
  onDone: () => void;
  onError: (error: unknown) => void;
}) {
  const [reference, setReference] = useState(payment.reference ?? "");
  const [notes, setNotes] = useState(payment.notes ?? "");
  const [receivedDate, setReceivedDate] = useState(payment.receivedAt.slice(0, 10));
  const [error, setError] = useState<string | null>(null);
  const [key] = useState(() => idempotencyKey());

  const mutation = useMutation({
    mutationFn: () =>
      pay03PatchPayment(payment.id, {
        reference: reference.trim(),
        notes: notes.trim(),
        receivedAt: `${receivedDate}T${payment.receivedAt.slice(11, 19)}Z`,
        version: payment.version,
      }),
    onSuccess: onDone,
    onError: (err) => {
      if (err instanceof ApiError) {
        setError(Object.values(err.fieldErrors())[0] ?? err.message);
        return;
      }
      onError(err);
    },
  });

  return (
    <Modal
      open
      onClose={onClose}
      title="Edit payment"
      description="Only the reference, the notes and the date can change. The amount, the method and the allocations are immutable."
      footer={
        <>
          <Button variant="secondary" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="edit-payment-form" pending={mutation.isPending}>
            Save changes
          </Button>
        </>
      }
    >
      <form
        id="edit-payment-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (receivedDate > todayISO()) {
            setError("The date received cannot be in the future.");
            return;
          }
          setError(null);
          mutation.mutate();
        }}
        className="space-y-4"
        data-idempotency-key={key}
      >
        {error ? <InlineAlert tone="danger" title="Could not save">{error}</InlineAlert> : null}
        <TextField
          id="edit-reference"
          label="Reference"
          value={reference}
          onChange={(event) => setReference(event.target.value)}
        />
        <TextField
          id="edit-received"
          label="Date received"
          type="date"
          max={todayISO()}
          value={receivedDate}
          onChange={(event) => setReceivedDate(event.target.value)}
          hint="The time of day is kept; only the date changes."
        />
        <TextAreaField
          id="edit-notes"
          label="Notes"
          rows={3}
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
        />
      </form>
    </Modal>
  );
}
