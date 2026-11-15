// src/lib/solitaire-duel/puzzleCore.ts
//
// THE BROWSER-SAFE HALF OF THE SOLITAIRE PUZZLE.
//
// A puzzle is a REAL mid-game Klondike position taken from a verified winning
// line: the player sees the position and three moves, and exactly one of them
// turns a face-down card face up and is the next move of the deal's engine-proved
// line.
//
// This module holds everything that needs no server: the puzzle types, the
// deterministic position builder, the answer check, and a local builder for
// offline unlimited practice. It imports only the pure engine (`deck`, `rules`,
// `ai`, `solvable`), so a client component can generate and verify a position
// with no network and no Node `crypto`.
//
// The server-only remainder (`./puzzle.ts`) owns the cache, the UTC-date daily
// seeds and the cryptographic random seed, and re-exports everything here so the
// API routes and tests keep their imports.
//
// DETERMINISM: a puzzle is a pure function of a 32-bit seed. The same seed always
// produces the same position, the same three choices and the same answer.

import { legalMoves } from "./ai";
import { dealFromSeed } from "./deck";
import { applyMove, initialStateFromDeal } from "./rules";
import { solveDealLine } from "./solvable";
import type { Card, SolitaireMove, SolitaireState, Suit } from "./types";

export type PuzzleKind = "daily" | "unlimited";
export type PuzzleChoiceLabel = "A" | "B" | "C";

const CHOICE_LABELS: readonly PuzzleChoiceLabel[] = ["A", "B", "C"];

export type PuzzleCardView = { suit: Suit; rank: number };

export type PuzzlePositionView = {
  /** `null` is a face-down slot — it carries no identity, only a position. */
  columns: (PuzzleCardView | null)[][];
  stockCount: number;
  wasteTop: PuzzleCardView | null;
  foundations: Record<Suit, number>;
  faceDownRemaining: number;
};

export type PuzzleChoiceView = { label: PuzzleChoiceLabel; move: SolitaireMove };

/** Everything the browser may know before it answers. Never the answer. */
export type PublicPuzzle = {
  key: string;
  kind: PuzzleKind;
  dateKey: string | null;
  position: PuzzlePositionView;
  choices: PuzzleChoiceView[];
};

/** The server's puzzle. `answer` must never be serialised before submission. */
export type Puzzle = PublicPuzzle & { seed: number; answer: PuzzleChoiceLabel };

export const DAILY_PUZZLE_PREFIX = "daily:";
export const UNLIMITED_PUZZLE_PREFIX = "unlimited:";

export const MAX_UINT32 = 0xffff_ffff;
/** How many seeds an unlimited key may try before giving up. */
export const CANDIDATE_ATTEMPTS = 6;

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

function sameCard(a: Card | null | undefined, b: Card | null | undefined): boolean {
  return Boolean(a && b && a.rank === b.rank && a.suit === b.suit);
}

/** True when a tableau move carries exactly the top card of its column. */
function isSingleCardMove(state: SolitaireState, move: SolitaireMove): boolean {
  if (move.kind !== "tableau-to-tableau") return false;
  if (!Number.isInteger(move.fromColumn) || !Number.isInteger(move.toColumn)) return false;
  const column = state.tableau[move.fromColumn] ?? [];
  const top = column[column.length - 1];
  return Boolean(top?.faceUp && sameCard(top.card, move.card));
}

function moveSignature(move: SolitaireMove): string {
  switch (move.kind) {
    case "tableau-to-tableau":
      return `t2t:${move.fromColumn}:${move.toColumn}:${move.card.suit}:${move.card.rank}`;
    case "tableau-to-foundation":
      return `t2f:${move.fromColumn}:${move.suit}`;
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

function revealedBy(state: SolitaireState, move: SolitaireMove): number {
  const applied = applyMove({ state, move });
  return applied.ok ? applied.revealed.length : -1;
}

function cardView(card: Card | null | undefined): PuzzleCardView | null {
  return card ? { suit: card.suit, rank: card.rank } : null;
}

function positionView(state: SolitaireState): PuzzlePositionView {
  let faceDownRemaining = 0;
  const columns = state.tableau.map((column) =>
    column.map((pile) => {
      if (!pile.faceUp || !pile.card) {
        faceDownRemaining += 1;
        return null;
      }
      return cardView(pile.card);
    }),
  );
  return {
    columns,
    stockCount: state.stock.length,
    wasteTop: cardView(state.waste[state.waste.length - 1]),
    foundations: {
      spades: state.foundations.spades.length,
      hearts: state.foundations.hearts.length,
      diamonds: state.foundations.diamonds.length,
      clubs: state.foundations.clubs.length,
    },
    faceDownRemaining,
  };
}

/**
 * Build the puzzle for one seed, or null when this deal has no position that
 * satisfies the puzzle's contract.
 *
 * The contract, all checked through the engine rather than assumed:
 *   1. the deal has a verified winning line (`solveDealLine`),
 *   2. the position is reached by replaying a prefix of that line,
 *   3. the answer is the next move of the line, a single-card tableau move that
 *      turns exactly one card face up,
 *   4. both decoys are legal moves that turn NO card face up.
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
    const answerMove = line[index];
    if (!isSingleCardMove(states[index], answerMove)) continue;
    if (revealedBy(states[index], answerMove) !== 1) continue;

    const decoys: SolitaireMove[] = [];
    const seen = new Set<string>([moveSignature(answerMove)]);
    for (const candidate of legalMoves(states[index])) {
      if (decoys.length === 2) break;
      if (seen.has(moveSignature(candidate))) continue;
      if (revealedBy(states[index], candidate) !== 0) continue;
      seen.add(moveSignature(candidate));
      decoys.push(candidate);
    }
    if (decoys.length < 2) continue;

    // Deterministic A/B/C order: the same seed always puts the answer in the
    // same slot, so a rebuild for verification matches what the player saw.
    const ordered = [answerMove, decoys[0], decoys[1]];
    const shift = seed % 3;
    const rotated = ordered.map((_, slot) => ordered[(slot + shift) % 3]);
    const answerIndex = rotated.findIndex(
      (move) => moveSignature(move) === moveSignature(answerMove),
    );

    return {
      key: "",
      kind: "unlimited",
      dateKey: null,
      seed,
      position: positionView(states[index]),
      choices: rotated.map((move, slot) => ({ label: CHOICE_LABELS[slot], move })),
      answer: CHOICE_LABELS[answerIndex],
    };
  }

  return null;
}

/** Strip the answer so a route can serialise a puzzle safely. */
export function publicPuzzle(puzzle: Puzzle): PublicPuzzle {
  const { key, kind, dateKey, position, choices } = puzzle;
  return { key, kind, dateKey, position, choices };
}

/** True when `label` is the puzzle's verified answer. */
export function verifyPuzzleChoice(puzzle: Pick<Puzzle, "answer">, label: unknown): boolean {
  return label === puzzle.answer;
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
