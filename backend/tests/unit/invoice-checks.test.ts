/**
 * The invoice message and the invoice checks (the two owner-facing tools).
 *
 * Both are pure here on purpose: the checks are arithmetic over rows, and the message is
 * substitution over one, so they are tested without a database and the SQL is left to the
 * integration surface. The interesting cases are the **refusals** — a paid invoice that still
 * asks for money, a template with a gap in it, a total that does not match its lines — because
 * each of those fails silently in production if it is not caught here.
 */
import { describe, expect, it } from "vitest";
import { formatMoney } from "../../src/files/pdf/format.js";
import {
  buildInvoiceMessage,
  type InvoiceForMessage,
} from "../../src/messaging/invoice-message.js";
import { fillTemplate, inspectTemplate } from "../../src/messaging/template.js";
import { checkInvoiceHealth, type InvoiceHealthRow } from "../../src/ops/invoice-health.js";

describe("template filling", () => {
  it("substitutes every variable it is given", () => {
    const filled = fillTemplate("Hello {{guardianName}}, {{amountDue}} by {{dueDate}}.", {
      guardianName: "Nimal",
      amountDue: "LKR 4,000.00",
      dueDate: "01 Nov 2026",
    });
    expect(filled.text).toBe("Hello Nimal, LKR 4,000.00 by 01 Nov 2026.");
    expect(filled.missing).toEqual([]);
    expect(filled.unknown).toEqual([]);
  });

  it("leaves a supplied-nothing placeholder in place and reports it", () => {
    // An empty "Amount due: " is worse than a refusal: nobody notices it.
    const filled = fillTemplate("Amount due: {{amountDue}}", {});
    expect(filled.text).toBe("Amount due: {{amountDue}}");
    expect(filled.missing).toEqual(["amountDue"]);
  });

  it("treats a typo as unknown rather than as a variable", () => {
    const filled = fillTemplate("{{amounDue}}", { amountDue: "LKR 1.00" });
    expect(filled.text).toBe("{{amounDue}}");
    expect(filled.unknown).toEqual(["amounDue"]);
    expect(filled.missing).toEqual([]);
  });

  it("tolerates whitespace inside the braces", () => {
    expect(fillTemplate("{{ amountDue }}", { amountDue: "LKR 1.00" }).text).toBe("LKR 1.00");
  });

  it("reports the variables a body uses, for validation on save", () => {
    expect(inspectTemplate("{{playerName}} {{invoiceNumber}} {{nope}}")).toEqual({
      used: ["playerName", "invoiceNumber", "nope"],
      unknown: ["nope"],
    });
  });
});

const TEMPLATE =
  "Hello {{guardianName}}, this is {{academyName}}. Invoice {{invoiceNumber}} for {{playerName}} is ready.\n" +
  "Amount due: {{amountDue}} · Due: {{dueDate}}\n" +
  "View/download: {{invoiceLink}}\n" +
  "Reply STOP to stop these messages.";

function invoice(overrides: Partial<InvoiceForMessage> = {}): InvoiceForMessage {
  return {
    invoiceNumber: "INV-2026-000123",
    status: "issued",
    currency: "LKR",
    balanceMinor: "400000",
    dueDate: "2026-11-08",
    playerName: "Kasun Perera",
    guardianName: "Nimal Perera",
    guardianPhone: "+94771234567",
    academyName: "Inspire Academy",
    ...overrides,
  };
}

