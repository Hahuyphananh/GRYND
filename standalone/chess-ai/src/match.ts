/**
 * Local Chess AI match controller — Phase 2.
 *
 * The single place a standalone match's rules, seats, history, clocks, undo and
 * result live. It is PURE: no React, no worker, no fetch, no storage. The board
 * (Phase 3) and the self-play harness render `view()`; the engine adapter only
 * supplies a UCI string, which `applyUci` re-validates through chess.js.
 *
 * TIME MODEL
 * ----------
 * Clocks are absolute: each side holds a remaining balance, and the side to move
 * has a `turnStartedAt`. `tick(now)` (and `clockRemaining`) derive the live
 * balance from the wall clock, so no interval is needed to keep time correct and
 * a background tab cannot lose time. A move settles the mover's clock before the
 * turn flips.
 *
 * RESULT MODEL
 * ------------
 * `status` flips to "finished" exactly once, at the moment the position or the
 * clock ends the game. `outcome` is from the HUMAN's seat, which is what the
 * result screen needs — never the board's point of view.
 */

import { Chess } from "chess.js";

import { DEFAULT_CHESS_AI_DIFFICULTY, type ChessAiDifficulty } from "./chessDifficulty";

export type SeatColor = "white" | "black";
export type MatchOutcome = "win" | "loss" | "draw";
export type MatchStatus = "playing" | "finished";

export type EndReason =
  | "checkmate"
  | "stalemate"
  | "insufficient-material"
  | "threefold-repetition"
  | "fifty-move"
  | "timeout"
  | "resign";

/** One persisted-style ply, enough to rebuild the game exactly. */
export type MoveRecord = {
  san: string;
  /** `e2e4`, `e7e8q`, `e1g1`, `e5d6`. */
  uci: string;
  fenAfter: string;
  color: SeatColor;
};

export type LocalMatch = {
  /** The live position. Mutated only by this module. */
  chess: Chess;
  humanColor: SeatColor;
  difficulty: ChessAiDifficulty;
  status: MatchStatus;
  outcome: MatchOutcome | null;
  reason: EndReason | null;
  history: MoveRecord[];
  /** Remaining time per SEAT (ms). */
  clockMs: Record<SeatColor, number>;
  /** When the side to move started its turn; null once the match is over. */
  turnStartedAt: number | null;
};

export type MoveInput = { from: string; to: string; promotion?: string };
export type MoveResult = { ok: true; record: MoveRecord } | { ok: false; error: string };

export type MatchView = {
  fen: string;
  turn: "w" | "b";
  sideToMove: SeatColor;
  humanColor: SeatColor;
  aiColor: SeatColor;
  difficulty: ChessAiDifficulty;
  status: MatchStatus;
  outcome: MatchOutcome | null;
  reason: EndReason | null;
  history: MoveRecord[];
  clocks: Record<SeatColor, number>;
  isHumanTurn: boolean;
  isAiTurn: boolean;
  canUndo: boolean;
};

/** The clock a VS-AI game has always started with (migration-compatible). */
export const DEFAULT_INITIAL_TIME_MS = 300_000;

const UCI_RE = /^([a-h][1-8])([a-h][1-8])([qrbn])?$/;

export function oppositeColor(color: SeatColor): SeatColor {
  return color === "white" ? "black" : "white";
}

/**
 * Why the position is over, or null while play continues.
 *
 * Order matters: a checkmate is also "not a draw", so the decisive endings are
 * tested first.
 */
export function terminationOf(chess: Chess): EndReason | null {
  if (chess.isCheckmate()) return "checkmate";
  if (chess.isStalemate()) return "stalemate";
  if (chess.isInsufficientMaterial()) return "insufficient-material";
  if (chess.isThreefoldRepetition()) return "threefold-repetition";
  const withFifty = chess as Chess & { isDrawByFiftyMoves?: () => boolean };
  if (typeof withFifty.isDrawByFiftyMoves === "function" && withFifty.isDrawByFiftyMoves()) {
    return "fifty-move";
  }
  if (chess.isDraw()) return "fifty-move";
  return null;
}

