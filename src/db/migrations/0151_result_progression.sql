-- 0151: Result-screen progression data.
--
-- Every settled wager funnels through applyLeaderboardCounters, which is
-- the single place XP and the weekly win/loss counters are written. These
-- four columns persist the facts of the MOST RECENT settlement so the
-- shared PvpResultScreen can show real "+N XP" and "RANK ↑ N" numbers
-- (read via /api/user/stats and /api/leaderboard/my-rank) without every
-- game's payload having to carry them:
--
--   last_settled_xp          XP granted by the last settlement (wager XP ×
--                            active boost — exactly what was added to xp).
--   last_settled_xp_at       When that grant happened. Result screens gate
--                            on this so a stale grant (old match, Monday
--                            weekly reset) is never shown as the current
--                            match's XP.
--   last_settled_wins_delta  Weekly-board win delta applied by the last
--                            settlement (1 on a win, else 0).
--   last_settled_losses_delta  Weekly-board loss delta (1 on a loss —
--                            including draw settlements that count as a
--                            loss in the weekly counters — else 0).
--
-- The rank-before/after deltas derived from these match the weekly board's
-- exact ordering (weekly_wins DESC, weekly_losses ASC, user_id ASC), so
-- "RANK ↑ N" is real movement, never invented.
--
-- Idempotent: safe to run repeatedly.

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "last_settled_xp" INTEGER,
  ADD COLUMN IF NOT EXISTS "last_settled_xp_at" TIMESTAMP,
  ADD COLUMN IF NOT EXISTS "last_settled_wins_delta" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "last_settled_losses_delta" INTEGER NOT NULL DEFAULT 0;