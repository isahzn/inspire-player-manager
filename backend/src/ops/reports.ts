/**
 * RPT-01/RPT-02 — the report catalogue (API_CONTRACTS §3.8).
 *
 * One module owns the eight reports so the JSON view (RPT-01) and the CSV export (RPT-02) cannot
 * disagree: both are assembled from the same `runReport()`, and the column metadata RPT-01
 * returns is the same list RPT-02 writes as its header row.
 *
 * **The source of these shapes is `frontend/src/mocks/reports.ts`.** That mock is the only
 * concrete definition of the eight reports' column sets and totals that exists, and the owner
 * instructed that this work follow it; `REPORT_COLUMNS` below is copied from it key-for-key,
 * label-for-label and type-for-type. Three things the mock reads are **not** in RPT-01's declared
 * query in `spec/sections/08-dashboard-reports-admin.ts` and are therefore not implemented —
 * they are recorded rather than invented: the mock's filter aliases (`group`, `dateFrom`,
 * `registrationFrom`, `method`, `sessionId`, `overdue`, `issueFrom`/`dueFrom`, `minDaysOverdue`)
 * and its `groupBy` for `collections`. A caller can still filter by `from`/`to`, `ageGroupId`,
 * `playerId`, `guardianId` and `status`; each report says below what `from`/`to` mean for it.
 *
 * Two honesty rules are structural here, because a report is where they are easiest to break:
 *
 *  - **Invoiced ≠ collected.** They are different sums over different sources (issued invoices
 *    vs CONFIRMED payments) and are never combined — not in a column, not in a total, not in a
 *    bucket (CLAUDE.md §3, BILLING_ENGINE §14).
 *  - **An unattended field is `null`, never guessed.** An open coach check-in has no hours; a
 *    manual invoice has no period. The CSV writes those as empty cells.
 *
 * Amounts arrive from `pg` as strings (they are `bigint` columns) and are converted to `number`
 * at the row boundary: a report is a view, and the contract's `ReportCell` is JSON — but the
 * conversion happens once, on an integer, and money is never divided by 100 outside the CSV
 * writer (where a spreadsheet needs a decimal it can sum).
 */
import type { PoolClient } from "pg";
import type { ReportName } from "../../spec/components.js";

export type ReportCell = string | number | boolean | null;
export type ReportRow = Record<string, ReportCell>;
export type ReportColumnType = "text" | "date" | "instant" | "money" | "number" | "percent";

export interface ReportColumnDef {
  key: string;
  label: string;
  type: ReportColumnType;
}

/** RPT-02's cap on one export (API_CONTRACTS §3.8). */
export const EXPORT_ROW_CAP = 50_000;

/** The eight reports, in the contract enum's order (`ReportName` in spec/components.ts). */
export const REPORT_NAMES: readonly ReportName[] = [
  "players",
  "attendance-summary",
  "attendance-detail",
  "invoices",
  "payments",
  "outstanding",
  "collections",
  "coach-attendance",
];

