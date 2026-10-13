/**
 * Chess VS-AI — the AI's TURN: assessment, the atomic claim, and finalization.
 *
 * THE FLOW THIS MODULE SERVES
 * ---------------------------
 *   1. The human's move is persisted by the EXISTING route (`/api/chess/move`),
 *      which authorizes the caller as a seat of the game and appends one row.
 *   2. The client asks `POST /api/chess/ai-move` for the reply, sending nothing
 *      but the game id.
 *   3. The route assesses the game (this module), generates a move with
 *      `chessGameplayEngine`, then CLAIMS the turn (this module) to write it.
 *
 * WHAT THE CLIENT MAY DECIDE: nothing. The endpoint reads the game row, the
 * persisted history, the seat ownership and the stored difficulty from the
 * database. No FEN, move, difficulty, player id or turn indicator from the
 * request body is ever consulted — the body carries a game id and nothing else.
 *
 * THE RACE, AND HOW THE CLAIM CLOSES IT
 * -------------------------------------
 * Two requests for the same turn (a double-click, a retry, two tabs, a proxy
 * retry) both see "the AI is to move" and both may run the engine — the engine
 * is a shared, serialized resource and the search is deliberately NOT done under
 * a database lock (it can take a boot plus up to the tier's budget, and no
 * request should hold a row lock for that). What makes the write safe is
 * `claimAiMove`: inside ONE transaction it re-reads the row `FOR UPDATE`,
 * re-reads the persisted history, and writes ONLY if
 *
 *   * the game is still this AI game and still in progress,
 *   * the last persisted move id is EXACTLY what the caller assessed (so no
 *     other turn slipped in between), and
 *   * it is still the AI's turn in the re-read position, and
 *   * the engine's move is legal in the RE-READ position (re-validated with
 *     chess.js, never trusted from the search).
 *
 * Anything else loses the race and writes nothing. Two concurrent requests
 * therefore produce ONE move row, whichever order they reach the lock in, and a
 * retry after success finds the turn already flipped (or the game finished) and
 * is refused rather than appended twice.
 *
 * Finalization happens in the SAME transaction as the move it results from, so
 * there is no window in which a mating move exists but the game is still open.
 *
 * The store is injected (`ChessAiTurnStore`) so every one of those rules is
 * testable without a database; the route supplies the drizzle implementation.
 *
 * SERVER-ONLY. `advanceAiTurn` reaches the WASM engine (src/lib/chessGameplayEngine),
 * so this module must never be imported by a Client Component. The board talks to
 * it through the HTTP endpoint, which is the point.
 */

import { Chess } from "chess.js";

import { CHESS_AI_PLAYER_ID, type ChessSeatColor } from "./chessAiSeat";
import {
  chessAiDifficultyFromMatch,
  type ChessAiDifficulty,
} from "./chessDifficulty";
import {
  ChessGameplayEngineError,
  chooseGameplayMove,
} from "./chessGameplayEngine";
import { toStoredUci } from "./chessMoveUci";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Every way this module refuses to produce or persist a move. */
export class ChessAiTurnError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "ChessAiTurnError";
    if (options && "cause" in options) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

// ════════════════════════════════════════════════════════════════════
// Rows (the columns this module needs — nothing more)
// ════════════════════════════════════════════════════════════════════

export type ChessGameSeatRow = {
  id: string;
  playerWhiteId: string | null;
  playerBlackId: string | null;
  status: string;
  isAiGame: boolean;
  aiDifficulty: string | null;
};

export type ChessAiMoveRow = {
  id: number;
  playedBy: string;
  moveUci: string;
  moveSan: string;
  fenAfter: string;
};

/** The move that was written, as the client needs to render it. */
export type AiMoveSummary = {
  san: string;
  uci: string;
  from: string;
  to: string;
  promotion: string | null;
};

/** The authoritative state of the game, in the shape both answers carry. */
export type AiTurnState = {
  gameId: string;
  status: string;
  /** Whose turn it is in the authoritative position. */
  turn: ChessSeatColor;
  fen: string;
  isGameOver: boolean;
  winnerId: string | null;
  result: string | null;
  /** The colour the requesting human plays, from the seat columns. */
  humanColor: ChessSeatColor | null;
  /** The colour the bot plays. Always the other seat. */
  aiColor: ChessSeatColor | null;
  /** Plies persisted for this game. */
  moveCount: number;
};

