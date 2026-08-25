//get-bet-history/route.ts
import { NextResponse } from "next/server";
import { db } from "../../../db";
import { eq, or, and, inArray, sql } from "drizzle-orm";
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
  diceMatches,
  poolMatches,
  connectFourGames,
  laneRunnerGames,
  hexDuelGames,
  oddsGames,
  pokerGames,
  memoryGridMatches,
  diceFlushRooms,
  diceFlushPlayers,
  minesPvpMatches,
  laneRushDuelMatches,
  crashArenaTables,
  crashArenaRounds,
  crashArenaEntries,
} from "../../../db/schema";
import { auth } from "@clerk/nextjs/server";

// Cap each table's contribution so history stays bounded — the response
// is the newest entries across all games after the final sort.
const HISTORY_LIMIT = 200;

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
      kenoPvpRows,
      kenoRows,
      diceRows,
      poolRows,
      connectFourRows,
      laneRunnerRows,
      hexDuelRows,
      oddsRows,
      pokerRows,
      memoryGridRows,
      diceFlushRows,
      minesPvpRows,
      laneRushDuelRows,
      crashArenaRows,
    ] = await Promise.all([
      // Column projection + per-table LIMIT. The formatters below only
      // read a handful of fields per row; full-row selects shipped every
      // table's deck/hand/seed/state columns to the client. LIMIT caps
      // unbounded history (oldest entries are dropped by the final sort).
      db
        .select({
          betAmount: rouletteGames.betAmount,
          payout: rouletteGames.payout,
          result: rouletteGames.result,
          createdAt: rouletteGames.createdAt,
        })
        .from(rouletteGames)
        .where(eq(rouletteGames.userId, uid))
        .limit(HISTORY_LIMIT),
      db
        .select({
          betAmount: blackjackGames.betAmount,
          payout: blackjackGames.payout,
          result: blackjackGames.result,
          createdAt: blackjackGames.createdAt,
        })
        .from(blackjackGames)
        .where(eq(blackjackGames.userId, uid))
        .limit(HISTORY_LIMIT),
      db
        .select({
          betAmount: minesGames.betAmount,
          payout: minesGames.payout,
          result: minesGames.result,
          createdAt: minesGames.createdAt,
        })
        .from(minesGames)
        .where(eq(minesGames.userId, uid))
        .limit(HISTORY_LIMIT),
      db
        .select({
          betAmount: plinkoGames.betAmount,
          payout: plinkoGames.payout,
          result: plinkoGames.result,
          createdAt: plinkoGames.createdAt,
        })
        .from(plinkoGames)
        .where(eq(plinkoGames.userId, userId))
        .limit(HISTORY_LIMIT),
      db
        .select({
          betAmount: crashGames.betAmount,
          payout: crashGames.payout,
          result: crashGames.result,
          createdAt: crashGames.createdAt,
        })
        .from(crashGames)
        .where(eq(crashGames.userId, uid))
        .limit(HISTORY_LIMIT),
      db
        .select({
          betAmount: rpsGames.betAmount,
          payout: rpsGames.payout,
          result: rpsGames.result,
          createdAt: rpsGames.createdAt,
        })
        .from(rpsGames)
        .where(eq(rpsGames.userId, clerkId))
        .limit(HISTORY_LIMIT),
      db
        .select({
          betAmount: unoGames.betAmount,
          payout: unoGames.payout,
          result: unoGames.result,
          createdAt: unoGames.createdAt,
        })
        .from(unoGames)
        .where(eq(unoGames.userId, uid))
        .limit(HISTORY_LIMIT),
      db
        .select({
          playerWhiteId: chessGames.playerWhiteId,
          playerBlackId: chessGames.playerBlackId,
          betAmount: chessGames.betAmount,
          payout: chessGames.payout,
          result: chessGames.result,
          createdAt: chessGames.createdAt,
        })
        .from(chessGames)
        .where(
          or(
            eq(chessGames.playerWhiteId, clerkId),
            eq(chessGames.playerBlackId, clerkId),
          ),
        )
        .limit(HISTORY_LIMIT),
      db
        .select({
          player1Id: kenoPvpMatches.player1Id,
          player2Id: kenoPvpMatches.player2Id,
          stakeAmount: kenoPvpMatches.stakeAmount,
          prizePaid: kenoPvpMatches.prizePaid,
          winnerId: kenoPvpMatches.winnerId,
          result: kenoPvpMatches.result,
          status: kenoPvpMatches.status,
          endedAt: kenoPvpMatches.endedAt,
          createdAt: kenoPvpMatches.createdAt,
        })
        .from(kenoPvpMatches)
        .where(
          or(
            eq(kenoPvpMatches.player1Id, clerkId),
            eq(kenoPvpMatches.player2Id, clerkId),
          ),
        )
        .limit(HISTORY_LIMIT),
      db
        .select({
          bet_amount: keno_games.bet_amount,
          payout: keno_games.payout,
          created_at: keno_games.created_at,
        })
        .from(keno_games)
        .where(eq(keno_games.user_id, uid))
        .limit(HISTORY_LIMIT),
      db
        .select({
          player1Id: diceMatches.player1Id,
          player2Id: diceMatches.player2Id,
          wager: diceMatches.wager,
          prizePaid: diceMatches.prizePaid,
          winnerId: diceMatches.winnerId,
          endedAt: diceMatches.endedAt,
          createdAt: diceMatches.createdAt,
        })
        .from(diceMatches)
        .where(
          or(
            eq(diceMatches.player1Id, clerkId),
            eq(diceMatches.player2Id, clerkId),
          ),
        )
        .limit(HISTORY_LIMIT),
      db
        .select({
          player1Id: poolMatches.player1Id,
          player2Id: poolMatches.player2Id,
          wager: poolMatches.wager,
          prizePaid: poolMatches.prizePaid,
          winnerId: poolMatches.winnerId,
          endedAt: poolMatches.endedAt,
          createdAt: poolMatches.createdAt,
        })
        .from(poolMatches)
        .where(
          or(
            eq(poolMatches.player1Id, clerkId),
            eq(poolMatches.player2Id, clerkId),
          ),
        )
        .limit(HISTORY_LIMIT),
      db
        .select({
          hostClerkId: connectFourGames.hostClerkId,
          guestClerkId: connectFourGames.guestClerkId,
          betAmount: connectFourGames.betAmount,
          payout: connectFourGames.payout,
          winnerClerkId: connectFourGames.winnerClerkId,
          endedAt: connectFourGames.endedAt,
          createdAt: connectFourGames.createdAt,
        })
        .from(connectFourGames)
        .where(
          or(
            eq(connectFourGames.hostClerkId, clerkId),
            eq(connectFourGames.guestClerkId, clerkId),
          ),
        )
        .limit(HISTORY_LIMIT),
      //  Lane Runner (solo game with integer userId)
      db
        .select({
          betAmount: laneRunnerGames.betAmount,
          payout: laneRunnerGames.payout,
          result: laneRunnerGames.result,
          status: laneRunnerGames.status,
          createdAt: laneRunnerGames.createdAt,
        })
        .from(laneRunnerGames)
        .where(eq(laneRunnerGames.userId, uid))
        .limit(HISTORY_LIMIT),
      //  Hex Duel (PvP + AI, clerkId-based, skip fun mode)
      db
        .select({
          player1Id: hexDuelGames.player1Id,
          player2Id: hexDuelGames.player2Id,
          wagerAmount: hexDuelGames.wagerAmount,
          payout: hexDuelGames.payout,
          winner: hexDuelGames.winner,
          status: hexDuelGames.status,
          isAiGame: hexDuelGames.isAiGame,
          isFunMode: hexDuelGames.isFunMode,
          endedAt: hexDuelGames.endedAt,
          createdAt: hexDuelGames.createdAt,
        })
        .from(hexDuelGames)
        .where(
          and(
            or(
              eq(hexDuelGames.player1Id, clerkId),
              eq(hexDuelGames.player2Id, clerkId),
            ),
            eq(hexDuelGames.isFunMode, false),
          ),
        )
        .limit(HISTORY_LIMIT),
      //  Odds (PvP + AI, clerkId-based)
      db
        .select({
          player1Id: oddsGames.player1Id,
          player2Id: oddsGames.player2Id,
          wager: oddsGames.wager,
          payout: oddsGames.payout,
          winner: oddsGames.winner,
          status: oddsGames.status,
          isAi: oddsGames.isAi,
          endedAt: oddsGames.endedAt,
          createdAt: oddsGames.createdAt,
        })
        .from(oddsGames)
        .where(
          or(
            eq(oddsGames.player1Id, clerkId),
            eq(oddsGames.player2Id, clerkId),
          ),
        )
        .limit(HISTORY_LIMIT),
      //  Poker (multiplayer, jsonb players array)
      // Guard against legacy rows where `players` is null or a non-array
      // jsonb value; jsonb_array_elements on a non-array would throw
      // "cannot extract elements from a scalar/object" and 500 the route.
      // Also: the older `@>` form relied on exact key containment, which
      // never matched because every stored player object has a `seat`
      // key in addition to `clerkId` — so it silently never returned any
      // rows even when the user had played poker.
      db
        .select({
          players: pokerGames.players,
          winnings: pokerGames.winnings,
          betAmount: pokerGames.betAmount,
          payout: pokerGames.payout,
          status: pokerGames.status,
          createdAt: pokerGames.createdAt,
        })
        .from(pokerGames)
        .where(
          sql`exists (
            select 1
            from jsonb_array_elements(
              case
                when jsonb_typeof(${pokerGames.players}) = 'array'
                  then ${pokerGames.players}
                else '[]'::jsonb
              end
            ) elem
            where elem->>'clerkId' = ${clerkId}
          )`,
        )
        .limit(HISTORY_LIMIT),
      //  Memory Grid (PvP, clerkId-based — finished-only)
      db
        .select({
          player1Id: memoryGridMatches.player1Id,
          player2Id: memoryGridMatches.player2Id,
          stakeAmount: memoryGridMatches.stakeAmount,
          prizePaid: memoryGridMatches.prizePaid,
          winnerId: memoryGridMatches.winnerId,
          result: memoryGridMatches.result,
          status: memoryGridMatches.status,
          endedAt: memoryGridMatches.endedAt,
          createdAt: memoryGridMatches.createdAt,
        })
        .from(memoryGridMatches)
        .where(
          or(
            eq(memoryGridMatches.player1Id, clerkId),
            eq(memoryGridMatches.player2Id, clerkId),
          ),
        )
        .limit(HISTORY_LIMIT),
      //  Dice Flush (join players → rooms)
      db
        .select({
          userId: diceFlushPlayers.userId,
          roomWager: diceFlushRooms.wager,
          roomPot: diceFlushRooms.pot,
          roomStatus: diceFlushRooms.status,
          roomGameState: diceFlushRooms.gameState,
          roomCreatedAt: diceFlushRooms.createdAt,
        })
        .from(diceFlushPlayers)
        .innerJoin(diceFlushRooms, eq(diceFlushPlayers.roomId, diceFlushRooms.id))
        .where(eq(diceFlushPlayers.userId, clerkId))
        .limit(HISTORY_LIMIT),
      //  Mines Duel (PvP, clerkId-based, best-of-1 — only finished
      // matches contribute a win/loss; cancelled / in-flight matches
      // are excluded so the history never shows a misleading entry).
      db
        .select({
          player1Id: minesPvpMatches.player1Id,
          player2Id: minesPvpMatches.player2Id,
          stakeAmount: minesPvpMatches.stakeAmount,
          prizePaid: minesPvpMatches.prizePaid,
          winnerId: minesPvpMatches.winnerId,
          result: minesPvpMatches.result,
          status: minesPvpMatches.status,
          endedAt: minesPvpMatches.endedAt,
          createdAt: minesPvpMatches.createdAt,
        })
        .from(minesPvpMatches)
        .where(
          or(
            eq(minesPvpMatches.player1Id, clerkId),
            eq(minesPvpMatches.player2Id, clerkId),
          ),
        )
        .limit(HISTORY_LIMIT),
      //  Lane Rush Duel (PvP tower race — same shape as Mines Duel:
      // finished-only, winnerId-based outcome, draw refunds).
      db
        .select({
          player1Id: laneRushDuelMatches.player1Id,
          player2Id: laneRushDuelMatches.player2Id,
          stakeAmount: laneRushDuelMatches.stakeAmount,
          prizePaid: laneRushDuelMatches.prizePaid,
          winnerId: laneRushDuelMatches.winnerId,
          result: laneRushDuelMatches.result,
          status: laneRushDuelMatches.status,
          endedAt: laneRushDuelMatches.endedAt,
          createdAt: laneRushDuelMatches.createdAt,
        })
        .from(laneRushDuelMatches)
        .where(
          or(
            eq(laneRushDuelMatches.player1Id, clerkId),
            eq(laneRushDuelMatches.player2Id, clerkId),
          ),
        )
        .limit(HISTORY_LIMIT),
      //  Crash Arena — one entry per player per round (PvP tables AND
      //  free AI practice tables). Projection joins entries → rounds →
      //  tables so we can label AI practice rounds and compute the pot
      //  from the table wager.
      db
        .select({
          entryId: crashArenaEntries.id,
          result: crashArenaEntries.result,
          roundId: crashArenaEntries.roundId,
          roundStatus: crashArenaRounds.status,
          roundCreatedAt: crashArenaRounds.createdAt,
          tableIsAi: crashArenaTables.isAi,
          tableWager: crashArenaTables.wagerAmount,
        })
        .from(crashArenaEntries)
        .innerJoin(crashArenaRounds, eq(crashArenaEntries.roundId, crashArenaRounds.id))
        .innerJoin(crashArenaTables, eq(crashArenaRounds.tableId, crashArenaTables.id))
        .where(eq(crashArenaEntries.userId, uid))
        .limit(HISTORY_LIMIT),
    ]);

    // ── Crash Arena: how many entries each of the user's rounds had ───────
    // Pot = players × wager; the winner takes pot minus the 5% rake.
    const crashRoundIds = [
      ...new Set(crashArenaRows.map((r) => r.roundId).filter((id) => id != null)),
    ];
    let crashRoundPlayerCounts = new Map();
    if (crashRoundIds.length > 0) {
      const counts = await db
        .select({
          roundId: crashArenaEntries.roundId,
          count: sql<number>`count(*)`,
        })
        .from(crashArenaEntries)
        .where(inArray(crashArenaEntries.roundId, crashRoundIds))
        .groupBy(crashArenaEntries.roundId);
      crashRoundPlayerCounts = new Map(
        counts.map((c) => [c.roundId, Number(c.count ?? 0)]),
      );
    }

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

    const kenoFormatted = kenoRows.map((row) => {
      const amount = Number(row.bet_amount ?? 0);
      const payout = Number(row.payout ?? 0);
      const result = payout > 0 ? "won" : "lost";
      return {
        type: "Keno",
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
          type: "Dice Duel",
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
          type: "Connect Four",
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
          type: "Pool Masters",
          date: game.endedAt || game.createdAt || new Date().toISOString(),
          amount,
          payout,
          result,
          tokenDiff: result === "won" ? payout - amount : -amount,
        };
      })
      .filter(Boolean);

    //  Lane Runner — solo game with standard bet/payout/result
    const laneRunnerFormatted = laneRunnerRows
      .filter((g) => g.status === "completed")
      .map((g) => formatBet("Lane Runner", {
        betAmount: g.betAmount,
        payout: g.payout,
        result: g.result,
        createdAt: g.createdAt,
      }));

    //  Hex Duel — determine win/loss from winner field
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
          type: g.isAiGame ? "Hex Duel vs AI" : "Hex Duel",
          date: g.endedAt || g.createdAt || new Date().toISOString(),
          amount,
          payout,
          result,
          tokenDiff: result === "won" ? payout - amount : -amount,
        };
      });

    //  Odds — determine win/loss from winner field
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
          type: g.isAi ? "Odds vs AI" : "Odds",
          date: g.endedAt || g.createdAt || new Date().toISOString(),
          amount,
          payout,
          result,
          tokenDiff: result === "won" ? payout - amount : -amount,
        };
      });

    //  Poker — determine result from winnings jsonb or winner text
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
          type: "Poker",
          date: g.createdAt || new Date().toISOString(),
          amount,
          payout,
          result,
          tokenDiff: result === "won" ? payout - amount : -amount,
        };
      });

    //  Dice Flush — joined rows: dice_flush_players + dice_flush_rooms
    // (projection aliases the room columns as room*).
    const diceFlushFormatted = diceFlushRows
      .filter((row) => row.roomStatus === "finished")
      .map((row) => {
        const amount = Number(row.roomWager ?? 0);
        const gameState =
          row.roomGameState && typeof row.roomGameState === "object"
            ? (row.roomGameState as Record<string, unknown>)
            : {};
        const winnerId = gameState.winnerId as string | undefined;
        const result = winnerId
          ? winnerId === clerkId
            ? "won"
            : "lost"
          : "completed";
        const payout = result === "won" ? Number(row.roomPot ?? amount * 2) : 0;
        return {
          type: "Dice Flush",
          date: row.roomCreatedAt || new Date().toISOString(),
          amount,
          payout,
          result,
          tokenDiff: result === "won" ? payout - amount : -amount,
        };
      });

    //  Mines Duel — only finished matches count. Maps the
    // server-side `result` enum ('player1' | 'player2' | 'draw')
    // plus `winner_id` (null on draw) to a UI-friendly
    // won/lost/draw string. The 90/10 split means a winner's
    // payout is `stake * 1.9` and a loser's payout is 0; a draw
    // refunds both stakes (payout = stake, tokenDiff = 0). Named
    // `outcome` instead of `result` to avoid shadowing the server
    // row's `result` field in this scope (matches the style of
    // the dice/pool/connectFour formatters which don't shadow).
    // Memory Grid — same shape as Mines Duel: winner's payout is
    // `stake * 1.9`, a loser's is 0, and a draw refunds both stakes
    // (payout = stake, tokenDiff = 0).
    const memoryGridFormatted = memoryGridRows
      .map((g) => {
        if (g.status !== "finished") return null;
        const amount = Number(g.stakeAmount ?? 0);
        const payout = Number(g.prizePaid ?? 0);
        const isDraw = g.result === "draw" || !g.winnerId;
        const outcome = isDraw
          ? "draw"
          : g.winnerId === clerkId
            ? "won"
            : "lost";
        const tokenDiff =
          outcome === "won"
            ? payout - amount
            : outcome === "lost"
              ? -amount
              : 0;
        return {
          type: "Memory Grid",
          date: g.endedAt || g.createdAt || new Date().toISOString(),
          amount,
          payout,
          result: outcome,
          tokenDiff,
        };
      })
      .filter(Boolean);

    const minesPvpFormatted = minesPvpRows
      .map((g) => {
        if (g.status !== "finished") return null;
        const amount = Number(g.stakeAmount ?? 0);
        const payout = Number(g.prizePaid ?? 0);
        const isDraw = g.result === "draw" || !g.winnerId;
        const outcome = isDraw
          ? "draw"
          : g.winnerId === clerkId
            ? "won"
            : "lost";
        const tokenDiff =
          outcome === "won"
            ? payout - amount
            : outcome === "lost"
              ? -amount
              : 0;
        return {
          type: "Mines Duel",
          date: g.endedAt || g.createdAt || new Date().toISOString(),
          amount,
          payout,
          result: outcome,
          tokenDiff,
        };
      })
      .filter(Boolean);

    // Lane Rush Duel PvP matches — same shape as Mines Duel: the
    // winner's payout is `stake * 1.9`, a loser's is 0, and a draw
    // refunds both stakes (payout = stake, tokenDiff = 0).
    const laneRushDuelFormatted = laneRushDuelRows
      .map((g) => {
        // Test vs Bot practice matches are zero-stake — skip them so
        // history only shows real-money games.
        if (g.status !== "finished") return null;
        if (g.player2Id === "AI_BOT") return null;
        const amount = Number(g.stakeAmount ?? 0);
        const payout = Number(g.prizePaid ?? 0);
        const isDraw = g.result === "draw" || !g.winnerId;
        const outcome = isDraw
          ? "draw"
          : g.winnerId === clerkId
            ? "won"
            : "lost";
        const tokenDiff =
          outcome === "won"
            ? payout - amount
            : outcome === "lost"
              ? -amount
              : 0;
        return {
          type: "Lane Rush Duel",
          date: g.endedAt || g.createdAt || new Date().toISOString(),
          amount,
          payout,
          result: outcome,
          tokenDiff,
        };
      })
      .filter(Boolean);

    // Crash Arena — settled rounds only. AI practice rounds are labeled
    // "Crash Arena vs AI" (their amounts are virtual practice chips).
    const crashArenaFormatted = crashArenaRows
      .map((g) => {
        if (g.roundStatus !== "settled") return null;
        const amount = Number(g.tableWager ?? 0);
        const players = crashRoundPlayerCounts.get(g.roundId) ?? 0;
        const pot = players * amount;
        const rake = Math.floor(pot * 0.05);
        const won = g.result === "won";
        const payout = won ? pot - rake : 0;
        return {
          type: g.tableIsAi ? "Crash Arena vs AI" : "Crash Arena",
          date: g.roundCreatedAt || new Date().toISOString(),
          amount,
          payout,
          result: won ? "won" : "lost",
          tokenDiff: won ? payout - amount : -amount,
        };
      })
      .filter(Boolean);

    // Keno Duel PvP matches — winner's payout is `stake * 1.9` and a
    // loser's is 0; a draw refunds both stakes (payout = stake,
    // tokenDiff = 0). Mirrors the minesPvpFormatted shape.
    const kenoPvpFormatted = kenoPvpRows
      .map((g) => {
        if (g.status !== "finished") return null;
        const amount = Number(g.stakeAmount ?? 0);
        const payout = Number(g.prizePaid ?? 0);
        const isDraw = g.result === "draw" || !g.winnerId;
        const outcome = isDraw
          ? "draw"
          : g.winnerId === clerkId
            ? "won"
            : "lost";
        const tokenDiff =
          outcome === "won"
            ? payout - amount
            : outcome === "lost"
              ? -amount
              : 0;
        return {
          type: "Keno Duel",
          date: g.endedAt || g.createdAt || new Date().toISOString(),
          amount,
          payout,
          result: outcome,
          tokenDiff,
        };
      })
      .filter(Boolean);

    const allBets = [
    ...roulette.map((b) => formatBet("Roulette", b)),
    ...blackjack.map((b) => formatBet("Blackjack", b)),
    ...mines.map((b) => formatBet("Mines", b)),
    ...plinko.map((b) => formatBet("Plinko", b)),
    ...crash.map((b) => formatBet("Crash", b)),
    ...rps.map((b) => formatBet("Rock Paper Scissors", b)),
    ...uno.map((b) => formatBet("UNO", b)),
    ...chess.map((b) => formatBet("Chess", b)),
      ...kenoPvpFormatted,
      ...kenoFormatted,
      ...diceFormatted,
      ...poolFormatted,
      ...connectFourFormatted,
      ...laneRunnerFormatted,
      ...hexDuelFormatted,
      ...oddsFormatted,
      ...pokerFormatted,
      ...memoryGridFormatted,
      ...diceFlushFormatted,
      ...minesPvpFormatted,
      ...laneRushDuelFormatted,
      ...crashArenaFormatted,
    ].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    //  Cumulative stats (totalWagered, weeklyWagered, currentStreak, etc.)
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
