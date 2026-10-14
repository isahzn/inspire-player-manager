/**
 * The report module's pure half: the CSV writer and the ordering.
 *
 * These are the parts a spreadsheet or the on-screen table actually depends on, and both are
 * testable without a database — which is why the arithmetic and the SQL were split in the first
 * place. The rule under test throughout is the money one: **an export a spreadsheet will sum must
 * carry plain decimal numbers**, and a value that could be read as a formula must not be.
 */
import { describe, expect, it } from "vitest";
import {
  EXPORT_ROW_CAP,
  REPORT_COLUMNS,
  csvCell,
  csvFilename,
  sortRows,
  type ReportRow,
} from "../../src/ops/reports.js";

describe("RPT-02 CSV cells", () => {
  it("writes money as a plain two-decimal number so a spreadsheet can sum the column", () => {
    expect(csvCell(400000, "money")).toBe("4000.00");
    expect(csvCell(12345, "money")).toBe("123.45");
    expect(csvCell(0, "money")).toBe("0.00");
    // No currency symbol, no thousands separator: both break a numeric cell.
    expect(csvCell(400000, "money")).not.toContain(",");
    expect(csvCell(400000, "money")).not.toContain("LKR");
  });

  it("writes an absent value as an empty cell, never as a guess", () => {
    expect(csvCell(null, "money")).toBe("");
    expect(csvCell(null, "text")).toBe("");
    expect(csvCell(null, "number")).toBe("");
  });

  it("neutralises every formula-injection prefix the contract names", () => {
    for (const dangerous of ["=", "+", "-", "@", "\t", "\r"]) {
      const cell = csvCell(`${dangerous}cmd`, "text");
      // The prefix is applied first, then the cell is quoted **only if it must be** — a CR
      // forces quoting, `=` does not. So the leading apostrophe is inside the quotes when the
      // cell was quoted and bare when it was not, and the rule under test is the same either
      // way: the first character a spreadsheet sees must not be the dangerous one.
      const unquoted = cell.startsWith('"') && cell.endsWith('"') ? cell.slice(1, -1) : cell;
      expect(unquoted, `prefix ${JSON.stringify(dangerous)}`).toBe(`'${dangerous}cmd`);
    }
  });

  it("quotes a cell containing a quote, a comma or a newline, doubling the quotes", () => {
    expect(csvCell('Perera, Nimal', "text")).toBe('"Perera, Nimal"');
    expect(csvCell('He said "hello"', "text")).toBe('"He said ""hello"""');
    expect(csvCell("two\nlines", "text")).toBe('"two\nlines"');
  });

  it("leaves an ordinary value alone", () => {
    expect(csvCell("Kasun Perera", "text")).toBe("Kasun Perera");
    expect(csvCell("2026-10-14", "date")).toBe("2026-10-14");
    expect(csvCell(7, "number")).toBe("7");
  });
});

describe("RPT-01/02 column metadata", () => {
  it("carries the eight reports and the columns the ratified mock defines", () => {
    expect(Object.keys(REPORT_COLUMNS)).toHaveLength(8);
    expect(REPORT_COLUMNS.players.map((c) => c.key)).toEqual([
      "registrationNo",
      "fullName",
      "group",
      "status",
      "registrationDate",
      "dateOfBirth",
      "guardianName",
      "guardianPhone",
    ]);
    expect(REPORT_COLUMNS.collections.map((c) => c.key)).toEqual([
      "bucket",
      "collectedMinor",
      "invoicedMinor",
      "count",
    ]);
    // Invoiced and collected are separate columns, never one money figure (CLAUDE.md).
    expect(REPORT_COLUMNS.collections.map((c) => c.label)).toContain("Collected");
    expect(REPORT_COLUMNS.collections.map((c) => c.label)).toContain("Invoiced");
  });

  it("caps one export at 50,000 rows", () => {
    expect(EXPORT_ROW_CAP).toBe(50_000);
  });
});

describe("report ordering", () => {
  const rows: ReportRow[] = [
    { invoiceNumber: "INV-2", balanceMinor: 100, dueDate: "2026-11-02" },
    { invoiceNumber: "INV-1", balanceMinor: 300, dueDate: "2026-11-01" },
    { invoiceNumber: "INV-3", balanceMinor: null, dueDate: "2026-11-03" },
  ];

  it("orders by an explicit field, and `-field` descending", () => {
    expect(sortRows("invoices", rows, "invoiceNumber").rows.map((r) => r["invoiceNumber"])).toEqual(
      ["INV-1", "INV-2", "INV-3"],
    );
    expect(sortRows("invoices", rows, "balanceMinor").rows.map((r) => r["invoiceNumber"])).toEqual(
      // 100, 300, then the empty cell — an absent value sorts last in either direction.
      ["INV-2", "INV-1", "INV-3"],
    );
    expect(sortRows("invoices", rows, "-balanceMinor").rows.map((r) => r["invoiceNumber"])).toEqual(
      ["INV-1", "INV-2", "INV-3"],
    );
  });

  it("reports an unknown field instead of quietly returning a different order", () => {
    const result = sortRows("invoices", rows, "notAColumn");
    expect(result.unknown).toBe("notAColumn");
  });

  it("applies the report's own default order when no sort is asked for", () => {
    expect(sortRows("invoices", rows, undefined).rows.map((r) => r["invoiceNumber"])).toEqual([
      "INV-1",
      "INV-2",
      "INV-3",
    ]);
  });
});

describe("export filename", () => {
  it("names the report, the academy's date and the filters, sanitised", () => {
    const name = csvFilename("players", { status: "active" }, "2026-10-14");
    expect(name).toBe("report-players-2026-10-14-status-active.csv");
    expect(csvFilename("players", {}, "2026-10-14")).toBe("report-players-2026-10-14.csv");
  });
});
