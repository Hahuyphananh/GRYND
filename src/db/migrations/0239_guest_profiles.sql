-- 0239_guest_profiles.sql
--
-- GUEST PROGRESSION — the identity row for a signed-out practice player.
--
-- A guest is a `guest_<32 hex>` id signed into the `grynd_guest` cookie by
-- src/lib/auth/guestSession.ts. It has NO `users` row by design, so it needs
-- somewhere of its own to hang persistent practice results off. This table is
-- that anchor.
--
-- ── WHY THE ROW IS CREATED LAZILY ────────────────────────────────────────
--
-- The writer (recordGuestPracticeResult in src/lib/guest/practiceProgress.ts)
-- inserts a profile in the SAME transaction that records a finished practice
-- match. Nothing creates a profile on a page view, on browsing, or when a
-- practice match STARTS — so a visitor who never completes a game leaves no
-- row, and the table cannot grow with anonymous traffic.
--
-- ── NO CLAIM COLUMNS YET ─────────────────────────────────────────────────
--
-- Guest-to-account conversion is a later phase and is explicitly out of scope
-- here, so `claimed_by_user_id` / `claimed_at` are deliberately absent. Adding
-- them now would mean carrying a foreign key and a NULL-pair constraint for a
-- feature nothing uses — and the previous design pairing ON DELETE SET NULL
-- with a "both set or both NULL" check would have rejected the very NULL pair
-- that SET NULL produces. When conversion ships, the columns arrive in their
-- own migration with a constraint that matches the delete behaviour.
--
-- ── WHAT MAY BE STORED ───────────────────────────────────────────────────
--
-- `guest_id` is the id the HMAC-verified session issued, never a value from a
-- request body/query/header. The CHECK repeats the shape `isGuestId` enforces
-- in code, so a malformed id cannot be persisted even by a future writer that
-- forgets to validate.

CREATE TABLE IF NOT EXISTS "guest_profiles" (
  "guest_id" varchar(64) PRIMARY KEY,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "last_seen_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "guest_profiles_guest_id_format"
    CHECK ("guest_id" ~ '^guest_[A-Za-z0-9_-]{1,58}$')
);

COMMENT ON TABLE "guest_profiles" IS
  'One row per signed-out guest who completed a supported practice match; created lazily, never per visit';
COMMENT ON COLUMN "guest_profiles"."guest_id" IS
  'The HMAC-signed guest_<hex> cookie identity (never a Clerk id, never a users row)';
COMMENT ON COLUMN "guest_profiles"."last_seen_at" IS
  'Refreshed when a practice result is recorded; reported back by GET /api/guest/progress';
