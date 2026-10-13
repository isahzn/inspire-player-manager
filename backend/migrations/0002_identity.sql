-- ---------------------------------------------------------------------------
-- 0002_identity — academy settings, users, sessions, invites (DATABASE §3.1).
--
-- Rollback: new tables; a compensating migration drops them in reverse order.
-- `users` is referenced by document_counters/files.uploaded_by only as a bare uuid
-- (no FK yet), so dropping is safe before M3 adds the people tables.
--
-- Deliberate addition, flagged in the M2 handoff §4: `academy_settings.beneficiary_accounts`.
-- PAYMENT_VERIFICATION §3 requires the academy's own accounts so a bank receipt's
-- beneficiary can be cross-checked, and the API exposes it (SET-01 / AcademySettings),
-- but DATABASE §3.1 has no column for it. Stored as jsonb.
-- ---------------------------------------------------------------------------

create table academy_settings (
  id                smallint primary key check (id = 1),   -- single academy (ADR-015)
  name              text not null,
  short_name        text,
  address           text,
  phone             text,
  email             citext,
  timezone          text not null default 'Asia/Colombo',
  currency          char(3) not null default 'LKR' check (currency = 'LKR'),
  logo_file_id      uuid references files (id),
  payment_instructions text,
  beneficiary_accounts jsonb not null default '[]'::jsonb,   -- [{ "name": …, "accountMasked": … }]
  billing_frequency     text not null default 'monthly' check (billing_frequency in ('weekly','monthly')),
  billing_period_mode   text not null default 'calendar' check (billing_period_mode in ('anchored','calendar')),
  week_start_day        smallint not null default 1 check (week_start_day between 1 and 7),
  invoice_issue_timing  text not null default 'period_start' check (invoice_issue_timing in ('period_start','period_end')),
  due_rule_type         text not null default 'days_after_issue'
                          check (due_rule_type in ('days_after_issue','days_after_period_start','fixed_day_of_month')),
  due_rule_value        smallint not null default 7 check (due_rule_value between 0 and 31),
  age_reference_rule    text not null default 'jan_1_of_year'
                          check (age_reference_rule in ('jan_1_of_year','fixed_month_day','today')),
  age_reference_month_day text,
  allow_fractional_money boolean not null default false,
  coach_can_see_guardian_phone boolean not null default false,
  attendance_coach_edit_window_hours smallint not null default 24 check (attendance_coach_edit_window_hours >= 0),
  coach_checkin_opens_minutes_before smallint not null default 60 check (coach_checkin_opens_minutes_before >= 0),
  coach_checkin_closes_minutes_after_end smallint not null default 120 check (coach_checkin_closes_minutes_after_end >= 0),
  -- Master pause (MSG-07) and the per-automation switches (SET-08, CR-003/ADR-019).
  -- All default false: automation is opt-in, and CR-003 is still awaiting approval.
  messaging_automation_enabled boolean not null default false,
  messaging_automation_invoice_delivery boolean not null default false,
  messaging_automation_reminder_pre_due boolean not null default false,
  messaging_automation_reminder_overdue boolean not null default false,
  messaging_automation_proof_check boolean not null default false,
  messaging_send_window_start time not null default '09:00',
  messaging_send_window_end   time not null default '19:00',
  messaging_provider text not null default 'openwa',
  messaging_invoice_mode text not null default 'link' check (messaging_invoice_mode in ('link','attachment_and_link')),
  messaging_pacing_min_seconds smallint not null default 20 check (messaging_pacing_min_seconds >= 0),
  messaging_pacing_max_seconds smallint not null default 60 check (messaging_pacing_max_seconds >= 0),
  messaging_max_per_hour smallint not null default 40 check (messaging_max_per_hour > 0),
  messaging_opt_out_keywords text[] not null default '{STOP}',
  invoice_link_ttl_days smallint not null default 30 check (invoice_link_ttl_days > 0),
  updated_by uuid,
  updated_at timestamptz not null default now(),
  constraint academy_settings_due_rule_fixed_day check (
    due_rule_type <> 'fixed_day_of_month'
    or (billing_frequency = 'monthly' and due_rule_value between 1 and 28)
  ),
  constraint academy_settings_age_reference_md check (
    age_reference_rule <> 'fixed_month_day'
    or age_reference_month_day ~ '^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'
  )
);

-- ---------------------------------------------------------------------------
-- users (DATABASE §3.1, ADR-018: `username` is the login identifier)
-- ---------------------------------------------------------------------------
create table users (
  id                  uuid primary key,
  username            citext not null unique check (username ~ '^[a-z0-9._-]{3,32}$'),
  full_name           text not null check (length(btrim(full_name)) between 1 and 120),
  phone_e164          text check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  role                text not null check (role in ('owner','coach')),
  status              text not null check (status in ('invited','active','disabled')),
  password_hash       text,                       -- argon2id; null while invited
  failed_login_count  smallint not null default 0 check (failed_login_count >= 0),
  locked_until        timestamptz,
  last_login_at       timestamptz,
  password_changed_at timestamptz,
  totp_secret_enc     bytea,
  totp_enabled        boolean not null default false,
  created_by          uuid,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint users_username_lowercase check (username = lower(username::text)::citext)
);
create index users_role_status_idx on users (role, status);

