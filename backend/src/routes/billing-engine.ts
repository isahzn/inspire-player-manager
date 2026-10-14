/**
 * The billing engine — periods, eligibility, fees and due dates (BILLING_ENGINE §2–§9).
 *
 * Three rules shape this file, and each one is a bug I would otherwise write later:
 *
 *  - **A billing period is a calendar fact, not an instant.** Every date here is an
 *    academy-local business date (`YYYY-MM-DD`); "today" comes from the database
 *    (`now() at time zone <academy tz>`), and the period arithmetic runs in SQL
 *    (`app.billing_period_start`/`_end`, 0012) so an anchored month clamps the way §3 says
 *    — 31 Jan → 28 Feb → 31 Mar, always measured from the anchor. Doing this in JS is how
 *    a server in another timezone bills the wrong month.
 *  - **The preview and the run are one computation.** BIL-02 recomputes the preview it was
 *    handed and compares `previewHash`; a fee change, a transfer or another run in between
 *    answers 409 `PREVIEW_STALE` instead of issuing invoices for a world that has moved
 *    (T-FIN-18). Nothing about the preview is stored.
 *  - **One period per player per run.** A player who is behind is caught up by later runs
 *    with an earlier `targetDate`, and the preview says how far behind they are (§4) rather
 *    than quietly issuing several invoices at once.
 *
 * Adjustments are the *owner's* refusal to prorate (§6): the engine never prorates and never
 * invents a fee — it reports the full fee and, for a mid-period join, warns that the full fee
 * applies unless an adjustment is added.
 */
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { loadAcademyBrand } from "./academy-brand.js";
import { uuidv7 } from "../ids.js";
import { nextDocumentNumber } from "./money-helpers.js";

export interface BillingConfig {
  frequency: "weekly" | "monthly";
  mode: "calendar" | "anchored";
  weekStartDay: number;
  timing: "period_start" | "period_end";
  dueRuleType: "days_after_issue" | "days_after_period_start" | "fixed_day_of_month";
  dueRuleValue: number;
  allowFractionalMoney: boolean;
  currency: string;
  timezone: string;
}

export interface BillingContext {
  config: BillingConfig;
  /** Academy-local today — the issue date of a run, never a UTC instant. */
  today: string;
}

export type BillingSkipReason =
  | "NO_GROUP"
  | "NO_FEE"
  | "NOT_ACTIVE"
  | "ALREADY_INVOICED"
  | "NOT_YET_REGISTERED";

export interface PreviewLine {
  playerId: string;
  playerName: string;
  registrationNo: string;
  ageGroup: { id: string; name: string };
  feeId: string;
  feeMinor: number;
  /** Omitted when the player has no guardian at all — the contract's `guardian?`. */
  guardian?: { id: string; fullName: string };
  /**
   * The guardian's number, written into the invoice's `snapshot` so the PDF's bill-to block
   * can print it (FILES_AND_PDF §2). It is a **separate** field rather than a member of
   * `guardian` because `guardian` is what the preview response already exposes, and adding a
   * phone number to it would silently widen that response (AUTH_AND_PERMISSIONS §4).
   */
  guardianPhone?: string | null;
  periodStart: string;
  periodEnd: string;
  issueDate: string;
  dueDate: string;
  warnings: string[];
}

export interface PreviewSkip {
  playerId: string;
  playerName: string;
  reason: BillingSkipReason;
}

export interface BillingPreview {
  targetDate: string;
  issueDate: string;
  config: BillingConfig;
  lines: PreviewLine[];
  skipped: PreviewSkip[];
}

export interface PreviewScope {
  targetDate: string;
  ageGroupIds?: string[];
  playerIds?: string[];
}

/**
 * The academy's billing configuration **and** its local today, in one round trip.
 *
 * `academy_settings` carries FORCE ROW LEVEL SECURITY with an owner-only policy, which is
 * exactly right here: the whole billing surface is owner-only, so it is read through the
 * caller's own transaction and no SECURITY DEFINER door is needed.
 */
