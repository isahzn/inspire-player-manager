"use client";

// Dashboard — PAGE_SPECIFICATIONS §2. One route, two projections:
//  · owner  → DSH-01: alerts, the money row (Invoiced · Collected · Outstanding ·
//    Overdue, always as separate numbers), players, today's sessions, **Coaches
//    today** (CR-003), upcoming, messaging.
//  · coach  → DSH-02 "Today": today's session cards with one-tap clock in/out and
//    take-attendance, upcoming sessions, own hours this week. A coach never sees
//    money, and never calls an owner endpoint.
//
// Rules this page is built around:
//  · Invoiced and Collected are never summed (CLAUDE.md money rule). Only they
//    follow the date-range selector; Outstanding/Overdue are "as of now" and are
//    labelled so.
//  · Clock in/out is one tap from the card — no dialog, no confirmation. It is
//    reversible by an owner correction, so a confirm step would only cost time
//    (PAGE_SPEC §2). Everything shown afterwards is the SERVER's time, in the
//    academy timezone; the device clock is never used to record anything.
//  · Hours come from CLOSED check-ins only — an open check-in is shown as elapsed
//    time and is never counted as worked hours (ATTENDANCE §5).
import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowRight,
  BarChart3,
  CalendarCheck,
  Clock,
  LogIn,
  LogOut,
  MessageCircle,
  Receipt,
  Timer,
  Users,
} from "lucide-react";
import {
  ApiError,
  cat01CheckIn,
  cat02CheckOut,
  dsh01GetOwnerDashboard,
  dsh02GetCoachDashboard,
  msg06GetMessagingStatus,
} from "@/api/client";
import type {
  CoachDashboard,
  OwnerDashboard,
  Session,
} from "@/api/types";
import { RequireAuth } from "@/components/Guards";
import { PageHeader } from "@/components/PageHeader";
import { StatusChip } from "@/components/StatusChip";
import {
  Button,
  EmptyState,
  ErrorState,
  InlineAlert,
  ListSkeleton,
  SectionTitle,
  Toast,
} from "@/components/ui";
import { useAuth } from "@/lib/auth";
import {
  academyTime,
  addDaysISO,
  formatDateRange,
  formatDateStr,
  formatDuration,
  minutesBetween,
  todayISO,
} from "@/lib/dates";
import { formatMoneyMinor } from "@/lib/money";
import {
  automationStateLine,
  automationWarning,
  sessionStatusLabel,
  sessionStatusTone,
} from "@/lib/messaging";

// --- date range -------------------------------------------------------------
// Business dates only: never `new Date(str)`, which would shift the day across
// timezones (lib/dates.ts). The first of a month is the date with `01` appended.

type RangeKey = "this-month" | "last-month" | "custom";

function firstOfMonth(dateISO: string): string {
  return `${dateISO.slice(0, 8)}01`;
}

/**
 * The first and last day of the month `offset` months before `today`, by pure
 * date arithmetic on business dates (never a Date object, which would shift the
 * day across timezones). `offset = 0` is the current month.
 */
function monthRange(today: string, offset: number): { from: string; to: string } {
  let from = firstOfMonth(today);
  for (let i = 0; i < offset; i += 1) {
    from = firstOfMonth(addDaysISO(from, -1));
  }
  const to = addDaysISO(firstOfMonth(addDaysISO(from, 32)), -1);
  return { from, to };
}

const RANGE_TABS: { key: RangeKey; label: string }[] = [
  { key: "this-month", label: "This month" },
  { key: "last-month", label: "Last month" },
  { key: "custom", label: "Custom" },
];

