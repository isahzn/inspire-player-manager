/**
 * The PDF layer's pure parts (FILES_AND_PDF §2/§4).
 *
 * Two things here are worth a test of their own rather than only an integration pass:
 *
 *  - **The formatters.** `LKR 4,000.00` and `01 Nov 2026` are what a guardian reads, and both
 *    have an obvious wrong version (a raw integer, or a UTC-parsed date that renders as the
 *    previous day). They are also the only place a `bigint` column becomes text.
 *  - **The self-checks.** Their entire job is to *refuse*, so a test that only shows them
 *    passing proves nothing; each one is exercised with a total that does not add up.
 */
import { describe, expect, it } from "vitest";
import { formatDate, formatMoney, formatPeriod } from "../../src/files/pdf/format.js";
import { assertInvoiceTotals, buildInvoicePdf } from "../../src/files/pdf/invoice.js";
import { assertReceiptTotals } from "../../src/files/pdf/receipt.js";
import type { InvoicePdfInput, ReceiptPdfInput } from "../../src/files/pdf/types.js";

describe("PDF formatting", () => {
  it("prints money with two decimals and thousands separators", () => {
    expect(formatMoney("400000", "LKR")).toBe("LKR 4,000.00");
    expect(formatMoney("0", "LKR")).toBe("LKR 0.00");
    expect(formatMoney("5", "LKR")).toBe("LKR 0.05");
    expect(formatMoney("1234567890", "LKR")).toBe("LKR 12,345,678.90");
  });

  it("puts the minus outside the currency for a negative amount", () => {
    expect(formatMoney("-50000", "LKR")).toBe("-LKR 500.00");
    expect(formatMoney("-1", "LKR")).toBe("-LKR 0.01");
  });

  it("formats a business date without going through a timezone", () => {
    // `new Date("2026-11-01")` is UTC midnight and renders as 31 October in any negative
    // offset; the formatter reads the parts instead, so it cannot.
    expect(formatDate("2026-11-01")).toBe("01 Nov 2026");
    expect(formatDate("2026-01-31")).toBe("31 Jan 2026");
    expect(formatDate(null)).toBe("—");
  });

  it("prints a period as a range", () => {
    expect(formatPeriod("2026-11-01", "2026-11-30")).toBe("01 Nov 2026 – 30 Nov 2026");
    expect(formatPeriod(null, "2026-11-30")).toBeNull();
  });
});

const ACADEMY = {
  name: "Inspire Academy",
  address: "12 Temple Rd",
  phone: "+94 11 234 5678",
  email: "hello@inspire.lk",
  paymentInstructions: "Quote the invoice number as the reference.",
  logoFileId: null,
  currency: "LKR",
};

function invoiceInput(overrides: Partial<InvoicePdfInput> = {}): InvoicePdfInput {
  return {
    invoiceNumber: "INV-2026-000123",
    kind: "periodic",
    status: "issued",
    issueDate: "2026-11-01",
    dueDate: "2026-11-08",
    periodStart: "2026-11-01",
    periodEnd: "2026-11-30",
    manualDescription: null,
    currency: "LKR",
    subtotalMinor: "400000",
    adjustmentsMinor: "-50000",
    totalMinor: "350000",
    paidMinor: "100000",
    balanceMinor: "250000",
    voidReason: null,
    voidedAt: null,
    academy: ACADEMY,
    player: { fullName: "Nimal Perera", registrationNo: "IA-2024-0091", ageGroupName: "U12" },
    guardian: { fullName: "Sunil Perera", phone: "+94 77 123 4567" },
    items: [
      {
        lineNo: 1,
        description: "Monthly fee — U12",
        quantity: 1,
        unitAmountMinor: "400000",
        amountMinor: "400000",
        reason: null,
      },
      {
        lineNo: 2,
        description: "Sibling discount",
        quantity: 1,
        unitAmountMinor: "-50000",
        amountMinor: "-50000",
        reason: "second child",
      },
    ],
    timezone: "Asia/Colombo",
    ...overrides,
  };
}

describe("the invoice self-check (FILES_AND_PDF §4)", () => {
  it("accepts an invoice whose arithmetic holds", () => {
    expect(() => assertInvoiceTotals(invoiceInput())).not.toThrow();
  });

  it("refuses items that do not sum to the subtotal", () => {
    const input = invoiceInput({
      items: [
        {
          lineNo: 1,
          description: "Fee",
          quantity: 1,
          unitAmountMinor: "400000",
          amountMinor: "399000",
          reason: null,
        },
      ],
    });
    expect(() => assertInvoiceTotals(input)).toThrow(/PDF_TOTAL_MISMATCH/);
  });

  it("refuses a stored balance that disagrees with total minus paid", () => {
    expect(() => assertInvoiceTotals(invoiceInput({ balanceMinor: "999999" }))).toThrow(
      /PDF_TOTAL_MISMATCH/,
    );
  });

  it("refuses a line whose amount is not quantity × unit amount", () => {
    // The totals still add up here, so only the per-line check can catch it — which is the
    // reason it exists.
    const input = invoiceInput({
      subtotalMinor: "800000",
      adjustmentsMinor: "0",
      totalMinor: "800000",
      paidMinor: "0",
      balanceMinor: "800000",
      items: [
        {
          lineNo: 1,
          description: "Fee",
          quantity: 2,
          unitAmountMinor: "400000",
          amountMinor: "400000",
          reason: null,
        },
      ],
    });
    expect(() => assertInvoiceTotals(input)).toThrow(/PDF_TOTAL_MISMATCH/);
  });
});

describe("the receipt self-check", () => {
  const base: ReceiptPdfInput = {
    receiptNumber: "RCT-2026-000045",
    paymentMethodLabel: "Bank transfer",
    paymentReference: "REF-889912",
    payerName: "Sunil Perera",
    amountMinor: "150000",
    unallocatedMinor: "50000",
    currency: "LKR",
    receivedAt: "2026-11-03",
    issuedAt: "2026-11-03",
    allocations: [
      {
        invoiceNumber: "INV-2026-000123",
        playerName: "Nimal Perera",
        appliedMinor: "100000",
        invoiceBalanceAfterMinor: "250000",
      },
    ],
    reversedAt: null,
    academy: ACADEMY,
    timezone: "Asia/Colombo",
  };

  it("accepts allocations plus credit that account for the amount received", () => {
    expect(() => assertReceiptTotals(base)).not.toThrow();
  });

  it("refuses a receipt whose allocations and credit do not account for the amount", () => {
    expect(() => assertReceiptTotals({ ...base, unallocatedMinor: "0" })).toThrow(
      /PDF_TOTAL_MISMATCH/,
    );
  });

  it("refuses a non-positive allocation", () => {
    expect(() =>
      assertReceiptTotals({
        ...base,
        allocations: [{ ...base.allocations[0]!, appliedMinor: "0" }],
        unallocatedMinor: "150000",
      }),
    ).toThrow(/PDF_TOTAL_MISMATCH/);
  });
});

describe("a rendered invoice", () => {
  it("is a real PDF with a page and the document's own creation date", async () => {
    const result = await buildInvoicePdf(invoiceInput(), {
      logo: null,
      generatedAt: new Date("2026-11-03T08:35:00Z"),
    });
    expect(result.bytes.subarray(0, 5).toString()).toBe("%PDF-");
    expect(result.pages).toBe(1);
    // Determinism (§4): the trailer's CreationDate is the invoice's issue date, not "now", so
    // two renders of the same input cannot differ by a timestamp.
    expect(result.bytes.toString("latin1")).toContain("D:20261101000000");
  });
});
