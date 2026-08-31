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
  unoGames,
  chessGames,
  keno_games,
  kenoPvpMatches,
  poolMatches,
  fourInARowGames,
  memoryGridMatches,
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
      kenoPvpRows,
      kenoRows,
      poolRows,
      fourInARowRows,
      memoryGridRows,
    ] = await Promise.all([
      // Column projection: this is a PUBLIC endpoint (viewable by any user for
      // any clerkId), so only the fields the formatters read leave the DB.
      // Full-row selects shipped every table's deck/hand/seed/state columns
      // to unauthenticated visitors. fetchLimit already caps pagination at 100.
      db.select({
        betAmount: rouletteGames.betAmount,
        payout: rouletteGames.payout,
        result: rouletteGames.result,
        createdAt: rouletteGames.createdAt,
      }).from(rouletteGames).where(eq(rouletteGames.userId, uid)).limit(fetchLimit),
      db.select({
        betAmount: blackjackGames.betAmount,
        payout: blackjackGames.payout,
        result: blackjackGames.result,
        createdAt: blackjackGames.createdAt,
      }).from(blackjackGames).where(eq(blackjackGames.userId, uid)).limit(fetchLimit),
      db.select({
        betAmount: minesGames.betAmount,
        payout: minesGames.payout,
        result: minesGames.result,
        createdAt: minesGames.createdAt,
      }).from(minesGames).where(eq(minesGames.userId, uid)).limit(fetchLimit),
      db.select({
        betAmount: plinkoGames.betAmount,
        payout: plinkoGames.payout,
        result: plinkoGames.result,
        createdAt: plinkoGames.createdAt,
      }).from(plinkoGames).where(eq(plinkoGames.userId, clerkId)).limit(fetchLimit),
      db.select({
        betAmount: crashGames.betAmount,
        payout: crashGames.payout,
        result: crashGames.result,
        createdAt: crashGames.createdAt,
      }).from(crashGames).where(eq(crashGames.userId, uid)).limit(fetchLimit),
      db.select({
        betAmount: rpsGames.betAmount,
        payout: rpsGames.payout,
        result: rpsGames.result,
        createdAt: rpsGames.createdAt,
      }).from(rpsGames).where(eq(rpsGames.userId, clerkId)).limit(fetchLimit),
      db.select({
        betAmount: unoGames.betAmount,
        payout: unoGames.payout,
        result: unoGames.result,
        createdAt: unoGames.createdAt,
      }).from(unoGames).where(eq(unoGames.userId, uid)).limit(fetchLimit),
      db.select({
        betAmount: chessGames.betAmount,
        payout: chessGames.payout,
        result: chessGames.result,
        createdAt: chessGames.createdAt,
      }).from(chessGames).where(
        or(eq(chessGames.playerWhiteId, clerkId), eq(chessGames.playerBlackId, clerkId))
      ).limit(fetchLimit),
      db.select({
        status: kenoPvpMatches.status,
        result: kenoPvpMatches.result,
        winnerId: kenoPvpMatches.winnerId,
        stakeAmount: kenoPvpMatches.stakeAmount,
        prizePaid: kenoPvpMatches.prizePaid,
        endedAt: kenoPvpMatches.endedAt,
        createdAt: kenoPvpMatches.createdAt,
      }).from(kenoPvpMatches).where(
        or(eq(kenoPvpMatches.player1Id, clerkId), eq(kenoPvpMatches.player2Id, clerkId))
      ).limit(fetchLimit),
      db.select({
        bet_amount: keno_games.bet_amount,
        payout: keno_games.payout,
        created_at: keno_games.created_at,
      }).from(keno_games).where(eq(keno_games.user_id, uid)).limit(fetchLimit),
      db.select({
        winnerId: poolMatches.winnerId,
        wager: poolMatches.wager,
        prizePaid: poolMatches.prizePaid,
        endedAt: poolMatches.endedAt,
        createdAt: poolMatches.createdAt,
      }).from(poolMatches).where(
        or(eq(poolMatches.player1Id, clerkId), eq(poolMatches.player2Id, clerkId))
      ).limit(fetchLimit),
      db.select({
        winnerClerkId: fourInARowGames.winnerClerkId,
        betAmount: fourInARowGames.betAmount,
        payout: fourInARowGames.payout,
        endedAt: fourInARowGames.endedAt,
        createdAt: fourInARowGames.createdAt,
      }).from(fourInARowGames).where(
        or(eq(fourInARowGames.hostClerkId, clerkId), eq(fourInARowGames.guestClerkId, clerkId))
      ).limit(fetchLimit),
      db.select({
        status: memoryGridMatches.status,
        result: memoryGridMatches.result,
        winnerId: memoryGridMatches.winnerId,
        stakeAmount: memoryGridMatches.stakeAmount,
        prizePaid: memoryGridMatches.prizePaid,
        endedAt: memoryGridMatches.endedAt,
        createdAt: memoryGridMatches.createdAt,
      }).from(memoryGridMatches).where(
        or(eq(memoryGridMatches.player1Id, clerkId), eq(memoryGridMatches.player2Id, clerkId))
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

    const memoryGridFormatted = memoryGridRows
      .filter((g: any) => g.status === "finished")
      .map((game: any) => {
        const amount = Number(game.stakeAmount ?? 0);
        const payout = Number(game.prizePaid ?? 0);
        const isDraw = game.result === "draw" || !game.winnerId;
        const result = isDraw ? "draw" : game.winnerId === clerkId ? "won" : "lost";
        return {
          type: "Memory Grid",
          date: game.endedAt || game.createdAt || new Date().toISOString(),
          amount,
          payout,
          result,
          tokenDiff: result === "won" ? payout - amount : result === "lost" ? -amount : 0,
        };
      });

    const fourInARowFormatted = fourInARowRows
      .filter((g: any) => g.winnerClerkId)
      .map((game: any) => {
        const amount = Number(game.betAmount ?? 0);
        const payout = Number(game.payout ?? 0);
        const result = game.winnerClerkId === clerkId ? "won" : "lost";
        return {
          type: "Four-In-A-Row", date: game.endedAt || game.createdAt || new Date().toISOString(),
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
      ...kenoPvpFormatted,
      ...kenoFormatted,
      ...poolFormatted,
      ...fourInARowFormatted,
      ...memoryGridFormatted,
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
