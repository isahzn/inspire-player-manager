"use client";

// Step 7 report engine for RPT-01/RPT-02 (`GET /reports/{name}` and its CSV
// export). MOCK-ONLY, but it runs on the REAL store: every number is derived
// from the same rows the money slice maintains, so a report can never agree with
// a page it should not.
//
// Rules this module keeps, on purpose:
//   · Invoiced and Collected are computed from different sources (issued invoices
//     vs CONFIRMED payments) and are never added together — not in a column, not
//     in a total, not in a bucket (CLAUDE.md money rule; BILLING_ENGINE §14).
//   · Invoice money comes from the billing engine's own read path, which
//     recomputes paid/balance/status from active allocations on every read
//     (BILLING_ENGINE §1.4) — a report never re-implements that arithmetic, and
//     never trusts a stale `balanceMinor`.
//   · `hours` counts CLOSED coach check-ins only (ATTENDANCE §5).
//   · An unattended field is left empty rather than guessed at.
//
// Filter names are matched leniently (`group`/`ageGroupId`, `from`/`dateFrom`,
// `registeredFrom`/`registrationFrom`, …) because the report pages are written
// against PAGE_SPECIFICATIONS §10 wording while the query strings come from the
// URL — a mismatch there would silently return everything.

import type {
  AttendanceStatus,
  Invoice,
  ReportCell,
  ReportColumn,
  ReportName,
  ReportResult,
  ReportRow,
  Role,
} from "@/api/types";
import { academyDateOf, academyTime, addDaysISO, minutesBetween, todayISO } from "@/lib/dates";
import { listInvoices } from "./billing";
import {
  MockError,
  getDb,
  listCoachAttendance,
  listGroups,
  listSessions,
  sessionAttendanceFor,
  type Db,
} from "./db";
import { actorFor } from "./store678";

export const REPORT_NAMES: ReportName[] = [
  "players",
  "attendance-summary",
  "attendance-detail",
  "invoices",
  "payments",
  "outstanding",
  "collections",
  "coach-attendance",
];

export function isReportName(value: string): value is ReportName {
  return (REPORT_NAMES as string[]).includes(value);
}

/** RPT-02 caps at 50,000 rows (API_CONTRACTS §3.8). */
export const EXPORT_ROW_CAP = 50_000;

type Viewer = { role: Role; userId: string };

export type Filters = Record<string, string>;

export function parseFilters(url: URL): Filters {
  const out: Filters = {};
  for (const [key, value] of url.searchParams.entries()) {
    if (value !== "") out[key] = value;
  }
  return out;
}

const OWNER_VIEWER: Viewer = { role: "owner", userId: "owner" };

/** First value of an alias set, trimmed. */
function pick(filters: Filters, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = filters[key];
    if (value !== undefined && value !== "") return value.trim();
  }
  return undefined;
}

