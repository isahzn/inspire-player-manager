// Date helpers for business dates ("YYYY-MM-DD", academy-local) and instants.
// Business dates are NEVER parsed with `new Date(str)` — that would shift the
// day across timezones. Strings are split and formatted directly; instants are
// rendered in the academy timezone (Asia/Colombo, UTC+05:30, no DST).
// Step 5 extends this module with unit tests (T-UI-01).

export const ACADEMY_TIMEZONE = "Asia/Colombo";

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

/** "2026-01-10" → { y: 2026, m: 1, d: 10 } (null when malformed). */
export function parseDateStr(value: string): { y: number; m: number; d: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const y = Number(m[1]);
  const month = Number(m[2]);
  const d = Number(m[3]);
  if (month < 1 || month > 12 || d < 1 || d > 31) return null;
  return { y, m: month, d };
}

/** Days since epoch for a business date — pure arithmetic, timezone-free. */
function dayNumber(value: string): number | null {
  const p = parseDateStr(value);
  if (!p) return null;
  // Civil-from-days algorithm (Howard Hinnant), integer-only.
  const y = p.m <= 2 ? p.y - 1 : p.y;
  const era = Math.floor((y >= 0 ? y : y - 399) / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (p.m + (p.m > 2 ? -3 : 9)) + 2) / 5) + p.d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** Days since epoch → "YYYY-MM-DD". */
function fromDayNumber(days: number): string {
  const z = days + 719468;
  const era = Math.floor((z >= 0 ? z : z - 146096) / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  const year = m <= 2 ? y + 1 : y;
  return `${String(year).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** "2026-01-10" → "10 Jan 2026". Empty/invalid → fallback. */
export function formatDateStr(value?: string | null, fallback = "—"): string {
  if (!value) return fallback;
  const p = parseDateStr(value);
  if (!p) return fallback;
  return `${p.d} ${MONTHS[p.m - 1]} ${p.y}`;
}

/** UTC instant → "14 Mar 2015, 10:05" in the academy timezone. */
export function formatInstant(value?: string | null, fallback = "—"): string {
  if (!value) return fallback;
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return fallback;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: ACADEMY_TIMEZONE,
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(at);
  return parts.replace(",", "");
}

/** Today as an academy-local business date. */
export function todayISO(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: ACADEMY_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** Business date ± days. Returns "" when the input is not a date. */
export function addDaysISO(value: string, days: number): string {
  const n = dayNumber(value);
  if (n === null) return "";
  return fromDayNumber(n + days);
}

/** Completed years between two business dates (0 when malformed). */
export function ageOn(dateOfBirth: string, reference: string): number {
  const b = parseDateStr(dateOfBirth);
  const r = parseDateStr(reference);
  if (!b || !r) return 0;
  let age = r.y - b.y;
  if (r.m < b.m || (r.m === b.m && r.d < b.d)) age -= 1;
  return age < 0 ? 0 : age;
}

/** First day of next month (default `effectiveFrom` for a fee change). */
export function firstOfNextMonthISO(from: string = todayISO()): string {
  const p = parseDateStr(from);
  if (!p) return "";
  const y = p.m === 12 ? p.y + 1 : p.y;
  const m = p.m === 12 ? 1 : p.m + 1;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-01`;
}

/** "10 Jan 2026" or "10 Jan 2026 – 12 Feb 2026" when an end date exists. */
export function formatDateRange(from?: string | null, to?: string | null): string {
  const start = formatDateStr(from);
  return to ? `${start} – ${formatDateStr(to)}` : start;
}

// --- instants ↔ academy-local time (Step 4) --------------------------------
// Session times are wall-clock times in the academy's zone stored as UTC
// instants, so the conversion has to be done in two steps (guess an offset,
// correct it) and the offset must be READ from the tz database for that date —
// never hardcoded (ATTENDANCE §2: a future DST/zone change must keep working).

/** Offset of `zone` from UTC at that instant, in minutes (read from the tz db). */
function zoneOffsetMinutes(zone: string, at: Date): number {
  const parts: Record<string, number> = {};
  for (const part of new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at)) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour % 24,
    parts.minute,
    parts.second
  );
  return Math.round((asUtc - at.getTime()) / 60000);
}