/** Copied from `frontend/src/mocks/reports.ts` — the ratified column sets. */
export const REPORT_COLUMNS: Record<ReportName, ReportColumnDef[]> = {
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
    // Separate columns, separate sums — never one "collected" figure (CLAUDE.md).
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

/** The contract's filters for RPT-01/02, as the handler received them. */
export interface ReportFilters {
  from?: string;
  to?: string;
  ageGroupId?: string;
  playerId?: string;
  guardianId?: string;
  status?: string;
}

export interface ReportRun {
  rows: ReportRow[];
  totals?: Record<string, number>;
  /** Set by `runReport` when `sort` named a field the report does not have. */
  unknownSort?: string | null;
}

/** Read once by every report: the academy's timezone and its own "today". */
const CFG = `cfg as (select timezone, (now() at time zone timezone)::date as today
                       from academy_settings where id = 1)`;

/** A `pg` value we only ever pass through. */
function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function num(value: unknown): number {
  return value === null || value === undefined ? 0 : Number(value);
}

function nullableNum(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

/** The ordering each report ships with, in its own column keys. */
const DEFAULT_SORT: Record<ReportName, { key: string; dir: 1 | -1 }[]> = {
  players: [{ key: "registrationNo", dir: 1 }],
  "attendance-summary": [{ key: "player", dir: 1 }],
  "attendance-detail": [
    { key: "sessionDate", dir: 1 },
    { key: "player", dir: 1 },
  ],
  invoices: [
    { key: "dueDate", dir: 1 },
    { key: "invoiceNumber", dir: 1 },
  ],
  payments: [{ key: "receivedAt", dir: -1 }],
  outstanding: [
    { key: "daysOverdue", dir: -1 },
    { key: "dueDate", dir: 1 },
  ],
  collections: [{ key: "bucket", dir: 1 }],
  "coach-attendance": [{ key: "checkInAt", dir: -1 }],
};

/**
 * `null` sorts last in either direction: an empty cell is the absence of a value, and "no
 * answer" jumping to the top of an ascending column reads as a bug.
 */
function compareCells(left: ReportCell | undefined, right: ReportCell | undefined): number {
  const leftEmpty = left === null || left === undefined;
  const rightEmpty = right === null || right === undefined;
  if (leftEmpty && rightEmpty) return 0;
  if (leftEmpty) return 1;
  if (rightEmpty) return -1;
  if (typeof left === "number" && typeof right === "number") return left - right;
  if (typeof left === "boolean" && typeof right === "boolean") {
    return (left ? 1 : 0) - (right ? 1 : 0);
  }
  return String(left).localeCompare(String(right));
}

/**
 * Orders the rows for `sort` (`-field,field`), refusing a field the report does not have.
 *
 * Sorting happens over the report's own **column keys** rather than over SQL, so the ordering can
 * never reference a table or expression the report did not already read — there is no clause to
 * inject into. An unknown key is reported, not ignored: the caller answers the contract's
 * `422 INVALID_SORT` instead of quietly returning rows in the wrong order.
 */
export function sortRows(
  name: ReportName,
  rows: readonly ReportRow[],
  sort: string | undefined,
): { rows: ReportRow[]; unknown: string | null } {
  const allowed = new Set(REPORT_COLUMNS[name].map((column) => column.key));
  const specs: { key: string; dir: 1 | -1 }[] = [];
  if (sort) {
    for (const token of sort.split(",")) {
      const trimmed = token.trim();
      if (!trimmed) continue;
      const dir: 1 | -1 = trimmed.startsWith("-") ? -1 : 1;
      const key = trimmed.replace(/^-/, "");
      if (!allowed.has(key)) return { rows: [...rows], unknown: key };
      specs.push({ key, dir });
    }
  }
  const order = specs.length > 0 ? specs : DEFAULT_SORT[name];
  const sorted = [...rows].sort((a, b) => {
    for (const spec of order) {
      const leftEmpty = a[spec.key] === null || a[spec.key] === undefined;
      const rightEmpty = b[spec.key] === null || b[spec.key] === undefined;
      // "Absent sorts last" is decided **before** the direction is applied. `compareCells`
      // returns 1 for an empty left cell, which is right ascending and wrong descending —
      // multiplying it by -1 puts every empty cell at the top of the column.
      if (leftEmpty && rightEmpty) continue;
      if (leftEmpty) return 1;
      if (rightEmpty) return -1;
      const cmp = compareCells(a[spec.key], b[spec.key]);
      if (cmp !== 0) return cmp * spec.dir;
    }
    return 0;
  });
  return { rows: sorted, unknown: null };
}

/** Paging bounds → `[offset, limit]`, with the contract's 1..100 page size already validated. */
export function pageWindow(page: number, pageSize: number): { offset: number; limit: number } {
  return { offset: (page - 1) * pageSize, limit: pageSize };
}

// ---------------------------------------------------------------------------
// The reports
// ---------------------------------------------------------------------------

/**
 * Amounts and counts arrive as `bigint`, so every numeric column is `Number(...)`-ed once here.
 * Nothing else in this file touches money arithmetic: `totals` sum the row values the report
 * already produced, exactly as the mock does, so a column and its total cannot disagree.
 */
async function queryRows(client: PoolClient, sql: string, values: unknown[]): Promise<ReportRow[]> {
  const result = await client.query<Record<string, unknown>>(sql, values);
  return result.rows.map((row) => {
    const out: ReportRow = {};
    for (const [key, value] of Object.entries(row)) {
      out[key] = value === undefined ? null : (value as ReportCell);
    }
    return out;
  });
}

type QueryBuilder = {
  values: unknown[];
  /** Appends a bound parameter and returns its `$n` placeholder. */
  p: (value: unknown) => string;
};

function builder(): QueryBuilder {
  const values: unknown[] = [];
  return {
    values,
    p: (value: unknown) => {
      values.push(value);
      return `$${values.length}`;
    },
  };
}

/** `players` — the register, with the player's current group and first guardian. */
async function playersReport(
  client: PoolClient,
  filters: ReportFilters,
): Promise<ReportRow[]> {
  const { values, p } = builder();
  const where: string[] = [];
  if (filters.status) where.push(`p.status = ${p(filters.status)}`);
  if (filters.ageGroupId) where.push(`cur.age_group_id = ${p(filters.ageGroupId)}`);
  if (filters.playerId) where.push(`p.id = ${p(filters.playerId)}`);
  // `from`/`to` are the registration window for this report (the mock's `registrationFrom`).
  where.push(
    `p.registration_date >= coalesce(${p(filters.from ?? null)}::date, '0001-01-01'::date)`,
    `p.registration_date <= coalesce(${p(filters.to ?? null)}::date, '9999-12-31'::date)`,
  );

  return queryRows(
    client,
    `with ${CFG}
     select p.registration_no as "registrationNo", p.full_name as "fullName",
            coalesce(ag.name, '—') as "group", p.status,
            p.registration_date::text as "registrationDate",
            p.date_of_birth::text as "dateOfBirth",
            g.full_name as "guardianName", g.phone_e164 as "guardianPhone"
       from players p
       left join lateral (
         select h.age_group_id from player_group_history h
          where h.player_id = p.id and h.effective_to is null limit 1
       ) cur on true
       left join age_groups ag on ag.id = cur.age_group_id
       left join lateral (
         select gg.full_name, gg.phone_e164
           from player_guardians pg join guardians gg on gg.id = pg.guardian_id
          where pg.player_id = p.id
          order by pg.is_primary desc, pg.guardian_id asc limit 1
       ) g on true
      where ${where.join(" and ")}`,
    values,
  );
}

/**
 * `attendance-summary` — one row per player, over the sessions in the window.
 *
 * `ratePercent` is `present + late` over the sessions the player was **rostered for**: an
 * excused absence stays out of the numerator and stays visible in its own count beside it, which
 * is the point of reporting both rather than one "attendance %".
 */
async function attendanceSummaryReport(
  client: PoolClient,
  filters: ReportFilters,
): Promise<ReportRow[]> {
  const { values, p } = builder();
  const where: string[] = ["s.status <> 'cancelled'"];
  where.push(
    `s.session_date >= coalesce(${p(filters.from ?? null)}::date,
                                 date_trunc('month', cfg.today)::date)`,
    `s.session_date <= coalesce(${p(filters.to ?? null)}::date, cfg.today)`,
  );
  if (filters.ageGroupId) where.push(`s.age_group_id = ${p(filters.ageGroupId)}`);
  if (filters.playerId) where.push(`pl.id = ${p(filters.playerId)}`);

  return queryRows(
    client,
    `with ${CFG}
     select pl.full_name as "player",
            coalesce(cur.name, '—') as "group",
            count(*)::int as "sessions",
            count(*) filter (where pa.status = 'present')::int as "present",
            count(*) filter (where pa.status = 'late')::int as "late",
            count(*) filter (where pa.status = 'absent')::int as "absent",
            count(*) filter (where pa.status = 'excused')::int as "excused",
            count(*) filter (where pa.id is null)::int as "unmarked",
            case when count(*) = 0 then 0
                 else round(100.0 * (count(*) filter (where pa.status in ('present','late')))
                            / count(*))::int
            end as "ratePercent"
       from sessions s
       cross join cfg
       join player_group_history h
         on h.age_group_id = s.age_group_id
        and h.effective_from <= s.session_date
        and (h.effective_to is null or h.effective_to >= s.session_date)
       join players pl on pl.id = h.player_id
       left join lateral (
         select ag2.name from player_group_history h2
           join age_groups ag2 on ag2.id = h2.age_group_id
          where h2.player_id = pl.id and h2.effective_to is null limit 1
       ) cur on true
       left join player_attendance pa on pa.session_id = s.id and pa.player_id = pl.id
      where ${where.join(" and ")}
      group by pl.id, pl.full_name, cur.name`,
    values,
  );
}

const ATTENDANCE_LABEL: Record<string, string> = {
  present: "Present",
  late: "Late",
  absent: "Absent",
  excused: "Excused",
};

/** `attendance-detail` — one row per recorded mark, oldest session first. */
async function attendanceDetailReport(
  client: PoolClient,
  filters: ReportFilters,
): Promise<ReportRow[]> {
  const { values, p } = builder();
  const where: string[] = [];
  where.push(
    `s.session_date >= coalesce(${p(filters.from ?? null)}::date,
                                 date_trunc('month', cfg.today)::date)`,
    `s.session_date <= coalesce(${p(filters.to ?? null)}::date, cfg.today)`,
  );
  if (filters.ageGroupId) where.push(`s.age_group_id = ${p(filters.ageGroupId)}`);
  if (filters.playerId) where.push(`pl.id = ${p(filters.playerId)}`);
  if (filters.status) where.push(`pa.status = ${p(filters.status)}`);

  const rows = await queryRows(
    client,
    `with ${CFG}
     select s.session_date::text as "sessionDate",
            ag.name || ' · ' || to_char(s.starts_at at time zone cfg.timezone, 'HH24:MI')
              as "session",
            pl.full_name as "player", pa.status as "statusRaw", pa.note,
            coalesce(u.full_name, '—') as "markedBy"
       from player_attendance pa
       cross join cfg
       join sessions s on s.id = pa.session_id
       join age_groups ag on ag.id = s.age_group_id
       join players pl on pl.id = pa.player_id
       left join users u on u.id = pa.marked_by
      where ${where.join(" and ")}`,
    values,
  );

  return rows.map((row) => {
    const { statusRaw, ...rest } = row;
    const key = String(statusRaw ?? "");
    return { ...rest, status: ATTENDANCE_LABEL[key] ?? key };
  });
}

/** `invoices` — issued invoices; `from`/`to` are the **issue** window. */
async function invoicesReport(client: PoolClient, filters: ReportFilters): Promise<ReportRow[]> {
  const { values, p } = builder();
  const where: string[] = [];
  if (filters.status) where.push(`i.status = ${p(filters.status)}`);
  if (filters.playerId) where.push(`i.player_id = ${p(filters.playerId)}`);
  if (filters.guardianId) where.push(`i.guardian_id = ${p(filters.guardianId)}`);
  if (filters.ageGroupId) where.push(`i.snapshot ->> 'ageGroupId' = ${p(filters.ageGroupId)}`);
  where.push(
    `i.issue_date >= coalesce(${p(filters.from ?? null)}::date, '0001-01-01'::date)`,
    `i.issue_date <= coalesce(${p(filters.to ?? null)}::date, '9999-12-31'::date)`,
  );

  return queryRows(
    client,
    `with ${CFG}
     select i.invoice_number as "invoiceNumber", pl.full_name as "player",
            coalesce(i.snapshot ->> 'ageGroupName', '—') as "group",
            case when i.period_start is not null and i.period_end is not null
                 then i.period_start::text || ' … ' || i.period_end::text
                 else null end as "period",
            i.issue_date::text as "issueDate", i.due_date::text as "dueDate",
            i.total_minor::text as "totalMinor", i.paid_minor::text as "paidMinor",
            i.balance_minor::text as "balanceMinor", i.status
       from invoices i
       cross join cfg
       join players pl on pl.id = i.player_id
      where ${where.join(" and ")}`,
    values,
  ).then((rows) =>
    rows.map((row) => ({
      ...row,
      totalMinor: num(row["totalMinor"]),
      paidMinor: num(row["paidMinor"]),
      balanceMinor: num(row["balanceMinor"]),
    })),
  );
}

/** `payments` — confirmed and pending alike, with the status saying which (the mock's rule). */
async function paymentsReport(client: PoolClient, filters: ReportFilters): Promise<ReportRow[]> {
  const { values, p } = builder();
  const where: string[] = [];
  if (filters.status) where.push(`pay.status = ${p(filters.status)}`);
  if (filters.guardianId) where.push(`pay.payer_guardian_id = ${p(filters.guardianId)}`);
  where.push(
    `(pay.received_at at time zone cfg.timezone)::date >=
       coalesce(${p(filters.from ?? null)}::date, '0001-01-01'::date)`,
    `(pay.received_at at time zone cfg.timezone)::date <=
       coalesce(${p(filters.to ?? null)}::date, '9999-12-31'::date)`,
  );

  return queryRows(
    client,
    `with ${CFG}
     select pay.received_at as "receivedAt",
            coalesce(pay.payer_name, g.full_name, '—') as "payer",
            pm.label as "method", pay.reference,
            pay.amount_minor::text as "amountMinor",
            pay.allocated_minor::text as "allocatedMinor",
            (pay.amount_minor - pay.allocated_minor)::text as "creditMinor",
            pay.status, r.receipt_number as "receiptNumber"
       from payments pay
       cross join cfg
       join payment_methods pm on pm.code = pay.method_code
       left join guardians g on g.id = pay.payer_guardian_id
       left join receipts r on r.payment_id = pay.id
      where ${where.join(" and ")}`,
    values,
  ).then((rows) =>
    rows.map((row) => ({
      ...row,
      receivedAt: iso(row["receivedAt"]),
      amountMinor: num(row["amountMinor"]),
      allocatedMinor: num(row["allocatedMinor"]),
      creditMinor: num(row["creditMinor"]),
    })),
  );
}

/**
 * `outstanding` — what is still owed, as of now. Void and paid invoices are excluded by
 * definition (amounts and balances exclude credit, which lives on the payment, not the invoice).
 * `from`/`to` are the **due date** window, so "what falls due next week" is askable.
 */
async function outstandingReport(client: PoolClient, filters: ReportFilters): Promise<ReportRow[]> {
  const { values, p } = builder();
  const where: string[] = ["i.status in ('issued','partially_paid')", "i.balance_minor > 0"];
  if (filters.playerId) where.push(`i.player_id = ${p(filters.playerId)}`);
  if (filters.guardianId) where.push(`i.guardian_id = ${p(filters.guardianId)}`);
  if (filters.ageGroupId) where.push(`i.snapshot ->> 'ageGroupId' = ${p(filters.ageGroupId)}`);
  where.push(
    `i.due_date >= coalesce(${p(filters.from ?? null)}::date, '0001-01-01'::date)`,
    `i.due_date <= coalesce(${p(filters.to ?? null)}::date, '9999-12-31'::date)`,
  );

  return queryRows(
    client,
    `with ${CFG}
     select pl.full_name as "player",
            coalesce(g.full_name, pgv.full_name) as "guardian",
            i.invoice_number as "invoiceNumber", i.due_date::text as "dueDate",
            i.balance_minor::text as "balanceMinor",
            greatest(0, cfg.today - i.due_date)::int as "daysOverdue"
       from invoices i
       cross join cfg
       join players pl on pl.id = i.player_id
       left join guardians g on g.id = i.guardian_id
       left join app.player_primary_guardian pgv on pgv.player_id = i.player_id
      where ${where.join(" and ")}`,
    values,
  ).then((rows) => rows.map((row) => ({ ...row, balanceMinor: num(row["balanceMinor"]) })));
}

/**
 * `collections` — the same money from both ends, bucketed by day.
 *
 * The two sums come from **different sources on purpose**: `invoicedMinor` from issued invoices,
 * `collectedMinor` from confirmed payments. They are never added. The mock's `groupBy` is not in
 * the contract, so every bucket is a day; `count` is the number of documents in the bucket
 * (invoices + payments), which is what the mock's count is.
 */
async function collectionsReport(
  client: PoolClient,
  filters: ReportFilters,
): Promise<ReportRow[]> {
  const { values, p } = builder();
  const params: Record<string, string> = {};
  const from = (filters.from ?? null) as string | null;
  const to = (filters.to ?? null) as string | null;
  params["from"] = p(from);
  params["to"] = p(to);
  const group = filters.ageGroupId ? p(filters.ageGroupId) : null;

  const groupClauseInvoice = group
    ? `and i.snapshot ->> 'ageGroupId' = ${group}`
    : "";
  const groupClausePayment = group
    ? `and exists (
         select 1 from payment_allocations a
           join invoices ai on ai.id = a.invoice_id
          where a.payment_id = pay.id and a.reversed_at is null
            and ai.snapshot ->> 'ageGroupId' = ${group})`
    : "";

  return queryRows(
    client,
    `with ${CFG}, payments_in_range as (
       select pay.id, (pay.received_at at time zone cfg.timezone)::date as day, pay.amount_minor
         from payments pay cross join cfg
        where pay.status = 'confirmed'
          and (pay.received_at at time zone cfg.timezone)::date
              >= coalesce(${params["from"]}::date, date_trunc('month', cfg.today)::date)
          and (pay.received_at at time zone cfg.timezone)::date
              <= coalesce(${params["to"]}::date, cfg.today)
          ${groupClausePayment}
     ), bucket_rows as (
       select i.issue_date as day, 0::bigint as collected, i.total_minor as invoiced
         from invoices i cross join cfg
        where i.status <> 'void'
          and i.issue_date >= coalesce(${params["from"]}::date, date_trunc('month', cfg.today)::date)
          and i.issue_date <= coalesce(${params["to"]}::date, cfg.today)
          ${groupClauseInvoice}
       union all
       select day, amount_minor, 0::bigint from payments_in_range
     )
     select day::text as "bucket",
            sum(collected)::text as "collectedMinor",
            sum(invoiced)::text as "invoicedMinor",
            count(*)::int as "count"
       from bucket_rows group by day`,
    values,
  ).then((rows) =>
    rows.map((row) => ({
      ...row,
      collectedMinor: num(row["collectedMinor"]),
      invoicedMinor: num(row["invoicedMinor"]),
    })),
  );
}

/** `coach-attendance` — hours count **closed** check-ins only (T-ATT-11). */
async function coachAttendanceReport(
  client: PoolClient,
  filters: ReportFilters,
): Promise<ReportRow[]> {
  const { values, p } = builder();
  const where: string[] = [];
  // The report has no player or guardian column to filter on; an age group does scope it.
  if (filters.ageGroupId) where.push(`s.age_group_id = ${p(filters.ageGroupId)}`);
  where.push(
    `(ca.check_in_at at time zone cfg.timezone)::date >=
       coalesce(${p(filters.from ?? null)}::date, cfg.today - 30)`,
    `(ca.check_in_at at time zone cfg.timezone)::date <=
       coalesce(${p(filters.to ?? null)}::date, cfg.today)`,
  );

  return queryRows(
    client,
    `with ${CFG}
     select u.full_name as "coach",
            ag.name || ' · ' || s.session_date::text as "session",
            ca.check_in_at as "checkInAt", ca.check_out_at as "checkOutAt",
            case when ca.check_out_at is null then null
                 else round(extract(epoch from (ca.check_out_at - ca.check_in_at)) / 3600.0, 2)
            end::text as "hours",
            case when ca.corrected then 'Yes' else 'No' end as "corrected"
       from coach_attendance ca
       cross join cfg
       join users u on u.id = ca.coach_user_id
       join sessions s on s.id = ca.session_id
       join age_groups ag on ag.id = s.age_group_id
      where ${where.join(" and ")}`,
    values,
  ).then((rows) =>
    rows.map((row) => ({
      ...row,
      checkInAt: iso(row["checkInAt"]),
      checkOutAt: iso(row["checkOutAt"]),
      hours: nullableNum(row["hours"]),
    })),
  );
}

/** The rows and totals of one report, before ordering and before paging. */
async function computeReport(
  client: PoolClient,
  args: { name: ReportName; filters: ReportFilters },
): Promise<ReportRun> {
  const { name, filters } = args;

  switch (name) {
    case "players": {
      const rows = await playersReport(client, filters);
      return { rows, totals: { count: rows.length } };
    }
    case "attendance-summary": {
      const rows = await attendanceSummaryReport(client, filters);
      const totals = sumColumns(rows, [
        "sessions",
        "present",
        "late",
        "absent",
        "excused",
        "unmarked",
      ]);
      const attended = totals["present"]! + totals["late"]!;
      totals["ratePercent"] =
        totals["sessions"] === 0 ? 0 : Math.round((attended / totals["sessions"]!) * 100);
      return { rows, totals };
    }
    case "attendance-detail": {
      const rows = await attendanceDetailReport(client, filters);
      const counts: Record<string, number> = { present: 0, late: 0, absent: 0, excused: 0 };
      for (const row of rows) {
        for (const [key, label] of Object.entries(ATTENDANCE_LABEL)) {
          if (row["status"] === label) counts[key] = (counts[key] ?? 0) + 1;
        }
      }
      return { rows, totals: counts };
    }
    case "invoices": {
      const rows = await invoicesReport(client, filters);
      // Void invoices carry no money, so they are out of the totals (the mock's skipVoid).
      const billed = rows.filter((row) => row["status"] !== "void");
      return { rows, totals: sumColumns(billed, ["totalMinor", "paidMinor", "balanceMinor"]) };
    }
    case "payments": {
      const rows = await paymentsReport(client, filters);
      return { rows, totals: sumColumns(rows, ["amountMinor", "allocatedMinor", "creditMinor"]) };
    }
    case "outstanding": {
      const rows = await outstandingReport(client, filters);
      return { rows, totals: sumColumns(rows, ["balanceMinor"]) };
    }
    case "collections": {
      const rows = await collectionsReport(client, filters);
      // Two separate sums, never one "money" figure.
      return { rows, totals: sumColumns(rows, ["collectedMinor", "invoicedMinor", "count"]) };
    }
    case "coach-attendance": {
      const rows = await coachAttendanceReport(client, filters);
      const hours = rows.reduce(
        (total, row) => total + (typeof row["hours"] === "number" ? row["hours"] : 0),
        0,
      );
      return { rows, totals: { hours: Math.round(hours * 100) / 100 } };
    }
    default: {
      // Unreachable: `name` is the contract's enum, validated before the handler runs.
      return { rows: [] };
    }
  }
}

/**
 * Runs one report: rows (ordered), totals, and whether the caller asked for a field that does not
 * exist.
 *
 * Paging is the caller's (RPT-01 pages the result, RPT-02 takes it whole), because `totals` must
 * cover the **whole** result: a total over one page would be a number nobody can use.
 *
 * `unknownSort` is the contract's `INVALID_SORT` case: the caller answers 422 for it, and the
 * rows come back in their default order so nothing has to be re-queried to find out.
 */
export async function runReport(
  client: PoolClient,
  args: { name: ReportName; filters: ReportFilters; sort?: string },
): Promise<ReportRun> {
  const computed = await computeReport(client, args);
  const { rows, unknown } = sortRows(args.name, computed.rows, args.sort);
  return {
    rows,
    ...(computed.totals ? { totals: computed.totals } : {}),
    unknownSort: unknown,
  };
}

function sumColumns(rows: ReportRow[], keys: string[]): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const key of keys) totals[key] = 0;
  for (const row of rows) {
    for (const key of keys) {
      const value = row[key];
      if (typeof value === "number") totals[key] = (totals[key] ?? 0) + value;
    }
  }
  return totals;
}