function num(filters: Filters, ...keys: string[]): number | undefined {
  const raw = pick(filters, ...keys);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function firstOfMonth(day: string): string {
  return `${day.slice(0, 7)}-01`;
}

/** Monday-based week start (or the academy's configured first day). */
function weekStartOf(dateISO: string, weekStartDay: number): string {
  const at = Date.parse(`${dateISO}T00:00:00Z`);
  if (Number.isNaN(at)) return dateISO;
  const weekday = new Date(at).getUTCDay(); // 0 = Sunday
  return addDaysISO(dateISO, -((weekday - weekStartDay + 7) % 7));
}

function monthOf(dateISO: string): string {
  return dateISO.slice(0, 7);
}

function includesText(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

/** The player's group on the store's own rule (`age_groups` history, open row). */
function currentGroupName(db: Db, playerId: string): string {
  return db.history.find((h) => h.playerId === playerId && !h.effectiveTo)?.ageGroup.name ?? "—";
}

function currentGroupId(db: Db, playerId: string): string | undefined {
  return db.history.find((h) => h.playerId === playerId && !h.effectiveTo)?.ageGroup.id;
}

function primaryGuardian(db: Db, playerId: string) {
  const player = db.players.find((p) => p.id === playerId);
  return player?.guardians.find((g) => g.isPrimary)?.guardian ?? player?.guardians[0]?.guardian;
}

function methodLabel(db: Db, code: string): string {
  return db.methods.find((m) => m.code === code)?.label ?? code;
}

function activeAllocations(allocations: { amountMinor: number; reversedAt?: string }[]): number {
  return allocations.filter((a) => !a.reversedAt).reduce((sum, a) => sum + a.amountMinor, 0);
}

/**
 * Invoice rows after the billing engine's own recalculation. `listInvoices()` is
 * its public read path and `refreshInvoices()` (private) runs at the top of every
 * billing read, so calling it once here refreshes the store's rows in place —
 * re-deriving balances a second time in this module is exactly the drift the
 * ledger rule exists to prevent.
 */
function refreshedInvoices(): Invoice[] {
  listInvoices({ pageSize: 100 });
  return getDb().invoices;
}

/**
 * The same refresh, for the dashboard's money block: it must read the identical
 * figures the reports and the billing screens read (one ledger, one arithmetic).
 */
export function refreshLedger(): Invoice[] {
  return refreshedInvoices();
}

// ---------------------------------------------------------------------------
// Column sets (PAGE_SPECIFICATIONS §10)
// ---------------------------------------------------------------------------
const COLUMNS: Record<ReportName, ReportColumn[]> = {
  players: [
    { key: "registrationNo", label: "Reg no", type: "text" },
    { key: "fullName", label: "Name", type: "text" },
    { key: "group", label: "Age group", type: "text" },
    { key: "status", label: "Status", type: "text" },
    { key: "registrationDate", label: "Registered", type: "date" },
    { key: "dateOfBirth", label: "Date of birth", type: "date" },
    { key: "guardianName", label: "Primary guardian", type: "text" },
    { key: "guardianPhone", label: "Guardian phone", type: "text" },
  ],
  "attendance-summary": [
    { key: "player", label: "Player", type: "text" },
    { key: "group", label: "Age group", type: "text" },
    { key: "sessions", label: "Sessions", type: "number" },
    { key: "present", label: "Present", type: "number" },
    { key: "late", label: "Late", type: "number" },
    { key: "absent", label: "Absent", type: "number" },
    { key: "excused", label: "Excused", type: "number" },
    { key: "unmarked", label: "Unmarked", type: "number" },
    { key: "ratePercent", label: "Attendance rate %", type: "percent" },
  ],
  "attendance-detail": [
    { key: "sessionDate", label: "Date", type: "date" },
    { key: "session", label: "Session", type: "text" },
    { key: "player", label: "Player", type: "text" },
    { key: "status", label: "Status", type: "text" },
    { key: "note", label: "Note", type: "text" },
    { key: "markedBy", label: "Marked by", type: "text" },
  ],
  invoices: [
    { key: "invoiceNumber", label: "Invoice no", type: "text" },
    { key: "player", label: "Player", type: "text" },
    { key: "group", label: "Age group", type: "text" },
    { key: "period", label: "Period", type: "text" },
    { key: "issueDate", label: "Issued", type: "date" },
    { key: "dueDate", label: "Due", type: "date" },
    { key: "totalMinor", label: "Total", type: "money" },
    { key: "paidMinor", label: "Paid", type: "money" },
    { key: "balanceMinor", label: "Balance", type: "money" },
    { key: "status", label: "Status", type: "text" },
  ],
  payments: [
    { key: "receivedAt", label: "Received", type: "instant" },
    { key: "payer", label: "Payer", type: "text" },
    { key: "method", label: "Method", type: "text" },
    { key: "reference", label: "Reference", type: "text" },
    { key: "amountMinor", label: "Amount", type: "money" },
    { key: "allocatedMinor", label: "Allocated", type: "money" },
    { key: "creditMinor", label: "Credit", type: "money" },
    { key: "status", label: "Status", type: "text" },
    { key: "receiptNumber", label: "Receipt no", type: "text" },
  ],
  outstanding: [
    { key: "player", label: "Player", type: "text" },
    { key: "guardian", label: "Guardian", type: "text" },
    { key: "invoiceNumber", label: "Invoice", type: "text" },
    { key: "dueDate", label: "Due", type: "date" },
    { key: "balanceMinor", label: "Balance", type: "money" },
    { key: "daysOverdue", label: "Days overdue", type: "number" },
  ],
  collections: [
    { key: "bucket", label: "Period", type: "text" },
    // Separate columns, separate sums — never one “collected” figure (CLAUDE.md).
    { key: "collectedMinor", label: "Collected", type: "money" },
    { key: "invoicedMinor", label: "Invoiced", type: "money" },
    { key: "count", label: "Count", type: "number" },
  ],
  "coach-attendance": [
    { key: "coach", label: "Coach", type: "text" },
    { key: "session", label: "Session", type: "text" },
    { key: "checkInAt", label: "In", type: "instant" },
    { key: "checkOutAt", label: "Out", type: "instant" },
    { key: "hours", label: "Hours", type: "number" },
    { key: "corrected", label: "Corrected", type: "text" },
  ],
};

const ATTENDANCE_LABEL: Record<AttendanceStatus, string> = {
  present: "Present",
  late: "Late",
  absent: "Absent",
  excused: "Excused",
};

// ---------------------------------------------------------------------------
// Rows per report
// ---------------------------------------------------------------------------
function playerRows(db: Db, filters: Filters, viewer: Viewer): ReportRow[] {
  const status = pick(filters, "status");
  const group = pick(filters, "ageGroupId", "group");
  const from = pick(filters, "registrationFrom", "registeredFrom", "from");
  const to = pick(filters, "registrationTo", "registeredTo", "to");
  const q = pick(filters, "q");
  // A coach sees only the groups they are assigned (listGroups already scopes).
  const scope =
    viewer.role === "coach" ? new Set(listGroups(true, viewer).map((g) => g.id)) : null;

  return db.players
    .filter((p) => (status ? p.status === status : true))
    .filter((p) => (group ? currentGroupId(db, p.id) === group : true))
    .filter((p) => (scope ? scope.has(currentGroupId(db, p.id) ?? "") : true))
    .filter((p) => (from ? p.registrationDate >= from : true))
    .filter((p) => (to ? p.registrationDate <= to : true))
    .filter((p) => (q ? includesText(p.fullName, q) || includesText(p.registrationNo, q) : true))
    .map((p) => {
      const guardian = primaryGuardian(db, p.id);
      return {
        registrationNo: p.registrationNo,
        fullName: p.fullName,
        group: currentGroupName(db, p.id),
        status: p.status,
        registrationDate: p.registrationDate,
        dateOfBirth: p.dateOfBirth ?? null,
        guardianName: guardian?.fullName ?? null,
        guardianPhone: guardian?.phone ?? null,
      };
    })
    .sort((a, b) => String(a.registrationNo).localeCompare(String(b.registrationNo)));
}

function attendanceSummaryRows(db: Db, filters: Filters, viewer: Viewer): ReportRow[] {
  const today = todayISO();
  const from = pick(filters, "from", "dateFrom") ?? firstOfMonth(today);
  const to = pick(filters, "to", "dateTo") ?? today;
  const group = pick(filters, "ageGroupId", "group");
  const playerId = pick(filters, "playerId", "player");

  const sessions = listSessions({ from, to, ageGroupId: group }, viewer).data.filter(
    (s) => s.status !== "cancelled"
  );

  interface Acc {
    player: string;
    group: string;
    sessions: number;
    present: number;
    late: number;
    absent: number;
    excused: number;
    unmarked: number;
  }
  const byPlayer = new Map<string, Acc>();

  for (const session of sessions) {
    const payload = sessionAttendanceFor(session.id, viewer);
    if (!payload) continue;
    for (const row of payload.roster) {
      if (playerId && row.player.id !== playerId) continue;
      const acc =
        byPlayer.get(row.player.id) ??
        {
          player: row.player.fullName,
          group: session.ageGroup.name,
          sessions: 0,
          present: 0,
          late: 0,
          absent: 0,
          excused: 0,
          unmarked: 0,
        };
      acc.sessions += 1;
      if (row.record) acc[row.record.status] += 1;
      else acc.unmarked += 1;
      byPlayer.set(row.player.id, acc);
    }
  }

  return [...byPlayer.values()]
    .map((acc) => {
      // \"Rate\" = the player actually turned up (present or late) out of the
      // sessions they were rostered for; excused absences stay out of the
      // numerator and are never hidden from the counts beside it.
      const attended = acc.present + acc.late;
      return {
        player: acc.player,
        group: acc.group,
        sessions: acc.sessions,
        present: acc.present,
        late: acc.late,
        absent: acc.absent,
        excused: acc.excused,
        unmarked: acc.unmarked,
        ratePercent: acc.sessions === 0 ? 0 : Math.round((attended / acc.sessions) * 100),
      };
    })
    .sort((a, b) => String(a.player).localeCompare(String(b.player)));
}

function attendanceDetailRows(db: Db, filters: Filters): ReportRow[] {
  const today = todayISO();
  const from = pick(filters, "from", "dateFrom") ?? firstOfMonth(today);
  const to = pick(filters, "to", "dateTo") ?? today;
  const group = pick(filters, "ageGroupId", "group");
  const sessionId = pick(filters, "sessionId", "session");
  const status = pick(filters, "status") as AttendanceStatus | undefined;

  const pairs = db.attendance
    .map((rec) => ({ rec, session: db.sessions.find((s) => s.id === rec.sessionId) }))
    .filter((r) => r.session)
    .filter((r) => r.session!.sessionDate >= from && r.session!.sessionDate <= to)
    .filter((r) => (group ? r.session!.ageGroupId === group : true))
    .filter((r) => (sessionId ? r.session!.id === sessionId : true))
    .filter((r) => (status ? r.rec.status === status : true));

  return pairs
    // Sorted on the pair BEFORE mapping so no helper key leaks into the row.
    .sort((a, b) =>
      `${a.session!.sessionDate}|${a.rec.playerId}`.localeCompare(
        `${b.session!.sessionDate}|${b.rec.playerId}`
      )
    )
    .map(({ rec, session }) => {
      const player = db.players.find((p) => p.id === rec.playerId);
      return {
        sessionDate: session!.sessionDate,
        session: `${session!.ageGroup.name} · ${academyTime(session!.startsAt)}`,
        player: player?.fullName ?? rec.playerId,
        status: ATTENDANCE_LABEL[rec.status],
        note: rec.note ?? null,
        markedBy: actorFor(rec.markedBy).fullName,
      };
    });
}

function invoiceRows(filters: Filters): ReportRow[] {
  const status = pick(filters, "status");
  const group = pick(filters, "ageGroupId", "group");
  const playerId = pick(filters, "playerId", "player");
  const issueFrom = pick(filters, "issueFrom");
  const issueTo = pick(filters, "issueTo");
  const dueFrom = pick(filters, "dueFrom");
  const dueTo = pick(filters, "dueTo");
  const overdue = pick(filters, "overdue") === "true";

  return refreshedInvoices()
    .filter((i) => (status ? i.status === status : true))
    .filter((i) => (overdue ? i.isOverdue : true))
    .filter((i) => (group ? i.ageGroup.id === group : true))
    .filter((i) => (playerId ? i.player.id === playerId : true))
    .filter((i) => (issueFrom ? i.issueDate >= issueFrom : true))
    .filter((i) => (issueTo ? i.issueDate <= issueTo : true))
    .filter((i) => (dueFrom ? i.dueDate >= dueFrom : true))
    .filter((i) => (dueTo ? i.dueDate <= dueTo : true))
    .map((i) => ({
      invoiceNumber: i.invoiceNumber,
      player: i.player.fullName,
      group: i.ageGroup.name,
      period: i.periodStart && i.periodEnd ? `${i.periodStart} … ${i.periodEnd}` : null,
      issueDate: i.issueDate,
      dueDate: i.dueDate,
      totalMinor: i.totalMinor,
      paidMinor: i.paidMinor,
      balanceMinor: i.balanceMinor,
      status: i.status,
      isVoid: i.status === "void",
    }))
    .sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)));
}

