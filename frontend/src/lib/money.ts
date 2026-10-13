// Strict money helpers — LKR minor units only.
// Contract (API_CONTRACTS §1, BILLING_ENGINE §1/§15): every money field is an
// integer named `*Minor` (400000 = LKR 4,000.00). There are no floats in this
// module: parsing works on the digit string, never on `Number(raw) * 100`, and
// formatting refuses a non-integer input instead of rounding it silently.
// Unit tests: src/lib/__tests__/money.test.ts (T-UI-01).

/** Contract cap (BILLING_ENGINE §15): amountMinor is 1..10_000_000_000 (LKR 100 M). */
export const MINOR_MAX = 10_000_000_000;

/** 1234567 → "1,234,567" (3-digit grouping, locale-independent). */
function groupDigits(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * Format integer minor units.
 * Default (compact, for tables/cards): "Rs. 4,000" — paise shown only when non-zero.
 * `full: true` (documents/receipts/confirmations): "LKR 4,000.00".
 * Negatives carry a real minus sign (BILLING_ENGINE §15).
 */
export function formatMoneyMinor(
  minor: number,
  opts: { full?: boolean } = {}
): string {
  if (!Number.isInteger(minor)) {
    throw new Error(
      `formatMoneyMinor: ${minor} is not integer minor units (money never floats)`
    );
  }
  const negative = minor < 0;
  const abs = Math.abs(minor);
  const rupees = Math.trunc(abs / 100);
  const paise = abs % 100;
  const paiseText = String(paise).padStart(2, "0");
  const body =
    paise === 0 && !opts.full
      ? groupDigits(String(rupees))
      : `${groupDigits(String(rupees))}.${paiseText}`;
  return `${negative ? "−" : ""}${opts.full ? "LKR" : "Rs."} ${body}`;
}

export interface ParseMoneyOptions {
  /** Allow an exactly-zero amount (adjustment previews use 0 as "no change"). */
  allowZero?: boolean;
  /**
   * `academy_settings.allow_fractional_money` (BILLING_ENGINE §2): when false the
   * amount must be whole rupees. Default true — the setting is only known once
   * SET-02 has been read.
   */
  allowFractional?: boolean;
}

/**
 * Parse owner input into integer minor units. Accepts a bare number, thousands
 * separators, and a leading `Rs`/`Rs.`/`LKR` label (API_INTEGRATION §6). Rejects
 * anything ambiguous so a typo can never become a wrong amount.
 */
export function parseMoneyInput(
  raw: string,
  opts: ParseMoneyOptions = {}
): { minor: number } | { error: string } {
  // Strip the currency label the owner may have typed or pasted, then
  // separators/spaces. Everything after this must be digits and one dot.
  const text = raw
    .trim()
    .replace(/^(lkr|rs\.?)\s*/i, "")
    .replace(/[\s,]/g, "");
  if (!text) return { error: "Enter an amount" };
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(text)) {
    return { error: "Use digits only, like 4000 or 4000.50" };
  }
  const [rupees, decimals = ""] = text.split(".");
  if (opts.allowFractional === false && decimals !== "" && /[1-9]/.test(decimals)) {
    return { error: "This academy records whole rupees only" };
  }
  // Integer arithmetic on the digit string: paise are the last two digits.
  const minor = Number(rupees) * 100 + Number(decimals.padEnd(2, "0"));
  if (!Number.isSafeInteger(minor)) return { error: "That amount is too large" };
  if (minor === 0 && !opts.allowZero) return { error: "Amount must be more than zero" };
  if (minor > MINOR_MAX) return { error: "That amount is too large" };
  return { minor };
}

/** Integer minor units → "4000.00" for an editable field (never a float). */
export function moneyMinorToEditText(minor: number): string {
  if (!Number.isInteger(minor)) {
    throw new Error("moneyMinorToEditText: minor units must be an integer");
  }
  const abs = Math.abs(minor);
  return `${minor < 0 ? "-" : ""}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/**
 * Sum integer minor units without ever touching a float. Money arithmetic in
 * this app is integer-only (BILLING_ENGINE §1), so the strict integer check is
 * the guard rail, not a formality.
 */
export function sumMinor(values: number[]): number {
  let total = 0;
  for (const value of values) {
    if (!Number.isInteger(value)) {
      throw new Error("sumMinor: money never floats");
    }
    total += value;
  }
  return total;
}
