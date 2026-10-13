-- ---------------------------------------------------------------------------
-- 0005_invite_lookup — accepting an invite happens before any identity exists.
--
-- `user_invites` is owner-only under RLS (it holds single-use credentials), so
-- AUTH-05 cannot read it as the invitee. As with 0004, the lookup is a narrow
-- SECURITY DEFINER function instead of a widened policy, and consuming the invite is
-- permitted only for the row that belongs to the caller's own user id.
--
-- Rollback: drop the function and the self-consume policy.
-- ---------------------------------------------------------------------------

create or replace function app.find_invite(p_token_hash text)
  returns table (id uuid, user_id uuid, purpose text, expires_at timestamptz, used_at timestamptz)
  language sql stable security definer
  set search_path = public, app
  as $$
    select i.id, i.user_id, i.purpose::text, i.expires_at, i.used_at
      from user_invites i
     where i.token_hash = p_token_hash
  $$;

revoke all on function app.find_invite(text) from public;
grant execute on function app.find_invite(text) to ia_app;
grant execute on function app.find_invite(text) to ia_migrator;

-- The invitee may mark their own invite used (single use is enforced in the same
-- transaction by the `used_at is null` predicate).
create policy user_invites_self_consume on user_invites for update to ia_app
  using (user_id = app.app_user_id())
  with check (user_id = app.app_user_id());