function paymentRows(db: Db, filters: Filters): ReportRow[] {
  const from = pick(filters, "from", "receivedFrom", "dateFrom");
  const to = pick(filters, "to", "receivedTo", "dateTo");
  const method = pick(filters, "method", "methodCode");
  const status = pick(filters, "status");
  const guardianId = pick(filters, "guardianId", "guardian");

  return db.payments
    .filter((p) => (status ? p.status === status : true))
    .filter((p) => (method ? p.methodCode === method : true))
    .filter((p) => (guardianId ? p.payerGuardianId === guardianId : true))
    .filter((p) => {
      const date = academyDateOf(p.receivedAt);
      return (from ? date >= from : true) && (to ? date <= to : true);
    })
    .map((p) => {
      const allocated = activeAllocations(p.allocations);
      return {
        receivedAt: p.receivedAt,
        payer: p.payerName ?? "—",
        method: methodLabel(db, p.methodCode),
        reference: p.reference ?? null,
        amountMinor: p.amountMinor,
        allocatedMinor: allocated,
        creditMinor: Math.max(0, p.amountMinor - allocated),
        status: p.status,
        receiptNumber: p.receipts[0]?.receiptNumber ?? null,
      };
    })
    .sort((a, b) => String(b.receivedAt).localeCompare(String(a.receivedAt)));
}

