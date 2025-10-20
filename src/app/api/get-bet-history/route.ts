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

    // Fetch bets from all games
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
    ] = await Promise.all([
      db.select().from(rouletteGames).where(eq(rouletteGames.userId, uid)),
      db.select().from(blackjackGames).where(eq(blackjackGames.userId, uid)),
      db.select().from(minesGames).where(eq(minesGames.userId, uid)),
      db.select().from(plinkoGames).where(eq(plinkoGames.userId, uid)),
      db.select().from(crashGames).where(eq(crashGames.userId, uid)),
      db.select().from(rpsGames).where(eq(rpsGames.userId, userId)), // note: Clerk ID
      db.select().from(unoGames).where(eq(unoGames.userId, uid)),
      db
        .select()
        .from(chessGames)
        .where(or(eq(chessGames.playerWhiteId, userId), eq(chessGames.playerBlackId, userId))),
      db.select().from(sportsBets).where(eq(sportsBets.userId, uid)),
    ]);

    // ✅ Smarter result normalization
const formatBet = (type: string, bet: any) => {
  let result = "pending";

  // normalize known keys
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

  // 🪙 Token calculation (added)
  const amount = Number(bet.betAmount || bet.bet_amount || bet.amount || 0);
  const payout = Number(bet.payout ?? 0);
  const tokenDiff =
    result === "won" ? payout - amount :
    result === "lost" ? -amount : 0;

  return {
    type,
    date: bet.createdAt || bet.placedAt || bet.created_at || new Date().toISOString(),
    amount,
    payout,
    result,
    tokenDiff, // ✅ added this field
  };
};



    // Combine all bets into one array with proper labels
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
    ].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    return NextResponse.json({ success: true, bets: allBets });
  } catch (err) {
    console.error("[GET_BET_HISTORY_ERROR]", err);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}