// ---------------------------------------------------------------------------
// RPT-02 — the CSV
// ---------------------------------------------------------------------------

/**
 * One CSV cell.
 *
 * Money becomes a plain decimal number with two places and **no** symbol or separators: the file
 * is a spreadsheet input, and a spreadsheet must be able to add the column up.
 *
 * Formula-injection neutralisation is the contract's rule, applied here in full: a cell that
 * begins with `=`, `+`, `-`, `@`, a tab or a CR is prefixed with `'` so Excel and Sheets treat it
 * as text rather than a formula. (The mock checks four of those six characters; the contract
 * names six, and the narrower rule is the one that lets `\t=cmd` through.)
 *
 * Quoting is the usual RFC-4180 doubling inside double quotes, applied when the value contains a
 * quote, comma, CR or LF.
 */
export function csvCell(value: ReportCell | undefined, type: ReportColumnType): string {
  if (value === null || value === undefined) return "";
  let text: string;
  if (type === "money" && typeof value === "number") {
    text = (value / 100).toFixed(2);
  } else if (typeof value === "boolean") {
    text = value ? "true" : "false";
  } else {
    text = String(value);
  }
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** `report-players-2026-10-14-ageGroupId-…csv`, sanitised and capped like the mock's. */
export function csvFilename(
  name: ReportName,
  filters: ReportFilters,
  today: string,
): string {
  const slug = Object.entries(filters)
    .filter(([, value]) => value !== undefined && value !== "")
    .map(([key, value]) => `${key}-${value}`)
    .join("-");
  const base = ["report", name, today, slug].filter(Boolean).join("-");
  return `${base.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120)}.csv`;
}

/**
 * The whole CSV document.
 *
 * A UTF-8 BOM leads the file so Excel reads Sinhala and Tamil names instead of mojibake; lines
 * end in CRLF for the same reason. **There is no totals row**: the totals belong to the on-screen
 * table, and a "Total" line inside a column a spreadsheet will sum is a double-count waiting to
 * happen.
 */
export function buildCsv(
  name: ReportName,
  columns: readonly ReportColumnDef[],
  rows: readonly ReportRow[],
): string {
  const lines: string[] = [];
  lines.push(columns.map((column) => csvCell(column.label, "text")).join(","));
  for (const row of rows) {
    lines.push(columns.map((column) => csvCell(row[column.key] ?? null, column.type)).join(","));
  }
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}
