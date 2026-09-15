// src/lib/gamePresenceStore.ts
//
// Server-side store for per-game ACTIVE PLAYER presence (the casino lobby's
// "12 playing" badge). Everything that touches user_game_presence lives here,
// so the HTTP routes stay thin and the aggregate can be reused (a future admin
// view, the lobby, tests) without a second implementation.
//
// Three operations:
//   markPlaying()        — the heartbeat. Idempotent UPSERT on (user_id, game_key).
//   clearPlaying()       — optional instant leave. Never required for correctness.
//   countActivePlayers() — aggregate counts grouped by canonical game id.
//
// Contracts this module guarantees:
//   * A user is identified by their internal users.id, resolved from the Clerk
//     session by the caller. No function here accepts a client-supplied user.
//   * One row per (user, game). Repeated heartbeats, multiple tabs and multiple
//     devices can never make one player count twice for the same game.
//   * `game_key` is always a CANONICAL game id (see src/lib/gamePresence.js);
//     unknown games are rejected by the route before reaching this store.
//   * Expiration is time-based only. Nothing here needs an explicit leave: a
//     row stops counting the moment last_seen_at falls out of the window.

import { and, eq, gt, sql } from "drizzle-orm";
import { db } from "../db";
import { userGamePresence } from "../db/schema";
import { presenceCutoff, toActivePlayerCounts } from "./gamePresence";

export type ActivePlayerCounts = Record<string, number>;

/**
 * Upsert the caller's presence for one canonical game.
 *
 * Idempotent by construction: the unique (user_id, game_key) row is updated in
 * place, so hammering this endpoint updates one row's timestamps and can never
 * create duplicates. `created_at` is only ever written on INSERT — the first
 * time this user was seen in this game — while `updated_at` moves on every
 * beat, matching the timestamp conventions used across the schema.
 *
 * @param userId    internal users.id (from the authenticated session)
 * @param gameId    canonical game id, already validated by the route
 * @param sessionId optional client session/tab id (informational; NOT part of
 *                  the uniqueness rule, so a second tab cannot double-count)
 */
export function markPlayingQuery({
  userId,
  gameId,
  sessionId = null,
  now = new Date(),
}: {
  userId: number;
  gameId: string;
  sessionId?: string | null;
  now?: Date;
}) {
  return db
    .insert(userGamePresence)
    .values({
      userId,
      gameKey: gameId,
      sessionId,
      lastSeenAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      // One row per (user, game): a repeat beat updates that row's timestamps
      // instead of inserting a second one, so a count can never double up.
      target: [userGamePresence.userId, userGamePresence.gameKey],
      set: {
        sessionId,
        lastSeenAt: now,
        updatedAt: now,
      },
    });
}

/** Execute the heartbeat upsert. */
export async function markPlaying(args: {
  userId: number;
  gameId: string;
  sessionId?: string | null;
}): Promise<void> {
  await markPlayingQuery(args);
}

/**
 * Clear presence for the caller — all games, or just their current one.
 *
 * Scoped to a session id when one is supplied, so navigating away in one tab
 * cannot wipe a still-open second tab's presence. Never required: this only
 * makes a departure instant instead of waiting out the activity window.
 *
 * @returns the number of rows removed.
 */
export function clearPlayingQuery({
  userId,
  gameId = null,
  sessionId = null,
}: {
  userId: number;
  gameId?: string | null;
  sessionId?: string | null;
}) {
  const filters = [eq(userGamePresence.userId, userId)];
  if (gameId) filters.push(eq(userGamePresence.gameKey, gameId));
  // Only clear a row this tab owns. A row written by another tab (different
  // session id) is left alone and just ages out normally.
  if (sessionId) filters.push(eq(userGamePresence.sessionId, sessionId));

  return db
    .delete(userGamePresence)
    .where(and(...filters))
    .returning({ id: userGamePresence.id });
}

/** Execute the (optional) instant leave; returns how many rows it removed. */
export async function clearPlaying(args: {
  userId: number;
  gameId?: string | null;
  sessionId?: string | null;
}): Promise<number> {
  const deleted = await clearPlayingQuery(args);
  return deleted.length;
}

/**
 * Aggregate active players per game.
 *
 * Returns ONLY counts grouped by canonical game id — no user ids, no names, no
 * session ids, ever. Driven by `(game_key, last_seen_at)`, and the window
 * predicate keeps the scan to at most `users × games` rows instead of any
 * historical record.
 *
 * Games with nobody playing are simply absent (never reported as 0), so the UI
 * can hide the badge without extra logic.
 */
export function activePlayersQuery(now: number = Date.now()) {
  return db
    .select({
      gameId: userGamePresence.gameKey,
      players: sql<number>`COUNT(*)::int`,
    })
    .from(userGamePresence)
    .where(gt(userGamePresence.lastSeenAt, presenceCutoff(now)))
    .groupBy(userGamePresence.gameKey);
}

export async function countActivePlayers(now: number = Date.now()): Promise<ActivePlayerCounts> {
  const rows = await activePlayersQuery(now);

  // Normalization is a pure, tested rule (src/lib/gamePresence.js): unknown
  // keys can never reach the lobby, and a game nobody is playing is absent
  // rather than reported as 0.
  return toActivePlayerCounts(rows);
}

/**
 * Delete presence rows that have been stale for longer than `maxAgeSeconds`.
 *
 * The activity window already excludes them from the count, so this is purely
 * storage hygiene (rows are bounded by users × games anyway). Called from the
 * existing daily retention cron rather than a new job.
 */
export async function pruneStalePresence(maxAgeSeconds = 86400): Promise<number> {
  const cutoff = new Date(Date.now() - maxAgeSeconds * 1000);
  const removed = await db
    .delete(userGamePresence)
    .where(sql`${userGamePresence.lastSeenAt} < ${cutoff}`)
    .returning({ id: userGamePresence.id });

  return removed.length;
}
