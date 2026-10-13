"use client";

// Step 7 handlers: DSH-01 `GET /dashboard/owner`, DSH-02 `GET /dashboard/coach`,
// RPT-01 `GET /reports/{name}` and RPT-02 `GET /reports/{name}/export`
// (API_CONTRACTS §3.8). Aggregation lives in `./reports`; this file only shapes
// the dashboard payloads, guards the routes and streams the CSV.
//
// Money discipline on the dashboard is the contract's own field split:
// `invoicedMinor` (issued in the range) and `collectedMinor` (CONFIRMED payments
// in the range) are separate fields; outstanding/overdue/credit are "as of now"
// and are named so on the screen. Nothing here ever adds the two together.

import { HttpResponse, delay, http } from "msw";
import type { CoachDashboard, OwnerDashboard } from "@/api/types";
import { academyDateOf, addDaysISO, minutesBetween, todayISO } from "@/lib/dates";
import {
  MockError,
  OWNER_ID,
  closedMinutesIn,
  getDb,
  listCoachAttendance,
  listGroups,
  listSessions,
  openCheckInFor,
  type Db,
} from "./db";
import { authed, json, ownerOnly } from "./http";
import { buildCsv, parseFilters, refreshLedger, runReport } from "./reports";
import { getAdmin, queueCounts } from "./store678";

const OWNER_VIEWER = { role: "owner" as const, userId: OWNER_ID };

/** An open check-in older than 12 h needs an owner correction (ATTENDANCE §5). */
const OPEN_CHECKIN_ALERT_MINUTES = 12 * 60;

function firstParam(value: string | readonly string[] | undefined): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.length > 0 ? String(value[0]) : "";
  return "";
}

function creditHeldMinor(db: Db): number {
  return db.payments
    .filter((p) => p.status === "confirmed")
    .reduce((sum, p) => {
      const allocated = p.allocations
        .filter((a) => !a.reversedAt)
        .reduce((inner, a) => inner + a.amountMinor, 0);
      return sum + Math.max(0, p.amountMinor - allocated);
    }, 0);
}

function weekStartOf(dateISO: string, weekStartDay: number): string {
  const at = Date.parse(`${dateISO}T00:00:00Z`);
  if (Number.isNaN(at)) return dateISO;
  const weekday = new Date(at).getUTCDay(); // 0 = Sunday
  return addDaysISO(dateISO, -((weekday - weekStartDay + 7) % 7));
}

function buildOwnerDashboard(from: string, to: string): OwnerDashboard {
  const db = getDb();
  const today = todayISO();
  const now = new Date().toISOString();

  const groups = listGroups(true, OWNER_VIEWER);
  const players = {
    active: db.players.filter((p) => p.status === "active").length,
    inactive: db.players.filter((p) => p.status === "inactive").length,
    withdrawn: db.players.filter((p) => p.status === "withdrawn").length,
    byGroup: groups.map((g) => ({
      ageGroupId: g.id,
      name: g.name,
      count: g.activePlayerCount ?? 0,
    })),
  };

  const todays = listSessions({ from: today, to: today }, OWNER_VIEWER).data;
  const upcoming = listSessions({ from: addDaysISO(today, 1), to: addDaysISO(today, 7) }, OWNER_VIEWER).data;
  const scored = todays.filter((s) => s.status !== "cancelled");
  const todayAttendance = {
    present: scored.reduce((n, s) => n + (s.attendanceSummary?.present ?? 0), 0),
    absent: scored.reduce((n, s) => n + (s.attendanceSummary?.absent ?? 0), 0),
    late: scored.reduce((n, s) => n + (s.attendanceSummary?.late ?? 0), 0),
    excused: scored.reduce((n, s) => n + (s.attendanceSummary?.excused ?? 0), 0),
    unmarked: scored.reduce((n, s) => n + (s.attendanceSummary?.unmarked ?? 0), 0),
  };

  // Coach time — hours come from CLOSED records only; an open check-in counts
  // towards "checked in now" and towards "needs correction", never towards hours.
  const coachRows = listCoachAttendance(
    { from: addDaysISO(today, -30), to: addDaysISO(today, 1) },
    OWNER_VIEWER
  ).data;
  const openRows = coachRows.filter((r) => !r.checkOutAt);
  const weekStart = weekStartOf(today, db.settings.weekStartDay);
  const coachTime = {
    checkedInNow: openRows.map((r) => ({
      coach: { id: r.coach.id, fullName: r.coach.fullName },
      session: { id: r.session.id, ageGroupName: r.session.ageGroupName, startsAt: r.session.startsAt },
      checkInAt: r.checkInAt,
      elapsedMinutes: minutesBetween(r.checkInAt, now),
    })),
    todayMinutes: closedMinutesIn(
      db,
      coachRows.filter((r) => academyDateOf(r.checkInAt) === today)
    ),
    weekMinutes: closedMinutesIn(
      db,
      coachRows.filter((r) => academyDateOf(r.checkInAt) >= weekStart && academyDateOf(r.checkInAt) <= today)
    ),
    openNeedingCorrection: openRows.filter((r) => minutesBetween(r.checkInAt, now) > OPEN_CHECKIN_ALERT_MINUTES).length,
  };

  // Money. `refreshLedger()` is the billing engine's own read path (it recomputes
  // every balance from active allocations), so these figures cannot drift from
  // the billing screens.
  const invoices = refreshLedger();
  const ranged = invoices.filter((i) => i.status !== "void" && i.issueDate >= from && i.issueDate <= to);
  const open = invoices.filter((i) => i.status !== "void" && i.balanceMinor > 0);
  const overdue = open.filter((i) => i.isOverdue);
  const dueSoonEnd = addDaysISO(today, 7);
  const dueSoon = open.filter((i) => i.dueDate >= today && i.dueDate <= dueSoonEnd);
  const money = {
    invoicedMinor: ranged.reduce((n, i) => n + i.totalMinor, 0),
    invoicesIssuedCount: ranged.length,
    collectedMinor: db.payments
      .filter((p) => {
        if (p.status !== "confirmed") return false;
        const date = academyDateOf(p.receivedAt);
        return date >= from && date <= to;
      })
      .reduce((n, p) => n + p.amountMinor, 0),
    outstandingMinor: open.reduce((n, i) => n + i.balanceMinor, 0),
    overdueMinor: overdue.reduce((n, i) => n + i.balanceMinor, 0),
    overdueCount: overdue.length,
    dueSoon: { days: 7, count: dueSoon.length, totalMinor: dueSoon.reduce((n, i) => n + i.balanceMinor, 0) },
    creditHeldMinor: creditHeldMinor(db),
  };

  const store = getAdmin();
  const counts = queueCounts();
  const messaging = {
    automationEnabled: !store.masterPaused,
    automations: store.automations,
    sessionStatus: store.sessionStatus,
    failed24h: counts.failedLast24h,
    dead: counts.dead,
    needsReview: counts.needsReview,
  };

  const alerts: OwnerDashboard["alerts"] = [];
  if (store.sessionStatus !== "connected") {
    alerts.push({
      code: "WHATSAPP_SESSION_DOWN",
      severity: "critical",
      message: `WhatsApp is not connected (status: ${store.sessionStatus}). Reminders stay queued until it reconnects.`,
      link: "/whatsapp",
    });
  }
  if (counts.dead > 0) {
    alerts.push({
      code: "MESSAGES_DEAD",
      severity: "warning",
      message: `${counts.dead} message${counts.dead === 1 ? "" : "s"} failed permanently.`,
      link: "/whatsapp?tab=messages&status=dead",
    });
  }
  if (counts.needsReview > 0) {
    alerts.push({
      code: "MESSAGES_NEEDS_REVIEW",
      severity: "warning",
      message: `${counts.needsReview} message${counts.needsReview === 1 ? "" : "s"} need review — the provider's answer was ambiguous.`,
      link: "/whatsapp?tab=messages&status=needs_review",
    });
  }
  if (coachTime.openNeedingCorrection > 0) {
    alerts.push({
      code: "COACH_OPEN_CHECKIN",
      severity: "warning",
      message: `${coachTime.openNeedingCorrection} open coach check-in${
        coachTime.openNeedingCorrection === 1 ? "" : "s"
      } older than 12 hours need correction.`,
      link: "/coach-attendance",
    });
  }
  if (counts.failedLast24h > 0) {
    alerts.push({
      code: "MESSAGES_FAILING",
      severity: "info",
      message: `${counts.failedLast24h} message${counts.failedLast24h === 1 ? "" : "s"} failed in the last 24 hours and will retry.`,
      link: "/whatsapp?tab=messages&status=failed",
    });
  }

  return {
    range: { from, to },
    players,
    coachTime,
    sessions: { today: todays, next7Days: upcoming, todayAttendance },
    money,
    messaging,
    alerts,
  };
}

