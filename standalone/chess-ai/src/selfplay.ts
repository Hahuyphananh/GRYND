/**
 * Self-play driver — used by the Phase 2 browser harness (and by tests with a
 * fake engine) to prove the adapter can carry a WHOLE game.
 *
 * Every move is checked against chess.js before it is applied. An engine answer
 * that is not legal stops the game as a failure rather than being "fixed" —
 * self-play is the proof, so a fabricated move must not be able to hide here.
 */

import { Chess } from "chess.js";

import type { ChessEngine } from "./engine";
import type { ChessAiDifficulty, ChessAiSearchSettings } from "./chessDifficulty";
import { terminationOf, type EndReason, type SeatColor } from "./match";

export type SelfPlayPly = {
  ply: number;
  color: SeatColor;
  uci: string;
  san: string;
  fenAfter: string;
  /** The settings the engine actually searched with, when it reported them. */
  settings?: ChessAiSearchSettings;
};

export type SelfPlayReport = {
  plies: number;
  moves: SelfPlayPly[];
  termination: EndReason | null;
  /** The winning seat, or null for a draw / unfinished game. */
  winner: SeatColor | null;
  durationMs: number;
  /** Set when the game could not continue: no move from the engine, or an illegal one. */
  stalled: boolean;
};

export type SelfPlayOptions = {
  whiteTier: ChessAiDifficulty;
  blackTier: ChessAiDifficulty;
  /** Hard cap so a pathological game cannot run forever. */
  maxPlies?: number;
  fen?: string;
  onPly?: (ply: SelfPlayPly, chess: Chess) => void;
};

export async function playSelfPlay(
  engine: Pick<ChessEngine, "chooseMove">,
  options: SelfPlayOptions
): Promise<SelfPlayReport> {
  const maxPlies = options.maxPlies ?? 300;
  const chess = options.fen ? new Chess(options.fen) : new Chess();
  const moves: SelfPlayPly[] = [];
  const startedAt = Date.now();
  let stalled = false;

  while (!chess.isGameOver() && moves.length < maxPlies) {
    const color: SeatColor = chess.turn() === "w" ? "white" : "black";
    const tier = color === "white" ? options.whiteTier : options.blackTier;
    const legal = new Set(
      chess.moves({ verbose: true }).map((move) => `${move.from}${move.to}${move.promotion ?? ""}`)
    );
    if (legal.size === 0) break;

    const choice = await engine.chooseMove(chess.fen(), tier);
    const { uci } = choice;
    if (uci === null) {
      stalled = true;
      break;
    }
    if (!legal.has(uci)) {
      throw new Error(`self-play: engine returned an illegal move ${uci} in ${chess.fen()}`);
    }

    const from = uci.slice(0, 2);
    const to = uci.slice(2, 4);
    const promotion = uci.length > 4 ? uci.slice(4) : undefined;
    const played = chess.move({ from, to, promotion });
    if (!played) throw new Error(`self-play: could not apply ${uci}`);

    const ply: SelfPlayPly = {
      ply: moves.length + 1,
      color,
      uci,
      san: played.san,
      fenAfter: chess.fen(),
      settings: choice.settings,
    };
    moves.push(ply);
    options.onPly?.(ply, chess);
  }

  const termination = terminationOf(chess);
  let winner: SeatColor | null = null;
  if (termination === "checkmate") {
    // The side to move is the one that has been mated.
    winner = chess.turn() === "w" ? "black" : "white";
  }

  return {
    plies: moves.length,
    moves,
    termination,
    winner,
    durationMs: Date.now() - startedAt,
    stalled,
  };
}
