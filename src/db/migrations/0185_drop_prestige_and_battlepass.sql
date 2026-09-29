-- 0185: Remove the Prestige system and the Battle Pass claim journal.
--
-- PRESTIGE — the derived Elo-−-1000 layer is retired entirely. Elo itself is
-- kept and is now openly visible (src/lib/rating.js); there is no prestige
-- column, preference or journal any more. The three `users` columns (already
-- inert since the derived rewrite) and the `prestige_results` journal go.
--
-- BATTLE PASS — the whole system is removed. `battlepass_claims` recorded
-- which functional rewards a player had claimed per level; with the pass gone
-- nothing reads it. Reward ownership that players already earned lives in
-- `user_emotes` / `user_glows` / `user_cosmetics` / `user_special_titles` and
-- is untouched (migration 0186 additionally grants the whole catalog to
-- everyone). The legacy `users.level` / `users.xp` counters are left in place
-- but are no longer driven by a Battle Pass.
--
-- Idempotent: safe to run repeatedly.

ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_prestige_level_nonneg";
--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_prestige_net_wins_nonneg";
--> statement-breakpoint
ALTER TABLE "users"
  DROP COLUMN IF EXISTS "prestige_level",
  DROP COLUMN IF EXISTS "prestige_net_wins",
  DROP COLUMN IF EXISTS "show_prestige_badge";
--> statement-breakpoint
DROP TABLE IF EXISTS "prestige_results";
--> statement-breakpoint
DROP TABLE IF EXISTS "battlepass_claims";
