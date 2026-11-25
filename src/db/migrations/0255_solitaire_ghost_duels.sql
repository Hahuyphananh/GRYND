-- Migration 0255 — Asynchronous ghost duels for ranked Solitaire.
--
-- Ranked Solitaire keeps its live 1v1 queue exactly as it was. The ONLY change
-- is what happens when nobody joins: instead of waiting indefinitely, the open
-- lobby may be paired against a recorded REPLAY of another real player who
-- already played that exact deterministic deal (a "ghost"). The ghost is not an
-- AI and makes no decisions — its moves are the recorded moves of a real human,
-- replayed at the recorded instants, so ranked never substitutes a bot.
--
-- THE DEAL IS NOT RE-MINTED. A ghost match replays the SOURCE match's committed
-- deal (`server_seed`, `server_seed_hash`, `deal_seed`, `deal`) and both seats
-- start from that deal's opening position, which is what makes "the ghost played
-- this exact deal" a structural fact rather than a claim. `ghost_source_match_id`
-- records the provenance; the seed is still only revealed once THIS match is
-- terminal, exactly like a human duel.
--
-- Every column is additive and nullable/defaulted, so existing rows, existing
-- code paths and existing matches are untouched.

ALTER TABLE solitaire_duel_matches
  -- True on a ghost duel. Deliberately SEPARATE from `is_ai`: a ghost is a
  -- recorded human, settlement is rated, and no AI planner is ever consulted.
  ADD COLUMN IF NOT EXISTS is_ghost BOOLEAN NOT NULL DEFAULT FALSE,
  -- The finished human match the replay came from (provenance, never a board).
  ADD COLUMN IF NOT EXISTS ghost_source_match_id UUID,
  -- The anonymised handle shown to the player. Never the source player's id,
  -- name or icon: a replay is attributed, not de-anonymised.
  ADD COLUMN IF NOT EXISTS ghost_name VARCHAR(40),
  -- The source player's ladder snapshot, so a ghost duel settles against the
  -- strength the opponent actually had rather than a made-up number.
  ADD COLUMN IF NOT EXISTS ghost_rating INT,
  ADD COLUMN IF NOT EXISTS ghost_trophies INT,
  -- The recorded replay: [{ offsetMs, kind, move }] in ply order, where
  -- offsetMs is measured from the SOURCE match's GO instant. Copied onto the
  -- row so playback never depends on the source log still being readable.
  ADD COLUMN IF NOT EXISTS ghost_timeline JSONB,
  -- When the source player solved the deal (offset from GO), or NULL if the
  -- recording never finished. Decides the ghost's completion instant.
  ADD COLUMN IF NOT EXISTS ghost_completed_at_offset_ms INT,
  -- The instant a still-waiting lobby may fall back to a ghost. Written at
  -- lobby creation; NULL on every joined, practice and ghost row.
  ADD COLUMN IF NOT EXISTS ghost_fallback_at TIMESTAMP;--> statement-breakpoint

-- The pool query: finished, human, non-ghost matches on the current variant.
-- Partial, because only those rows are ever ghost candidates.
CREATE INDEX IF NOT EXISTS solitaire_duel_matches_ghost_pool_idx
  ON solitaire_duel_matches(status, variant_version, created_at DESC)
  WHERE is_ai = FALSE AND is_ghost = FALSE;--> statement-breakpoint

-- The fallback sweep's index: which open lobbies are past their ghost window.
CREATE INDEX IF NOT EXISTS solitaire_duel_matches_ghost_fallback_idx
  ON solitaire_duel_matches(ghost_fallback_at)
  WHERE status = 'waiting' AND is_ghost = FALSE;
