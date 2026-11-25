// src/lib/solitaire-duel/puzzleProgress.ts
//
// LOCAL strategic-puzzle progress — deliberately small, and separate from every
// existing record.
//
// The daily and unlimited puzzle modes keep their own server-side attempts and
// allowance; this module never reads or writes those. It stores only what the
// strategic player actually uses:
//
//   * whether this browser has completed a puzzle at its CURRENT spec version;
//   * the best completed line (fewest moves, then fewest hints);
//   * how many attempts were started, and when the puzzle was last opened;
//   * the last puzzle and a short recent list, for Continue / Next.
//
// NOTHING competitive is written: no Elo, trophy, coin, quest, player level,
// matchmaking record or server call. Time is only the "last opened" stamp —
// there is no completion timer because the player has no reliable clock across
// tab switches, so the record does not pretend to measure one.
//
// SCOPING follows the shipped lesson/practice stores: guests use a `guest` key
// and a signed-in player uses their Clerk id, so two people on one browser never
// see each other's puzzles. Blocked storage degrades to in-memory progress.
//
// REVISIONS: a record carries the spec version it was earned at. If the library
// later ships a different version for that id, the old completion is NOT
// counted as done — the UI reports "updated" and the next completion replaces
// the best line. Attempts are preserved: the player did play it.
//
// DAILY: one deterministic pick per UTC day for every player, derived from the
// date and a rotation version. No database, no scheduler, no per-user seed.

import type { PuzzleLibraryCategory } from "./puzzleVocabulary";

export type PuzzleRecord = {
  /** The spec version this result belongs to. */
  version: number;
  completed: boolean;
  /** Best completed line, fewest moves then fewest hints. */
  bestMoves: number | null;
  bestHints: number | null;
  /** Attempts started (a restart counts as another attempt). */
  attempts: number;
  /** Last time the puzzle was opened, in epoch milliseconds. */
  lastPlayedAt: number;
};

export type PuzzleProgressState = {
  puzzles: Record<string, PuzzleRecord>;
  lastPuzzleId: string | null;
  /** Most recent puzzle ids, newest first. Capped. */
  recentIds: string[];
  updatedAt: number;
};

export type PuzzleProgressStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

export const PUZZLE_PROGRESS_STORAGE_PREFIX = "grynd:solitaire:puzzle-progress:v1";
export const PUZZLE_PROGRESS_EVENT = "grynd:puzzle-progress";
/** How many recently opened puzzles "Next" avoids. */
const MAX_RECENT = 4;

export function emptyPuzzleProgress(): PuzzleProgressState {
  return { puzzles: {}, lastPuzzleId: null, recentIds: [], updatedAt: 0 };
}