export async function loadBillingContext(client: PoolClient): Promise<BillingContext> {
  const result = await client.query<{
    timezone: string;
    currency: string;
    billing_frequency: BillingConfig["frequency"];
    billing_period_mode: BillingConfig["mode"];
    week_start_day: number;
    invoice_issue_timing: BillingConfig["timing"];
    due_rule_type: BillingConfig["dueRuleType"];
    due_rule_value: number;
    allow_fractional_money: boolean;
    today: string;
  }>(
    `select timezone, currency, billing_frequency, billing_period_mode, week_start_day,
            invoice_issue_timing, due_rule_type, due_rule_value, allow_fractional_money,
            (now() at time zone timezone)::date::text as today
       from academy_settings where id = 1`,
  );
  const row = result.rows[0];
  if (!row) throw new Error("academy_settings row 1 is missing");
  return {
    today: row.today,
    config: {
      frequency: row.billing_frequency,
      mode: row.billing_period_mode,
      weekStartDay: row.week_start_day,
      timing: row.invoice_issue_timing,
      dueRuleType: row.due_rule_type,
      dueRuleValue: row.due_rule_value,
      allowFractionalMoney: row.allow_fractional_money,
      currency: row.currency.trim(),
      timezone: row.timezone,
    },
  };
}

interface PreviewRow {
  player_id: string;
  player_name: string;
  registration_no: string;
  period_start: string;
  period_end: string;
  reference_date: string;
  registration_date: string;
  status_active: boolean;
  registered: boolean;
  age_group_id: string | null;
  age_group_name: string | null;
  fee_id: string | null;
  fee_minor: string | null;
  guardian_id: string | null;
  guardian_name: string | null;
  /** Printed on the invoice PDF's bill-to block (FILES_AND_PDF §2). */
  guardian_phone: string | null;
  existing_invoice_id: string | null;
  missed_periods: number;
  due_date: string;
}

/**
 * Everything a run would do at `targetDate`, with nothing stored.
 *
 * One query resolves the period, the reference date, the group, the fee and the duplicate
 * check per player; the eligibility order is BILLING_ENGINE §4's, so the *first* reason a
 * player is skipped is the reason reported (`NOT_ACTIVE` before `NOT_YET_REGISTERED` before
 * `NO_GROUP` before `NO_FEE` before `ALREADY_INVOICED`). One skipped player never blocks the
 * run — that is why skips are data, not errors.
 */