// ════════════════════════════════════════════════════════════════════
// Request
// ════════════════════════════════════════════════════════════════════

export type ParsedAiTurnRequest =
  | { ok: true; gameId: string }
  | { ok: false; error: string };

/**
 * Validate the request body.
 *
 * The body is allowed to contain `gameId` and nothing else matters: every other
 * field a client might add (a FEN, a move, a difficulty, a player id, a turn
 * indicator) is ignored by construction, because nothing below reads it. A
 * malformed or absent body is a 400 rather than a defaulted game — there is no
 * sensible default for "which game".
 */
export function parseAiTurnRequest(body: unknown): ParsedAiTurnRequest {
  const record =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  const gameId = String(record.gameId ?? "").trim();
  if (!UUID_RE.test(gameId)) {
    return { ok: false, error: "Invalid gameId" };
  }
  return { ok: true, gameId };
}

// ════════════════════════════════════════════════════════════════════
// The authoritative position
// ════════════════════════════════════════════════════════════════════

/**
 * Rebuilds the position from the PERSISTED history — the last row's `fenAfter`,
 * or the initial position when nothing has been played yet.
 *
 * A row whose stored FEN cannot be loaded is an error, never a fresh board: the
 * alternative is to silently restart a game in progress, which is exactly the
 * class of bug this whole flow exists to prevent.
 */
export function positionAfter(moves: ChessAiMoveRow[]): Chess {
  const last = moves.length > 0 ? moves[moves.length - 1].fenAfter : null;
  if (!last) return new Chess();
  try {
    return new Chess(String(last));
  } catch (err) {
    throw new ChessAiTurnError(
      `the persisted move history ends in an unusable position ("${last}")`,
      { cause: err },
    );
  }
}

/** The seat id for a colour. */
export function seatIdFor(
  seats: { playerWhiteId: string | null; playerBlackId: string | null },
  color: ChessSeatColor,
): string | null {
  return color === "white" ? seats.playerWhiteId : seats.playerBlackId;
}

/** The colour of the side to move in a position. */
export function colorToMove(chess: Chess): ChessSeatColor {
  return chess.turn() === "w" ? "white" : "black";
}

/**
 * The result a finished position implies, attributed to the seat that owns it.
 *
 * A draw is `winnerId: null`; otherwise the side to move is the side that has
 * been mated, so the winner is the OTHER seat. The winner id is a real seat id
 * from the row — for a VS-AI game that is the bot sentinel when the bot mates,
 * which is the same "the winner is the seat that delivered it" convention
 * `/api/chess/move` already uses.
 */
export function terminalResultFor(
  chess: Chess,
  seats: { playerWhiteId: string | null; playerBlackId: string | null },
): { winnerId: string | null; result: "win" | "draw" } {
  const isDraw =
    chess.isDraw() ||
    chess.isStalemate() ||
    chess.isInsufficientMaterial() ||
    chess.isThreefoldRepetition();
  if (isDraw) return { winnerId: null, result: "draw" };

  const mated = colorToMove(chess);
  return {
    winnerId: seatIdFor(seats, mated === "white" ? "black" : "white"),
    result: "win",
  };
}

/** The state a client can resync from. */
export function buildAiTurnState(
  game: ChessGameSeatRow,
  moves: ChessAiMoveRow[],
  position: Chess,
  humanColor: ChessSeatColor | null,
  aiColor: ChessSeatColor | null,
): AiTurnState {
  return {
    gameId: game.id,
    status: game.status,
    turn: colorToMove(position),
    fen: position.fen(),
    isGameOver: position.isGameOver(),
    winnerId: null,
    result: null,
    humanColor,
    aiColor,
    moveCount: moves.length,
  };
}

// ════════════════════════════════════════════════════════════════════
// Assessment — may the AI move at all?
// ════════════════════════════════════════════════════════════════════

export type AiTurnRejection =
  | "not_a_seat"
  | "not_ai_game"
  | "invalid_history"
  | "not_active"
  | "terminal"
  | "not_ai_turn";

