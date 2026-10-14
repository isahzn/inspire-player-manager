-- ---------------------------------------------------------------------------
-- 0017_owner_invariant_bootstrap — the owner invariant must not block the
-- one-time bootstrap that creates the academy's first owner.
--
-- Rollback: re-apply the 0006 definition of app.users_require_active_owner().
--
-- 0002/0006 raise LAST_OWNER whenever `users` holds zero rows with
-- `role = 'owner' and status = 'active'`, and the deferred constraint trigger
-- evaluates that on **every** insert/update/delete. On a fresh database there
-- is no owner at all, so the very first bootstrap died at COMMIT with 23514:
-- `create-owner` inserts the owner as `invited` by design (they set their own
-- password from a 72 h single-use link — DEPLOYMENT_AND_OPERATIONS §9.2), and
-- an `invited` row is not an `active` one. The first owner could therefore
-- never be created — the deployment runbook's step 9 could not succeed.
--
-- A guard against *removing* the last owner should fire when an ACTIVE owner is
-- taken out of that state, not when a row that was never an active owner is
-- written. This redefinition keeps T-AUTH-07 exactly — the last active owner
-- cannot be disabled, demoted or deleted, and two concurrent demotions still
-- serialize through the advisory lock and leave >= 1 — while letting the
-- bootstrap insert its first, still-`invited`, owner.
--
-- The advisory lock and the deferred SECURITY DEFINER evaluation are unchanged
-- from 0006: the count must see every owner row, not the caller's RLS view.
-- ---------------------------------------------------------------------------

create or replace function app.users_require_active_owner() returns trigger
  language plpgsql
  security definer
  set search_path = public, app
  as $$
  declare
    remaining integer;
  begin
    -- Adding a row can never remove the last active owner (this is the
    -- bootstrap: `create-owner` inserts the first owner as `invited`).
    if tg_op = 'INSERT' then
      return null;
    end if;

    -- Only a row that WAS an active owner can be lost by this statement.
    if not (old.role = 'owner' and old.status = 'active') then
      return null;
    end if;

    -- ...and only if the statement actually takes it out of that state
    -- (e.g. a sign-in touching `last_login_at` leaves it an active owner).
    if tg_op = 'UPDATE' and new.role = 'owner' and new.status = 'active' then
      return null;
    end if;

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

-- Trigger functions are not privilege-checked per row, but EXECUTE is required
-- to create the trigger and PUBLIC must not inherit it by default (0006).
revoke all on function app.users_require_active_owner() from public;
grant execute on function app.users_require_active_owner() to ia_app;
grant execute on function app.users_require_active_owner() to ia_migrator;
