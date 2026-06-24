import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../../db/client";
import { coinFlipGames, users } from "../../../../../db/schema";
import { eq, sql } from "drizzle-orm";
import crypto from "crypto";

/**
 * Resolve a single round WITHOUT finalising the match. When both players
 * have chosen (or the choice deadline has passed and any missing choices
 * have been forced), this rolls the per-round outcome, increments the
 * winning seat's score on `coin_flip_games.score_player1/_player2`, and
 *
 *   • if either seat just hit `target_wins` → mark status='finished',
 *     set winnerId / outcome / result, and credit the winner's balance
 *     (minus the 2% house rake) — same payout math as before.
 *   • otherwise → clear player1Choice / player2Choice / outcome /
 *     result / winnerId for the next round, leave status='matched' so
 *     the next choice phase resumes immediately. New choiceDeadline is
 *     reset to now + 10s (matches the join-route cadence).
 *
 * The "round winner" is always written onto the row via the `winnerId`
 * column even mid-match so the client can render "Round N won by ..."
 * in the scoreboard between rounds. A separate `last_round_winner`
 * column mirrors that bit for the API response without leaking any
 * per-round state we plan to drop later — we persist via winnerId
 * itself here (per-round winner) and clean it up if the round is being
 * reset for another round.
 */
async function resolveGameIfReady(game) {
  if (game.status !== "matched") return game;

  const now = Date.now();
  const deadline = game.choiceDeadline
    ? new Date(game.choiceDeadline).getTime()
    : null;
  const bothChosen = Boolean(game.player1Choice && game.player2Choice);

  // Force a missing choice when the timer has expired, mirroring the
  // pre-best-of-3 behaviour. Forced choice = opposite of the side that
  // DID pick, so a non-responder always "loses" the round.
  if (!bothChosen && deadline && now >= deadline) {
    const forced = await db.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(coinFlipGames)
        .where(eq(coinFlipGames.id, game.id))
        .for("update");

      if (!locked || locked.status !== "matched") return locked || game;

      let player1Choice = locked.player1Choice;
      let player2Choice = locked.player2Choice;

      if (player1Choice && !player2Choice) {
        player2Choice = player1Choice === "heads" ? "tails" : "heads";
      }
      if (player2Choice && !player1Choice) {
        player1Choice = player2Choice === "heads" ? "tails" : "heads";
      }

      const [updated] = await tx
        .update(coinFlipGames)
        .set({ player1Choice, player2Choice })
        .where(eq(coinFlipGames.id, game.id))
        .returning();

      return updated;
    });
    // Re-fetch through the main flow so the round actually resolves.
    return resolveGameIfReady(forced);
  }

  if (!bothChosen) return game;

  // Both players have a (real or forced) choice — resolve the round.
  return db.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(coinFlipGames)
      .where(eq(coinFlipGames.id, game.id))
      .for("update");

    if (!locked || locked.status !== "matched") return locked || game;
    if (!(locked.player1Choice && locked.player2Choice)) return locked;

    const outcome = crypto.randomInt(0, 2) === 0 ? "heads" : "tails";
    const roundWinnerId =
      outcome === locked.player1Choice ? locked.player1Id : locked.player2Id;

    const isPlayer1Winner = roundWinnerId === locked.player1Id;
    const nextScore1 = locked.scorePlayer1 + (isPlayer1Winner ? 1 : 0);
    const nextScore2 = locked.scorePlayer2 + (isPlayer1Winner ? 0 : 1);
    const targetWins = locked.targetWins ?? 2;
    const matchFinished =
      nextScore1 >= targetWins || nextScore2 >= targetWins;
    const matchWinnerId = matchFinished ? roundWinnerId : null;

    if (matchFinished) {
      // Match is over: credit the winner (2% rake unchanged), persist
      // outcome / result / winnerId so the client can render the final
      // screen. Per-round scoreboard lives on the row permanently.
      const totalPot = Number(locked.betAmount) * 2;
      const houseFee = Math.floor(totalPot * 0.02);
      const payout = totalPot - houseFee;

      await tx
        .update(users)
        .set({ balance: sql`${users.balance} + ${payout}` })
        .where(eq(users.clerkId, matchWinnerId));

      const [finished] = await tx
        .update(coinFlipGames)
        .set({
          outcome,
          winnerId: matchWinnerId,
          result: matchWinnerId === locked.player1Id ? "player1" : "player2",
          scorePlayer1: nextScore1,
          scorePlayer2: nextScore2,
          status: "finished",
        })
        .where(eq(coinFlipGames.id, game.id))
        .returning();

      return finished;
    }

    // Round decided, match continues — clear per-round columns so the
    // next choice submission passes the "no own choice yet" guard,
    // restart the ~10s choice window, and stamp the per-round winner
    // bit onto `winnerId` (transiently) so the API can surface it via
    // `last_round_winner` until the next choice is submitted.
    const [updated] = await tx
      .update(coinFlipGames)
      .set({
        player1Choice: null,
        player2Choice: null,
        outcome: null,
        result: "pending",
        winnerId: roundWinnerId,
        scorePlayer1: nextScore1,
        scorePlayer2: nextScore2,
        // status stays 'matched' — the next round begins immediately.
        choiceDeadline: new Date(Date.now() + 10_000),
      })
      .where(eq(coinFlipGames.id, game.id))
      .returning();

    return updated;
  });
}

export async function GET(req) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const gameId = Number(searchParams.get("gameId"));

  if (!Number.isFinite(gameId)) {
    return NextResponse.json({ error: "Invalid gameId" }, { status: 400 });
  }

  let game = await db.query.coinFlipGames.findFirst({
    where: eq(coinFlipGames.id, gameId),
  });

  if (!game) {
    return NextResponse.json({ error: "Game not found" }, { status: 404 });
  }

  if (game.player1Id !== userId && game.player2Id !== userId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  game = await resolveGameIfReady(game);

  // `game.winnerId` holds the per-round winner between rounds (before
  // the next choice clears it) and the match winner once status flips
  // to finished. Project it consistently here so the client can render
  // a single "who just won?" hint keyed off the current status.
  let lastRoundWinner = null;
  if (game.status === "matched" && game.winnerId) {
    lastRoundWinner =
      game.winnerId === game.player1Id ? "player1" : "player2";
  }

  return NextResponse.json({
    success: true,
    data: {
      status: game.status,
      player1Id: game.player1Id,
      player2Id: game.player2Id,
      player1Choice: game.player1Choice,
      player2Choice: game.player2Choice,
      choiceDeadline: game.choiceDeadline,
      outcome: game.outcome,
      // Match-level fields below this line power the best-of-3 scoreboard.
      winner:
        game.status === "finished"
          ? game.winnerId === userId
            ? "you"
            : "opponent"
          : null,
      result: game.result,
      targetWins: game.targetWins ?? 2,
      scorePlayer1: game.scorePlayer1 ?? 0,
      scorePlayer2: game.scorePlayer2 ?? 0,
      totalRounds: (game.scorePlayer1 ?? 0) + (game.scorePlayer2 ?? 0),
      lastRoundWinner,
    },
  });
}
