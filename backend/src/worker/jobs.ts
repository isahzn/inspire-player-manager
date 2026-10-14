/**
 * The scheduled jobs of DEPLOYMENT_AND_OPERATIONS §8.
 *
 * This file is the answer to the gap the M6 handoff recorded: *"the daily billing scheduler and
 * the PDF sweeper — today invoices exist only when a person clicks a run"*. Both are here, along
 * with the session generator, the invariant job, retention/purge and the logical backup.
 *
 * Three rules shape every job:
 *
 *  1. **The academy's clock, not the server's.** A daily job keys its idempotency on the
 *     academy-local date (`app.billing_period_start`'s own convention), so a container in
 *     another region cannot bill the wrong month or run a day twice.
 *  2. **Do the smallest honest thing.** The billing job issues invoices through the *same*
 *     engine BIL-02 uses; the PDF sweeper calls the *same* `generateInvoicePdf` INV-07 calls.
 *     A second implementation would be a second set of bugs in the money path.
 *  3. **Never claim more than happened.** A job that found nothing says so; a job whose
 *     dependency does not exist (the three M7 jobs) is recorded `skipped` with the reason; the
 *     backup job proves a dump was *produced*, not that it is *restorable*.
 *
 * The money rules are untouched by design: nothing here confirms a payment, moves an
 * allocation, or auto-confirms anything from a proof. The jobs read and maintain; only the
 * owner's actions change money.
 */
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { PoolClient } from "pg";
import { config } from "../config.js";
import { uuidv7 } from "../ids.js";
import { readStoredFile } from "../files/storage.js";
import { buildPreview, issueRun, loadBillingContext } from "../routes/billing-engine.js";
import { generateInvoicePdf, generateReceiptPdf } from "../routes/pdf-service.js";
import { checkInvoiceHealth, loadInvoiceHealthRows } from "../ops/invoice-health.js";
import { JOB, NOT_BUILT_JOBS, type JobName } from "../ops/job-runs.js";

export interface JobContext {
  client: PoolClient;
  /** Academy-local date (`YYYY-MM-DD`) — the idempotency key for every daily job. */
  today: string;
  /** Academy-local time (`HH:MM`) — what the daily schedules are compared against. */
  time: string;
  /** The academy's IANA zone, so a wall-clock time becomes an instant in SQL, not in Node. */
  timezone: string;
}

export interface JobResult {
  /** What the run did, for `job_runs.detail`. Small, PII-free, and omitted when nothing ran. */
  detail?: Record<string, unknown>;
  /**
   * Overrides the recorded status. `skipped` is a real outcome — a job that ran correctly and
   * deliberately did nothing (no `BACKUP_DIR`, a dependency that does not exist) must not be
   * recorded `ok`, because SYS-03 and the alerting read that word as "this happened".
   */
  status?: "ok" | "skipped";
}

export interface JobDef {
  name: JobName;
  /**
   * `daily` runs once per academy-local day at `at`, and catches up if the worker was down;
   * `interval` runs every `everyMs` while the worker is up. The distinction is the contract's
   * (§8's cadence column), not an implementation detail.
   */
  kind: "daily" | "interval";
  at?: string;
  everyMs?: number;
  /** Set for a job whose dependency is not built yet; the scheduler records it `skipped`. */
  notBuilt?: string;
  run: (ctx: JobContext) => Promise<JobResult>;
}

const MINUTE = 60_000;

/** How far ahead the session generator writes. Two weeks is enough to see a schedule change. */
const GENERATE_HORIZON_DAYS = 14;
/** How many stale documents one sweep rebuilds, so a backlog cannot block the tick loop. */
const PDF_SWEEP_BATCH = 20;
/** How many stored objects the orphan sweeper actually reads (each read is a storage call). */
const ORPHAN_SAMPLE = 50;

// ---------------------------------------------------------------------------
// 1. Billing scheduler — the job that makes invoices exist without a person
// ---------------------------------------------------------------------------
async function runBillingScheduler(ctx: JobContext): Promise<JobResult> {
  const billing = await loadBillingContext(ctx.client);
  const preview = await buildPreview(ctx.client, billing, { targetDate: billing.today });

  // Nothing to consider at all: no active player has a group and a fee. Say so and write no
  // billing run — a daily row reading "0 created, 0 skipped" for an unconfigured academy would
  // be noise, and the operator cannot act on it.
  if (preview.lines.length === 0 && preview.skipped.length === 0) {
    return { detail: { created: 0, skipped: 0, note: "no player is billable yet" } };
  }

  const run = await issueRun(ctx.client, {
    ctx: billing,
    preview,
    // The engine never prorates and never invents a fee; an adjustment is the owner's refusal
    // to prorate (BILLING_ENGINE §6), so a scheduled run applies none.
    adjustments: [],
    runKey: `scheduler:${billing.today}`,
    triggeredBy: "scheduler",
    // A system-triggered run has no user. `billing_runs.started_by` and `invoices.created_by`
    // both allow null, and inventing an owner id would falsely attribute the run to a person.
    userId: null,
  });

  return {
    detail: {
      runId: run.runId,
      status: run.status,
      created: run.invoicesCreated,
      skipped: run.invoicesSkipped,
      targetDate: preview.targetDate,
    },
  };
}

