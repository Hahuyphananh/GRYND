-- 0236_battleship.sql
--
-- BATTLESHIP — ranked 1v1 naval duel: the match row, the PRIVATE fleets and the
-- append-only attack log.
--
-- ── FREE TO PLAY ────────────────────────────────────────────────────────
--
-- There is deliberately no stake, escrow, rake or payout column. Battleship
-- moves no coins: `src/lib/battleship/serverStore.ts` has no wager call and no
-- stake parameter, so a match cannot fund, pay or refund anything.
--
-- ── WHY FLEETS ARE THEIR OWN TABLE ──────────────────────────────────────
--
-- Fleet layouts are the one piece of match data that must never reach the
-- opponent. They live in `battleship_fleets`, keyed (match_id, seat), and the
-- store only ever reads the row for the VIEWER'S OWN seat — the opponent's fleet
-- is never selected, so no DTO, route or serialiser can leak it. A `jsonb` column
-- on the match row would have put both fleets one `SELECT *` away from a
-- response; a separate seat-keyed table makes the protected read explicit.
--
-- `placement` is the canonical fleet text produced by `serializeFleet`
-- (`carrier:A1:horizontal;battleship:…`), re-validated by `deserializeFleet` on
-- read. The unique (match_id, seat) index is what makes "one fleet per seat,
-- ever" a storage invariant rather than an application hope.
--
-- ── THE ATTACK LOG ──────────────────────────────────────────────────────
--
-- `battleship_attacks` is append-only and empty until the combat phase ships.
-- Two unique indexes state the rules structurally:
--   * (match_id, round, seat)  — one attack per seat per round;
--   * (match_id, seat, coordinate) — a coordinate may be attacked once per seat
--     (both seats may attack the same coordinate, on their own boards).
-- `result` stays NULL until the round resolves, which is exactly the server-side
-- simultaneous-resolution step of a later phase.
--
-- ── LIFECYCLE ───────────────────────────────────────────────────────────
--
-- `phase` is the game's own vocabulary (waiting | placement | combat | finished |
-- cancelled). The canonical `match_lifecycle` row is created and advanced in the
-- same transactions by the store, so the platform queue history stays complete.
-- Timers are server columns: `placement_deadline` opens when the second seat
-- lands, `round_deadline` when both fleets are confirmed and the round opens.

CREATE TABLE IF NOT EXISTS "battleship_matches" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "player1_id" varchar(255) NOT NULL,
  "player2_id" varchar(255),
  "phase" varchar(12) DEFAULT 'waiting' NOT NULL,
  "round" integer DEFAULT 0 NOT NULL,
  "player1_ready" boolean DEFAULT false NOT NULL,
  "player2_ready" boolean DEFAULT false NOT NULL,
  "winner_id" varchar(255),
  "result" varchar(16),
  "placement_deadline" timestamp,
  "round_deadline" timestamp,
  "player1_timeouts" integer DEFAULT 0 NOT NULL,
  "player2_timeouts" integer DEFAULT 0 NOT NULL,
  "started_at" timestamp,
  "ended_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

COMMENT ON COLUMN "battleship_matches"."phase" IS
  'waiting | placement | combat | finished | cancelled — server-owned, never client input';
COMMENT ON COLUMN "battleship_matches"."winner_id" IS
  'Set only by the combat resolver; NULL until a match is decided';

CREATE INDEX IF NOT EXISTS "battleship_matches_phase_idx"
  ON "battleship_matches" ("phase", "created_at");
CREATE INDEX IF NOT EXISTS "battleship_matches_player1_idx"
  ON "battleship_matches" ("player1_id", "created_at");
CREATE INDEX IF NOT EXISTS "battleship_matches_player2_idx"
  ON "battleship_matches" ("player2_id", "created_at");

CREATE TABLE IF NOT EXISTS "battleship_fleets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "match_id" uuid NOT NULL REFERENCES "battleship_matches" ("id") ON DELETE CASCADE,
  "seat" varchar(8) NOT NULL,
  "placement" text NOT NULL,
  "confirmed_at" timestamp DEFAULT now() NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

COMMENT ON TABLE "battleship_fleets" IS
  'Private fleet layouts. Server-only: read solely for the viewer''s own seat; never projected to the opponent.';
COMMENT ON COLUMN "battleship_fleets"."placement" IS
  'Canonical serializeFleet text, re-validated on read (src/lib/battleship/fleet.ts)';

CREATE UNIQUE INDEX IF NOT EXISTS "battleship_fleets_match_seat_unique"
  ON "battleship_fleets" ("match_id", "seat");

CREATE TABLE IF NOT EXISTS "battleship_attacks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "match_id" uuid NOT NULL REFERENCES "battleship_matches" ("id") ON DELETE CASCADE,
  "round" integer NOT NULL,
  "seat" varchar(8) NOT NULL,
  "coordinate" varchar(4) NOT NULL,
  "result" varchar(8),
  "ship" varchar(16),
  "created_at" timestamp DEFAULT now() NOT NULL
);

COMMENT ON COLUMN "battleship_attacks"."result" IS
  'miss | hit | sunk — NULL until the round resolves simultaneously';

CREATE UNIQUE INDEX IF NOT EXISTS "battleship_attacks_round_seat_unique"
  ON "battleship_attacks" ("match_id", "round", "seat");
CREATE UNIQUE INDEX IF NOT EXISTS "battleship_attacks_coordinate_unique"
  ON "battleship_attacks" ("match_id", "seat", "coordinate");
CREATE INDEX IF NOT EXISTS "battleship_attacks_match_idx"
  ON "battleship_attacks" ("match_id", "round");
