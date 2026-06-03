import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db";
import { eq, sql } from "drizzle-orm";
import { poolMatches, users } from "../../../../db/schema";
import { applyLeaderboardCounters } from "../../../../lib/leaderboardCounters";

export async function POST(req: Request) {
  try {
    const { userId } = await auth();
    if (!userId)
      return NextResponse.json(
        { success: false, error: "Unauthorized" },
        { status: 401 },
      );

    const { matchId } = await req.json();
    if (!matchId)
      return NextResponse.json(
        { success: false, error: "bad_request" },
        { status: 400 },
      );

    const [match] = await db
      .select()
      .from(poolMatches)
      .where(eq(poolMatches.id, String(matchId)))
      .limit(1);

    if (!match) {
      return NextResponse.json(
        { success: false, error: "match_not_found" },
        { status: 404 },
      );
    }

    // Already finished
    if (match.status === "finished") {
      return NextResponse.json({ success: true, skipped: true });
    }

    // Determine the resigning player and the winner
    const isPlayer1 = match.player1Id === userId;
    const isPlayer2 = match.player2Id === userId;
    const isAi = match.player2Id === "AI";

    if (!isPlayer1 && !isPlayer2) {
      return NextResponse.json(
        { success: false, error: "not_a_player" },
        { status: 403 },
      );
    }

    // In AI mode, opponent "AI" automatically wins
    // In PvP mode, the other player wins
    const winnerId = isAi
      ? "AI"
      : isPlayer1
        ? match.player2Id
        : match.player1Id;

    const winnerSeat = isPlayer1 ? 2 : 1;
    const wager = Number(match.wager ?? 0);
    // Guard: if wager is invalid, abort gracefully
    if (!wager || wager <= 0 || !Number.isFinite(wager)) {
      return NextResponse.json(
        { success: false, error: "Invalid wager on match" },
        { status: 400 },
      );
    }
    const houseFee = Math.floor(wager * 2 * 0.02); // 2% house edge
    const payout = isAi ? 0 : wager * 2 - houseFee;

    // Update the match
    const gameState = (match.gameState as Record<string, unknown>) || {};
    const updatedGameState = {
      ...gameState,
      winner: winnerSeat,
      resigned: true,
      resignedBy: userId,
      version: Date.now(),
    };

    await db.transaction(async (tx) => {
      // Pay the winner (unless it's AI)
      if (!isAi && winnerId) {
        await tx
          .update(users)
          .set({ balance: sql`${users.balance} + ${payout}` })
          .where(eq(users.clerkId, String(winnerId)));
      }

      // Update match status
      await tx
        .update(poolMatches)
        .set({
          status: "finished",
          winnerId: String(winnerId),
          gameState: updatedGameState,
          prizePaid: payout,
          houseFee,
          endedAt: new Date(),
        })
        .where(eq(poolMatches.id, String(matchId)));
    });

    // Track leaderboard stats for both players
    const loserId = isPlayer1 ? match.player1Id : match.player2Id;
    if (!isAi && loserId) {
      applyLeaderboardCounters({
        clerkId: loserId,
        game: "Pool",
        betAmount: wager,
        payout: 0,
      }).catch(() => {});
    }
    if (!isAi && winnerId) {
      const isPvp = !isAi;
      applyLeaderboardCounters({
        clerkId: winnerId,
        game: "Pool",
        betAmount: wager,
        payout,
        isPvpWin: isPvp,
      }).catch(() => {});
    }

    return NextResponse.json({ success: true });
  } catch (e: any) {
    console.error("Pool resign error:", e);
    return NextResponse.json(
      { success: false, error: e?.message || "Server error" },
      { status: 500 },
    );
  }
}
