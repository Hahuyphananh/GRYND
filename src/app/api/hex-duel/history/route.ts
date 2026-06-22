import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { db } from "../../../../db/client";
import { hexDuelGames, users } from "../../../../db/schema";
import { and, desc, eq, inArray, isNotNull, ne, or, sql } from "drizzle-orm";
import {
  normalizeHexDuelForViewer,
  type HexDuelHistoryRow,
} from "../../../../lib/hexDuelHistoryPerspective";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

export async function GET(req: Request) {
  try {
    const { userId: clerkId } = await auth();

    if (!clerkId) {
      return NextResponse.json(
        { success: false, error: "Unauthorized — please sign in" },
        { status: 401 }
      );
    }

    const url = new URL(req.url);
    const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
    const limit = Math.min(
      MAX_LIMIT,
      Math.max(1, Number(url.searchParams.get("limit")) || DEFAULT_LIMIT)
    );
    const offset = (page - 1) * limit;

    // The viewer may have played as engine player1 (host) OR player2 (joiner).
    // Return only RESOLVED games — half-finished ones (waiting/in_progress,
    // or with player2=null) are skipped because there's no opponent data
    // and no winner yet. This also fixes the long-standing bug where the
    // previous query only returned rows where the viewer was the host.
    const whereExpr = and(
      or(
        eq(hexDuelGames.player1Id, clerkId),
        eq(hexDuelGames.player2Id, clerkId)
      ),
      isNotNull(hexDuelGames.player2Id),
      ne(hexDuelGames.status, "waiting"),
      ne(hexDuelGames.status, "in_progress")
    );

    const [rows, countResult] = await Promise.all([
      db
        .select()
        .from(hexDuelGames)
        .where(whereExpr)
        .orderBy(desc(hexDuelGames.createdAt))
        .limit(limit)
        .offset(offset),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(hexDuelGames)
        .where(whereExpr),
    ]);

    const total = countResult[0]?.count ?? 0;
    const totalPages = Math.ceil(total / limit);

    // Batch-fetch opponent display names. The opponent is whichever seat
    // the viewer ISN'T occupying.
    const opponentIds = Array.from(
      new Set(
        rows.map((r) =>
          r.player1Id === clerkId ? r.player2Id : r.player1Id
        )
      )
    ).filter((id): id is string => Boolean(id));

    const opponentNamesByClerkId = new Map<string, string>();
    if (opponentIds.length > 0) {
      // Use Drizzle's inArray operator — safe parameter binding, no manual
      // SQL string interpolation with caller-controlled IDs.
      const opponentRows = await db
        .select({ clerkId: users.clerkId, name: users.name })
        .from(users)
        .where(inArray(users.clerkId, opponentIds));
      for (const opp of opponentRows) {
        opponentNamesByClerkId.set(opp.clerkId, opp.name);
      }
    }

    // Build the perspective-aware response — mirrors the in-board
    // displayGrid swap so each viewer sees "You / Opponent" rather than
    // "P1 / P2" on external surfaces (history, bet-history).
    const enrichedGames = rows.map((row) => {
      const opponentClerkId =
        row.player1Id === clerkId ? row.player2Id : row.player1Id;
      const opponentDisplayName =
        opponentClerkId && opponentNamesByClerkId.get(opponentClerkId);
      const rowWithOppName: HexDuelHistoryRow = {
        ...row,
        opponentName: opponentDisplayName ?? null,
      };
      const perspective = normalizeHexDuelForViewer(rowWithOppName, clerkId);
      return {
        ...rowWithOppName,
        // Override the row's engine-absolute `result` with the viewer's
        // perspective: "win" iff the viewer won. The page already keys
        // off `result === "win"` for the Win/Loss badge.
        result: perspective.viewerWon ? "win" : "loss",
        isHost: perspective.isHost,
        viewerMoves: perspective.viewerMoves,
        opponentMoves: perspective.opponentMoves,
        viewerTerritory: perspective.viewerTerritory,
        opponentTerritory: perspective.opponentTerritory,
        opponentDisplayName: perspective.opponentIsAi
          ? `AI (${perspective.opponentAiDifficulty || "medium"})`
          : opponentDisplayName || "Opponent",
      };
    });

    return NextResponse.json({
      success: true,
      data: {
        games: enrichedGames,
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
    console.error("❌ Hex Duel history error:", error);
    return NextResponse.json(
      {
        success: false,
        error: "Server error",
        details: error instanceof Error ? error.message : "Unknown",
      },
      { status: 500 }
    );
  }
}
