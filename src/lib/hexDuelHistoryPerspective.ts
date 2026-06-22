/**
 * Hex Duel — viewer-perspective normalization for wire data.
 *
 * Background:
 *   The engine tracks owner identity absolutely (player1 capital at (0,0),
 *   player2 capital at (GRID_SIZE-1, GRID_SIZE-1)). The in-board view
 *   applies a per-viewer owner swap via `displayGrid` so each player sees
 *   their own tiles as their own color. This module does the same
 *   normalization for data that flows OUT over the wire (history endpoint,
 *   bet-history, etc.) so external consumers see perspective-aware fields
 *   ("You / Opponent" rather than "P1 / P2").
 *
 *   The multiplayer `end` route, `get-bet-history`, and `user-stats`
 *   already do this kind of normalization inline. This helper centralizes
 *   it so the history endpoint can use the same code path without each
 *   row being parsed by hand.
 */

export type DuelPlayer = "player1" | "player2";

export interface HexDuelHistoryRow {
  id: number;
  player1Id: string;
  player2Id: string | null;
  wagerAmount: string | number;
  winner: string;
  result: string;
  payout: string | null;
  isAiGame: boolean;
  aiDifficulty: string | null;
  player1Moves: number;
  player2Moves: number;
  player1Territory: number;
  player2Territory: number;
  durationSeconds: number;
  status: string;
  isFunMode: boolean;
  startedAt: string | Date | null;
  endedAt: string | Date | null;
  createdAt: string | Date;
  /** Optional joined names for opponent display */
  opponentName?: string | null;
}

export interface HexDuelHistoryPerspective {
  /** Which engine seat the viewer occupied: "player1" or "player2" */
  viewerSide: DuelPlayer;
  /** True iff viewer is the host (player1) */
  isHost: boolean;
  /** Did the viewer win? (Uses the DB `result` field directly if present;
   *  otherwise derived from winner + viewerSide.) */
  viewerWon: boolean;
  /** Viewer's move count */
  viewerMoves: number;
  /** Opponent's move count */
  opponentMoves: number;
  /** Viewer's territory (tiles) */
  viewerTerritory: number;
  /** Opponent's territory */
  opponentTerritory: number;
  /** True iff opponent is the AI (game was AI mode AND viewer is human) */
  opponentIsAi: boolean;
  /** AI difficulty when opponent is AI */
  opponentAiDifficulty: string | null;
}

/**
 * Determine which engine seat the viewer occupied.
 * - If the viewer is player1, returns "player1".
 * - If the viewer is player2, returns "player2".
 * - If neither (shouldn't happen for matches the viewer played), returns
 *   "player1" as a safe default — the resulting fields will reflect an
 *   from-player1 POV, which is what the existing records already encode.
 */
export function getViewerSide(
  row: Pick<HexDuelHistoryRow, "player1Id" | "player2Id">,
  viewerClerkId: string
): DuelPlayer {
  if (row.player1Id === viewerClerkId) return "player1";
  if (row.player2Id === viewerClerkId) return "player2";
  return "player1";
}

/**
 * Returns `true` iff the viewer won the game from their POV.
 *
 *   - If the row has a populated `result` field ("win" or "loss") recorded
 *     by the server from the viewer's perspective (as in `multiplayer/end`
 *     and `end-game` routes), trust that field.
 *   - Otherwise derive from engine winner + viewerSide.
 */
export function didViewerWin(
  row: Pick<HexDuelHistoryRow, "winner" | "result">,
  viewerSide: DuelPlayer
): boolean {
  const result = String(row.result ?? "").toLowerCase();
  if (result === "win") return true;
  if (result === "loss" || result === "lose" || result === "lost") return false;

  // No authoritative per-viewer result recorded (e.g. older row, or row
  // saved with engine-absolute result that wasn't normalized). Fall back to
  // deriving from engine winner.
  const winner = String(row.winner ?? "");
  if (winner === "draw") return false;
  return winner === viewerSide;
}

export function normalizeHexDuelForViewer(
  row: HexDuelHistoryRow,
  viewerClerkId: string
): HexDuelHistoryPerspective {
  const viewerSide = getViewerSide(row, viewerClerkId);
  const isViewerPlayer1 = viewerSide === "player1";

  return {
    viewerSide,
    isHost: isViewerPlayer1,
    viewerWon: didViewerWin(row, viewerSide),
    viewerMoves: isViewerPlayer1 ? row.player1Moves : row.player2Moves,
    opponentMoves: isViewerPlayer1 ? row.player2Moves : row.player1Moves,
    viewerTerritory: isViewerPlayer1
      ? row.player1Territory
      : row.player2Territory,
    opponentTerritory: isViewerPlayer1
      ? row.player2Territory
      : row.player1Territory,
    opponentIsAi: Boolean(row.isAiGame),
    opponentAiDifficulty: row.isAiGame ? row.aiDifficulty ?? null : null,
  };
}
