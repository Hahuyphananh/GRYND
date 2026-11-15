// src/lib/solitaire-duel/puzzleCore.ts
//
// THE BROWSER-SAFE HALF OF THE SOLITAIRE PUZZLE.
//
// A puzzle is a REAL mid-game Klondike position taken from a verified winning
// line. The player is shown the whole board — stock, waste, foundations and the
// seven columns — and plays the move themselves, exactly as in a game: drag a
// card (or a run) onto a pile, click a card then a target, or click the stock to
// turn the next waste card over.
//
// Exactly ONE legal move in the position turns a face-down card face up, and
// that move is the next move of the deal's engine-proved winning line. Every
// other legal move — including drawing — leaves every hidden card hidden, which
// is what makes the puzzle have a single defensible answer rather than an
// opinion: the answer is not "our favourite move", it is the only move that
// makes progress, and it is the one the solver's line plays.
//
// This module holds everything that needs no server: the puzzle types, the
// deterministic position builder, the move check, and a local builder for
// offline unlimited practice. It imports only the pure engine (`deck`, `rules`,
// `ai`, `solvable`), so a client component can generate and verify a position
// with no network and no Node `crypto`.
//
// The server-only remainder (`./puzzle.ts`) owns the cache, the UTC-date daily
// seeds and the cryptographic random seed, and re-exports everything here so the
// API routes and tests keep their imports.
//
// DETERMINISM: a puzzle is a pure function of a 32-bit seed. The same seed always
// produces the same position, the same answer move and the same revealed card.

import { legalMoves } from "./ai";
import { dealFromSeed } from "./deck";
import { applyMove, initialStateFromDeal, viewForState } from "./rules";
import { solveDealLine } from "./solvable";
import type { Card, SolitaireMove, SolitaireState, SolitaireView, Suit } from "./types";

export type PuzzleKind = "daily" | "unlimited";

/** The card — and the column it sits in — the winning move turns over. */
export type PuzzleReveal = { column: number; card: Card };

/**
 * Everything the browser may know before it plays. Never the answer, never the
 * server's state (face-down identities and the stock order stay on the server).
 */
export type PublicPuzzle = {
  key: string;
  kind: PuzzleKind;
  dateKey: string | null;
  /** A playable board: exactly what a duel seat would be shown. */
  board: SolitaireView;
};

/**
 * The server's puzzle. `state`, `answer`, `answerBoard` and `answerReveal` must
 * never be serialised before the player has moved (see `publicPuzzle`).
 */
export type Puzzle = PublicPuzzle & {
  seed: number;
  /** The authoritative position — needed to validate the move the player sends. */
  state: SolitaireState;
  /** The next move of the proven winning line: the only move that reveals a card. */
  answer: SolitaireMove;
  /** The board after that move, so a solution can be shown once it is judged. */
  answerBoard: SolitaireView;
  answerReveal: PuzzleReveal;
};

export const DAILY_PUZZLE_PREFIX = "daily:";
export const UNLIMITED_PUZZLE_PREFIX = "unlimited:";

export const MAX_UINT32 = 0xffff_ffff;
/** How many seeds an unlimited key may try before giving up. */
export const CANDIDATE_ATTEMPTS = 6;

const SUITS: readonly Suit[] = ["spades", "hearts", "diamonds", "clubs"];
const TABLEAU_COLUMNS = 7;

/** The UTC calendar day a daily puzzle belongs to (`YYYY-MM-DD`). */
export function dailyPuzzleDateKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function dailyPuzzleKey(dateKey: string): string {
  return `${DAILY_PUZZLE_PREFIX}${dateKey}`;
}

/** The seed encoded in an unlimited puzzle key, or null when malformed. */
export function puzzleSeedFromKey(key: string): number | null {
  if (typeof key !== "string" || !key.startsWith(UNLIMITED_PUZZLE_PREFIX)) return null;
  const raw = key.slice(UNLIMITED_PUZZLE_PREFIX.length);
  if (!/^\d{1,10}$/.test(raw)) return null;
  const seed = Number(raw);
  return Number.isInteger(seed) && seed >= 0 && seed <= MAX_UINT32 ? seed : null;
}

// ── Moves ─────────────────────────────────────────────────────────────────

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function isColumn(value: unknown): value is number {
  return isInteger(value) && value >= 0 && value < TABLEAU_COLUMNS;
}

