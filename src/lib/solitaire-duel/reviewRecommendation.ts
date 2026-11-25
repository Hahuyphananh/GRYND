// src/lib/solitaire-duel/reviewRecommendation.ts
//
// PHASE 2 — the review-side bridge to the Phase 1 recommendation.
//
// The page must not re-derive rules. These two helpers are the whole contract:
//
//   * `recommendationForMove` reads the recommendation attached to exactly one
//     analysed ply, and returns null for every unsupported case (no analysis,
//     an out-of-range ply, a routine/good/great move, an uncertain position).
//   * `buildRecommendationDemo` rebuilds the two READ-ONLY positions the board
//     needs: the exact position immediately BEFORE the reviewed move, and the
//     same position with the Phase 1 recommended move applied.
//
// Neither function touches the stored log, the analysis, the review timeline or
// the game result. `buildRecommendationDemo` takes a prefix copy and replays it;
// it never mutates the caller's array, and it refuses a recommendation that the
// authoritative engine cannot apply.

import type { GameAnalysis } from "./analysis";
import type { MoveRecommendation } from "./alternatives";
import { applyMove, replayMoves, viewForState } from "./rules";
import type { SolitaireDeal, SolitaireMove, SolitaireView } from "./types";

export type RecommendationDemoPosition = {
  /** Cards applied to reach this position. */
  ply: number;
  /** The board as the player may see it — never a hidden identity. */
  view: SolitaireView;
};

export type RecommendationDemo =
  | {
      ok: true;
      /** The reviewed move's pre-move position. */
      before: RecommendationDemoPosition;
      /** The same position after the recommended move. */
      after: RecommendationDemoPosition;
      /** Exactly the move Phase 1 returned. */
      move: SolitaireMove;
    }
  | { ok: false; reason: "not-reconstructable" | "not-legal" };

/**
 * The recommendation for the move at `moveIndex` (0-based log index), or null.
 *
 * A recommendation is only ever attached to an Inaccuracy/Mistake by the
 * analysis engine, so this is also the display gate: routine, positive and
 * uncertain moves have none.
 */
export function recommendationForMove(
  analysis: GameAnalysis | null | undefined,
  moveIndex: number,
): MoveRecommendation | null {
  if (!analysis || !Number.isInteger(moveIndex) || moveIndex < 0) return null;
  return analysis.perMove[moveIndex]?.recommendation ?? null;
}

/**
 * Rebuild the demonstration positions for a recommendation.
 *
 * The before state comes from the validated log prefix; the after state is
 * `applyMove` with the exact recommended move. Both are projected through
 * `viewForState`, the codebase's single hidden-information boundary, so the
 * demonstration cannot reveal a face-down card.
 */
export function buildRecommendationDemo(
  deal: SolitaireDeal | null | undefined,
  moves: readonly { kind: string; move: unknown }[] | null | undefined,
  recommendation: MoveRecommendation | null | undefined,
): RecommendationDemo {
  if (
    !deal ||
    !Array.isArray(moves) ||
    !recommendation ||
    !Number.isInteger(recommendation.ply) ||
    recommendation.ply < 0 ||
    recommendation.ply > moves.length
  ) {
    return { ok: false, reason: "not-reconstructable" };
  }

  // `slice` is a prefix copy; the caller's log is never touched.
  const replayed = replayMoves({ deal, moves: moves.slice(0, recommendation.ply) });
  if (!replayed.ok || replayed.state.ply !== recommendation.ply) {
    return { ok: false, reason: "not-reconstructable" };
  }

  const applied = applyMove({ state: replayed.state, move: recommendation.move });
  if (!applied.ok) {
    return { ok: false, reason: "not-legal" };
  }

  return {
    ok: true,
    before: { ply: replayed.state.ply, view: viewForState(replayed.state) },
    after: { ply: applied.state.ply, view: viewForState(applied.state) },
    move: recommendation.move,
  };
}
