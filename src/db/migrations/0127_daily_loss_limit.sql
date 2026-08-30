-- 0127: Per-player daily loss limit (responsible-play setting).
--
-- NULL  → use the global soft-warning default (DAILY_LOSS_WARNING_THRESHOLD).
-- 0     → warnings disabled entirely for this player.
-- > 0   → custom daily-loss threshold in tokens; the lobby warns (soft, never
--         blocks) once the player is down more than this in a single day.
-- Idempotent: safe to run repeatedly.

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "daily_loss_limit" integer;
