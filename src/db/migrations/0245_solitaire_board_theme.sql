-- 0245_solitaire_board_theme.sql
--
-- CROSS-DEVICE SOLITAIRE TABLE THEME.
--
-- One nullable column on the account, not a new preferences table: the table
-- theme is a single catalog key (see src/lib/solitaire-duel/boardThemes.ts), so
-- a dedicated table would be a join and a row for one varchar.
--
--   NULL = the player has never chosen a table.
--   Otherwise = the key of one of the presets.
--
-- NULL and 'classic' are deliberately different. NULL lets the client upload a
-- guest's local choice the first time they sign in, instead of silently
-- replacing it with the default; 'classic' is an explicit choice that must win
-- on every other device.
--
-- Additive and idempotent: no default (so existing accounts keep NULL), no
-- backfill, no rewrite. Written only through /api/solitaire/board-theme after
-- the key is validated against the catalog, so a stale/unknown key can never
-- reach the renderer (and is read back as NULL if one ever did).
--
-- No RLS change: `users` is already server-only (table owner bypasses RLS) and
-- this column is never read by the browser directly.

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "solitaire_board_theme" varchar(20);
