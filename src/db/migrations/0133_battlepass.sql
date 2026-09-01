-- Battlepass: the wager-based VIP levels are replaced by an EXP-driven
-- 100-level track. XP comes from wagering (1 XP per 10 tokens) and quest
-- claims (see src/lib/battlepass.js for the curve).
--
-- This migration converts each player's historical wagering into XP so
-- nobody loses progress: xp = GREATEST(xp, total_wagered / 10), and the
-- level column is recomputed from that XP using the closed form of
-- cumulative(level) = 5 * (level - 1) * (level + 28):
--
--   level = LEAST(100, GREATEST(1, FLOOR((SQRT(21025 + 20 * xp) - 135) / 10)))
--
-- GREATEST() keeps the backfill idempotent — re-running it never lowers XP.
--
-- Overflow guards (ERROR 22003 "integer out of range"):
--   * `xp` is an INTEGER column, so the backfill is clamped to
--     2147483647 via LEAST(FLOOR(...), 2147483647)::int.
--   * `20 * xp` in the level formula is cast to BIGINT so the
--     multiplication cannot overflow INTEGER arithmetic.

UPDATE users u
SET xp = GREATEST(u.xp, b.backfill_xp),
    level = LEAST(100, GREATEST(1, FLOOR((SQRT(21025 + 20 * GREATEST(u.xp, b.backfill_xp)::bigint) - 135) / 10)::int))
FROM (
  SELECT id, LEAST(FLOOR(total_wagered / 10), 2147483647)::int AS backfill_xp
  FROM users
) b
WHERE u.id = b.id;

UPDATE user_stats s
SET xp = GREATEST(s.xp, b.backfill_xp),
    level = LEAST(100, GREATEST(1, FLOOR((SQRT(21025 + 20 * GREATEST(s.xp, b.backfill_xp)::bigint) - 135) / 10)::int))
FROM (
  SELECT user_id, LEAST(FLOOR(total_wagered / 10), 2147483647)::int AS backfill_xp
  FROM user_stats
) b
WHERE s.user_id = b.user_id;
