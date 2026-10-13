/**
 * Exact Tic-Tac-Toe evaluator (src/lib/tic-tac-toe/*).
 *
 * ── WHAT IS AND ISN'T EXACTLY EVALUABLE ──────────────────────────────────
 * The shipped game is MEGA Tic-Tac-Toe: one 3x3 board at stage 1 (a line WINS
 * the match, a full-board draw EXPANDS), four boards at stage 2, nine at stage
 * 3, plus a cell-count tiebreak and sudden-death boards (see
 * src/lib/tic-tac-toe/types.ts and constants.ts). A Mega match is NOT a solved
 * game — the lattice has on the order of 3^81 positions and the tiebreak
 * rewards cell counts, so no small exact solver exists for it.
 *
 * Stage 1 alone IS the classic solved 3x3 game. So this evaluator reports
 * `exact` analysis ONLY for a match that was DECIDED WITHIN STAGE 1 — a win on
 * the single opening board before it filled. Every such match is, end to end,
 * ordinary tic-tac-toe, and every one of its moves can be judged exactly.
 *
 * Everything else is reported as `unavailable` with a machine reason — never a
 * fabricated "optimal move":
 *   - a match that expanded (stage 2 / 3 / sudden death, or a stage-1 draw),
 *   - a match finalised by forfeit or cancel (no played-out history),
 *   - a history that does not replay, is mis-attributed, or disagrees with the
 *     persisted result.
 *
 * ── TRUST BOUNDARY ───────────────────────────────────────────────────────
 * Nothing here reads a client-supplied mark, board, winner or result. The board
 * is replayed with the SAME pure engine the server ran
 * (`validateMove` → `applyMove` from ../tic-tac-toe/rules), from the append-only
 * `tic_tac_toe_moves` log; the persisted `game_state`/`result` are only ever
 * used to CONFIRM that replay, never as the source of truth. A mismatch is
 * rejected, not repaired.
 */

import { asc, eq } from "drizzle-orm";

import { db } from "../../../db/client";
import { ticTacToeMatches, ticTacToeMoves } from "../../../db/schema";
import { CELL_COUNT } from "../../tic-tac-toe/constants";
import type { Cell, Mark, Seat, SmallBoard, TicTacToeState } from "../../tic-tac-toe/types";
import {
  applyMove,
  createInitialState,
  findWinningLine,
  markForSeat,
  seatForPly,
  seatsFromMatch,
  userIdForSeat,
  validateMove,
} from "../../tic-tac-toe/rules";
import {
  GAME_REPORT_SCHEMA_VERSION,
  metric,
  type GameReportKeyMoment,
  type GameReportMetric,
  type GameReportMove,
  type GameReportV1,
} from "../gameReport";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const GAME_KEY = "tic-tac-toe";

// ════════════════════════════════════════════════════════════════════
// Reason codes (machine-readable; the service maps them to HTTP)
// ════════════════════════════════════════════════════════════════════

export type TicTacToeUnavailableReason =
  | "game_not_found"
  | "match_not_finished"
  | "history_incomplete"
  | "invalid_move_history"
  | "history_after_end"
  | "history_attribution_mismatch"
  | "result_mismatch"
  | "not_exactly_evaluable"
  | "database_error";

// ════════════════════════════════════════════════════════════════════
// Classification vocabulary (documented, disjoint, exhaustive)
// ════════════════════════════════════════════════════════════════════
//
// `best` is the outcome the mover could force from the position BEFORE the move
// (with both sides playing optimally); `after` is the outcome of the position
// AFTER the move, again under optimal play.
//
//   optimal     best === after            the move preserves the optimal outcome.
//                                         SEVERAL moves may be optimal — this
//                                         never claims uniqueness.
//   missedWin   best === win, after draw  a forced win was not preserved.
//   blunder     best === win, after loss  a won game was thrown away outright.
//   missedDraw  best === draw, after loss a draw (or better) became a forced loss.
//   unavoidable best === loss             the position was already lost with
//                                         optimal play, so no move could do
//                                         better. NEVER called a mistake.
//
// A move is never labelled merely for differing from another: only a genuine
// change of the game-theoretic outcome is classified.
export type TicTacToeMoveClassification =
  | "optimal"
  | "missedWin"
  | "blunder"
  | "missedDraw"
  | "unavoidable";

export type OutcomeValue = "win" | "draw" | "loss";

