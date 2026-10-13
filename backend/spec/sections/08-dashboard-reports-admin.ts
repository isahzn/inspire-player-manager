/**
 * API_CONTRACTS §3.8 — dashboards, reports, audit, system health, CSV import.
 *
 * Two honesty rules from the spec are structural here:
 *  - `invoicedMinor` and `collectedMinor` are separate fields on the owner
 *    dashboard and must never be summed into one "revenue" figure (T-RPT-01/09);
 *  - health endpoints (`SYS-01`/`SYS-02`) are unauthenticated and deliberately
 *    reveal nothing, which is why they are owned by M2 while `SYS-03` (owner-only,
 *    detailed) is M8.
 */
import { endpoint, section, res, z, type Section } from "../registry.js";
import {
  AuditEntry,
  CoachDashboard,
  DateStr,
  Id,
  ImportCommitResult,
  ImportValidation,
  Instant,
  OwnerDashboard,
  ReportName,
  ReportResult,
  SystemHealth,
  dateRangeQuery,
  pageOf,
  pageQuery,
  qParam,
  sortParam,
} from "../components.js";

const idParam = z.object({ id: Id });
const reportParam = z.object({ name: ReportName });

export const dashboardReportsAdminSection: Section = section(
  "3.8 Dashboard, reports, audit, system",
  [
    // -----------------------------------------------------------------------
    // Dashboards (DSH-01..02)
    // -----------------------------------------------------------------------
    endpoint({
      id: "DSH-01",
      method: "get",
      path: "/dashboard/owner",
      auth: "owner",
      permission: "reports:read",
      scope: "Owner only — the payload carries every financial aggregate",
      summary: "Owner dashboard",
      description:
        "Defaults to the current month. `invoicedMinor` counts invoices issued in the range; `collectedMinor` counts confirmed payments received in the range — they are never combined. `outstandingMinor`/`overdueMinor` are \"as of now\" and exclude void invoices and credit. `coachTime` derives only from `coach_attendance`: `checkedInNow` lists open records with elapsed minutes, `todayMinutes`/`weekMinutes` count **closed** records only, and a check-in open longer than 12 h surfaces in `openNeedingCorrection` plus the alerts strip (T-ATT-11). No coach-time figure touches an invoice, fee, balance or attendance metric.",
      tags: ["Dashboard"],
      query: dateRangeQuery,
      responses: [res.json(200, OwnerDashboard, "The dashboard aggregate")],
      milestone: "m8",
    }),

    endpoint({
      id: "DSH-02",
      method: "get",
      path: "/dashboard/coach",
      auth: "coach_scoped",
      permission: "sessions:read",
      scope: "Coach: own sessions (assigned groups) and own check-ins only — no financial field exists here",
      summary: "Coach dashboard",
      description:
        "`myOpenCheckIn` is the caller's own open record, which drives the one-tap clock-out; `myWeekMinutes` is the coach's own closed check-ins this week (CR-003).",
      tags: ["Dashboard"],
      responses: [
        res.json(
          200,
          CoachDashboard,
          "Today's sessions, upcoming sessions and the caller's own check-in state",
        ),
      ],
      milestone: "m8",
    }),

    // -----------------------------------------------------------------------
    // Reports (RPT-01..02)
    // -----------------------------------------------------------------------
    endpoint({
      id: "RPT-01",
      method: "get",
      path: "/reports/{name}",
      auth: "owner",
      permission: "reports:read",
      summary: "Run a report",
      description:
        "One route, eight reports: `players, attendance-summary, attendance-detail, invoices, payments, outstanding, collections, coach-attendance`. Rows are flat (never nested objects), `columns` tells the table what to render, and `totals` uses the same minor-unit convention as the rows. Outstanding and overdue exclude void and paid invoices; credit is reported separately (T-RPT-02).",
      tags: ["Reports"],
      params: reportParam,
      query: pageQuery.extend({
        from: DateStr.optional(),
        to: DateStr.optional(),
        ageGroupId: Id.optional(),
        playerId: Id.optional(),
        guardianId: Id.optional(),
        status: z.string().max(40).optional(),
        sort: sortParam,
      }),
      responses: [res.json(200, ReportResult, "The report page plus totals and columns")],
      errors: ["INVALID_SORT"],
      milestone: "m8",
    }),

    endpoint({
      id: "RPT-02",
      method: "get",
      path: "/reports/{name}/export",
      auth: "owner",
      permission: "reports:read",
      audit: "report.export",
      rateLimit: "exports",
      summary: "Export a report as CSV",
      description:
        "Streams `text/csv; charset=utf-8` with a BOM (so Sinhala/Tamil names survive Excel), a `Content-Disposition` filename, a 50 000-row cap and formula-injection neutralization: a cell beginning `=`, `+`, `-`, `@`, tab or CR is prefixed with `'` (T-RPT-04). The export is audited **with the filters used**, because it is a bulk read of children's data.",
      tags: ["Reports"],
      params: reportParam,
      query: z.object({
        from: DateStr.optional(),
        to: DateStr.optional(),
        ageGroupId: Id.optional(),
        playerId: Id.optional(),
        guardianId: Id.optional(),
        status: z.string().max(40).optional(),
        sort: sortParam,
      }),
      responses: [
        res.csv("The CSV document"),
        {
          status: 429,
          description: "RATE_LIMITED — exports are limited to 10 per hour per user.",
        },
      ],
      errors: ["RATE_LIMITED"],
      milestone: "m8",
    }),

    // -----------------------------------------------------------------------
    // Audit (AUD-01)
    // -----------------------------------------------------------------------
    endpoint({
      id: "AUD-01",
      method: "get",
      path: "/audit-logs",
      auth: "owner",
      permission: "audit:read",
      scope: "Owner only; the audit trail is not readable by coaches",
      summary: "Read the audit log",
      description:
        "Append-only: the runtime database role may SELECT and INSERT, never UPDATE or DELETE (T-DB-RLS-03), and a nightly job verifies the hash chain. CONTRACT GAP: the row does not say whether `from`/`to` are business dates or instants; they are declared as instants here (the column is `occurred_at timestamptz`) and flagged in the M1 handoff §4.",
      tags: ["Admin"],
      query: pageQuery.extend({
        actorUserId: Id.optional(),
        entityType: z.string().max(60).optional(),
        entityId: Id.optional(),
        action: z.string().max(80).optional(),
        from: Instant.optional(),
        to: Instant.optional(),
        q: qParam,
      }),
      responses: [res.json(200, pageOf(AuditEntry), "One page of audit entries, newest first")],
      milestone: "m8",
    }),

    // -----------------------------------------------------------------------
    // System (SYS-01..03)
    // -----------------------------------------------------------------------
    endpoint({
      id: "SYS-01",
      method: "get",
      path: "/health",
      auth: "public",
      summary: "Liveness probe",
      description: "Deliberately reveals nothing: a plain liveness answer for the host and uptime monitor. Readiness is SYS-02; details are SYS-03 (owner-only).",
      tags: ["Admin"],
      responses: [res.json(200, z.object({ status: z.literal("ok") }), "Alive")],
      milestone: "m2",
    }),

    endpoint({
      id: "SYS-02",
      method: "get",
      path: "/ready",
      auth: "public",
      summary: "Readiness probe",
      description:
        "Answers 200 only when the database is reachable; 503 otherwise, so a load balancer takes the instance out of rotation instead of serving broken requests (T-OPS-03).",
      tags: ["Admin"],
      responses: [
        res.empty(200, "Ready"),
        { status: 503, description: "DEPENDENCY_UNAVAILABLE — the database is not reachable." },
      ],
      errors: ["DEPENDENCY_UNAVAILABLE"],
      milestone: "m2",
    }),

    endpoint({
      id: "SYS-03",
      method: "get",
      path: "/system/health",
      auth: "owner",
      permission: "audit:read",
      summary: "Detailed system health",
      description:
        "Dependency status (database, storage, messaging provider, queue), the scheduler's last run and the last backup — the operator's page. A stale worker heartbeat or a failed backup is visible here rather than only in logs.",
      tags: ["Admin"],
      responses: [res.json(200, SystemHealth, "Dependency and job health")],
      milestone: "m8",
    }),

    // -----------------------------------------------------------------------
    // CSV import (IMP-01..02)
    // -----------------------------------------------------------------------
    endpoint({
      id: "IMP-01",
      method: "post",
      path: "/imports/players/validate",
      auth: "owner",
      permission: "import:manage",
      mutating: true,
      audit: "import.validate",
      summary: "Validate a players CSV",
      description:
        "multipart/form-data with a `csv` file part. Nothing is written to `players`: the batch is stored, every row is validated (columns per CSV_IMPORT §2) and the response previews what would be created, with per-row errors and warnings (`importRowsWithWarnings`, raised as a contract gap in the Step 3 handoff §4 — errors and warnings are separate arrays here).",
      tags: ["Admin"],
      bodyContentType: "multipart/form-data",
      body: z.strictObject({
        file: z.string().openapi({ format: "binary" }).describe("UTF-8 CSV"),
      }),
      responses: [res.json(200, ImportValidation, "Row count, issues and preview")],
      errors: ["FILE_TOO_LARGE", "UNSUPPORTED_FILE_TYPE"],
      milestone: "m3",
    }),

    endpoint({
      id: "IMP-02",
      method: "post",
      path: "/imports/players/{batchId}/commit",
      auth: "owner",
      permission: "import:manage",
      idempotent: true,
      mutating: true,
      audit: "import.commit",
      summary: "Commit a validated import batch",
      description:
        "All-or-nothing: a single failure rolls the whole batch back, so there is no half-imported roster to reconcile. Duplicate-suspect rows are skipped and counted rather than silently merged.",
      tags: ["Admin"],
      params: z.object({ batchId: Id }),
      responses: [res.json(200, ImportCommitResult, "Created and skipped counts")],
      errors: ["INVALID_STATE_TRANSITION", "VALIDATION_ERROR"],
      milestone: "m3",
    }),
  ],
);