describe("invoice message", () => {
  it("builds the seeded template with the money and the link filled in", () => {
    const plan = buildInvoiceMessage({
      templateBody: TEMPLATE,
      invoice: invoice(),
      invoiceLink: "https://api.test/api/v1/public/invoices/tok/pdf",
    });
    expect(plan.sendable).toBe(true);
    if (!plan.sendable) return;
    expect(plan.text).toContain("Invoice INV-2026-000123 for Kasun Perera is ready.");
    expect(plan.text).toContain("Amount due: LKR 4,000.00 · Due: 08 Nov 2026");
    expect(plan.text).toContain("https://api.test/api/v1/public/invoices/tok/pdf");
    expect(plan.text).not.toContain("{{");
    expect(plan.to).toBe("+94771234567");
  });

  it("asks for what is still owed, not what was billed", () => {
    // The whole reason the amount is read from the invoice at the moment of sending.
    const plan = buildInvoiceMessage({
      templateBody: TEMPLATE,
      invoice: invoice({ status: "partially_paid", balanceMinor: "250000" }),
      invoiceLink: "https://api.test/x",
    });
    expect(plan.sendable).toBe(true);
    if (!plan.sendable) return;
    expect(plan.text).toContain(formatMoney("250000", "LKR"));
  });

  it("refuses a settled invoice", () => {
    const plan = buildInvoiceMessage({
      templateBody: TEMPLATE,
      invoice: invoice({ status: "paid", balanceMinor: "0" }),
      invoiceLink: "https://api.test/x",
    });
    expect(plan).toMatchObject({ sendable: false, reason: "NOTHING_DUE" });
  });

  it("refuses a void invoice", () => {
    const plan = buildInvoiceMessage({
      templateBody: TEMPLATE,
      invoice: invoice({ status: "void" }),
      invoiceLink: "https://api.test/x",
    });
    expect(plan).toMatchObject({ sendable: false, reason: "INVOICE_VOID" });
  });

  it("refuses when the template needs a link that was not supplied", () => {
    const plan = buildInvoiceMessage({ templateBody: TEMPLATE, invoice: invoice() });
    expect(plan).toMatchObject({ sendable: false, reason: "TEMPLATE_INCOMPLETE" });
    if (plan.sendable) return;
    expect(plan.detail).toContain("invoiceLink");
  });

  it("refuses when there is no guardian to address", () => {
    const plan = buildInvoiceMessage({
      templateBody: TEMPLATE,
      invoice: invoice({ guardianName: null }),
      invoiceLink: "https://api.test/x",
    });
    expect(plan).toMatchObject({ sendable: false, reason: "NO_GUARDIAN" });
  });

  it("reports a missing template rather than sending a blank message", () => {
    const plan = buildInvoiceMessage({
      templateBody: null,
      invoice: invoice(),
      invoiceLink: "https://api.test/x",
    });
    expect(plan).toMatchObject({ sendable: false, reason: "TEMPLATE_MISSING" });
  });
});

const TODAY = "2026-10-14";

function row(overrides: Partial<InvoiceHealthRow> = {}): InvoiceHealthRow {
  return {
    id: "01930000-0000-7000-8000-000000000001",
    invoiceNumber: "INV-2026-000123",
    status: "issued",
    currency: "LKR",
    dueDate: "2026-11-08",
    totalMinor: "400000",
    paidMinor: "0",
    balanceMinor: "400000",
    itemsTotalMinor: "400000",
    allocatedMinor: "0",
    pdfFileId: "01930000-0000-7000-8000-0000000000ff",
    pdfStale: false,
    pdfGeneratedAt: new Date("2026-10-14T09:00:00Z"),
    guardianName: "Nimal Perera",
    liveLinks: 0,
    ...overrides,
  };
}

function codes(rows: InvoiceHealthRow[]) {
  return checkInvoiceHealth(rows, { today: TODAY }).findings.map((f) => f.code);
}