export function createLocalMatch(
  options: {
    humanColor?: SeatColor;
    difficulty?: ChessAiDifficulty;
    initialTimeMs?: number;
    /** Start from a position (tests, puzzles, a rematch from a FEN). */
    fen?: string;
    now?: number;
  } = {}
): LocalMatch {
  const now = options.now ?? Date.now();
  const initial = Math.max(0, options.initialTimeMs ?? DEFAULT_INITIAL_TIME_MS);
  const chess = options.fen ? new Chess(options.fen) : new Chess();

  const match: LocalMatch = {
    chess,
    humanColor: options.humanColor ?? "white",
    difficulty: options.difficulty ?? DEFAULT_CHESS_AI_DIFFICULTY,
    status: "playing",
    outcome: null,
    reason: null,
    history: [],
    clockMs: { white: initial, black: initial },
    turnStartedAt: now,
  };

  if (chess.isGameOver()) finishByPosition(match);
  return match;
}

export function sideToMove(match: LocalMatch): SeatColor {
  return match.chess.turn() === "w" ? "white" : "black";
}

export function aiColorOf(match: LocalMatch): SeatColor {
  return oppositeColor(match.humanColor);
}

export function isHumanTurn(match: LocalMatch): boolean {
  return match.status === "playing" && sideToMove(match) === match.humanColor;
}

export function isAiTurn(match: LocalMatch): boolean {
  return match.status === "playing" && sideToMove(match) !== match.humanColor;
}

/** Legal moves in the current position, as stored UCI. */
export function legalUci(match: LocalMatch): string[] {
  return match.chess
    .moves({ verbose: true })
    .map((move) => `${move.from}${move.to}${move.promotion ?? ""}`);
}

/**
 * Play one move for whichever side is to move.
 *
 * chess.js v1 THROWS on an illegal move rather than returning null, so a bogus
 * move is an ignored result here, never a thrown handler.
 */
export function applyMove(
  match: LocalMatch,
  input: MoveInput,
  now: number = Date.now()
): MoveResult {
  if (match.status === "finished") return { ok: false, error: "the match is over" };
  if (match.chess.isGameOver()) {
    finishByPosition(match);
    return { ok: false, error: "the match is over" };
  }

  const mover = sideToMove(match);
  let move;
  try {
    move = match.chess.move({
      from: input.from,
      to: input.to,
      promotion: input.promotion,
    });
  } catch {
    return { ok: false, error: `illegal move ${input.from}${input.to}` };
  }
  if (!move) return { ok: false, error: `illegal move ${input.from}${input.to}` };

  settleClock(match, mover, now);

  const record: MoveRecord = {
    san: move.san,
    uci: `${move.from}${move.to}${move.promotion ?? ""}`,
    fenAfter: match.chess.fen(),
    color: mover,
  };
  match.history.push(record);
  match.turnStartedAt = now;

  if (match.chess.isGameOver()) finishByPosition(match);
  return { ok: true, record };
}

/** Play a UCI move (`e2e4`, `e7e8q`). Malformed input is rejected, never guessed. */
export function applyUci(match: LocalMatch, uci: string, now: number = Date.now()): MoveResult {
  const parsed = UCI_RE.exec(
    String(uci ?? "")
      .trim()
      .toLowerCase()
  );
  if (!parsed) return { ok: false, error: `malformed UCI move "${uci}"` };
  return applyMove(match, { from: parsed[1], to: parsed[2], promotion: parsed[3] }, now);
}

/**
 * Take back the human's last move (and the AI's reply, when it has already
 * played), so it is the human's turn again.
 *
 * Refused once the match is over: the result has already been recorded, and
 * rewinding it would let a loss be erased. Clocks are not refunded — undo is a
 * convenience, not a time machine.
 */