/**
 * Applies the documented classification table. Exported (like the chess
 * evaluator's `classifyMove`) so the scheme itself is unit-tested directly.
 */
export function classifyMove(
  best: OutcomeValue,
  after: OutcomeValue,
): TicTacToeMoveClassification {
  if (best === "win") {
    if (after === "win") return "optimal";
    return after === "draw" ? "missedWin" : "blunder";
  }
  if (best === "draw") return after === "draw" ? "optimal" : "missedDraw";
  return "unavoidable";
}

// ════════════════════════════════════════════════════════════════════
// Exact 3x3 solver
// ════════════════════════════════════════════════════════════════════

/**
 * Minimax over the 3x3 board, memoised by (cells, side to move).
 *
 * Returns the game value from X's point of view: `+1` X wins, `0` draw, `-1` O
 * wins, assuming both sides play optimally. The full tree is ~5.5k positions,
 * so this is microseconds — no engine, no model.
 */
function minimax(cells: Cell[], turn: Mark, memo: Map<string, number>): number {
  const win = findWinningLine(cells);
  if (win) return win.mark === "X" ? 1 : -1;
  if (cells.every((cell) => cell !== null)) return 0;

  const key = `${cells.map((cell) => cell ?? "-").join("")}${turn}`;
  const cached = memo.get(key);
  if (cached !== undefined) return cached;

  let best: number;
  if (turn === "X") {
    best = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < CELL_COUNT; i += 1) {
      if (cells[i] !== null) continue;
      cells[i] = "X";
      best = Math.max(best, minimax(cells, "O", memo));
      cells[i] = null;
    }
  } else {
    best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < CELL_COUNT; i += 1) {
      if (cells[i] !== null) continue;
      cells[i] = "O";
      best = Math.min(best, minimax(cells, "X", memo));
      cells[i] = null;
    }
  }
  memo.set(key, best);
  return best;
}

/**
 * The outcome `mark` can force from this exact position (both sides optimal).
 * Exported so tests can assert the solver's answer for a board directly.
 */
export function bestOutcomeFor(cells: Cell[], mark: Mark): OutcomeValue {
  return valueForMover(minimax([...cells], mark, new Map()), mark);
}

/** Converts an X-relative minimax score into the mover's own outcome. */
function valueForMover(score: number, mark: Mark): OutcomeValue {
  const moverScore = mark === "X" ? score : -score;
  if (moverScore > 0) return "win";
  if (moverScore < 0) return "loss";
  return "draw";
}

/** Row-major cell index → a human coordinate like `r2c3`. */
function cellLabel(cellIndex: number): string {
  const row = Math.floor(cellIndex / 3) + 1;
  const col = (cellIndex % 3) + 1;
  return `r${row}c${col}`;
}

// ════════════════════════════════════════════════════════════════════
// Pure analysis (unit-testable without a database)
// ════════════════════════════════════════════════════════════════════

export type TicTacToeMoveRow = {
  ply: number;
  playerId: string;
  boardIndex: number;
  cellIndex: number;
};

export type TicTacToeMatchInput = {
  matchId: string;
  player1Id: string;
  player2Id: string | null;
  winnerId: string | null;
  status: string | null;
  result: string | null;
  /** The row's denormalised ply counter. */
  ply: number;
  /** The persisted authoritative state blob (used only to CONFIRM the replay). */
  gameState: unknown;
  endedAtIso: string | null;
  moves: TicTacToeMoveRow[];
};

type AnalysisOutcome =
  | { ok: true; state: TicTacToeState; ordered: TicTacToeMoveRow[] }
  | { ok: false; reason: TicTacToeUnavailableReason };

/**
 * Replays the append-only log strictly.
 *
 * Unlike `replayMoves` (which skips a move it cannot apply so a partial log
 * "degrades instead of corrupting"), this REJECTS: a history that cannot be
 * replayed exactly is not eligible for an exact evaluation. Every move is
 * checked for ply continuity, correct attribution (the logged player must be
 * the seat whose turn the reconstructed state says it is), legality, and
 * absence of play after the match ended.
 */
