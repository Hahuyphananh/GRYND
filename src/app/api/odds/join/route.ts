import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { requireAgeVerifiedUser } from "../../../../lib/auth/requireAgeVerified";
import { db } from "../../../../db/client";
import { oddsGames } from "../../../../db/schema";
import { eq, and, isNull } from "drizzle-orm";
import { initPvPOddsGame } from "../../../../lib/odds";
import { escrowMatchWagers } from "../../../../lib/tokens/wager";
import { normalizeStake } from "../../../../lib/games/stakes";

export async function POST(req: Request) {
  try {
    const gate = await requireAgeVerifiedUser();
    if (gate.response) return gate.response;

    const { userId } = await auth();
    if (!userId)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!process.env.DATABASE_URL) {
      return NextResponse.json(
        { success: false, error: "Database not available" },
        { status: 503 },
      );
    }


    const body = await req.json();
    const gameId = Number(body.gameId);
    // The stake the joiner agreed to when they picked this lobby. A request
    // that names a different one is refused instead of being escrowed at an
    // amount the player never chose (the lobby list is public and may be
    // stale). A request that names none is still held to the lobby's stake.
    const claimedStake =
      body?.wager === undefined || body?.wager === null || body?.wager === ""
        ? null
        : normalizeStake(body.wager, "odds");

    if (!Number.isFinite(gameId) || gameId <= 0) {
      return NextResponse.json({ error: "Invalid game ID" }, { status: 400 });
    }

    const result = await db.transaction(async (tx: any) => {
      const [game] = await tx
        .select()
        .from(oddsGames)
        .where(
          and(
            eq(oddsGames.id, gameId),
            eq(oddsGames.status, "waiting"),
            isNull(oddsGames.player2Id),
          )
        )
        .for("update");

      if (!game) throw new Error("Game not found or already joined");
      if (game.player1Id === userId) throw new Error("Cannot join your own game");
      if (claimedStake !== null && claimedStake !== Number(game.wager)) {
        throw Object.assign(
          new Error("This game is no longer open at that stake"),
          { status: 400 },
        );
      }

      // Escrow BOTH stakes before the seat is filled: a staked match either
      // funds fully or the join is refused, so a `playing` game is always
      // backed by two stakes (and the winner's payout is always funded). A
      // free match (wager 0) moves nothing. Thrown with `status: 400` so the
      // caller sees the reason — never a 500.
      // Annotated rather than inferred: `strict` is off in this project, where
      // a discriminated union is not narrowed by `if (!x.ok)`.
      const escrow: { ok: boolean; error?: string; status?: number } =
        await escrowMatchWagers({
          clerkIds: [game.player1Id, userId],
          stake: game.wager,
          matchId: gameId,
          gameKey: "odds-pvp",
          tx,
        });
      if (!escrow.ok) {
        throw Object.assign(
          new Error(escrow.error || "Insufficient coins"),
          { status: 400 },
        );
      }

      // Initialize interactive PvP game state
      const gameState = initPvPOddsGame();

      // Update the game — status "playing", game is now interactive
      const [updated] = await tx
        .update(oddsGames)
        .set({
          player2Id: userId,
          status: "playing",
          gameState,
        })
        .where(eq(oddsGames.id, gameId))
        .returning();

      return { updated, gameState };
    });

    return NextResponse.json({
      success: true,
      data: {
        gameId: result.updated.id,
        wager: result.updated.wager,
        player1Id: result.updated.player1Id,
        gameState: result.gameState,
        winner: result.gameState.winner,
        result: result.updated.result,
        payout: result.updated.payout,
      },
    });
  } catch (error: any) {
    // A store-level failure (game taken, own game, insufficient coins) is a
    // user-level error and must answer 4xx with its reason; only a genuinely
    // unexpected failure stays a 500.
    const status = error?.status === 400 ? 400 : 500;
    return NextResponse.json(
      { success: false, error: error.message || "Failed to join game" },
      { status }
    );
  }
}