export function undo(match: LocalMatch, now: number = Date.now()): boolean {
  if (match.status === "finished" || match.history.length === 0) return false;

  const last = match.history[match.history.length - 1];
  const remove = last.color === match.humanColor ? 1 : Math.min(2, match.history.length);
  const keep = match.history.slice(0, match.history.length - remove);

  const rebuilt = new Chess();
  for (const record of keep) {
    const from = record.uci.slice(0, 2);
    const to = record.uci.slice(2, 4);
    const promotion = record.uci.length > 4 ? record.uci.slice(4) : undefined;
    try {
      rebuilt.move({ from, to, promotion });
    } catch {
      // A record that cannot be replayed is a corrupt history: refuse the undo
      // rather than leave the board on a position the history does not explain.
      return false;
    }
  }

  match.chess = rebuilt;
  match.history = keep;
  match.turnStartedAt = now;
  return true;
}

export function resign(match: LocalMatch): void {
  if (match.status === "finished") return;
  finish(match, "loss", "resign");
}

/** Advance the clock to `now`; ends the match when the side to move runs out. */
export function tick(
  match: LocalMatch,
  now: number = Date.now()
): { finished: boolean; remainingMs: number } {
  if (match.status === "finished") return { finished: true, remainingMs: 0 };
  const clock = clockRemaining(match, now);
  const side = sideToMove(match);
  if (clock[side] <= 0) {
    match.clockMs[side] = 0;
    finishByTimeout(match, side);
    return { finished: true, remainingMs: 0 };
  }
  return { finished: false, remainingMs: clock[side] };
}

/** Live balances, with the ticking side's elapsed time deducted. */
export function clockRemaining(
  match: LocalMatch,
  now: number = Date.now()
): Record<SeatColor, number> {
  const elapsed =
    match.status === "playing" && match.turnStartedAt !== null
      ? Math.max(0, now - match.turnStartedAt)
      : 0;
  const ticking = sideToMove(match);
  return {
    white: Math.max(0, match.clockMs.white - (ticking === "white" ? elapsed : 0)),
    black: Math.max(0, match.clockMs.black - (ticking === "black" ? elapsed : 0)),
  };
}

export function view(match: LocalMatch, now: number = Date.now()): MatchView {
  return {
    fen: match.chess.fen(),
    turn: match.chess.turn(),
    sideToMove: sideToMove(match),
    humanColor: match.humanColor,
    aiColor: aiColorOf(match),
    difficulty: match.difficulty,
    status: match.status,
    outcome: match.outcome,
    reason: match.reason,
    history: [...match.history],
    clocks: clockRemaining(match, now),
    isHumanTurn: isHumanTurn(match),
    isAiTurn: isAiTurn(match),
    canUndo: match.status === "playing" && match.history.length > 0,
  };
}

// ── internals ────────────────────────────────────────────────────────────

function settleClock(match: LocalMatch, mover: SeatColor, now: number): void {
  if (match.turnStartedAt === null) return;
  const elapsed = Math.max(0, now - match.turnStartedAt);
  match.clockMs[mover] = Math.max(0, match.clockMs[mover] - elapsed);
}

function finishByPosition(match: LocalMatch): void {
  const reason = terminationOf(match.chess);
  if (!reason) return;
  if (reason === "checkmate") {
    // The side to move has been mated; the other side delivered it.
    const winner = oppositeColor(sideToMove(match));
    finish(match, winner === match.humanColor ? "win" : "loss", reason);
    return;
  }
  finish(match, "draw", reason);
}

function finishByTimeout(match: LocalMatch, side: SeatColor): void {
  finish(match, side === match.humanColor ? "loss" : "win", "timeout");
}

function finish(match: LocalMatch, outcome: MatchOutcome, reason: EndReason): void {
  match.status = "finished";
  match.outcome = outcome;
  match.reason = reason;
  match.turnStartedAt = null;
}