// ---------------------------------------------------------------------------
// 2. Session generation — SCH-02's own rule, for every active schedule
// ---------------------------------------------------------------------------
async function runSessionGeneration(ctx: JobContext): Promise<JobResult> {
  const to = await ctx.client.query<{ day: string }>(
    `select ($1::date + $2::int)::text as day`,
    [ctx.today, GENERATE_HORIZON_DAYS - 1],
  );
  const horizonEnd = to.rows[0]!.day;

  // The same predicate SCH-02 uses, and the same `on conflict do nothing`: the
  // (schedule_id, session_date) unique index makes a second run of the same range a no-op, so a
  // session someone edited by hand is never overwritten (T-ATT-01).
  const days = await ctx.client.query<{
    schedule_id: string;
    age_group_id: string;
    start_time: string;
    end_time: string;
    venue: string | null;
    session_date: string;
  }>(
    `select sc.id as schedule_id, sc.age_group_id, sc.start_time, sc.end_time, sc.venue,
            d::date::text as session_date
       from training_schedules sc
       cross join generate_series($1::date, $2::date, interval '1 day') d
      where sc.is_active
        and extract(isodow from d) = sc.weekday
        and d::date >= sc.valid_from
        and (sc.valid_to is null or d::date <= sc.valid_to)
      order by d asc, sc.id asc`,
    [ctx.today, horizonEnd],
  );

  let created = 0;
  for (const row of days.rows) {
    const inserted = await ctx.client.query(
      `insert into sessions
         (id, age_group_id, schedule_id, session_date, starts_at, ends_at, venue, status, created_by)
       values ($1, $2, $3, $4::date,
               (($4::date + $5::time) at time zone $8),
               (($4::date + $6::time) at time zone $8),
               $7, 'scheduled', null)
       on conflict do nothing`,
      [
        uuidv7(),
        row.age_group_id,
        row.schedule_id,
        row.session_date,
        row.start_time,
        row.end_time,
        row.venue,
        ctx.timezone,
      ],
    );
    if (inserted.rowCount === 1) created += 1;
  }

  const considered = days.rows.length;
  const skipped = considered - created;
  if (considered === 0) return {};
  return { detail: { created, skipped, from: ctx.today, to: horizonEnd } };
}

