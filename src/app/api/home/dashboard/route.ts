// src/app/api/home/dashboard/route.ts
//
// THE HOME DASHBOARD'S ONE PLAYER READ.
//
// The home page used to assemble its player panel from five separate requests
// (`/api/user-stats`, `/api/get-user-tokens`, `/api/solitaire-duel/lobby`,
// `/api/solitaire/solo`, `/api/solitaire/daily`). Every one of them re-resolved
// the same session and several returned overlapping state, so the page could
// show two different trophy totals while both were "loading".
//
// This route answers the dashboard's four questions in one response:
//
//   1. How am I progressing?  → the authoritative trophy-derived level/rank
//      (`getTotalTrophyProgressForUser`), the Solitaire rating row and the
//      server-owned daily streak (`readStreakState`).
//   2. What should I do next? → `selectNextAction`, a pure fixed-precedence
//      recommendation with its reason.
//   3. How have I performed?  → a merged newest-first activity list built from
//      the caller's own ranked, Solo and Daily rows.
//   4. What can I improve?     → the review link on a completed game (the
//      existing Game Review surface; no second analysis engine here).
//
// EVERYTHING IS SERVER-AUTHORITATIVE. The session id is the only identity input
// (never a query parameter or body), all five source reads are filtered by it,
// and no stat is computed from client-supplied data. Nothing is written.
//
// PARTIAL FAILURE IS EXPLICIT. If the trophy progression read fails the route
// returns 503 (the panel cannot honestly say "Level 1"); any other failed read
// is omitted from the payload and `partial: true` tells the UI to keep the rest
// and say that part of the dashboard is unavailable rather than print a zero.

import { auth } from "@clerk/nextjs/server";
import { desc, eq, or } from "drizzle-orm";

import { db } from "../../../../db/client";
import {
  solitaireDailyResults,
  solitaireDuelMatches,
  solitaireSoloResults,
} from "../../../../db/schema";
import {
  getTotalTrophyProgressForUser,
  getTrophiesForUser,
} from "../../../../lib/trophyStore";
import { getRatingsForUser } from "../../../../lib/rating";
import { readStreakState } from "../../../../lib/streaks/server";
import { dailyDateKey, summariseDaily, summariseSolo } from "../../../../lib/solitaire-duel/soloStats.js";
import {
  REVIEW_WINDOW_MS,
  buildRecentActivity,
  fastestSolveMs,
  instantMs,
  isNewPlayer,
  selectNextAction,
} from "../../../../lib/home/dashboard.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = {
  "Cache-Control": "private, no-store",
} as const;

const RECENT_ROWS = 8;

type RankedRow = {
  id: unknown;
  status: unknown;
  result: unknown;
  winnerId: unknown;
  isAi: unknown;
  createdAt: unknown;
  endedAt: unknown;
};

/**
 * The caller's own last few matches, in the same shape the lobby preview uses.
 * The winner is the server's column; the UI only names the caller's side of it.
 */
async function recentRanked(userId: string) {
  const rows = (await db
    .select({
      id: solitaireDuelMatches.id,
      status: solitaireDuelMatches.status,
      result: solitaireDuelMatches.result,
      winnerId: solitaireDuelMatches.winnerId,
      isAi: solitaireDuelMatches.isAi,
      createdAt: solitaireDuelMatches.createdAt,
      endedAt: solitaireDuelMatches.endedAt,
    })
    .from(solitaireDuelMatches)
    .where(
      or(
        eq(solitaireDuelMatches.player1Id, userId),
        eq(solitaireDuelMatches.player2Id, userId),
      ),
    )
    .orderBy(desc(solitaireDuelMatches.createdAt))
    .limit(RECENT_ROWS)) as RankedRow[];

  return rows.map((row) => {
    const finished = row.status === "finished";
    const outcome = row.winnerId
      ? row.winnerId === userId
        ? "win"
        : "loss"
      : finished
        ? "draw"
        : null;
    return {
      matchId: String(row.id),
      status: String(row.status),
      outcome,
      isAi: Boolean(row.isAi),
      createdAtMs: instantMs(row.createdAt),
      endedAtMs: instantMs(row.endedAt),
    };
  });
}

async function soloRows(userId: string) {
  return (await db
    .select({
      id: solitaireSoloResults.id,
      completed: solitaireSoloResults.completed,
      moves: solitaireSoloResults.moves,
      elapsedMs: solitaireSoloResults.elapsedMs,
      logDigest: solitaireSoloResults.logDigest,
      createdAt: solitaireSoloResults.createdAt,
    })
    .from(solitaireSoloResults)
    .where(eq(solitaireSoloResults.userId, userId))
    .orderBy(desc(solitaireSoloResults.createdAt))
    // The same 500-row window `/api/solitaire/solo` summarises, so the two
    // surfaces cannot disagree about the player's Solo record.
    .limit(500)) as Array<Record<string, unknown>>;
}

async function dailyRows(userId: string) {
  return (await db
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
    .orderBy(desc(solitaireDailyResults.challengeDate))) as Array<
    Record<string, unknown>
  >;
}

