// src/app/api/lane-rush-duel/history/route.js
//
// GET — paginated match history for the current user. Returns
// FINISHED Lane Rush Duel matches (both PvP and Test vs Bot
// practice), each in viewer perspective:
//   * `viewerIsPlayer1`, `myLane` / `oppLane`, `myHeld` / `oppHeld`
//     plus the banked multipliers
//   * `result`: "win" | "loss" | "draw" (viewer-relative — the
//     stored `result` column is seat-absolute 'player1'|'player2')
//   * `payout`: prizePaid on a win, stakeAmount on a draw (refund),
//     0 on a loss
//   * `isBot` + `opponentName` (display name from `users`, or "Bot"
//     for practice matches)
//
// Mirrors the hex-duel history route shape (page/limit pagination,
// opponent-name batch fetch).

import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { db } from "../../../../db/client";
import { laneRushDuelMatches, users } from "../../../../db/schema";
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";


const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

export async function GET(req) {
  try {
    const { userId: clerkId } = await auth();
    if (!clerkId) {
      return NextResponse.json(
        { success: false, error: "Unauthorized — please sign in" },
        { status: 401 },
      );
    }

    const url = new URL(req.url);
    const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
    const limit = Math.min(
      MAX_LIMIT,
      Math.max(1, Number(url.searchParams.get("limit")) || DEFAULT_LIMIT),
    );
    const offset = (page - 1) * limit;

    // Only RESOLVED matches appear in history — waiting/ready/turn/
    // cancelled rows have no outcome yet.
    const whereExpr = and(
      or(
        eq(laneRushDuelMatches.player1Id, clerkId),
        eq(laneRushDuelMatches.player2Id, clerkId),
      ),
      eq(laneRushDuelMatches.status, "finished"),
    );

    const [rows, countResult] = await Promise.all([
      db
        .select()
        .from(laneRushDuelMatches)
        .where(whereExpr)
        .orderBy(desc(laneRushDuelMatches.createdAt))
        .limit(limit)
        .offset(offset),
      db
        .select({ count: sql`count(*)::int` })
        .from(laneRushDuelMatches)
        .where(whereExpr),
    ]);

    const total = countResult[0]?.count ?? 0;
    const totalPages = Math.ceil(total / limit);

    // Batch-fetch opponent display names (the seat the viewer isn't in).
    const opponentIds = Array.from(
      new Set(
        rows.map((r) => (r.player1Id === clerkId ? r.player2Id : r.player1Id)),
      ),
    ).filter((id) => Boolean(id) && id !== "AI_BOT");

    const namesByClerkId = new Map();
    if (opponentIds.length > 0) {
      const opponentRows = await db
        .select({ clerkId: users.clerkId, name: users.name })
        .from(users)
        .where(inArray(users.clerkId, opponentIds));
      for (const opp of opponentRows) {
        namesByClerkId.set(opp.clerkId, opp.name);
      }
    }

    const games = rows.map((row) => {
      const viewerIsPlayer1 = row.player1Id === clerkId;
      const isBot = row.player2Id === "AI_BOT";
      const myLane = Number(viewerIsPlayer1 ? row.p1Lane : row.p2Lane) || 0;
      const oppLane = Number(viewerIsPlayer1 ? row.p2Lane : row.p1Lane) || 0;
      const myHeld = Boolean(viewerIsPlayer1 ? row.p1Held : row.p2Held);
      const oppHeld = Boolean(viewerIsPlayer1 ? row.p2Held : row.p1Held);
      const myPoints = Number(viewerIsPlayer1 ? row.p1Points : row.p2Points) || 0;
      const oppPoints = Number(viewerIsPlayer1 ? row.p2Points : row.p1Points) || 0;

      const isDraw = row.result === "draw" || !row.winnerId;
      const isWin = !isDraw && row.winnerId === clerkId;
      const stake = Number(row.stakeAmount) || 0;
      const prize = Number(row.prizePaid) || 0;

      const opponentClerkId = viewerIsPlayer1 ? row.player2Id : row.player1Id;

      return {
        id: row.id,
        difficulty: row.difficulty,
        stakeAmount: stake,
        isBot,
        isDraw,
        result: isDraw ? "draw" : isWin ? "win" : "loss",
        winnerId: row.winnerId ?? null,
        prizePaid: prize,
        payout: isWin ? prize : isDraw ? stake : 0,
        viewerIsPlayer1,
        myLane,
        oppLane,
        myHeld,
        oppHeld,
        myPoints,
        oppPoints,
        opponentName: isBot
          ? "Bot"
          : namesByClerkId.get(opponentClerkId) || "Opponent",
        startedAt: row.startedAt,
        endedAt: row.endedAt,
        createdAt: row.createdAt,
      };
    });

    return NextResponse.json({
      success: true,
      data: {
        games,
        pagination: {
          page,
          limit,
          total,
          totalPages,
          hasMore: page < totalPages,
        },
      },
    });
  } catch (error) {
    console.error("Lane Rush Duel history error:", error);
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
