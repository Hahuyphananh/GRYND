// src/lib/solitaire-duel/puzzle.ts
//
// THE DAILY / UNLIMITED SOLITAIRE PUZZLE — server-only.
//
// A puzzle is a REAL mid-game Klondike position taken from a verified winning
// line: the player is shown the whole board and plays the move themselves, and
// the engine-proved next move of the line must be the position's unique best
// legal move. It may reveal a card, build a run, reach the foundation or draw —
// the puzzle asks for the best move, not always a flip. The answer never leaves
// this module until the player has moved.
//
// The DAILY puzzle is a three-step run over one deal. Each step has its own
// `daily:YYYY-MM-DD:N` key (step 1 keeps the legacy `daily:YYYY-MM-DD` key), so
// the attempt table's one-row-per-key rule gives each step one official answer.
//
// The pure builder and the answer check now live in `./puzzleCore.ts`, which has
// no Node imports so the browser can build and check an offline practice
// position. This file keeps only what needs a server: the in-process cache, the
// UTC-date daily seeds, and the cryptographic random seed for an unlimited
// puzzle. It re-exports the core, so every existing import path still works.
//
// SERVER-ONLY: imports `./seeds.js` (Node crypto), so never import this from a
// client component. The client receives `PublicPuzzle` from the route, or builds
// an offline position with `./puzzleCore.ts`.

import crypto from "crypto";

import { VARIANT_VERSION } from "./constants";
import { deriveDealSeed } from "./seeds.js";
import {
  CANDIDATE_ATTEMPTS,
  MAX_UINT32,
  UNLIMITED_PUZZLE_PREFIX,
  buildPuzzleForSeed,
  buildPuzzleStepsForSeed,
  dailyPuzzleDateKey,
  dailyPuzzleKey,
  puzzleCandidatesForSeed,
  puzzleSeedFromKey,
  type Puzzle,
  type PuzzleKind,
} from "./puzzleCore";

// Explicit re-exports (not `export *`): the routes and tests import these by
// name through tsx's CJS interop, which does not resolve a star re-export.
export {
  DAILY_PUZZLE_PREFIX,
  MAX_UINT32,
  UNLIMITED_PUZZLE_PREFIX,
  buildOfflinePuzzle,
  buildPuzzleForSeed,
  buildPuzzleStepsForSeed,
  dailyPuzzleDateKey,
  dailyPuzzleKey,
  moveSignature,
  parsePuzzleMove,
  publicPuzzle,
  puzzleCandidatesForSeed,
  puzzleSeedFromKey,
  randomPuzzleSeed,
  verifyPuzzleMove,
  type PublicPuzzle,
  type Puzzle,
  type PuzzleKind,
  type PuzzleReveal,
} from "./puzzleCore";

const MAX_CACHED_PUZZLES = 64;

/** How many best-move steps one daily run contains. */
export const DAILY_PUZZLE_STEPS = 3;

const cache = new Map<string, Puzzle>();
const dailyCache = new Map<string, Puzzle[]>();

function remember(puzzle: Puzzle): Puzzle {
  cache.set(puzzle.key, puzzle);
  if (cache.size > MAX_CACHED_PUZZLES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return puzzle;
}

function rememberDaily(dateKey: string, steps: Puzzle[]): Puzzle[] {
  dailyCache.set(dateKey, steps);
  if (dailyCache.size > MAX_CACHED_PUZZLES) {
    const oldest = dailyCache.keys().next().value;
    if (oldest !== undefined) dailyCache.delete(oldest);
  }
  return steps;
}

/** The key for one step of a daily run. Step 1 keeps the legacy key. */
export function dailyPuzzleStepKey(dateKey: string, step: number): string {
  return step <= 1 ? dailyPuzzleKey(dateKey) : `${dailyPuzzleKey(dateKey)}:${step}`;
}

/** The step number encoded in a daily key, or null when it is not this date. */
export function dailyPuzzleStepFromKey(
  key: string,
  dateKey: string,
): number | null {
  if (key === dailyPuzzleKey(dateKey)) return 1;
  const prefix = `${dailyPuzzleKey(dateKey)}:`;
  if (!key.startsWith(prefix)) return null;
  const raw = key.slice(prefix.length);
  if (!/^[1-9]\d?$/.test(raw)) return null;
  const step = Number(raw);
  return step >= 1 && step <= DAILY_PUZZLE_STEPS ? step : null;
}

/** The candidate seed for one attempt at a day's puzzle. */
export function dailyPuzzleCandidateSeed(dateKey: string, attempt: number): number {
  return deriveDealSeed({
    serverSeed: `grynd-daily-puzzle:${dateKey}:${attempt}`,
    variantVersion: VARIANT_VERSION,
  });
}

/**
 * The three-step puzzle for a UTC date, identical for every player.
 *
 * Candidate seeds are derived from the date, so a retry on a deal that has no
 * usable position cannot make the puzzle different for the next player: the
 * same date walks the same candidates in the same order.
 */
export function getDailyPuzzleSteps(dateKey: string): Puzzle[] {
  const cached = dailyCache.get(dateKey);
  if (cached) return cached;

  for (let attempt = 0; attempt < CANDIDATE_ATTEMPTS; attempt += 1) {
    const seed = dailyPuzzleCandidateSeed(dateKey, attempt);
    const steps = buildPuzzleStepsForSeed(seed, DAILY_PUZZLE_STEPS);
    if (!steps) continue;
    return rememberDaily(
      dateKey,
      steps.map((step, index) => ({
        ...step,
        key: dailyPuzzleStepKey(dateKey, index + 1),
        kind: "daily",
        dateKey,
      })),
    );
  }

  throw new Error(`No verified puzzle could be built for ${dateKey}`);
}

/** The first step of a day's run, kept for callers that only need one board. */
export function getDailyPuzzle(dateKey: string): Puzzle {
  const first = getDailyPuzzleSteps(dateKey)[0];
  if (!first) throw new Error(`No verified puzzle could be built for ${dateKey}`);
  return first;
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
    const step = dailyPuzzleStepFromKey(key, dateKey);
    if (step === null) return null;
    try {
      return getDailyPuzzleSteps(dateKey)[step - 1] ?? null;
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
