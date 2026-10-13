-- ---------------------------------------------------------------------------
-- 0004_preauth_helpers — the two lookups that must work *before* an identity exists.
--
-- Rollback: drop the functions and restore the stricter audit policy.
--
-- Why this is needed: RLS on `user_sessions` and `users` is identity-based, and at
-- login time there is no identity yet. Widening those policies to "any caller may read
-- any row" would hand the runtime role the whole user table, so instead each lookup is
-- a narrow SECURITY DEFINER function owned by ia_migrator (which holds the blanket
-- policy). EXECUTE is revoked from PUBLIC — PostgreSQL grants it to PUBLIC by default,
-- which would otherwise expose the password hash to any role in the database.
-- ---------------------------------------------------------------------------

-- 1. Failed logins are audited with no actor and must still be writable: the append
--    policy must not depend on an identity. Append-only (no UPDATE/DELETE grant and a
--    trigger that refuses both) is what protects the trail, not the actor check.
drop policy if exists audit_append on audit_logs;
create policy audit_append on audit_logs for insert to ia_app with check (true);

-- 2. Resolve a session token hash to its live session and user.
create or replace function app.resolve_session(p_session_id text)
  returns table (
    session_id text,
    user_id uuid,
    role text,
    status text,
    idle_expires_at timestamptz,
    expires_at timestamptz
  )
  language sql stable security definer
  set search_path = public, app
  as $$
    select s.id, s.user_id, u.role::text, u.status::text, s.idle_expires_at, s.expires_at
      from user_sessions s
      join users u on u.id = s.user_id
     where s.id = p_session_id
       and s.revoked_at is null
       and s.expires_at > now()
       and s.idle_expires_at > now()
  $$;

-- 3. Find a user for sign-in. Exact username match only (case-insensitive via citext);
--    no wildcard, no pagination, no way to enumerate.
create or replace function app.find_user_for_login(p_username citext)
  returns table (
    id uuid,
    username citext,
    full_name text,
    phone_e164 text,
    role text,
    status text,
    password_hash text,
    failed_login_count smallint,
    locked_until timestamptz,
    totp_enabled boolean,
    totp_secret_enc bytea,
    last_login_at timestamptz
  )
  language sql stable security definer
  set search_path = public, app
  as $$
    select u.id, u.username, u.full_name, u.phone_e164, u.role::text, u.status::text,
           u.password_hash, u.failed_login_count, u.locked_until, u.totp_enabled,
           u.totp_secret_enc, u.last_login_at
      from users u
     where u.username = p_username
  $$;

-- Lock down execution: PUBLIC must not be able to call these.
revoke all on function app.resolve_session(text) from public;
revoke all on function app.find_user_for_login(citext) from public;
grant execute on function app.resolve_session(text) to ia_app;
grant execute on function app.find_user_for_login(citext) to ia_app;
grant execute on function app.resolve_session(text) to ia_migrator;
grant execute on function app.find_user_for_login(citext) to ia_migrator;
