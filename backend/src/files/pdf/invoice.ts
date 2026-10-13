/**
 * The invoice PDF (FILES_AND_PDF §2).
 *
 * Two rules from the spec shape this file:
 *
 *  - **The document is rendered from the invoice alone.** Everything printed comes from
 *    `InvoicePdfInput`, which the caller builds from `invoices`, `invoice_items` and
 *    `snapshot` — never from live settings (ADR-014). An invoice issued last year prints last
 *    year's address when it is regenerated today.
 *  - **A wrong total must never be printed** (§4). `assertInvoiceTotals` recomputes the
 *    document's arithmetic before a single byte is written, and throws on a mismatch. The
 *    caller turns that into a failed PDF; it is never a silent correction, because silently
 *    "fixing" a total is how a document and a ledger come to disagree.
 *
 * The one thing deliberately *not* printed is an "overdue" badge. The PDF is static and
 * overdue is a function of the calendar, so it would be wrong the day after it is generated;
 * the due date is shown instead.
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
import { formatDate, formatInstant, formatMoney, formatPeriod } from "./format.js";
import type { InvoicePdfInput } from "./types.js";

/** What the badge says, in the contract's own words (FILES_AND_PDF §2). */
const STATUS_BADGE: Record<InvoicePdfInput["status"], string> = {
  issued: "ISSUED",
  partially_paid: "PARTIALLY PAID",
  paid: "PAID",
  void: "VOID",
};

/**
 * Recomputes the document's arithmetic and throws on any disagreement (§4 self-check).
 *
 * Exported because the service calls it *before* deciding whether to spend the work of
 * rendering — a mismatch should surface as `PDF_TOTAL_MISMATCH`, not as a broken PDF that was
 * cheaper to detect up front.
 */
export function assertInvoiceTotals(input: InvoicePdfInput): void {
  const feeLines = input.items.filter((item) => item.amountMinor.trim().startsWith("-") === false);
  const adjustmentLines = input.items.filter((item) => item.amountMinor.trim().startsWith("-"));

  const sum = (lines: typeof input.items) =>
    lines.reduce((total, item) => total + BigInt(item.amountMinor), 0n);

  const fees = sum(feeLines);
  const adjustments = sum(adjustmentLines);
  const total = BigInt(input.totalMinor);

  if (fees !== BigInt(input.subtotalMinor) || adjustments !== BigInt(input.adjustmentsMinor)) {
    throw new Error(
      "PDF_TOTAL_MISMATCH: invoice items do not sum to the invoice's own subtotal/adjustments",
    );
  }
  if (fees + adjustments !== total) {
    throw new Error("PDF_TOTAL_MISMATCH: subtotal plus adjustments does not equal the total");
  }

  // `total − allocations` is the balance. `paid_minor` is the allocation ledger's cache, so
  // the two must still agree; a disagreement means the cache was written by something other
  // than the allocations.
  if (total - BigInt(input.paidMinor) !== BigInt(input.balanceMinor)) {
    throw new Error("PDF_TOTAL_MISMATCH: total minus paid does not equal the stored balance");
  }

  // Every line's own arithmetic, so a bad `quantity × unit` cannot slip through as a
  // "consistent" total.
  for (const item of input.items) {
    if (BigInt(item.amountMinor) !== BigInt(item.quantity) * BigInt(item.unitAmountMinor)) {
      throw new Error(
        `PDF_TOTAL_MISMATCH: line ${item.lineNo} amount is not quantity × unit amount`,
      );
    }
  }
}

export interface InvoicePdfOptions {
  /** The logo bytes, or `null` for the text wordmark. */
  logo: Uint8Array | null;
  /** When the document was rendered; only the "Generated …" label uses it. */
  generatedAt: Date;
}

