// src/app/api/solitaire/history/route.ts
//
// THE ACCOUNT'S REVIEW HISTORY.
//
// The list of completed single-player games a signed-in player can reopen, so
// it follows the ACCOUNT instead of one browser's localStorage ring. Each
// entry is deliberately thin — id, mode, date, move count and time — because
// the review itself is fetched from `/api/solitaire/review` when the player
// opens a game. The move logs are never sent in a list.
//
// REVIEWABLE ONLY: a row earns an entry when it is completed AND carries a
// stored canonical log. Both routes write `log_digest` exactly when they write
// `move_log`, so the digest is the cheap test; the review route still replays
// the log before it serves anything.
//
// IDENTITY: Clerk only. A guest's history lives in the browser ring
// (`localReview.ts`), and this endpoint never reads an identity from the URL or
// body. Both queries filter by the session's own user id.
//
// Read-only: nothing here writes, updates, settles or touches ranked tables.

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { desc, eq } from "drizzle-orm";

import { db } from "../../../../db/client";
import { solitaireDailyResults, solitaireSoloResults } from "../../../../db/schema";
import { logError } from "../../../../lib/logError";
import { toIso } from "../../../../lib/solitaire-duel/review";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 50;

type HistoryGame = {
  id: string;
  gameKind: "solo" | "daily";
  /** The daily challenge's UTC date; null for a solo game. */
  dateKey: string | null;
  /** The solo deal seed; null for a daily game. */
  seed: number | null;
  moves: number;
  elapsedMs: number | null;
  completedAt: string | null;
};

function readLimit(value: string | null): number {
  // `Number(null)` is 0, so a missing parameter must be handled before parsing
  // or the default page would silently collapse to one game.
  if (value === null || value.trim() === "") return DEFAULT_LIMIT;
  const limit = Math.round(Number(value));
  if (!Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, limit));
}

function instantOf(game: HistoryGame): number {
  const ms = game.completedAt ? Date.parse(game.completedAt) : NaN;
  return Number.isFinite(ms) ? ms : 0;
}

function elapsedOrNull(value: unknown): number | null {
  const ms = Number(value);
  return Number.isFinite(ms) && ms > 0 ? Math.round(ms) : null;
}

export async function GET(req: Request) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json(
      { success: false, error: "Unauthenticated", code: "SIGN_IN_REQUIRED" },
      { status: 401 },
    );
  }

  const limit = readLimit(new URL(req.url).searchParams.get("limit"));

  try {
    const [soloRows, dailyRows] = await Promise.all([
      db
        .select({
          id: solitaireSoloResults.id,
          seed: solitaireSoloResults.seed,
          completed: solitaireSoloResults.completed,
          moves: solitaireSoloResults.moves,
          elapsedMs: solitaireSoloResults.elapsedMs,
          logDigest: solitaireSoloResults.logDigest,
          createdAt: solitaireSoloResults.createdAt,
        })
        .from(solitaireSoloResults)
        .where(eq(solitaireSoloResults.userId, userId))
        .orderBy(desc(solitaireSoloResults.createdAt))
        .limit(limit),
      db
        .select({
          id: solitaireDailyResults.id,
          challengeDate: solitaireDailyResults.challengeDate,
          completed: solitaireDailyResults.completed,
          moves: solitaireDailyResults.moves,
          elapsedMs: solitaireDailyResults.elapsedMs,
          logDigest: solitaireDailyResults.logDigest,
          createdAt: solitaireDailyResults.createdAt,
        })
        .from(solitaireDailyResults)
        .where(eq(solitaireDailyResults.userId, userId))
        .orderBy(desc(solitaireDailyResults.createdAt))
        .limit(limit),
    ]);

    const games: HistoryGame[] = [
      ...soloRows
        .filter((row) => row.completed === true && Boolean(row.logDigest))
        .map((row) => {
          const seed = Number(row.seed);
          return {
            id: row.id,
            gameKind: "solo" as const,
            dateKey: null,
            seed: Number.isInteger(seed) && seed >= 0 ? seed : null,
            moves: Number(row.moves) || 0,
            elapsedMs: elapsedOrNull(row.elapsedMs),
            completedAt: toIso(row.createdAt),
          };
        }),
      ...dailyRows
        .filter((row) => row.completed === true && Boolean(row.logDigest))
        .map((row) => ({
          id: row.id,
          gameKind: "daily" as const,
          dateKey: row.challengeDate,
          seed: null,
          moves: Number(row.moves) || 0,
          elapsedMs: elapsedOrNull(row.elapsedMs),
          completedAt: toIso(row.createdAt),
        })),
    ]
      // Two tables, one timeline: newest first, and no more than the caller
      // asked for even if both tables returned a full page.
      .sort((a, b) => instantOf(b) - instantOf(a))
      .slice(0, limit);

    return NextResponse.json({ success: true, data: { games } });
  } catch (error) {
    await logError({
      errorType: "solitaire_history_get_error",
      errorMessage: error instanceof Error ? error.message : "History fetch failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/solitaire/history",
      game: "Solitaire",
      metadata: { operation: "get" },
    });
    return NextResponse.json({ success: false, error: "Server error" }, { status: 500 });
  }
}