// ---------------------------------------------------------------------------
// 3. PDF sweeper — the job FILES_AND_PDF §4 describes and nothing implemented
// ---------------------------------------------------------------------------
async function runPdfSweeper(ctx: JobContext): Promise<JobResult> {
  // Each branch is parenthesised: `order by … limit` is only legal before a `union` inside
  // parentheses, and an unparenthesised first branch makes the whole statement a syntax error
  // at the `union` — which the first run of this job found for real.
  const stale = await ctx.client.query<{ kind: "invoice" | "receipt"; id: string }>(
    `(select 'invoice' as kind, i.id
        from invoices i
       where i.pdf_stale and i.status <> 'void'
       order by i.issue_date asc, i.id asc
       limit $1)
     union all
     (select 'receipt' as kind, r.id
        from receipts r
       where r.pdf_stale
       order by r.issued_at asc, r.id asc
       limit $1)`,
    [PDF_SWEEP_BATCH],
  );

  let rebuilt = 0;
  let reused = 0;
  const failures: string[] = [];

  for (const row of stale.rows) {
    const result =
      row.kind === "invoice"
        ? await generateInvoicePdf(ctx.client, {
            invoiceId: row.id,
            userId: null,
            force: false,
            timezoneFallback: "Asia/Colombo",
          })
        : await generateReceiptPdf(ctx.client, {
            receiptId: row.id,
            userId: null,
            timezoneFallback: "Asia/Colombo",
          });

    if (result.outcome === "ready") {
      if (result.reused) reused += 1;
      else rebuilt += 1;
    } else if (result.outcome === "mismatch") {
      // A document whose arithmetic does not add up is a data fault for a person, not something
      // a sweeper retries forever. `pdf_stale` stays set, so INV-06 keeps answering 409.
      failures.push(`${row.kind}:${row.id}: the document's totals do not add up`);
    } else if (result.outcome === "storage_failed") {
      failures.push(`${row.kind}:${row.id}: storage refused the write`);
    }
  }

  // A quiet sweep records nothing: this job runs every 30 s, and 2 880 rows a day saying
  // "nothing to do" would bury the rows that matter.
  if (rebuilt === 0 && failures.length === 0) return {};
  return {
    detail: {
      considered: stale.rows.length,
      rebuilt,
      reused,
      failures: failures.slice(0, 10),
      ...(stale.rows.length === PDF_SWEEP_BATCH ? { note: "batch full; the next sweep continues" } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// 4. Stuck jobs — a run that never finished
// ---------------------------------------------------------------------------
async function runStuckJobs(ctx: JobContext): Promise<JobResult> {
  const aborted = await ctx.client.query(
    `update job_runs
        set status = 'failed', finished_at = now(),
            error = 'aborted: the run never finished (the worker stopped or died mid-run)'
      where status = 'running'
        and started_at < now() - ($1::int * interval '1 minute')`,
    [config.worker.stuckMinutes],
  );
  const count = aborted.rowCount ?? 0;
  return count > 0 ? { detail: { aborted: count } } : {};
}

// ---------------------------------------------------------------------------
// 5. Orphan files — rows that point at nothing, and objects nothing points at
// ---------------------------------------------------------------------------
async function runOrphanSweeper(ctx: JobContext): Promise<JobResult> {
  const orphans = await ctx.client.query<{
    orphan_proof_files: number;
    orphan_pdf_files: number;
  }>(
    `select
       (select count(*)::int from files f
         where f.kind = 'payment_proof' and f.deleted_at is null
           and not exists (select 1 from payment_proofs p where p.file_id = f.id)) as orphan_proof_files,
       (select count(*)::int from files f
         where f.kind in ('invoice_pdf','receipt_pdf') and f.deleted_at is null
           and not exists (select 1 from invoices i where i.pdf_file_id = f.id)
           and not exists (select 1 from receipts r where r.file_id = f.id)) as orphan_pdf_files`,
  );
  const row = orphans.rows[0]!;

  // A row whose object is gone is the failure FILES_AND_PDF §8 names (\"object missing but row
  // exists\"). Reading every object would be absurd, so a bounded sample of the newest rows is
  // checked and the result is reported as exactly that: a sample.
  const sample = await ctx.client.query<{ id: string; kind: string; storage_key: string }>(
    `select id, kind, storage_key from files
      where deleted_at is null
      order by created_at desc
      limit $1`,
    [ORPHAN_SAMPLE],
  );
  let missing = 0;
  for (const file of sample.rows) {
    const bytes = await readStoredFile(file.storage_key);
    if (bytes === null) missing += 1;
  }

  const detail: Record<string, unknown> = {
    orphanProofFiles: row.orphan_proof_files,
    orphanPdfFiles: row.orphan_pdf_files,
    sampledObjects: sample.rows.length,
    missingObjects: missing,
    note: "Orphan rows are reported, never deleted: a file row is evidence of what was submitted.",
  };
  const hasWork = row.orphan_proof_files > 0 || row.orphan_pdf_files > 0 || missing > 0;
  return hasWork ? { detail } : {};
}

// ---------------------------------------------------------------------------
// 6. Invariant verification, audit-chain verification and the anchor
// ---------------------------------------------------------------------------
async function runInvariantNightly(ctx: JobContext): Promise<JobResult> {
  // The migrator connection is the point: an integrity check that could not see a row a policy
  // hides would not be an integrity check.
  const rows = await loadInvoiceHealthRows(ctx.client, { includeVoid: true });
  const report = checkInvoiceHealth(rows, { today: ctx.today });
  const errors = report.findings.filter((finding) => finding.severity === "error");

  // The audit trail's own integrity: every `prev_hash` must be the previous row's `row_hash`,
  // and every `row_hash` must be the documented hash of its row. Recomputing it here is the
  // only way "the chain is intact" means anything.
  const chain = await ctx.client.query<{ checked: string; broken: string; head: string | null }>(
    `with chained as (
       select id, occurred_at, actor_user_id, actor_role, action, entity_type, entity_id,
              before, after, reason, request_id, prev_hash, row_hash,
              lag(row_hash) over (order by id) as expected_prev
         from audit_logs
     )
     select count(*)::text as checked,
            count(*) filter (
              where coalesce(prev_hash, '') is distinct from coalesce(expected_prev, '')
                 or row_hash <> app.audit_row_hash(
                      prev_hash, id, occurred_at, actor_user_id, actor_role, action,
                      entity_type, entity_id, before, after, reason, request_id)
            )::text as broken,
            (select row_hash from audit_logs order by id desc limit 1) as head
       from chained`,
  );
  const chainRow = chain.rows[0]!;
  const broken = Number(chainRow.broken);
  const checked = Number(chainRow.checked);

  // Every invoice's own arithmetic, as a count, so the operator sees one number even when the
  // findings list is long.
  const arithmetic = await ctx.client.query<{ mismatch: string }>(
    `select count(*)::text as mismatch
       from invoices i
       left join (select invoice_id, sum(amount_minor) as total from invoice_items group by invoice_id) it
              on it.invoice_id = i.id
      where i.total_minor <> coalesce(it.total, 0)
         or (i.status in ('issued','partially_paid','paid') and i.balance_minor <> i.total_minor - i.paid_minor)`,
  );

  const detail = {
    invoicesChecked: report.summary.checked,
    invoiceErrors: report.summary.errors,
    invoiceWarns: report.summary.warns,
    overdueCount: report.summary.overdueCount,
    arithmeticMismatches: Number(arithmetic.rows[0]?.mismatch ?? 0),
    auditRowsChecked: checked,
    auditChainBroken: broken,
  };

  if (checked > 0) {
    // The anchor records what was verified, up to which row, and the head hash then in force.
    // Storing it is what makes "when was the chain last proven intact" answerable later.
    // Both bounds are read back from the table, so `verified_to` is a real row and not a guess.
    const bounds = await ctx.client.query<{ min_id: string | null; max_id: string | null }>(
      `select min(id)::text as min_id, max(id)::text as max_id from audit_logs`,
    );
    await ctx.client.query(
      `insert into audit_anchors (id, verified_from, verified_to, head_hash, rows_checked)
       values ($1, $2::bigint, $3::bigint, $4, $5)`,
      [
        uuidv7(),
        bounds.rows[0]?.min_id ?? "1",
        bounds.rows[0]?.max_id ?? "1",
        chainRow.head ?? "",
        checked,
      ],
    );
  }

  // A failed invariant is the one thing the release procedure calls a rollback trigger
  // (DEPLOYMENT §5). Throwing records the run `failed`, which is what SYS-03 and the alerting
  // read — the detail is already on the row.
  if (errors.length > 0 || broken > 0 || detail.arithmeticMismatches > 0) {
    throw new Error(
      `invariant violation: ${errors.length} invoice error(s), ${broken} broken audit hash(es), ` +
        `${detail.arithmeticMismatches} total mismatch(es)`,
    );
  }

  return { detail };
}

// ---------------------------------------------------------------------------
// 7. Retention and purge — the smallest set that is safe to delete
// ---------------------------------------------------------------------------
async function runRetentionPurge(ctx: JobContext): Promise<JobResult> {
  const retention = config.worker.retention;

  const idempotency = await ctx.client.query(
    `delete from idempotency_keys where expires_at < now()`,
  );
  const links = await ctx.client.query(
    `delete from invoice_access_tokens
      where (revoked_at is not null or expires_at < now())
        and created_at < now() - ($1::int * interval '1 day')`,
    [retention.invoiceLinkExpiredDays],
  );
  const jobRuns = await ctx.client.query(
    `delete from job_runs
      where (status <> 'failed' and started_at < now() - ($1::int * interval '1 day'))
         or (status = 'failed' and started_at < now() - ($2::int * interval '1 day'))`,
    [retention.jobRunDays, retention.failedJobRunDays],
  );

  // Deliberately NOT deleted, and reported instead: invoices, payments, receipts, proofs and
  // their objects. Financial records are kept for the retention the owner's accountant confirms
  // (OPEN-009), and proofs are the one artefact that cannot be re-created (FILES_AND_PDF §8). A
  // purge job that guessed at those periods would be destroying evidence on a schedule.
  const eligible = await ctx.client.query<{ proofs: number; invoices: number }>(
    `select
       (select count(*)::int from payment_proofs p
         where p.deleted_at is null
           and p.created_at < now() - ($1::int * interval '1 month')) as proofs,
       (select count(*)::int from invoices i
         where i.issue_date < (now() - ($2::int * interval '1 year'))::date) as invoices`,
    [retention.proofMonths, retention.financialYears],
  );

  return {
    detail: {
      purgedIdempotencyKeys: idempotency.rowCount ?? 0,
      purgedInvoiceLinks: links.rowCount ?? 0,
      purgedJobRuns: jobRuns.rowCount ?? 0,
      eligibleButNotPurged: {
        proofs: eligible.rows[0]?.proofs ?? 0,
        invoices: eligible.rows[0]?.invoices ?? 0,
        reason:
          "Financial records and proofs need the owner's written retention decision (OPEN-009); " +
          "this job purges operational rows only.",
      },
    },
  };
}

// ---------------------------------------------------------------------------
// 8. Logical backup
// ---------------------------------------------------------------------------
async function runLogicalBackup(ctx: JobContext): Promise<JobResult> {
  const dir = config.worker.backupDir;
  const url = config.worker.migratorDatabaseUrl;
  if (!dir) {
    return {
      // `skipped`, not `ok`: SYS-03 would otherwise read the last backup as healthy on a
      // deployment that has never written one.
      status: "skipped",
      detail: {
        skipped: true,
        reason:
          "BACKUP_DIR is not set, so no dump was written. Production takes its dumps with a host " +
          "cron or the provider (DEPLOYMENT §7) — this job exists so a self-hosted deployment " +
          "has one, and so SYS-03 can report whether the last backup happened.",
      },
    };
  }
  if (!url) {
    // Unreachable in practice (`workerDb()` already refused), kept so the branch cannot rot.
    throw new Error("DATABASE_MIGRATOR_URL is missing, so pg_dump has no database to read");
  }

  const stamp = `${ctx.today}_${ctx.time.replace(":", "")}`;
  const fileName = `ia-${stamp}.dump`;
  const filePath = join(dir, fileName);
  await mkdir(dir, { recursive: true });

  const outcome = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
    const child = spawn("pg_dump", ["--format=custom", "--no-owner", `--file=${filePath}`, url], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    // `stdio: [..., "pipe"]` guarantees a stream at run time; the optional call keeps the type
    // honest without an assertion.
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      // `pg_dump` is not on PATH. That is a configuration fact, not a crash.
      resolve({ ok: false, error: (err as Error).message });
    });
    child.on("close", (code) => {
      resolve(
        code === 0
          ? { ok: true }
          : { ok: false, error: stderr.trim().slice(0, 300) || `pg_dump exited with ${code}` },
      );
    });
  });

  if (!outcome.ok) {
    throw new Error(`the logical backup did not complete: ${outcome.error}`);
  }

  return {
    detail: {
      file: fileName,
      format: "custom",
      // Said plainly because it is the difference between a backup and a feeling of safety:
      // this proves a dump was written, not that it can be restored. DEPLOYMENT §7 requires a
      // restore drill every quarter, recorded in RESTORE_LOG.md.
      note: "A dump was produced. Restorability is proven only by the quarterly restore drill.",
    },
  };
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------
const CORE_JOBS: readonly JobDef[] = [
  {
    name: JOB.billingScheduler,
    kind: "daily",
    at: "02:00",
    run: runBillingScheduler,
  },
  {
    name: JOB.sessionGeneration,
    kind: "daily",
    at: "03:00",
    run: runSessionGeneration,
  },
  { name: JOB.pdfSweeper, kind: "interval", everyMs: 30_000, run: runPdfSweeper },
  { name: JOB.stuckJobs, kind: "interval", everyMs: 15 * MINUTE, run: runStuckJobs },
  { name: JOB.orphanFiles, kind: "daily", at: "04:00", run: runOrphanSweeper },
  { name: JOB.invariant, kind: "daily", at: "04:00", run: runInvariantNightly },
  { name: JOB.retention, kind: "daily", at: "04:30", run: runRetentionPurge },
  { name: JOB.backup, kind: "daily", at: "01:00", run: runLogicalBackup },
];

/**
 * The three M7 jobs, registered but not built.
 *
 * They are listed rather than omitted so the operator's page can show "waiting on a phone
 * number" in the same place as everything else, and so nothing can quietly claim messaging
 * works. No OpenWA behaviour is written against a guess (M6 handoff §5, handoff §5.1).
 */
const NOT_BUILT: readonly JobDef[] = NOT_BUILT_JOBS.map((name) => ({
  name,
  kind: "daily" as const,
  at: "08:30",
  notBuilt: "M7 is blocked on a dedicated phone number (spike S1); no messaging code is written.",
  run: async (): Promise<JobResult> => ({}),
}));

export const JOBS: readonly JobDef[] = [...CORE_JOBS, ...NOT_BUILT];
