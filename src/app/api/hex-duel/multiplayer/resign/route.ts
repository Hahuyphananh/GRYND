import { auth } from "@clerk/nextjs/server";
import { requireAgeVerifiedUser } from "../../../../../lib/auth/requireAgeVerified";
import { and, desc, eq, isNull, or } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "../../../../../db/client";
import { hexDuelGames } from "../../../../../db/schema";
import { logError } from "../../../../../lib/logError";
import { applyLeaderboardCounters } from "../../../../../lib/leaderboardCounters";
import { settleHexDuelMatch } from "../../../../../lib/hex-duel/settle";
import { hexDuelSeatFor, hexDuelOpponentSeat } from "../../../../../lib/hex-duel/authority";

/**
 * POST /api/hex-duel/multiplayer/resign
 *
 * The LOSING SEAT concedes — and the only client-reported way a staked match can
 * end, which is what makes it safe: the authenticated caller can only ever put
 * ITSELF on the losing side, and the server derives the winner as the other
 * seat. A client cannot use this to name itself the winner, so no pot can be
 * claimed through it.
 *
 * Two cases:
 *   * the caller owns a WAITING lobby — the match is cancelled (nothing was
 *     escrowed; a lobby waiting for an opponent costs nothing), and
 *   * the caller is mid-match — the opponent wins, the pot is paid out of the
 *     escrow both seats funded, and the row is finalised exactly as
 *     `/multiplayer/end` would have finalised it.
 *
 * The clock-timeout path uses this same route (`reason: "timeout"`): whichever
 * seat's clock expired is the seat that reports it, i.e. it reports its own loss.
 */
export async function POST(req: Request) {
  let clerkId: string | null = null;
  try {
    const gate = await requireAgeVerifiedUser();
    if (gate.response) return gate.response;

    const { userId } = await auth();
    clerkId = userId ?? null;
    if (!clerkId) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }

    const body = (await req.json().catch(() => ({}))) as {
      gameId?: unknown;
      reason?: unknown;
    };
    const requestedGameId = Number(body.gameId);
    const gameId = Number.isFinite(requestedGameId) && requestedGameId > 0 ? requestedGameId : null;
    const reason =
      body.reason === "timeout" || body.reason === "disconnect" ? body.reason : "resign";

    const result = await db.transaction(async (tx) => {
      // The caller's live multiplayer match. The `player1Id`/`player2Id` seat
      // check below is the authorisation — a caller can only ever touch a match
      // it holds a seat in.
      const participant = or(
        eq(hexDuelGames.player1Id, clerkId as string),
        eq(hexDuelGames.player2Id, clerkId as string),
      );
      const [game] = await tx
        .select()
        .from(hexDuelGames)
        .where(gameId ? and(eq(hexDuelGames.id, gameId), participant) : participant)
        .orderBy(desc(hexDuelGames.createdAt))
        .for("update")
        .limit(1);

      if (!game) {
        throw Object.assign(new Error("No active game found"), { _httpStatus: 404 });
      }

      const callerSlot = hexDuelSeatFor(game, clerkId);
      if (!callerSlot) {
        throw Object.assign(new Error("No active game found"), { _httpStatus: 404 });
      }

      // Already settled (the winner's client got to /multiplayer/end first):
      // nothing to concede.
      if (game.status === "completed") {
        return {
          alreadySettled: true as const,
          winner: game.winner === "player1" || game.winner === "player2" ? game.winner : null,
          wager: Number(game.wagerAmount) || 0,
          payout: Number(game.payout || 0),
          newBalance: undefined as number | undefined,
        };
      }

      // 1. A lobby nobody joined yet: cancel it. No seat was funded, so this
      //    moves no coins — it only stops the lobby from being matched.
      if (game.status === "waiting" && game.player2Id === null) {
        if (callerSlot !== "player1") {
          throw Object.assign(new Error("Not your lobby"), { _httpStatus: 403 });
        }
        await tx
          .update(hexDuelGames)
          .set({ status: "cancelled", endedAt: new Date() })
          .where(and(eq(hexDuelGames.id, game.id), isNull(hexDuelGames.player2Id)));
        return {
          cancelled: true as const,
          alreadySettled: false as const,
          winner: null,
          wager: 0,
          payout: 0,
          newBalance: undefined as number | undefined,
        };
      }

      // 2. Mid-match: the caller concedes and the OTHER seat takes the pot.
      const winnerSeat = hexDuelOpponentSeat(callerSlot);
      const { payout } = await settleHexDuelMatch({
        tx,
        game,
        winnerSeat,
        callerSeat: callerSlot,
      });

      return {
        cancelled: false as const,
        alreadySettled: false as const,
        winner: winnerSeat,
        wager: Number(game.wagerAmount) || 0,
        payout,
        reason,
        newBalance: undefined as number | undefined,
      };
    });

    // Stats for the seat that conceded (the winner's own client gets its
    // counters in the settlement; this covers the loser even if the winner's
    // client never calls /multiplayer/end).
    if (!result.alreadySettled && !result.cancelled) {
      applyLeaderboardCounters({
        clerkId,
        game: "Hex Duel",
        outcome: "loss",
        isPvpWin: false,
      }).catch(() => {});
    }

    return NextResponse.json({ success: true, data: result });
  } catch (error: any) {
    const httpStatus: number =
      typeof error?._httpStatus === "number" ? error._httpStatus : 500;
    console.error("[hex-duel/multiplayer/resign] POST failed", {
      clerkId,
      err: error?.message,
      stack: error?.stack,
      causeMessage: error?.cause?.message,
    });
    if (httpStatus >= 500) {
      await logError({
        errorType: "hex_duel_resign_error",
        errorMessage: error?.message || "Hex Duel resign failed",
        stackTrace: error?.stack,
        endpoint: "/api/hex-duel/multiplayer/resign",
        game: "Hex Duel",
        metadata: { operation: "resign_match" },
      });
    }
    return NextResponse.json(
      {
        success: false,
        error: httpStatus >= 500 ? "Server error" : error?.message || "Unable to resign",
      },
      { status: httpStatus },
    );
  }
}
