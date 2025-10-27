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
  coinFlipGames, // <- coinflip already added earlier
  keno_games,     // <- added Keno table import (note snake_case export name)
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

    const uid = dbUser.id; // internal numeric id
    const clerkId = userId; // Clerk ID (string)

    // Fetch bets from all games (added keno_games query)
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
      kenoRows, // <- new
    ] = await Promise.all([
      db.select().from(rouletteGames).where(eq(rouletteGames.userId, uid)),
      db.select().from(blackjackGames).where(eq(blackjackGames.userId, uid)),
      db.select().from(minesGames).where(eq(minesGames.userId, uid)),
      db.select().from(plinkoGames).where(eq(plinkoGames.userId, userId)),
      db.select().from(crashGames).where(eq(crashGames.userId, uid)),
      db.select().from(rpsGames).where(eq(rpsGames.userId, clerkId)), // note: Clerk ID
      db.select().from(unoGames).where(eq(unoGames.userId, uid)),
      db
        .select()
        .from(chessGames)
        .where(or(eq(chessGames.playerWhiteId, clerkId), eq(chessGames.playerBlackId, clerkId))),
      db.select().from(sportsBets).where(eq(sportsBets.userId, uid)),
      db.select().from(slotGames).where(eq(slotGames.userId, userId)),
      // coinflip: find rows where either player1Id or player2Id matches Clerk ID
      db.select().from(coinFlipGames).where(or(eq(coinFlipGames.player1Id, clerkId), eq(coinFlipGames.player2Id, clerkId))),
      // keno rows for this internal user id
      db.select().from(keno_games).where(eq(keno_games.user_id, uid)),
    ]);

    // Generic formatter (unchanged)
    const formatBet = (type, bet) => {
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

      const amount = Number(bet.betAmount || bet.bet_amount || bet.amount || 0);
      const payout = Number(bet.payout ?? 0);

      // 🧮 Custom tokenDiff for Plinko and Slots
      let tokenDiff;
      if (type.includes("Plinko") || type.includes("Slots")) {
        // ✅ Show net profit/loss (difference) for Plinko & Slots
        tokenDiff = payout - amount;
      } else {
        // 🕹 Default logic for other games
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

    // coinflip mapping (keeps your existing coinflip logic)
    const coinflipFormatted = coinflipRows.map((bet) => {
      const amount = Number(bet.betAmount ?? bet.betAmount ?? 0);

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

      const COINFLIP_MULT = 1.98;
      const payout = result === "won" ? Number((amount * COINFLIP_MULT).toFixed(2)) : 0;
      const tokenDiff = result === "won" ? payout - amount : result === "lost" ? -amount : 0;

      return {
        type: "💰 Coinflip",
        date: bet.createdAt || bet.createdAt || new Date().toISOString(),
        amount,
        payout,
        result,
        tokenDiff,
      };
    });

    // -------------------------
    // KENO mapping (NEW)
    // -------------------------
    // Your keno schema uses snake_case fields: bet_amount, numbers_picked (jsonb), numbers_drawn (jsonb), hits, payout, multiplier, status, created_at
    const kenoFormatted = kenoRows.map((row) => {
      const amount = Number(row.bet_amount ?? 0);
      const payout = Number(row.payout ?? 0);
      // if status exists, use it; otherwise infer by payout
      let result = (row.status ?? "").toString().toLowerCase();
      if (!result || result === "") {
        if (!isNaN(payout)) {
          result = payout > 0 ? "won" : "lost";
        } else {
          result = "pending";
        }
      } else {
        // normalize typical values
        if (result === "win") result = "won";
        if (result === "lose") result = "lost";
      }

      // tokenDiff: show net profit/loss for Keno (payout - bet)
      const tokenDiff = (isNaN(payout) ? 0 : payout) - amount;

      // include some keno-specific fields in the object for frontend if needed later
      let numbersPicked = null;
      let numbersDrawn = null;
      try {
        numbersPicked = row.numbers_picked ?? row.numbers_picked ?? null;
        numbersDrawn = row.numbers_drawn ?? row.numbers_drawn ?? null;
      } catch (e) {
        numbersPicked = null;
        numbersDrawn = null;
      }

      return {
        type: "🎯 Keno",
        date: row.created_at || row.created_at || new Date().toISOString(),
        amount,
        payout,
        result,
        tokenDiff,
        hits: Number(row.hits ?? 0),
        multiplier: Number(row.multiplier ?? 0),
        numbersPicked,
        numbersDrawn,
      };
    });

    // Combine all bets into one array with proper labels (include kenoFormatted)
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
      ...kenoFormatted, // <- appended
    ].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    return NextResponse.json({ success: true, bets: allBets });
  } catch (err) {
    console.error("[GET_BET_HISTORY_ERROR]", err);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}