function DashboardBody() {
  const { me } = useAuth();
  const isOwner = me?.user.role === "owner";
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();

  const today = todayISO();
  const [toast, setToast] = useState<string | null>(null);

  const rangeParam = (searchParams.get("range") as RangeKey | null) ?? "this-month";
  const defaults = rangeParam === "last-month" ? monthRange(today, 1) : monthRange(today, 0);
  const from = searchParams.get("from") ?? defaults.from;
  const to = searchParams.get("to") ?? defaults.to;

  function setRange(next: RangeKey, nextFrom?: string, nextTo?: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("range", next);
    if (next === "custom") {
      params.set("from", nextFrom ?? from);
      params.set("to", nextTo ?? to);
    } else {
      params.delete("from");
      params.delete("to");
    }
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }

  const ownerQuery = useQuery({
    queryKey: ["dashboard", "owner", { from, to }],
    queryFn: () => dsh01GetOwnerDashboard({ from, to }),
    enabled: Boolean(me) && isOwner,
  });

  const coachQuery = useQuery({
    queryKey: ["dashboard", "coach"],
    queryFn: () => dsh02GetCoachDashboard(),
    enabled: Boolean(me) && !isOwner,
  });

  const messagingQuery = useQuery({
    queryKey: ["messaging", "status"],
    queryFn: () => msg06GetMessagingStatus(),
    enabled: Boolean(me) && isOwner,
  });

  // One clock for "elapsed" labels; the values themselves are the server's.
  const [now, setNow] = useState(() => new Date().toISOString());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date().toISOString()), 30_000);
    return () => clearInterval(timer);
  }, []);

  if (isOwner) {
    return (
      <>
        <PageHeader
          title="Dashboard"
          sub={
            ownerQuery.data
              ? `Academy overview · ${formatDateRange(ownerQuery.data.range.from, ownerQuery.data.range.to)}`
              : "Academy overview"
          }
          actions={
            <>
              <Link
                href="/reports"
                className="touch44 inline-flex h-11 items-center gap-2 rounded-xl border border-slate-300 bg-white px-4 text-[14px] font-semibold text-slate-800 hover:bg-slate-50"
              >
                <BarChart3 className="h-4 w-4" aria-hidden="true" />
                Reports
              </Link>
              <Link
                href="/billing/new"
                className="touch44 inline-flex h-11 items-center gap-2 rounded-xl bg-pitch-600 px-4 text-[14px] font-semibold text-white hover:bg-pitch-700"
              >
                <Receipt className="h-4 w-4" aria-hidden="true" />
                New billing run
              </Link>
            </>
          }
        />

        <RangeSelector
          range={rangeParam}
          from={from}
          to={to}
          onPick={setRange}
          disabled={!ownerQuery.data}
        />

        {ownerQuery.isLoading ? (
          <div aria-busy="true" aria-label="Loading the dashboard">
            <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="skeleton h-28 rounded-2xl" />
              ))}
            </div>
            <div className="mt-5 grid gap-4 lg:grid-cols-2">
              <div className="skeleton h-52 rounded-2xl" />
              <div className="skeleton h-52 rounded-2xl" />
            </div>
          </div>
        ) : ownerQuery.isError ? (
          <div className="rounded-2xl border border-slate-200 bg-white shadow-card">
            <ErrorState error={ownerQuery.error} onRetry={() => ownerQuery.refetch()} />
          </div>
        ) : ownerQuery.data ? (
          <OwnerView
            data={ownerQuery.data}
            now={now}
            messaging={messagingQuery.data}
            messagingLoading={messagingQuery.isLoading}
          />
        ) : null}

        {toast ? <Toast message={toast} onDismiss={() => setToast(null)} /> : null}
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Today"
        sub={`Your sessions and hours · ${formatDateStr(today)}`}
      />

      {coachQuery.isLoading ? (
        <div aria-busy="true" aria-label="Loading today">
          <div className="skeleton h-40 rounded-2xl" />
          <div className="mt-4 skeleton h-28 rounded-2xl" />
        </div>
      ) : coachQuery.isError ? (
        <div className="rounded-2xl border border-slate-200 bg-white shadow-card">
          <ErrorState error={coachQuery.error} onRetry={() => coachQuery.refetch()} />
        </div>
      ) : coachQuery.data ? (
        <CoachView
          data={coachQuery.data}
          now={now}
          onChanged={(message) => {
            setToast(message);
            void queryClient.invalidateQueries({ queryKey: ["dashboard", "coach"] });
            // An owner's dashboard and the coach-time log both move when a coach
            // clocks in or out, so they are refreshed too.
            void queryClient.invalidateQueries({ queryKey: ["dashboard", "owner"] });
            void queryClient.invalidateQueries({ queryKey: ["coach-attendance"] });
          }}
        />
      ) : null}

      {toast ? <Toast message={toast} onDismiss={() => setToast(null)} /> : null}
    </>
  );
}

