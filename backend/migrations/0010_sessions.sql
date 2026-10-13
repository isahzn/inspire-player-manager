-- ---------------------------------------------------------------------------
-- 0010_sessions — recurring training schedules and the sessions they produce
-- (DATABASE §3.5, M4).
--
-- Rollback: new tables; drop in reverse order (sessions → training_schedules).
-- `age_groups` and `users` are referenced by FK only.
--
-- Two rules the schema enforces rather than the API:
--   * `(schedule_id, session_date)` is unique among generated sessions, so SCH-02
--     is idempotent by construction and a second run cannot duplicate a session.
--   * `(age_group_id, starts_at)` is unique among non-cancelled sessions, so a
--     one-off session cannot collide with a generated one (409 SESSION_DUPLICATE).
--     Cancelling is how a collision is deliberately cleared.
--
-- Times: `training_schedules` holds academy-local `time` values; `sessions` holds
-- real instants. The conversion between them is done in SQL (`at time zone
-- academy_settings.timezone`) by the generator, never by the API guessing an offset.
-- ---------------------------------------------------------------------------

create table training_schedules (
  id           uuid primary key,
  age_group_id uuid not null references age_groups (id),
  weekday      smallint not null check (weekday between 1 and 7),   -- 1 = Monday (ISO)
  start_time   time not null,
  end_time     time not null,
  venue        text,
  valid_from   date not null,
  valid_to     date,
  is_active    boolean not null default true,
  created_by   uuid,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint training_schedules_period check (valid_to is null or valid_to >= valid_from),
  constraint training_schedules_time_order check (end_time > start_time),
  constraint training_schedules_venue_len check (venue is null or length(venue) <= 120)
);
create index training_schedules_group_idx on training_schedules (age_group_id);

create table sessions (
  id                  uuid primary key,
  age_group_id        uuid not null references age_groups (id),
  schedule_id         uuid references training_schedules (id),
  session_date        date not null,
  starts_at           timestamptz not null,
  ends_at             timestamptz not null,
  venue               text,
  status              text not null default 'scheduled'
                        check (status in ('scheduled','completed','cancelled')),
  cancel_reason       text,
  lead_coach_user_id  uuid references users (id),
  notes               text,
  created_by          uuid,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  version             integer not null default 1 check (version > 0),
  constraint sessions_time_order check (ends_at > starts_at),
  constraint sessions_venue_len check (venue is null or length(venue) <= 120),
  constraint sessions_cancel_reason_len check (cancel_reason is null or length(cancel_reason) <= 200)
);
-- SCH-02 idempotency: one generated session per schedule per date.
create unique index sessions_schedule_date_uq on sessions (schedule_id, session_date)
  where schedule_id is not null;
-- No two live sessions for a group at the same instant.
create unique index sessions_group_start_uq on sessions (age_group_id, starts_at)
  where status <> 'cancelled';
create index sessions_group_date_idx on sessions (age_group_id, session_date);
create index sessions_date_idx on sessions (session_date);

-- `updated_at` / `version` are trigger-maintained (0007), so no statement can
-- forget to bump them.
create trigger training_schedules_touch_trg before update on training_schedules
  for each row execute function app.set_updated_at();
create trigger sessions_version_trg before update on sessions
  for each row execute function app.bump_version();

-- ---------------------------------------------------------------------------
-- Row level security (DATABASE §7): both tables are owner-write, coach-read where
-- the group is assigned **on the session's own date** (SES-01/AUTH §6).
-- ---------------------------------------------------------------------------
alter table training_schedules enable row level security;
alter table training_schedules force row level security;
alter table sessions           enable row level security;
alter table sessions           force row level security;

create policy training_schedules_migrator_all on training_schedules to ia_migrator
  using (true) with check (true);
create policy sessions_migrator_all on sessions to ia_migrator
  using (true) with check (true);

create policy training_schedules_owner_all on training_schedules to ia_app
  using (app.app_role() = 'owner') with check (app.app_role() = 'owner');
create policy sessions_owner_all on sessions to ia_app
  using (app.app_role() = 'owner') with check (app.app_role() = 'owner');

-- A coach reaches a session only through an assignment held on that session's date;
-- the helper takes the date, so an ended assignment cannot leak a future session.
create policy training_schedules_coach_read on training_schedules for select to ia_app using (
  app.app_role() = 'coach'
  and age_group_id = any (app.app_coach_group_ids(current_date))
);
create policy sessions_coach_read on sessions for select to ia_app using (
  app.app_role() = 'coach'
  and age_group_id = any (app.app_coach_group_ids(session_date))
);

grant select, insert, update on training_schedules to ia_app;
grant select, insert, update on sessions to ia_app;