function replayStrict(input: TicTacToeMatchInput): AnalysisOutcome {
  if (!Array.isArray(input.moves) || input.moves.length === 0) {
    return { ok: false, reason: "history_incomplete" };
  }

  const ordered = [...input.moves].sort((a, b) => a.ply - b.ply);
  // Ply numbering must be exactly 0..n-1 — no gaps, no duplicates.
  for (let i = 0; i < ordered.length; i += 1) {
    if (Number(ordered[i].ply) !== i) return { ok: false, reason: "history_incomplete" };
  }

  const seats = seatsFromMatch({ player1Id: input.player1Id, player2Id: input.player2Id });
  let state = createInitialState();

  for (const move of ordered) {
    // Any move recorded after the match was decided is a corrupt log.
    if (state.phase === "finished") {
      return { ok: false, reason: "history_after_end" };
    }

    const expectedSeat = state.currentTurn;
    const expectedPlayer = userIdForSeat(seats, expectedSeat);
    if (!expectedPlayer || String(move.playerId) !== String(expectedPlayer)) {
      return { ok: false, reason: "history_attribution_mismatch" };
    }

    const validation = validateMove({
      state,
      seat: expectedSeat,
      boardIndex: move.boardIndex,
      cellIndex: move.cellIndex,
    });
    if (!validation.ok) return { ok: false, reason: "invalid_move_history" };

    state = applyMove({
      state,
      seat: expectedSeat,
      boardIndex: Number(move.boardIndex),
      cellIndex: Number(move.cellIndex),
    }).state;
  }

  return { ok: true, state, ordered };
}

/** Confirms the replay against the persisted state and settled result. */
function confirmsPersistedResult(
  input: TicTacToeMatchInput,
  state: TicTacToeState,
): boolean {
  const persisted = input.gameState as TicTacToeState | null;
  if (!persisted || typeof persisted !== "object") return false;

  const board = state.boards[0] as SmallBoard | null;
  const persistedBoard = Array.isArray(persisted.boards) ? persisted.boards[0] : null;
  if (!board || !persistedBoard) return false;

  const sameCells =
    Array.isArray(persistedBoard.cells) &&
    persistedBoard.cells.length === CELL_COUNT &&
    board.cells.every((cell, index) => cell === persistedBoard.cells[index]);

  if (
    !sameCells ||
    persisted.stage !== state.stage ||
    persisted.ply !== state.ply ||
    persisted.winner !== state.winner ||
    persistedBoard.control !== board.control ||
    Number(input.ply) !== state.ply
  ) {
    return false;
  }

  if (String(input.result) !== String(state.winner)) return false;
  if (!state.winner) return false;
  const expectedWinnerId = userIdForSeat(
    seatsFromMatch({ player1Id: input.player1Id, player2Id: input.player2Id }),
    state.winner,
  );
  if (String(input.winnerId ?? "") !== String(expectedWinnerId ?? "")) return false;
  return true;
}

function emptyReport(
  input: TicTacToeMatchInput,
  reason: TicTacToeUnavailableReason,
): GameReportV1 {
  const participants = [input.player1Id, input.player2Id].filter(
    (id): id is string => Boolean(id),
  );
  return {
    schemaVersion: GAME_REPORT_SCHEMA_VERSION,
    gameKey: GAME_KEY,
    analysisType: "exact",
    status: "unavailable",
    match: {
      matchId: input.matchId,
      result: input.result ?? null,
      finishedAt: input.endedAtIso ?? null,
      participants,
    },
    metrics: [],
    unavailableReason: reason,
  };
}

const CLASSIFICATION_LABELS: Record<TicTacToeMoveClassification, string> = {
  optimal: "Optimal (preserves the best available outcome)",
  missedWin: "Missed win",
  blunder: "Blunder (threw away a won game)",
  missedDraw: "Missed draw (allowed a forced loss)",
  unavoidable: "Unavoidable (the position was already lost)",
};

type Counts = Record<TicTacToeMoveClassification, number>;

function emptyCounts(): Counts {
  return { optimal: 0, missedWin: 0, blunder: 0, missedDraw: 0, unavoidable: 0 };
}

