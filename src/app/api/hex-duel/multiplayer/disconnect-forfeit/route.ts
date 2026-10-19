import { NextResponse } from "next/server";
import { verifyToken } from "@clerk/backend";
import { and, desc, eq, isNull, or } from "drizzle-orm";
import { db } from "../../../../../db/client";
import { hexDuelGames } from "../../../../../db/schema";
import { logError } from "../../../../../lib/logError";
import { applyLeaderboardCounters } from "../../../../../lib/leaderboardCounters";
import { settleHexDuelMatch } from "../../../../../lib/hex-duel/settle";
import { hexDuelOpponentSeat, hexDuelSeatFor } from "../../../../../lib/hex-duel/authority";

export const dynamic = "force-dynamic";

/**
 * POST /api/hex-duel/multiplayer/disconnect-forfeit
 *
 * Internal endpoint called by the realtime server when a Hex Duel seat has
 * stayed disconnected past its grace window (tab closed, long network drop).
 * Resolves the match in the OPPONENT's favour with the shared pot
 * (winner takes 2 × stake × 90% out of the escrow both seats funded); a WAITING
 * lobby with an empty second seat is simply cancelled, which moves nothing.
 *
 * AUTHENTICATION: the Clerk session token the player authenticated their socket
 * with is re-verified here, so the forfeit is always attributed to the seat that
 * actually left — only that token's owner can be put on the losing side, and the
 * endpoint cannot be used to grief another player or to claim a win.
 *
 * Mirrors /api/memory-grid/disconnect-forfeit (and /api/keno-pvp/disconnect-forfeit):
 * idempotent — a finished match is left untouched, so a retried or stale timer
 * can never double-pay.
 */
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const gameId = Number(body?.gameId ?? body?.matchId);
    const token = typeof body?.token === "string" ? body.token : "";

    if (!Number.isFinite(gameId) || gameId <= 0 || !token) {
      return NextResponse.json(
        { success: false, error: "Missing gameId or token" },
        { status: 400 },
      );
    }

    const CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY;
    if (!CLERK_SECRET_KEY) {
      return NextResponse.json(
        { success: false, error: "Server authentication is not configured" },
        { status: 500 },
      );
    }
    let clerkUserId: string;
    try {
      const verified = await verifyToken(token, { secretKey: CLERK_SECRET_KEY });
      clerkUserId = verified.sub ?? "";
    } catch {
      return NextResponse.json({ success: false, error: "Invalid token" }, { status: 401 });
    }
    if (!clerkUserId) {
      return NextResponse.json({ success: false, error: "Invalid token" }, { status: 401 });
    }

    const settle = await db.transaction(async (tx) => {
      const participant = or(
        eq(hexDuelGames.player1Id, clerkUserId),
        eq(hexDuelGames.player2Id, clerkUserId),
      );
      const [game] = await tx
        .select()
        .from(hexDuelGames)
        .where(and(eq(hexDuelGames.id, gameId), participant))
        .orderBy(desc(hexDuelGames.createdAt))
        .for("update")
        .limit(1);

      if (!game) {
        // Definitive — no retry will help; stop the realtime retry loop.
        return { forfeited: false, cancelled: false, reason: "not_a_player" } as const;
      }

      const callerSlot = hexDuelSeatFor(game, clerkUserId);
      if (!callerSlot) {
        return { forfeited: false, cancelled: false, reason: "not_a_player" } as const;
      }

      // Already finalised — idempotent, nothing to do.
      if (game.status === "completed") {
        return { forfeited: false, cancelled: false, reason: "already_settled" } as const;
      }

      // A lobby whose second seat never arrived: cancel it. No escrow exists
      // for a waiting lobby, so this moves no coins.
      if (game.status === "waiting" && game.player2Id === null) {
        await tx
          .update(hexDuelGames)
          .set({ status: "cancelled", endedAt: new Date() })
          .where(and(eq(hexDuelGames.id, game.id), isNull(hexDuelGames.player2Id)));
        return { forfeited: false, cancelled: true, winner: null } as const;
      }

      // The disconnected seat loses; the seat still present takes the pot.
      const winnerSeat = hexDuelOpponentSeat(callerSlot);
      const { payout } = await settleHexDuelMatch({
        tx,
        game,
        winnerSeat,
        callerSeat: callerSlot,
      });

      return { forfeited: true, cancelled: false, winner: winnerSeat, payout } as const;
    });

    if (settle.forfeited) {
      applyLeaderboardCounters({
        clerkId: clerkUserId,
        game: "Hex Duel",
        outcome: "loss",
        isPvpWin: false,
      }).catch(() => {});
    }

    return NextResponse.json({ success: true, data: settle });
  } catch (err: any) {
    console.error("[hex-duel:disconnect-forfeit]", err?.message, err?.cause?.message);
    await logError({
      errorType: "hex_duel_forfeit_error",
      errorMessage: err?.message || "Hex Duel disconnect forfeit failed",
      stackTrace: err?.stack,
      endpoint: "/api/hex-duel/multiplayer/disconnect-forfeit",
      game: "Hex Duel",
      metadata: { operation: "disconnect_forfeit" },
    });
    return NextResponse.json({ success: false, error: "Server error" }, { status: 500 });
  }
}