export async function buildPreview(
  client: PoolClient,
  ctx: BillingContext,
  scope: PreviewScope,
): Promise<BillingPreview> {
  const { config } = ctx;
  const scopePlayerIds = scope.playerIds?.length ? scope.playerIds : null;
  const scopeGroupIds = scope.ageGroupIds?.length ? scope.ageGroupIds : null;

  const result = await client.query<PreviewRow>(
    `with cfg as (
       select $1::text as frequency, $2::text as mode, $3::smallint as week_start,
              $4::text as timing, $5::date as target, $8::text as due_rule,
              $9::smallint as due_value, $10::date as issue_date
     ),
     scope as (
       select p.id, p.full_name, p.registration_no, p.registration_date, p.billing_anchor_date,
              p.status, p.status_effective_date
         from players p
        where $6::uuid[] is null or p.id = any ($6::uuid[])
     ),
     -- The period containing the target, then the one before it when the academy issues in
     -- arrears: "the period that ended most recently before T" is the period preceding the
     -- one that contains T, which is why it is reached through that period's own start.
     chosen as (
       select s.*,
              case when cfg.timing = 'period_start' then containing.start_date
                   else app.billing_period_start(s.billing_anchor_date, containing.start_date - 1,
                                                 cfg.frequency, cfg.mode, cfg.week_start)
              end as period_start
         from scope s
         cross join cfg
         cross join lateral (
           select app.billing_period_start(s.billing_anchor_date, cfg.target, cfg.frequency,
                                           cfg.mode, cfg.week_start) as start_date
         ) containing
     ),
     resolved as (
       select c.*,
              app.billing_period_end(c.billing_anchor_date, c.period_start, cfg.frequency,
                                     cfg.mode, cfg.week_start) as period_end,
              greatest(c.period_start, c.registration_date) as reference_date
         from chosen c
         cross join cfg
     )
     select r.id as player_id, r.full_name as player_name, r.registration_no,
            r.period_start::text as period_start, r.period_end::text as period_end,
            r.reference_date::text as reference_date,
            r.registration_date::text as registration_date,
            -- "Active on the period's first day", the same convention the attendance roster
            -- uses: a status change effective on or before that day is what removes a player.
            (r.status = 'active' or r.status_effective_date > r.period_start) as status_active,
            (r.registration_date <= r.period_end) as registered,
            h.age_group_id, ag.name as age_group_name,
            f.id as fee_id, f.amount_minor::text as fee_minor,
            g.id as guardian_id, g.full_name as guardian_name,
            g.phone_e164 as guardian_phone,
            inv.id as existing_invoice_id,
            behind.missed as missed_periods,
            -- The due date (BILLING_ENGINE §5), with its final guard: never before the issue
            -- date. fixed_day_of_month is day D of the period's own month, which is why it is
            -- built from the period start rather than from today.
            greatest(
              case cfg.due_rule
                when 'days_after_issue' then cfg.issue_date + cfg.due_value
                when 'days_after_period_start' then r.period_start + cfg.due_value
                else (date_trunc('month', r.period_start)
                      + make_interval(days => cfg.due_value - 1))::date
              end,
              cfg.issue_date
            )::text as due_date
       from resolved r
       cross join cfg
       -- How far back the "behind by N" walk goes, and where the current period sits in the
       -- anchored sequence — both needed before the lateral that reads them.
       cross join lateral (
         select case
                  when cfg.frequency = 'monthly' and cfg.mode = 'anchored'
                    then app.billing_month_index(r.billing_anchor_date, r.period_start)
                  else 0
                end as n_cur,
                case
                  when cfg.frequency = 'monthly' and cfg.mode = 'anchored'
                    then greatest(0, app.billing_month_index(r.billing_anchor_date, r.period_start)
                                   - app.billing_month_index(r.billing_anchor_date, r.registration_date))
                  when cfg.frequency = 'monthly'
                    then greatest(0, (extract(year from r.period_start)::int * 12
                                      + extract(month from r.period_start)::int)
                                   - (extract(year from r.registration_date)::int * 12
                                      + extract(month from r.registration_date)::int))
                  else greatest(0, ((r.period_start - app.billing_period_start(
                        r.billing_anchor_date, r.registration_date, cfg.frequency, cfg.mode,
                        cfg.week_start)) / 7)::int)
                end as k_max
       ) lim
       -- The group held on the reference date (a transfer therefore bills the new group from
       -- the next period, §8) …
       left join lateral (
         select hh.age_group_id
           from player_group_history hh
          where hh.player_id = r.id
            and hh.effective_from <= r.reference_date
            and (hh.effective_to is null or hh.effective_to >= r.reference_date)
          limit 1
       ) h on true
       left join age_groups ag on ag.id = h.age_group_id
       -- … and the fee that group was charged on that same date: a fee change effective
       -- 1 December moves December's invoice and leaves November's snapshot alone (§4).
       left join lateral (
         select ff.id, ff.amount_minor
           from group_fees ff
          where ff.age_group_id = h.age_group_id
            and ff.effective_from <= r.reference_date
            and (ff.effective_to is null or ff.effective_to >= r.reference_date)
          limit 1
       ) f on true
       -- Who the invoice is billed to: the guardian who receives invoices, then the primary.
       left join lateral (
         select gg.id, gg.full_name, gg.phone_e164
           from player_guardians pg
           join guardians gg on gg.id = pg.guardian_id
          where pg.player_id = r.id
          order by pg.receives_invoices desc, pg.is_primary desc
          limit 1
       ) g on true
       -- The duplicate guard as a *read*: a non-void invoice, or a void one the owner asked
       -- not to reissue, already occupies this period (§9).
       left join lateral (
         select ii.id
           from invoices ii
          where ii.player_id = r.id
            and ii.period_start = r.period_start
            and ii.period_end = r.period_end
            and (ii.status <> 'void' or ii.suppress_reissue)
          limit 1
       ) inv on true
       -- "Behind by N periods" (§4): the periods immediately before this one, back to the
       -- player's first, that carry no invoice at all. The earlier starts are stepped in the
       -- period's own unit from the anchor, never by adding a month to a clamped start.
       left join lateral (
         select count(*)::int as missed
           from generate_series(1, greatest(0, lim.k_max)) k
           cross join lateral (
             select case
               when cfg.frequency = 'monthly' and cfg.mode = 'anchored'
                 then (r.billing_anchor_date + make_interval(months => lim.n_cur - k))::date
               when cfg.frequency = 'monthly'
                 -- Calendar periods start on the 1st, so stepping back by whole months is
                 -- exact here; the anchored case goes through the anchor instead.
                 then (r.period_start - make_interval(months => k))::date
               else r.period_start - (7 * k)
             end as ps
           ) earlier
          where not exists (
            select 1 from invoices i2
             where i2.player_id = r.id
               and i2.period_start = earlier.ps
               and (i2.status <> 'void' or i2.suppress_reissue)
          )
       ) behind on true
      where $7::uuid[] is null or h.age_group_id = any ($7::uuid[])
      order by r.full_name asc, r.id asc`,
    [
      config.frequency,
      config.mode,
      config.weekStartDay,
      config.timing,
      scope.targetDate,
      scopePlayerIds,
      scopeGroupIds,
      config.dueRuleType,
      config.dueRuleValue,
      ctx.today,
    ],
  );

  const lines: PreviewLine[] = [];
  const skipped: PreviewSkip[] = [];

  for (const row of result.rows) {
    const reason = skipReasonFor(row);
    if (reason) {
      skipped.push({
        playerId: row.player_id,
        playerName: row.player_name,
        reason,
      });
      continue;
    }

    const warnings: string[] = [];
    if (row.missed_periods > 0) {
      warnings.push(
        `Behind by ${row.missed_periods} period(s): earlier periods have no invoice. A later ` +
          "run with an earlier target date catches them up.",
      );
    }
    if (config.mode === "calendar" && row.registration_date > row.period_start) {
      warnings.push(
        `Registered ${row.registration_date}, part-way through this period — the full fee ` +
          "applies unless an adjustment is added to this run.",
      );
    }

    lines.push({
      playerId: row.player_id,
      playerName: row.player_name,
      registrationNo: row.registration_no,
      ageGroup: { id: row.age_group_id!, name: row.age_group_name! },
      feeId: row.fee_id!,
      feeMinor: Number(row.fee_minor),
      ...(row.guardian_id && row.guardian_name
        ? {
            guardian: { id: row.guardian_id, fullName: row.guardian_name },
            guardianPhone: row.guardian_phone ?? null,
          }
        : {}),
      periodStart: row.period_start,
      periodEnd: row.period_end,
      issueDate: ctx.today,
      dueDate: row.due_date,
      warnings,
    });
  }

  return { targetDate: scope.targetDate, issueDate: ctx.today, config, lines, skipped };
}