// --- owner ------------------------------------------------------------------

function RangeSelector({
  range,
  from,
  to,
  onPick,
  disabled,
}: {
  range: RangeKey;
  from: string;
  to: string;
  onPick: (range: RangeKey, from?: string, to?: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="mb-4 rounded-2xl border border-slate-200 bg-white p-3 shadow-card">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[12px] font-semibold uppercase tracking-wide text-slate-500">
            Period for Invoiced and Collected
          </p>
          <div className="mt-2 flex flex-wrap gap-2" role="group" aria-label="Date range">
            {RANGE_TABS.map((tab) => {
              const active = tab.key === range;
              return (
                <button
                  key={tab.key}
                  type="button"
                  aria-pressed={active}
                  disabled={disabled && tab.key !== "custom"}
                  onClick={() => onPick(tab.key)}
                  className={`touch44 min-h-[44px] cursor-pointer rounded-xl border px-3 text-[14px] font-semibold ${
                    active
                      ? "border-pitch-600 bg-pitch-50 text-pitch-800"
                      : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                  }`}
                >
                  {tab.label}
                </button>
              );
            })}
          </div>
        </div>
        {range === "custom" ? (
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label htmlFor="dash-from" className="mb-1 block text-[13px] font-semibold text-slate-700">
                From
              </label>
              <input
                id="dash-from"
                type="date"
                value={from}
                onChange={(event) => onPick("custom", event.target.value, to)}
                className="touch44 h-12 rounded-xl border border-slate-300 bg-white px-3 text-[16px]"
              />
            </div>
            <div>
              <label htmlFor="dash-to" className="mb-1 block text-[13px] font-semibold text-slate-700">
                To
              </label>
              <input
                id="dash-to"
                type="date"
                value={to}
                onChange={(event) => onPick("custom", from, event.target.value)}
                className="touch44 h-12 rounded-xl border border-slate-300 bg-white px-3 text-[16px]"
              />
            </div>
          </div>
        ) : (
          <p className="text-[13px] text-slate-600">
            Showing <strong className="font-semibold text-slate-800">{formatDateRange(from, to)}</strong>{" "}
            for Invoiced and Collected.
          </p>
        )}
      </div>
      <p className="mt-2 text-[13px] text-slate-600">
        Outstanding and Overdue are <strong className="font-semibold">as of now</strong> and ignore this
        range. Invoiced and Collected are separate numbers — they are never added together.
      </p>
    </div>
  );
}

function AlertStrip({ alerts }: { alerts: OwnerDashboard["alerts"] }) {
  if (alerts.length === 0) return null;
  const tone = (severity: OwnerDashboard["alerts"][number]["severity"]) =>
    severity === "critical" ? "danger" : severity === "warning" ? "warning" : "info";
  return (
    <div className="mb-4 space-y-2" aria-label="Alerts">
      {alerts.map((alert) => (
        <InlineAlert
          key={alert.code}
          tone={tone(alert.severity)}
          title={alert.severity === "critical" ? "Needs attention" : undefined}
          action={
            alert.link ? (
              <Link
                href={alert.link}
                className="inline-flex min-h-[44px] items-center font-semibold underline underline-offset-2"
              >
                Open
              </Link>
            ) : undefined
          }
        >
          {alert.message}
        </InlineAlert>
      ))}
    </div>
  );
}

function OwnerView({
  data,
  now,
  messaging,
  messagingLoading,
}: {
  data: OwnerDashboard;
  now: string;
  messaging?: Awaited<ReturnType<typeof msg06GetMessagingStatus>>;
  messagingLoading: boolean;
}) {
  const attendance = data.sessions.todayAttendance;
  const masterPaused = messaging ? !messaging.automationEnabled : false;
  // The contract exposes no "invoices carrying a balance" count, so the overdue
  // count is used as the honest lower bound for the R-20 warning — every overdue
  // invoice certainly still carries a balance.
  const warning = messaging
    ? automationWarning(messaging.automations, masterPaused, data.money.overdueCount)
    : null;
  const maxGroup = Math.max(1, ...data.players.byGroup.map((g) => g.count));

  return (
    <div>
      <AlertStrip alerts={data.alerts} />

      <section aria-label="Money" className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <MoneyCard
          label="Invoiced"
          value={data.money.invoicedMinor}
          sub={`${data.money.invoicesIssuedCount} invoice${data.money.invoicesIssuedCount === 1 ? "" : "s"} issued in the period`}
          href="/billing"
        />
        <MoneyCard
          label="Collected"
          value={data.money.collectedMinor}
          sub="confirmed payments received in the period"
          href="/payments"
        />
        <MoneyCard
          label="Outstanding"
          value={data.money.outstandingMinor}
          sub="unpaid balances · as of now"
          href="/billing?outstanding=true"
        />
        <MoneyCard
          label="Overdue"
          value={data.money.overdueMinor}
          sub={`${data.money.overdueCount} invoice${data.money.overdueCount === 1 ? "" : "s"} past the due date · as of now`}
          href="/billing?overdue=true"
          tone="danger"
        />
      </section>

      <div className="mt-3 grid grid-cols-2 gap-3">
        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-card">
          <p className="text-[12px] font-semibold uppercase tracking-wide text-slate-500">
            Due in next {data.money.dueSoon.days} days
          </p>
          <p className="tabular mt-1 font-heading text-lg font-bold text-slate-900">
            <MoneyCell minor={data.money.dueSoon.totalMinor} />
          </p>
          <p className="mt-1 text-[13px] text-slate-600">
            {data.money.dueSoon.count} invoice{data.money.dueSoon.count === 1 ? "" : "s"} coming due
          </p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-card">
          <p className="text-[12px] font-semibold uppercase tracking-wide text-slate-500">
            Credit held
          </p>
          <p className="tabular mt-1 font-heading text-lg font-bold text-slate-900">
            <MoneyCell minor={data.money.creditHeldMinor} />
          </p>
          <p className="mt-1 text-[13px] text-slate-600">
            unallocated payments — not income until applied
          </p>
        </div>
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        <section
          aria-label="Players"
          className="rounded-2xl border border-slate-200 bg-white shadow-card"
        >
          <SectionTitle
            right={
              <Link
                href="/players"
                className="text-[13px] font-semibold text-pitch-700 underline underline-offset-2"
              >
                All players
              </Link>
            }
          >
            Players
          </SectionTitle>
          <div className="p-4">
            <p className="tabular font-heading text-2xl font-bold text-slate-900">
              {data.players.active}
            </p>
            <p className="text-[13px] text-slate-600">
              active · {data.players.inactive} inactive · {data.players.withdrawn} withdrawn
            </p>
            {data.players.byGroup.length === 0 ? (
              <p className="mt-3 text-[14px] text-slate-600">No age groups yet.</p>
            ) : (
              <ul className="mt-3 space-y-2">
                {data.players.byGroup.map((group) => (
                  <li key={group.ageGroupId}>
                    <Link
                      href={`/players?ageGroupId=${encodeURIComponent(group.ageGroupId)}`}
                      className="touch44 flex min-h-[44px] items-center gap-3 rounded-lg px-1 hover:bg-slate-50"
                    >
                      <span className="w-24 shrink-0 truncate text-[14px] font-medium text-slate-700">
                        {group.name}
                      </span>
                      <span
                        aria-hidden="true"
                        className="h-2.5 flex-1 overflow-hidden rounded-full bg-slate-100"
                      >
                        <span
                          className="block h-full rounded-full bg-pitch-500"
                          style={{ width: `${Math.round((group.count / maxGroup) * 100)}%` }}
                        />
                      </span>
                      <span className="tabular w-10 shrink-0 text-right text-[14px] font-semibold text-slate-900">
                        {group.count}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        <section
          aria-label="Today's sessions"
          className="rounded-2xl border border-slate-200 bg-white shadow-card"
        >
          <SectionTitle
            right={
              <span className="text-[13px] text-slate-600">
                {attendance.unmarked} unmarked today
              </span>
            }
          >
            Today&apos;s sessions
          </SectionTitle>
          {data.sessions.today.length === 0 ? (
            <EmptyState
              title="No session today"
              description="Sessions appear here on the day they run."
            />
          ) : (
            <ul className="divide-y divide-slate-100">
              {data.sessions.today.map((session) => (
                <SessionRow key={session.id} session={session} />
              ))}
            </ul>
          )}
          <p className="border-t border-slate-200 px-4 py-3 text-[13px] text-slate-600">
            Attendance today: {attendance.present} present · {attendance.late} late ·{" "}
            {attendance.absent} absent · {attendance.excused} excused ·{" "}
            <strong className="font-semibold">{attendance.unmarked} unmarked</strong>
          </p>
        </section>
      </div>

      <section
        aria-label="Coaches today"
        className="mt-4 rounded-2xl border border-slate-200 bg-white shadow-card"
      >
        <SectionTitle
          right={
            <Link
              href="/coach-attendance"
              className="text-[13px] font-semibold text-pitch-700 underline underline-offset-2"
            >
              Coach time
            </Link>
          }
        >
          Coaches today
        </SectionTitle>
        <div className="grid gap-4 p-4 sm:grid-cols-3">
          <div>
            <p className="text-[12px] font-semibold uppercase tracking-wide text-slate-500">
              Checked in now
            </p>
            <p className="tabular mt-1 font-heading text-2xl font-bold text-slate-900">
              {data.coachTime.checkedInNow.length}
            </p>
          </div>
          <div>
            <p className="text-[12px] font-semibold uppercase tracking-wide text-slate-500">
              Today&apos;s coach hours
            </p>
            <p className="tabular mt-1 font-heading text-2xl font-bold text-slate-900">
              {formatDuration(data.coachTime.todayMinutes)}
            </p>
          </div>
          <div>
            <p className="text-[12px] font-semibold uppercase tracking-wide text-slate-500">
              This week
            </p>
            <p className="tabular mt-1 font-heading text-2xl font-bold text-slate-900">
              {formatDuration(data.coachTime.weekMinutes)}
            </p>
          </div>
        </div>
        {data.coachTime.checkedInNow.length === 0 ? (
          <p className="border-t border-slate-200 px-4 py-4 text-[14px] text-slate-600">
            No coach is clocked in right now
          </p>
        ) : (
          <ul className="divide-y divide-slate-100 border-t border-slate-200">
            {data.coachTime.checkedInNow.map((row) => (
              <li
                key={`${row.coach.id}-${row.session.id}`}
                className="flex flex-wrap items-center justify-between gap-2 px-4 py-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-[15px] font-semibold text-slate-900">
                    {row.coach.fullName}
                  </p>
                  <p className="text-[13px] text-slate-600">
                    {row.session.ageGroupName} · checked in {academyTime(row.checkInAt)}
                  </p>
                </div>
                <span className="tabular shrink-0 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-[13px] font-semibold text-emerald-800">
                  {formatDuration(minutesBetween(row.checkInAt, now))} elapsed
                </span>
              </li>
            ))}
          </ul>
        )}
        {data.coachTime.openNeedingCorrection > 0 ? (
          <p className="border-t border-slate-200 px-4 py-3 text-[13px] text-amber-800">
            <Clock className="mr-1 inline h-4 w-4" aria-hidden="true" />
            {data.coachTime.openNeedingCorrection} open check-in
            {data.coachTime.openNeedingCorrection === 1 ? "" : "s"} need correction —{" "}
            <Link href="/coach-attendance" className="font-semibold underline underline-offset-2">
              review them
            </Link>
          </p>
        ) : null}
        <p className="border-t border-slate-200 px-4 py-3 text-[13px] text-slate-600">
          Hours are counted from closed check-ins only. Check-ins are self-reported and
          server-timestamped; they don&apos;t prove physical presence.
        </p>
      </section>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <section
          aria-label="Upcoming sessions"
          className="rounded-2xl border border-slate-200 bg-white shadow-card"
        >
          <SectionTitle
            right={
              <Link
                href="/sessions"
                className="text-[13px] font-semibold text-pitch-700 underline underline-offset-2"
              >
                All sessions
              </Link>
            }
          >
            Next 7 days
          </SectionTitle>
          {data.sessions.next7Days.length === 0 ? (
            <EmptyState
              title="Nothing scheduled"
              description="No sessions in the next seven days."
            />
          ) : (
            <ul className="divide-y divide-slate-100">
              {data.sessions.next7Days.map((session) => (
                <SessionRow key={session.id} session={session} showDate />
              ))}
            </ul>
          )}
        </section>

        <section
          aria-label="Messaging"
          className="rounded-2xl border border-slate-200 bg-white shadow-card"
        >
          <SectionTitle
            right={
              <Link
                href="/whatsapp"
                className="text-[13px] font-semibold text-pitch-700 underline underline-offset-2"
              >
                Open WhatsApp
              </Link>
            }
          >
            Messaging
          </SectionTitle>
          <div className="p-4">
            {messagingLoading ? (
              <ListSkeleton rows={2} />
            ) : messaging ? (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <StatusChip status={sessionStatusTone(messaging.session.status)} />
                  <span className="text-[14px] text-slate-700">
                    {sessionStatusLabel(messaging.session.status)}
                  </span>
                  <span className="text-[13px] text-slate-500">
                    · automation {automationStateLine(
                      messaging.automationEnabled,
                      masterPaused,
                      messaging.session.status
                    )}
                  </span>
                </div>
                <dl className="mt-3 grid grid-cols-3 gap-3 text-[14px]">
                  <div>
                    <dt className="text-[12px] font-semibold uppercase tracking-wide text-slate-500">
                      Failed (24 h)
                    </dt>
                    <dd className="tabular font-semibold text-slate-900">
                      {messaging.queue.failedLast24h}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[12px] font-semibold uppercase tracking-wide text-slate-500">
                      Failed permanently
                    </dt>
                    <dd className="tabular font-semibold text-slate-900">{messaging.queue.dead}</dd>
                  </div>
                  <div>
                    <dt className="text-[12px] font-semibold uppercase tracking-wide text-slate-500">
                      Needs review
                    </dt>
                    <dd className="tabular font-semibold text-slate-900">
                      {messaging.queue.needsReview}
                    </dd>
                  </div>
                </dl>
                {messaging.session.status !== "connected" ? (
                  <div className="mt-3">
                    <InlineAlert tone="warning">
                      WhatsApp shows <em>{sessionStatusLabel(messaging.session.status)}</em> — reminders
                      stay queued until it reconnects.
                    </InlineAlert>
                  </div>
                ) : null}
                {warning ? (
                  <div className="mt-3">
                    <InlineAlert tone="warning">{warning}</InlineAlert>
                  </div>
                ) : null}
                <p className="mt-3 text-[13px] text-slate-500">
                  Unofficial WhatsApp automation via a reverse-engineered client — delivery isn&apos;t
                  guaranteed.
                </p>
              </>
            ) : (
              <p className="text-[14px] text-slate-600">
                Messaging status is unavailable right now.{" "}
                <Link href="/whatsapp" className="font-semibold underline underline-offset-2">
                  Open WhatsApp
                </Link>{" "}
                to retry.
              </p>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

/** Money is rendered through the strict formatter — never a float, never a sum. */
function MoneyCell({ minor }: { minor: number }) {
  return <>{formatMoneyMinor(minor)}</>;
}

function MoneyCard({
  label,
  value,
  sub,
  href,
  tone,
}: {
  label: string;
  value: number;
  sub: string;
  href: string;
  tone?: "danger";
}) {
  return (
    <Link
      href={href}
      className="rounded-2xl border border-slate-200 bg-white p-4 shadow-card transition-shadow hover:shadow-pop"
    >
      <p className="text-[12px] font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <p
        className={`tabular mt-1 font-heading text-xl font-bold ${
          tone === "danger" ? "text-red-700" : "text-slate-900"
        }`}
      >
        <MoneyCell minor={value} />
      </p>
      <p className="mt-1 text-[13px] text-slate-600">{sub}</p>
    </Link>
  );
}

function SessionRow({ session, showDate }: { session: Session; showDate?: boolean }) {
  const unmarked = session.attendanceSummary?.unmarked ?? 0;
  return (
    <li>
      <Link
        href={`/sessions/${session.id}`}
        className="touch44 flex min-h-[44px] flex-wrap items-center justify-between gap-3 px-4 py-3 hover:bg-slate-50"
      >
        <div className="min-w-0">
          <p className="truncate text-[15px] font-semibold text-slate-900">
            {session.ageGroup.name}
          </p>
          <p className="text-[13px] text-slate-600">
            {showDate ? `${formatDateStr(session.sessionDate)} · ` : ""}
            {academyTime(session.startsAt)}
            {session.venue ? ` · ${session.venue}` : ""}
            {session.leadCoach ? ` · ${session.leadCoach.fullName}` : ""}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {session.status === "cancelled" ? (
            <StatusChip status="Cancelled" />
          ) : (
            <>
              {unmarked > 0 ? (
                <span className="rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-[12px] font-semibold text-amber-800">
                  {unmarked} unmarked
                </span>
              ) : (
                <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[12px] font-semibold text-emerald-800">
                  Attendance saved
                </span>
              )}
              <ArrowRight className="h-4 w-4 text-slate-400" aria-hidden="true" />
            </>
          )}
        </div>
      </Link>
    </li>
  );
}

// --- coach ------------------------------------------------------------------

function CoachView({
  data,
  now,
  onChanged,
}: {
  data: CoachDashboard;
  now: string;
  onChanged: (message: string) => void;
}) {
  const [actionError, setActionError] = useState<string | null>(null);
  const open = data.myOpenCheckIn;

  const checkIn = useMutation({
    mutationFn: (sessionId: string) => cat01CheckIn({ sessionId }),
    onSuccess: () => {
      setActionError(null);
      onChanged("Checked in — the time is the server's.");
    },
    onError: (error) => {
      setActionError(
        error instanceof ApiError
          ? error.message
          : "Could not check in. Please try again."
      );
    },
  });

  const checkOut = useMutation({
    mutationFn: (sessionId: string) => cat02CheckOut({ sessionId }),
    onSuccess: () => {
      setActionError(null);
      onChanged("Checked out — your hours are updated.");
    },
    onError: (error) => {
      setActionError(
        error instanceof ApiError
          ? error.message
          : "Could not check out. Please try again."
      );
    },
  });

  const busy = checkIn.isPending || checkOut.isPending;
  const elapsed = open ? minutesBetween(open.checkInAt, now) : 0;

  return (
    <div>
      {actionError ? (
        <div className="mb-4">
          <InlineAlert tone="danger" title="That didn't go through">
            {actionError}
          </InlineAlert>
        </div>
      ) : null}

      <section aria-label="Your hours" className="mb-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-card">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-[12px] font-semibold uppercase tracking-wide text-slate-500">
              Your hours this week
            </p>
            <p className="tabular mt-1 font-heading text-2xl font-bold text-slate-900">
              {formatDuration(data.myWeekMinutes)}
            </p>
          </div>
          {open ? (
            <div className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-[14px] text-emerald-900">
              <Timer className="h-4 w-4" aria-hidden="true" />
              Checked in {academyTime(open.checkInAt)} ·{" "}
              <span className="tabular font-semibold">{formatDuration(elapsed)}</span>
            </div>
          ) : (
            <p className="text-[14px] text-slate-600">Not checked in right now.</p>
          )}
        </div>
        <p className="mt-2 text-[13px] text-slate-600">
          Only closed check-ins count as worked hours. Times are the server&apos;s, in the
          academy timezone.
        </p>
      </section>

      <section aria-label="Today's sessions" className="space-y-3">
        <h2 className="font-heading text-[16px] font-semibold text-slate-900">Today</h2>
        {data.todaySessions.length === 0 ? (
          <div className="rounded-2xl border border-slate-200 bg-white shadow-card">
            <EmptyState
              title="No session today"
              description="Enjoy the rest day — your next sessions are below."
            />
          </div>
        ) : (
          data.todaySessions.map((session) => {
            const isOpenHere = open?.session.id === session.id;
            const cancelled = session.status === "cancelled";
            const unmarked = session.attendanceSummary?.unmarked ?? 0;
            return (
              <article
                key={session.id}
                className="rounded-2xl border border-slate-200 bg-white p-4 shadow-card"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="truncate font-heading text-[17px] font-semibold text-slate-900">
                      {session.ageGroup.name}
                    </h3>
                    <p className="mt-0.5 text-[14px] text-slate-600">
                      {academyTime(session.startsAt)}–{academyTime(session.endsAt)}
                      {session.venue ? ` · ${session.venue}` : ""}
                    </p>
                  </div>
                  {cancelled ? (
                    <StatusChip status="Cancelled" />
                  ) : unmarked > 0 ? (
                    <span className="shrink-0 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-[12px] font-semibold text-amber-800">
                      {unmarked} unmarked
                    </span>
                  ) : null}
                </div>

                {cancelled ? (
                  <p className="mt-3 rounded-xl bg-slate-50 px-3 py-2 text-[13px] text-slate-700">
                    This session was cancelled
                    {session.cancelReason ? `: ${session.cancelReason}` : "."}
                  </p>
                ) : (
                  <div className="mt-3 space-y-2">
                    {/* One tap, thumb-side, no dialog: the action is reversible by
                        an owner correction, so confirming would only cost time. */}
                    {isOpenHere ? (
                      <Button
                        className="min-h-[48px] w-full"
                        variant="secondary"
                        pending={checkOut.isPending}
                        onClick={() => checkOut.mutate(session.id)}
                      >
                        <LogOut className="h-5 w-5" aria-hidden="true" />
                        Check out · {formatDuration(elapsed)} elapsed
                      </Button>
                    ) : (
                      <Button
                        className="min-h-[48px] w-full"
                        disabled={busy || Boolean(open)}
                        pending={checkIn.isPending}
                        onClick={() => checkIn.mutate(session.id)}
                      >
                        <LogIn className="h-5 w-5" aria-hidden="true" />
                        Check in
                      </Button>
                    )}
                    {!isOpenHere && open ? (
                      <p className="text-[13px] text-slate-600">
                        You are checked in on {open.session.ageGroupName} — check out there first.
                      </p>
                    ) : null}
                    <Link
                      href={`/sessions/${session.id}`}
                      className="touch44 inline-flex min-h-[48px] w-full items-center justify-center gap-2 rounded-xl border border-slate-300 bg-white px-4 text-[15px] font-semibold text-slate-800 hover:bg-slate-50"
                    >
                      <CalendarCheck className="h-5 w-5" aria-hidden="true" />
                      Take attendance
                    </Link>
                  </div>
                )}
              </article>
            );
          })
        )}
      </section>

      <section aria-label="Upcoming sessions" className="mt-5">
        <h2 className="font-heading text-[16px] font-semibold text-slate-900">Coming up</h2>
        <div className="mt-3 rounded-2xl border border-slate-200 bg-white shadow-card">
          {data.upcoming.length === 0 ? (
            <EmptyState
              title="Nothing coming up"
              description="No further sessions are scheduled for your groups."
            />
          ) : (
            <ul className="divide-y divide-slate-100">
              {data.upcoming.map((session) => (
                <li key={session.id}>
                  <Link
                    href={`/sessions/${session.id}`}
                    className="touch44 flex min-h-[56px] items-center justify-between gap-3 px-4 py-3 hover:bg-slate-50"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-[15px] font-semibold text-slate-900">
                        {session.ageGroup.name}
                      </span>
                      <span className="block text-[13px] text-slate-600">
                        {formatDateStr(session.sessionDate)} · {academyTime(session.startsAt)}
                        {session.venue ? ` · ${session.venue}` : ""}
                      </span>
                    </span>
                    <ArrowRight className="h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <p className="mt-4 flex items-start gap-2 text-[13px] text-slate-600">
        <MessageCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        Players and groups you are not assigned to are not shown — the API scopes them.
      </p>
      <p className="mt-1 flex items-start gap-2 text-[13px] text-slate-600">
        <Users className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        Wrong something? Ask an owner — balance and payment information is not available to
        coaches.
      </p>
      <p className="mt-1 flex items-start gap-2 text-[13px] text-slate-600">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        Check-ins are self-reported and server-timestamped; they don&apos;t prove physical
        presence.
      </p>
      <p className="mt-1 flex items-start gap-2 text-[13px] text-slate-600">
        <Clock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        Something missing?{" "}
        <Link href="/coach-attendance" className="font-semibold underline underline-offset-2">
          See your check-in log
        </Link>
        .
      </p>
    </div>
  );
}

export default function DashboardPage() {
  return (
    <RequireAuth>
      <Suspense
        fallback={
          <div aria-busy="true" aria-label="Loading">
            <div className="skeleton h-8 w-48 rounded-lg" />
            <div className="mt-4 grid grid-cols-2 gap-3 xl:grid-cols-4">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="skeleton h-28 rounded-2xl" />
              ))}
            </div>
          </div>
        }
      >
        <DashboardBody />
      </Suspense>
    </RequireAuth>
  );
}
