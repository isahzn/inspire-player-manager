-- ---------------------------------------------------------------------------
-- 0003_messaging_config — owner-configurable reference data that the platform
-- seeds and the settings endpoints manage (DATABASE §3.3, §3.6).
--
-- These are config tables, not the queue: message_jobs/message_events arrive in M7.
-- Rollback: drop in reverse order (message_templates → reminder_rules → payment_methods).
-- ---------------------------------------------------------------------------

create table payment_methods (
  code               text primary key,
  label              text not null,
  requires_reference boolean not null default false,
  is_active          boolean not null default true,
  sort_order         smallint not null default 0
);

create table reminder_rules (
  id          uuid primary key,
  kind        text not null check (kind in ('pre_due','overdue')),
  offset_days smallint not null check (offset_days between 0 and 120),
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint reminder_rules_kind_offset_uq unique (kind, offset_days)
);

create table message_templates (
  key        text primary key check (key in ('invoice_delivery','reminder_pre_due','reminder_overdue')),
  body       text not null,
  locale     text not null default 'en',
  is_active  boolean not null default true,
  updated_by uuid,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Row level security: configuration is owner-only (DATABASE §7)
-- ---------------------------------------------------------------------------
alter table payment_methods  enable row level security;
alter table payment_methods  force row level security;
alter table reminder_rules   enable row level security;
alter table reminder_rules   force row level security;
alter table message_templates enable row level security;
alter table message_templates force row level security;

do $$
declare t text;
begin
  foreach t in array array['payment_methods','reminder_rules','message_templates'] loop
    execute format(
      'create policy %I on %I to ia_migrator using (true) with check (true)',
      t || '_migrator_all', t);
    execute format(
      'create policy %I on %I to ia_app using (app.app_role() = ''owner'') with check (app.app_role() = ''owner'')',
      t || '_owner_all', t);
  end loop;
end
$$;

grant select, insert, update on payment_methods to ia_app;
grant select, insert, update on reminder_rules to ia_app;
grant select, insert, update on message_templates to ia_app;
