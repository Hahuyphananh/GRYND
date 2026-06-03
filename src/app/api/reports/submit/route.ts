// src/app/api/reports/submit/route.ts
// POST → submit a player report from a PVP game

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { getNeonSql } from "../../../../db/neon";

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  if (!body) {
    return NextResponse.json({ success: false, error: "Invalid request body" }, { status: 400 });
  }

  const { reportedClerkId, gameType, gameId, reason, details } = body as {
    reportedClerkId: string;
    gameType: string;
    gameId?: string;
    reason: string;
    details?: string;
  };

  // Validate reason
  const validReasons = ["toxic_player", "hacker", "inappropriate_name", "inappropriate_picture", "other"];
  if (!reason || !validReasons.includes(reason)) {
    return NextResponse.json(
      { success: false, error: "Invalid reason. Must be one of: " + validReasons.join(", ") },
      { status: 400 },
    );
  }

  // Validate details required for "other" reason
  if (reason === "other" && (!details || details.trim().length === 0)) {
    return NextResponse.json(
      { success: false, error: "Details are required when selecting 'Other' reason" },
      { status: 400 },
    );
  }

  // Resolve reportedClerkId from game if needed (e.g. hex-duel doesn't have opponent clerkId client-side)
  let resolvedReportedId = reportedClerkId;
  if ((!resolvedReportedId || resolvedReportedId === "player1" || resolvedReportedId === "player2") && gameId && gameType) {
    try {
      const sql = getNeonSql();
      let lookupResult: any = [];

      if (gameType === "hex-duel") {
        lookupResult = await sql`
          SELECT player1_id, player2_id FROM hex_duel_games
          WHERE id = ${parseInt(gameId, 10)}
          LIMIT 1
        `;
      } else if (gameType === "pool-masters") {
        lookupResult = await sql`
          SELECT player1_id, player2_id FROM pool_matches
          WHERE id = ${gameId}
          LIMIT 1
        `;
      }

      if (lookupResult.length > 0) {
        const game = lookupResult[0];
        // The reporter is the current user; the reported is the other player
        if (game.player1_id === userId) {
          resolvedReportedId = game.player2_id || "";
        } else if (game.player2_id === userId) {
          resolvedReportedId = game.player1_id || "";
        }
      }
    } catch {
      // If lookup fails, fall through to validation below
    }
  }

  // Validate required fields after resolution
  if (!resolvedReportedId || !gameType) {
    return NextResponse.json(
      { success: false, error: "Missing required fields: reportedClerkId, gameType" },
      { status: 400 },
    );
  }

  // Prevent self-reporting
  if (resolvedReportedId === userId) {
    return NextResponse.json(
      { success: false, error: "You cannot report yourself" },
      { status: 400 },
    );
  }

  try {
    const sql = getNeonSql();

    // Check for duplicate reports (same reporter, same reported, same game within 5 minutes)
    const recentReport = await sql`
      SELECT id FROM player_reports
      WHERE reporter_clerk_id = ${userId}
        AND reported_clerk_id = ${resolvedReportedId}
        AND game_type = ${gameType}
        AND game_id = ${gameId ?? null}
        AND created_at > NOW() - INTERVAL '5 minutes'
      LIMIT 1
    `;

    if (Array.isArray(recentReport) && recentReport.length > 0) {
      return NextResponse.json(
        { success: false, error: "You have already reported this player recently" },
        { status: 429 },
      );
    }

    await sql`
      INSERT INTO player_reports (reporter_clerk_id, reported_clerk_id, game_type, game_id, reason, details)
      VALUES (${userId}, ${resolvedReportedId}, ${gameType}, ${gameId ?? null}, ${reason}, ${details ?? null})
    `;

    return NextResponse.json({ success: true, message: "Report submitted successfully" });
  } catch (err: any) {
    console.error("[reports/submit] Failed:", err);
    return NextResponse.json(
      { success: false, error: "Failed to submit report" },
      { status: 500 },
    );
  }
}
