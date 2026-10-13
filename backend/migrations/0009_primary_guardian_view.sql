-- ---------------------------------------------------------------------------
-- 0009_primary_guardian_view — the narrow door a coach's projection needs.
--
-- Rollback: drop the view.
--
-- `guardians` and `player_guardians` carry no coach policy (DATABASE §7: guardian
-- data is owner-only), yet `PlayerCoachView.primaryGuardian` must appear when
-- `academy_settings.coach_can_see_guardian_phone` is true (OPEN-008). Rather than
-- widening a policy — which would hand a coach the whole guardian table — this is a
-- SECURITY DEFINER view owned by ia_migrator, exposing exactly two columns of the
-- primary link, in the same pattern as `app.academy_public`.
-- ---------------------------------------------------------------------------

create view app.player_primary_guardian with (security_invoker = false) as
  select pg.player_id,
         g.full_name,
         g.phone_e164
    from player_guardians pg
    join guardians g on g.id = pg.guardian_id
   where pg.is_primary;

grant select on app.player_primary_guardian to ia_app;