describe("invoice health", () => {
  it("finds nothing wrong with a healthy invoice", () => {
    const report = checkInvoiceHealth([row()], { today: TODAY });
    expect(report.findings).toEqual([]);
    expect(report.summary).toMatchObject({ checked: 1, errors: 0, warns: 0, infos: 0 });
  });

  it("catches a total that does not match its lines", () => {
    expect(codes([row({ itemsTotalMinor: "390000" })])).toContain("INVOICE_TOTAL_MISMATCH");
  });

  it("catches a balance that is not total minus paid", () => {
    expect(codes([row({ balanceMinor: "300000" })])).toContain("INVOICE_BALANCE_MISMATCH");
  });

  it("catches money still allocated to a void invoice", () => {
    const found = codes([row({ status: "void", allocatedMinor: "100000" })]);
    expect(found).toContain("VOID_WITH_ALLOCATIONS");
  });

  it("catches an invoice marked paid with nothing allocated to it", () => {
    const found = codes([
      row({ status: "paid", paidMinor: "400000", balanceMinor: "0", allocatedMinor: "0" }),
    ]);
    expect(found).toContain("PAID_NOT_ALLOCATED");
  });

  it("catches allocations that exceed what was paid", () => {
    expect(codes([row({ allocatedMinor: "500000" })])).toContain("ALLOCATION_EXCEEDS_PAID");
  });

  it("catches a capability link that survived its invoice being voided", () => {
    expect(codes([row({ status: "void", liveLinks: 2 })])).toContain("VOID_WITH_LIVE_LINK");
  });

  it("warns that no document exists yet", () => {
    expect(codes([row({ pdfFileId: null })])).toContain("PDF_MISSING");
  });

  it("escalates a document that has been stale for longer than the threshold", () => {
    const rows = [
      row({ pdfStale: true, pdfGeneratedAt: new Date("2026-10-14T08:00:00Z") }),
    ];
    const report = checkInvoiceHealth(rows, {
      today: TODAY,
      now: new Date("2026-10-14T09:00:00Z"),
      staleMinutes: 10,
    });
    expect(report.findings.map((f) => f.severity)).toEqual(["warn"]);
    expect(report.findings[0]!.code).toBe("PDF_REBUILD_OVERDUE");

    // A document flagged a moment ago is a note, not an alarm.
    const fresh = checkInvoiceHealth([row({ pdfStale: true })], {
      today: TODAY,
      now: new Date("2026-10-14T09:00:00Z"),
      staleMinutes: 10,
    });
    expect(fresh.findings[0]!.code).toBe("PDF_STALE");
    expect(fresh.findings[0]!.severity).toBe("info");
  });

  it("counts what is overdue and sums it without losing a cent", () => {
    const report = checkInvoiceHealth(
      [
        row({ dueDate: "2026-10-01", balanceMinor: "400000" }),
        row({
          id: "01930000-0000-7000-8000-000000000002",
          invoiceNumber: "INV-2026-000124",
          dueDate: "2026-10-02",
          totalMinor: "123457",
          balanceMinor: "123456",
          itemsTotalMinor: "123457",
          status: "partially_paid",
          paidMinor: "1",
          allocatedMinor: "1",
        }),
        row({
          id: "01930000-0000-7000-8000-000000000003",
          invoiceNumber: "INV-2026-000125",
          dueDate: "2026-12-01",
        }),
      ],
      { today: TODAY },
    );
    expect(report.summary.overdueCount).toBe(2);
    expect(report.summary.overdueMinor).toBe((400000n + 123456n).toString());
    // A partially paid invoice that is past its due date is overdue (BILLING_ENGINE §10).
    expect(report.findings.filter((f) => f.code === "OVERDUE")).toHaveLength(2);
  });

  it("puts errors before warnings before notes", () => {
    const report = checkInvoiceHealth(
      [
        row({ pdfFileId: null }), // warn
        row({ itemsTotalMinor: "1" }), // error
      ],
      { today: TODAY },
    );
    expect(report.findings.map((f) => f.severity)).toEqual(["error", "warn"]);
  });

  it("says nothing about the document of a void invoice", () => {
    const report = checkInvoiceHealth([row({ status: "void", pdfFileId: null })], { today: TODAY });
    expect(report.findings.map((f) => f.code)).not.toContain("PDF_MISSING");
  });
});
