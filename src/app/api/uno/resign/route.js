import { requirePracticePlayer } from "../../../../lib/auth/guestSession";
import { db } from "../../../../db/client";
import { unoGames, users } from "../../../../db/schema";
import { and, eq, or, inArray } from "drizzle-orm";
import { isUnoSeat, unoCallerToken } from "../../../../lib/unoSeat";


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

        //  End game — STAKES ARE RETIRED: no pot to pay out on a resignation.
        await tx
          .update(unoGames)
          .set({
            status: "finished",
            winner: lockedGame.userId === requestingUser.id ? "player2" : "player1",
            result: "loss",
            payout: "0",
          })
          .where(eq(unoGames.id, gameId));

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
