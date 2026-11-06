// src/lib/odds/guestSettlement.ts
//
// GUEST PROGRESSION (Phase 2E) — the one place an Odds AI duel becomes a guest
// practice result.
//
// An Odds practice match lives in `odds_games`: the server creates the row with
// its own `game_state`, resolves every round inside `/api/odds/ai/pick` with
// `submitAIPrediction`, and stores `winner` + `gameOver` back on that row. The
// client never submits a prediction OF THE RESULT — only its per-round guess —
// so the verdict handed to the guest writer is the server's own.
//
// This module therefore reads only the LOCKED row and the state the server just
// computed. It never looks at the request: no body field, no query parameter and
// no caller-supplied winner can reach it. An unfinished row, a non-AI row, an
// account seat or a guest in seat 2 writes nothing at all, which is what keeps
// registered-user play and PvP behaviour exactly as they were.
//
// A guest's practice record is private and cosmetic: no Elo, trophy, token,
// quest, daily-reward or leaderboard code is imported or called here.

import { isGuestId } from "../guestIdentity";
import {
  GUEST_PRACTICE_ODDS_GAME_KEY,
  recordGuestPracticeResultSafely,
} from "../guest/practiceProgress";

export type OddsPracticeRow = {
  id: number | string;
  /** In AI mode the human is always seat 1 (`player2Id` is the "AI" sentinel). */
  player1Id: string;
  isAi?: boolean | null;
  aiDifficulty?: string | null;
};

export type OddsPracticeVerdict = {
  gameOver?: boolean | null;
  winner?: "player1" | "player2" | null;
} | null | undefined;

/**
 * Map the server's stored verdict onto the guest's own result.
 *
 * `null` is the engine's exact tie (a draw). A missing verdict is NOT a draw —
 * it means the state is unfinished or from retired rules, so nothing is
 * recorded. An unknown `winner` value likewise maps to `null` rather than being
 * guessed.
 */
export function oddsPracticeOutcomeForGuest(
  state: OddsPracticeVerdict,
  row: OddsPracticeRow | null | undefined,
): "win" | "loss" | "draw" | null {
  if (!row) return null;
  // Only an AI duel, and only when a signed-out guest actually holds seat 1.
  if (row.isAi !== true) return null;
  if (!isGuestId(row.player1Id)) return null;
  if (!state || state.gameOver !== true) return null;

  const winner = state.winner;
  if (winner === null) return "draw";
  if (winner === "player1") return "win";
  if (winner === "player2") return "loss";
  return null;
}

/**
 * Record one finished guest duel. Called inside the transaction that flipped the
 * row to `finished`, so the practice record commits with the match result.
 *
 * Idempotent through the writer's `(game_key, match_id)` unique constraint: the
 * client's `/ai/end` after a `/ai/pick` that already finished the match is a
 * no-op rather than a second row. The safe writer contains a database failure,
 * so progression can never un-finish a decided duel.
 */
export async function settleGuestOddsPracticeTx(
  tx: any,
  row: OddsPracticeRow | null | undefined,
  state: OddsPracticeVerdict,
): Promise<void> {
  const result = oddsPracticeOutcomeForGuest(state, row);
  if (!result || !row) return;

  await recordGuestPracticeResultSafely(tx, {
    guestId: row.player1Id,
    gameKey: GUEST_PRACTICE_ODDS_GAME_KEY,
    matchId: String(row.id),
    result,
    aiDifficulty: row.aiDifficulty,
  });
}
