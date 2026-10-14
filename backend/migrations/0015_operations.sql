-- ---------------------------------------------------------------------------
-- 0015_operations — the worker's own bookkeeping (DEPLOYMENT_AND_OPERATIONS §6/§8).
--
-- SYS-03 is the operator's page, and it can only tell the truth if the worker leaves
-- evidence: which scheduled job ran, when, and whether it succeeded. That is what
-- `job_runs` is, and it is also the mechanism that makes a daily job idempotent — the
-- partial unique index on (job, run_key) means "this job already ran for this local
-- date" is a fact the database enforces rather than something the worker remembers.
--
-- `worker_heartbeats` is a single row the worker touches every minute (§6: "worker
-- writes a row every minute ... alert if > 5 min stale"). It is a row rather than a
-- history so a heartbeat every minute cannot grow without bound; the *history* worth
-- keeping belongs in `job_runs`.
--
-- Rollback: these objects are new; a compensating migration drops worker_heartbeats
-- then job_runs. No existing data is touched.
--
-- DATABASE §7: ENABLE + FORCE ROW LEVEL SECURITY, owner-readable, worker-written.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- job_runs — one row per scheduled-job execution
-- ---------------------------------------------------------------------------
create table job_runs (
  id          uuid primary key,
  -- The job's stable name ('billing.scheduler', 'pdf.sweeper', …). It is the same
  -- string the worker's registry uses, so a typo cannot create a phantom job.
  job         text not null,
  -- The idempotency key for a job that must run at most once per window (a daily
  -- job uses the academy-local date). NULL for an interval job, which legitimately
  -- runs many times and is ordered by the advisory lock instead.
  run_key     text,
  status      text not null check (status in ('running', 'ok', 'failed', 'skipped')),
  -- What the run did, in the job's own words. Small by design: counts and names,
  -- never a dump of rows (SECURITY_AND_PRIVACY §3.5 — no PII in operational data).
  detail      jsonb,
  -- The failure, trimmed. A stack trace belongs in the process log, not here.
  error       text,
  started_at  timestamptz not null default now(),
  finished_at timestamptz
);
comment on table job_runs is
  'Scheduled-job history for SYS-03 and for daily-job idempotency. Written by the worker.';

create index job_runs_job_idx on job_runs (job, started_at desc);
-- The last failure per job is what the operator needs to see; a healthy history is not.
create index job_runs_failed_idx on job_runs (job, started_at desc) where status = 'failed';
-- "Has this job already run for this window?" — the whole point of run_key.
create unique index job_runs_key_uq on job_runs (job, run_key) where run_key is not null;
-- A run that is still 'running' long after it started is a stuck job (the sweeper's input).
create index job_runs_running_idx on job_runs (started_at) where status = 'running';

-- ---------------------------------------------------------------------------
-- worker_heartbeats — the single row a live worker touches every minute (§6)
-- ---------------------------------------------------------------------------
create table worker_heartbeats (
  id           smallint primary key check (id = 1),
  heartbeat_at timestamptz not null default now(),
  -- The worker's own version string, so an operator can tell which build is running.
  version      text
);
comment on table worker_heartbeats is
  'One row, touched by the worker each minute. SYS-03 compares its age against the 5-minute alert threshold.';

-- ---------------------------------------------------------------------------
-- pending_anchors — the audit chain's external anchor (§8 "audit-chain verify + anchor")
--
-- The nightly job verifies the hash chain and records the head hash it verified. The
-- anchor is a *local record of an intent to anchor*: nothing here uploads to
-- `AUDIT_ANCHOR_BUCKET`, so the table holds what a later uploader needs (the head id,
-- the hash and the window covered). Storing it makes "when was the chain last proven
-- intact, and up to which row" answerable — which is the question an audit asks.
-- ---------------------------------------------------------------------------
create table audit_anchors (
  id             uuid primary key,
  verified_from  bigint not null,
  verified_to    bigint not null,   -- the head row id at verification time
  head_hash      text not null,
  rows_checked   integer not null check (rows_checked >= 0),
  created_at     timestamptz not null default now(),
  constraint audit_anchors_range check (verified_to >= verified_from)
);
create index audit_anchors_created_idx on audit_anchors (created_at desc);

-- ---------------------------------------------------------------------------
-- Row level security (DATABASE §7)
-- ---------------------------------------------------------------------------
alter table job_runs         enable row level security;
alter table job_runs         force row level security;
alter table worker_heartbeats enable row level security;
alter table worker_heartbeats force row level security;
alter table audit_anchors    enable row level security;
alter table audit_anchors    force row level security;

do $$
declare t text;
begin
  foreach t in array array['job_runs','worker_heartbeats','audit_anchors'] loop
    execute format(
      'create policy %I on %I to ia_migrator using (true) with check (true)',
      t || '_migrator_all', t);
  end loop;
end
$$;

-- The worker writes through the migrator role (as the operator CLIs do — there is no
-- session to authenticate), so the runtime role only ever *reads* here. That keeps the
-- operational surface owner-readable and not owner-writable: an API request cannot
-- fabricate a green heartbeat.
create policy job_runs_owner_read on job_runs for select to ia_app
  using (app.app_role() = 'owner');
create policy worker_heartbeats_owner_read on worker_heartbeats for select to ia_app
  using (app.app_role() = 'owner');
create policy audit_anchors_owner_read on audit_anchors for select to ia_app
  using (app.app_role() = 'owner');

-- ---------------------------------------------------------------------------
-- Grants (DATABASE §7)
-- ---------------------------------------------------------------------------
grant select on job_runs, worker_heartbeats, audit_anchors to ia_app;
