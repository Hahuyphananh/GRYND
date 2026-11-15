// src/lib/solitaire-duel/puzzleFeedback.ts
//
// GLITCH'S COACHING, AS PURE DATA.
//
// The puzzle is played on a real board, so the feedback has to answer a real
// question: why was that move right, or why was it not. Nothing here guesses.
// Every sentence is built from facts the engine produced:
//
//   * the move that was played (its own coordinates and card),
//   * the proven winning move,
//   * the card — and column — the winning move turns face up,
//   * how many tableau cards are still hidden.
//
// Browser-safe and server-safe: no React, no DOM, no engine import. That keeps
// the offline puzzle's coaching identical to the online one, and makes the copy
// unit-testable.

import type { Card, SolitaireMove, SolitaireView, Suit } from "./types";
import type { PuzzleReveal } from "./puzzleCore";

const RANK_LABELS = [
  "",
  "A",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "10",
  "J",
  "Q",
  "K",
] as const;

const SUIT_GLYPHS: Record<Suit, string> = {
  spades: "\u2660",
  hearts: "\u2665",
  diamonds: "\u2666",
  clubs: "\u2663",
};

/** `K♠` — the same shorthand the board uses. */
export function puzzleCardText(card: Card): string {
  return `${RANK_LABELS[card.rank] ?? card.rank}${SUIT_GLYPHS[card.suit] ?? ""}`;
}

/** A move in plain words, addressed the way the board is numbered (1-based). */
export function puzzleMoveText(move: SolitaireMove): string {
  switch (move.kind) {
    case "tableau-to-tableau":
      return `${puzzleCardText(move.card)} from column ${move.fromColumn + 1} onto column ${move.toColumn + 1}`;
    case "tableau-to-foundation":
      return `${puzzleCardText(move.card)} from column ${move.fromColumn + 1} to the ${move.suit} foundation`;
    case "waste-to-tableau":
      return `the waste card onto column ${move.toColumn + 1}`;
    case "waste-to-foundation":
      return `the waste card to the ${move.suit} foundation`;
    case "foundation-to-tableau":
      return `a ${move.suit} foundation card back down onto column ${move.toColumn + 1}`;
    default:
      return "draw from the stock";
  }
}

export type PuzzleFeedback = {
  tone: "correct" | "incorrect";
  title: string;
  body: string;
};

function faceDownCount(board: SolitaireView | null | undefined): number {
  let count = 0;
  for (const column of board?.tableau ?? []) {
    for (const slot of column) if (!slot.faceUp) count += 1;
  }
  return count;
}

/**
 * What Glitch says about one played move.
 *
 * `correct` is the server's (or the offline verifier's) verdict, never a guess:
 * calling this with a wrong verdict is impossible to do accidentally, because
 * the verdict and the two moves are passed together.
 */
export function puzzleFeedback({
  correct,
  playedMove,
  answer,
  answerReveal,
  board,
}: {
  correct: boolean;
  playedMove: SolitaireMove;
  answer: SolitaireMove;
  answerReveal: PuzzleReveal | null;
  board: SolitaireView | null;
}): PuzzleFeedback {
  const answerText = puzzleMoveText(answer);

  if (correct) {
    const reveal = answerReveal
      ? `It turns the ${puzzleCardText(answerReveal.card)} face up in column ${answerReveal.column + 1}, and it is the only move on this board that uncovers a card.`
      : "It is the next move of the line that solves this deal.";
    return {
      tone: "correct",
      title: "Correct — that is the move",
      body: `Playing ${answerText} keeps you on the winning line. ${reveal}`,
    };
  }

  const hidden = faceDownCount(board);
  const hiddenText =
    hidden > 0
      ? `${hidden} card${hidden === 1 ? "" : "s"} ${hidden === 1 ? "is" : "are"} still face down`
      : "nothing is uncovered";

  if (playedMove.kind === "draw") {
    return {
      tone: "incorrect",
      title: "Not the move",
      body: `Drawing cycles the stock and leaves the tableau exactly as it is — ${hiddenText}. The winning move is ${answerText}${
        answerReveal
          ? `, which turns the ${puzzleCardText(answerReveal.card)} face up in column ${answerReveal.column + 1}`
          : ""
      }.`,
    };
  }

  return {
    tone: "incorrect",
    title: "Not the move",
    body: `That is legal Klondike, but it uncovers nothing — ${hiddenText}. The winning move is ${answerText}${
      answerReveal
        ? `, which turns the ${puzzleCardText(answerReveal.card)} face up in column ${answerReveal.column + 1}`
        : ""
    }.`,
  };
}