function outstandingRows(db: Db, filters: Filters): ReportRow[] {
  const group = pick(filters, "ageGroupId", "group");
  const minDays = num(filters, "minDaysOverdue", "minDays") ?? 0;

  return refreshedInvoices()
    .filter((i) => i.status !== "void" && i.balanceMinor > 0)
    .filter((i) => (group ? i.ageGroup.id === group : true))
    .filter((i) => i.daysOverdue >= minDays)
    .map((i) => {
      const guardian = i.guardian?.fullName ?? primaryGuardian(db, i.player.id)?.fullName ?? null;
      return {
        player: i.player.fullName,
        guardian,
        invoiceNumber: i.invoiceNumber,
        dueDate: i.dueDate,
        balanceMinor: i.balanceMinor,
        daysOverdue: i.daysOverdue,
      };
    })
    .sort((a, b) => Number(b.daysOverdue) - Number(a.daysOverdue));
}

function collectionRows(db: Db, filters: Filters): ReportRow[] {
  const today = todayISO();
  const from = pick(filters, "from", "dateFrom") ?? firstOfMonth(today);
  const to = pick(filters, "to", "dateTo") ?? today;
  const group = pick(filters, "ageGroupId", "group");
  const groupBy = (pick(filters, "groupBy") ?? "day") as
    | "day"
    | "week"
    | "month"
    | "method"
    | "ageGroup";

  interface Bucket {
    bucket: string;
    collectedMinor: number;
    invoicedMinor: number;
    count: number;
  }
  const buckets = new Map<string, Bucket>();
  const bump = (key: string, patch: Partial<Bucket>) => {
    const current = buckets.get(key) ?? { bucket: key, collectedMinor: 0, invoicedMinor: 0, count: 0 };
    buckets.set(key, {
      bucket: current.bucket,
      collectedMinor: current.collectedMinor + (patch.collectedMinor ?? 0),
      invoicedMinor: current.invoicedMinor + (patch.invoicedMinor ?? 0),
      count: current.count + (patch.count ?? 0),
    });
  };

  const weekStartDay = db.settings.weekStartDay;
  const keyOf = (date: string) => {
    switch (groupBy) {
      case "month":
        return monthOf(date);
      case "week": {
        const start = weekStartOf(date, weekStartDay);
        return `${start} … ${addDaysISO(start, 6)}`;
      }
      case "day":
      default:
        return date;
    }
  };

  // Invoiced — issued invoices in the range (void ones carry no money).
  for (const inv of refreshedInvoices()) {
    if (inv.status === "void") continue;
    if (inv.issueDate < from || inv.issueDate > to) continue;
    if (group && inv.ageGroup.id !== group) continue;
    const key =
      groupBy === "ageGroup"
        ? inv.ageGroup.name
        : groupBy === "method"
          ? "(invoiced — no method)"
          : keyOf(inv.issueDate);
    bump(key, { invoicedMinor: inv.totalMinor, count: 1 });
  }

  // Collected — CONFIRMED payments only (a pending transfer is not money).
  for (const payment of db.payments) {
    if (payment.status !== "confirmed") continue;
    const date = academyDateOf(payment.receivedAt);
    if (date < from || date > to) continue;

    if (groupBy === "ageGroup") {
      // Attribute each allocation to the invoice's group; a remainder is credit,
      // which belongs to no group and is labelled as such rather than hidden.
      let allocated = 0;
      for (const a of payment.allocations) {
        if (a.reversedAt) continue;
        const invoice = db.invoices.find((i) => i.id === a.invoice.id);
        if (!invoice) continue;
        if (group && invoice.ageGroup.id !== group) continue;
        allocated += a.amountMinor;
        bump(invoice.ageGroup.name, { collectedMinor: a.amountMinor, count: 1 });
      }
      const credit = payment.amountMinor - allocated;
      if (credit > 0) bump("(credit — not allocated)", { collectedMinor: credit });
      continue;
    }

    if (group) {
      const belongs = payment.allocations.some((a) => {
        if (a.reversedAt) return false;
        const invoice = db.invoices.find((i) => i.id === a.invoice.id);
        return invoice?.ageGroup.id === group;
      });
      if (!belongs) continue;
    }

    const key = groupBy === "method" ? methodLabel(db, payment.methodCode) : keyOf(date);
    bump(key, { collectedMinor: payment.amountMinor, count: 1 });
  }

  // Bucket rows carry explicit keys rather than an index signature; they are
  // structurally the report rows, so the widening is stated here once.
  return [...buckets.values()].sort((a, b) =>
    a.bucket.localeCompare(b.bucket)
  ) as unknown as ReportRow[];
}

