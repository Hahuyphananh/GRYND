-- UNO practice seat for signed-out guests.
--
-- `uno_games.user_id` is an INTEGER FK to `users.id`, so a guest
-- (`guest_<uuid>`, no `users` row) could not hold a practice game — which left
-- UNO's free vs-AI mode account-gated while every other practice mode accepted
-- guests. Make the account seat nullable and add a dedicated text guest seat:
-- a practice game is owned by exactly one of the two. Online (PvP) games are
-- unaffected — matchmaking keeps the age gate, so they always carry a
-- `user_id`.
--
-- Idempotent: safe to re-run (and safe to paste into the Supabase SQL editor).

ALTER TABLE "uno_games"
  ALTER COLUMN "user_id" DROP NOT NULL;

ALTER TABLE "uno_games"
  ADD COLUMN IF NOT EXISTS "guest_id" varchar(64);

COMMENT ON COLUMN "uno_games"."guest_id" IS
  'Guest seat for a free vs-AI practice game: guest_<uuid> (NULL for every account game)';
