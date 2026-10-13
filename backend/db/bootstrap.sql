-- ---------------------------------------------------------------------------
-- Bootstrap (run ONCE per database, as a superuser) — DATABASE §7.
--
-- Creates the two runtime roles and the extensions the schema needs. This is not a
-- migration: managed Postgres providers hand you a privileged role for exactly this
-- step, and it must be re-runnable. `backend/scripts/bootstrap-roles.ts` runs it
-- against every database in the environment.
--
--   ia_migrator : owns objects, runs migrations, no BYPASSRLS.
--   ia_app      : the runtime role. No DDL, no BYPASSRLS, not a table owner.
--                 audit_logs / message_events are INSERT + SELECT only.
--
-- Passwords are supplied by the caller (ALTER ROLE below); nothing is hardcoded.
-- ---------------------------------------------------------------------------

-- Roles are cluster-wide, so this block is idempotent rather than guarded by IF NOT EXISTS.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'ia_migrator') then
    create role ia_migrator login nosuperuser nocreatedb nocreaterole nobypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'ia_app') then
    create role ia_app login nosuperuser nocreatedb nocreaterole nobypassrls;
  end if;
end
$$;

-- Extensions (DATABASE §1). citext = case-insensitive usernames; pg_trgm = fuzzy
-- duplicate detection; btree_gist = effective-dated exclusion constraints;
-- pgcrypto = audit hash chain + TOTP secret encryption.
create extension if not exists citext;
create extension if not exists pg_trgm;
create extension if not exists btree_gist;
create extension if not exists pgcrypto;

-- PG 15+ removed CREATE on schema public from PUBLIC, so grant it explicitly.
grant usage, create on schema public to ia_migrator;
grant usage on schema public to ia_app;

-- The runtime role must never be able to create objects or drop the schema.
revoke create on schema public from ia_app;

-- Belt and braces: prove at bootstrap time that the runtime role cannot bypass RLS.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'ia_app' and rolbypassrls) then
    raise exception 'ia_app must not have BYPASSRLS (DATABASE §7)';
  end if;
end
$$;
