// src/lib/solitaire-duel/puzzle.ts
//
// THE DAILY / UNLIMITED SOLITAIRE PUZZLE — server-only.
//
// A puzzle is a REAL mid-game Klondike position taken from a verified winning
// line: the player is shown the position and three moves, and exactly one of
// them turns a face-down card face up and is the next move of the deal's
// engine-proved winning line. The answer never leaves this module until the
// player has submitted once.
//
// DETERMINISM: a puzzle is a pure function of a 32-bit seed. The daily puzzle
// derives its candidate seeds from the UTC date, so every player gets the same
// position for the same day and a refresh cannot reroll it. An unlimited
// puzzle derives its seed from the server's random source and carries it in the
// key, so the submit route can rebuild the exact same position.
//
// VERIFICATION: `solveDealLine` proves the deal is winnable and the line is
// replayed through the authoritative engine (`applyMove`) before any position
// from it is trusted. Decoy moves are checked with the same engine and are
// required to reveal nothing, so "exactly one move turns a card" is a fact, not
// copy.
//
// SERVER-ONLY: imports `./seeds.js` (Node crypto), so never import this from a
// client component. The client receives `PublicPuzzle` from the route.

import crypto from "crypto";

import { legalMoves } from "./ai";
import { VARIANT_VERSION } from "./constants";
import { dealFromSeed } from "./deck";
import { applyMove, initialStateFromDeal } from "./rules";
import { deriveDealSeed } from "./seeds.js";
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

const MAX_CACHED_PUZZLES = 64;
const CANDIDATE_ATTEMPTS = 6;
const MAX_UINT32 = 0xffff_ffff;

const cache = new Map<string, Puzzle>();

function remember(puzzle: Puzzle): Puzzle {
  cache.set(puzzle.key, puzzle);
  if (cache.size > MAX_CACHED_PUZZLES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return puzzle;
}

/** The UTC calendar day a daily puzzle belongs to (`YYYY-MM-DD`). */
export function dailyPuzzleDateKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function dailyPuzzleKey(dateKey: string): string {
  return `${DAILY_PUZZLE_PREFIX}${dateKey}`;
}

/** The candidate seed for one attempt at a day's puzzle. */
export function dailyPuzzleCandidateSeed(dateKey: string, attempt: number): number {
  return deriveDealSeed({
    serverSeed: `grynd-daily-puzzle:${dateKey}:${attempt}`,
    variantVersion: VARIANT_VERSION,
  });
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

/**
 * The one puzzle for a UTC date, identical for every player.
 *
 * Candidate seeds are derived from the date, so a retry on a deal that has no
 * usable position cannot make the puzzle different for the next player: the
 * same date walks the same candidates in the same order.
 */
export function getDailyPuzzle(dateKey: string): Puzzle {
  const key = dailyPuzzleKey(dateKey);
  const cached = cache.get(key);
  if (cached) return cached;

  for (let attempt = 0; attempt < CANDIDATE_ATTEMPTS; attempt += 1) {
    const seed = dailyPuzzleCandidateSeed(dateKey, attempt);
    const puzzle = buildPuzzleForSeed(seed);
    if (!puzzle) continue;
    return remember({ ...puzzle, key, kind: "daily", dateKey });
  }

  throw new Error(`No verified puzzle could be built for ${dateKey}`);
}

/**
 * A practice puzzle. With a seed the result is reproducible (the submit route
 * uses this to re-derive the exact position the player answered); without one
 * the server picks a fresh seed.
 */
export function getUnlimitedPuzzle(requestedSeed?: number): Puzzle {
  const validSeed =
    Number.isInteger(requestedSeed) &&
    (requestedSeed as number) >= 0 &&
    (requestedSeed as number) <= MAX_UINT32
      ? (requestedSeed as number)
      : null;
  const seedValue = validSeed ?? crypto.randomBytes(4).readUInt32BE(0);
  const key = `${UNLIMITED_PUZZLE_PREFIX}${seedValue}`;

  const cached = cache.get(key);
  if (cached) return cached;

  for (let attempt = 0; attempt < CANDIDATE_ATTEMPTS; attempt += 1) {
    const seed =
      attempt === 0
        ? seedValue
        : deriveDealSeed({
            serverSeed: `grynd-unlimited-puzzle:${seedValue}:${attempt}`,
            variantVersion: VARIANT_VERSION,
          });
    const puzzle = buildPuzzleForSeed(seed);
    if (!puzzle) continue;
    return remember({ ...puzzle, key, kind: "unlimited", dateKey: null });
  }

  throw new Error(`No verified puzzle could be built for seed ${seedValue}`);
}

/** Strip the answer so a route can serialise a puzzle safely. */
export function publicPuzzle(puzzle: Puzzle): PublicPuzzle {
  const { key, kind, dateKey, position, choices } = puzzle;
  return { key, kind, dateKey, position, choices };
}

/**
 * Rebuild the puzzle a submission names. A daily key is accepted ONLY for the
 * server's own current date, so an old or future puzzle cannot be replayed; an
 * unlimited key must encode a seed this module can rebuild.
 */
export function puzzleForKey({
  key,
  kind,
  dateKey = dailyPuzzleDateKey(),
}: {
  key: string;
  kind: PuzzleKind;
  dateKey?: string;
}): Puzzle | null {
  if (kind === "daily") {
    if (key !== dailyPuzzleKey(dateKey)) return null;
    try {
      return getDailyPuzzle(dateKey);
    } catch {
      return null;
    }
  }

  const seed = puzzleSeedFromKey(key);
  if (seed === null) return null;
  try {
    return getUnlimitedPuzzle(seed);
  } catch {
    return null;
  }
}

/** True when `label` is the puzzle's verified answer. */
export function verifyPuzzleChoice(puzzle: Puzzle, label: unknown): boolean {
  return label === puzzle.answer;
}
