import { requirePracticePlayer } from "../../../../lib/auth/guestSession";
import { db } from "../../../../db/client";
import { unoGames, users } from "../../../../db/schema";
import { and, eq, or, inArray } from "drizzle-orm";
import { isUnoSeat, unoCallerToken } from "../../../../lib/unoSeat";
import { payPvpPot } from "../../../../lib/tokens/pvpPot";


export async function POST(req) {
  try {
    const gate = await requirePracticePlayer();
    if (gate.response) return gate.response;

    const body = await req.json();
    const gameId = Number(body?.gameId);

    if (!gameId) {
      return new Response("Invalid gameId", { status: 400 });
    }

    // The account row exists only for a signed-in caller; a guest's seat
    // token is its guest id.
    let requestingUser = null;
    if (!gate.isGuest) {
      [requestingUser] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.clerkId, gate.playerId))
        .limit(1);

      if (!requestingUser) {
        return new Response("User not found", { status: 404 });
      }
    }

    //  Find the game
    const [game] = await db.select().from(unoGames).where(eq(unoGames.id, gameId)).limit(1);

    if (!game) {
      return new Response("Game not found", { status: 404 });
    }

    //  Seat check: the practice owner (the only seat a guest can hold) OR an
    //  online participant may resign. A guest is never an online participant.
    const callerToken = unoCallerToken(
      gate.isGuest,
      gate.playerId,
      requestingUser?.id ?? null,
    );
    const isOwner = isUnoSeat(game, callerToken);
    const isPlayer2 =
      game.player2Id !== null && game.player2Id === requestingUser?.id;
    if (!isOwner && !isPlayer2) {
      return new Response("Forbidden", { status: 403 });
    }

    await db.transaction(async (tx) => {
      const [lockedGame] = await tx
        .select()
        .from(unoGames)
        .where(eq(unoGames.id, gameId))
        .for("update");

      if (!lockedGame) return;

      //  Determine game type
      const isAiGame = !lockedGame.player2Id;
      const isWaiting = lockedGame.status === "waiting";
      const isActive = lockedGame.status === "active";

      // =========================
      //  WAITING GAME → CANCEL
      // =========================
      if (isWaiting) {
        // A waiting game was never escrowed (the host's stake is only taken
        // when an opponent fills the seat), so cancelling it moves no coins.
        await tx
          .update(unoGames)
          .set({
            status: "finished",
            result: "cancelled",
          })
          .where(eq(unoGames.id, gameId));

        return;
      }

      // =========================
      //  AI GAME → AI WINS
      // =========================
      if (isAiGame && isActive) {
        await tx
          .update(unoGames)
          .set({
            status: "finished",
            winner: "ai",
            result: "loss",
            payout: "0",
          })
          .where(eq(unoGames.id, gameId));

        return;
      }

      // =========================
      //  ONLINE GAME → OPPONENT WINS
      // =========================
      if (!isAiGame && isActive) {
        const opponentId =
          lockedGame.userId === requestingUser.id ? lockedGame.player2Id : lockedGame.userId;

        if (!opponentId) return;

        const winner = lockedGame.userId === requestingUser.id ? "player2" : "player1";

        // The resigner forfeits their stake: the opponent banks the pot out of
        // the escrow both seats funded at join. The winner's Clerk id is
        // resolved from the row (never from the request), and the payout runs
        // in the same transaction as the terminal write so the coins commit
        // with the result.
        const [opponent] = await tx
          .select({ clerkId: users.clerkId })
          .from(users)
          .where(eq(users.id, opponentId))
          .limit(1);

        await tx
          .update(unoGames)
          .set({
            status: "finished",
            winner,
            result: "loss",
            payout: "0.00",
          })
          .where(eq(unoGames.id, gameId));

        const payout = await payPvpPot({
          tx,
          gameKey: "uno",
          matchId: gameId,
          winnerClerkId: opponent?.clerkId,
          stake: Number(lockedGame.betAmount) || 0,
        });
        if (payout > 0) {
          await tx
            .update(unoGames)
            .set({ payout: payout.toFixed(2) })
            .where(eq(unoGames.id, gameId));
        }

        return;
      }

      // fallback
      await tx
        .update(unoGames)
        .set({
          status: "finished",
        })
        .where(eq(unoGames.id, gameId));
    });

    return Response.json({ success: true });
  } catch (err) {
    console.error("UNO resign error:", err);
    return new Response("Server error", { status: 500 });
  }
}
