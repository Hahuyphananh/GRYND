import { NextResponse } from "next/server";
import { requireAgeVerifiedUser } from "../../../../lib/auth/requireAgeVerified";
import { db } from "../../../../db/client";
import { chessGames, users } from "../../../../db/schema";
import { and, eq, isNull } from "drizzle-orm";
import { escrowMatchWagers } from "../../../../lib/tokens/wager";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function getUserAliases(clerkId) {
  const aliases = new Set([String(clerkId)]);
  const [userRow] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.clerkId, clerkId))
    .limit(1);
  if (userRow?.id) aliases.add(String(userRow.id));
  return aliases;
}

export async function POST(req) {
  const gate = await requireAgeVerifiedUser();
  if (gate.response) return gate.response;
  const userId = gate.userId;

  const { gameId } = await req.json();
  const parsedGameId = String(gameId ?? "").trim();

  if (!UUID_RE.test(parsedGameId)) {
    return NextResponse.json(
      { success: false, error: "Invalid gameId" },
      { status: 400 },
    );
  }

  try {
    const userAliases = await getUserAliases(userId);

    const result = await db.transaction(async (tx) => {
      const [game] = await tx
        .select()
        .from(chessGames)
        .where(
          and(
            eq(chessGames.id, parsedGameId),
            eq(chessGames.status, "waiting"),
            isNull(chessGames.playerBlackId),
            eq(chessGames.isAiGame, false),
          ),
        )
        .for("update");

      if (!game) {
        throw new Error("Game is no longer available");
      }
      if (userAliases.has(String(game.playerWhiteId))) {
        throw new Error("You cannot join your own game");
      }

      // Escrow BOTH stakes before the seat fills: a staked table either funds
      // fully or the join is refused and the transaction rolls back, so an
      // `in_progress` game is always backed by two stakes and the winner's
      // payout is always funded. The host is identified by the row's own seat
      // column, never by the request.
      const escrow = await escrowMatchWagers({
        clerkIds: [game.playerWhiteId, userId],
        stake: Number(game.betAmount) || 0,
        matchId: parsedGameId,
        gameKey: "chess",
        tx,
      });
      if (!escrow.ok) {
        throw Object.assign(
          new Error(escrow.error || "Insufficient coins"),
          { status: 400 },
        );
      }

      // The JOINER takes White. Chess still opens with White, but the product
      // rule for every seat-based PvP game is that the joining seat moves
      // first (Barrier Blitz's purple-first rule). Swapping the two seat
      // columns at the moment the table fills is enough: every reader
      // (game-state, move, settlement, clocks) derives colour from these
      // columns, so no extra "opening seat" column is needed.
      const [updatedGame] = await tx
        .update(chessGames)
        .set({
          playerWhiteId: userId,
          playerBlackId: game.playerWhiteId,
          status: "in_progress",
          startedAt: new Date(),
        })
        .where(
          and(
            eq(chessGames.id, parsedGameId),
            isNull(chessGames.playerBlackId),
          ),
        )
        .returning({
          id: chessGames.id,
          playerWhiteId: chessGames.playerWhiteId,
          playerBlackId: chessGames.playerBlackId,
        });

      if (!updatedGame) {
        throw new Error("Game is no longer available");
      }

      return {
        gameId: updatedGame.id,
        playerWhiteId: updatedGame.playerWhiteId,
        playerBlackId: updatedGame.playerBlackId,
      };
    });

    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    console.error("chess join-game failed", {
      gameId: parsedGameId,
      requester: userId,
      message: error?.message,
      stack: error?.stack,
    });
    return NextResponse.json(
      { success: false, error: error.message || "Failed to join game" },
      { status: 400 },
    );
  }
}
