// src/lib/solitaire-duel/opponentKind.ts
//
// THE canonical opponent classification for Solitaire Duel.
//
// Every surface — lobby history, active match, result screen, analytics and
// notifications — must decide "who am I racing?" here, from the server's own
// columns, never from a display name and never from `isAi` alone.
//
//   ai       — a GRYND-controlled bot seat (`is_ai = true`).
//   recorded — a ghost seat replaying a real person's logged run
//              (`is_ghost = true`, or a `solitaire_ghost_` seat id). The source
//              player is NOT in this match.
//   human    — two live accounts.
//
// A recorded run is not a live person, and a ghost must never be presented as
// one: that is the whole point of this module's existence.

import { isGhostPlayerId } from "./constants";

export type OpponentKind = "human" | "recorded" | "ai";

export type OpponentMatchShape = {
  isAi?: boolean | null;
  isGhost?: boolean | null;
  player1Id?: string | null;
  player2Id?: string | null;
};

/**
 * Classify from server-side match data. The explicit flags win; the seat id is
 * the fallback for rows/DTOs that predate the flags. Names are never consulted.
 */
export function classifyOpponent(match: OpponentMatchShape | null | undefined): OpponentKind {
  if (!match) return "human";
  if (match.isAi === true) return "ai";
  if (match.isGhost === true) return "recorded";
  if (isGhostPlayerId(match.player1Id) || isGhostPlayerId(match.player2Id)) return "recorded";
  return "human";
}

/** The user-facing label for each kind. One spelling, everywhere. */
export const OPPONENT_LABELS: Readonly<Record<OpponentKind, string>> = Object.freeze({
  human: "Live player",
  recorded: "Recorded opponent",
  ai: "GRYND AI",
});

export function opponentLabel(kind: OpponentKind): string {
  return OPPONENT_LABELS[kind];
}

/** True when the opponent is a person who is actually in this match. */
export function isLiveHuman(kind: OpponentKind): boolean {
  return kind === "human";
}

/** The analytics vocabulary (Phase 1 `opponent_type`). */
export function opponentAnalyticsType(kind: OpponentKind): "human" | "recorded" | "ai" {
  return kind;
}
