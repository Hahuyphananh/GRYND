//get-bet-history/route.ts
import { NextResponse } from "next/server";
import { db } from "../../../db";
import { eq, or, sql } from "drizzle-orm";
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
  diceMatches,
  poolMatches,
  connectFourGames,
} from "../../../db/schema";
import { auth } from "@clerk/nextjs/server";

export async function GET() {
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ success: false, error: "Not authenticated" }, { status: 401 });

    const dbUser = await db.query.users.findFirst({ where: eq(users.clerkId, userId) });
    if (!dbUser) return NextResponse.json({ success: false, error: "User not found" }, { status: 404 });

    const uid = dbUser.id;
    const clerkId = userId;

    const [roulette, blackjack, mines, plinko, crash, rps, uno, chess, sports, slots, coinflipRows, kenoRows, diceRows, poolRows, connectFourRows] = await Promise.all([
      db.select().from(rouletteGames).where(eq(rouletteGames.userId, uid)),
      db.select().from(blackjackGames).where(eq(blackjackGames.userId, uid)),
      db.select().from(minesGames).where(eq(minesGames.userId, uid)),
      db.select().from(plinkoGames).where(eq(plinkoGames.userId, userId)),
      db.select().from(crashGames).where(eq(crashGames.userId, uid)),
      db.select().from(rpsGames).where(eq(rpsGames.userId, clerkId)),
      db.select().from(unoGames).where(eq(unoGames.userId, uid)),
      db.select().from(chessGames).where(or(eq(chessGames.playerWhiteId, clerkId), eq(chessGames.playerBlackId, clerkId))),
      db.select().from(sportsBets).where(eq(sportsBets.userId, uid)),
      db.select().from(slotGames).where(eq(slotGames.userId, userId)),
      db.select().from(coinFlipGames).where(or(eq(coinFlipGames.player1Id, clerkId), eq(coinFlipGames.player2Id, clerkId))),
      db.select().from(keno_games).where(eq(keno_games.user_id, uid)),
      db.select().from(diceMatches).where(or(eq(diceMatches.player1Id, clerkId), eq(diceMatches.player2Id, clerkId))),
      db.select().from(poolMatches).where(or(eq(poolMatches.player1Id, clerkId), eq(poolMatches.player2Id, clerkId))),
      db.select().from(connectFourGames).where(or(eq(connectFourGames.hostClerkId, clerkId), eq(connectFourGames.guestClerkId, clerkId))),
    ]);

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
      else if (!isNaN(Number(bet.payout))) result = Number(bet.payout) > 0 ? "won" : "lost";

      if (type.includes("Rock Paper Scissors")) {
        const lowerResult = bet.result?.toLowerCase?.() || bet.outcome?.toLowerCase?.() || "";
        if (lowerResult.includes("tie") || lowerResult.includes("draw")) result = "tie";
      }

      const amount = Math.floor(Number(bet.betAmount || bet.bet_amount || bet.amount || 0));
      const payout = Math.floor(Number(bet.payout ?? 0));
      const tokenDiff = result === "won" ? payout - amount : result === "lost" ? -amount : 0;

      return { type, date: bet.createdAt || bet.placedAt || bet.created_at || new Date().toISOString(), amount, payout, result, tokenDiff };
    };

    const coinflipFormatted = coinflipRows.map((bet) => {
      const amount = Number(bet.betAmount ?? 0);
      let result = bet.result?.toLowerCase?.() ?? "pending";
      if (!bet.result) {
        if (bet.winnerId) result = bet.winnerId === clerkId ? "won" : "lost";
      }
      const payout = result === "won" ? Number((amount * 1.98).toFixed(2)) : 0;
      return { type: "💰 Coinflip", date: bet.createdAt || new Date().toISOString(), amount, payout, result, tokenDiff: result === "won" ? payout - amount : -amount };
    });

    const kenoFormatted = kenoRows.map((row) => {
      const amount = Number(row.bet_amount ?? 0);
      const payout = Number(row.payout ?? 0);
      const result = payout > 0 ? "won" : "lost";
      return { type: "🎯 Keno", date: row.created_at || new Date().toISOString(), amount, payout, result, tokenDiff: payout - amount };
    });

    const diceFormatted = diceRows.map((game) => {
      if (!game.winnerId) return null;
      const amount = Number(game.wager ?? 0);
      const payout = Number(game.prizePaid ?? 0);
      const result = game.winnerId === clerkId ? "won" : "lost";
      return { type: "🎲 Dice Duel", date: game.endedAt || game.createdAt || new Date().toISOString(), amount, payout, result, tokenDiff: result === "won" ? payout - amount : -amount };
    }).filter(Boolean);

    const connectFourFormatted = connectFourRows.map((game) => {
      if (!game.winnerClerkId) return null;
      const amount = Number(game.betAmount ?? 0);
      const payout = Number(game.payout ?? 0);
      const result = game.winnerClerkId === clerkId ? "won" : "lost";
      return { type: "🔴 Connect Four", date: game.endedAt || game.createdAt || new Date().toISOString(), amount, payout, result, tokenDiff: result === "won" ? payout - amount : -amount };
    }).filter(Boolean);

    const poolFormatted = poolRows.map((game) => {
      if (!game.winnerId) return null;
      const amount = Number(game.wager ?? 0);
      const payout = Number(game.prizePaid ?? 0);
      const result = game.winnerId === clerkId ? "won" : "lost";
      return { type: "🎱 Pool Masters", date: game.endedAt || game.createdAt || new Date().toISOString(), amount, payout, result, tokenDiff: result === "won" ? payout - amount : -amount };
    }).filter(Boolean);

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
      ...diceFormatted,
      ...poolFormatted,
      ...connectFourFormatted,
    ].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    const now = Date.now();
    const weeklyMs = 7 * 24 * 60 * 60 * 1000;
    let totalWagered = 0;
    let totalWon = 0;
    let biggestWin = 0;
    let bestMultiplier = 0;
    let weeklyWagered = 0;
    let weeklyWon = 0;
    let weeklyProfit = 0;
    let weeklyWins = 0;
    let currentStreak = 0;
    let bestStreak = 0;

    const byOldest = [...allBets].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    for (const bet of byOldest) {
      const amount = Math.max(0, Math.floor(Number(bet.amount || 0)));
      const payout = Math.max(0, Math.floor(Number(bet.payout || 0)));
      totalWagered += amount;
      totalWon += payout;
      biggestWin = Math.max(biggestWin, payout);
      if (amount > 0) bestMultiplier = Math.max(bestMultiplier, payout / amount);

      const ts = new Date(bet.date).getTime();
      if (now - ts <= weeklyMs) {
        weeklyWagered += amount;
        weeklyWon += payout;
        weeklyProfit += payout - amount;
        if (bet.result === "won") weeklyWins += 1;
      }

      if (bet.result === "won") {
        currentStreak += 1;
        bestStreak = Math.max(bestStreak, currentStreak);
      } else if (bet.result === "lost") {
        currentStreak = 0;
      }
    }

    await db
      .update(users)
      .set({
        totalWagered,
        totalWon,
        biggestWin,
        bestMultiplier: sql`${bestMultiplier}`,
        currentStreak,
        bestStreak,
        weeklyWagered,
        weeklyWon,
        weeklyProfit,
        weeklyWins,
      })
      .where(eq(users.id, uid));

    return NextResponse.json({ success: true, bets: allBets });
  } catch (err) {
    console.error("[GET_BET_HISTORY_ERROR]", err);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}