export type AiTurnAssessment =
  | {
      ok: true;
      humanColor: ChessSeatColor;
      aiColor: ChessSeatColor;
      difficulty: ChessAiDifficulty;
      /** The position to search, built from the persisted history. */
      fen: string;
      /** What the claim must still see as the newest move, or it backs off. */
      lastMoveId: number | null;
      position: Chess;
      state: AiTurnState;
    }
  | { ok: false; reason: AiTurnRejection; state: AiTurnState | null };

/**
 * Decides whether this game is ready for an AI turn.
 *
 * `humanMatches` is the route's alias test for the authenticated caller, so seat
 * ownership is resolved from the row — never from the request.
 *
 * The rejection order matters: ownership first (a non-seat must not learn
 * anything about the game), then "is this even a VS-AI game", then the history
 * (an unusable one cannot be assessed), then liveness, then whether the position
 * is already over, and only then whose turn it is.
 */
export function assessAiTurn(input: {
  game: ChessGameSeatRow;
  moves: ChessAiMoveRow[];
  humanMatches: (id: string) => boolean;
}): AiTurnAssessment {
  const { game, moves, humanMatches } = input;

  const humanColor =
    game.playerWhiteId && humanMatches(String(game.playerWhiteId))
      ? "white"
      : game.playerBlackId && humanMatches(String(game.playerBlackId))
        ? "black"
        : null;
  if (!humanColor) return { ok: false, reason: "not_a_seat", state: null };

  const aiColor: ChessSeatColor = humanColor === "white" ? "black" : "white";

  let position: Chess;
  try {
    position = positionAfter(moves);
  } catch {
    return { ok: false, reason: "invalid_history", state: null };
  }

  const state = buildAiTurnState(game, moves, position, humanColor, aiColor);

  if (!game.isAiGame) return { ok: false, reason: "not_ai_game", state };
  if (game.status !== "in_progress") {
    return { ok: false, reason: "not_active", state };
  }
  if (position.isGameOver()) return { ok: false, reason: "terminal", state };
  if (colorToMove(position) !== aiColor) {
    return { ok: false, reason: "not_ai_turn", state };
  }

  return {
    ok: true,
    humanColor,
    aiColor,
    // The stored tier, coerced — a legacy row with a NULL difficulty plays at
    // the documented default (medium) rather than failing to move at all.
    difficulty: chessAiDifficultyFromMatch({ aiDifficulty: game.aiDifficulty }),
    fen: position.fen(),
    lastMoveId: moves.length > 0 ? moves[moves.length - 1].id : null,
    position,
    state,
  };
}

// ════════════════════════════════════════════════════════════════════
// The claim — the only place an AI move is written
// ════════════════════════════════════════════════════════════════════

export type ChessAiTurnTx = {
  /** `SELECT … FOR UPDATE` on the game row. */
  lockGame: () => Promise<ChessGameSeatRow | null>;
  /** The persisted history, oldest first. */
  loadMoves: () => Promise<ChessAiMoveRow[]>;
  /** Appends ONE move row. */
  appendMove: (move: {
    playedBy: string;
    moveUci: string;
    moveSan: string;
    fenAfter: string;
  }) => Promise<void>;
  /** Persists the terminal state of the locked row. */
  finishGame: (result: {
    winnerId: string | null;
    result: "win" | "draw";
  }) => Promise<void>;
};

/**
 * The transactional seam. The route implements it with `db.transaction`; tests
 * implement it with an in-memory store whose lock is a real mutex, so the
 * ordering rules above are exercised for real.
 */
export type ChessAiTurnStore = {
  run: <T>(fn: (tx: ChessAiTurnTx) => Promise<T>) => Promise<T>;
};

export type AiMoveClaimRequest = {
  gameId: string;
  aiColor: ChessSeatColor;
  /** The newest move id the caller assessed — the optimistic-concurrency token. */
  expectedLastMoveId: number | null;
  /**
   * The ENGINE's move, in stored UCI — re-validated here before it is written.
   *
   * `null` is the repair call: there is no move to apply, and the only thing
   * this invocation may do is record an already-terminal position as finished.
   * If the position turns out NOT to be terminal, that call writes nothing.
   */
  chosenUci: string | null;
};

