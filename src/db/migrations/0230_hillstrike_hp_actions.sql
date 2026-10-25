-- ── 0230: Hillstrike HP and the three-action turn ───────────────────────────
--
-- 0229 modelled Hillstrike as "one row per accepted SHOT". The rules now give a
-- turn three actions — shoot, drive (forward/back) and build (one shield block)
-- — and a tank has 100 HP that a direct hit takes down in proportion to how far
-- the shell flew.
--
-- WHAT CHANGES ON `hillstrike_shots`
--
--   * `action` — `shoot` | `move` | `build`. The append-only log keeps recording
--     every accepted action, so a stored match still replays action for action.
--   * `damage` — HP taken off the opponent by a `shoot` (0 for a drive/build).
--     Damage is the distance-scaled number the engine resolved; it is never
--     client-supplied.
--   * `angle_deg`, `power`, `impact_kind`, `impact_x`, `impact_y` become NULLABLE:
--     only a shot has an aim and an impact, and writing a zero for a drive would
--     read as a real shot at 0°/0%.
--   * `lives_lost` is KEPT for the rows written under the v1 (three-lives)
--     rules. New matches always write 0; nothing reads it as a live rule.
--
-- `game_state` needs no DDL: it is JSONB, and the engine's state gained `hp` and
-- `lastAction` there. Rows written under v1 keep replaying their own battlefields
-- because `field_version` was bumped to 2 (see FIELD_VERSION), which is what the
-- generator/seed mix uses.
--
-- Idempotent: safe to re-run, like the other hand-written migrations here.

ALTER TABLE "hillstrike_shots"
  ADD COLUMN IF NOT EXISTS "action" varchar(8) DEFAULT 'shoot' NOT NULL;
--> statement-breakpoint

ALTER TABLE "hillstrike_shots"
  ADD COLUMN IF NOT EXISTS "damage" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint

ALTER TABLE "hillstrike_shots" ALTER COLUMN "angle_deg" DROP NOT NULL;
--> statement-breakpoint

ALTER TABLE "hillstrike_shots" ALTER COLUMN "power" DROP NOT NULL;
--> statement-breakpoint

ALTER TABLE "hillstrike_shots" ALTER COLUMN "impact_kind" DROP NOT NULL;
--> statement-breakpoint

ALTER TABLE "hillstrike_shots" ALTER COLUMN "impact_x" DROP NOT NULL;
--> statement-breakpoint

ALTER TABLE "hillstrike_shots" ALTER COLUMN "impact_y" DROP NOT NULL;
--> statement-breakpoint

COMMENT ON COLUMN "hillstrike_shots"."action" IS
  'shoot | move | build — the action this row records (ACTION_TYPES).';
--> statement-breakpoint

COMMENT ON COLUMN "hillstrike_shots"."damage" IS
  'HP taken off the opponent by a shoot, after the flight-distance falloff; 0 for a move or a build.';
