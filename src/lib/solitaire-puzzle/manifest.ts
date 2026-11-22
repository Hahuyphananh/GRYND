// src/lib/solitaire-puzzle/manifest.ts
//
// SERVER-ONLY puzzle-set selection. The manifest contains the hidden start
// states, so this module must never be imported by a client component. It
// deliberately copies only the session-relevant fields from a library puzzle:
// no accepted solution paths, no verification metadata and no authoring data.
//
// Both seats share the exact returned array. Puzzle Ranked receives one puzzle
// from each difficulty band; AI practice uses the same selector.

import {
  puzzleLibraryPuzzles,
  type LibraryPuzzle,
} from "../solitaire-duel/puzzleLibrary";
import type { PuzzleManifestEntry } from "./types";

const BANDS = [1, 2, 3, 4, 5] as const;

/** Deterministic FNV-1a hash; no randomness, no server runtime. */
function hashSeed(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function sessionSpecFor(puzzle: LibraryPuzzle) {
  return {
    id: puzzle.spec.id,
    version: puzzle.spec.version,
    objective: puzzle.spec.objective,
    startState: puzzle.spec.startState,
    ...(puzzle.spec.constraints
      ? {
          constraints: {
            ...(puzzle.spec.constraints.maxMoves !== undefined
              ? { maxMoves: puzzle.spec.constraints.maxMoves }
              : {}),
            ...(puzzle.spec.constraints.maxStockPasses !== undefined
              ? { maxStockPasses: puzzle.spec.constraints.maxStockPasses }
              : {}),
          },
        }
      : {}),
  };
}

function entryFor(puzzle: LibraryPuzzle, slot: number): PuzzleManifestEntry {
  return {
    slot,
    id: puzzle.id,
    level: puzzle.level,
    category: puzzle.category,
    objectiveText: puzzle.spec.objectiveText,
    concept: puzzle.spec.concept,
    spec: sessionSpecFor(puzzle),
  };
}

export type PuzzleManifestOptions = {
  /** Library ids the players raced recently; avoided when the band allows it. */
  avoidIds?: ReadonlySet<string>;
  /** Most recent start per id, used only to order the fallback repeat. */
  lastSeenAt?: ReadonlyMap<string, number>;
};

/**
 * Select one puzzle per band from a seed.
 *
 * The seed is server-generated at session creation and stored server-side. The
 * same seed always produces the same five entries, which is what lets both seats
 * and a recovery read reconstruct the identical set.
 *
 * `avoidIds` is per-player repeat prevention applied to BOTH seats at once:
 * where a band still has unseen positions, one of them is chosen; where the
 * whole band was seen inside the window, the LEAST recently seen position is
 * chosen instead of failing to seat the match. The fallback is deterministic
 * and still one per band, so the format never changes shape.
 */
export function buildPuzzleManifest(
  seed: string,
  puzzles: readonly LibraryPuzzle[] = puzzleLibraryPuzzles(),
  { avoidIds, lastSeenAt }: PuzzleManifestOptions = {},
): PuzzleManifestEntry[] {
  const manifest: PuzzleManifestEntry[] = [];
  const used = new Set<string>();
  const avoid = avoidIds ?? new Set<string>();

  for (const band of BANDS) {
    const candidates = puzzles.filter(
      (puzzle) => puzzle.levelNumber === band && !used.has(puzzle.id),
    );
    if (candidates.length === 0) {
      throw new Error(`No puzzle is available for difficulty band ${band}`);
    }

    const unseen = candidates.filter((puzzle) => !avoid.has(puzzle.id));
    let chosen: LibraryPuzzle;
    if (unseen.length > 0) {
      chosen = unseen[hashSeed(`${seed}:${band}`) % unseen.length];
    } else {
      // Every position in this band was seen inside the window. Repeat the one
      // seen longest ago (never seen sorts first, then id for determinism).
      chosen = [...candidates].sort((a, b) => {
        const byAge =
          (lastSeenAt?.get(a.id) ?? 0) - (lastSeenAt?.get(b.id) ?? 0);
        return byAge !== 0 ? byAge : a.id.localeCompare(b.id);
      })[0];
    }

    used.add(chosen.id);
    manifest.push(entryFor(chosen, manifest.length));
  }

  return manifest;
}

/**
 * Grow an endless battle's frozen stream to at least `minLength` entries.
 *
 * Each block is another seeded five-band set, re-slotted at its absolute index,
 * so a seat can keep advancing without the match silently ending. Selection is
 * deterministic from the session's stored seed and block number; the recent
 * block is avoided where the bands allow it.
 */
export function extendPuzzleManifest(
  manifest: readonly PuzzleManifestEntry[],
  seed: string,
  minLength: number,
  puzzles: readonly LibraryPuzzle[] = puzzleLibraryPuzzles(),
): PuzzleManifestEntry[] {
  const out = [...manifest];
  let block = 0;
  while (out.length < minLength) {
    const avoid = new Set(out.slice(-15).map((entry) => entry.id));
    const next = buildPuzzleManifest(`${seed}:stream:${block}`, puzzles, {
      avoidIds: avoid,
    });
    if (next.length === 0) break;
    for (const entry of next) {
      out.push({ ...entry, slot: out.length });
    }
    block += 1;
  }
  return out;
}

/**
 * Select a PRACTICE set: `count` distinct puzzles, one difficulty band.
 *
 * Practice is not competitive, so a player may pick a level (the brief's
 * "select a puzzle or difficulty"); the set itself is still chosen server-side
 * from a server-generated seed, so a client cannot hand us a manifest. With no
 * level the pool is the whole library.
 */
export function buildPracticeManifest({
  seed,
  level = null,
  count = 1,
  puzzles = puzzleLibraryPuzzles(),
}: {
  seed: string;
  level?: number | null;
  count?: number;
  puzzles?: readonly LibraryPuzzle[];
}): PuzzleManifestEntry[] {
  const wanted = Math.max(1, Math.min(5, Math.floor(Number(count) || 1)));
  const pool =
    level === null || level === undefined
      ? [...puzzles]
      : puzzles.filter((puzzle) => puzzle.levelNumber === level);
  if (pool.length === 0) {
    throw new Error(`No puzzle is available for difficulty level ${level}`);
  }

  // Deterministic seeded shuffle (FNV key per puzzle + id tie-break), so the
  // same seed always yields the same practice set.
  const ordered = [...pool].sort((a, b) => {
    const bySeed = hashSeed(`${seed}:${a.id}`) - hashSeed(`${seed}:${b.id}`);
    return bySeed !== 0 ? bySeed : a.id.localeCompare(b.id);
  });

  return ordered.slice(0, Math.min(wanted, ordered.length)).map((puzzle, slot) => entryFor(puzzle, slot));
}

/**
 * Internal/test helper: freeze an explicit ordered list of library puzzle IDs.
 * This is not exposed by an HTTP route. A future matchmaker must use the seeded
 * selector above so a client can never choose its own competitive set.
 */
export function manifestFromIds(
  ids: readonly string[],
  puzzles: readonly LibraryPuzzle[] = puzzleLibraryPuzzles(),
): PuzzleManifestEntry[] {
  if (ids.length === 0) throw new Error("A puzzle manifest cannot be empty");
  const seen = new Set<string>();
  const manifest: PuzzleManifestEntry[] = [];

  for (const id of ids) {
    if (seen.has(id)) throw new Error(`Duplicate puzzle id in manifest: ${id}`);
    const puzzle = puzzles.find((candidate) => candidate.id === id);
    if (!puzzle) throw new Error(`Unknown puzzle id: ${id}`);
    seen.add(id);
    manifest.push(entryFor(puzzle, manifest.length));
  }

  return manifest;
}
