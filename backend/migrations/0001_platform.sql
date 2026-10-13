-- ---------------------------------------------------------------------------
-- 0001_platform — request context, audit trail, idempotency, counters, files.
--
-- Rollback: these objects are new; a compensating migration drops them in reverse
-- order (files → document_counters → idempotency_keys → audit_logs → helpers →
-- schema app). No existing data is touched, so no expand/contract is needed.
--
-- DATABASE §3.7 / §7. Every table here is ENABLE + FORCE ROW LEVEL SECURITY.
-- ---------------------------------------------------------------------------

create schema if not exists app;

-- ---------------------------------------------------------------------------
-- Request context (DATABASE §7)
--
-- The API sets `app.user_id` / `app.role` with SET LOCAL at the start of every
-- request transaction; these read that context. `true` = missing_ok, so an
-- unauthenticated or background transaction reads null instead of erroring.
-- ---------------------------------------------------------------------------
create or replace function app.app_user_id() returns uuid
  language sql stable
  as $$ select nullif(current_setting('app.user_id', true), '')::uuid $$;

create or replace function app.app_role() returns text
  language sql stable
  as $$ select nullif(current_setting('app.role', true), '') $$;

-- NOTE: `app.app_coach_group_ids(on_date)` (DATABASE §7) is deliberately NOT created
-- here. Its body reads `coach_group_assignments`, which M3 introduces, and PostgreSQL
-- validates a SQL function body at creation — a helper pointing at a non-existent
-- table would either fail the migration or (with body checks off) sit broken in the
-- database. It is created in the migration that owns that table, together with its
-- EXECUTE grant. Nothing in M2 needs it: no table here has coach-scoped RLS.

-- ---------------------------------------------------------------------------
-- files — metadata only; contents live in private object storage (DATABASE §3.4)
-- ---------------------------------------------------------------------------
create table files (
  id            uuid primary key,
  kind          text not null check (kind in ('payment_proof','invoice_pdf','receipt_pdf','logo','import_csv')),
  storage_key   text not null unique,
  mime_type     text not null,
  size_bytes    bigint not null check (size_bytes >= 0),
  sha256        text not null,
  original_name text,
  uploaded_by   uuid,
  created_at    timestamptz not null default now(),
  deleted_at    timestamptz
);
create index files_kind_idx on files (kind) where deleted_at is null;

-- ---------------------------------------------------------------------------
-- document_counters — gapless per-year document numbers (DATABASE §3.3)
-- ---------------------------------------------------------------------------
create table document_counters (
  name       text not null,
  year       integer not null,
  next_value bigint not null default 1 check (next_value > 0),
  primary key (name, year)
);

-- ---------------------------------------------------------------------------
-- idempotency_keys — 72 h retention (API_CONTRACTS §1)
-- ---------------------------------------------------------------------------
create table idempotency_keys (
  user_id         uuid not null,
  key             text not null,
  method          text not null,
  path            text not null,
  request_hash    text not null,
  state           text not null check (state in ('in_progress','completed')),
  response_status integer,
  response_body   jsonb,
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null,
  primary key (user_id, key)
);
create index idempotency_keys_expiry_idx on idempotency_keys (expires_at);

-- ---------------------------------------------------------------------------
-- audit_logs — append-only, hash-chained (DATABASE §3.7, T-SEC-07)
--
-- prev_hash/row_hash make silent tampering detectable: any edit to a historical
-- row breaks every later hash. The runtime role has INSERT + SELECT only, and a
-- trigger refuses UPDATE/DELETE even for a role that somehow holds the grant.
-- ---------------------------------------------------------------------------
create table audit_logs (
  id            bigint generated always as identity primary key,
  occurred_at   timestamptz not null default now(),
  actor_user_id uuid,
  actor_role    text,
  action        text not null,
  entity_type   text not null,
  entity_id     uuid,
  before        jsonb,
  after         jsonb,
  reason        text,
  request_id    text not null,
  ip            inet,
  prev_hash     text,
  row_hash      text not null
);
create index audit_logs_occurred_idx on audit_logs (occurred_at desc);
create index audit_logs_entity_idx on audit_logs (entity_type, entity_id);
create index audit_logs_actor_idx on audit_logs (actor_user_id);

