/**
 * The formatting rules PDFs follow (FILES_AND_PDF §2). They are separate from the serializers
 * on purpose: an API response carries ISO instants and integer minor units, while a document
 * that a guardian reads carries `dd MMM yyyy` and `LKR 4,000.00`. Sharing one formatter with
 * the API would make one of the two wrong.
 *
 * Amounts arrive as **strings** because they are `bigint` columns read through `pg`; parsing
 * them into a JS `number` is exactly the rounding the money rules forbid, so every step here
 * stays in `BigInt`.
 */

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

/**
 * `LKR 4,000.00` — always two decimals, thousands separators, a minus sign for negatives.
 *
 * The sign is placed outside the currency (`-LKR 500.00`) rather than inside it, because a
 * minus wedged against the digits is the first thing to be misread.
 */
export function formatMoney(minor: string | number, currency: string): string {
  const value = BigInt(typeof minor === "number" ? Math.trunc(minor) : minor);
  const negative = value < 0n;
  const absolute = negative ? -value : value;

  const whole = (absolute / 100n).toString();
  const cents = (absolute % 100n).toString().padStart(2, "0");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

  return `${negative ? "-" : ""}${currency} ${grouped}.${cents}`;
}

/**
 * `01 Nov 2026` from a `YYYY-MM-DD` business date.
 *
 * The parts are formatted directly instead of going through `Date`, because
 * `new Date("2026-11-01")` is UTC midnight and renders as 31 October in any negative offset —
 * a one-day error on every invoice, visible only in some server timezones.
 */
export function formatDate(isoDate: string | null): string {
  if (!isoDate) return "—";
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate);
  if (!match) return isoDate;
  const [, year, month, day] = match;
  const name = MONTHS[Number(month) - 1];
  return name ? `${day} ${name} ${year}` : isoDate;
}

/** `01 Nov 2026 – 30 Nov 2026`, the billing-period line. */
export function formatPeriod(start: string | null, end: string | null): string | null {
  if (!start || !end) return null;
  return `${formatDate(start)} – ${formatDate(end)}`;
}

/** `11 Oct 2026 14:05`, from a timestamp and the academy's own timezone. */
export function formatInstant(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(at);

  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";

  return `${get("day")} ${get("month")} ${get("year")} ${get("hour")}:${get("minute")}`;
}
