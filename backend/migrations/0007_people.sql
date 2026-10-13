-- ---------------------------------------------------------------------------
-- 0007_people — age groups, fees, coach assignments, players, group history,
-- guardians, links and import batches (DATABASE §3.2, M3).
--
-- Rollback: new tables; a compensating migration drops them in reverse order
-- (import_batches → player_guardians → guardians → player_group_history →
-- players → coach_group_assignments → group_fees → age_groups) and the helper
-- function. `users`, `files` and `document_counters` are referenced by FK only.
--
-- Two deviations from a literal reading of DATABASE §3.2, both deliberate and
-- flagged in the M3 handoff:
--  1. `app.app_coach_group_ids(on_date)` is created here (it was deliberately left
--     out of 0001 because it reads `coach_group_assignments`), together with its
--     EXECUTE grant. It is the coach-scope predicate every coach RLS policy uses.
--  2. `player_guardians` is the one table with a DELETE grant: GDN-04 removes a
--     *link*, not a person, and there is no soft-delete column for it. Players,
--     guardians and fee rows keep the DATABASE §6 "never hard-deleted" rule
--     (select/insert/update only).
--
-- `citext`, `pg_trgm`, `btree_gist` and `pgcrypto` are created by db/bootstrap.sql
-- (run once per database as a superuser); this migration only uses them.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- age_groups (DATABASE §3.2) — archive hides a group from new assignments;
-- history stays readable. Name is unique among non-archived groups.
-- ---------------------------------------------------------------------------
create table age_groups (
  id          uuid primary key,
  name        text not null check (length(btrim(name)) between 1 and 120),
  min_age     smallint check (min_age >= 0),
  max_age     smallint check (max_age >= 0),
  sort_order  smallint not null default 0,
  archived_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint age_groups_age_order check (min_age is null or max_age is null or min_age <= max_age)
);
create unique index age_groups_name_active_uq on age_groups (lower(name)) where archived_at is null;

-- ---------------------------------------------------------------------------
-- group_fees — effective-dated per group. One amount per range; a change closes
-- the current row and inserts a new one inside one transaction (T6, FEE-02).
-- No overlapping ranges, enforced by the database.
-- ---------------------------------------------------------------------------
create table group_fees (
  id             uuid primary key,
  age_group_id   uuid not null references age_groups (id),
  amount_minor   bigint not null check (amount_minor > 0 and amount_minor <= 10000000000),
  effective_from date not null,
  effective_to   date,
  created_by     uuid,
  created_at     timestamptz not null default now(),
  constraint group_fees_period check (effective_to is null or effective_to >= effective_from),
  constraint group_fees_no_overlap exclude using gist (
    age_group_id with =,
    daterange(effective_from, effective_to, '[]') with &&
  )
);
create index group_fees_group_idx on group_fees (age_group_id, effective_from desc);

-- ---------------------------------------------------------------------------
-- coach_group_assignments — a coach's scope on a date is
-- `assigned_from <= D and (assigned_to is null or assigned_to >= D)`.
-- ---------------------------------------------------------------------------
create table coach_group_assignments (
  id            uuid primary key,
  coach_user_id uuid not null references users (id),
  age_group_id  uuid not null references age_groups (id),
  assigned_from date not null,
  assigned_to   date,
  created_by    uuid,
  created_at    timestamptz not null default now(),
  constraint coach_assign_period check (assigned_to is null or assigned_to >= assigned_from),
  constraint coach_assign_no_overlap exclude using gist (
    coach_user_id with =,
    age_group_id with =,
    daterange(assigned_from, assigned_to, '[]') with &&
  )
);
create index coach_assign_coach_idx on coach_group_assignments (coach_user_id, assigned_from desc);
create index coach_assign_group_idx on coach_group_assignments (age_group_id);