function coachAttendanceRows(filters: Filters): ReportRow[] {
  const today = todayISO();
  const from = pick(filters, "from", "dateFrom") ?? addDaysISO(today, -30);
  const to = pick(filters, "to", "dateTo") ?? today;
  const coachUserId = pick(filters, "coachUserId", "coach");

  return listCoachAttendance({ from, to, coachUserId }, OWNER_VIEWER).data.map((row) => ({
    coach: row.coach.fullName,
    // The academy-local date of the session, not the UTC slice of the instant.
    session: `${row.session.ageGroupName} · ${academyDateOf(row.session.startsAt)}`,
    checkInAt: row.checkInAt,
    // An open check-in has no check-out — left empty, never filled in with “now”.
    checkOutAt: row.checkOutAt ?? null,
    hours: row.checkOutAt
      ? Math.round((minutesBetween(row.checkInAt, row.checkOutAt) / 60) * 100) / 100
      : null,
    corrected: row.corrected ? "Yes" : "No",
  }));
}

// ---------------------------------------------------------------------------
// Totals (only where PAGE_SPECIFICATIONS §10 asks for one)
// ---------------------------------------------------------------------------
function sum(rows: ReportRow[], keys: string[], opts: { skipVoid?: boolean } = {}): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const key of keys) totals[key] = 0;
  for (const row of rows) {
    if (opts.skipVoid && row.isVoid === true) continue;
    for (const key of keys) {
      const value = row[key];
      if (typeof value === "number") totals[key] += value;
    }
  }
  return totals;
}

