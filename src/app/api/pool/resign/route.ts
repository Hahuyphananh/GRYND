import { NextResponse } from "next/server";
import { requirePracticePlayer } from "../../../../lib/auth/guestSession";
import { db } from "../../../../db/client";
import { eq } from "drizzle-orm";
import { poolMatches } from "../../../../db/schema";
import { applyLeaderboardCounters } from "../../../../lib/leaderboardCounters";
import { applyRatingResult } from "../../../../lib/rating";
import { applyTrophyResult } from "../../../../lib/trophyStore";
import { logError } from "../../../../lib/logError";
import { normalizeStake } from "../../../../lib/games/stakes";
import { PVP_RAKE_PCT } from "../../../../lib/games/economy";
import { payPvpPot } from "../../../../lib/tokens/pvpPot";
import { isGuestId } from "../../../../lib/guestIdentity";

export async function POST(req: Request) {
  try {
    // A guest may resign their own practice match (the seat check below is the
    // authorisation; AI matches award nothing, so no counter moves).
    const gate = await requirePracticePlayer();
    if (gate.response) return gate.response;
    const userId = gate.playerId;
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
    const wager = normalizeStake(match.wager ?? 0);
    // The pot, at the platform's shared rake: 2 × stake minus 10%
    // (`PVP_RAKE_PCT`). A free match carries stake 0 and moves nothing.
    const houseFee = Math.round(wager * 2 * PVP_RAKE_PCT);
    let payout = 0;

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
      // Update match status
      await tx
        .update(poolMatches)
        .set({
          status: "finished",
          winnerId: String(winnerId),
          gameState: updatedGameState,
          prizePaid: 0,
          houseFee,
          endedAt: new Date(),
        })
        .where(eq(poolMatches.id, String(matchId)));

      // Pay the winner out of the escrow both seats paid at join. The ledger
      // refuses a payout with no funding debit and refuses a second payout for
      // the same match, so a retried resign cannot mint or duplicate coins.
      if (!isAi && wager > 0 && winnerId && winnerId !== "AI") {
        payout = await payPvpPot({
          tx,
          gameKey: "pool",
          matchId,
          winnerClerkId: String(winnerId),
          stake: wager,
        });
        if (payout > 0) {
          await tx
            .update(poolMatches)
            .set({ prizePaid: Math.round(payout) })
            .where(eq(poolMatches.id, String(matchId)));
        }
      }
    });

    // Track leaderboard stats for both players. A guest seat never moves a
    // counter (guests are practice-only by construction, and this keeps a
    // guest id out of the rating/trophy ledgers even if one ever got here).
    const loserId = isPlayer1 ? match.player1Id : match.player2Id;
    const guestSeat = isGuestId(loserId) || isGuestId(winnerId);
    if (!isAi && !guestSeat && loserId) {
      applyLeaderboardCounters({
        clerkId: loserId,
        game: "Pool",
        outcome: "loss",
      }).catch(() => {});
    }
    if (!isAi && !guestSeat && winnerId) {
      applyLeaderboardCounters({
        clerkId: winnerId,
        game: "Pool",
        outcome: "win",
        isPvpWin: true,
      }).catch(() => {});
    }

    // Per-game Elo — a resign forfeit: the remaining player wins. Both seats
    // come from the canonical match row and the winner is derived server-side
    // (winnerId above), so a resigning client can only ever give away rating.
    if (!isAi && !guestSeat && winnerId && loserId) {
      applyRatingResult({
        gameKey: "pool",
        matchId: String(matchId),
        winnerClerkId: String(winnerId),
        loserClerkId: String(loserId),
      }).catch(() => {});
      // Per-game trophies — the same authoritative forfeit (+30 / −30).
      applyTrophyResult({
        gameKey: "pool",
        matchId: String(matchId),
        winnerClerkId: String(winnerId),
        loserClerkId: String(loserId),
      }).catch(() => {});
    }

    return NextResponse.json({ success: true });
  } catch (e: any) {
    console.error("Pool resign error:", e);
    await logError({
      errorType: "pool_resignation_error",
      errorMessage: e instanceof Error ? e.message : "Pool resignation failed",
      stackTrace: e instanceof Error ? e.stack : undefined,
      endpoint: "/api/pool/resign",
      game: "Pool",
      metadata: { operation: "resign_match" },
    });
    return NextResponse.json(
      { success: false, error: e?.message || "Server error" },
      { status: 500 },
    );
  }
}
