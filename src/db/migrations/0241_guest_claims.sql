-- 0241_guest_claims.sql
--
-- GUEST → ACCOUNT CONVERSION (Phase 4) — the permanent link between a signed
-- guest practice record and the Clerk account that claimed it.
--
-- ── WHY A TABLE, NOT COLUMNS ON guest_profiles ───────────────────────────
--
-- A claim is a one-to-one relationship with its own provenance: WHO claimed,
-- WHEN, and HOW MUCH was there at that moment. Keeping it in its own row means
-- the guest rows themselves are never rewritten — every `guest_practice_results`
-- row keeps its original `guest_id` and `created_at`, so a claimed practice
-- record stays distinguishable from an account's official results forever.
--
-- ── THE TWO CONSTRAINTS ARE THE ANTI-DUPLICATE DESIGN ────────────────────
--
--   guest_id PRIMARY KEY              one guest can be claimed exactly once,
--                                     by exactly one account.
--   UNIQUE (claimed_by_user_id)       one account can hold at most one claimed
--                                     guest record (the product has no notion
--                                     of merging several unrelated guests).
--
-- The claim writer (src/lib/guest/claim.ts) takes `SELECT … FOR UPDATE` on the
-- guest profile inside a transaction, so two accounts racing for the same
-- guest serialise on the row and the loser is rejected by the primary key even
-- if it somehow passed the read. A 23505 from either constraint is mapped back
-- to a precise, idempotent outcome rather than a 500.
--
-- ── COUNTS ARE A SNAPSHOT, NOT A COUNTER ─────────────────────────────────
--
-- `match_count` / `win_count` / `loss_count` / `draw_count` are written ONCE at
-- claim time from the guest's existing result rows. They exist so the claim UI
-- can report what was preserved without re-reading the history on every page.
-- They are never incremented afterwards, and nothing in rating, trophy, token,
-- quest or leaderboard code reads this table.
--
-- ── DELETION ─────────────────────────────────────────────────────────────
--
-- `ON DELETE CASCADE` on both foreign keys: deleting the account removes the
-- claim (the guest rows remain as an anonymous practice record), and deleting
-- the guest profile removes the claim. No orphan claim can outlive its account.

CREATE TABLE IF NOT EXISTS "guest_claims" (
  "guest_id" varchar(64) PRIMARY KEY
    REFERENCES "guest_profiles" ("guest_id") ON DELETE CASCADE,
  "claimed_by_user_id" varchar(255) NOT NULL
    REFERENCES "users" ("clerk_id") ON DELETE CASCADE,
  "claimed_at" timestamp NOT NULL DEFAULT now(),
  "match_count" integer NOT NULL DEFAULT 0,
  "win_count" integer NOT NULL DEFAULT 0,
  "loss_count" integer NOT NULL DEFAULT 0,
  "draw_count" integer NOT NULL DEFAULT 0,
  CONSTRAINT "guest_claims_one_guest_per_account"
    UNIQUE ("claimed_by_user_id"),
  CONSTRAINT "guest_claims_counts_valid"
    CHECK (
      "match_count" >= 0 AND
      "win_count" >= 0 AND
      "loss_count" >= 0 AND
      "draw_count" >= 0 AND
      "win_count" + "loss_count" + "draw_count" = "match_count"
    )
);

COMMENT ON TABLE "guest_claims" IS
  'Permanent one-guest-to-one-account link recorded when a signed-in player claims their guest practice record; guest result rows are never rewritten';
COMMENT ON COLUMN "guest_claims"."claimed_by_user_id" IS
  'Clerk user id (users.clerk_id) of the single account that claimed this guest record';
COMMENT ON COLUMN "guest_claims"."match_count" IS
  'Practice matches present at claim time — an immutable snapshot, not a counter';
