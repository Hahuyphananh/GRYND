// src/lib/solitaire-puzzle/repetition.ts
//
// PER-PLAYER REPEAT PREVENTION for Puzzle Ranked.
//
// A ranked player should not be served the same library puzzle twice in a row
// within a window. Fairness comes first, though: both seats must race ONE
// identical set, so this cannot filter puzzles per seat. Instead the window is
// applied to BOTH players when the set is selected, and a set is only replaced
// before the match starts.
//
// WHERE IT APPLIES: when the second seat is taken (`createOrJoinPuzzleRanked`).
// A waiting lobby holds a provisional set that nobody has seen — the board is
// withheld until `playing` — so replacing it at pairing is invisible and keeps
// the frozen-set guarantee intact. Once a match is `playing`, its set is fixed
// for recovery and for both seats.
//
// WHAT COUNTS AS SEEN: `playing` and `finished` ranked sessions inside the
// window. A `waiting` search or a `cancelled` one never showed a board, so it
// must not consume a puzzle. Practice/AI sessions are excluded: this window is
// a ranked-memory, not a global history, so practice cannot shrink the
// competitive pool.
//
// BEST EFFORT, NEVER A DEAD END: if a band's whole pool has been seen inside
// the window, selection falls back to the puzzle seen longest ago rather than
// failing to seat a match. `manifest.ts` owns that ordering.
//
// SERVER-ONLY: reads session rows; never imported by a client component.

import { and, desc, eq, or, sql } from "drizzle-orm";

import { db } from "../../db/client";
import { solitairePuzzleSessions } from "../../db/schema";
import {
  PUZZLE_SESSION_MODE,
  PUZZLE_SESSION_STATUS,
} from "./constants";
import type { PuzzleManifestEntry } from "./types";

/**
 * How long a ranked player's history constrains new selections.
 *
 * Seven days covers a normal play cadence (and several sessions' worth of
 * five-puzzle sets) without starving a band as the library grows: even the
 * smallest band now has six positions, and only five can be "burnt" per match.
 */
export const PUZZLE_REPEAT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Per-player row read bound. A week cannot realistically exceed this. */
const RECENT_ROW_LIMIT = 50;

export type RecentPuzzleSeen = {
  /** Library puzzle ids the players have raced inside the window. */
  ids: Set<string>;
  /**
   * The most recent instant each id was started. Used only for the
   * least-recently-seen fallback when a band is fully covered.
   */
  lastSeenAt: Map<string, number>;
};

function instantMs(value: unknown): number {
  if (!value) return 0;
  const ms = value instanceof Date ? value.getTime() : Date.parse(String(value));
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * The union of what these players have already raced inside the window.
 *
 * One bounded read per player, filtered here rather than in SQL so the seat
 * membership check is explicit and testable — a row the caller does not hold a
 * seat in can never contribute. The caller passes its transaction, so the read
 * happens under the same matchmaking advisory lock as the pairing.
 */
export async function recentRankedPuzzleSeen({
  tx,
  userIds,
  nowMs = Date.now(),
  windowMs = PUZZLE_REPEAT_WINDOW_MS,
  excludeSessionId = null,
}: {
  tx?: any;
  userIds: readonly (string | null | undefined)[];
  nowMs?: number;
  windowMs?: number;
  /** The provisional lobby being paired, when it is already a stored row. */
  excludeSessionId?: string | null;
}): Promise<RecentPuzzleSeen> {
  const ids = new Set<string>();
  const lastSeenAt = new Map<string, number>();
  const players = [...new Set(userIds.filter((id): id is string => Boolean(id)))];
  if (players.length === 0) return { ids, lastSeenAt };

  const sinceMs = nowMs - Math.max(0, windowMs);
  const client = tx ?? db;

  for (const userId of players) {
    const rows = await client
      .select()
      .from(solitairePuzzleSessions)
      .where(
        and(
          or(
            eq(solitairePuzzleSessions.player1Id, userId),
            eq(solitairePuzzleSessions.player2Id, userId),
          ),
          sql`${solitairePuzzleSessions.status} IN (${PUZZLE_SESSION_STATUS.PLAYING}, ${PUZZLE_SESSION_STATUS.FINISHED})`,
        ),
      )
      .orderBy(desc(solitairePuzzleSessions.createdAt))
      .limit(RECENT_ROW_LIMIT);

    for (const row of rows) {
      if (row.mode !== PUZZLE_SESSION_MODE.RANKED) continue;
      if (
        row.status !== PUZZLE_SESSION_STATUS.PLAYING &&
        row.status !== PUZZLE_SESSION_STATUS.FINISHED
      ) {
        continue;
      }
      if (row.player1Id !== userId && row.player2Id !== userId) continue;
      if (excludeSessionId && String(row.id) === String(excludeSessionId)) continue;

      const startedAtMs = instantMs(row.createdAt);
      if (startedAtMs < sinceMs) continue;

      const manifest = (row.manifest ?? []) as PuzzleManifestEntry[];
      for (const entry of manifest) {
        if (!entry || typeof entry.id !== "string") continue;
        ids.add(entry.id);
        const previous = lastSeenAt.get(entry.id) ?? 0;
        if (startedAtMs > previous) lastSeenAt.set(entry.id, startedAtMs);
      }
    }
  }

  return { ids, lastSeenAt };
}
