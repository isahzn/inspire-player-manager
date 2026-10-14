/**
 * DSH-01 — the owner dashboard (API_CONTRACTS §3.8, M8).
 *
 * This is the one page that has to be honest about money, so the two rules that shape it are
 * the project's own:
 *
 *  - **Invoiced ≠ collected.** They are separate fields derived from separate sources (issued
 *    invoices vs confirmed payments) and are never added together — not in a field, not in a
 *    total, not in an alert. `outstandingMinor`/`overdueMinor` are "as of now" and exclude
 *    void invoices; credit held on a payment is reported separately again.
 *  - **Coach time never touches money.** `coachTime` is derived from `coach_attendance` alone:
 *    a still-open shift is not time worked (T-ATT-11), so `todayMinutes`/`weekMinutes` count
 *    **closed** records only and an open record shows up in `checkedInNow` and, past 12 hours,
 *    in `openNeedingCorrection`.
 *
 * "Today", "this week" and the default `range` are computed **in SQL** from
 * `academy_settings.timezone` (`loadBillingContext` in `billing-engine.ts` uses the same idiom).
 * Computing them in Node would bill and report against the server's day, which is the bug that
 * puts the wrong date on an invoice whenever the process runs outside Colombo.
 *
 * The `messaging` block is deliberately thin. `message_jobs` does not exist until M7, so there
 * is no queue to count and no session state to read: the honest answer is zero failures out of
 * zero jobs and the `unknown` session label, with the switches read from `academy_settings`
 * (where they do exist, defaulting off). It is a real gap, recorded in the M8 handoff rather
 * than filled with a query against a table that is not there.
 */
import { z } from "zod";
import { config } from "../config.js";
import { formatMoney } from "../files/pdf/format.js";
import { asViewer } from "../http/context.js";
import type { Handler, HandlerResult } from "../http/router.js";
import { readSchedulerHealth } from "../ops/job-runs.js";
import { OwnerDashboard as OwnerDashboardSchema } from "../../spec/components.js";
import { SESSION_SELECT, withSummaries } from "./sessions.js";
import { serializeSession, type SessionRow } from "./attendance-serialize.js";

/** The contract's own type, derived from the schema so a field cannot drift from §3.8. */
type OwnerDashboardBody = z.infer<typeof OwnerDashboardSchema>;

/** The enrolled window the money and player blocks report against. Always concrete dates. */
interface AcademyContextRow {
  timezone: string;
  currency: string;
  today: string;
  from_date: string;
  to_date: string;
  messaging_automation_enabled: boolean;
  messaging_automation_invoice_delivery: boolean;
  messaging_automation_reminder_pre_due: boolean;
  messaging_automation_reminder_overdue: boolean;
  messaging_automation_proof_check: boolean;
}

interface PlayerCountsRow {
  active: number;
  inactive: number;
  withdrawn: number;
}

interface GroupCountRow {
  age_group_id: string;
  name: string;
  count: number;
}

interface OpenCheckInRow {
  coach_user_id: string;
  coach_name: string;
  session_id: string;
  age_group_name: string;
  starts_at: Date;
  check_in_at: Date;
  elapsed_minutes: number;
}

interface CoachMinutesRow {
  today_minutes: number;
  week_minutes: number;
  open_needing_correction: number;
}

interface MoneyRow {
  invoiced_minor: string;
  invoices_issued_count: number;
  collected_minor: string;
  outstanding_minor: string;
  overdue_minor: string;
  overdue_count: number;
  due_soon_count: number;
  due_soon_minor: string;
  credit_held_minor: string;
  pdf_missing_count: number;
}

/** How far ahead "due soon" looks (the contract's `dueSoon.days`). */
const DUE_SOON_DAYS = 7;
/** How long an open check-in may stay open before the owner is asked to correct it (T-ATT-11). */
const OPEN_CHECKIN_CORRECTION_HOURS = 12;