/** Academy-local date + "HH:mm" → UTC instant. "" when the input is malformed. */
export function academyLocalToInstant(dateISO: string, time: string): string {
  const clock = /^(\d{2}):(\d{2})$/.exec(time);
  if (!parseDateStr(dateISO) || !clock) return "";
  const guess = Date.parse(`${dateISO}T${clock[1]}:${clock[2]}:00Z`);
  if (Number.isNaN(guess)) return "";
  const offset = zoneOffsetMinutes(ACADEMY_TIMEZONE, new Date(guess));
  return new Date(guess - offset * 60_000).toISOString();
}

/**
 * The first instant of an academy-local business date.
 *
 * The contract types several list filters (`/payments`, `/audit-logs`) as **instants**
 * (`Instant`, `format: date-time`), while the screens offer a date picker. Sending the
 * date itself is a 422 (`Invalid ISO datetime`), which is what the 2026-10-15 UI audit
 * found on `/payments` (defect A3) — so a business date is widened to the day it names.
 * Returns "" for a malformed date, which callers treat as "no filter".
 */
export function startOfAcademyDay(dateISO: string): string {
  return academyLocalToInstant(dateISO, "00:00");
}

/** The last instant of an academy-local business date (23:59:59.999). "" when malformed. */
export function endOfAcademyDay(dateISO: string): string {
  const start = academyLocalToInstant(dateISO, "00:00");
  if (!start) return "";
  return new Date(Date.parse(start) + 86_400_000 - 1).toISOString();
}

/**
 * Widens a list query's business dates to the academy-local instants the contract wants.
 *
 * PAY-01 and AUD-01 type `from`/`to` as instants (`format: date-time`), so a raw
 * `YYYY-MM-DD` from a date picker is a 422 — that is what took the payments list down with
 * "Something went wrong" (2026-10-15 audit, defect A3). This is a module-level helper
 * rather than inline code so it can be applied **inside a query function**: the React
 * Compiler's `preserve-manual-memoization` rule refuses to preserve a `useMemo` whose
 * dependency is passed to a call in the component body.
 */
export function withAcademyDayRange<T extends { from?: string; to?: string }>(params: T): T {
  const next: T = { ...params };
  if (params.from) next.from = startOfAcademyDay(params.from) || undefined;
  if (params.to) next.to = endOfAcademyDay(params.to) || undefined;
  return next;
}

/** UTC instant → "16:00" in the academy timezone. */
export function academyTime(value?: string | null, fallback = "—"): string {
  if (!value) return fallback;
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return fallback;
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: ACADEMY_TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(at);
}

/** The academy-local business date of an instant ("2026-11-03"). */
export function academyDateOf(instant: string): string {
  const at = new Date(instant);
  if (Number.isNaN(at.getTime())) return "";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: ACADEMY_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

/** Whole minutes between two instants (0 when either is unparseable/negative). */
export function minutesBetween(from: string, to: string): number {
  const a = Date.parse(from);
  const b = Date.parse(to);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.max(0, Math.round((b - a) / 60000));
}

/** 110 → "1 h 50 m" · 45 → "45 min". Hours are only shown when there are any. */
export function formatDuration(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return "0 min";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} m`;
}

/** Instant ± minutes. "" when the input is unparseable. */
export function addMinutes(instant: string, minutes: number): string {
  const at = Date.parse(instant);
  if (Number.isNaN(at)) return "";
  return new Date(at + minutes * 60_000).toISOString();
}

/** Signed minutes from `from` to `to` (negative when `to` is earlier). */
export function signedMinutes(from: string, to: string): number {
  const a = Date.parse(from);
  const b = Date.parse(to);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 60000);
}