export function puzzleProgressStorageKey(userId?: string | null): string {
  return `${PUZZLE_PROGRESS_STORAGE_PREFIX}:${userId ? encodeURIComponent(userId) : "guest"}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

/**
 * The ids the caller is willing to accept. The hook supplies them from the
 * solution-free player payload, so this module never imports the library data.
 * Omitting the set accepts any well-formed id (used by isolated tests).
 */
function idSet(knownIds?: Iterable<string>): Set<string> | null {
  return knownIds ? new Set(knownIds) : null;
}

/** Accept only ids still in the validated library, and bounded counters. */
export function normalizePuzzleProgress(
  value: unknown,
  knownIds?: Iterable<string>,
): PuzzleProgressState {
  if (!isRecord(value)) return emptyPuzzleProgress();
  const known = idSet(knownIds);

  const puzzles: Record<string, PuzzleRecord> = {};
  if (isRecord(value.puzzles)) {
    for (const [id, raw] of Object.entries(value.puzzles)) {
      if ((known && !known.has(id)) || !isRecord(raw)) continue;
      const version = count(raw.version);
      if (version < 1) continue;
      // A best line is only meaningful when both numbers are present: a hint
      // count without a move count cannot belong to a finished line.
      const rawMoves = raw.bestMoves == null ? null : count(raw.bestMoves);
      const bestMoves = rawMoves !== null && rawMoves > 0 ? rawMoves : null;
      const bestHints =
        bestMoves !== null && raw.bestHints != null ? count(raw.bestHints) : null;
      puzzles[id] = {
        version,
        completed: raw.completed === true,
        bestMoves,
        bestHints,
        attempts: count(raw.attempts),
        lastPlayedAt: count(raw.lastPlayedAt),
      };
    }
  }

  const recentIds = Array.isArray(value.recentIds)
    ? [
        ...new Set(
          value.recentIds.filter(
            (id): id is string => typeof id === "string" && (!known || known.has(id)),
          ),
        ),
      ].slice(
        0,
        MAX_RECENT,
      )
    : [];

  const lastPuzzleId =
    typeof value.lastPuzzleId === "string" &&
    (!known || known.has(value.lastPuzzleId)) &&
    (puzzles[value.lastPuzzleId]?.attempts ?? 0) > 0
      ? value.lastPuzzleId
      : null;

  return {
    puzzles,
    lastPuzzleId,
    recentIds,
    updatedAt: count(value.updatedAt),
  };
}

export function parsePuzzleProgress(
  raw: string | null,
  knownIds?: Iterable<string>,
): PuzzleProgressState {
  if (!raw) return emptyPuzzleProgress();
  try {
    return normalizePuzzleProgress(JSON.parse(raw), knownIds);
  } catch {
    return emptyPuzzleProgress();
  }
}

export function serializePuzzleProgress(progress: PuzzleProgressState): string {
  return JSON.stringify(progress);
}

export function readPuzzleProgress(
  storage: PuzzleProgressStorage | null | undefined,
  userId?: string | null,
  knownIds?: Iterable<string>,
): PuzzleProgressState {
  if (!storage) return emptyPuzzleProgress();
  try {
    return parsePuzzleProgress(storage.getItem(puzzleProgressStorageKey(userId)), knownIds);
  } catch {
    return emptyPuzzleProgress();
  }
}

export function writePuzzleProgress(
  storage: PuzzleProgressStorage | null | undefined,
  userId: string | null | undefined,
  progress: PuzzleProgressState,
): void {
  if (!storage) return;
  try {
    storage.setItem(puzzleProgressStorageKey(userId), serializePuzzleProgress(progress));
  } catch {
    // Private mode / blocked storage: the player still works in memory.
  }
}

// ── Recording ─────────────────────────────────────────────────────────────

function recentAfter(recentIds: readonly string[], id: string): string[] {
  return [id, ...recentIds.filter((entry) => entry !== id)].slice(0, MAX_RECENT);
}

/**
 * A new attempt. It advances the attempt counter and the Continue pointer but
 * never changes completion or the best line: abandoning a puzzle must not erase
 * an earlier result.
 */
export function recordPuzzleStart(
  progress: PuzzleProgressState,
  { id, version, knownIds }: { id: string; version: number; knownIds?: Iterable<string> },
  now = Date.now(),
): PuzzleProgressState {
  const known = idSet(knownIds);
  if (known && !known.has(id)) return progress;
  const existing = progress.puzzles[id];
  const record: PuzzleRecord = existing
    ? { ...existing, attempts: existing.attempts + 1, lastPlayedAt: now }
    : {
        version: Math.max(1, count(version)),
        completed: false,
        bestMoves: null,
        bestHints: null,
        attempts: 1,
        lastPlayedAt: now,
      };

  return {
    ...progress,
    puzzles: { ...progress.puzzles, [id]: record },
    lastPuzzleId: id,
    recentIds: recentAfter(progress.recentIds, id),
    updatedAt: now,
  };
}

/**
 * A completed line at `version`.
 *
 * Fewest moves wins; on a tie, fewer hints wins. A completion earned at an older
 * spec version is discarded (the position changed) while the attempt history is
 * kept. A worse replay never overwrites a better best.
 */
export function recordPuzzleCompletion(
  progress: PuzzleProgressState,
  {
    id,
    version,
    moves,
    hints,
    knownIds,
  }: { id: string; version: number; moves: number; hints: number; knownIds?: Iterable<string> },
  now = Date.now(),
): PuzzleProgressState {
  const known = idSet(knownIds);
  if (known && !known.has(id)) return progress;
  const existing = progress.puzzles[id];
  const sameVersion = Boolean(existing && existing.version === version);
  const priorMoves = sameVersion ? existing?.bestMoves ?? null : null;
  const priorHints = sameVersion ? existing?.bestHints ?? null : null;
  const safeMoves = Math.max(1, count(moves));
  const safeHints = Math.max(0, count(hints));

  const better =
    priorMoves === null ||
    safeMoves < priorMoves ||
    (safeMoves === priorMoves && (priorHints === null || safeHints < priorHints));

  const record: PuzzleRecord = {
    version: Math.max(1, count(version)),
    completed: true,
    bestMoves: better ? safeMoves : priorMoves,
    bestHints: better ? safeHints : priorHints,
    attempts: existing?.attempts ?? 1,
    lastPlayedAt: now,
  };

  return {
    ...progress,
    puzzles: { ...progress.puzzles, [id]: record },
    lastPuzzleId: id,
    recentIds: recentAfter(progress.recentIds, id),
    updatedAt: now,
  };
}

// ── Derived views ─────────────────────────────────────────────────────────

export type PuzzleStatus = "new" | "in-progress" | "completed" | "updated";

/**
 * The status the browser shows.
 *
 * `updated` means a completion exists but belongs to an older spec version: the
 * puzzle changed, so it must be replayed before it counts again.
 */
export function puzzleStatus(
  progress: PuzzleProgressState,
  puzzle: { id: string; spec: { version: number } },
): PuzzleStatus {
  const record = progress.puzzles[puzzle.id];
  if (!record) return "new";
  if (record.completed && record.version !== puzzle.spec.version) return "updated";
  if (record.completed) return "completed";
  return record.attempts > 0 ? "in-progress" : "new";
}

export function puzzleRecord(
  progress: PuzzleProgressState,
  puzzleId: string,
): PuzzleRecord | null {
  return progress.puzzles[puzzleId] ?? null;
}

export type PuzzleFilter = {
  category?: PuzzleLibraryCategory | "all";
  /** Player-facing level number (1..5), or "all". */
  level?: number | "all";
  status?: "all" | "unfinished" | "completed";
};

/**
 * Filter the library without hiding anything silently: "unfinished" includes
 * never-played, in-progress and revised puzzles, because all three still need
 * the player's attention.
 */
export function filterPuzzles<T extends { id: string; category: string; levelNumber: number; spec: { version: number } }>(
  puzzles: readonly T[],
  filter: PuzzleFilter,
  progress: PuzzleProgressState,
): T[] {
  const category = filter.category ?? "all";
  const level = filter.level ?? "all";
  const status = filter.status ?? "all";

  return puzzles.filter((puzzle) => {
    if (category !== "all" && puzzle.category !== category) return false;
    if (level !== "all" && puzzle.levelNumber !== level) return false;
    if (status !== "all") {
      const current = puzzleStatus(progress, puzzle);
      if (status === "completed" && current !== "completed") return false;
      if (status === "unfinished" && current === "completed") return false;
    }
    return true;
  });
}

/**
 * The next challenge, without repeating the last few.
 *
 * Scans forward from the last opened puzzle in library order, preferring an
 * unfinished one that is not in the recent list. If everything nearby is done or
 * recent, it returns the lowest-level unfinished puzzle; if the library is
 * complete, it cycles onward so replay is still one click away.
 */
export function recommendedPuzzle<T extends { id: string; levelNumber: number; spec: { version: number } }>(
  puzzles: readonly T[],
  progress: PuzzleProgressState,
): T | null {
  if (puzzles.length === 0) return null;
  const recent = new Set(progress.recentIds);
  const startIndex = progress.lastPuzzleId
    ? puzzles.findIndex((puzzle) => puzzle.id === progress.lastPuzzleId)
    : -1;

  const ordered = [...puzzles.slice(startIndex + 1), ...puzzles.slice(0, startIndex + 1)];
  const unfinished = ordered.filter((puzzle) => puzzleStatus(progress, puzzle) !== "completed");

  return (
    unfinished.find((puzzle) => !recent.has(puzzle.id)) ??
    unfinished[0] ??
    ordered.find((puzzle) => !recent.has(puzzle.id)) ??
    ordered[0] ??
    null
  );
}

export function completedPuzzleCount(
  puzzles: readonly { id: string; spec: { version: number } }[],
  progress: PuzzleProgressState,
): number {
  return puzzles.filter((puzzle) => puzzleStatus(progress, puzzle) === "completed").length;
}

// ── Daily pick ────────────────────────────────────────────────────────────

/**
 * Bumped only when the rotation itself should change. The date plus this number
 * is the whole seed, so every player on the same build gets the same pick.
 */
export const PUZZLE_DAILY_ROTATION_VERSION = 1;

/** The UTC day key (`YYYY-MM-DD`) the pick belongs to. */
export function puzzleDayKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Index of the day's puzzle.
 *
 * Whole days since the epoch, stepped by a number coprime with the library size
 * so a full cycle visits every puzzle once before repeating. The step changes
 * only for sizes where 7 would divide the collection evenly.
 */
function greatestCommonDivisor(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y > 0) {
    const next = x % y;
    x = y;
    y = next;
  }
  return x || 1;
}

export function dailyPuzzleIndex(dateKey: string, total: number): number {
  const size = Math.max(0, Math.floor(total));
  if (size === 0) return 0;
  const ms = Date.parse(`${dateKey}T00:00:00.000Z`);
  const day = Number.isFinite(ms) ? Math.floor(ms / 86_400_000) : 0;

  // A step coprime with the collection visits every puzzle once per cycle. The
  // loop keeps that true even if a future library size shares a factor with 7.
  let step = 7;
  while (step > 1 && greatestCommonDivisor(step, size) !== 1) step -= 1;

  const offset = day + PUZZLE_DAILY_ROTATION_VERSION;
  return ((offset * step) % size + size) % size;
}

export function dailyPuzzleForDate<T>(puzzles: readonly T[], dateKey: string): T | null {
  if (puzzles.length === 0) return null;
  return puzzles[dailyPuzzleIndex(dateKey, puzzles.length)] ?? null;
}

