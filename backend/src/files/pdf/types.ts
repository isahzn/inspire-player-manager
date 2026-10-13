/**
 * The canonical input to a PDF.
 *
 * These shapes are the **contract between the database and the renderer**, and they are
 * deliberately renderer-independent (ADR-008): swapping PDFKit for Chromium must not change
 * what is printed. They are also what `pdf_input_hash` is computed over, which is why they
 * carry only the document's own facts — never "now", never a page count.
 *
 * Every amount is a **string of minor units** rather than a number. They come from `bigint`
 * columns, and a JSON number would round them on the way through.
 *
 * Nothing here is read live from settings: the academy block, the player and the guardian are
 * the invoice's own `snapshot` (FILES_AND_PDF §2), so re-rendering an old invoice cannot
 * silently adopt today's address or today's phone number.
 */

/** The academy's identity as it stood when the document was issued (`snapshot.academy`). */
export interface PdfAcademy {
  name: string;
  address: string | null;
  phone: string | null;
  email: string | null;
  paymentInstructions: string | null;
  logoFileId: string | null;
  currency: string;
}

/** The payer/customer block of an invoice. */
export interface PdfPlayer {
  fullName: string;
  registrationNo: string;
  ageGroupName: string | null;
}

export interface PdfGuardian {
  fullName: string;
  phone: string | null;
}

export interface InvoicePdfItem {
  lineNo: number;
  description: string;
  quantity: number;
  /** Negative for an adjustment; the sign is part of the printed amount. */
  unitAmountMinor: string;
  amountMinor: string;
  reason: string | null;
}

export type InvoicePdfStatus = "issued" | "partially_paid" | "paid" | "void";

export interface InvoicePdfInput {
  invoiceNumber: string;
  kind: "periodic" | "manual";
  status: InvoicePdfStatus;
  issueDate: string; // YYYY-MM-DD
  dueDate: string;
  periodStart: string | null;
  periodEnd: string | null;
  manualDescription: string | null;
  currency: string;
  subtotalMinor: string;
  adjustmentsMinor: string;
  totalMinor: string;
  paidMinor: string;
  balanceMinor: string;
  voidReason: string | null;
  voidedAt: string | null;
  academy: PdfAcademy;
  player: PdfPlayer;
  guardian: PdfGuardian | null;
  items: InvoicePdfItem[];
  /** Academy-local zone, used only for the "Generated …" label. */
  timezone: string;
}

export interface ReceiptPdfAllocation {
  invoiceNumber: string;
  playerName: string;
  appliedMinor: string;
  /** The invoice's balance after this payment was applied. */
  invoiceBalanceAfterMinor: string;
}

export interface ReceiptPdfInput {
  receiptNumber: string;
  paymentMethodLabel: string;
  paymentReference: string | null;
  payerName: string | null;
  amountMinor: string;
  unallocatedMinor: string;
  currency: string;
  receivedAt: string; // YYYY-MM-DD, academy-local business date
  issuedAt: string;
  allocations: ReceiptPdfAllocation[];
  /** Set when the payment was reversed: the regenerated PDF is watermarked. */
  reversedAt: string | null;
  academy: PdfAcademy;
  timezone: string;
}
