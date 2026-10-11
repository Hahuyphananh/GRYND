-- Migration 0209 — Speed Typing: the input device each seat raced on.
--
-- WHY. A phone or tablet has no physical keyboard, so a touch typist on a phone
-- is at a structural disadvantage against anyone on a computer: the passage is
-- the same, the clock is the same, but the input method is not. A rated 1v1
-- race between a phone and a keyboard is therefore not a fair test of typing
-- skill, which is the one thing this game is supposed to measure.
--
-- So matchmaking pools by input device: `createOrJoin` prefers the oldest open
-- lobby whose creator typed on the same kind of input, and only pairs across
-- pools once the waiting lobby has waited past DEVICE_MATCH_WIDEN_MS
-- (src/lib/speed-typing/constants.ts). The columns below are what makes that
-- possible: one per seat, because both seats are recorded and the pool of an
-- open lobby is its CREATOR's class (player1).
--
-- WHAT IS STORED. A closed vocabulary — 'keyboard' | 'touch' — or NULL. NULL is
-- 'unknown' (a legacy row, the quick-queue path, or a client with no usable
-- User-Agent), and an unknown lobby is class-NEUTRAL: it pairs with anyone,
-- exactly as it did before this migration. That is deliberately the fallback
-- rather than a third pool, so no change here can strand an unclassifiable
-- client in a queue of its own.
--
-- THE SIGNAL IS THE REQUEST'S OWN HEADERS (Sec-CH-UA-Mobile, then User-Agent:
-- see deviceClassFromHeaders in src/lib/speed-typing/deviceClass.ts), never a
-- field a player sends. The route's contract — asserted by
-- tests/speed-typing-e2e.test.mjs and tests/speed-typing-platform.test.mjs — is
-- that a client may only ever say WHAT IT TYPED; a self-declared device class
-- would be one more thing a client could lie about to farm a weaker pool.
--
-- NO ECONOMY, NO RACE STATE. These are two nullable strings on the existing
-- table: nothing here touches the race, the rating, the trophies or money.
--
-- Idempotent: safe to re-run (ADD COLUMN IF NOT EXISTS, and the constraint is
-- dropped before it is re-added), so it can also be pasted straight into the
-- Supabase SQL editor.

ALTER TABLE speed_typing_matches
  ADD COLUMN IF NOT EXISTS player1_device_class VARCHAR(16),
  ADD COLUMN IF NOT EXISTS player2_device_class VARCHAR(16);

-- The vocabulary is closed: a value that is not one of the two pool names is a
-- bug in the detection, and it must fail at the write rather than silently
-- splitting matchmaking into a third pool nobody can join.
DO $$
BEGIN
  IF to_regclass('speed_typing_matches') IS NULL THEN
    RETURN;
  END IF;

  ALTER TABLE speed_typing_matches
    DROP CONSTRAINT IF EXISTS speed_typing_matches_device_class_valid;

  ALTER TABLE speed_typing_matches
    ADD CONSTRAINT speed_typing_matches_device_class_valid
    CHECK (
      (player1_device_class IS NULL OR player1_device_class IN ('keyboard', 'touch'))
      AND (player2_device_class IS NULL OR player2_device_class IN ('keyboard', 'touch'))
    );
END $$;
