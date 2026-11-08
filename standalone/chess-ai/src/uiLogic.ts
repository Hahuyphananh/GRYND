/**
 * Pure presentation helpers for the standalone chess board — Phase 3.
 *
 * Everything here is testable in Node (no DOM, no React, no worker): square
 * helpers, clock labels, captured pieces, move-list rows and result copy. The
 * React components render these; they never re-derive chess rules themselves.
 */

import { Chess, type Square } from "chess.js";

import type { EndReason, MatchOutcome, MoveRecord, SeatColor } from "./match";

export const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

/** Legal destinations for a square, tagged with whether they capture. */
export function legalTargetsFrom(
  position: string,
  square: string | null
): { to: string; capture: boolean }[] {
  if (!square || !position) return [];
  try {
    return new Chess(position)
      .moves({ square: square as Square, verbose: true })
      .map((move) => ({ to: move.to, capture: Boolean(move.captured) }));
  } catch {
    return [];
  }
}

/** True when `from` → `to` is a pawn stepping onto the far rank. */
export function isPromotionMove(position: string, from: string | null, to: string | null): boolean {
  if (!position || !from || !to) return false;
  if (to[1] !== "1" && to[1] !== "8") return false;
  try {
    return new Chess(position).get(from as Square)?.type === "p";
  } catch {
    return false;
  }
}

/** `05:00`-style clock. Never renders a negative time. */
export function formatClock(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

const GLYPHS: Record<string, string> = {
  p: "♟",
  n: "♞",
  b: "♝",
  r: "♜",
  q: "♛",
  P: "♙",
  N: "♘",
  B: "♗",
  R: "♖",
  Q: "♕",
};

const INITIAL_COUNTS: Record<string, number> = {
  p: 8,
  n: 2,
  b: 2,
  r: 2,
  q: 1,
  P: 8,
  N: 2,
  B: 2,
  R: 2,
  Q: 1,
};

const PIECE_VALUES: Record<string, number> = {
  p: 1,
  n: 3,
  b: 3,
  r: 5,
  q: 9,
};

/**
 * Pieces each seat has captured, as glyphs, strongest first.
 *
 * A missing WHITE piece was captured by Black, so it is listed under `byBlack`.
 */
export function capturedPieces(fen: string): { byWhite: string[]; byBlack: string[] } {
  const board = (fen || START_FEN).split(" ")[0];
  const counts: Record<string, number> = {};
  for (const character of board) {
    if (/[pnbrqkPNBRQK]/.test(character)) {
      counts[character] = (counts[character] ?? 0) + 1;
    }
  }

  const byWhite: string[] = [];
  const byBlack: string[] = [];
  for (const [piece, initial] of Object.entries(INITIAL_COUNTS)) {
    const missing = Math.max(0, initial - (counts[piece] ?? 0));
    for (let index = 0; index < missing; index += 1) {
      if (piece === piece.toUpperCase()) byBlack.push(GLYPHS[piece]);
      else byWhite.push(GLYPHS[piece]);
    }
  }

  const value = (glyph: string) =>
    PIECE_VALUES[
      Object.keys(GLYPHS)
        .find((key) => GLYPHS[key] === glyph)
        ?.toLowerCase() ?? "p"
    ] ?? 0;
  byWhite.sort((a, b) => value(b) - value(a));
  byBlack.sort((a, b) => value(b) - value(a));
  return { byWhite, byBlack };
}

/** A capture-baiting helper for the check highlight: the king square, or null. */
export function kingSquare(fen: string): string | null {
  try {
    const chess = new Chess(fen);
    if (!chess.inCheck()) return null;
    const turn = chess.turn();
    for (const row of chess.board()) {
      for (const piece of row) {
        if (piece && piece.type === "k" && piece.color === turn) return piece.square;
      }
    }
  } catch {
    return null;
  }
  return null;
}

/** Move-list rows: `1. e4 e5`, `2. Nf3 …`. */
export function moveRows(
  history: readonly MoveRecord[]
): { number: number; white: MoveRecord | null; black: MoveRecord | null }[] {
  const rows: { number: number; white: MoveRecord | null; black: MoveRecord | null }[] = [];
  for (const record of history) {
    const last = rows[rows.length - 1];
    if (record.color === "white" || !last || last.black) {
      rows.push({
        number: record.color === "white" ? rows.length + 1 : rows.length,
        white: record.color === "white" ? record : null,
        black: record.color === "white" ? null : record,
      });
    } else {
      last.black = record;
    }
  }
  return rows;
}

const REASON_TEXT: Record<EndReason, string> = {
  checkmate: "Checkmate.",
  stalemate: "Stalemate — no legal moves.",
  "insufficient-material": "Draw — neither side can force a mate.",
  "threefold-repetition": "Draw by threefold repetition.",
  "fifty-move": "Draw by the fifty-move rule.",
  timeout: "The clock ran out.",
  resign: "You resigned.",
};

/** Result-screen copy, written from the human's seat. */
export function resultCopy(
  outcome: MatchOutcome | null,
  reason: EndReason | null
): { title: string; detail: string; tone: MatchOutcome } {
  const tone = outcome ?? "draw";
  const title = tone === "win" ? "You win" : tone === "loss" ? "You lose" : "Draw";
  return {
    title,
    detail: reason ? REASON_TEXT[reason] : "The game is over.",
    tone,
  };
}

/** Which way the board faces for the human's seat. */
export function boardOrientation(seat: SeatColor): "white" | "black" {
  return seat === "white" ? "white" : "black";
}

/** The piece picker's options, in the order it shows them. */
export const PROMOTION_OPTIONS = ["q", "r", "b", "n"] as const;
export type PromotionPiece = (typeof PROMOTION_OPTIONS)[number];
