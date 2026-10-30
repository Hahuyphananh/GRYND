// src/lib/last-run/queries.ts
//
// READ SIDE of the durable LAST RUN records: the persisted result screen, the
// post-restart match view and the paginated match history.
//
// Every read is scoped to the authenticated viewer: a match id alone returns
// null unless the caller holds one of the two seats, so knowing an id is never
// enough to read somebody else's match. Outcomes are converted to the viewer's
// own perspective here — the stored `result` is seat-absolute.

import { and, desc, eq, inArray, or, sql } from "drizzle-orm";

import { db } from "../../db";
import { lastRunMatches, ratingEvents, users } from "../../db/schema";
import { LAST_RUN_GAME_KEY } from "./constants";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type LastRunRatingSide = { delta: number; before: number; after: number };

export type LastRunRatingView = {
  /** True only when the Elo writer applied this match. */
  applied: boolean;
  you?: LastRunRatingSide;
};

export type LastRunPersistedMatch = {
  matchId: string;
  /** Viewer-relative. */
  result: "win" | "loss" | "draw";
  /** Seat-absolute, as stored. */
  seatResult: "player1" | "player2" | "draw";
  endReason: string;
  durationMs: number;
  seed: number;
  rated: boolean;
  startedAt: string;
  endedAt: string;
  you: { survivalMs: number; distance: number };
  opponent: { survivalMs: number; distance: number; name: string | null };
};

export type LastRunRecord = {
  match: LastRunPersistedMatch;
  rating: LastRunRatingView | null;
};

type MatchRow = typeof lastRunMatches.$inferSelect;

function toPersistedMatch(
  row: MatchRow,
  viewerId: string,
  opponentName: string | null,
): LastRunPersistedMatch {
  const viewerIsPlayer1 = row.player1Id === viewerId;
  const result =
    row.result === "draw"
      ? "draw"
      : (row.result === "player1") === viewerIsPlayer1
        ? "win"
        : "loss";

  return {
    matchId: row.id,
    result,
    seatResult: row.result as LastRunPersistedMatch["seatResult"],
    endReason: row.endReason,
    durationMs: row.durationMs,
    seed: Number(row.seed),
    rated: row.rated,
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt.toISOString(),
    you: {
      survivalMs: viewerIsPlayer1 ? row.player1SurvivalMs : row.player2SurvivalMs,
      distance: viewerIsPlayer1 ? row.player1Distance : row.player2Distance,
    },
    opponent: {
      survivalMs: viewerIsPlayer1 ? row.player2SurvivalMs : row.player1SurvivalMs,
      distance: viewerIsPlayer1 ? row.player2Distance : row.player1Distance,
      name: opponentName,
    },
  };
}

/**
 * One persisted match, from `viewerId`'s side — or null.
 *
 * Null covers all three "not yours" cases identically (unknown id, malformed
 * id, viewer not a seat) so the caller cannot probe for the existence of
 * somebody else's match.
 */
export async function readLastRunMatch(
  matchId: string,
  viewerId: string,
): Promise<LastRunRecord | null> {
  if (!matchId || !UUID_RE.test(matchId) || !viewerId) return null;

  const [row] = await db
    .select()
    .from(lastRunMatches)
    .where(eq(lastRunMatches.id, matchId))
    .limit(1);
  if (!row) return null;

  const viewerIsPlayer1 = row.player1Id === viewerId;
  if (!viewerIsPlayer1 && row.player2Id !== viewerId) return null;

  const opponentClerkId = viewerIsPlayer1 ? row.player2Id : row.player1Id;

  const [viewerUser] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.clerkId, viewerId))
    .limit(1);
  const [opponentUser] = await db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.clerkId, opponentClerkId))
    .limit(1);

  let rating: LastRunRatingView | null = null;
  if (viewerUser) {
    const [event] = await db
      .select({
        delta: ratingEvents.delta,
        before: ratingEvents.ratingBefore,
        after: ratingEvents.ratingAfter,
      })
      .from(ratingEvents)
      .where(
        and(
          eq(ratingEvents.userId, viewerUser.id),
          eq(ratingEvents.gameKey, LAST_RUN_GAME_KEY),
          eq(ratingEvents.matchId, matchId),
        ),
      )
      .limit(1);

    rating = event
      ? {
          applied: row.rated,
          you: { delta: event.delta, before: event.before, after: event.after },
        }
      : { applied: false };
  }

  return { match: toPersistedMatch(row, viewerId, opponentUser?.name ?? null), rating };
}

/**
 * Paginated match history for one player, newest first.
 *
 * Only durable (settled) rows exist in this table — a match that never reached
 * completion has no row here, by design. The opponent's display name comes from
 * `users`; a deleted account leaves the row intact with a null name.
 */
export async function readLastRunHistory(
  viewerId: string,
  { page = 1, limit = 20 }: { page?: number; limit?: number } = {},
): Promise<{
  matches: LastRunPersistedMatch[];
  pagination: { page: number; limit: number; total: number; totalPages: number; hasMore: boolean };
}> {
  const take = Math.min(50, Math.max(1, Math.floor(limit) || 20));
  const current = Math.max(1, Math.floor(page) || 1);
  const offset = (current - 1) * take;

  const where = or(
    eq(lastRunMatches.player1Id, viewerId),
    eq(lastRunMatches.player2Id, viewerId),
  );

  const [rows, counted] = await Promise.all([
    db
      .select()
      .from(lastRunMatches)
      .where(where)
      .orderBy(desc(lastRunMatches.endedAt))
      .limit(take)
      .offset(offset),
    db.select({ count: sql<number>`count(*)::int` }).from(lastRunMatches).where(where),
  ]);

  const opponentIds = Array.from(
    new Set(rows.map((row) => (row.player1Id === viewerId ? row.player2Id : row.player1Id))),
  ).filter(Boolean);

  const names = new Map<string, string>();
  if (opponentIds.length > 0) {
    const found = await db
      .select({ clerkId: users.clerkId, name: users.name })
      .from(users)
      .where(inArray(users.clerkId, opponentIds));
    for (const entry of found) names.set(entry.clerkId, entry.name);
  }

  const total = counted[0]?.count ?? 0;
  const totalPages = Math.ceil(total / take);

  return {
    matches: rows.map((row) => {
      const opponentClerkId = row.player1Id === viewerId ? row.player2Id : row.player1Id;
      return toPersistedMatch(row, viewerId, names.get(opponentClerkId) ?? null);
    }),
    pagination: {
      page: current,
      limit: take,
      total,
      totalPages,
      hasMore: current < totalPages,
    },
  };
}