-- Canonical serialization: a deterministic concatenation of the row's meaning, so
-- the same logical row always hashes the same way regardless of key order.
create or replace function app.audit_row_hash(
  prev_hash text, p_id bigint, occurred_at timestamptz, actor_user_id uuid, actor_role text,
  action text, entity_type text, entity_id uuid, before jsonb, after jsonb, reason text, request_id text
) returns text
  language sql immutable
  as $$
    select encode(digest(
      coalesce(prev_hash, '') || '|' ||
      p_id::text || '|' ||
      to_char(occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '|' ||
      coalesce(actor_user_id::text, '') || '|' ||
      coalesce(actor_role, '') || '|' ||
      action || '|' || entity_type || '|' ||
      coalesce(entity_id::text, '') || '|' ||
      coalesce(before::text, '') || '|' ||
      coalesce(after::text, '') || '|' ||
      coalesce(reason, '') || '|' || request_id,
      'sha256'), 'hex')
  $$;

create or replace function app.audit_logs_chain() returns trigger
  language plpgsql
  as $$
  declare
    prev text;
  begin
    select al.row_hash into prev from audit_logs al order by al.id desc limit 1;
    new.prev_hash := prev;
    new.row_hash := app.audit_row_hash(
      prev, new.id, new.occurred_at, new.actor_user_id, new.actor_role, new.action,
      new.entity_type, new.entity_id, new.before, new.after, new.reason, new.request_id);
    return new;
  end
  $$;

create trigger audit_logs_chain_trg
  before insert on audit_logs
  for each row execute function app.audit_logs_chain();

create or replace function app.audit_logs_immutable() returns trigger
  language plpgsql
  as $$
  begin
    raise exception 'audit_logs is append-only (DATABASE §3.7)';
  end
  $$;

create trigger audit_logs_no_update_trg
  before update or delete on audit_logs
  for each row execute function app.audit_logs_immutable();

-- ---------------------------------------------------------------------------
-- Row level security (DATABASE §7) — owner-only tables for this migration
-- ---------------------------------------------------------------------------
alter table files               enable row level security;
alter table files               force row level security;
alter table document_counters   enable row level security;
alter table document_counters   force row level security;
alter table idempotency_keys    enable row level security;
alter table idempotency_keys    force row level security;
alter table audit_logs          enable row level security;
alter table audit_logs          force row level security;

-- ia_migrator owns the objects and needs blanket access for migrations, seeds and
-- SECURITY DEFINER helpers. It is a DDL/bootstrap role, never the runtime role.
do $$
declare t text;
begin
  foreach t in array array['files','document_counters','idempotency_keys','audit_logs'] loop
    execute format(
      'create policy %I on %I to ia_migrator using (true) with check (true)',
      t || '_migrator_all', t);
  end loop;
end
$$;

-- Runtime policies: platform tables are owner-only.
create policy files_owner_all on files to ia_app using (app.app_role() = 'owner') with check (app.app_role() = 'owner');
create policy document_counters_owner_all on document_counters to ia_app using (app.app_role() = 'owner') with check (app.app_role() = 'owner');
-- Idempotency rows are per user and written before the role check, so any
-- authenticated caller may touch only its own keys.
create policy idempotency_own on idempotency_keys to ia_app
  using (user_id = app.app_user_id()) with check (user_id = app.app_user_id());

-- Audit: anyone authenticated may append (coach actions are audited too); only an
-- owner may read. No UPDATE/DELETE policy exists, so those are denied outright.
create policy audit_append on audit_logs for insert to ia_app with check (app.app_user_id() is not null);
create policy audit_read on audit_logs for select to ia_app using (app.app_role() = 'owner');

-- ---------------------------------------------------------------------------
-- Grants (DATABASE §7): the runtime role gets exactly what it needs.
-- ---------------------------------------------------------------------------
grant usage on schema app to ia_app;
grant select, insert on files to ia_app;
grant update on files to ia_app;                 -- soft delete only (deleted_at)
grant select, insert on idempotency_keys to ia_app;
grant update on idempotency_keys to ia_app;      -- in_progress → completed
grant select, insert, update on document_counters to ia_app;
grant select, insert on audit_logs to ia_app;    -- deliberately no update/delete
grant execute on function app.app_user_id(), app.app_role() to ia_app;
grant execute on function app.audit_row_hash(text, bigint, timestamptz, uuid, text, text, text, uuid, jsonb, jsonb, text, text) to ia_app;