export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    // Guests never receive somebody else's panel; the page renders its guest
    // starting path instead of calling this at all.
    return Response.json({ success: true, signedIn: false }, { headers: NO_STORE });
  }

  const todayKey = dailyDateKey();
  const nowMs = Date.now();

  // The progression read is the one section the dashboard cannot fake.
  let progression;
  try {
    progression = await getTotalTrophyProgressForUser(userId);
  } catch (error) {
    console.error("[home/dashboard] Failed to load player progression:", error);
    return Response.json(
      { success: false, signedIn: true, error: "Unable to load your dashboard" },
      { status: 503, headers: NO_STORE },
    );
  }

  // Everything else degrades independently: a failed section is omitted rather
  // than replaced with a zero the player did not earn.
  const settled = await Promise.allSettled([
    getTrophiesForUser(userId),
    getRatingsForUser(userId),
    readStreakState(userId),
    recentRanked(userId),
    soloRows(userId),
    dailyRows(userId),
  ]);

  let failed = 0;
  const value = <T,>(index: number, fallback: T): T => {
    const result = settled[index];
    if (result.status === "fulfilled") return result.value as T;
    failed += 1;
    console.error("[home/dashboard] A dashboard read failed:", result.reason);
    return fallback;
  };

  const trophies = value<Record<string, any>>(0, {});
  const ratings = value<Record<string, any>>(1, {});
  const streakState = value<Awaited<ReturnType<typeof readStreakState>>>(2, null);
  const rankedRows = value<Array<Record<string, any>>>(3, []);
  const solo = value<Array<Record<string, any>>>(4, []);
  const daily = value<Array<Record<string, any>>>(5, []);

  const ratingRow = ratings?.["solitaire-duel"] ?? null;
  const trophyRow = trophies?.["solitaire-duel"] ?? null;

  const soloSummary = summariseSolo(solo);
  const dailySummary = summariseDaily(daily, todayKey);

  const streak = streakState
    ? {
        current: Math.max(0, Number(streakState.currentStreak) || 0),
        best: Math.max(0, Number(streakState.longestStreak) || 0),
        creditedToday: streakState.lastCompletedUtcDate === todayKey,
        nextMilestone: streakState.nextMilestone ?? null,
      }
    : null;

  const lastRankedChange =
    ratingRow || trophyRow
      ? {
          ratingDelta: Number(ratingRow?.lastDelta) || 0,
          trophyDelta: Number(trophyRow?.lastDelta) || 0,
          at: instantMs(ratingRow?.lastRatedAt ?? trophyRow?.lastTrophyAt),
        }
      : null;

  const recent = buildRecentActivity({
    ranked: rankedRows,
    solo: solo.map((row) => ({
      id: row.id,
      completed: row.completed,
      moves: row.moves,
      elapsedMs: row.elapsedMs,
      reviewable: Boolean(row.logDigest),
      createdAtMs: instantMs(row.createdAt),
    })),
    daily: daily.map((row) => ({
      id: row.id,
      completed: row.completed,
      moves: row.moves,
      elapsedMs: row.elapsedMs,
      reviewable: Boolean(row.logDigest),
      dateKey: row.challengeDate,
      createdAtMs: instantMs(row.createdAt),
    })),
  });

  const dailyCompletedToday = dailySummary.today?.completed === true;
  const rankedGames = Number(ratingRow?.gamesRated) || 0;
  const newPlayer = isNewPlayer({
    rankedGames,
    soloGames: soloSummary.games,
    dailyCompleted: dailySummary.completed,
    streakCurrent: streak?.current ?? 0,
  });

  // The newest completed game that still has a review to open and is recent
  // enough to be called "your last game".
  const reviewCandidate =
    recent.find(
      (entry) =>
        entry.reviewable &&
        entry.at > 0 &&
        nowMs - entry.at <= REVIEW_WINDOW_MS,
    ) ?? null;

  const recommendation = selectNextAction({
    newPlayer,
    dailyCompletedToday,
    rankedGames,
    recentReview: reviewCandidate
      ? { kind: reviewCandidate.kind, href: reviewCandidate.href, at: reviewCandidate.at }
      : null,
    nowMs,
  });

  return Response.json(
    {
      success: true,
      signedIn: true,
      partial: failed > 0,
      generatedAt: nowMs,
      overview: {
        playerLevel: progression,
        trophies: {
          total: progression.currentTrophies,
          peak: progression.peakTrophies,
        },
        ranked: ratingRow
          ? {
              rating: Number(ratingRow.rating),
              peakRating: Number(ratingRow.peakRating),
              gamesRated: Number(ratingRow.gamesRated) || 0,
              wins: Number(ratingRow.wins) || 0,
              losses: Number(ratingRow.losses) || 0,
              draws: Number(ratingRow.draws) || 0,
              winRate: Number(ratingRow.winRate) || 0,
              provisional: Boolean(ratingRow.provisional),
              provisionalGamesRemaining: Number(
                ratingRow.provisionalGamesRemaining,
              ) || 0,
            }
          : null,
        lastRankedChange,
        streak,
        solo: soloSummary,
        daily: { ...dailySummary, dateKey: todayKey },
        fastestSolveMs: fastestSolveMs(soloSummary, dailySummary),
      },
      recent,
      recommendation,
    },
    { headers: NO_STORE },
  );
}
