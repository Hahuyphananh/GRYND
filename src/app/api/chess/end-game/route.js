import { auth, currentUser } from "@clerk/nextjs/server";
import { requireAgeVerifiedUser } from "../../../../lib/auth/requireAgeVerified";
import { db } from "../../../../db/client";
import { chessGames, users } from "../../../../db/schema";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { applyLeaderboardCounters } from "../../../../lib/leaderboardCounters";
import { applyRatingResult } from "../../../../lib/rating";
import { applyTrophyResult } from "../../../../lib/trophyStore";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Harmonized to the shared 5% PvP rake (must match PVP_RAKE_PCT in
// src/lib/games/economy.ts). Winner keeps 95% of the pot.
const HOUSE_EDGE_PERCENT = 5;

// Ends any open game for this user.
// Optional body: { gameId?: string (uuid), result?: "win" | "loss" | "draw" }
export async function POST(req) {
  try {
    const gate = await requireAgeVerifiedUser();
    if (gate.response) return gate.response;

    const { userId } = await auth();
    if (!userId) return new Response("Unauthorized", { status: 401 });

    let body = {};
    try {
      body = await req.json();
    } catch {
      body = {};
    }

    const requestedGameId =
      body?.gameId != null ? String(body.gameId).trim() : "";
    const hasRequestedGameId = UUID_RE.test(requestedGameId);
    const normalizedResult =
      typeof body?.result === "string" ? body.result.toLowerCase() : null;
    const allowedResult = ["win", "loss", "draw"].includes(normalizedResult)
      ? normalizedResult
      : null;

    const whereBase = and(
      or(
        eq(chessGames.playerWhiteId, userId),
        eq(chessGames.playerBlackId, userId),
      ),
      inArray(chessGames.status, ["waiting", "active", "in_progress"]),
    );

    const openGame = hasRequestedGameId
      ? await db
          .select()
          .from(chessGames)
          .where(and(whereBase, eq(chessGames.id, requestedGameId)))
          .limit(1)
      : await db.select().from(chessGames).where(whereBase).limit(1);

    if (openGame.length === 0) {
      return new Response("No active game found", { status: 200 });
    }

    const game = openGame[0];
    const gameId = game.id;

    await db.transaction(async (tx) => {
      const [lockedGame] = await tx
        .select()
        .from(chessGames)
        .where(eq(chessGames.id, gameId))
        .for("update");
      if (!lockedGame) return;

      if (lockedGame.isAiGame) {
        await tx
          .update(chessGames)
          .set({ status: "expired", endedAt: new Date() })
          .where(eq(chessGames.id, gameId));
        return;
      }

      if (lockedGame.status === "waiting") {
        await tx
          .update(users)
          .set({ balance: sql`${users.balance} + ${lockedGame.betAmount}` })
          .where(eq(users.clerkId, userId));

        await tx
          .update(chessGames)
          .set({
            status: "expired",
            result: allowedResult || "cancelled",
            endedAt: new Date(),
          })
          .where(eq(chessGames.id, gameId));
        return;
      }

      if (lockedGame.status === "in_progress") {
        const opponentId =
          lockedGame.playerWhiteId === userId
            ? lockedGame.playerBlackId
            : lockedGame.playerWhiteId;
        if (!opponentId) {
          await tx
            .update(chessGames)
            .set({ status: "expired", endedAt: new Date() })
            .where(eq(chessGames.id, gameId));
          return;
        }

        const pot = Number(lockedGame.betAmount) * 2;
        const houseFee = Number(((pot * HOUSE_EDGE_PERCENT) / 100).toFixed(2));
        const winnerPayout = Number((pot - houseFee).toFixed(2));

        await tx
          .update(users)
          .set({ balance: sql`${users.balance} + ${winnerPayout}` })
          .where(eq(users.clerkId, opponentId));

        await tx
          .update(chessGames)
          .set({
            status: "finished",
            winnerId: opponentId,
            result: "opponent_left",
            payout: winnerPayout.toString(),
            endedAt: new Date(),
          })
          .where(eq(chessGames.id, gameId));

        // Record leaderboard stats for both players (outside tx to avoid blocking)
        applyLeaderboardCounters({
          clerkId: opponentId,
          game: "Chess",
          betAmount: Number(lockedGame.betAmount),
          payout: winnerPayout,
          isPvpWin: true,
        }).catch(() => {});
        applyLeaderboardCounters({
          clerkId: userId,
          game: "Chess",
          betAmount: Number(lockedGame.betAmount),
          payout: 0,
        }).catch(() => {});

        // Per-game Elo — a competitive forfeit. The winner is the player who
        // STAYED (derived server-side above from the game's seat columns and
        // the caller's identity), so a caller can never award themselves the
        // win by calling this route. AI games are excluded above.
        applyRatingResult({
          gameKey: "chess",
          matchId: String(gameId),
          winnerClerkId: opponentId,
          loserClerkId: userId,
        }).catch(() => {});

        // Per-game trophies — the same authoritative forfeit (+30 / −30),
        // clamped to [0, 10000] and idempotent on the match id.
        applyTrophyResult({
          gameKey: "chess",
          matchId: String(gameId),
          winnerClerkId: opponentId,
          loserClerkId: userId,
        }).catch(() => {});

        // Record big win if winnerPayout >= 1 million tokens
        return;
      }

      await tx
        .update(chessGames)
        .set({
          status: "expired",
          ...(allowedResult ? { result: allowedResult } : {}),
          endedAt: new Date(),
        })
        .where(eq(chessGames.id, gameId));
    });

    return new Response("Game ended", { status: 200 });
  } catch (err) {
    console.error("End-game error:", err);
    return new Response("Server error", { status: 500 });
  }
}
