"use client";

// Reports index (PAGE_SPECIFICATIONS §10, ROUTES_AND_NAVIGATION §1). One card per
// report, each naming what it answers and the filters it actually takes, because
// the report pages are the only place the academy reads its own numbers out.
import Link from "next/link";
import {
  AlertTriangle,
  Banknote,
  BarChart3,
  CalendarCheck,
  ClipboardList,
  Receipt,
  Timer,
  TrendingUp,
  Users,
} from "lucide-react";
import { RequireAuth, RequirePermissions } from "@/components/Guards";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/ui";

interface ReportCard {
  name: string;
  title: string;
  answers: string;
  filters: string;
  icon: typeof Users;
}

/**
 * The eight reports in the contract's `name` enum. Nothing here is invented: the
 * columns live on the report page (they come from the API), this list only says
 * what each report is for.
 */
const REPORTS: ReportCard[] = [
  {
    name: "players",
    title: "Players",
    answers: "Who is registered, in which group, and how to reach their guardian.",
    filters: "Status · age group · registered between · search",
    icon: Users,
  },
  {
    name: "attendance-summary",
    title: "Attendance summary",
    answers: "How often each player turned up over a period, and the group averages.",
    filters: "Dates · age group · player",
    icon: CalendarCheck,
  },
  {
    name: "attendance-detail",
    title: "Attendance detail",
    answers: "Every marked record, line by line, with who marked it and the note.",
    filters: "Dates · age group · session · status",
    icon: ClipboardList,
  },
  {
    name: "invoices",
    title: "Invoices",
    answers: "What was invoiced, what has been paid, and what each invoice still owes.",
    filters: "Issued/due between · status · age group · overdue · player",
    icon: Receipt,
  },
  {
    name: "payments",
    title: "Payments",
    answers: "What was actually received, by which method, and how much is unallocated credit.",
    filters: "Received between · method · status · guardian",
    icon: Banknote,
  },
  {
    name: "outstanding",
    title: "Outstanding balances",
    answers: "Who owes money right now, oldest first — as of now, not for a period.",
    filters: "Age group · minimum days overdue",
    icon: AlertTriangle,
  },
  {
    name: "collections",
    title: "Collections",
    answers: "Money received against money invoiced, kept as two separate columns.",
    filters: "Dates · age group · group by day, week, month, method or group",
    icon: TrendingUp,
  },
  {
    name: "coach-attendance",
    title: "Coach time",
    answers: "Coach check-ins and hours — closed records only, never an open check-in.",
    filters: "Dates · coach",
    icon: Timer,
  },
];

export default function ReportsIndexPage() {
  return (
    <RequireAuth>
      <RequirePermissions path="/reports">
        <PageHeader
          title="Reports"
          sub="Read-only views over the academy's own data. Every report can be exported as CSV with the filters you chose."
        />

        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {REPORTS.map((report) => {
            const Icon = report.icon;
            return (
              <Card key={report.name} className="flex flex-col p-4">
                <div className="flex items-start gap-3">
                  <span
                    aria-hidden="true"
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-navy-900/5 text-navy-900"
                  >
                    <Icon className="h-5 w-5" />
                  </span>
                  <div className="min-w-0">
                    <h2 className="font-heading text-[16px] font-semibold text-slate-900">
                      {report.title}
                    </h2>
                    <p className="mt-1 text-[13px] text-slate-600">{report.answers}</p>
                  </div>
                </div>
                <dl className="mt-3 space-y-1 text-[13px]">
                  <div className="flex gap-2">
                    <dt className="shrink-0 font-semibold text-slate-700">Filters</dt>
                    <dd className="min-w-0 text-slate-600">{report.filters}</dd>
                  </div>
                </dl>
                <div className="mt-4 flex-1" />
                <Link
                  href={`/reports/${report.name}`}
                  className="touch44 inline-flex min-h-[44px] items-center font-semibold text-pitch-700 underline underline-offset-2"
                >
                  Open {report.title.toLowerCase()}
                </Link>
              </Card>
            );
          })}
        </div>

        <Card className="mt-5 p-4">
          <div className="flex items-start gap-3">
            <BarChart3 className="mt-0.5 h-5 w-5 shrink-0 text-slate-500" aria-hidden="true" />
            <p className="text-[13px] text-slate-600">
              <strong className="font-semibold text-slate-800">Reading money in a report:</strong>{" "}
              Invoiced and Collected are separate figures and are never added together. Outstanding
              and Overdue are always &ldquo;as of now&rdquo;, so they will not add up against a
              period either. An export is capped at 50,000 rows — narrow the filters if a report is
              bigger than that.
            </p>
          </div>
        </Card>
      </RequirePermissions>
    </RequireAuth>
  );
}