function totalsFor(name: ReportName, rows: ReportRow[]): Record<string, number> | undefined {
  switch (name) {
    case "players":
      return { count: rows.length };
    case "attendance-summary": {
      const totals = sum(rows, ["sessions", "present", "late", "absent", "excused", "unmarked"]);
      const attended = totals.present + totals.late;
      return { ...totals, ratePercent: totals.sessions === 0 ? 0 : Math.round((attended / totals.sessions) * 100) };
    }
    case "attendance-detail": {
      const counts: Record<string, number> = { present: 0, late: 0, absent: 0, excused: 0 };
      for (const row of rows) {
        const key = Object.entries(ATTENDANCE_LABEL).find(([, label]) => label === row.status)?.[0];
        if (key) counts[key] += 1;
      }
      return counts;
    }
    case "invoices":
      return sum(rows, ["totalMinor", "paidMinor", "balanceMinor"], { skipVoid: true });
    case "payments":
      return sum(rows, ["amountMinor", "allocatedMinor", "creditMinor"]);
    case "outstanding":
      return sum(rows, ["balanceMinor"]);
    case "collections":
      // Two separate sums, never one \"money\" figure.
      return sum(rows, ["collectedMinor", "invoicedMinor", "count"]);
    case "coach-attendance":
      return sum(rows, ["hours"]);
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// RPT-01
// ---------------------------------------------------------------------------
export function runReport(
  name: string,
  filters: Filters,
  viewer: Viewer = OWNER_VIEWER,
  opts: { all?: boolean } = {}
): ReportResult {
  if (!isReportName(name)) {
    throw new MockError("NOT_FOUND", `There is no report called “${name}”.`, 404);
  }
  const db = getDb();

  let rows: ReportRow[];
  switch (name) {
    case "players":
      rows = playerRows(db, filters, viewer);
      break;
    case "attendance-summary":
      rows = attendanceSummaryRows(db, filters, viewer);
      break;
    case "attendance-detail":
      rows = attendanceDetailRows(db, filters);
      break;
    case "invoices":
      rows = invoiceRows(filters);
      break;
    case "payments":
      rows = paymentRows(db, filters);
      break;
    case "outstanding":
      rows = outstandingRows(db, filters);
      break;
    case "collections":
      rows = collectionRows(db, filters);
      break;
    case "coach-attendance":
      rows = coachAttendanceRows(filters);
      break;
    default:
      // Unreachable (`isReportName` guards above) — kept so the switch is total.
      throw new MockError("NOT_FOUND", `There is no report called “${name}”.`, 404);
  }

  const page = opts.all ? 1 : Math.max(1, num(filters, "page") ?? 1);
  const pageSize = opts.all ? Math.max(rows.length, 1) : Math.min(200, Math.max(1, num(filters, "pageSize") ?? 50));
  const data = opts.all ? rows : rows.slice((page - 1) * pageSize, page * pageSize);

  return {
    data,
    meta: {
      page,
      pageSize,
      total: rows.length,
      totalPages: Math.max(1, Math.ceil(rows.length / pageSize)),
    },
    totals: totalsFor(name, rows),
    columns: COLUMNS[name],
    generatedAt: new Date().toISOString(),
    filters: { ...filters },
  };
}

// ---------------------------------------------------------------------------
// RPT-02 — CSV
// ---------------------------------------------------------------------------
function csvCell(value: ReportCell, type: ReportColumn["type"]): string {
  if (value === null || value === undefined) return "";
  let text: string;
  if (type === "money") {
    // Plain number, two decimals, no symbol or separators — a spreadsheet must
    // be able to add the column up.
    text = (Number(value) / 100).toFixed(2);
  } else {
    text = String(value);
  }
  // Formula-injection neutralization (API_CONTRACTS RPT-02).
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export interface CsvExport {
  csv: string;
  filename: string;
  rowCount: number;
}

export function buildCsv(
  name: string,
  filters: Filters,
  viewer: Viewer = OWNER_VIEWER
): CsvExport {
  const result = runReport(name, filters, viewer, { all: true });
  if (result.meta.total > EXPORT_ROW_CAP) {
    throw new MockError(
      "ROW_LIMIT_EXCEEDED",
      `Narrow the filters (max ${EXPORT_ROW_CAP.toLocaleString("en-US")} rows).`,
      413,
      [{ issue: `${result.meta.total} rows match; the cap is ${EXPORT_ROW_CAP}` }]
    );
  }

  const lines: string[] = [];
  lines.push(result.columns.map((c) => csvCell(c.label, "text")).join(","));
  for (const row of result.data) {
    lines.push(
      result.columns.map((column) => csvCell(row[column.key] ?? null, column.type)).join(",")
    );
  }
  // No totals row in the FILE: the totals belong to the on-screen table, and a
  // "Total" line inside a column a spreadsheet will sum is a double-count trap.

  const slug = Object.entries(filters)
    .filter(([, value]) => value !== "" && value !== undefined)
    .map(([key, value]) => `${key}-${value}`)
    .join("-");
  const base = ["report", name, todayISO(), slug].filter(Boolean).join("-");
  const filename = `${base.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120)}.csv`;

  // UTF-8 BOM so Excel reads the Sinhala/Tamil guardians in the same file.
  return { csv: `\uFEFF${lines.join("\r\n")}\r\n`, filename, rowCount: result.data.length };
}