-- ---------------------------------------------------------------------------
-- players — records are never hard-deleted (ADR-016); a withdrawn player leaves
-- future rosters and billing but stays searchable. `registration_no` comes from
-- document_counters ('player_reg'). `version` powers optimistic locking.
-- ---------------------------------------------------------------------------
create table players (
  id                    uuid primary key,
  registration_no       text not null unique,
  full_name             text not null check (length(btrim(full_name)) between 2 and 120),
  date_of_birth         date,
  registration_date     date not null,
  billing_anchor_date   date not null,
  status                text not null default 'active' check (status in ('active','inactive','withdrawn')),
  status_effective_date date not null,
  status_reason         text check (status_reason is null or length(status_reason) <= 200),
  notes                 text check (notes is null or length(notes) <= 1000),
  coach_notes           text check (coach_notes is null or length(coach_notes) <= 500),
  anonymized_at         timestamptz,
  created_by            uuid,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  version               integer not null default 1 check (version > 0)
);
create index players_status_idx on players (status);
create index players_dob_idx on players (date_of_birth);
-- Advisory duplicate detection (PLY-08): trigram similarity over the name.
create index players_full_name_trgm_idx on players using gin (full_name gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- player_group_history — the open row (effective_to is null) *is* the current
-- group; there is no denormalized current_age_group_id. A transfer closes the
-- open row and opens a new one (T7, PLY-06).
-- ---------------------------------------------------------------------------
create table player_group_history (
  id             uuid primary key,
  player_id      uuid not null references players (id),
  age_group_id   uuid not null references age_groups (id),
  effective_from date not null,
  effective_to   date,
  reason         text,
  changed_by     uuid,
  created_at     timestamptz not null default now(),
  constraint pgh_period check (effective_to is null or effective_to >= effective_from),
  constraint pgh_no_overlap exclude using gist (
    player_id with =,
    daterange(effective_from, effective_to, '[]') with &&
  )
);
-- At most one open row per player.
create unique index player_group_history_one_open on player_group_history (player_id)
  where effective_to is null;
create index player_group_history_group_idx on player_group_history (age_group_id);

-- ---------------------------------------------------------------------------
-- guardians — siblings share one guardian row and one consent record. No unique
-- constraint on the phone (two guardians may share a number; duplicates advisory).
-- ---------------------------------------------------------------------------
create table guardians (
  id                  uuid primary key,
  full_name           text not null check (length(btrim(full_name)) between 2 and 120),
  phone_e164          text not null check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  relationship        text check (relationship is null or length(relationship) <= 60),
  whatsapp_consent    text not null default 'unknown' check (whatsapp_consent in ('unknown','granted','revoked')),
  consent_recorded_at timestamptz,
  consent_source      text,
  opted_out_at        timestamptz,
  notes               text,
  anonymized_at       timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index guardians_phone_idx on guardians (phone_e164);

-- ---------------------------------------------------------------------------
-- player_guardians — PK (player_id, guardian_id); exactly one primary per player.
-- ---------------------------------------------------------------------------
create table player_guardians (
  player_id         uuid not null references players (id),
  guardian_id       uuid not null references guardians (id),
  is_primary        boolean not null default false,
  receives_invoices boolean not null default true,
  created_at        timestamptz not null default now(),
  primary key (player_id, guardian_id)
);
create unique index player_guardians_one_primary on player_guardians (player_id) where is_primary;

-- ---------------------------------------------------------------------------
-- import_batches (DATABASE §3.7, CSV_IMPORT) — the validated batch a commit
-- reads back. `report` holds the parsed rows + issues because no object-storage
-- adapter exists yet (M6); nothing is written to `players` until IMP-02.
-- ---------------------------------------------------------------------------
create table import_batches (
  id           uuid primary key,
  kind         text not null check (kind in ('players')),
  file_id      uuid references files (id),
  status       text not null check (status in ('validated','committed','rejected')),
  row_count    integer not null default 0 check (row_count >= 0),
  error_count  integer not null default 0 check (error_count >= 0),
  report       jsonb not null default '{}'::jsonb,
  created_by   uuid,
  created_at   timestamptz not null default now(),
  committed_at timestamptz
);

-- ---------------------------------------------------------------------------
-- updated_at / version maintenance. A trigger rather than each UPDATE statement,
-- so an update can never forget to bump `version` (players) or `updated_at`.
-- ---------------------------------------------------------------------------
create or replace function app.set_updated_at() returns trigger
  language plpgsql
  as $$
  begin
    new.updated_at := now();
    return new;
  end
  $$;

create or replace function app.bump_version() returns trigger
  language plpgsql
  as $$
  begin
    new.updated_at := now();
    new.version := old.version + 1;
    return new;
  end
  $$;

create trigger age_groups_touch_trg before update on age_groups
  for each row execute function app.set_updated_at();
create trigger guardians_touch_trg before update on guardians
  for each row execute function app.set_updated_at();
create trigger players_version_trg before update on players
  for each row execute function app.bump_version();

-- ---------------------------------------------------------------------------
-- Coach scope (DATABASE §7). Created here because it reads coach_group_assignments.
-- STABLE + SECURITY INVOKER: it sees exactly the assignments the caller may read.
-- ---------------------------------------------------------------------------
create or replace function app.app_coach_group_ids(on_date date)
  returns uuid[]
  language sql stable
  as $$
    select coalesce(array_agg(distinct a.age_group_id), '{}'::uuid[])
      from coach_group_assignments a
     where a.coach_user_id = app.app_user_id()
       and a.assigned_from <= on_date
       and (a.assigned_to is null or a.assigned_to >= on_date)
  $$;

-- ---------------------------------------------------------------------------
-- Row level security (DATABASE §7). Every table is ENABLE + FORCE.
-- ---------------------------------------------------------------------------
alter table age_groups              enable row level security;
alter table age_groups              force row level security;
alter table group_fees              enable row level security;
alter table group_fees              force row level security;
alter table coach_group_assignments enable row level security;
alter table coach_group_assignments force row level security;
alter table players                 enable row level security;
alter table players                 force row level security;
alter table player_group_history    enable row level security;
alter table player_group_history    force row level security;
alter table guardians               enable row level security;
alter table guardians               force row level security;
alter table player_guardians        enable row level security;
alter table player_guardians        force row level security;
alter table import_batches          enable row level security;
alter table import_batches          force row level security;

do $$
declare t text;
begin
  foreach t in array array[
    'age_groups','group_fees','coach_group_assignments','players',
    'player_group_history','guardians','player_guardians','import_batches'
  ] loop
    execute format(
      'create policy %I on %I to ia_migrator using (true) with check (true)',
      t || '_migrator_all', t);
  end loop;
end
$$;

-- Owner: full access to everything in this migration.
do $$
declare t text;
begin
  foreach t in array array[
    'age_groups','group_fees','coach_group_assignments','players',
    'player_group_history','guardians','player_guardians','import_batches'
  ] loop
    execute format(
      'create policy %I on %I to ia_app using (app.app_role() = ''owner'') with check (app.app_role() = ''owner'')',
      t || '_owner_all', t);
  end loop;
end
$$;

-- Coach: assigned age groups only, and only the projections AUTH §4 grants them.
create policy age_groups_coach_read on age_groups for select to ia_app using (
  app.app_role() = 'coach'
  and id = any (app.app_coach_group_ids(current_date))
);

create policy coach_assign_coach_read on coach_group_assignments for select to ia_app using (
  app.app_role() = 'coach' and coach_user_id = app.app_user_id()
);

-- A coach reaches a player only through a group they are assigned to today. An
-- out-of-scope id matches no policy and is invisible, which is why the API can
-- answer 404 without confirming existence.
create policy players_coach_read on players for select to ia_app using (
  app.app_role() = 'coach'
  and exists (
    select 1
      from player_group_history h
     where h.player_id = players.id
       and h.effective_from <= current_date
       and (h.effective_to is null or h.effective_to >= current_date)
       and h.age_group_id = any (app.app_coach_group_ids(current_date))
  )
);

create policy player_group_history_coach_read on player_group_history for select to ia_app using (
  app.app_role() = 'coach'
  and age_group_id = any (app.app_coach_group_ids(current_date))
);

-- `guardians`, `player_guardians`, `group_fees` and `import_batches` have no coach
-- policy: a coach is denied outright, and a guardian phone reaches them only through
-- the explicit projection the API builds when coach_can_see_guardian_phone is true.

-- ---------------------------------------------------------------------------
-- Grants (DATABASE §7). ia_app never gets DELETE except on the one link table
-- GDN-04 removes from; people and financial rows stay undeletable.
-- ---------------------------------------------------------------------------
grant select, insert, update on age_groups              to ia_app;
grant select, insert, update on group_fees              to ia_app;
grant select, insert, update on coach_group_assignments to ia_app;
grant select, insert, update on players                 to ia_app;
grant select, insert, update on player_group_history    to ia_app;
grant select, insert, update on guardians               to ia_app;
grant select, insert, update, delete on player_guardians to ia_app;
grant select, insert, update on import_batches          to ia_app;

grant execute on function app.app_coach_group_ids(date) to ia_app;
grant execute on function app.set_updated_at() to ia_app;
grant execute on function app.bump_version() to ia_app;
