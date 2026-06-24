//get-bet-history/route.ts
import { NextResponse } from "next/server";
import { db } from "../../../db";
import { eq, or, and, sql } from "drizzle-orm";
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
  laneRunnerGames,
  hexDuelGames,
  oddsGames,
  pokerGames,
  farkleRooms,
  farklePlayers,
  diceFlushRooms,
  diceFlushPlayers,
  clickerGames,
} from "../../../db/schema";
import { auth } from "@clerk/nextjs/server";

export async function GET() {
  try {
    const { userId } = await auth();
    if (!userId)
      return NextResponse.json(
        { success: false, error: "Not authenticated" },
        { status: 401 },
      );

    const dbUser = await db.query.users.findFirst({
      where: eq(users.clerkId, userId),
    });
    if (!dbUser)
      return NextResponse.json(
        { success: false, error: "User not found" },
        { status: 404 },
      );

    const uid = dbUser.id;
    const clerkId = userId;

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
      diceRows,
      poolRows,
      connectFourRows,
      laneRunnerRows,
      hexDuelRows,
      oddsRows,
      pokerRows,
      farkleRows,
      diceFlushRows,
      clickerRows,
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
        .where(
          or(
            eq(chessGames.playerWhiteId, clerkId),
            eq(chessGames.playerBlackId, clerkId),
          ),
        ),
      db.select().from(sportsBets).where(eq(sportsBets.userId, uid)),
      db.select().from(slotGames).where(eq(slotGames.userId, userId)),
      db
        .select()
        .from(coinFlipGames)
        .where(
          or(
            eq(coinFlipGames.player1Id, clerkId),
            eq(coinFlipGames.player2Id, clerkId),
          ),
        ),
      db.select().from(keno_games).where(eq(keno_games.user_id, uid)),
      db
        .select()
        .from(diceMatches)
        .where(
          or(
            eq(diceMatches.player1Id, clerkId),
            eq(diceMatches.player2Id, clerkId),
          ),
        ),
      db
        .select()
        .from(poolMatches)
        .where(
          or(
            eq(poolMatches.player1Id, clerkId),
            eq(poolMatches.player2Id, clerkId),
          ),
        ),
      db
        .select()
        .from(connectFourGames)
        .where(
          or(
            eq(connectFourGames.hostClerkId, clerkId),
            eq(connectFourGames.guestClerkId, clerkId),
          ),
        ),
      // 🏃 Lane Runner (solo game with integer userId)
      db.select().from(laneRunnerGames).where(eq(laneRunnerGames.userId, uid)),
      // ⬡ Hex Duel (PvP + AI, clerkId-based, skip fun mode)
      db
        .select()
        .from(hexDuelGames)
        .where(
          and(
            or(
              eq(hexDuelGames.player1Id, clerkId),
              eq(hexDuelGames.player2Id, clerkId),
            ),
            eq(hexDuelGames.isFunMode, false),
          ),
        ),
      // 🎯 Odds (PvP + AI, clerkId-based)
      db
        .select()
        .from(oddsGames)
        .where(
          or(
            eq(oddsGames.player1Id, clerkId),
            eq(oddsGames.player2Id, clerkId),
          ),
        ),
      // 🃏 Poker (multiplayer, jsonb players array)
      db
        .select()
        .from(pokerGames)
        .where(
          sql`exists (select 1 from jsonb_array_elements(${pokerGames.players}) elem where elem->>'clerkId' = ${clerkId})`,
        ),
      // 🎲 Farkle (join players → rooms)
      db
        .select()
        .from(farklePlayers)
        .innerJoin(farkleRooms, eq(farklePlayers.roomId, farkleRooms.id))
        .where(eq(farklePlayers.userId, clerkId)),
      // 🎲 Dice Flush (join players → rooms)
      db
        .select()
        .from(diceFlushPlayers)
        .innerJoin(diceFlushRooms, eq(diceFlushPlayers.roomId, diceFlushRooms.id))
        .where(eq(diceFlushPlayers.userId, clerkId)),
      // 🖱️ GoonBet Clicker (solo game, clerkId-based)
      db.select().from(clickerGames).where(eq(clickerGames.userId, clerkId)),
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
      else if (typeof bet.didWin === "boolean")
        result = bet.didWin ? "won" : "lost";
      else if (typeof bet.win === "boolean") result = bet.win ? "won" : "lost";
      else if (!isNaN(Number(bet.payout)))
        result = Number(bet.payout) > 0 ? "won" : "lost";

      if (type.includes("Rock Paper Scissors")) {
        const lowerResult =
          bet.result?.toLowerCase?.() || bet.outcome?.toLowerCase?.() || "";
        if (lowerResult.includes("tie") || lowerResult.includes("draw"))
          result = "tie";
      }

      const amount = Math.floor(
        Number(bet.betAmount || bet.bet_amount || bet.amount || 0),
      );
      const payout = Math.floor(Number(bet.payout ?? 0));
      const tokenDiff =
        result === "won" ? payout - amount : result === "lost" ? -amount : 0;

      return {
        type,
        date:
          bet.createdAt ||
          bet.placedAt ||
          bet.created_at ||
          new Date().toISOString(),
        amount,
        payout,
        result,
        tokenDiff,
      };
    };

    const coinflipFormatted = coinflipRows.map((bet) => {
      // Only finished matches contribute a Win/Loss — in-flight
      // matches (status='active' / 'matched' / 'cancelled') and even
      // mid-match rounds (where the server briefly stamps the round
      // winner onto `winnerId` between rounds of a best-of-N match)
      // are deliberately excluded so the bet history never shows a
      // misleading win/loss for an unfinished game.
      if (bet.status !== "finished") {
        return null;
      }
      const amount = Number(bet.betAmount ?? 0);
      const result = bet.winnerId === clerkId ? "won" : "lost";
      const payout = result === "won" ? Number((amount * 1.98).toFixed(2)) : 0;
      return {
        type: "💰 Coinflip",
        date: bet.createdAt || new Date().toISOString(),
        amount,
        payout,
        result,
        tokenDiff: result === "won" ? payout - amount : -amount,
      };
    }).filter(Boolean);

    const kenoFormatted = kenoRows.map((row) => {
      const amount = Number(row.bet_amount ?? 0);
      const payout = Number(row.payout ?? 0);
      const result = payout > 0 ? "won" : "lost";
      return {
        type: "🎯 Keno",
        date: row.created_at || new Date().toISOString(),
        amount,
        payout,
        result,
        tokenDiff: payout - amount,
      };
    });

    const diceFormatted = diceRows
      .map((game) => {
        if (!game.winnerId) return null;
        const amount = Number(game.wager ?? 0);
        const payout = Number(game.prizePaid ?? 0);
        const result = game.winnerId === clerkId ? "won" : "lost";
        return {
          type: "🎲 Dice Duel",
          date: game.endedAt || game.createdAt || new Date().toISOString(),
          amount,
          payout,
          result,
          tokenDiff: result === "won" ? payout - amount : -amount,
        };
      })
      .filter(Boolean);

    const connectFourFormatted = connectFourRows
      .map((game) => {
        if (!game.winnerClerkId) return null;
        const amount = Number(game.betAmount ?? 0);
        const payout = Number(game.payout ?? 0);
        const result = game.winnerClerkId === clerkId ? "won" : "lost";
        return {
          type: "🔴 Connect Four",
          date: game.endedAt || game.createdAt || new Date().toISOString(),
          amount,
          payout,
          result,
          tokenDiff: result === "won" ? payout - amount : -amount,
        };
      })
      .filter(Boolean);

    const poolFormatted = poolRows
      .map((game) => {
        if (!game.winnerId) return null;
        const amount = Number(game.wager ?? 0);
        const payout = Number(game.prizePaid ?? 0);
        const result = game.winnerId === clerkId ? "won" : "lost";
        return {
          type: "🎱 Pool Masters",
          date: game.endedAt || game.createdAt || new Date().toISOString(),
          amount,
          payout,
          result,
          tokenDiff: result === "won" ? payout - amount : -amount,
        };
      })
      .filter(Boolean);

    // 🏃 Lane Runner — solo game with standard bet/payout/result
    const laneRunnerFormatted = laneRunnerRows
      .filter((g) => g.status === "completed")
      .map((g) => formatBet("🏃 Lane Runner", {
        betAmount: g.betAmount,
        payout: g.payout,
        result: g.result,
        createdAt: g.createdAt,
      }));

    // ⬡ Hex Duel — determine win/loss from winner field
    const hexDuelFormatted = hexDuelRows
      .filter((g) => g.status !== "in_progress")
      .map((g) => {
        const amount = Number(g.wagerAmount ?? 0);
        const payout = Number(g.payout ?? 0);
        const isPlayer1 = g.player1Id === clerkId;
        const won =
          (isPlayer1 && g.winner === "player1") ||
          (!isPlayer1 && g.winner === "player2");
        const result = won ? "won" : "lost";
        return {
          type: g.isAiGame ? "⬡ Hex Duel vs AI" : "⬡ Hex Duel",
          date: g.endedAt || g.createdAt || new Date().toISOString(),
          amount,
          payout,
          result,
          tokenDiff: result === "won" ? payout - amount : -amount,
        };
      });

    // 🎯 Odds — determine win/loss from winner field
    const oddsFormatted = oddsRows
      .filter((g) => g.status === "finished" || g.status === "forfeit")
      .map((g) => {
        const amount = Number(g.wager ?? 0);
        const payout = Number(g.payout ?? 0);
        const isPlayer1 = g.player1Id === clerkId;
        const won =
          (isPlayer1 && g.winner === "player1") ||
          (!isPlayer1 && g.winner === "player2");
        const result = won ? "won" : "lost";
        return {
          type: g.isAi ? "🎯 Odds vs AI" : "🎯 Odds",
          date: g.endedAt || g.createdAt || new Date().toISOString(),
          amount,
          payout,
          result,
          tokenDiff: result === "won" ? payout - amount : -amount,
        };
      });

    // 🃏 Poker — determine result from winnings jsonb or winner text
    const pokerFormatted = pokerRows
      .filter((g) => g.status === "finished")
      .map((g) => {
        const playersArr = Array.isArray(g.players) ? g.players : [];
        const mySeat = playersArr.find((p) => p?.clerkId === clerkId);
        const winnings =
          Array.isArray(g.winnings) && mySeat != null
            ? g.winnings.find((w) => w?.seat === mySeat.seat)
            : null;
        const amount = Number(winnings?.bet || g.betAmount || 0);
        const payout = Number(winnings?.payout || g.payout || 0);
        const result = payout > amount ? "won" : "lost";
        return {
          type: "🃏 Poker",
          date: g.createdAt || new Date().toISOString(),
          amount,
          payout,
          result,
          tokenDiff: result === "won" ? payout - amount : -amount,
        };
      });

    // 🎲 Farkle — joined rows: farkle_players + farkle_rooms
    const farkleFormatted = farkleRows
      .filter((row) => row.farkle_rooms?.status === "finished")
      .map((row) => {
        const room = row.farkle_rooms;
        const amount = Number(room.wager ?? 0);
        const gameState =
          room.gameState && typeof room.gameState === "object"
            ? (room.gameState as Record<string, unknown>)
            : {};
        const winnerId = gameState.winnerId as string | undefined;
        const result = winnerId
          ? winnerId === clerkId
            ? "won"
            : "lost"
          : "completed";
        const payout = result === "won" ? Number(room.pot ?? amount * 2) : 0;
        return {
          type: "🎲 Farkle",
          date: room.createdAt || new Date().toISOString(),
          amount,
          payout,
          result,
          tokenDiff: result === "won" ? payout - amount : -amount,
        };
      });

    // 🎲 Dice Flush — joined rows: dice_flush_players + dice_flush_rooms
    const diceFlushFormatted = diceFlushRows
      .filter((row) => row.dice_flush_rooms?.status === "finished")
      .map((row) => {
        const room = row.dice_flush_rooms;
        const amount = Number(room.wager ?? 0);
        const gameState =
          room.gameState && typeof room.gameState === "object"
            ? (room.gameState as Record<string, unknown>)
            : {};
        const winnerId = gameState.winnerId as string | undefined;
        const result = winnerId
          ? winnerId === clerkId
            ? "won"
            : "lost"
          : "completed";
        const payout = result === "won" ? Number(room.pot ?? amount * 2) : 0;
        return {
          type: "🎲 Dice Flush",
          date: room.createdAt || new Date().toISOString(),
          amount,
          payout,
          result,
          tokenDiff: result === "won" ? payout - amount : -amount,
        };
      });

    // 🖱️ GoonBet Clicker — solo game with bet/payout/multiplier/busted
    const clickerFormatted = clickerRows.map((g) => {
      const amount = Number(g.betAmount ?? 0);
      const payout = Number(g.payout ?? 0);
      const result = g.busted ? "lost" : payout > amount ? "won" : "lost";
      return {
        type: "🖱️ Clicker",
        date: g.createdAt || new Date().toISOString(),
        amount,
        payout,
        result,
        tokenDiff: result === "won" ? payout - amount : -amount,
      };
    });

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
      ...laneRunnerFormatted,
      ...hexDuelFormatted,
      ...oddsFormatted,
      ...pokerFormatted,
      ...farkleFormatted,
      ...diceFlushFormatted,
      ...clickerFormatted,
    ].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    // ⚠ Cumulative stats (totalWagered, weeklyWagered, currentStreak, etc.)
    // are maintained by applyLeaderboardCounters (leaderboardCounters.js)
    // which is called by every game settlement endpoint. Recalculating them
    // here from a subset of game history tables causes stats to DECREASE
    // whenever a game type not listed above contributes to those counters.
    return NextResponse.json({ success: true, bets: allBets });
  } catch (err) {
    console.error("[GET_BET_HISTORY_ERROR]", err);
    return NextResponse.json(
      { success: false, error: "Internal server error" },
      { status: 500 },
    );
  }
}
