//get-bet-history/route.ts
import { NextResponse } from "next/server";
import { db } from "../../../db";
import { eq, or } from "drizzle-orm";
import {
  users,
  rouletteGames,
  blackjackGames,
  minesGames,
  plinkoGames,
  rpsGames,
  crashGames,
  sportsBets,
  unoGames,
  chessGames,
  slotGames,
  coinFlipGames,
  keno_games,
  tankStats,
  connectFourGames,
} from "../../../db/schema";
import { auth } from "@clerk/nextjs/server";

export async function GET() {
  try {
    const { userId } = await auth();
    if (!userId)
      return NextResponse.json({ success: false, error: "Not authenticated" }, { status: 401 });

    // Fetch the internal user record
    const dbUser = await db.query.users.findFirst({
      where: eq(users.clerkId, userId),
    });
    if (!dbUser)
      return NextResponse.json({ success: false, error: "User not found" }, { status: 404 });

    const uid = dbUser.id; 
    const clerkId = userId;

    // Fetch all game histories
    const [
      roulette,
      blackjack,
      mines,
      plinko,
      crash,
      rps,
      uno,
      chess,
      sports,
      slots,
      coinflipRows,
      kenoRows,
      tankRows, // <-- NEW
      connectFourRows
    ] = await Promise.all([
      db.select().from(rouletteGames).where(eq(rouletteGames.userId, uid)),
      db.select().from(blackjackGames).where(eq(blackjackGames.userId, uid)),
      db.select().from(minesGames).where(eq(minesGames.userId, uid)),
      db.select().from(plinkoGames).where(eq(plinkoGames.userId, userId)),
      db.select().from(crashGames).where(eq(crashGames.userId, uid)),
      db.select().from(rpsGames).where(eq(rpsGames.userId, clerkId)),
      db.select().from(unoGames).where(eq(unoGames.userId, uid)),
      db
        .select()
        .from(chessGames)
        .where(or(eq(chessGames.playerWhiteId, clerkId), eq(chessGames.playerBlackId, clerkId))),
      db.select().from(sportsBets).where(eq(sportsBets.userId, uid)),
      db.select().from(slotGames).where(eq(slotGames.userId, userId)),
      db.select().from(coinFlipGames).where(or(eq(coinFlipGames.player1Id, clerkId), eq(coinFlipGames.player2Id, clerkId))),
      db.select().from(keno_games).where(eq(keno_games.user_id, uid)),
      db.select().from(tankStats).where(eq(tankStats.clerkId, clerkId)), // NEW
      db.select().from(connectFourGames).where(
  or(
    eq(connectFourGames.hostClerkId, clerkId),
    eq(connectFourGames.guestClerkId, clerkId)
  )
),
    ]);

    // Generic formatter (unchanged)
    const formatBet = (type, bet) => {
      let result = "pending";

      const r = bet.result?.toLowerCase?.();
      const s = bet.status?.toLowerCase?.();
      const o = bet.outcome?.toLowerCase?.();

      if (r === "win" || r === "won") result = "won";
      else if (r === "loss" || r === "lost") result = "lost";
      else if (s === "win" || s === "won") result = "won";
      else if (s === "loss" || s === "lost") result = "lost";
      else if (o === "win" || o === "won") result = "won";
      else if (o === "loss" || o === "lost") result = "lost";
      else if (typeof bet.didWin === "boolean") result = bet.didWin ? "won" : "lost";
      else if (typeof bet.win === "boolean") result = bet.win ? "won" : "lost";
      else if (!isNaN(Number(bet.payout))) {
        const payoutNum = Number(bet.payout);
        if (payoutNum > 0) result = "won";
        else if (payoutNum === 0) result = "lost";
      }

      if (type.includes("Rock Paper Scissors")) {
        const lowerResult = bet.result?.toLowerCase?.() || bet.outcome?.toLowerCase?.() || "";
        if (lowerResult.includes("tie") || lowerResult.includes("draw")) {
          result = "tie";
        }
      }

      const amount = Number(bet.betAmount || bet.bet_amount || bet.amount || 0);
      const payout = Number(bet.payout ?? 0);

      let tokenDiff;
      if (type.includes("Plinko") || type.includes("Slots")) {
        tokenDiff = payout - amount;
      } else if (type.includes("Rock Paper Scissors") && result === "tie") {
        tokenDiff = 0;
      } else {
        tokenDiff =
          result === "won" ? payout - amount :
          result === "lost" ? -amount : 0;
      }

      return {
        type,
        date: bet.createdAt || bet.placedAt || bet.created_at || new Date().toISOString(),
        amount,
        payout,
        result,
        tokenDiff,
      };
    };

    // CoinFlip mapping (unchanged)
    const coinflipFormatted = coinflipRows.map((bet) => {
      const amount = Number(bet.betAmount ?? 0);

      let result = bet.result?.toLowerCase?.() ?? "pending";
      if (!bet.result) {
        if (bet.winnerId) {
          result = bet.winnerId === clerkId ? "won" : "lost";
        } else if (bet.outcome) {
          const playerChoice = bet.player1Id === clerkId ? bet.player1Choice : null;
          if (playerChoice) {
            result = bet.outcome.toLowerCase() === playerChoice.toLowerCase() ? "won" : "lost";
          }
        }
      }

      const mult = 1.98;
      const payout = result === "won" ? Number((amount * mult).toFixed(2)) : 0;
      const tokenDiff = result === "won" ? payout - amount : -amount;

      return {
        type: "💰 Coinflip",
        date: bet.createdAt || new Date().toISOString(),
        amount,
        payout,
        result,
        tokenDiff,
      };
    });

    // Keno mapping (unchanged)
    const kenoFormatted = kenoRows.map((row) => {
      const amount = Number(row.bet_amount ?? 0);
      const payout = Number(row.payout ?? 0);

      let result = (row.status ?? "").toLowerCase();
      if (!result) {
        result = payout > 0 ? "won" : "lost";
      }
      if (result === "win") result = "won";
      if (result === "lose") result = "lost";

      const tokenDiff = payout - amount;

      return {
        type: "🎯 Keno",
        date: row.created_at || new Date().toISOString(),
        amount,
        payout,
        result,
        tokenDiff,
        hits: Number(row.hits ?? 0),
        multiplier: Number(row.multiplier ?? 0),
        numbersPicked: row.numbers_picked,
        numbersDrawn: row.numbers_drawn,
      };
    });

    // -------------------------------------
    // 🛢️ NEW — Tank Survival History
    // -------------------------------------
    const tankFormatted = tankRows.map((row) => {
      const amount = Number(row.bounty ?? 0); // cost to enter
      const cashed = Number(row.amountCashedOut ?? 0);

      const result = cashed > 0 ? "won" : "lost";
      const payout = cashed;
      const tokenDiff = payout - amount;

      return {
        type: "🛢️ Tank Survival",
        date: row.createdAt || new Date().toISOString(),
        amount,
        payout,
        result,
        tokenDiff,
      };
    });

    // Connect Four mapping
   const connectFourFormatted = connectFourRows
  .map((game) => {
    if (!game.winnerClerkId) return null; // ✅ ignore unfinished games

    const amount = Number(game.betAmount ?? 0);
    const payout = Number(game.payout ?? 0);

    const result =
      game.winnerClerkId === clerkId ? "won" : "lost";

    const tokenDiff =
      result === "won" ? payout - amount : -amount;

    return {
      type: "🔴 Connect Four",
      date: game.endedAt || game.createdAt || new Date().toISOString(),
      amount,
      payout,
      result,
      tokenDiff,
    };
  })
  .filter(Boolean); // ✅ removes nulls);

    // Combine all bets
    const allBets = [
      ...roulette.map((b) => formatBet("🎡 Roulette", b)),
      ...blackjack.map((b) => formatBet("🃏 Blackjack", b)),
      ...mines.map((b) => formatBet("💣 Mines", b)),
      ...plinko.map((b) => formatBet("🟢 Plinko", b)),
      ...crash.map((b) => formatBet("🚀 Crash", b)),
      ...rps.map((b) => formatBet("✊ Rock Paper Scissors", b)),
      ...uno.map((b) => formatBet("🎴 UNO", b)),
      ...chess.map((b) => formatBet("♟️ Chess", b)),
      ...sports.map((b) => formatBet("🏈 Sports Bet", b)),
      ...slots.map((b) => formatBet("🎰 Slots", b)),
      ...coinflipFormatted,
      ...kenoFormatted,
      ...tankFormatted, 
      ...connectFourFormatted,
].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

return NextResponse.json({ success: true, bets: allBets });
  } catch (err) {
    console.error("[GET_BET_HISTORY_ERROR]", err);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}
