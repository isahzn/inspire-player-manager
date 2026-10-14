/**
 * RPT-01/RPT-02 — run a report, and export it (API_CONTRACTS §3.8, M8).
 *
 * Both handlers are thin on purpose: the eight reports, their columns and their arithmetic live
 * in `ops/reports.ts`, so the JSON view and the CSV file are the *same* result rendered two ways
 * and cannot drift apart. What lives here is the HTTP-shaped part:
 *
 *  - **Paging is over the full result.** `totals` are computed across every matching row and
 *    `meta.total` is that same count, because a total over one page is a number nobody can use.
 *  - **An unknown sort field is 422 `INVALID_SORT`**, not a silently different order.
 *  - **The export is capped and audited.** It streams `text/csv; charset=utf-8` with a BOM (so a
 *    spreadsheet reads Sinhala/Tamil names), CRLF lines, formula-injection neutralisation and
 *    **no totals row** — a "Total" line inside a column a spreadsheet will sum is a double-count
 *    trap. The audit row names the filters used, because a bulk read of children's data should be
 *    answerable for what it read. The contract also rate-limits this route to 10/hour, which the
 *    router applies from the endpoint's `rateLimit: "exports"` label.
 *
 * One contract gap, recorded rather than invented: the frontend mock refuses an oversized export
 * with `ROW_LIMIT_EXCEEDED` (413), and **no such code exists in the catalogue**
 * (`spec/registry.ts`). The cap is enforced with `VALIDATION_ERROR` (422) plus a detail telling
 * the caller to narrow the filters — an existing code, used honestly.
 */
import { ApiError } from "../errors.js";
import { asViewer } from "../http/context.js";
import * as audit from "../audit.js";
import type { Handler, HandlerResult } from "../http/router.js";
import type { ReportName } from "../../spec/components.js";
import { viewerAudit } from "./auth.js";
import {
  EXPORT_ROW_CAP,
  REPORT_COLUMNS,
  buildCsv,
  csvFilename,
  pageWindow,
  runReport,
  type ReportFilters,
} from "../ops/reports.js";

/** Only the filters the contract declares are read; anything else in the query is ignored. */
function filtersFrom(query: Record<string, unknown>): ReportFilters {
  const filters: ReportFilters = {};
  const put = (key: keyof ReportFilters, value: unknown): void => {
    if (typeof value === "string" && value !== "") filters[key] = value;
  };
  put("from", query["from"]);
  put("to", query["to"]);
  put("ageGroupId", query["ageGroupId"]);
  put("playerId", query["playerId"]);
  put("guardianId", query["guardianId"]);
  put("status", query["status"]);
  return filters;
}

// ---------------------------------------------------------------------------
// RPT-01 — run a report
// ---------------------------------------------------------------------------
export const rpt01Run: Handler = async ({ viewer, params, query }): Promise<HandlerResult> => {
  const { name } = params as { name: ReportName };
  const request = query as { page: number; pageSize: number; sort?: string } & Record<
    string,
    unknown
  >;
  const filters = filtersFrom(request);

  const body = await asViewer(viewer, async (client) => {
    const run = await runReport(client, { name, filters, sort: request.sort });
    if (run.unknownSort) {
      throw new ApiError("INVALID_SORT", `Unknown sort field "${run.unknownSort}".`);
    }

    const { offset, limit } = pageWindow(request.page, request.pageSize);
    return {
      data: run.rows.slice(offset, offset + limit),
      meta: {
        page: request.page,
        pageSize: request.pageSize,
        total: run.rows.length,
        totalPages: request.pageSize > 0 ? Math.ceil(run.rows.length / request.pageSize) : 0,
      },
      ...(run.totals ? { totals: run.totals } : {}),
      columns: REPORT_COLUMNS[name],
      generatedAt: new Date().toISOString(),
      filters,
    };
  });

  return { status: 200, body };
};

// ---------------------------------------------------------------------------
// RPT-02 — export a report as CSV
// ---------------------------------------------------------------------------
export const rpt02Export: Handler = async ({
  ctx,
  viewer,
  params,
  query,
}): Promise<HandlerResult> => {
  const { name } = params as { name: ReportName };
  const filters = filtersFrom(query as Record<string, unknown>);
  const sort = (query as { sort?: string }).sort;

  const result = await asViewer(viewer, async (client) => {
    const run = await runReport(client, { name, filters, sort });
    if (run.unknownSort) {
      throw new ApiError("INVALID_SORT", `Unknown sort field "${run.unknownSort}".`);
    }

    if (run.rows.length > EXPORT_ROW_CAP) {
      throw new ApiError(
        "VALIDATION_ERROR",
        `This export would contain ${run.rows.length} rows, more than the ${EXPORT_ROW_CAP} row limit.`,
        [
          {
            field: "from",
            issue: `Narrow the filters (max ${EXPORT_ROW_CAP} rows).`,
          },
        ],
      );
    }

    // The filename carries the academy's own date, not the server's UTC slice of it.
    const today = await client.query<{ today: string }>(
      `select (now() at time zone timezone)::date::text as today from academy_settings where id = 1`,
    );
    const stamp = today.rows[0]?.today ?? new Date().toISOString().slice(0, 10);

    const document = buildCsv(name, REPORT_COLUMNS[name], run.rows);

    await audit.record(client, viewerAudit(viewer, ctx), {
      action: "report.export",
      entityType: "report",
      entityId: null,
      after: { name, filters, rowCount: run.rows.length },
    });

    return { document, filename: csvFilename(name, filters, stamp) };
  });

  return {
    status: 200,
    body: result.document,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${result.filename}"`,
      // A bulk read of children's data: never cached by a shared proxy.
      "cache-control": "no-store",
    },
  };
};
