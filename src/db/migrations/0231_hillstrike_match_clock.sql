-- ── 0231: the Hillstrike match clock ────────────────────────────────────────
--
-- Hillstrike matches are timed now, like a chess clock: the lobby picks 5, 10 or
-- 15 minutes (MATCH_DURATION_OPTIONS_MS in src/lib/hillstrike/constants.ts) and
-- both seats get the same duration, because matchmaking only pairs callers who
-- asked for the same clock.
--
-- `duration_ms` is the chosen duration. The deadline is NOT stored: it is
-- derived as `started_at + duration_ms`, so there is one source of truth for the
-- clock and a re-read can never disagree with a stored deadline.
--
-- When the clock runs out the SERVER resolves the match
-- (`resolveTimeout` in src/lib/hillstrike/serverStore.ts): the engine's
-- `finishOnTime` names the tank with more HP as the winner, and level HP records
-- a draw (`result` stays NULL, `result_reason` is 'timed-out'). A draw settles no
-- rating and no trophy.
--
-- Existing rows keep playing under the default 10-minute clock. Idempotent, like
-- the other hand-written migrations here.

ALTER TABLE "hillstrike_matches"
  ADD COLUMN IF NOT EXISTS "duration_ms" integer DEFAULT 600000 NOT NULL;
--> statement-breakpoint

COMMENT ON COLUMN "hillstrike_matches"."duration_ms" IS
  'The match clock in ms, chosen at lobby creation (5 / 10 / 15 minutes). The deadline is started_at + duration_ms.';
