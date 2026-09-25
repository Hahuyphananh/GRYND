-- 0171: Rating identity ledger — anti-reset for provisional status + Elo.
--
-- WHY THIS TABLE EXISTS
--
-- `player_ratings` / `rating_events` hang off `users.id` with ON DELETE CASCADE,
-- and deleting an account deletes the local `users` row
-- (src/lib/security/deleteUserData.ts). Before this table, the sequence
--   "play 10 placement matches → delete account → re-register with the same
--    email"
-- produced a brand-new `users` row, a brand-new `player_ratings` row at 1000,
-- and a fresh 10-match provisional window. That is exactly the account-reset
-- abuse the provisional system is meant to be immune to.
--
-- So this ledger is keyed by a HASH OF THE ACCOUNT's normalized email address —
-- the one identity anchor the platform's account system already treats as
-- durable (Clerk verifies it and `users.email` is UNIQUE) — and carries NO
-- foreign key to `users`. It therefore survives account deletion and lets
-- `applyRatingResult` (src/lib/rating.js) restore a returning player's rating
-- and provisional progress instead of restarting them at 1000.
--
-- The email itself is never stored; only `sha256("grynd:rating-identity:" ||
-- lower(trim(email)))`, so the row is not directly identifying and can never be
-- used to look an account up by address.
--
-- NOTE: this is deliberately NOT a currency, reward or token ledger. It holds a
-- snapshot of Elo progress only, and it is never read by the Elo calculation
-- itself — a restored row simply becomes the player's starting point.
--
-- Idempotent: safe to run repeatedly.

CREATE TABLE IF NOT EXISTS "rating_identities" (
  "id" SERIAL PRIMARY KEY,
  -- sha256 hex of the normalized email (see identityHashForEmail in
  -- src/lib/rating.js). Length 64 = hex sha256.
  "identity_hash" VARCHAR(64) NOT NULL,
  "game_key" VARCHAR(64) NOT NULL,
  -- Snapshot of the player's per-game Elo progress, mirrored on every rated
  -- match and used to seed a re-registered account's rating row.
  "rating" INTEGER NOT NULL DEFAULT 1000,
  "peak_rating" INTEGER NOT NULL DEFAULT 1000,
  "games_rated" INTEGER NOT NULL DEFAULT 0,
  "wins" INTEGER NOT NULL DEFAULT 0,
  "losses" INTEGER NOT NULL DEFAULT 0,
  "draws" INTEGER NOT NULL DEFAULT 0,
  "last_delta" INTEGER NOT NULL DEFAULT 0,
  "last_rated_at" TIMESTAMP,
  "created_at" TIMESTAMP NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT "rating_identities_identity_game_unique"
    UNIQUE ("identity_hash", "game_key")
);

CREATE INDEX IF NOT EXISTS "rating_identities_identity_idx"
  ON "rating_identities" ("identity_hash");

-- Defense-in-depth guards, mirroring player_ratings.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'rating_identities_counts_nonneg'
  ) THEN
    ALTER TABLE "rating_identities" ADD CONSTRAINT "rating_identities_counts_nonneg"
      CHECK ("rating" >= 0 AND "games_rated" >= 0 AND "wins" >= 0
             AND "losses" >= 0 AND "draws" >= 0);
  END IF;
END $$;