export const dashboardHandlers = [
  // DSH-01 ------------------------------------------------------------------
  http.get(
    "*/dashboard/owner",
    ownerOnly(async ({ request }) => {
      await delay(350);
      const url = new URL(request.url);
      const today = todayISO();
      const from = url.searchParams.get("from") ?? `${today.slice(0, 7)}-01`;
      const to = url.searchParams.get("to") ?? today;
      if (from > to) {
        throw new MockError("VALIDATION_ERROR", "The start date is after the end date.", 422, [
          { field: "from", issue: "Pick a start date on or before the end date" },
        ]);
      }
      return json(buildOwnerDashboard(from, to));
    })
  ),

  // DSH-02 ------------------------------------------------------------------
  http.get(
    "*/dashboard/coach",
    authed(async ({ viewer }) => {
      await delay(300);
      const db = getDb();
      const today = todayISO();
      const weekStart = weekStartOf(today, db.settings.weekStartDay);
      const mine = listCoachAttendance({ from: weekStart, to: today }, viewer).data.filter(
        (r) => r.coach.id === viewer.userId
      );
      const payload: CoachDashboard = {
        todaySessions: listSessions({ from: today, to: today }, viewer).data,
        upcoming: listSessions({ from: addDaysISO(today, 1), to: addDaysISO(today, 14) }, viewer).data,
        myOpenCheckIn: openCheckInFor(viewer.userId),
        // Closed records only — an open check-in has no hours yet.
        myWeekMinutes: closedMinutesIn(db, mine),
      };
      return json(payload);
    })
  ),

  // RPT-02 (registered before RPT-01 so the export path is never read as a name
  // that happens to be `…/export`) ------------------------------------------
  http.get(
    "*/reports/:name/export",
    ownerOnly(async ({ request, params }) => {
      await delay(500);
      const name = firstParam(params.name);
      const filters = parseFilters(new URL(request.url));
      const { csv, filename } = buildCsv(name, filters, OWNER_VIEWER);
      // Real headers: the CSV is not the JSON envelope (API_CONTRACTS §3.8).
      return new HttpResponse(csv, {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="${filename}"`,
        },
      });
    })
  ),

  // RPT-01 ------------------------------------------------------------------
  http.get(
    "*/reports/:name",
    ownerOnly(async ({ request, params }) => {
      await delay(350);
      const name = firstParam(params.name);
      const filters = parseFilters(new URL(request.url));
      return json(runReport(name, filters, OWNER_VIEWER));
    })
  ),
];