/**
 * How each refusal reads to the caller. Kept beside the reasons so the route
 * cannot invent its own wording (or its own status codes) for them.
 *
 * `not_a_seat` answers 404 like `/api/chess/move` does: a caller who holds
 * neither seat must not be able to tell an existing game from a missing one.
 * Everything 409-shaped means "the game is not where you think it is", except
 * `invalid_history`, which is a server-side data problem rather than a race.
 */
export const AI_TURN_REFUSALS: Record<
  string,
  { status: 400 | 404 | 409; error: string }
> = {
  missing: { status: 404, error: "Game not found" },
  not_a_seat: { status: 404, error: "Game not found" },
  not_ai_game: { status: 400, error: "Not a Chess AI game" },
  invalid_history: { status: 409, error: "Game state is unavailable" },
  not_active: { status: 409, error: "Game is not active" },
  stale: { status: 409, error: "The game already moved on" },
  not_ai_turn: { status: 409, error: "Not the AI's turn" },
  terminal: { status: 409, error: "Game is already over" },
  invalid_move: { status: 409, error: "The AI produced an unusable move" },
  no_move_supplied: { status: 409, error: "No move to apply" },
};

export type AiMoveClaimOutcome =
  | {
      ok: true;
      status: "moved" | "finished";
      state: AiTurnState;
      aiMove: AiMoveSummary | null;
    }
  | {
      ok: false;
      reason:
        | "missing"
        | "not_ai_game"
        | "invalid_history"
        | "not_active"
        | "stale"
        | "not_ai_turn"
        | "invalid_move"
        | "no_move_supplied";
      state: AiTurnState | null;
    };

/**
 * Applies and persists the AI's move, or backs off without writing.
 *
 * @throws {ChessAiTurnError} never — every refusal is a returned reason, so the
 *   route can answer precisely; a thrown error here would hide which rule held.
 */
export async function claimAiMove(
  request: AiMoveClaimRequest,
  store: ChessAiTurnStore,
): Promise<AiMoveClaimOutcome> {
  return store.run(async (tx) => {
    const game = await tx.lockGame();
    if (!game) return { ok: false, reason: "missing", state: null };
    if (!game.isAiGame) return { ok: false, reason: "not_ai_game", state: null };

    const moves = await tx.loadMoves();

    // The optimistic token: if anything was appended since the caller assessed
    // the game, this turn is no longer the one it saw.
    const lastMoveId = moves.length > 0 ? moves[moves.length - 1].id : null;
    if (lastMoveId !== request.expectedLastMoveId) {
      return { ok: false, reason: "stale", state: null };
    }

    let position: Chess;
    try {
      position = positionAfter(moves);
    } catch {
      return { ok: false, reason: "invalid_history", state: null };
    }

    const seats = {
      playerWhiteId: game.playerWhiteId,
      playerBlackId: game.playerBlackId,
    };
    const humanColor: ChessSeatColor =
      request.aiColor === "white" ? "black" : "white";
    const buildState = () =>
      buildAiTurnState(game, moves, position, humanColor, request.aiColor);

    if (game.status !== "in_progress") {
      return { ok: false, reason: "not_active", state: buildState() };
    }

    // REPAIR: an in-progress row whose position is already terminal (a history
    // written before this endpoint existed, or a failed finalize). No move is
    // fabricated — the game is simply recorded as finished, once, atomically.
    if (position.isGameOver()) {
      const terminal = terminalResultFor(position, seats);
      await tx.finishGame(terminal);
      const finished = buildState();
      return {
        ok: true,
        status: "finished",
        aiMove: null,
        state: {
          ...finished,
          status: "finished",
          isGameOver: true,
          winnerId: terminal.winnerId,
          result: terminal.result,
        },
      };
    }

    if (colorToMove(position) !== request.aiColor) {
      return { ok: false, reason: "not_ai_turn", state: buildState() };
    }

    // The repair call brought nothing to apply and the position is not terminal
    // after all — there is nothing to write, so nothing is written.
    if (request.chosenUci === null) {
      return { ok: false, reason: "no_move_supplied", state: buildState() };
    }

    // Re-validate the engine's move against the position we just re-read under
    // the lock. An engine answer that does not fit is refused, not repaired.
    let applied;
    try {
      applied = position.move({
        from: request.chosenUci.slice(0, 2),
        to: request.chosenUci.slice(2, 4),
        promotion:
          request.chosenUci.length > 4
            ? request.chosenUci.slice(4, 5)
            : undefined,
      });
    } catch {
      applied = null;
    }
    if (!applied) {
      return { ok: false, reason: "invalid_move", state: buildState() };
    }

    const storedUci = toStoredUci(applied) || request.chosenUci;
    const fenAfter = position.fen();
    const isOver = position.isGameOver();

    await tx.appendMove({
      playedBy: CHESS_AI_PLAYER_ID,
      moveUci: storedUci,
      moveSan: applied.san,
      fenAfter,
    });

    const aiMove: AiMoveSummary = {
      san: applied.san,
      uci: storedUci,
      from: applied.from,
      to: applied.to,
      promotion: applied.promotion ?? null,
    };

    if (!isOver) {
      return {
        ok: true,
        status: "moved",
        aiMove,
        state: {
          ...buildState(),
          turn: colorToMove(position),
          fen: fenAfter,
          moveCount: moves.length + 1,
        },
      };
    }

    // Terminal: the row is finished in the SAME transaction as the move.
    const terminal = terminalResultFor(position, seats);
    await tx.finishGame(terminal);

    return {
      ok: true,
      status: "finished",
      aiMove,
      state: {
        ...buildState(),
        status: "finished",
        turn: colorToMove(position),
        fen: fenAfter,
        isGameOver: true,
        winnerId: terminal.winnerId,
        result: terminal.result,
        moveCount: moves.length + 1,
      },
    };
  });
}

