-- ---------------------------------------------------------------------------
-- 0008_academy_coach_context — widen the coach-facing academy view.
--
-- Rollback: restore the 0002 definition (drop the three added columns).
--
-- Why: M3's coach projections need two academy settings that a coach may not read
-- from `academy_settings` (FORCE ROW LEVEL SECURITY, owner-only):
--   * `age_reference_rule` (+ its month/day) to compute a player's age for the
--     restricted `PlayerCoachView.age`;
--   * `coach_can_see_guardian_phone` to decide whether the primary guardian's
--     phone may appear in that same projection (OPEN-008).
-- `app.academy_public` already exists for exactly this purpose (a narrow,
-- SECURITY DEFINER view owned by ia_migrator), so the columns are appended to it
-- rather than adding a second view. Nothing billing-related is exposed.
-- ---------------------------------------------------------------------------

create or replace view app.academy_public with (security_invoker = false) as
  select name,
         short_name,
         timezone,
         logo_file_id,
         age_reference_rule,
         age_reference_month_day,
         coach_can_see_guardian_phone
    from academy_settings
   where id = 1;

grant select on app.academy_public to ia_app;
