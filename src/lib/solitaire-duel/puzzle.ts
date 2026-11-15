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
  dailyPuzzleDateKey,
  dailyPuzzleKey,
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
  dailyPuzzleDateKey,
  dailyPuzzleKey,
  publicPuzzle,
  puzzleSeedFromKey,
  randomPuzzleSeed,
  verifyPuzzleChoice,
  type Puzzle,
  type PuzzleCardView,
  type PuzzleChoiceLabel,
  type PuzzleChoiceView,
  type PuzzleKind,
  type PuzzlePositionView,
  type PublicPuzzle,
} from "./puzzleCore";

const MAX_CACHED_PUZZLES = 64;

const cache = new Map<string, Puzzle>();

function remember(puzzle: Puzzle): Puzzle {
  cache.set(puzzle.key, puzzle);
  if (cache.size > MAX_CACHED_PUZZLES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return puzzle;
}

/** The candidate seed for one attempt at a day's puzzle. */
export function dailyPuzzleCandidateSeed(dateKey: string, attempt: number): number {
  return deriveDealSeed({
    serverSeed: `grynd-daily-puzzle:${dateKey}:${attempt}`,
    variantVersion: VARIANT_VERSION,
  });
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
