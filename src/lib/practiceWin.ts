// src/lib/practiceWin.ts
//
// Free practice games that live ENTIRELY in the browser (Four-in-a-Row, RPS,
// Barrier Blitz) have no match row and no server settlement, so the shared
// marker writers in src/lib/rating.js and src/lib/dailyRewardWin.ts never see
// their result. This module is the one place that turns a client-reported
// terminal win into the same `users.last_won_game_date` marker the daily
// reward reads, so a practice win counts exactly like a server-settled one.
//
// ── Why this is client-authoritative ────────────────────────────────────────
//
// For these three modes the browser IS the game authority: there is no wager,
// rating or trophy at stake, and the engine that decides the winner runs in the
// page. The daily reward is a small nudge back into a game, not a competitive
// prize, so the honest trade-off is to trust the terminal result for these
// modes rather than ship a server copy of three more engines.
//
// The endpoint still refuses a report from a player who has not started a
// practice session today (`last_played_game_date`, stamped by the shared
// /api/game-plays edge when GameSessionHost's autoStart flips). That is not a
// security boundary — the client can call that edge too — it is a cheap guard
// against a stray/accidental POST unlocking the reward without a game at all.
//
// A draw or a loss must never call this: only a genuine win is the price of
// the reward.

import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { users } from "../db/schema";
import { markDailyRewardWin, utcWinDay } from "./dailyRewardWin";

/** The practice modes whose result is decided only in the browser. */
export const CLIENT_SETTLED_PRACTICE_GAMES = [
  "four-in-a-row",
  "rps",
  "barrier-blitz",
] as const;

export type ClientSettledPracticeGame =
  (typeof CLIENT_SETTLED_PRACTICE_GAMES)[number];

/** Narrow an untrusted request body value to a known practice game key. */
export function isClientSettledPracticeGame(
  value: unknown,
): value is ClientSettledPracticeGame {
  return (
    typeof value === "string" &&
    (CLIENT_SETTLED_PRACTICE_GAMES as readonly string[]).includes(value)
  );
}

export type PracticeWinResult =
  | { ok: true; stamped: boolean }
  | { ok: false; status: number; error: string };

/**
 * Whether the player's last practice-session stamp is today's UTC day. Pure,
 * so the anti-stray-POST guard is testable without a database.
 */
export function isPracticeSessionToday(
  lastPlayed: string | Date | null | undefined,
  today: string = utcWinDay(),
): boolean {
  if (!lastPlayed) return false;
  const day =
    lastPlayed instanceof Date
      ? lastPlayed.toISOString().slice(0, 10)
      : String(lastPlayed).slice(0, 10);
  return day === today;
}

/**
 * Stamp today's win for a signed-in player after a client-settled practice
 * game. Returns a discriminated result so the route can choose the HTTP status
 * without throwing, and so a repeated report is harmless (the marker is a
 * date, not a counter).
 */
export async function markClientPracticeWin(
  clerkId: string | null | undefined,
  game: unknown,
): Promise<PracticeWinResult> {
  if (!clerkId) {
    return { ok: false, status: 401, error: "Not authenticated" };
  }
  if (!isClientSettledPracticeGame(game)) {
    return { ok: false, status: 400, error: "Unknown practice game" };
  }

  const today = utcWinDay();
  const [user] = await db
    .select({
      id: users.id,
      lastPlayed: users.lastPlayedGameDate,
    })
    .from(users)
    .where(eq(users.clerkId, clerkId))
    .limit(1);

  if (!user) {
    return { ok: false, status: 404, error: "User not found" };
  }

  // A session start is recorded by the same client that reports the win, so
  // this only proves a game was begun today. It keeps a stray POST — or a
  // stale tab from yesterday — from unlocking the reward on its own.
  if (!isPracticeSessionToday(user.lastPlayed, today)) {
    return {
      ok: false,
      status: 409,
      error: "Start a practice match before reporting a win",
    };
  }

  const stamped = await markDailyRewardWin(db, clerkId);
  if (!stamped) {
    return { ok: false, status: 404, error: "User not found" };
  }
  return { ok: true, stamped };
}
