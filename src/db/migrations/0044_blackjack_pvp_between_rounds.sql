-- Migration: 0044_blackjack_pvp_between_rounds.sql
--
-- Adds the `between_rounds` value to the `blackjack_pvp_status` enum so
-- the server can express an explicit transition state between resolved
-- rounds. This unlocks a dedicated Best-of-3 "next round incoming"
-- screen (regardless of player action) without polluting the active
-- round_X statuses.
--
-- The `IF NOT EXISTS` guard makes this idempotent against re-runs.
--
-- NOTE: PostgreSQL does not allow `ALTER TYPE ... ADD VALUE` inside a
-- transaction block in many configurations. If the migration runner
-- wraps each migration file in BEGIN/COMMIT, this migration must be
-- promoted to a non-transactional migration or split into two steps.
-- Drizzle-kit, when configured with `transaction: false`, handles
-- this automatically.

ALTER TYPE blackjack_pvp_status ADD VALUE IF NOT EXISTS 'between_rounds';
