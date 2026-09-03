-- 0137_prestige_badge.sql
--
-- Equip preference for showing the "Prestige N" badge instead of the normal
-- title. Mirrors the existing users.selected_* preference columns (selected
-- title / special title / streak type): it is a user PREFERENCE, never the
-- source of truth for the prestige level itself.
--
--   * show_prestige_badge = true  → the player wants [Prestige N] shown
--   * The N is ALWAYS derived server-side from prestige_level (migration
--     0136). The client can only toggle the boolean; it can never claim a
--     prestige level.
--   * Read paths ignore the flag unless the player is genuinely eligible
--     (Battle Pass Level 100, XP-derived) and has prestige >= 1, so an
--     unearned badge can never be displayed — see resolvePrestigeBadge in
--     src/lib/prestige.js.
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "show_prestige_badge" BOOLEAN NOT NULL DEFAULT false;