export const dsh01Owner: Handler = async ({ viewer, query }): Promise<HandlerResult> => {
  const { from, to } = query as { from?: string; to?: string };

  const body = await asViewer(viewer, async (client): Promise<OwnerDashboardBody> => {
    // One read of the academy row: the timezone, the currency, the messaging switches, and the
    // three date defaults resolved by the database's own clock in the academy's own zone.
    const contextResult = await client.query<AcademyContextRow>(
      `select a.timezone, a.currency,
              a.messaging_automation_enabled,
              a.messaging_automation_invoice_delivery,
              a.messaging_automation_reminder_pre_due,
              a.messaging_automation_reminder_overdue,
              a.messaging_automation_proof_check,
              (now() at time zone a.timezone)::date::text as today,
              coalesce($1::date,
                       date_trunc('month', (now() at time zone a.timezone))::date)::text as from_date,
              coalesce($2::date, (now() at time zone a.timezone)::date)::text as to_date
         from academy_settings a
        where a.id = 1`,
      [from ?? null, to ?? null],
    );
    const academy = contextResult.rows[0]!;
    const timezone = academy.timezone;
    const currency = academy.currency.trim();

    // --- players: the register as it stands now, not as the range sees it -------------------
    const counts = await client.query<PlayerCountsRow>(
      `select count(*) filter (where p.status = 'active')::int    as active,
              count(*) filter (where p.status = 'inactive')::int  as inactive,
              count(*) filter (where p.status = 'withdrawn')::int as withdrawn
         from players p
        where p.anonymized_at is null`,
    );
    const playerCounts = counts.rows[0] ?? { active: 0, inactive: 0, withdrawn: 0 };

    // The group a player holds **now** (`effective_to is null`), never a historical row: a
    // transfer must move the player between these bars exactly once.
    const byGroup = await client.query<GroupCountRow>(
      `select g.id as age_group_id, g.name, count(p.id)::int as count
         from age_groups g
         left join player_group_history h
                on h.age_group_id = g.id and h.effective_to is null
         left join players p on p.id = h.player_id and p.anonymized_at is null
        where g.archived_at is null
        group by g.id, g.name, g.sort_order
        order by g.sort_order asc, g.name asc`,
    );

    // --- coach time: `coach_attendance` only, never a fee or a balance -----------------------
    const openCheckIns = await client.query<OpenCheckInRow>(
      `select c.coach_user_id, u.full_name as coach_name, c.session_id,
              g.name as age_group_name, s.starts_at, c.check_in_at,
              floor(extract(epoch from (now() - c.check_in_at)) / 60)::int as elapsed_minutes
         from coach_attendance c
         join users u on u.id = c.coach_user_id
         join sessions s on s.id = c.session_id
         join age_groups g on g.id = s.age_group_id
        where c.check_out_at is null
        order by c.check_in_at asc, c.id asc`,
    );

    // Closed records only (T-ATT-11): `filter (where check_out_at is not null)` is what keeps a
    // shift that is still running out of the worked-time totals. The week is the academy's own,
    // Monday-based, and both windows are measured on the check-in's **local** date.
    const coachMinutes = await client.query<CoachMinutesRow>(
      `select
         coalesce(sum(extract(epoch from (c.check_out_at - c.check_in_at)) / 60)
                  filter (where c.check_out_at is not null
                            and (c.check_in_at at time zone $1)::date
                                = (now() at time zone $1)::date), 0)::int as today_minutes,
         coalesce(sum(extract(epoch from (c.check_out_at - c.check_in_at)) / 60)
                  filter (where c.check_out_at is not null
                            and (c.check_in_at at time zone $1)::date
                                >= date_trunc('week', (now() at time zone $1))::date), 0)::int
           as week_minutes,
         count(*) filter (where c.check_out_at is null
                            and c.check_in_at < now() - ($2::int * interval '1 hour'))::int
           as open_needing_correction
       from coach_attendance c`,
      [timezone, OPEN_CHECKIN_CORRECTION_HOURS],
    );
    const coach = coachMinutes.rows[0] ?? {
      today_minutes: 0,
      week_minutes: 0,
      open_needing_correction: 0,
    };

    // --- sessions: today and the coming week -------------------------------------------------
    const todaySessions = await client.query<SessionRow>(
      `${SESSION_SELECT}
        where s.session_date = $1::date
        order by s.starts_at asc, s.id asc`,
      [academy.today],
    );
    const upcomingSessions = await client.query<SessionRow>(
      `${SESSION_SELECT}
        where s.session_date > $1::date and s.session_date <= $1::date + 7
        order by s.starts_at asc, s.id asc`,
      [academy.today],
    );
    const [todayWithSummaries, upcomingWithSummaries] = [
      await withSummaries(client, todaySessions.rows),
      await withSummaries(client, upcomingSessions.rows),
    ];

    // The day's attendance tally, summed over the sessions above. A session nobody has marked
    // yet contributes its whole roster to `unmarked`, which is the number the owner acts on.
    const todayAttendance = { present: 0, absent: 0, late: 0, excused: 0, unmarked: 0 };
    for (const { summary } of todayWithSummaries) {
      if (!summary) continue;
      todayAttendance.present += summary.present;
      todayAttendance.absent += summary.absent;
      todayAttendance.late += summary.late;
      todayAttendance.excused += summary.excused;
      todayAttendance.unmarked += summary.unmarked;
    }

    // --- money ------------------------------------------------------------------------------
    // Every figure is an aggregate over rows in the caller's own RLS-scoped transaction, so a
    // coach could not read them even if the permission guard were wrong (there is no coach
    // policy on any money table).
    const moneyResult = await client.query<MoneyRow>(
      `select
         coalesce((select sum(i.total_minor) from invoices i
                    where i.status <> 'void'
                      and i.issue_date between $1::date and $2::date), 0)::text
           as invoiced_minor,
         (select count(*) from invoices i
           where i.status <> 'void'
             and i.issue_date between $1::date and $2::date)::int
           as invoices_issued_count,
         -- Collected is confirmed payments **received** in the range, on the academy's day.
         coalesce((select sum(p.amount_minor) from payments p
                    where p.status = 'confirmed'
                      and (p.received_at at time zone $3)::date between $1::date and $2::date),
                  0)::text
           as collected_minor,
         coalesce((select sum(i.balance_minor) from invoices i
                    where i.status in ('issued','partially_paid')), 0)::text
           as outstanding_minor,
         coalesce((select sum(i.balance_minor) from invoices i
                    where i.status in ('issued','partially_paid')
                      and i.due_date < $4::date), 0)::text
           as overdue_minor,
         (select count(*) from invoices i
           where i.status in ('issued','partially_paid')
             and i.due_date < $4::date)::int
           as overdue_count,
         (select count(*) from invoices i
           where i.status in ('issued','partially_paid')
             and i.balance_minor > 0
             and i.due_date between $4::date and $4::date + $5::int)::int
           as due_soon_count,
         coalesce((select sum(i.balance_minor) from invoices i
                    where i.status in ('issued','partially_paid')
                      and i.balance_minor > 0
                      and i.due_date between $4::date and $4::date + $5::int), 0)::text
           as due_soon_minor,
         -- Credit held on confirmed payments that no invoice is holding (OPEN-007: never
         -- auto-applied, so it is reported on its own rather than netted off anything).
         coalesce((select sum(p.amount_minor - p.allocated_minor) from payments p
                    where p.status = 'confirmed'
                      and p.allocated_minor < p.amount_minor), 0)::text
           as credit_held_minor,
         (select count(*) from invoices i
           where i.status <> 'void' and i.pdf_file_id is null)::int
           as pdf_missing_count`,
      [academy.from_date, academy.to_date, timezone, academy.today, DUE_SOON_DAYS],
    );
    const money = moneyResult.rows[0]!;

    // --- the worker's own state, for the alert strip ----------------------------------------
    const scheduler = await readSchedulerHealth(client, {
      staleMinutes: config.worker.heartbeatStaleMinutes,
    });

    // --- alerts: only conditions actually evaluated above -----------------------------------
    const overdueMinor = money.overdue_minor;
    const alerts: OwnerDashboardBody["alerts"] = [];
    if (scheduler.stale) {
      alerts.push({
        code: "WORKER_STALE",
        severity: "critical",
        message:
          `${scheduler.detail} The daily billing run, the PDF sweeper and the backup job do ` +
          "not run without it.",
        link: "/system",
      });
    }
    if (money.overdue_count > 0) {
      alerts.push({
        code: "OVERDUE_INVOICES",
        severity: "warning",
        message:
          `${money.overdue_count} invoice(s) totalling ` +
          `${formatMoney(overdueMinor, currency)} are past their due date.`,
      });
    }
    if (coach.open_needing_correction > 0) {
      alerts.push({
        code: "COACH_CHECKIN_OPEN",
        severity: "warning",
        message:
          `${coach.open_needing_correction} coach check-in(s) have been open for more than ` +
          `${OPEN_CHECKIN_CORRECTION_HOURS} hours. Correct them so the recorded time is real.`,
      });
    }
    if (money.pdf_missing_count > 0) {
      alerts.push({
        code: "PDF_MISSING",
        severity: "info",
        message:
          `${money.pdf_missing_count} invoice(s) have no PDF yet; the background sweeper ` +
          "generates them, and the guardian's link answers 404 until it has.",
      });
    }

    return {
      range: { from: academy.from_date, to: academy.to_date },
      players: {
        active: playerCounts.active,
        inactive: playerCounts.inactive,
        withdrawn: playerCounts.withdrawn,
        byGroup: byGroup.rows.map((row) => ({
          ageGroupId: row.age_group_id,
          name: row.name,
          count: row.count,
        })),
      },
      coachTime: {
        checkedInNow: openCheckIns.rows.map((row) => ({
          coach: { id: row.coach_user_id, fullName: row.coach_name },
          session: {
            id: row.session_id,
            ageGroupName: row.age_group_name,
            startsAt: row.starts_at.toISOString(),
          },
          checkInAt: row.check_in_at.toISOString(),
          elapsedMinutes: row.elapsed_minutes,
        })),
        todayMinutes: coach.today_minutes,
        weekMinutes: coach.week_minutes,
        openNeedingCorrection: coach.open_needing_correction,
      },
      sessions: {
        today: todayWithSummaries.map(({ row, summary }) => serializeSession(row, summary)),
        next7Days: upcomingWithSummaries.map(({ row, summary }) => serializeSession(row, summary)),
        todayAttendance,
      },
      money: {
        invoicedMinor: Number(money.invoiced_minor),
        invoicesIssuedCount: money.invoices_issued_count,
        collectedMinor: Number(money.collected_minor),
        outstandingMinor: Number(money.outstanding_minor),
        overdueMinor: Number(overdueMinor),
        overdueCount: money.overdue_count,
        dueSoon: {
          days: DUE_SOON_DAYS,
          count: money.due_soon_count,
          totalMinor: Number(money.due_soon_minor),
        },
        creditHeldMinor: Number(money.credit_held_minor),
      },
      messaging: {
        automationEnabled: academy.messaging_automation_enabled,
        automations: {
          invoiceDelivery: academy.messaging_automation_invoice_delivery,
          reminderPreDue: academy.messaging_automation_reminder_pre_due,
          reminderOverdue: academy.messaging_automation_reminder_overdue,
          proofCheck: academy.messaging_automation_proof_check,
        },
        // M7 owns the provider and the queue. Until `message_jobs` exists there is nothing to
        // count, so "no failures out of no jobs" is the true answer and the session label is
        // `unknown` rather than a guessed OpenWA state (O18 is unverified until spike S1).
        sessionStatus: "unknown",
        failed24h: 0,
        dead: 0,
        needsReview: 0,
      },
      alerts,
    };
  });

  return { status: 200, body };
};