export async function buildInvoicePdf(
  input: InvoicePdfInput,
  options: InvoicePdfOptions,
): Promise<PdfResult> {
  assertInvoiceTotals(input);

  const generated = `${formatInstant(options.generatedAt, input.timezone)} (${input.timezone})`;
  const period = formatPeriod(input.periodStart, input.periodEnd);

  const columns = [
    { header: "#", width: 0.7 },
    { header: "Description", width: 5.4 },
    { header: "Qty", width: 0.7, align: "right" as const },
    { header: "Unit amount", width: 1.6, align: "right" as const },
    { header: "Amount", width: 1.6, align: "right" as const },
  ];

  const rows: TableRow[] = input.items.map((item) => ({
    cells: [
      String(item.lineNo),
      item.reason ? `${item.description} — ${item.reason}` : item.description,
      String(item.quantity),
      formatMoney(item.unitAmountMinor, input.currency),
      formatMoney(item.amountMinor, input.currency),
    ],
  }));

  // The totals block is a table so its numeric columns line up with the lines above it.
  const blank = ["", "", "", "", ""];
  const totals: TableRow[] = [
    { cells: [...blank.slice(0, 3), "Subtotal", formatMoney(input.subtotalMinor, input.currency)] },
  ];
  if (BigInt(input.adjustmentsMinor) !== 0n) {
    totals.push({
      cells: [...blank.slice(0, 3), "Adjustments", formatMoney(input.adjustmentsMinor, input.currency)],
    });
  }
  totals.push({ cells: [...blank.slice(0, 3), "Total", formatMoney(input.totalMinor, input.currency)], emphasis: true });
  totals.push({ cells: [...blank.slice(0, 3), "Amount paid", formatMoney(input.paidMinor, input.currency)] });
  totals.push({
    cells: [...blank.slice(0, 3), "Balance due", formatMoney(input.balanceMinor, input.currency)],
    emphasis: true,
  });

  return renderPdf(
    {
      title: `Invoice ${input.invoiceNumber}`,
      // The document's own date, so a re-render at a different moment is reproducible.
      createdAt: new Date(`${input.issueDate}T00:00:00Z`),
    },
    (doc) => {
      const meta = {
        title: "INVOICE",
        badge: STATUS_BADGE[input.status],
        fields: [
          { label: "Invoice no.", value: input.invoiceNumber },
          { label: "Issue date", value: formatDate(input.issueDate) },
          { label: "Due date", value: formatDate(input.dueDate) },
        ],
        footerNote:
          "Balance shown is as at the generation time." +
          (input.voidReason ? ` Void reason: ${input.voidReason}` : ""),
        generated,
        watermark: input.status === "void" ? "VOID" : null,
      };

      const brand = {
        academyName: input.academy.name,
        address: input.academy.address,
        phone: input.academy.phone,
        email: input.academy.email,
        logo: options.logo,
      };

      let y = drawHeader(doc, brand, meta);

      y = sectionTitle(doc, "Billed to", y);
      y = keyValueBlock(
        doc,
        [
          {
            label: "Guardian",
            // The full number, because this is the guardian's own document (FILES_AND_PDF §2).
            value: input.guardian
              ? `${input.guardian.fullName}${input.guardian.phone ? ` · ${input.guardian.phone}` : ""}`
              : "—",
          },
          { label: "Player", value: input.player.fullName },
          { label: "Registration no.", value: input.player.registrationNo },
          { label: "Age group", value: input.player.ageGroupName ?? "—" },
        ],
        y,
      );

      y = sectionTitle(
        doc,
        input.kind === "periodic" ? "Billing period" : "Description",
        y + 4,
      );
      y = drawNote(
        doc,
        period ?? input.manualDescription ?? "—",
        y,
      );

      y = sectionTitle(doc, "Items", y + 6);
      y = drawTable(doc, columns, rows, y);
      // The totals continue the same table, so they reuse its columns but must not print its
      // header row a second time.
      y = drawTable(doc, columns, totals, y + 2, false);

      if (input.academy.paymentInstructions) {
        y = sectionTitle(doc, "Payment instructions", y + 8);
        y = drawNote(doc, input.academy.paymentInstructions, y);
      }

      // The caller keeps `y` for future zones; the footer is drawn over every page instead.
      void y;
      finishPages(doc, meta);
    },
  );
}
