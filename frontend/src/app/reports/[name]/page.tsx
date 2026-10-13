"use client";

// One report screen for all eight reports (PAGE_SPECIFICATIONS §10,
// API_CONTRACTS §3.8 RPT-01/02).
//
// Rules this file exists to hold:
// · The page renders the report the API returns — columns come from
//   `ReportResult.columns`, so nothing here hardcodes a column list, and a
//   column the API does not send is never shown.
// · `collections` keeps **Invoiced** and **Collected** as separate columns with
//   separate totals; there is no combined money column anywhere.
// · `outstanding` is always "as of now" and says so.
// · Money cells are integer minor units, formatted through `lib/money.ts` —
//   the app never floats money (BILLING_ENGINE §1).
// · Filters live in the URL and are echoed in the exported CSV's filename.
//
// Filter/query param names (the contract fixes the report names, not the filter
// keys): from · to · status · ageGroupId · q · playerId · sessionId · method ·
// guardianId · overdue · groupBy · coachUserId · minDaysOverdue · page · pageSize.
import { Suspense, useCallback, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { notFound, useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import {
  ApiError,
  cch01ListCoaches,
  gdn01ListGuardians,
  grp01ListAgeGroups,
  ply01ListPlayers,
  rpt01GetReport,
  rpt02ExportReportCsv,
  ses01ListSessions,
  set04ListPaymentMethods,
} from "@/api/client";
import type { ReportCell, ReportColumn, ReportName, ReportResult } from "@/api/types";
import { AuthLoading, RequireAuth, RequirePermissions } from "@/components/Guards";
import { PageHeader } from "@/components/PageHeader";
import {
  BackLink,
  Button,
  Card,
  DateText,
  EmptyState,
  ErrorState,
  InlineAlert,
  ListSkeleton,
  MoneyText,
  SectionTitle,
  TextField,
  Toggle,
} from "@/components/ui";
import { addDaysISO, firstOfNextMonthISO, formatDateStr, formatInstant, todayISO } from "@/lib/dates";
import { saveBlob } from "@/lib/download";
import { formatMoneyMinor } from "@/lib/money";

const PAGE_SIZE = 25;

/** The 50,000-row cap the CSV stream enforces (API_CONTRACTS RPT-02). */
const CSV_ROW_CAP = 50_000;

type FilterKey =
  | "from"
  | "to"
  | "status"
  | "ageGroupId"
  | "q"
  | "playerId"
  | "sessionId"
  | "method"
  | "guardianId"
  | "overdue"
  | "groupBy"
  | "coachUserId"
  | "minDaysOverdue";

interface ReportSpec {
  title: string;
  /** Shown next to the title when the report needs a plain-language caveat. */
  note?: string;
  filters: FilterKey[];
  /** Labels for the two date fields, so "Due from" is never mislabelled. */
  fromLabel?: string;
  toLabel?: string;
  statusOptions?: { value: string; label: string }[];
}

const RECORD_STATUSES = [
  { value: "present", label: "Present" },
  { value: "late", label: "Late" },
  { value: "absent", label: "Absent" },
  { value: "excused", label: "Excused" },
];

const REPORT_SPECS: Record<ReportName, ReportSpec> = {
  players: {
    title: "Players",
    filters: ["status", "ageGroupId", "from", "to", "q"],
    fromLabel: "Registered from",
    toLabel: "Registered to",
    statusOptions: [
      { value: "active", label: "Active" },
      { value: "inactive", label: "Inactive" },
      { value: "withdrawn", label: "Withdrawn" },
    ],
  },
  "attendance-summary": {
    title: "Attendance summary",
    filters: ["from", "to", "ageGroupId", "playerId"],
    fromLabel: "From",
    toLabel: "To",
  },
  "attendance-detail": {
    title: "Attendance detail",
    filters: ["from", "to", "ageGroupId", "sessionId", "status"],
    fromLabel: "From",
    toLabel: "To",
    statusOptions: RECORD_STATUSES,
  },
  invoices: {
    title: "Invoices",
    filters: ["from", "to", "status", "ageGroupId", "overdue", "playerId", "q"],
    fromLabel: "Issued from",
    toLabel: "Issued to",
    statusOptions: [
      { value: "issued", label: "Issued" },
      { value: "partially_paid", label: "Partially paid" },
      { value: "paid", label: "Paid" },
      { value: "void", label: "Void" },
    ],
  },
  payments: {
    title: "Payments",
    filters: ["from", "to", "method", "status", "guardianId"],
    fromLabel: "Received from",
    toLabel: "Received to",
    statusOptions: [
      { value: "pending", label: "Pending" },
      { value: "confirmed", label: "Confirmed" },
      { value: "rejected", label: "Rejected" },
      { value: "reversed", label: "Reversed" },
    ],
  },
  outstanding: {
    title: "Outstanding balances",
    note: "Everything here is as of now, not for a chosen period — a balance is what the ledger says at this moment.",
    filters: ["ageGroupId", "minDaysOverdue"],
  },
  collections: {
    title: "Collections",
    note: "Invoiced and Collected are separate columns with separate totals. They are never added together — invoicing money is not collecting it.",
    filters: ["from", "to", "ageGroupId", "groupBy"],
    fromLabel: "From",
    toLabel: "To",
  },
  "coach-attendance": {
    title: "Coach time",
    note: "Hours come from closed check-ins only; an open check-in has no duration yet and is excluded from the totals.",
    filters: ["from", "to", "coachUserId"],
    fromLabel: "From",
    toLabel: "To",
  },
};

const GROUP_BY_OPTIONS = ["day", "week", "month", "method", "ageGroup"] as const;

const REPORT_NAMES = Object.keys(REPORT_SPECS) as ReportName[];

function isReportName(value: string): value is ReportName {
  return (REPORT_NAMES as string[]).includes(value);
}

/** One cell. `null`/empty is an em dash — never a fabricated 0. */
function CellValue({ value, column }: { value: ReportCell; column: ReportColumn }) {
  if (value === null || value === undefined || value === "") {
    return <span className="text-slate-400">—</span>;
  }
  switch (column.type) {
    case "money":
      // Integer minor units — the only money representation in this app.
      return typeof value === "number" && Number.isInteger(value) ? (
        <MoneyText minor={value} />
      ) : (
        <span className="text-red-700">Not a money value</span>
      );
    case "date":
      return <span className="whitespace-nowrap">{formatDateStr(String(value))}</span>;
    case "instant":
      return <DateText value={String(value)} withTime />;
    case "percent":
      return <span className="tabular">{typeof value === "number" ? `${value}%` : String(value)}</span>;
    case "number":
      return <span className="tabular">{typeof value === "number" ? value.toLocaleString("en-GB") : String(value)}</span>;
    case "text":
    default:
      if (typeof value === "boolean") return <span>{value ? "Yes" : "No"}</span>;
      return <span>{String(value)}</span>;
  }
}

/** Plain-text version for the CSV row preview and the mobile cards. */
function cellText(value: ReportCell, column: ReportColumn): string {
  if (value === null || value === undefined || value === "") return "—";
  switch (column.type) {
    case "money":
      // One money formatter for the whole app — never a second implementation.
      return typeof value === "number" && Number.isInteger(value)
        ? formatMoneyMinor(value)
        : String(value);
    case "date":
      return formatDateStr(String(value));
    case "instant":
      return formatInstant(String(value));
    case "percent":
      return `${value}%`;
    default:
      return typeof value === "boolean" ? (value ? "Yes" : "No") : String(value);
  }
}

// --- date presets -----------------------------------------------------------

function presetRange(kind: "this-month" | "last-month" | "last-30"): { from: string; to: string } {
  const today = todayISO();
  if (kind === "this-month") {
    return { from: `${today.slice(0, 7)}-01`, to: addDaysISO(firstOfNextMonthISO(today), -1) };
  }
  if (kind === "last-month") {
    const to = addDaysISO(`${today.slice(0, 7)}-01`, -1);
    return { from: `${to.slice(0, 7)}-01`, to };
  }
  return { from: addDaysISO(today, -29), to: today };
}

// --- the screen -------------------------------------------------------------

function ReportBody({ name }: { name: ReportName }) {
  const spec = REPORT_SPECS[name];
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const page = Math.max(1, Number(searchParams.get("page") ?? "1") || 1);

  // URL-first state: merge into the query we asked for while a write is in
  // flight, so two quick filter changes lose neither (see players/page.tsx).
  const lastWrite = useRef<{ query: string; at: number } | null>(null);
  const renderedQuery = searchParams.toString();

  const setParams = useCallback(
    (patch: Record<string, string | null>, opts: { keepPage?: boolean } = {}) => {
      const inFlight = lastWrite.current;
      const pending =
        Boolean(inFlight) && Date.now() - (inFlight?.at ?? 0) < 1500 && inFlight?.query !== renderedQuery;
      const next = new URLSearchParams(pending ? (inFlight?.query ?? "") : renderedQuery);
      for (const [key, value] of Object.entries(patch)) {
        if (value === null || value === "") next.delete(key);
        else next.set(key, value);
      }
      if (!opts.keepPage && !("page" in patch)) next.delete("page");
      const query = next.toString();
      lastWrite.current = { query, at: Date.now() };
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [pathname, renderedQuery, router]
  );

  const value = useCallback((key: FilterKey) => searchParams.get(key) ?? "", [searchParams]);

  /** Only the filters this report accepts, and only when they carry a value. */
  const filters = useMemo(() => {
    const out: Record<string, string> = {};
    for (const key of spec.filters) {
      const raw = searchParams.get(key);
      if (raw !== null && raw !== "") out[key] = raw;
    }
    return out;
  }, [searchParams, spec.filters]);

  const needs = useCallback((key: FilterKey) => spec.filters.includes(key), [spec.filters]);

  const groupsQuery = useQuery({
    queryKey: ["age-groups", { includeArchived: true }],
    queryFn: () => grp01ListAgeGroups({ includeArchived: true }),
    enabled: needs("ageGroupId"),
    staleTime: 5 * 60_000,
  });

  const playersQuery = useQuery({
    queryKey: ["players", "report-filter"],
    queryFn: () => ply01ListPlayers({ pageSize: 100, sort: "fullName" }),
    enabled: needs("playerId"),
    staleTime: 5 * 60_000,
  });

  const guardiansQuery = useQuery({
    queryKey: ["guardians", "report-filter", value("guardianId")],
    queryFn: () => gdn01ListGuardians({ page: 1 }),
    enabled: needs("guardianId"),
    staleTime: 5 * 60_000,
  });

  const methodsQuery = useQuery({
    queryKey: ["payment-methods"],
    queryFn: () => set04ListPaymentMethods(),
    enabled: needs("method"),
    staleTime: 5 * 60_000,
  });

  const coachesQuery = useQuery({
    queryKey: ["coaches", "report-filter"],
    queryFn: () => cch01ListCoaches({}),
    enabled: needs("coachUserId"),
    staleTime: 5 * 60_000,
  });

  const sessionsQuery = useQuery({
    queryKey: ["sessions", "report-filter", value("from"), value("to"), value("ageGroupId")],
    queryFn: () =>
      ses01ListSessions({
        from: value("from") || undefined,
        to: value("to") || undefined,
        ageGroupId: value("ageGroupId") || undefined,
      }),
    enabled: needs("sessionId"),
    staleTime: 60_000,
  });

  const reportQuery = useQuery({
    queryKey: ["report", name, filters, page],
    queryFn: () => rpt01GetReport(name, { ...filters, page, pageSize: PAGE_SIZE }),
    placeholderData: (previous) => previous,
  });

  const [exporting, setExporting] = useState(false);
  const [exportNotice, setExportNotice] = useState<
    { tone: "info" | "warning" | "danger"; text: string } | null
  >(null);

  const result: ReportResult | undefined = reportQuery.data;
  const rows = result?.data ?? [];
  const columns = result?.columns ?? [];
  const meta = result?.meta;
  const totals = result?.totals;
  const filtersActive = Object.keys(filters).length > 0;

  const activePreset = useMemo(() => {
    const from = value("from");
    const to = value("to");
    if (!from || !to) return null;
    for (const kind of ["this-month", "last-month", "last-30"] as const) {
      const range = presetRange(kind);
      if (range.from === from && range.to === to) return kind;
    }
    return null;
  }, [value]);

  async function onExport() {
    setExporting(true);
    setExportNotice(null);
    try {
      const blob = await rpt02ExportReportCsv(name, filters);
      // The filters are echoed in the filename (PAGE_SPEC §10).
      const suffix = Object.entries(filters)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, val]) => `${key}-${val.replace(/[^\w.-]+/g, "_")}`)
        .join("_");
      saveBlob(blob, `${name}${suffix ? `_${suffix}` : ""}.csv`);
    } catch (error) {
      if (error instanceof ApiError && error.status === 429) {
        setExportNotice({ tone: "warning", text: "Too many exports — try again in a moment." });
      } else if (
        error instanceof ApiError &&
        (error.status === 413 || error.code === "EXPORT_ROW_LIMIT_EXCEEDED")
      ) {
        setExportNotice({
          tone: "warning",
          text: `Narrow the filters (max ${CSV_ROW_CAP.toLocaleString("en-GB")} rows).`,
        });
      } else if (error instanceof ApiError && error.status === 403) {
        setExportNotice({ tone: "danger", text: "You do not have permission to export this report." });
      } else {
        const api = error instanceof ApiError ? error : null;
        setExportNotice({
          tone: "danger",
          text: `${api?.message ?? "The export could not be prepared. Please retry."}${
            api?.requestId ? ` (reference ${api.requestId})` : ""
          }`,
        });
      }
    } finally {
      setExporting(false);
    }
  }

  const firstColumn = columns[0];
  const restColumns = columns.slice(1);
  const dateFilters = needs("from") || needs("to");

  return (
    <>
      <BackLink href="/reports">All reports</BackLink>
      <div className="mt-2">
        <PageHeader
          title={spec.title}
          sub={spec.note}
          actions={
            <Button variant="secondary" onClick={onExport} pending={exporting} type="button">
              <Download className="h-4 w-4" aria-hidden="true" />
              {exporting ? "Preparing…" : "Export CSV"}
            </Button>
          }
        />
      </div>

      <Card className="mb-4">
        <SectionTitle
          right={
            filtersActive ? (
              <button
                type="button"
                className="cursor-pointer text-[13px] font-semibold text-pitch-700 underline underline-offset-2"
                onClick={() => {
                  const cleared: Record<string, string | null> = {};
                  for (const key of spec.filters) cleared[key] = null;
                  setParams(cleared);
                }}
              >
                Clear filters
              </button>
            ) : null
          }
        >
          Filters
        </SectionTitle>

        {dateFilters ? (
          <div className="flex flex-wrap gap-2 border-b border-slate-200 px-4 py-3">
            {(
              [
                { key: "this-month", label: "This month" },
                { key: "last-month", label: "Last month" },
                { key: "last-30", label: "Last 30 days" },
              ] as const
            ).map((preset) => {
              const selected = activePreset === preset.key;
              const range = presetRange(preset.key);
              return (
                <button
                  key={preset.key}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => setParams({ from: range.from, to: range.to })}
                  className={`touch44 inline-flex min-h-[44px] cursor-pointer items-center rounded-full border px-3 text-[13px] font-semibold ${
                    selected
                      ? "border-pitch-600 bg-pitch-50 text-pitch-700"
                      : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                  }`}
                >
                  {preset.label}
                </button>
              );
            })}
            {activePreset === null && (value("from") || value("to")) ? (
              <span className="inline-flex min-h-[44px] items-center text-[13px] font-semibold text-slate-600">
                Custom range
              </span>
            ) : null}
          </div>
        ) : null}

        <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3">
          {needs("from") ? (
            <TextField
              id="report-from"
              label={spec.fromLabel ?? "From"}
              type="date"
              value={value("from")}
              onChange={(event) => setParams({ from: event.target.value || null })}
            />
          ) : null}
          {needs("to") ? (
            <TextField
              id="report-to"
              label={spec.toLabel ?? "To"}
              type="date"
              value={value("to")}
              onChange={(event) => setParams({ to: event.target.value || null })}
            />
          ) : null}

          {needs("q") ? (
            <TextField
              id="report-q"
              label="Search"
              placeholder="Name, registration no. or phone"
              value={value("q")}
              onChange={(event) => setParams({ q: event.target.value || null })}
              hint="The server applies this from two characters."
            />
          ) : null}

          {needs("status") && spec.statusOptions ? (
            <div>
              <label htmlFor="report-status" className="mb-1 block text-[14px] font-semibold text-slate-800">
                Status
              </label>
              <select
                id="report-status"
                value={value("status")}
                onChange={(event) => setParams({ status: event.target.value || null })}
                className="h-12 w-full rounded-xl border border-slate-300 bg-white px-3 text-[16px]"
              >
                <option value="">All statuses</option>
                {spec.statusOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          {needs("ageGroupId") ? (
            <div>
              <label htmlFor="report-group" className="mb-1 block text-[14px] font-semibold text-slate-800">
                Age group
              </label>
              <select
                id="report-group"
                value={value("ageGroupId")}
                onChange={(event) => setParams({ ageGroupId: event.target.value || null, sessionId: null })}
                className="h-12 w-full rounded-xl border border-slate-300 bg-white px-3 text-[16px]"
                disabled={groupsQuery.isLoading}
              >
                <option value="">All groups</option>
                {(groupsQuery.data?.data ?? []).map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.name}
                    {group.archivedAt ? " (archived)" : ""}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          {needs("playerId") ? (
            <div>
              <label htmlFor="report-player" className="mb-1 block text-[14px] font-semibold text-slate-800">
                Player
              </label>
              <select
                id="report-player"
                value={value("playerId")}
                onChange={(event) => setParams({ playerId: event.target.value || null })}
                className="h-12 w-full rounded-xl border border-slate-300 bg-white px-3 text-[16px]"
                disabled={playersQuery.isLoading}
              >
                <option value="">All players</option>
                {(playersQuery.data?.data ?? []).map((player) => (
                  <option key={player.id} value={player.id}>
                    {player.fullName} · {player.registrationNo}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          {needs("sessionId") ? (
            <div>
              <label htmlFor="report-session" className="mb-1 block text-[14px] font-semibold text-slate-800">
                Session
              </label>
              <select
                id="report-session"
                value={value("sessionId")}
                onChange={(event) => setParams({ sessionId: event.target.value || null })}
                className="h-12 w-full rounded-xl border border-slate-300 bg-white px-3 text-[16px]"
                disabled={sessionsQuery.isLoading}
              >
                <option value="">All sessions in range</option>
                {(sessionsQuery.data?.data ?? []).map((session) => (
                  <option key={session.id} value={session.id}>
                    {formatDateStr(session.sessionDate)} · {session.ageGroup.name}
                  </option>
                ))}
              </select>
              {!value("from") && !value("to") ? (
                <p className="mt-1 text-[13px] text-slate-600">
                  Set a date range to narrow the session list.
                </p>
              ) : null}
            </div>
          ) : null}

          {needs("guardianId") ? (
            <div>
              <label htmlFor="report-guardian" className="mb-1 block text-[14px] font-semibold text-slate-800">
                Guardian
              </label>
              <select
                id="report-guardian"
                value={value("guardianId")}
                onChange={(event) => setParams({ guardianId: event.target.value || null })}
                className="h-12 w-full rounded-xl border border-slate-300 bg-white px-3 text-[16px]"
                disabled={guardiansQuery.isLoading}
              >
                <option value="">All guardians</option>
                {(guardiansQuery.data?.data ?? []).map((guardian) => (
                  <option key={guardian.id} value={guardian.id}>
                    {guardian.fullName}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          {needs("method") ? (
            <div>
              <label htmlFor="report-method" className="mb-1 block text-[14px] font-semibold text-slate-800">
                Method
              </label>
              <select
                id="report-method"
                value={value("method")}
                onChange={(event) => setParams({ method: event.target.value || null })}
                className="h-12 w-full rounded-xl border border-slate-300 bg-white px-3 text-[16px]"
                disabled={methodsQuery.isLoading}
              >
                <option value="">All methods</option>
                {(methodsQuery.data?.data ?? []).map((method) => (
                  <option key={method.code} value={method.code}>
                    {method.label}
                    {method.isActive ? "" : " (inactive)"}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          {needs("coachUserId") ? (
            <div>
              <label htmlFor="report-coach" className="mb-1 block text-[14px] font-semibold text-slate-800">
                Coach
              </label>
              <select
                id="report-coach"
                value={value("coachUserId")}
                onChange={(event) => setParams({ coachUserId: event.target.value || null })}
                className="h-12 w-full rounded-xl border border-slate-300 bg-white px-3 text-[16px]"
                disabled={coachesQuery.isLoading}
              >
                <option value="">All coaches</option>
                {(coachesQuery.data?.data ?? []).map((coach) => (
                  <option key={coach.user.id} value={coach.user.id}>
                    {coach.user.fullName}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          {needs("groupBy") ? (
            <div>
              <label htmlFor="report-groupby" className="mb-1 block text-[14px] font-semibold text-slate-800">
                Group by
              </label>
              <select
                id="report-groupby"
                value={value("groupBy")}
                onChange={(event) => setParams({ groupBy: event.target.value || null })}
                className="h-12 w-full rounded-xl border border-slate-300 bg-white px-3 text-[16px]"
              >
                {GROUP_BY_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {option === "ageGroup"
                      ? "Age group"
                      : option.charAt(0).toUpperCase() + option.slice(1)}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          {needs("minDaysOverdue") ? (
            <TextField
              id="report-min-days"
              label="Minimum days overdue"
              type="number"
              min={0}
              inputMode="numeric"
              value={value("minDaysOverdue")}
              onChange={(event) => setParams({ minDaysOverdue: event.target.value || null })}
              hint="Leave empty to include everything unpaid, however recent."
            />
          ) : null}

          {needs("overdue") ? (
            <div className="flex items-end pb-1">
              <Toggle
                id="report-overdue"
                label="Overdue only"
                hint="Issued or partly paid, past the due date."
                checked={value("overdue") === "true"}
                onChange={(next) => setParams({ overdue: next ? "true" : null })}
              />
            </div>
          ) : null}
        </div>
      </Card>

      {exportNotice ? (
        <div className="mb-4">
          <InlineAlert tone={exportNotice.tone}>{exportNotice.text}</InlineAlert>
        </div>
      ) : null}

      <Card>
        {reportQuery.isLoading ? (
          <ListSkeleton rows={8} />
        ) : reportQuery.isError ? (
          <ErrorState error={reportQuery.error} onRetry={() => reportQuery.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState
            title={filtersActive ? "Nothing matches these filters" : "No records for this report yet"}
            description={
              filtersActive
                ? "Try widening the date range or clearing a filter. The export follows the same filters."
                : "Once the academy has data in this area, it will appear here — and in the CSV export."
            }
          />
        ) : (
          <>
            {/* Desktop table (≥ 640 px) */}
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full border-collapse text-[14px]">
                <caption className="sr-only">
                  {spec.title} report, {rows.length} rows
                  {meta ? `, ${meta.total} matching, page ${meta.page} of ${meta.totalPages}` : ""}
                </caption>
                <thead>
                  <tr className="border-b border-slate-200 text-left text-[13px] uppercase tracking-wide text-slate-500">
                    {columns.map((column) => (
                      <th
                        key={column.key}
                        scope="col"
                        className={`px-4 py-3 font-semibold ${
                          column.type === "money" || column.type === "number" || column.type === "percent"
                            ? "text-right"
                            : ""
                        }`}
                      >
                        {column.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, index) => (
                    <tr
                      key={String(row.id ?? `${name}-${index}`)}
                      className="border-b border-slate-100 last:border-0 hover:bg-slate-50"
                    >
                      {columns.map((column) => (
                        <td
                          key={column.key}
                          className={`px-4 py-3 text-slate-700 ${
                            column.type === "money" || column.type === "number" || column.type === "percent"
                              ? "text-right font-medium text-slate-900"
                              : ""
                          }`}
                        >
                          <CellValue value={row[column.key] ?? null} column={column} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
                {totals ? (
                  <tfoot>
                    <tr className="border-t-2 border-slate-300 bg-slate-50 text-[14px] font-semibold text-slate-900">
                      {columns.map((column) => {
                        const total = totals[column.key];
                        return (
                          <th
                            key={column.key}
                            scope="row"
                            className={`px-4 py-3 text-left ${
                              column.type === "money" || column.type === "number" || column.type === "percent"
                                ? "text-right"
                                : ""
                            }`}
                          >
                            {total === undefined ? (
                              <span className="font-normal text-slate-500">
                                {column === columns[0] ? "Totals" : ""}
                              </span>
                            ) : column.type === "money" ? (
                              <MoneyText minor={total} />
                            ) : column.type === "percent" ? (
                              <span className="tabular">{total}%</span>
                            ) : (
                              <span className="tabular">{total.toLocaleString("en-GB")}</span>
                            )}
                          </th>
                        );
                      })}
                    </tr>
                  </tfoot>
                ) : null}
              </table>
            </div>

            {/* Mobile cards (< 640 px) */}
            <ul aria-label={`${spec.title} rows`} className="divide-y divide-slate-100 md:hidden">
              {rows.map((row, index) => (
                <li key={String(row.id ?? `${name}-m-${index}`)} className="px-4 py-3">
                  <p className="text-[15px] font-semibold text-slate-900">
                    {firstColumn ? cellText(row[firstColumn.key] ?? null, firstColumn) : `Row ${index + 1}`}
                  </p>
                  <dl className="mt-2 space-y-1 text-[13px]">
                    {restColumns.map((column) => (
                      <div key={column.key} className="flex items-start justify-between gap-3">
                        <dt className="text-slate-600">{column.label}</dt>
                        <dd className="text-right font-medium text-slate-900">
                          <CellValue value={row[column.key] ?? null} column={column} />
                        </dd>
                      </div>
                    ))}
                  </dl>
                </li>
              ))}
            </ul>

            {totals ? (
              <div className="border-t-2 border-slate-300 bg-slate-50 px-4 py-3 md:hidden">
                <p className="text-[13px] font-semibold uppercase tracking-wide text-slate-600">Totals</p>
                <dl className="mt-2 space-y-1 text-[13px]">
                  {columns
                    .filter((column) => totals[column.key] !== undefined)
                    .map((column) => (
                      <div key={column.key} className="flex items-start justify-between gap-3">
                        <dt className="text-slate-600">{column.label}</dt>
                        <dd className="text-right font-semibold text-slate-900">
                          {column.type === "money" ? (
                            <MoneyText minor={totals[column.key]} />
                          ) : column.type === "percent" ? (
                            <span className="tabular">{totals[column.key]}%</span>
                          ) : (
                            <span className="tabular">
                              {totals[column.key].toLocaleString("en-GB")}
                            </span>
                          )}
                        </dd>
                      </div>
                    ))}
                </dl>
              </div>
            ) : null}

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 px-4 py-3 text-[13px]">
              <p className="text-slate-600">
                {meta ? (
                  <>
                    Showing <span className="tabular">{rows.length}</span> of{" "}
                    <span className="tabular">{meta.total}</span> rows
                  </>
                ) : (
                  <>
                    <span className="tabular">{rows.length}</span> rows
                  </>
                )}
                {result?.generatedAt ? (
                  <>
                    {" "}
                    · Generated at <DateText value={result.generatedAt} withTime />
                  </>
                ) : null}
              </p>
              {meta && meta.totalPages > 1 ? (
                <div className="flex items-center gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={page <= 1}
                    onClick={() => setParams({ page: String(page - 1) }, { keepPage: true })}
                  >
                    Previous
                  </Button>
                  <span className="tabular text-slate-600">
                    {meta.page} / {meta.totalPages}
                  </span>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={page >= meta.totalPages}
                    onClick={() => setParams({ page: String(page + 1) }, { keepPage: true })}
                  >
                    Next
                  </Button>
                </div>
              ) : null}
            </div>
          </>
        )}
      </Card>

      <p className="mt-3 text-[12px] text-slate-500">
        A report reflects the ledger at the moment it was generated. The CSV export carries the same
        filters and is capped at {CSV_ROW_CAP.toLocaleString("en-GB")} rows.{" "}
        <Link href="/reports" className="font-semibold underline underline-offset-2">
          Back to all reports
        </Link>
      </p>
    </>
  );
}

/** Route owner: validates the name, then hands the report to the screen. */
function ReportRoute() {
  const params = useParams<{ name: string }>();
  const raw = String(params?.name ?? "");
  // An unknown report name is a real 404, not an empty table (ROUTES §1).
  if (!isReportName(raw)) notFound();
  return <ReportBody name={raw} />;
}

export default function ReportPage() {
  return (
    <RequireAuth>
      <RequirePermissions path="/reports">
        <Suspense fallback={<AuthLoading />}>
          <ReportRoute />
        </Suspense>
      </RequirePermissions>
    </RequireAuth>
  );
}