function playerMetrics(counts: Counts, outcome: string): GameReportMetric[] {
  const decisive = counts.optimal + counts.missedWin + counts.missedDraw + counts.blunder;
  const metrics: GameReportMetric[] = [
    metric("outcome", "Outcome", outcome),
    metric("moveCount", "Moves", decisive + counts.unavoidable, "count"),
    metric("optimalMoves", "Optimal moves", counts.optimal, "count"),
    metric("missedWins", "Missed wins", counts.missedWin, "count"),
    metric("missedDraws", "Missed draws", counts.missedDraw, "count"),
    metric("blunders", "Blunders", counts.blunder, "count"),
    metric("unavoidableMoves", "Moves in already-lost positions", counts.unavoidable, "count"),
  ];
  // Optimal-outcome preservation, over the moves where a better-than-forced-loss
  // outcome actually existed (a move in an already-lost position is excluded:
  // there was nothing to preserve). Exact, not an estimate.
  metrics.push(
    decisive > 0
      ? metric(
          "optimalMoveRate",
          "Optimal-outcome preservation",
          Math.round((counts.optimal / decisive) * 1000) / 10,
          "percent",
        )
      : metric("optimalMoveRate", "Optimal-outcome preservation", 0, "percent"),
  );
  return metrics;
}

/**
 * The pure analysis. Deterministic: the same input always yields the same
 * report (asserted by a repeat-evaluation test).
 */
export function analyzeTicTacToeGame(input: TicTacToeMatchInput): GameReportV1 {
  if (String(input.status ?? "") !== "finished") {
    return emptyReport(input, "match_not_finished");
  }
  if (input.result !== "player1" && input.result !== "player2") {
    // A tiebreak/`tie` result, or a match with no settled winning seat.
    return emptyReport(input, "not_exactly_evaluable");
  }

  const replayed = replayStrict(input);
  // `in`-narrowing, not a boolean discriminant: this repo compiles with
  // `strict: false`, where narrowing on a boolean literal is unreliable (see
  // the note in src/lib/tic-tac-toe/rules.ts).
  if ("reason" in replayed) return emptyReport(input, replayed.reason);
  const { state, ordered } = replayed;

  // Exact evaluation is scoped to a match decided within stage 1 (a single
  // board). An expanded match (stage 2/3, or a stage-1 draw) is not solved.
  if (state.stage !== 1 || state.winner === null) {
    return emptyReport(input, "not_exactly_evaluable");
  }

  // The replay must agree with what was persisted; a disagreement is rejected,
  // never repaired.
  if (!confirmsPersistedResult(input, state)) {
    return emptyReport(input, "result_mismatch");
  }

  const winner: Seat = state.winner;
  const memo = new Map<string, number>();
  const cells: Cell[] = Array.from({ length: CELL_COUNT }, () => null);
  const counts: Record<Seat, Counts> = { player1: emptyCounts(), player2: emptyCounts() };
  const moves: GameReportMove[] = [];
  const keyMoments: GameReportKeyMoment[] = [];

  for (const row of ordered) {
    const seat = seatForPly(row.ply);
    const mark = markForSeat(seat);
    const bestValue = valueForMover(minimax([...cells], mark, memo), mark);

    cells[row.cellIndex] = mark;
    const afterValue = valueForMover(minimax([...cells], otherSeatMark(mark), memo), mark);

    const classification = classifyMove(bestValue, afterValue);
    counts[seat][classification] += 1;

    const label = cellLabel(row.cellIndex);
    moves.push({
      ply: row.ply,
      actor: row.playerId,
      label,
      tags: [classification],
      metrics: [
        metric("cellIndex", "Cell", row.cellIndex, "count"),
        metric("optimalOutcome", "Best available outcome", bestValue),
        metric("playedOutcome", "Outcome after this move", afterValue),
      ],
    });

    if (classification !== "optimal" && classification !== "unavoidable") {
      keyMoments.push({
        ply: row.ply,
        label,
        note: `${CLASSIFICATION_LABELS[classification]} — best available: ${bestValue}, played: ${afterValue}.`,
      });
    }
  }

  const totalBlunders = counts.player1.blunder + counts.player2.blunder;
  const totalMissedWins = counts.player1.missedWin + counts.player2.missedWin;
  const totalMissedDraws = counts.player1.missedDraw + counts.player2.missedDraw;

  const metrics: GameReportMetric[] = [
    metric("moveCount", "Moves played", moves.length, "count"),
    metric("stage", "Stage reached", state.stage, "count"),
    metric("winnerSeat", "Winner", winner),
    metric("blunderCount", "Blunders", totalBlunders, "count"),
    metric("missedWinCount", "Missed wins", totalMissedWins, "count"),
    metric("missedDrawCount", "Missed draws", totalMissedDraws, "count"),
  ];

  const outcomeFor = (seat: Seat): string => (seat === winner ? "win" : "loss");

  return {
    schemaVersion: GAME_REPORT_SCHEMA_VERSION,
    gameKey: GAME_KEY,
    analysisType: "exact",
    status: "complete",
    match: {
      matchId: input.matchId,
      result: input.result,
      finishedAt: input.endedAtIso ?? null,
      participants: [input.player1Id, input.player2Id].filter(
        (id): id is string => Boolean(id),
      ),
    },
    metrics,
    players: [
      {
        playerId: input.player1Id,
        role: "player1",
        metrics: playerMetrics(counts.player1, outcomeFor("player1")),
      },
      ...(input.player2Id
        ? [
            {
              playerId: input.player2Id,
              role: "player2",
              metrics: playerMetrics(counts.player2, outcomeFor("player2")),
            },
          ]
        : []),
    ],
    moves,
    keyMoments,
    engine: null,
    ai: null,
    unavailableReason: null,
  };
}

