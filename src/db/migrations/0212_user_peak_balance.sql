-- 0212_user_peak_balance.sql
--
-- Two things, in this order:
--
--   1. `users.peak_balance` — the highest balance a player has ever held. It
--      is the column the "Highest all-time coins" leaderboard ranks, and it is
--      maintained by every credit path (src/lib/tokens/creditTokens.ts,
--      tokens/wager.ts, tokens/energyGrant.ts) as
--      `GREATEST(peak_balance, balance + credit)`.
--
--   2. A one-time sanity clamp of legacy balances to the new wallet ceiling
--      (WALLET_HARD_CAP = 100000, src/lib/games/economy.ts). Wagering was
--      retired for a long stretch, but balances carried over from the
--      pre-retirement economy can sit far above the new cap; the cap is the
--      guarantee that no account can reach millions, so it has to hold for
--      existing rows too.
--
-- Order matters: the peak is captured from the balance BEFORE the clamp, so a
-- legacy balance above the cap still records its true historical peak while
-- the spendable balance comes down to the ceiling.

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "peak_balance" numeric(30, 2) NOT NULL DEFAULT '0.00';

-- Highest balance we can prove, before the clamp.
UPDATE "users"
  SET "peak_balance" = GREATEST("peak_balance", "balance");

-- The one-time clamp. Anything above the wallet ceiling comes down to it.
UPDATE "users"
  SET "balance" = 100000.00
  WHERE "balance" > 100000.00;