// ════════════════════════════════════════════════════════════════════
// The turn — assessment, the search, and the claim
// ════════════════════════════════════════════════════════════════════

/**
 * The failure variants, selected explicitly.
 *
 * WHY NOT `if (!x.ok)`: this repo compiles with `strict: false`, where a boolean
 * literal discriminant is not narrowed — `if (!x.ok)` leaves the union intact and
 * `x.reason` does not type-check. A type predicate narrows regardless of that
 * setting, so the failure branch is stated instead of assumed.
 */
export type AiTurnRefusalAssessment = Extract<AiTurnAssessment, { ok: false }>;
export type AiMoveClaimRefusal = Extract<AiMoveClaimOutcome, { ok: false }>;

export function isAiTurnRefusal(
  value: AiTurnAssessment,
): value is AiTurnRefusalAssessment {
  return value.ok === false;
}

export function isClaimRefusal(
  value: AiMoveClaimOutcome,
): value is AiMoveClaimRefusal {
  return value.ok === false;
}

/** The read-only side of the database, injected the same way the store is. */
export type AiTurnReader = {
  loadGame: (gameId: string) => Promise<ChessGameSeatRow | null>;
  loadMoves: (gameId: string) => Promise<ChessAiMoveRow[]>;
};

export type AdvanceAiTurnDeps = {
  reader: AiTurnReader;
  store: ChessAiTurnStore;
  /**
   * The engine. Defaults to the Stage 1 server-side chooser, which is the only
   * thing that GENERATES an AI move; injected so tests can drive an engine that
   * fails, times out or answers with junk without booting WASM.
   */
  chooseMove?: (
    request: { fen: string; difficulty: unknown },
  ) => Promise<{ uci: string }>;
};

export type AiTurnSuccess = AiTurnState & {
  aiMove: AiMoveSummary | null;
  /** The tier the search ran at — the row's, never the caller's. */
  difficulty: ChessAiDifficulty;
  /**
   * What THIS call did, as opposed to `status`, which is the ROW's status:
   *
   *   * `moved`    — the bot's move was appended and the game continues,
   *   * `finished` — the bot's move was appended AND it ended the game,
   *   * `repaired` — nothing was appended; an already-over position on an open
   *                  row was recorded as finished.
   */
  outcome: "moved" | "finished" | "repaired";
};