function isSuit(value: unknown): value is Suit {
  return typeof value === "string" && (SUITS as readonly string[]).includes(value);
}

function isCard(value: unknown): value is Card {
  if (!value || typeof value !== "object") return false;
  const card = value as { suit?: unknown; rank?: unknown };
  return isSuit(card.suit) && isInteger(card.rank) && card.rank >= 1 && card.rank <= 13;
}

/**
 * A move this module will accept from a client, or null.
 *
 * Every field is checked here, so a malformed body can never reach
 * `applyMove` (which would throw on an undefined card) and a made-up move kind
 * is refused before anything is judged.
 */
export function parsePuzzleMove(value: unknown): SolitaireMove | null {
  if (!value || typeof value !== "object") return null;
  const move = value as Record<string, unknown>;
  switch (move.kind) {
    case "draw":
      return { kind: "draw" };
    case "waste-to-foundation":
      return isSuit(move.suit) ? { kind: "waste-to-foundation", suit: move.suit } : null;
    case "waste-to-tableau":
      return isColumn(move.toColumn)
        ? { kind: "waste-to-tableau", toColumn: move.toColumn }
        : null;
    case "tableau-to-foundation":
      return isColumn(move.fromColumn) && isCard(move.card) && isSuit(move.suit)
        ? {
            kind: "tableau-to-foundation",
            fromColumn: move.fromColumn,
            card: move.card,
            suit: move.suit,
          }
        : null;
    case "tableau-to-tableau":
      return isColumn(move.fromColumn) && isCard(move.card) && isColumn(move.toColumn)
        ? {
            kind: "tableau-to-tableau",
            fromColumn: move.fromColumn,
            card: move.card,
            toColumn: move.toColumn,
          }
        : null;
    case "foundation-to-tableau":
      return isSuit(move.suit) && isColumn(move.toColumn)
        ? { kind: "foundation-to-tableau", suit: move.suit, toColumn: move.toColumn }
        : null;
    default:
      return null;
  }
}

/** A stable identity for a move — what the answer check and the DB row store. */
export function moveSignature(move: SolitaireMove): string {
  switch (move.kind) {
    case "tableau-to-tableau":
      return `t2t:${move.fromColumn}:${move.toColumn}:${move.card.suit}:${move.card.rank}`;
    case "tableau-to-foundation":
      return `t2f:${move.fromColumn}:${move.card.suit}:${move.card.rank}:${move.suit}`;
    case "waste-to-tableau":
      return `w2t:${move.toColumn}`;
    case "waste-to-foundation":
      return `w2f:${move.suit}`;
    case "foundation-to-tableau":
      return `f2t:${move.suit}:${move.toColumn}`;
    default:
      return "draw";
  }
}

function sameCard(a: Card | null | undefined, b: Card | null | undefined): boolean {
  return Boolean(a && b && a.rank === b.rank && a.suit === b.suit);
}

/**
 * The column whose bottom card this move turned face up.
 *
 * Read from the two boards rather than assumed: `applyMove` flips the newly
 * exposed bottom of the source column, so the column is whichever one went from
 * a face-down bottom to a face-up bottom carrying `card`.
 */
function revealedColumn(
  before: SolitaireState,
  after: SolitaireState,
  card: Card,
): number | null {
  for (let column = 0; column < after.tableau.length; column += 1) {
    const wasHidden = !before.tableau[column]?.[0]?.faceUp;
    const now = after.tableau[column]?.[0];
    if (wasHidden && now?.faceUp && sameCard(now.card, card)) return column;
  }
  return null;
}

type RevealingMove = { move: SolitaireMove; revealed: Card[] };

/**
 * Every legal move from `state` that turns EXACTLY one face-down card over.
 *
 * The whole puzzle rests on this list having one entry. `legalMoves` is the
 * engine's own enumerator (the same one the bot uses), and each candidate is
 * re-applied through `applyMove` before it is believed, so a move here is a
 * move the engine accepts.
 */
function revealingMoves(state: SolitaireState): RevealingMove[] {
  const found: RevealingMove[] = [];
  const seen = new Set<string>();
  for (const move of legalMoves(state)) {
    const signature = moveSignature(move);
    if (seen.has(signature)) continue;
    seen.add(signature);
    const applied = applyMove({ state, move });
    if (applied.ok && applied.revealed.length === 1) {
      found.push({ move, revealed: applied.revealed });
    }
  }
  return found;
}

