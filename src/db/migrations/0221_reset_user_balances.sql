-- 0221_reset_user_balances.sql
--
-- ECONOMY RESET (one-off data migration): every existing account goes back to
-- the balance a new account opens with — STARTING_COINS = 1000 in
-- src/lib/games/economy.ts, which is also the `users.balance` default in
-- src/db/schema.ts.
--
-- The previous economy left most wallets parked at the 100,000 wallet ceiling
-- (the one-time clamp applied by 0212), so this migration resets the spendable
-- balance for EVERY account to 1000.00, including accounts currently below it.
--
-- Deliberately NOT touched:
--   * users.peak_balance — the "Highest All-Time Coins" leaderboard ranks a
--     historical high-water mark, not the spendable wallet. Keeping it means
--     this reset does not rewrite past records.
--   * user_secret_stats.last_known_balance / day_start_balance — derived
--     snapshots for the loss/title checks. They refresh from the real balance
--     on the next tracked action.
--   * token_transactions — the ledger records real purchases and spends; there
--     is no "adjustment" transaction type, and an economy reset is not a
--     purchase.
--
-- Idempotent: the WHERE means a second run touches no rows. This changes data
-- only — the `users.balance` default and the schema are unchanged.

UPDATE "users"
  SET "balance" = 1000.00
  WHERE "balance" <> 1000.00;