export type AdvanceAiTurnOutcome =
  | { ok: true; data: AiTurnSuccess }
  | {
      ok: false;
      status: 400 | 404 | 409 | 503;
      error: string;
      reason: string;
      state: AiTurnState | null;
    };

/**
 * Advances a VS-AI game by one AI move — the endpoint's whole behaviour, with
 * the database and the engine both injected.
 *
 * Order of operations, and why:
 *   1. read the row and the persisted history (the ONLY inputs),
 *   2. assess: ownership, AI game, liveness, terminality, the turn,
 *   3. search — outside any lock, because an engine boot plus a search is not
 *      something to hold a database transaction for,
 *   4. claim — inside one transaction, which re-checks all of (2) and refuses
 *      rather than writing if anything moved.
 *
 * A refusal NEVER writes, and an engine failure never even reaches the claim,
 * so a game that could not be advanced is left exactly as it was — retryable.
 */
export async function advanceAiTurn(
  request: {
    gameId: string;
    humanMatches: (id: string) => boolean;
  },
  deps: AdvanceAiTurnDeps,
): Promise<AdvanceAiTurnOutcome> {
  const chooseMove =
    deps.chooseMove ??
    ((search: { fen: string; difficulty: unknown }) =>
      chooseGameplayMove(search).then((chosen) => ({ uci: chosen.uci })));

  const game = await deps.reader.loadGame(request.gameId);
  if (!game) {
    return { ok: false, ...AI_TURN_REFUSALS.missing, reason: "missing", state: null };
  }

  const moves = await deps.reader.loadMoves(request.gameId);
  const assessed = assessAiTurn({
    game,
    moves,
    humanMatches: request.humanMatches,
  });

  if (isAiTurnRefusal(assessed)) {
    // An in-progress row whose position is already over is the one refusal the
    // claim can REPAIR: it records the finished game and invents no move.
    if (assessed.reason === "terminal" && assessed.state?.aiColor) {
      const repair = await claimAiMove(
        {
          gameId: request.gameId,
          aiColor: assessed.state.aiColor,
          expectedLastMoveId:
            moves.length > 0 ? moves[moves.length - 1].id : null,
          chosenUci: null,
        },
        deps.store,
      );
      if (!isClaimRefusal(repair)) {
        return {
          ok: true,
          data: {
            ...repair.state,
            aiMove: null,
            outcome: "repaired",
            difficulty: chessAiDifficultyFromMatch({
              aiDifficulty: game.aiDifficulty,
            }),
          },
        };
      }
      const refusal = AI_TURN_REFUSALS[repair.reason] ?? AI_TURN_REFUSALS.not_ai_turn;
      return {
        ok: false,
        ...refusal,
        reason: repair.reason,
        state: repair.state,
      };
    }

    const refusal =
      AI_TURN_REFUSALS[assessed.reason] ?? AI_TURN_REFUSALS.not_ai_turn;
    return {
      ok: false,
      ...refusal,
      reason: assessed.reason,
      state: assessed.state,
    };
  }

  let chosen: { uci: string };
  try {
    chosen = await chooseMove({
      fen: assessed.fen,
      difficulty: assessed.difficulty,
    });
  } catch (err) {
    if (err instanceof ChessGameplayEngineError) {
      // Nothing was written and the row is untouched, so the client can retry
      // the same turn. This is the ONLY failure that is retryable in place.
      return {
        ok: false,
        status: 503,
        error: "The AI could not move right now",
        reason: "engine_failed",
        state: assessed.state,
      };
    }
    throw err;
  }

  const claimed = await claimAiMove(
    {
      gameId: request.gameId,
      aiColor: assessed.aiColor,
      expectedLastMoveId: assessed.lastMoveId,
      chosenUci: chosen.uci,
    },
    deps.store,
  );

  if (isClaimRefusal(claimed)) {
    const refusal = AI_TURN_REFUSALS[claimed.reason] ?? AI_TURN_REFUSALS.not_ai_turn;
    return {
      ok: false,
      ...refusal,
      reason: claimed.reason,
      state: claimed.state,
    };
  }

  return {
    ok: true,
    data: {
      ...claimed.state,
      aiMove: claimed.aiMove,
      outcome: claimed.status,
      difficulty: assessed.difficulty,
    },
  };
}