/**
 * Build the puzzle for one seed, or null when this deal has no position that
 * satisfies the puzzle's contract.
 *
 * The contract, all checked through the engine rather than assumed:
 *   1. the deal has a verified winning line (`solveDealLine`),
 *   2. the position is reached by replaying a prefix of that line,
 *   3. the line's next move turns exactly one card face up,
 *   4. NO other legal move turns a card face up — so the answer is the only
 *      progress-making move on the board, not merely our preferred one.
 */
export function buildPuzzleForSeed(seed: number): Puzzle | null {
  if (!Number.isInteger(seed) || seed < 0 || seed > MAX_UINT32) return null;

  const deal = dealFromSeed(seed);
  const line = solveDealLine(deal);
  if (!line || line.length < 8) return null;

  let state = initialStateFromDeal(deal);
  const states: SolitaireState[] = [state];
  for (const move of line) {
    const applied = applyMove({ state, move });
    if (!applied.ok) return null;
    state = applied.state;
    states.push(state);
  }

  for (let index = 1; index < line.length - 1; index += 1) {
    const before = states[index];
    const answer = line[index];
    const applied = applyMove({ state: before, move: answer });
    if (!applied.ok || applied.revealed.length !== 1) continue;

    // The answer must be the ONLY move that uncovers anything. If another
    // legal move also turns a card over, either one is defensible and there is
    // no puzzle to solve — skip this position entirely.
    const revealing = revealingMoves(before);
    if (revealing.length !== 1) continue;
    if (moveSignature(revealing[0].move) !== moveSignature(answer)) continue;

    const column = revealedColumn(before, applied.state, applied.revealed[0]);
    if (column === null) continue;

    return {
      key: "",
      kind: "unlimited",
      dateKey: null,
      seed,
      board: viewForState(before),
      state: before,
      answer,
      answerBoard: viewForState(applied.state),
      answerReveal: { column, card: applied.revealed[0] },
    };
  }

  return null;
}

/** Strip the answer and the server's state so a route can serialise a puzzle. */
export function publicPuzzle(puzzle: Puzzle): PublicPuzzle {
  const { key, kind, dateKey, board } = puzzle;
  return { key, kind, dateKey, board };
}

/** True when `move` is the puzzle's verified answer. */
export function verifyPuzzleMove(puzzle: Pick<Puzzle, "answer">, move: unknown): boolean {
  const parsed = parsePuzzleMove(move);
  if (!parsed) return false;
  return moveSignature(parsed) === moveSignature(puzzle.answer);
}

/**
 * A fresh UNLIMITED puzzle built entirely in the browser.
 *
 * Offline practice has no server to pick a seed or cache the result, so this
 * walks candidate seeds derived from one caller-supplied seed until the engine
 * proves a position. The key is deliberately NOT a server-parseable
 * `unlimited:<seed>` key: an offline puzzle must never be submittable, because
 * nothing about an offline attempt is recorded.
 */
export function buildOfflinePuzzle(seed: number): Puzzle {
  const base = Number.isInteger(seed) ? seed >>> 0 : 0;
  for (let attempt = 0; attempt < CANDIDATE_ATTEMPTS; attempt += 1) {
    const candidate = attempt === 0 ? base : (base + attempt * 0x9e37_79b1) >>> 0;
    const puzzle = buildPuzzleForSeed(candidate);
    if (!puzzle) continue;
    return {
      ...puzzle,
      key: `${UNLIMITED_PUZZLE_PREFIX}offline:${candidate}`,
      kind: "unlimited",
      dateKey: null,
    };
  }
  throw new Error("No verified puzzle could be built on this device");
}

/**
 * An unpredictable seed for an offline puzzle.
 *
 * There is no opponent and no committed deal, so the only requirement is that a
 * refresh or replay cannot predict the next position. `crypto.getRandomValues`
 * is available in every browser this app supports; the fallback keeps a
 * degraded browser playable rather than throwing.
 */
export function randomPuzzleSeed(): number {
  const source = globalThis.crypto;
  if (source && typeof source.getRandomValues === "function") {
    return source.getRandomValues(new Uint32Array(1))[0] >>> 0;
  }
  return Math.floor(Math.random() * 0x1_0000_0000) >>> 0;
}
