-- 0175: Trophy identity ledger — anti-reset for trophy progress.
--
-- WHY THIS TABLE EXISTS
--
-- `player_trophies` / `trophy_events` hang off `users.id` with ON DELETE
-- CASCADE, and deleting an account deletes the local `users` row
-- (src/lib/security/deleteUserData.ts). Without this table, the sequence
--   "earn 5,000 trophies → delete account → re-register with the same email"
-- produced a brand-new `users` row and a brand-new 0-trophy ladder, letting a
-- player re-roll their progression.
--
-- So this ledger is keyed by a HASH OF THE ACCOUNT's normalized email address
-- — the same durable anchor the Elo ledger (migration 0171) uses — and carries
-- NO foreign key to `users`. It therefore survives account deletion and lets
-- `applyTrophyResult` (src/lib/trophyStore.js) restore a returning player's
-- trophies instead of restarting them at 0.
--
-- The email itself is never stored; only a sha256 hex digest, so the row is not
-- directly identifying.
--
-- NOTE: this is deliberately NOT a currency, reward or token ledger. It holds a
-- snapshot of trophy progress only, and it is never read by the trophy
-- calculation itself — a restored row simply becomes the player's starting
-- point.
--
-- Idempotent: safe to run repeatedly.

CREATE TABLE IF NOT EXISTS "trophy_identities" (
  "id" SERIAL PRIMARY KEY,
  "identity_hash" VARCHAR(64) NOT NULL,
  "game_key" VARCHAR(64) NOT NULL,
  "trophies" INTEGER NOT NULL DEFAULT 0,
  "peak_trophies" INTEGER NOT NULL DEFAULT 0,
  "games_rated" INTEGER NOT NULL DEFAULT 0,
  "wins" INTEGER NOT NULL DEFAULT 0,
  "losses" INTEGER NOT NULL DEFAULT 0,
  "draws" INTEGER NOT NULL DEFAULT 0,
  "last_delta" INTEGER NOT NULL DEFAULT 0,
  "last_trophy_at" TIMESTAMP,
  "created_at" TIMESTAMP NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT "trophy_identities_identity_game_unique"
    UNIQUE ("identity_hash", "game_key")
);

CREATE INDEX IF NOT EXISTS "trophy_identities_identity_idx"
  ON "trophy_identities" ("identity_hash");

-- Defense-in-depth guards, mirroring player_trophies.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'trophy_identities_counts_nonneg'
  ) THEN
    ALTER TABLE "trophy_identities" ADD CONSTRAINT "trophy_identities_counts_nonneg"
      CHECK ("trophies" >= 0 AND "trophies" <= 10000
             AND "peak_trophies" >= 0 AND "peak_trophies" <= 10000
             AND "games_rated" >= 0 AND "wins" >= 0
             AND "losses" >= 0 AND "draws" >= 0);
  END IF;
END $$;
