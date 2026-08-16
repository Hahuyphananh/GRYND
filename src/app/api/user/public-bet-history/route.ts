import { NextRequest, NextResponse } from "next/server";
import { db } from "../../../../db";
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
  keno_games,
  kenoPvpMatches,
  diceMatches,
  poolMatches,
  connectFourGames,
} from "../../../../db/schema";
import { consumeRateLimit } from "../../../../lib/security/rateLimit";

export async function GET(req: NextRequest) {
  try {
    const clerkId = req.nextUrl.searchParams.get("clerkId");
    const offset = Math.max(0, parseInt(req.nextUrl.searchParams.get("offset") || "0", 10) || 0);
    const limit = Math.min(50, Math.max(1, parseInt(req.nextUrl.searchParams.get("limit") || "20", 10) || 20));

    if (!clerkId) {
      return NextResponse.json(
        { success: false, error: "Missing clerkId parameter" },
        { status: 400 }
      );
    }

    // Rate limit: 30 requests per minute per IP for this public endpoint
    const rawIp = req.headers.get("x-forwarded-for") || req.headers.get("x-real-ip") || "unknown";
    const ip = rawIp.split(",")[0].trim();
    const rateLimitResult = await consumeRateLimit(`public-bet-history:${ip}`, {
      windowMs: 60_000,
      max: 30,
    });

    if (!rateLimitResult.allowed) {
      return NextResponse.json(
        { success: false, error: "Too many requests, please try again later" },
        {
          status: 429,
          headers: {
            "X-RateLimit-Limit": String(rateLimitResult.limit),
            "X-RateLimit-Remaining": String(rateLimitResult.remaining),
            "X-RateLimit-Reset": String(rateLimitResult.resetAt),
          },
        }
      );
    }

    const [dbUser] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.clerkId, clerkId))
      .limit(1);

    if (!dbUser) {
      return NextResponse.json(
        { success: false, error: "User not found" },
        { status: 404 }
      );
    }

    const uid = dbUser.id;
    // Fetch extra rows to have enough for pagination slicing (capped at 100 per table)
    const fetchLimit = Math.min(offset + limit + 1, 100);

    const formatBet = (type: string, bet: any) => {
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

      const amount = Math.floor(Number(bet.betAmount || bet.bet_amount || bet.amount || 0));
      const payout = Math.floor(Number(bet.payout ?? 0));
      const tokenDiff = result === "won" ? payout - amount : result === "lost" ? -amount : 0;

      return {
        type,
        date: bet.createdAt || bet.placedAt || bet.created_at || new Date().toISOString(),
        amount,
        payout,
        result,
        tokenDiff,
      };
    };

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
      kenoPvpRows,
      kenoRows,
      diceRows,
      poolRows,
      connectFourRows,
    ] = await Promise.all([
      db.select().from(rouletteGames).where(eq(rouletteGames.userId, uid)).limit(fetchLimit),
      db.select().from(blackjackGames).where(eq(blackjackGames.userId, uid)).limit(fetchLimit),
      db.select().from(minesGames).where(eq(minesGames.userId, uid)).limit(fetchLimit),
      db.select().from(plinkoGames).where(eq(plinkoGames.userId, clerkId)).limit(fetchLimit),
      db.select().from(crashGames).where(eq(crashGames.userId, uid)).limit(fetchLimit),
      db.select().from(rpsGames).where(eq(rpsGames.userId, clerkId)).limit(fetchLimit),
      db.select().from(unoGames).where(eq(unoGames.userId, uid)).limit(fetchLimit),
      db.select().from(chessGames).where(
        or(eq(chessGames.playerWhiteId, clerkId), eq(chessGames.playerBlackId, clerkId))
      ).limit(fetchLimit),
      db.select().from(sportsBets).where(eq(sportsBets.userId, uid)).limit(fetchLimit),
      db.select().from(kenoPvpMatches).where(
        or(eq(kenoPvpMatches.player1Id, clerkId), eq(kenoPvpMatches.player2Id, clerkId))
      ).limit(fetchLimit),
      db.select().from(keno_games).where(eq(keno_games.user_id, uid)).limit(fetchLimit),
      db.select().from(diceMatches).where(
        or(eq(diceMatches.player1Id, clerkId), eq(diceMatches.player2Id, clerkId))
      ).limit(fetchLimit),
      db.select().from(poolMatches).where(
        or(eq(poolMatches.player1Id, clerkId), eq(poolMatches.player2Id, clerkId))
      ).limit(fetchLimit),
      db.select().from(connectFourGames).where(
        or(eq(connectFourGames.hostClerkId, clerkId), eq(connectFourGames.guestClerkId, clerkId))
      ).limit(fetchLimit),
    ]);

    const kenoFormatted = kenoRows.map((row: any) => {
      const amount = Number(row.bet_amount ?? 0);
      const payout = Number(row.payout ?? 0);
      const result = payout > 0 ? "won" : "lost";
      return {
        type: "Keno", date: row.created_at || new Date().toISOString(),
        amount, payout, result, tokenDiff: payout - amount,
      };
    });

    const kenoPvpFormatted = kenoPvpRows
      .filter((g: any) => g.status === "finished")
      .map((game: any) => {
        const amount = Number(game.stakeAmount ?? 0);
        const payout = Number(game.prizePaid ?? 0);
        const isDraw = game.result === "draw" || !game.winnerId;
        const result = isDraw ? "draw" : game.winnerId === clerkId ? "won" : "lost";
        return {
          type: "Keno Duel",
          date: game.endedAt || game.createdAt || new Date().toISOString(),
          amount,
          payout,
          result,
          tokenDiff: result === "won" ? payout - amount : result === "lost" ? -amount : 0,
        };
      });

    const diceFormatted = diceRows
      .filter((g: any) => g.winnerId)
      .map((game: any) => {
        const amount = Number(game.wager ?? 0);
        const payout = Number(game.prizePaid ?? 0);
        const result = game.winnerId === clerkId ? "won" : "lost";
        return {
          type: "Dice Duel", date: game.endedAt || game.createdAt || new Date().toISOString(),
          amount, payout, result, tokenDiff: result === "won" ? payout - amount : -amount,
        };
      });

    const poolFormatted = poolRows
      .filter((g: any) => g.winnerId)
      .map((game: any) => {
        const amount = Number(game.wager ?? 0);
        const payout = Number(game.prizePaid ?? 0);
        const result = game.winnerId === clerkId ? "won" : "lost";
        return {
          type: "Pool Masters", date: game.endedAt || game.createdAt || new Date().toISOString(),
          amount, payout, result, tokenDiff: result === "won" ? payout - amount : -amount,
        };
      });

    const connectFourFormatted = connectFourRows
      .filter((g: any) => g.winnerClerkId)
      .map((game: any) => {
        const amount = Number(game.betAmount ?? 0);
        const payout = Number(game.payout ?? 0);
        const result = game.winnerClerkId === clerkId ? "won" : "lost";
        return {
          type: "Connect Four", date: game.endedAt || game.createdAt || new Date().toISOString(),
          amount, payout, result, tokenDiff: result === "won" ? payout - amount : -amount,
        };
      });

    const allBets = [
  ...roulette.map((b: any) => formatBet("Roulette", b)),
  ...blackjack.map((b: any) => formatBet("Blackjack", b)),
  ...mines.map((b: any) => formatBet("Mines", b)),
  ...plinko.map((b: any) => formatBet("Plinko", b)),
  ...crash.map((b: any) => formatBet("Crash", b)),
  ...rps.map((b: any) => formatBet("Rock Paper Scissors", b)),
  ...uno.map((b: any) => formatBet("UNO", b)),
  ...chess.map((b: any) => formatBet("Chess", b)),
  ...sports.map((b: any) => formatBet("Sports Bet", b)),
      ...kenoPvpFormatted,
      ...kenoFormatted,
      ...diceFormatted,
      ...poolFormatted,
      ...connectFourFormatted,
    ].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    const hasMore = allBets.length > offset + limit;
    const paginatedBets = allBets.slice(offset, offset + limit);

    return NextResponse.json({
      success: true,
      bets: paginatedBets,
      hasMore,
      total: allBets.length,
    });
  } catch (error: any) {
    console.error("[PUBLIC_BET_HISTORY_ERROR]", error);
    return NextResponse.json(
      { success: false, error: "Failed to load bet history" },
      { status: 500 }
    );
  }
}