/** The opposing mark. Local so the solver does not depend on seat vocabulary. */
function otherSeatMark(mark: Mark): Mark {
  return mark === "X" ? "O" : "X";
}

// ════════════════════════════════════════════════════════════════════
// Database entry point
// ════════════════════════════════════════════════════════════════════

/**
 * Evaluates one finished Tic-Tac-Toe match.
 *
 * Loads `tic_tac_toe_matches` + its ordered `tic_tac_toe_moves`, then runs the
 * pure analysis above. Returns an `unavailable` report (never fabricated stats
 * and never a throw for an expected condition) when the match is missing, not
 * finished, expanded past stage 1, or its history cannot be trusted.
 */
export async function evaluateTicTacToeMatch(matchId: string): Promise<GameReportV1> {
  const id = String(matchId ?? "").trim();
  const missing: TicTacToeMatchInput = {
    matchId: id,
    player1Id: "",
    player2Id: null,
    winnerId: null,
    status: null,
    result: null,
    ply: 0,
    gameState: null,
    endedAtIso: null,
    moves: [],
  };
  // `tic_tac_toe_matches.id` is a uuid column: an unvalidated string would make
  // Postgres throw instead of answering "no such match".
  if (!UUID_RE.test(id)) return emptyReport(missing, "game_not_found");

  try {
    const [match] = await db
      .select({
        id: ticTacToeMatches.id,
        player1Id: ticTacToeMatches.player1Id,
        player2Id: ticTacToeMatches.player2Id,
        winnerId: ticTacToeMatches.winnerId,
        status: ticTacToeMatches.status,
        result: ticTacToeMatches.result,
        ply: ticTacToeMatches.ply,
        gameState: ticTacToeMatches.gameState,
        endedAt: ticTacToeMatches.endedAt,
      })
      .from(ticTacToeMatches)
      .where(eq(ticTacToeMatches.id, id))
      .limit(1);

    if (!match) return emptyReport({ ...missing, matchId: id }, "game_not_found");

    const moveRows = await db
      .select({
        ply: ticTacToeMoves.ply,
        playerId: ticTacToeMoves.playerId,
        boardIndex: ticTacToeMoves.boardIndex,
        cellIndex: ticTacToeMoves.cellIndex,
      })
      .from(ticTacToeMoves)
      .where(eq(ticTacToeMoves.matchId, id))
      .orderBy(asc(ticTacToeMoves.ply));

    return analyzeTicTacToeGame({
      matchId: String(match.id),
      player1Id: String(match.player1Id),
      player2Id: match.player2Id ? String(match.player2Id) : null,
      winnerId: match.winnerId ? String(match.winnerId) : null,
      status: match.status ?? null,
      result: match.result ?? null,
      ply: Number(match.ply ?? 0),
      gameState: match.gameState,
      endedAtIso: match.endedAt ? new Date(match.endedAt).toISOString() : null,
      moves: moveRows.map((row) => ({
        ply: Number(row.ply),
        playerId: String(row.playerId),
        boardIndex: Number(row.boardIndex),
        cellIndex: Number(row.cellIndex),
      })),
    });
  } catch (err) {
    // The reason is logged server-side; the report carries only the code so no
    // driver/SQL detail can leak into a response.
    console.error("[evaluation] tic-tac-toe evaluation failed:", err);
    return emptyReport({ ...missing, matchId: id }, "database_error");
  }
}
