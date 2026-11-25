// src/lib/solitaire-duel/localReview.ts
//
// GAME REVIEW FOR GAMES THAT LIVE IN THIS BROWSER.
//
// A signed-in player's completed game is a server row, and the review API
// returns it by id. A guest has no row, so `SoloSolitaireGame` keeps the game
// itself on the device: the deal (or the seed it derives from) and the FINAL
// canonical log, never a board snapshot (see `appendLocalCompleted`). That is
// everything a review needs, because `replayMoves` proves the log reproduces
// the completed board, and the deal is either stored or a pure function of the
// seed.
//
// WHAT THIS MODULE OWNS:
//   * the localStorage key and the bounded ring of completed games
//   * the local-only review id (`local-<savedAtMs>-<moveCount>`), which is
//     never a server id and never uploaded
//   * building the SAME `SolitaireReview` payload the review API returns, so
//     the page has one renderer and one analysis path
//
// SOLO AND DAILY ARE BOTH RECONSTRUCTABLE, differently:
//   * Solo — the deal is derived from `seed`.
//   * Daily — the deal is derived server-side from the date (and that
//     derivation imports Node's crypto), so the page hands its server-derived
//     deal to the record instead. The stored deal is replayed exactly like the
//     server's would be.
//
// CLIENT-SAFE: imports only the pure deal/replay engine, like the game itself.

import { dealFromSeed } from "./deck";
import type { SolitaireReview } from "./review";
import { replayMoves } from "./rules";
import type { SolitaireDeal, SolitaireMove } from "./types";

export const LOCAL_COMPLETED_KEY = "grynd.solitaire.completed.v1";
/** A bounded ring: a log is ~10–40 KB, and only the latest games are useful. */
export const MAX_LOCAL_COMPLETED = 20;

const LOCAL_REVIEW_PREFIX = "local-";

export type LocalCompletedGame = {
  /** The local-only review id. Records written before this id existed lack it. */
  id: string;
  mode: "solo" | "daily";
  seed: number;
  dateKey: string | null;
  /**
   * DAILY ONLY: the server-derived deal this game was played on. A solo record
   * leaves it null and derives the deal from `seed` instead, so the log's own
   * weight is not duplicated.
   */
  deal?: SolitaireDeal | null;
  log: { kind: SolitaireMove["kind"]; move: SolitaireMove }[];
  startedAtMs: number;
  endedAtMs: number;
  elapsedMs: number;
  won: true;
  savedAtMs: number;
};

/** The local id for one completed game. Deterministic from the save instant. */
export function localCompletedReviewId(savedAtMs: number, moveCount: number): string {
  const at = Math.max(0, Math.floor(Number(savedAtMs) || 0));
  const moves = Math.max(0, Math.floor(Number(moveCount) || 0));
  return `${LOCAL_REVIEW_PREFIX}${at}-${moves}`;
}

/** True for a review id this browser issued, never for a server uuid. */
export function isLocalReviewGameId(gameId: unknown): boolean {
  return typeof gameId === "string" && gameId.startsWith(LOCAL_REVIEW_PREFIX);
}

/** Every completed game this browser kept, oldest first. Never throws. */
export function readLocalCompletedGames(): LocalCompletedGame[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(LOCAL_COMPLETED_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (row): row is LocalCompletedGame =>
        Boolean(row) && typeof row === "object" && row.won === true,
    );
  } catch {
    return [];
  }
}

/**
 * A stored deal has to be a real deal before it is replayed: the record comes
 * from localStorage, so a truncated or hand-edited value must fail closed
 * rather than reach the engine.
 */
function isStoredDeal(value: unknown): value is SolitaireDeal {
  if (!value || typeof value !== "object") return false;
  const deal = value as Partial<SolitaireDeal>;
  return (
    Array.isArray(deal.tableau) &&
    deal.tableau.length > 0 &&
    deal.tableau.every((column) => Array.isArray(column)) &&
    Array.isArray(deal.stock)
  );
}

/**
 * The review payload for a locally saved completed game, or null.
 *
 * The stored log is replayed before anything is returned: a record the engine
 * refuses, or one that does not solve the deal, is never presented as a
 * complete review.
 */
export function buildLocalReview(gameId: string): SolitaireReview | null {
  if (!isLocalReviewGameId(gameId)) return null;
  const record = readLocalCompletedGames().find((row) => row?.id === gameId);
  if (!record) return null;

  const mode = record.mode === "daily" ? "daily" : "solo";
  const seed = Number(record.seed);
  if (mode === "solo" && (!Number.isInteger(seed) || seed < 0)) return null;
  if (!Array.isArray(record.log) || record.log.length === 0) return null;

  const deal: SolitaireDeal | null =
    mode === "daily"
      ? isStoredDeal(record.deal)
        ? record.deal
        : null
      : dealFromSeed(seed);
  if (!deal) return null;

  let replayed: ReturnType<typeof replayMoves>;
  try {
    replayed = replayMoves({ deal, moves: record.log });
  } catch {
    return null;
  }
  if (!replayed.ok || !replayed.state.completed) return null;

  const startedAt = new Date(Number(record.startedAtMs));
  const completedAt = new Date(Number(record.endedAtMs));
  if (Number.isNaN(startedAt.getTime()) || Number.isNaN(completedAt.getTime())) {
    return null;
  }
  const durationMs = Math.max(0, completedAt.getTime() - startedAt.getTime());

  return {
    gameId,
    gameKind: mode,
    variant: deal.variant,
    variantVersion: deal.variantVersion,
    status: "complete",
    deal,
    moves: record.log,
    result: {
      completed: true,
      moveCount: record.log.length,
      elapsedMs: durationMs,
      seed,
    },
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    durationMs,
    analysisEligible: true,
    // No server cache exists for a local game: the review page's worker
    // computes the analysis once, on demand.
    analysis: null,
    incompleteReason: null,
    mode,
    seed,
    dateKey: mode === "daily" ? record.dateKey ?? null : null,
  };
}
