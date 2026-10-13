// Label discipline and derived billing text (PAGE_SPECIFICATIONS §7/§8).
// The rules live in ONE module on purpose: ADR-013 / ADR-020 / ADR-021 forbid
// ever letting a proof finding read as a payment state, and a second copy of
// that mapping is how a screen would start showing "verified".
//
// Forbidden, everywhere money is concerned: "verified", "paid" or "confirmed"
// standing in for an owner's confirmation, and any green tick that implies one.
import type {
  BillingSkipReason,
  Invoice,
  Payment,
  ProofFinding,
  ProofVerification,
} from "@/api/types";

/** Status chip text for an invoice (Overdue is derived, never stored). */
export function invoiceStatusLabel(invoice: Pick<Invoice, "status" | "isOverdue">): string {
  if (invoice.status === "void") return "Void";
  if (invoice.isOverdue) return "Overdue";
  if (invoice.status === "paid") return "Paid";
  if (invoice.status === "partially_paid") return "Partially paid";
  return "Issued";
}

/** Payment status chip text. `pending` is never dressed up as anything else. */
export function paymentStatusLabel(status: Payment["status"]): string {
  switch (status) {
    case "pending":
      return "Pending";
    case "confirmed":
      return "Confirmed";
    case "rejected":
      return "Rejected";
    case "reversed":
      return "Reversed";
  }
}

/**
 * Derived proof label for ONE payment (PAYMENT_VERIFICATION §5). It describes
 * what the checks say about the attached documents — nothing about the money.
 */
// Every variant pins `text` to the exact strings the product may print, so a
// wording that would read as a money state cannot slip in through a string.
export type ProofLabel =
  | { kind: "none"; text: "No proof attached" }
  | {
      kind: "unverifiable";
      text: "Not verifiable — ask for the PDF" | "Not verifiable — no PDF receipt was supplied";
    }
  | { kind: "failed"; text: string } // "Check failed: <plain reason>"
  | {
      kind: "warned";
      text: "Checks passed with warnings — look at the notes" | "Checks passed with warnings";
    }
  | {
      kind: "passed";
      text: "Ready to confirm — checks passed" | `Checks passed — payment already ${string}`;
    }
  | { kind: "not_run"; text: "Not checked yet" };

export function proofLabel(
  payment: Pick<Payment, "proofs" | "proofVerification" | "status">
): ProofLabel {
  const proofs = payment.proofs ?? [];
  const pending = payment.status === "pending";
  if (proofs.length === 0) return { kind: "none", text: "No proof attached" };
  const parsed = proofs.filter((p) => p.docKind === "bank_receipt_pdf");
  const rollup = payment.proofVerification;
  if (parsed.length === 0) {
    // "Ask for the PDF" is only an instruction while the owner still has to act.
    return {
      kind: "unverifiable",
      text: pending
        ? "Not verifiable — ask for the PDF"
        : "Not verifiable — no PDF receipt was supplied",
    };
  }
  if (!rollup || rollup.status === "none") {
    return { kind: "not_run", text: "Not checked yet" };
  }
  if (rollup.status === "failed") {
    const failure = parsed
      .flatMap((p) => p.verification?.findings ?? [])
      .find((f) => f.result === "fail");
    return { kind: "failed", text: `Check failed: ${failure?.detail ?? "see the findings"}` };
  }
  if (rollup.status === "warned") {
    return {
      kind: "warned",
      text: pending
        ? "Checks passed with warnings — look at the notes"
        : "Checks passed with warnings",
    };
  }
  if (rollup.status === "unverifiable") {
    return {
      kind: "unverifiable",
      text: pending
        ? "Not verifiable — ask for the PDF"
        : "Not verifiable — no PDF receipt was supplied",
    };
  }
  // A confirmed (or rejected/reversed) payment is never described as "ready to
  // confirm" — that would read as if the decision were still outstanding.
  return {
    kind: "passed",
    text: pending
      ? "Ready to confirm — checks passed"
      : `Checks passed — payment already ${paymentStatusLabel(payment.status).toLowerCase()}`,
  };
}

/** Plain-language order: pass first, then warnings, then failures. */
export function sortFindings(findings: ProofFinding[]): ProofFinding[] {
  const rank = { fail: 0, warn: 1, unknown: 2, pass: 3 } as const;
  return [...findings].sort((a, b) => rank[a.result] - rank[b.result] || a.code.localeCompare(b.code));
}

export function findingLabel(result: ProofFinding["result"]): string {
  switch (result) {
    case "pass":
      return "Passed";
    case "warn":
      return "Warning";
    case "fail":
      return "Failed";
    case "unknown":
      return "Not checked";
  }
}

/** Roll-up of every proof's findings into the payment's `proofVerification`. */
export function rollupVerification(
  proofs: { docKind: string; verification?: ProofVerification }[]
): Payment["proofVerification"] {
  const parsed = proofs.filter((p) => p.docKind === "bank_receipt_pdf");
  const withResult = parsed.filter((p) => p.verification && p.verification.status !== "not_run");
  if (withResult.length === 0) {
    return parsed.length === 0 ? { status: "unverifiable" } : { status: "none" };
  }
  const findings = withResult.flatMap((p) => p.verification!.findings);
  const checkedAt = withResult
    .map((p) => p.verification!.checkedAt)
    .filter((v): v is string => Boolean(v))
    .sort()
    .pop();
  if (findings.some((f) => f.result === "fail")) return { status: "failed", checkedAt };
  if (withResult.every((p) => p.verification!.status === "unverifiable")) {
    return { status: "unverifiable", checkedAt };
  }
  if (findings.some((f) => f.result === "warn")) return { status: "warned", checkedAt };
  return { status: "passed", checkedAt };
}

/** Why a player was skipped by the billing preview, in plain language. */
export function skipReasonText(reason: BillingSkipReason, targetDate: string): string {
  switch (reason) {
    case "NO_GROUP":
      return `No age group on ${targetDate}`;
    case "NO_FEE":
      return "No fee set for the group";
    case "NOT_ACTIVE":
      return "Not active in this period";
    case "ALREADY_INVOICED":
      return "Already invoiced for this period";
    case "NOT_YET_REGISTERED":
      return "Not registered yet";
  }
}

/** The message the owner copies when a photo was sent instead of the PDF. */
export const ASK_FOR_PDF_MESSAGE =
  "Please send the bank transfer receipt as a PDF from your bank app — a photo can't be verified.";

export const PROOF_EVIDENCE_NOTE =
  "A proof is evidence only — the payment counts after you confirm it. Passing checks never move money.";
