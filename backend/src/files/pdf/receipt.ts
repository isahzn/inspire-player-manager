/**
 * The receipt PDF (FILES_AND_PDF §3).
 *
 * A receipt exists only for a **confirmed** payment (BILLING_ENGINE §11), and it is the
 * academy's own record of money received — which is why the footer says plainly that a payment
 * *proof* is not a receipt (ADR-013: a submitted document is evidence, never a confirmation).
 *
 * Reversal is a watermark rather than a deletion: the receipt number stays reserved and the
 * document keeps its history, so a guardian holding the original can still be answered.
 * Regeneration is what applies the watermark, so a reversal always shows up on the next
 * render (the receipts table's `pdf_stale` flag is set when the payment is reversed).
 */
import {
  drawHeader,
  drawNote,
  drawTable,
  finishPages,
  keyValueBlock,
  renderPdf,
  sectionTitle,
  type PdfResult,
  type TableRow,
} from "./document.js";
import { formatDate, formatInstant, formatMoney } from "./format.js";
import type { ReceiptPdfInput } from "./types.js";

/**
 * The allocation table plus any credit must account for exactly the amount received.
 *
 * A receipt that prints `LKR 5,000.00 received` above allocations adding to 4,000 is worse
 * than no receipt, so this throws rather than printing the pair.
 */
export function assertReceiptTotals(input: ReceiptPdfInput): void {
  const applied = input.allocations.reduce(
    (total, allocation) => total + BigInt(allocation.appliedMinor),
    0n,
  );
  if (applied + BigInt(input.unallocatedMinor) !== BigInt(input.amountMinor)) {
    throw new Error(
      "PDF_TOTAL_MISMATCH: allocations plus unallocated credit does not equal the amount received",
    );
  }
  for (const allocation of input.allocations) {
    if (BigInt(allocation.appliedMinor) <= 0n) {
      throw new Error(
        `PDF_TOTAL_MISMATCH: allocation to ${allocation.invoiceNumber} is not a positive amount`,
      );
    }
  }
}

export interface ReceiptPdfOptions {
  logo: Uint8Array | null;
  generatedAt: Date;
}

export async function buildReceiptPdf(
  input: ReceiptPdfInput,
  options: ReceiptPdfOptions,
): Promise<PdfResult> {
  assertReceiptTotals(input);

  const generated = `${formatInstant(options.generatedAt, input.timezone)} (${input.timezone})`;
  const reversed = input.reversedAt !== null;

  const columns = [
    { header: "Invoice no.", width: 2.2 },
    { header: "Player", width: 3.4 },
    { header: "Applied amount", width: 1.9, align: "right" as const },
    { header: "Invoice balance after", width: 2.1, align: "right" as const },
  ];

  const rows: TableRow[] = input.allocations.map((allocation) => ({
    cells: [
      allocation.invoiceNumber,
      allocation.playerName,
      formatMoney(allocation.appliedMinor, input.currency),
      formatMoney(allocation.invoiceBalanceAfterMinor, input.currency),
    ],
  }));

  return renderPdf(
    {
      title: `Receipt ${input.receiptNumber}`,
      createdAt: new Date(`${input.receivedAt}T00:00:00Z`),
    },
    (doc) => {
      const meta = {
        title: "PAYMENT RECEIPT",
        badge: reversed ? "REVERSED" : "CONFIRMED",
        fields: [
          { label: "Receipt no.", value: input.receiptNumber },
          { label: "Date received", value: formatDate(input.receivedAt) },
          { label: "Issued on", value: formatDate(input.issuedAt) },
        ],
        footerNote:
          "This receipt confirms payment recorded by the academy. Payment proofs are not receipts." +
          (reversed ? ` Reversed on ${formatDate(input.reversedAt)}.` : ""),
        generated,
        watermark: reversed ? "VOID — PAYMENT REVERSED" : null,
      };

      let y = drawHeader(
        doc,
        {
          academyName: input.academy.name,
          address: input.academy.address,
          phone: input.academy.phone,
          email: input.academy.email,
          logo: options.logo,
        },
        meta,
      );

      y = sectionTitle(doc, "Payment", y);
      y = keyValueBlock(
        doc,
        [
          { label: "Method", value: input.paymentMethodLabel },
          { label: "Reference", value: input.paymentReference ?? "—" },
          { label: "Payer", value: input.payerName ?? "—" },
        ],
        y,
      );

      // The amount received is the one number the reader is looking for, so it gets its own
      // line at reading size rather than a table cell.
      doc.font("Helvetica-Bold").fontSize(15).fillColor("#111111")
        .text(formatMoney(input.amountMinor, input.currency), doc.page.margins.left, y + 4);
      y = doc.y + 10;

      y = sectionTitle(doc, "Applied to", y + 4);
      if (rows.length === 0) {
        y = drawNote(doc, "No invoice was paid — the whole amount is held as credit.", y);
      } else {
        y = drawTable(doc, columns, rows, y);
      }

      if (BigInt(input.unallocatedMinor) > 0n) {
        y = drawNote(
          doc,
          `Unallocated credit held: ${formatMoney(input.unallocatedMinor, input.currency)}`,
          y + 2,
        );
      }

      finishPages(doc, meta);
    },
  );
}