/** BILLING_ENGINE §4's eligibility, first failure wins. */
function skipReasonFor(row: PreviewRow): BillingSkipReason | null {
  if (!row.status_active) return "NOT_ACTIVE";
  if (!row.registered) return "NOT_YET_REGISTERED";
  if (!row.age_group_id) return "NO_GROUP";
  if (!row.fee_id) return "NO_FEE";
  if (row.existing_invoice_id) return "ALREADY_INVOICED";
  return null;
}

/**
 * `previewHash` — what BIL-02 must echo back.
 *
 * The hash covers everything that would change what a run issues: the configuration in
 * force, the target date, and each line's fee, period and due date. It is taken over a
 * **canonical** form (sorted, explicit field order) so two identical previews hash the same
 * regardless of query order, and a fee change, a transfer or another run's invoice in
 * between changes it — which is the whole point (T-FIN-18).
 */
export function hashPreview(preview: BillingPreview): string {
  const canonical = {
    targetDate: preview.targetDate,
    issueDate: preview.issueDate,
    frequency: preview.config.frequency,
    mode: preview.config.mode,
    weekStartDay: preview.config.weekStartDay,
    timing: preview.config.timing,
    dueRuleType: preview.config.dueRuleType,
    dueRuleValue: preview.config.dueRuleValue,
    lines: [...preview.lines]
      .sort((a, b) => (a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0))
      .map((line) => ({
        playerId: line.playerId,
        ageGroupId: line.ageGroup.id,
        feeId: line.feeId,
        feeMinor: line.feeMinor,
        periodStart: line.periodStart,
        periodEnd: line.periodEnd,
        dueDate: line.dueDate,
      })),
    skipped: [...preview.skipped]
      .sort((a, b) => (a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0))
      .map((skip) => ({ playerId: skip.playerId, reason: skip.reason })),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export interface BillingAdjustment {
  playerId: string;
  amountMinor: number;
  reason: string;
}

export interface IssuedRun {
  runId: string;
  status: "issued" | "partial" | "failed";
  invoicesCreated: number;
  invoicesSkipped: number;
  invoiceIds: string[];
}

/**
 * Issues one run — **one transaction**, which the caller owns (T1).
 *
 * The advisory lock is taken first so two runs that started at the same moment are ordered
 * rather than interleaved; the second one then finds every period `ALREADY_INVOICED` and
 * issues nothing (§9). Invoice numbers come from `document_counters` inside this same
 * transaction, so a rolled-back run burns no number.
 *
 * `ON CONFLICT DO NOTHING` on the period index is the last line of defence: even with a
 * different `run_key`, a period that already has an invoice is skipped and *counted* as
 * skipped rather than duplicated.
 */
export async function issueRun(
  client: PoolClient,
  args: {
    ctx: BillingContext;
    preview: BillingPreview;
    adjustments: BillingAdjustment[];
    runKey: string;
    triggeredBy: "owner" | "scheduler";
    /**
     * The user the run is attributed to, or `null` for the scheduled run.
     *
     * `billing_runs.started_by` and `invoices.created_by` both allow null, and the daily
     * scheduler has no session: attributing a system run to a person would be a false record in
     * the very table an audit reads (see `src/worker/jobs.ts`).
     */
    userId: string | null;
  },
): Promise<IssuedRun> {
  const { ctx, preview } = args;
  await client.query(`select pg_advisory_xact_lock(hashtext('billing_run'))`);

  // Read once for the whole run: every invoice in a run is issued at the same moment, so they
  // all snap the same branding block.
  const brand = await loadAcademyBrand(client);

  // The handler validates these before calling (unique player, negative, |adj| ≤ fee); the map
  // is only here so a second adjustment for one player cannot silently win.
  const adjustmentFor = new Map<string, BillingAdjustment>();
  for (const adjustment of args.adjustments) {
    if (adjustmentFor.has(adjustment.playerId)) {
      throw new Error(`two adjustments for player ${adjustment.playerId}`);
    }
    adjustmentFor.set(adjustment.playerId, adjustment);
  }

  const runId = uuidv7();
  await client.query(
    `insert into billing_runs
       (id, run_key, frequency, period_mode, target_date, status, triggered_by, started_by,
        invoices_created, invoices_skipped, summary)
     values ($1, $2, $3, $4, $5::date, 'issued', $6, $7, 0, 0, $8::jsonb)`,
    [
      runId,
      args.runKey,
      ctx.config.frequency,
      ctx.config.mode,
      preview.targetDate,
      args.triggeredBy,
      args.userId,
      JSON.stringify({ previewHash: hashPreview(preview), lines: preview.lines.length }),
    ],
  );

  const invoiceIds: string[] = [];
  // Players a concurrent run claimed between the preview and the insert. The preview's own
  // skips are added below — a run that issues nothing because every period is already
  // invoiced must report those N skips, not 0 (§9).
  let skippedDuringIssue = 0;

  for (const line of preview.lines) {
    const adjustment = adjustmentFor.get(line.playerId);
    const adjustmentMinor = adjustment?.amountMinor ?? 0;
    const subtotal = line.feeMinor;
    const total = subtotal + adjustmentMinor;
    if (total < 0) {
      throw new Error(`adjustment for player ${line.playerId} exceeds the fee`);
    }

    // Checked *before* the number is drawn: a `ON CONFLICT DO NOTHING` insert would still have
    // advanced `document_counters`, and the contract's numbers are gapless (§9). The advisory
    // lock plus this check make the conflict clause below a last line of defence rather than
    // the mechanism.
    const already = await client.query<{ id: string }>(
      `select i.id from invoices i
        where i.player_id = $1 and i.period_start = $2::date and i.period_end = $3::date
          and (i.status <> 'void' or i.suppress_reissue)`,
      [line.playerId, line.periodStart, line.periodEnd],
    );
    if (already.rowCount && already.rowCount > 0) {
      skippedDuringIssue += 1;
      continue;
    }

    const invoiceId = uuidv7();
    const inserted = await client.query(
      `insert into invoices
         (id, invoice_number, kind, player_id, guardian_id, billing_run_id, period_start,
          period_end, issue_date, due_date, status, currency, subtotal_minor,
          adjustments_minor, total_minor, paid_minor, snapshot, created_by)
       values ($1, $2, 'periodic', $3, $4, $5, $6::date, $7::date, $8::date, $9::date,
               'issued', $10, $11, $12, $13, 0, $14::jsonb, $15)
       on conflict (player_id, period_start, period_end)
         where kind = 'periodic' and (status <> 'void' or suppress_reissue)
         do nothing
       returning id`,
      [
        invoiceId,
        await nextDocumentNumber(client, "invoice", ctx.config.timezone),
        line.playerId,
        line.guardian?.id ?? null,
        runId,
        line.periodStart,
        line.periodEnd,
        line.issueDate,
        line.dueDate,
        ctx.config.currency,
        subtotal,
        adjustmentMinor,
        total,
        // The snapshot is the invoice's own record of the world at issue (DATABASE §4): the
        // group, the fee and the period, so a later fee change or transfer cannot rewrite it.
        //
        // The academy, player and guardian blocks are the same idea applied to the document
        // (FILES_AND_PDF §2): the invoice PDF is rendered from `snapshot` alone, so an invoice
        // reissued today still prints the address, the prefix and the phone number that were
        // true when it was issued.
        JSON.stringify({
          ageGroupId: line.ageGroup.id,
          ageGroupName: line.ageGroup.name,
          feeId: line.feeId,
          feeMinor: line.feeMinor,
          periodStart: line.periodStart,
          periodEnd: line.periodEnd,
          issuedBy: args.triggeredBy,
          academy: brand,
          player: {
            fullName: line.playerName,
            registrationNo: line.registrationNo,
            ageGroupName: line.ageGroup.name,
          },
          guardian: line.guardian
            ? { fullName: line.guardian.fullName, phone: line.guardianPhone ?? null }
            : null,
        }),
        args.userId,
      ],
    );

    if (inserted.rowCount === 0) {
      skippedDuringIssue += 1;
      continue;
    }

    await client.query(
      `insert into invoice_items
         (id, invoice_id, line_no, item_type, description, quantity, unit_amount_minor,
          amount_minor, created_by)
       values ($1, $2, 1, 'fee', $3, 1, $4, $4, $5)`,
      [uuidv7(), invoiceId, `Fee — ${line.ageGroup.name}`, subtotal, args.userId],
    );

    if (adjustment) {
      await client.query(
        `insert into invoice_items
           (id, invoice_id, line_no, item_type, description, quantity, unit_amount_minor,
            amount_minor, reason, created_by)
         values ($1, $2, 2, 'adjustment', $3, 1, $4, $4, $5, $6)`,
        [uuidv7(), invoiceId, adjustment.reason, adjustmentMinor, adjustment.reason, args.userId],
      );
    }

    invoiceIds.push(invoiceId);
  }

  const created = invoiceIds.length;
  // Everything the run did not invoice for this period: the players the preview already
  // excluded (`preview.skipped` — `NO_FEE`, `ALREADY_INVOICED`, …) plus the ones claimed by a
  // concurrent run. Reporting only the latter is what made a second run for a period answer
  // `invoicesCreated: 0 / invoicesSkipped: 0`, which said nothing had been considered
  // (BILLING_ENGINE §9; the frontend's BillingRun reads this pair).
  const skipped = skippedDuringIssue + preview.skipped.length;
  // `issued` only when the run had nothing to skip: any skipped player makes the run partial
  // — it did not invoice the full scope it was aimed at.
  const status: IssuedRun["status"] = skipped > 0 ? "partial" : "issued";

  await client.query(
    `update billing_runs
        set invoices_created = $2, invoices_skipped = $3, status = $4, completed_at = now(),
            summary = summary || jsonb_build_object('invoiceIds', $5::jsonb)
      where id = $1`,
    [runId, created, skipped, status, JSON.stringify(invoiceIds)],
  );

  return { runId, status, invoicesCreated: created, invoicesSkipped: skipped, invoiceIds };
}
