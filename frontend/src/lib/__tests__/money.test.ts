// T-UI-01 — money helper unit tests (TESTING_AND_ACCEPTANCE §2.1).
// Money is integer minor units everywhere (BILLING_ENGINE §1/§15): these tests
// pin the formatting cases the spec names (0, 1, 99, 100, 123456789), the
// strict parser, the fractional-money setting and the contract cap.
import { describe, expect, it } from "vitest";
import {
  MINOR_MAX,
  formatMoneyMinor,
  moneyMinorToEditText,
  parseMoneyInput,
  sumMinor,
} from "../money";

describe("formatMoneyMinor", () => {
  it("shows whole rupees without decimals and paise when non-zero", () => {
    expect(formatMoneyMinor(0)).toBe("Rs. 0");
    expect(formatMoneyMinor(1)).toBe("Rs. 0.01");
    expect(formatMoneyMinor(99)).toBe("Rs. 0.99");
    expect(formatMoneyMinor(100)).toBe("Rs. 1");
    expect(formatMoneyMinor(400000)).toBe("Rs. 4,000");
    expect(formatMoneyMinor(400050)).toBe("Rs. 4,000.50");
    expect(formatMoneyMinor(123456789)).toBe("Rs. 1,234,567.89");
  });

  it("prints documents as LKR with two decimals", () => {
    expect(formatMoneyMinor(400000, { full: true })).toBe("LKR 4,000.00");
    expect(formatMoneyMinor(0, { full: true })).toBe("LKR 0.00");
  });

  it("marks negatives with a minus, never a float", () => {
    expect(formatMoneyMinor(-200000)).toBe("−Rs. 2,000");
    expect(formatMoneyMinor(-200050, { full: true })).toBe("−LKR 2,000.50");
  });

  it("refuses a non-integer instead of rounding it", () => {
    expect(() => formatMoneyMinor(4000.5)).toThrow(/never floats/);
  });
});

describe("parseMoneyInput", () => {
  it("parses plain, grouped and currency-labelled input", () => {
    expect(parseMoneyInput("4000")).toEqual({ minor: 400000 });
    expect(parseMoneyInput("4,000")).toEqual({ minor: 400000 });
    expect(parseMoneyInput("Rs. 4,000")).toEqual({ minor: 400000 });
    expect(parseMoneyInput("LKR 4000.50")).toEqual({ minor: 400050 });
    expect(parseMoneyInput("4000.5")).toEqual({ minor: 400050 });
    expect(parseMoneyInput("  2500  ")).toEqual({ minor: 250000 });
  });

  it("rejects an ambiguous or impossible amount", () => {
    expect(parseMoneyInput("")).toEqual({ error: "Enter an amount" });
    expect("error" in parseMoneyInput("abc")).toBe(true);
    expect("error" in parseMoneyInput("4000.567")).toBe(true);
    expect("error" in parseMoneyInput("-100")).toBe(true);
    expect("error" in parseMoneyInput("4.000,00")).toBe(true);
  });

  it("requires more than zero unless the caller allows zero", () => {
    expect(parseMoneyInput("0")).toEqual({ error: "Amount must be more than zero" });
    expect(parseMoneyInput("0", { allowZero: true })).toEqual({ minor: 0 });
  });

  it("honours the academy's whole-rupee setting", () => {
    expect(parseMoneyInput("4000.50", { allowFractional: false })).toEqual({
      error: "This academy records whole rupees only",
    });
    expect(parseMoneyInput("4000.00", { allowFractional: false })).toEqual({ minor: 400000 });
    expect(parseMoneyInput("4000.50", { allowFractional: true })).toEqual({ minor: 400050 });
  });

  it("caps the amount at the contract maximum", () => {
    expect(parseMoneyInput("100000000")).toEqual({ minor: MINOR_MAX });
    expect(parseMoneyInput("100000001")).toEqual({ error: "That amount is too large" });
  });
});

describe("moneyMinorToEditText / sumMinor", () => {
  it("round-trips an amount through the editable field text", () => {
    expect(moneyMinorToEditText(400000)).toBe("4000.00");
    expect(moneyMinorToEditText(50)).toBe("0.50");
    expect(parseMoneyInput(moneyMinorToEditText(400050))).toEqual({ minor: 400050 });
  });

  it("adds minor units as integers", () => {
    expect(sumMinor([400000, 150000, 50])).toBe(550050);
    expect(sumMinor([])).toBe(0);
    expect(() => sumMinor([1.5])).toThrow(/never floats/);
  });
});
