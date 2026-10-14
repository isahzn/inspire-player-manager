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
--   ia_backup   : the ONLY role with BYPASSRLS, and the only one that may take the nightly
--                 logical dump. Read-only over data, no DDL, no password until
--                 DATABASE_BACKUP_URL supplies one.
--
-- Passwords are supplied by the caller (ALTER ROLE below); nothing is hardcoded.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Why a third role exists, and why it is the one exception to "no BYPASSRLS (DATABASE §7)"
--
-- `pg_dump` starts with `set row_security = off`. That is deliberate on PostgreSQL's part: it
-- refuses to emit an archive that is quietly missing rows it was not allowed to read. The
-- consequence is that against a table with **FORCE ROW LEVEL SECURITY** the dump fails unless
-- the dumping role is *exempt* from RLS — a superuser, or a role with BYPASSRLS.
--
-- Every table in this schema is FORCE ROW LEVEL SECURITY, and `ia_migrator` is deliberately not
-- exempt (0016 says so, and gives the reason). So the migrator can read every row through its
-- own blanket policy and still be unable to dump the table: the first deployment's nightly
-- backup died inside `academy_settings` with
-- `query would be affected by row-level security policy` — after writing a partial archive
-- (handoff §12.4).
--
-- The alternatives were worse. Granting BYPASSRLS to `ia_migrator` would void the guarantee
-- 0016 relies on. Using the superuser would put credentials that can read *every* database and
-- the server's filesystem inside the worker container, for a job that runs unattended every
-- night. This role instead has exactly the one privilege the dump needs and nothing else:
-- `pg_read_all_data` (PG 14+) is read access to every table and sequence, `BYPASSRLS` is what
-- makes it readable under `row_security = off`, and it can neither write, nor create, nor
-- connect as anything else.
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
  if not exists (select 1 from pg_roles where rolname = 'ia_backup') then
    create role ia_backup login nosuperuser nocreatedb nocreaterole bypassrls;
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

-- Belt and braces: prove at bootstrap time that the role that talks to the database on a user's
-- behalf cannot bypass RLS, and that the one role which must be able to can. A future edit that
-- swaps these two flags would otherwise only be noticed by a dump that produced a partial
-- archive.
do $$
begin
  if exists (select 1 from pg_roles where rolname in ('ia_app', 'ia_migrator') and rolbypassrls) then
    raise exception 'ia_app and ia_migrator must not have BYPASSRLS (DATABASE §7)';
  end if;
  if exists (select 1 from pg_roles where rolname = 'ia_backup' and not rolbypassrls) then
    raise exception 'ia_backup must have BYPASSRLS, or pg_dump cannot read a FORCE RLS table';
  end if;
end
$$;

-- The dump role's read grant. `pg_read_all_data` is a predefined role (PG 14+): membership is
-- resolved dynamically, so it covers the tables a later migration creates without this file
-- having to be re-run. It confers no write, no DDL and no superuser.
grant pg_read_all_data to ia_backup;