-- Usernames are immutable in v1 (ADR-018): a rename is a new user + re-invite,
-- otherwise a session, invite or audit trail could silently point at a different
-- identity than the one that was handed out.
create or replace function app.users_username_immutable() returns trigger
  language plpgsql
  as $$
  begin
    if new.username is distinct from old.username then
      raise exception 'users.username is immutable in v1 (ADR-018); create a new user instead'
        using errcode = '23514';
    end if;
    return new;
  end
  $$;

create trigger users_username_immutable_trg
  before update on users
  for each row execute function app.users_username_immutable();

-- At least one active owner must always exist (AUTH §1, T-AUTH-07).
--
-- A deferred constraint trigger runs at COMMIT, and the advisory lock serializes
-- concurrent owner changes so two transactions cannot each remove "the other"
-- owner and leave zero. Re-reading inside the trigger with READ COMMITTED takes a
-- fresh snapshot, so it sees a concurrent transaction that committed meanwhile.
create or replace function app.users_require_active_owner() returns trigger
  language plpgsql
  as $$
  declare
    remaining integer;
  begin
    perform pg_advisory_xact_lock(hashtext('ia:owner-invariant'));
    select count(*) into remaining
      from users
     where role = 'owner' and status = 'active';
    if remaining = 0 then
      raise exception 'at least one active owner must exist (LAST_OWNER)'
        using errcode = '23514';
    end if;
    return null;
  end
  $$;

create constraint trigger users_require_active_owner_trg
  after insert or update or delete on users
  deferrable initially deferred
  for each row execute function app.users_require_active_owner();

-- ---------------------------------------------------------------------------
-- user_sessions (DATABASE §3.1) — only the SHA-256 of the token is stored
-- ---------------------------------------------------------------------------
create table user_sessions (
  id                text primary key,              -- sha256(token); raw token lives only in the cookie
  user_id           uuid not null references users (id),
  created_at        timestamptz not null default now(),
  last_seen_at      timestamptz not null default now(),
  expires_at        timestamptz not null,
  idle_expires_at   timestamptz not null,
  ip                inet,
  user_agent        text,
  revoked_at        timestamptz,
  revoked_reason    text
);
create index user_sessions_user_idx on user_sessions (user_id) where revoked_at is null;
create index user_sessions_expiry_idx on user_sessions (expires_at);

-- ---------------------------------------------------------------------------
-- user_invites (DATABASE §3.1) — single use, 72 h
-- ---------------------------------------------------------------------------
create table user_invites (
  id          uuid primary key,
  user_id     uuid not null references users (id),
  token_hash  text not null unique,
  purpose     text not null check (purpose in ('invite','password_reset')),
  expires_at  timestamptz not null,
  used_at     timestamptz,
  created_by  uuid,
  created_at  timestamptz not null default now()
);
create index user_invites_user_idx on user_invites (user_id);

-- ---------------------------------------------------------------------------
-- Row level security (DATABASE §7)
-- ---------------------------------------------------------------------------
alter table academy_settings enable row level security;
alter table academy_settings force row level security;
alter table users            enable row level security;
alter table users            force row level security;
alter table user_sessions    enable row level security;
alter table user_sessions    force row level security;
alter table user_invites     enable row level security;
alter table user_invites     force row level security;

do $$
declare t text;
begin
  foreach t in array array['academy_settings','users','user_sessions','user_invites'] loop
    execute format(
      'create policy %I on %I to ia_migrator using (true) with check (true)',
      t || '_migrator_all', t);
  end loop;
end
$$;

-- academy_settings: owner only. Coaches read name/logo/timezone through the
-- column-limited view below, never the table (their policy would leak billing config).
create policy academy_settings_owner_all on academy_settings to ia_app
  using (app.app_role() = 'owner') with check (app.app_role() = 'owner');

-- users: owner manages everyone; a user may read and update their own row.
create policy users_owner_all on users to ia_app
  using (app.app_role() = 'owner') with check (app.app_role() = 'owner');
create policy users_self_read on users for select to ia_app
  using (id = app.app_user_id());
create policy users_self_update on users for update to ia_app
  using (id = app.app_user_id()) with check (id = app.app_user_id());

-- sessions/invites: an owner may see everything (user admin); a user only their own.
create policy user_sessions_owner_all on user_sessions to ia_app
  using (app.app_role() = 'owner') with check (app.app_role() = 'owner');
create policy user_sessions_self on user_sessions to ia_app
  using (user_id = app.app_user_id()) with check (user_id = app.app_user_id());
create policy user_invites_owner_all on user_invites to ia_app
  using (app.app_role() = 'owner') with check (app.app_role() = 'owner');

-- Column-limited view for the coach-facing academy summary (DATABASE §7).
-- security_invoker = false: the view runs as its owner (ia_migrator), which holds
-- the blanket policy, so a coach can read exactly these columns and nothing else.
create view app.academy_public with (security_invoker = false) as
  select name, short_name, timezone, logo_file_id from academy_settings where id = 1;

grant usage on schema app to ia_app;
grant select on app.academy_public to ia_app;

-- ---------------------------------------------------------------------------
-- Grants: ia_app never gets DELETE (people and financial rows are never hard-deleted).
-- ---------------------------------------------------------------------------
grant select, insert, update on academy_settings to ia_app;
grant select, insert, update on users to ia_app;
grant select, insert, update on user_sessions to ia_app;
grant select, insert, update on user_invites to ia_app;
grant execute on function app.users_username_immutable() to ia_app;
