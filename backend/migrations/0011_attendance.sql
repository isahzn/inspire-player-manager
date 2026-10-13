-- ---------------------------------------------------------------------------
-- 0011_attendance — player attendance and coach time (DATABASE §3.5, M4 second half).
--
-- Rollback: new tables; drop in reverse order (coach_attendance → player_attendance)
-- plus the three helper functions.
--
-- Three things are deliberately enforced here rather than only in the API:
--   * `(session_id, player_id)` is unique, so a bulk save is an upsert and a retried
--     `Idempotency-Key` cannot duplicate a mark.
--   * one open check-in per coach and one check-in per session (`coach_attendance`),
--     which is what makes "clock in twice" a 409 rather than a second row.
--   * the coach's **edit window** — reads are unscoped by time (a coach may look at an
--     old sheet) but writes are refused outside `starts_at + attendance_coach_edit_window_hours`
--     (ATTENDANCE §4). The window is read through a SECURITY DEFINER helper because the
--     hours live in the owner-only `academy_settings` table, which a coach may not read;
--     the API also checks it, so the refusal carries the documented 422.
-- ---------------------------------------------------------------------------

create table player_attendance (
  id          uuid primary key,
  session_id  uuid not null references sessions (id),
  player_id   uuid not null references players (id),
  status      text not null check (status in ('present','absent','late','excused')),
  note        text,
  marked_by   uuid not null,
  marked_at   timestamptz not null default now(),
  updated_by  uuid,
  updated_at  timestamptz not null default now(),
  version     integer not null default 1 check (version > 0),
  constraint player_attendance_session_player_uq unique (session_id, player_id),
  constraint player_attendance_note_len check (note is null or length(note) <= 500)
);
create index player_attendance_player_idx on player_attendance (player_id, session_id);

create table coach_attendance (
  id             uuid primary key,
  coach_user_id  uuid not null references users (id),
  session_id     uuid not null references sessions (id),
  check_in_at    timestamptz not null,
  check_out_at   timestamptz,
  check_in_note  text,
  entered_by     text not null check (entered_by in ('self','owner')),
  corrected      boolean not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  version        integer not null default 1 check (version > 0),
  constraint coach_attendance_session_uq unique (coach_user_id, session_id),
  constraint coach_attendance_order check (check_out_at is null or check_out_at > check_in_at),
  constraint coach_attendance_note_len check (check_in_note is null or length(check_in_note) <= 500)
);
-- One open check-in per coach: the partial unique index is the duplicate guard (T9).
create unique index coach_attendance_one_open on coach_attendance (coach_user_id)
  where check_out_at is null;
create index coach_attendance_session_idx on coach_attendance (session_id);

create trigger player_attendance_version_trg before update on player_attendance
  for each row execute function app.bump_version();
create trigger coach_attendance_version_trg before update on coach_attendance
  for each row execute function app.bump_version();

-- ---------------------------------------------------------------------------
-- Window helpers (SECURITY DEFINER, like the pre-auth helpers in 0004): a coach must
-- be able to test a window whose hours live in an owner-only table.
-- ---------------------------------------------------------------------------
create or replace function app.attendance_edit_window_hours() returns integer
  language sql stable security definer
  set search_path = public, app
  as $$ select coalesce((select attendance_coach_edit_window_hours from academy_settings where id = 1), 24) $$;

create or replace function app.attendance_editable_until(p_session_id uuid) returns timestamptz
  language sql stable security definer
  set search_path = public, app
  as $$
    select s.starts_at + (app.attendance_edit_window_hours() * interval '1 hour')
      from sessions s
     where s.id = p_session_id
  $$;

create or replace function app.coach_checkin_window(p_session_id uuid)
  returns table (opens_at timestamptz, closes_at timestamptz)
  language sql stable security definer
  set search_path = public, app
  as $$
    select s.starts_at - (a.coach_checkin_opens_minutes_before * interval '1 minute'),
           s.ends_at   + (a.coach_checkin_closes_minutes_after_end * interval '1 minute')
      from sessions s
      cross join academy_settings a
     where s.id = p_session_id and a.id = 1
  $$;

revoke all on function app.attendance_edit_window_hours() from public;
revoke all on function app.attendance_editable_until(uuid) from public;
revoke all on function app.coach_checkin_window(uuid) from public;
grant execute on function app.attendance_edit_window_hours() to ia_app, ia_migrator;
grant execute on function app.attendance_editable_until(uuid) to ia_app, ia_migrator;
grant execute on function app.coach_checkin_window(uuid) to ia_app, ia_migrator;

-- ---------------------------------------------------------------------------
-- Row level security (DATABASE §7)
-- ---------------------------------------------------------------------------
alter table player_attendance enable row level security;
alter table player_attendance force row level security;
alter table coach_attendance  enable row level security;
alter table coach_attendance  force row level security;

create policy player_attendance_migrator_all on player_attendance to ia_migrator
  using (true) with check (true);
create policy coach_attendance_migrator_all on coach_attendance to ia_migrator
  using (true) with check (true);

create policy player_attendance_owner_all on player_attendance to ia_app
  using (app.app_role() = 'owner') with check (app.app_role() = 'owner');
create policy coach_attendance_owner_all on coach_attendance to ia_app
  using (app.app_role() = 'owner') with check (app.app_role() = 'owner');

-- A coach may READ a sheet for a group they hold on that session's date, at any time.
create policy player_attendance_coach_read on player_attendance for select to ia_app using (
  app.app_role() = 'coach'
  and exists (
    select 1 from sessions s
     where s.id = player_attendance.session_id
       and s.age_group_id = any (app.app_coach_group_ids(s.session_date))
  )
);

-- ...but may only WRITE inside the edit window. The API checks the same rule so the
-- refusal is the documented 422 ATTENDANCE_WINDOW_CLOSED, not a silent zero rows.
create policy player_attendance_coach_insert on player_attendance for insert to ia_app with check (
  app.app_role() = 'coach'
  and exists (
    select 1 from sessions s
     where s.id = player_attendance.session_id
       and s.age_group_id = any (app.app_coach_group_ids(s.session_date))
  )
  and now() <= app.attendance_editable_until(player_attendance.session_id)
);

create policy player_attendance_coach_update on player_attendance for update to ia_app
  using (app.app_role() = 'coach' and now() <= app.attendance_editable_until(player_attendance.session_id))
  with check (
    app.app_role() = 'coach'
    and exists (
      select 1 from sessions s
       where s.id = player_attendance.session_id
         and s.age_group_id = any (app.app_coach_group_ids(s.session_date))
    )
    and now() <= app.attendance_editable_until(player_attendance.session_id)
  );

-- Coach time is self-reported: a coach sees and writes only their own rows.
create policy coach_attendance_self on coach_attendance to ia_app
  using (app.app_role() = 'coach' and coach_user_id = app.app_user_id())
  with check (app.app_role() = 'coach' and coach_user_id = app.app_user_id());

grant select, insert, update on player_attendance to ia_app;
grant select, insert, update on coach_attendance  to ia_app;
