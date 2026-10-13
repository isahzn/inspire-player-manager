-- ---------------------------------------------------------------------------
-- 0006_owner_invariant_visibility — fix: the owner invariant must not read
-- through the caller's RLS view.
--
-- Rollback: recreate `app.users_require_active_owner()` without SECURITY DEFINER
-- (see 0002) and drop this file from the migration table.
--
-- The deferred constraint trigger from 0002 fires on **every** insert/update/delete
-- of `users`. Its `select count(*) from users where role = 'owner' ...` was executed
-- with the invoker's rights, so when a coach wrote to their own row (sign-in updates
-- `last_login_at`; AUTH-04 changes the password; AUTH-02 rotates a session) the count
-- ran through `users_self_read`/`users_self_update` — a coach sees only their own row —
-- and the transaction died at COMMIT with a spurious LAST_OWNER (23514). Every coach
-- sign-in returned 500.
--
-- The invariant is a whole-table assertion, not a user-scoped read: it must be
-- evaluated with the rights of the object owner, exactly like the pre-auth helpers in
-- 0004. `ia_migrator` owns the table and holds the blanket `users_migrator_all` policy
-- (0002), so under SECURITY DEFINER the count sees every owner row. FORCE ROW LEVEL
-- SECURITY is deliberately *not* lifted for anyone else: `ia_app` still cannot read
-- another user's row through any path but these two functions.
-- ---------------------------------------------------------------------------

create or replace function app.users_require_active_owner() returns trigger
  language plpgsql
  security definer
  set search_path = public, app
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

-- Trigger functions are not privilege-checked per row, but EXECUTE is required to
-- create the trigger and PUBLIC must not inherit it by default.
revoke all on function app.users_require_active_owner() from public;
grant execute on function app.users_require_active_owner() to ia_app;
grant execute on function app.users_require_active_owner() to ia_migrator;
