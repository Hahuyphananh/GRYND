import { auth } from "@clerk/nextjs/server";
import { getNeonSql } from "../../../db/neon";
import { getBattlepassProgress, getLevelFromXp } from "../../../lib/battlepass";
import { getHighestTitle } from "../../../lib/titles";
import { cacheOrFetch } from "../../../lib/redis/cache";
import { CacheKeys, CacheTTL } from "../../../lib/redis/keys";

//  ADD THESE (from your history route)
import { db } from "../../../db";
import { eq, or, and, sql as drizzleSql } from "drizzle-orm";
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
  laneRushDuelMatches,
  memoryGridMatches,
  fourInARowGames,
  laneRunnerGames,
  hexDuelGames,
  oddsGames,
  pokerGames,
  diceFlushRooms,
  diceFlushPlayers,
} from "../../../db/schema";

// Cap each table's contribution so the per-user fetch stays bounded. Unlike
// the 200-row get-bet-history cap (a UI list), this route computes aggregate
// stats, so it needs headroom to stay accurate for heavy players — 1000 rows
// per game type covers even extreme play while bounding the response.
// The route is Redis-cached (CacheTTL.userStats), so the recompute cost only
// lands on cache misses.
const HISTORY_LIMIT = 1000;

export async function GET() {
  const { userId } = await auth();

  if (!userId) {
    return new Response(
      JSON.stringify({ success: false, error: "Unauthorized" }),
      {
        status: 401,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  try {
    //  Get DB connections inside try so failures don't 500 outside the catch
    const sql = getNeonSql();

    //  Get DB user
    const dbUser = await db.query.users.findFirst({
      where: eq(users.clerkId, userId),
    });

    if (!dbUser) {
      return new Response(
        JSON.stringify({ success: false, error: "User not found" }),
        {
          status: 404,
        },
      );
    }

    const uid = dbUser.id;
    const clerkId = userId;
    const cacheKey = CacheKeys.userStats(clerkId);

    // Cache the heavy stat computation. Side-effect writes happen only on miss.
    const stats = await cacheOrFetch(cacheKey, CacheTTL.userStats, async () => {

    //  Fetch all bets – each query wrapped so one failure doesn't tank the request
    const safeQuery = async (label, fn) => {
      try {
        return await fn();
      } catch (err) {
        console.error(`[user-stats] Query failed for ${label}:`, err);
        return [];
      }
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
      fourInARowRows,
      laneRunnerRows,
      hexDuelRows,
      oddsRows,
      pokerRows,
      diceFlushRows,
      laneRushDuelRows,
      memoryGridRows,
    ] = await Promise.all([
      // Column projection + per-table LIMIT. The formatters below only read
      // a handful of fields per row; full-row selects shipped every table's
      // deck/hand/seed/state columns across the wire. LIMIT caps pathological
      // histories (a bot or heavy grinder) while staying accurate for real
      // players — see HISTORY_LIMIT above.
      safeQuery("roulette", () =>
        db
          .select({
            betAmount: rouletteGames.betAmount,
            payout: rouletteGames.payout,
          })
          .from(rouletteGames)
          .where(eq(rouletteGames.userId, uid))
          .limit(HISTORY_LIMIT),
      ),
      safeQuery("blackjack", () =>
        db
          .select({
            betAmount: blackjackGames.betAmount,
            payout: blackjackGames.payout,
          })
          .from(blackjackGames)
          .where(eq(blackjackGames.userId, uid))
          .limit(HISTORY_LIMIT),
      ),
      safeQuery("mines", () =>
        db
          .select({
            betAmount: minesGames.betAmount,
            payout: minesGames.payout,
          })
          .from(minesGames)
          .where(eq(minesGames.userId, uid))
          .limit(HISTORY_LIMIT),
      ),
      safeQuery("plinko", () =>
        db
          .select({
            betAmount: plinkoGames.betAmount,
            payout: plinkoGames.payout,
          })
          .from(plinkoGames)
          .where(eq(plinkoGames.userId, userId))
          .limit(HISTORY_LIMIT),
      ),
      safeQuery("crash", () =>
        db
          .select({
            betAmount: crashGames.betAmount,
            payout: crashGames.payout,
          })
          .from(crashGames)
          .where(eq(crashGames.userId, uid))
          .limit(HISTORY_LIMIT),
      ),
      safeQuery("rps", () =>
        db
          .select({
            betAmount: rpsGames.betAmount,
            payout: rpsGames.payout,
          })
          .from(rpsGames)
          .where(eq(rpsGames.userId, clerkId))
          .limit(HISTORY_LIMIT),
      ),
      safeQuery("uno", () =>
        db
          .select({
            betAmount: unoGames.betAmount,
            payout: unoGames.payout,
          })
          .from(unoGames)
          .where(eq(unoGames.userId, uid))
          .limit(HISTORY_LIMIT),
      ),
      safeQuery("chess", () =>
        db
          .select({
            betAmount: chessGames.betAmount,
            payout: chessGames.payout,
          })
          .from(chessGames)
          .where(
            or(
              eq(chessGames.playerWhiteId, clerkId),
              eq(chessGames.playerBlackId, clerkId),
            ),
          )
          .limit(HISTORY_LIMIT),
      ),
      safeQuery("keno-pvp", () =>
        db
          .select({
            status: kenoPvpMatches.status,
            winnerId: kenoPvpMatches.winnerId,
            stakeAmount: kenoPvpMatches.stakeAmount,
            prizePaid: kenoPvpMatches.prizePaid,
          })
          .from(kenoPvpMatches)
          .where(
            or(
              eq(kenoPvpMatches.player1Id, clerkId),
              eq(kenoPvpMatches.player2Id, clerkId),
            ),
          )
          .limit(HISTORY_LIMIT),
      ),
      safeQuery("keno", () =>
        db
          .select({
            bet_amount: keno_games.bet_amount,
            payout: keno_games.payout,
          })
          .from(keno_games)
          .where(eq(keno_games.user_id, uid))
          .limit(HISTORY_LIMIT),
      ),
      safeQuery("four-in-a-row", () =>
        db
          .select({
            winnerClerkId: fourInARowGames.winnerClerkId,
            betAmount: fourInARowGames.betAmount,
            payout: fourInARowGames.payout,
          })
          .from(fourInARowGames)
          .where(
            or(
              eq(fourInARowGames.hostClerkId, clerkId),
              eq(fourInARowGames.guestClerkId, clerkId),
            ),
          )
          .limit(HISTORY_LIMIT),
      ),
      //  Lane Runner (solo, integer userId)
      safeQuery("lane-runner", () =>
        db
          .select({
            status: laneRunnerGames.status,
            betAmount: laneRunnerGames.betAmount,
            payout: laneRunnerGames.payout,
          })
          .from(laneRunnerGames)
          .where(eq(laneRunnerGames.userId, uid))
          .limit(HISTORY_LIMIT),
      ),
      safeQuery("lane-rush-duel", () =>
        db
          .select({
            status: laneRushDuelMatches.status,
            player2Id: laneRushDuelMatches.player2Id,
            winnerId: laneRushDuelMatches.winnerId,
            stakeAmount: laneRushDuelMatches.stakeAmount,
            prizePaid: laneRushDuelMatches.prizePaid,
          })
          .from(laneRushDuelMatches)
          .where(
            or(
              eq(laneRushDuelMatches.player1Id, clerkId),
              eq(laneRushDuelMatches.player2Id, clerkId),
            ),
          )
          .limit(HISTORY_LIMIT),
      ),
      //  Memory Grid (PvP, clerkId-based)
      safeQuery("memory-grid", () =>
        db
          .select({
            status: memoryGridMatches.status,
            result: memoryGridMatches.result,
            winnerId: memoryGridMatches.winnerId,
            stakeAmount: memoryGridMatches.stakeAmount,
            prizePaid: memoryGridMatches.prizePaid,
          })
          .from(memoryGridMatches)
          .where(
            or(
              eq(memoryGridMatches.player1Id, clerkId),
              eq(memoryGridMatches.player2Id, clerkId),
            ),
          )
          .limit(HISTORY_LIMIT),
      ),
      //  Hex Duel (PvP + AI, clerkId-based, skip fun mode)
      safeQuery("hex-duel", () =>
        db
          .select({
            status: hexDuelGames.status,
            wagerAmount: hexDuelGames.wagerAmount,
            payout: hexDuelGames.payout,
            player1Id: hexDuelGames.player1Id,
            winner: hexDuelGames.winner,
            isAiGame: hexDuelGames.isAiGame,
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
      ),
      //  Odds (PvP + AI, clerkId-based)
      safeQuery("odds", () =>
        db
          .select({
            status: oddsGames.status,
            wager: oddsGames.wager,
            payout: oddsGames.payout,
            player1Id: oddsGames.player1Id,
            winner: oddsGames.winner,
            isAi: oddsGames.isAi,
          })
          .from(oddsGames)
          .where(
            or(
              eq(oddsGames.player1Id, clerkId),
              eq(oddsGames.player2Id, clerkId),
            ),
          )
          .limit(HISTORY_LIMIT),
      ),
      //  Poker (multiplayer, jsonb players array)
      // Guard against legacy rows where `players` is null or a non-array
      // jsonb value; jsonb_array_elements on a non-array would throw
      // "cannot extract elements from a scalar/object" and 500 the route.
      safeQuery("poker", () =>
        db
          .select({
            players: pokerGames.players,
            winnings: pokerGames.winnings,
            betAmount: pokerGames.betAmount,
            payout: pokerGames.payout,
            status: pokerGames.status,
          })
          .from(pokerGames)
          .where(
            drizzleSql`exists (
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
      ),
      //  Dice Flush (join players → rooms; room columns aliased as room*)
      safeQuery("dice-flush", () =>
        db
          .select({
            userId: diceFlushPlayers.userId,
            roomWager: diceFlushRooms.wager,
            roomPot: diceFlushRooms.pot,
            roomStatus: diceFlushRooms.status,
            roomGameState: diceFlushRooms.gameState,
          })
          .from(diceFlushPlayers)
          .innerJoin(diceFlushRooms, eq(diceFlushPlayers.roomId, diceFlushRooms.id))
          .where(eq(diceFlushPlayers.userId, clerkId))
          .limit(HISTORY_LIMIT),
      ),
    ]);

    //  SIMPLE formatter (light version)
    const normalize = (bets, type) =>
      bets.map((b) => {
        const amount = Number(b.betAmount || b.bet_amount || b.amount || 0);
        const payout = Number(b.payout ?? 0);

        let result = "lost";
        if (payout > amount) result = "won";
        if (payout === amount) result = "tie";

        return { type, amount, payout, result, tokenDiff: payout - amount };
      });

    const fourInARowNormalized = fourInARowRows
      .map((game) => {
        if (!game.winnerClerkId) return null; // ignore unfinished games

        const amount = Number(game.betAmount ?? 0);
        const payout = Number(game.payout ?? 0);

        const result = game.winnerClerkId === clerkId ? "won" : "lost";

        return {
          type: "Four-In-A-Row",
          amount,
          payout,
          result,
          tokenDiff: result === "won" ? payout - amount : -amount,
        };
      })
      .filter(Boolean); // removes nulls);

    //  Keno Duel (PvP) — finished matches only; winner determined by
    // the match's winnerId (a draw refunds both, so no winner column).
    const kenoPvpNormalized = kenoPvpRows
      .map((game) => {
        if (game.status !== "finished") return null;
        if (!game.winnerId) return null; // draw
        const amount = Number(game.stakeAmount || 0);
        const payout = Number(game.prizePaid || 0);
        const result = game.winnerId === clerkId ? "won" : "lost";
        return {
          type: "Keno Duel",
          amount,
          payout,
          result,
          tokenDiff: result === "won" ? payout - amount : -amount,
        };
      })
      .filter(Boolean);

    //  Lane Runner — solo game, filter completed only
    const laneRunnerNormalized = normalize(
      laneRunnerRows.filter((g) => g.status === "completed"),
      "Lane Runner",
    );

    //  Lane Rush Duel (PvP) — finished matches only; winner
    //  determined by the match's winnerId (a draw refunds both).
    // Memory Grid — winner takes 1.9×, loser 0, draw refunds both
    const memoryGridNormalized = memoryGridRows
      .map((game) => {
        if (game.status !== "finished") return null;
        const amount = Number(game.stakeAmount || 0);
        const payout = Number(game.prizePaid || 0);
        const isDraw = game.result === "draw" || !game.winnerId;
        const outcome = isDraw
          ? "draw"
          : game.winnerId === clerkId
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
          amount,
          payout,
          result: outcome,
          tokenDiff,
        };
      })
      .filter(Boolean);

    const laneRushDuelNormalized = laneRushDuelRows
      .map((game) => {
        if (game.status !== "finished") return null;
        if (game.player2Id === "AI_BOT") return null; // practice
        if (!game.winnerId) return null; // draw
        const amount = Number(game.stakeAmount || 0);
        const payout = Number(game.prizePaid || 0);
        const result = game.winnerId === clerkId ? "won" : "lost";
        return {
          type: "Lane Rush Duel",
          amount,
          payout,
          result,
          tokenDiff: result === "won" ? payout - amount : -amount,
        };
      })
      .filter(Boolean);

    //  Hex Duel — determine win/loss from winner field
    const hexDuelNormalized = hexDuelRows
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
          amount,
          payout,
          result,
          tokenDiff: result === "won" ? payout - amount : -amount,
        };
      });

    //  Odds — determine win/loss from winner field
    const oddsNormalized = oddsRows
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
          amount,
          payout,
          result,
          tokenDiff: result === "won" ? payout - amount : -amount,
        };
      });

    //  Poker — determine result from winnings jsonb
    const pokerNormalized = pokerRows
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
          amount,
          payout,
          result,
          tokenDiff: result === "won" ? payout - amount : -amount,
        };
      });

    //  Dice Flush — joined rows, extract winner from gameState
    // (projection aliases the room columns as room*).
    const diceFlushNormalized = diceFlushRows
      .filter((row) => row.roomStatus === "finished")
      .map((row) => {
        const amount = Number(row.roomWager ?? 0);
        const gameState =
          row.roomGameState && typeof row.roomGameState === "object"
            ? row.roomGameState
            : {};
        const winnerId = gameState.winnerId;
        const result = winnerId
          ? winnerId === clerkId
            ? "won"
            : "lost"
          : "completed";
        const payout = result === "won" ? Number(row.roomPot ?? amount * 2) : 0;
        return {
          type: "Dice Flush",
          amount,
          payout,
          result,
          tokenDiff: result === "won" ? payout - amount : -amount,
        };
      });

    const allBets = [
      ...normalize(roulette, "Roulette"),
      ...normalize(blackjack, "Blackjack"),
      ...normalize(mines, "Mines"),
      ...normalize(plinko, "Plinko"),
      ...normalize(crash, "Crash"),
      ...normalize(rps, "RPS"),
      ...normalize(uno, "UNO"),
      ...normalize(chess, "Chess"),
      ...kenoPvpNormalized,
      ...normalize(kenoRows, "Keno"),
      ...fourInARowNormalized,
      ...laneRushDuelNormalized,
      ...laneRunnerNormalized,
      ...hexDuelNormalized,
      ...memoryGridNormalized,
      ...oddsNormalized,
      ...pokerNormalized,
      ...diceFlushNormalized,
    ];

    //  COMPUTE STATS
    const totalBets = allBets.length;
    const wins = allBets.filter((b) => b.result === "won").length;
    const losses = allBets.filter((b) => b.result === "lost").length;

    const winRate = totalBets > 0 ? (wins / totalBets) * 100 : 0;

    // Use a reduce loop instead of `Math.max(...arr)` to avoid RangeError on huge bet histories.
    const biggestWin = allBets.reduce(
      (m, b) => Math.max(m, Number(b.tokenDiff) || 0),
      0,
    );
    const totalWagered = allBets.reduce((sum, b) => sum + b.amount, 0);

    const gameCount = {};
    for (const b of allBets) {
      gameCount[b.type] = (gameCount[b.type] || 0) + 1;
    }

    const favoriteGame =
      Object.entries(gameCount).sort((a, b) => b[1] - a[1])[0]?.[0] || "N/A";

    // Only update favorite_game (the one stat that applyLeaderboardCounters doesn't track).
    // All other stats (total_bets, wins, losses, win_rate, biggest_win, etc.) are maintained
    // incrementally by applyLeaderboardCounters in leaderboardCounters.js and must NOT be
    // overwritten here — doing so would corrupt all-time values relative to weekly counters
    // and cause weekly > all-time. The stats computed above are for read-only display only.
    //
    // Write operations are fire-and-forget — they must not fail the request.
    try {
      await sql`
        INSERT INTO user_stats (user_id, favorite_game)
        VALUES (${uid}, ${favoriteGame})
        ON CONFLICT (user_id)
        DO UPDATE SET favorite_game = EXCLUDED.favorite_game;
      `;
    } catch (writeErr) {
      console.error("[user-stats] Failed to update user_stats:", writeErr);
    }

    //  Get user meta (level, referrals)
    let row = null;
    try {
      const rows = await sql`
        SELECT
          referral_code,
          referral_count,
          referral_earnings,
          total_wagered,
          xp
        FROM users
        WHERE clerk_id = ${userId}
        LIMIT 1
      `;
      row = rows[0];
    } catch (selectErr) {
      console.error("[user-stats] Failed to fetch user meta:", selectErr);
    }

    // Battlepass level comes from EXP (wagering + quest claims), NOT total
    // wagered. The level/xp columns are maintained incrementally by
    // applyLeaderboardCounters (per settled bet) and addExp (per quest
    // claim); we only derive the display values here and must NOT
    // overwrite level — that would clobber quest-earned progress.
    const userXp = Math.max(0, Math.floor(Number(row?.xp) || 0));
    const computedLevel = getLevelFromXp(userXp);
    const progress = getBattlepassProgress(userXp);
    const computedHighestTitle = getHighestTitle(computedLevel)?.title || null;

    // Titles still unlock by level — keep the highest unlocked title in
    // sync with the battlepass level.
    try {
      await sql`
        UPDATE users
        SET highest_title = COALESCE(${computedHighestTitle}, highest_title)
        WHERE clerk_id = ${userId}
      `;
    } catch (updateErr) {
      console.error("[user-stats] Failed to update highest title:", updateErr);
    }

    // Leaderboard-style record — the exact columns the leaderboard boards
    // read (user_stats + users), so the profile's stat tabs show the same
    // data as the /classement leaderboards. pvp_wins lives on users only.
    let record = null;
    try {
      const recordRows = await sql`
        SELECT
          COALESCE(s.wins, 0)::int AS wins,
          COALESCE(s.losses, 0)::int AS losses,
          COALESCE(s.total_bets, 0)::int AS games,
          COALESCE(s.win_rate, 0)::numeric AS win_rate,
          COALESCE(s.best_streak, 0)::int AS best_streak,
          COALESCE(s.current_streak, 0)::int AS current_streak,
          COALESCE(s.biggest_win, 0)::numeric AS biggest_win,
          COALESCE(s.favorite_game, 'N/A') AS favorite_game,
          COALESCE(u.pvp_wins, 0)::int AS pvp_wins,
          COALESCE(s.weekly_wins, 0)::int AS weekly_wins,
          COALESCE(s.weekly_losses, 0)::int AS weekly_losses,
          COALESCE(s.weekly_win_rate, 0)::numeric AS weekly_win_rate,
          COALESCE(s.weekly_best_streak, 0)::int AS weekly_best_streak,
          COALESCE(s.weekly_game_streak, 0)::int AS weekly_current_streak,
          COALESCE(s.weekly_biggest_win, 0)::numeric AS weekly_biggest_win,
          COALESCE(s.daily_streak_current, 0)::int AS daily_streak_current,
          COALESCE(s.daily_streak_best, 0)::int AS daily_streak_best,
          COALESCE(s.weekly_streak_current, 0)::int AS weekly_streak_current,
          COALESCE(s.weekly_streak_best, 0)::int AS weekly_streak_best
        FROM user_stats s
        INNER JOIN users u ON u.id = s.user_id
        WHERE s.user_id = ${uid}
        LIMIT 1
      `;
      record = recordRows[0] || null;
    } catch (recordErr) {
      console.error("[user-stats] Failed to fetch leaderboard record:", recordErr);
    }

      const statsResult = {
        totalBets,
        totalWins: wins,
        totalLosses: losses,
        winRate,
        biggestWin,
        favoriteGame,
        referrals: Number(row?.referral_count || 0),
        referralEarnings: Number(row?.referral_earnings || 0),
        referralCode: row?.referral_code || "",
        totalWagered,
        currentLevel: computedLevel,
        levelProgress: progress,
        // Same shape as the leaderboard boards — feeds the profile's
        // tabbed stat panel (UserStatsTabs).
        record,
      };

      return statsResult;
    });

    return new Response(
      JSON.stringify({
        success: true,
        stats,
      }),
      { status: 200, headers: { "Cache-Control": "private, s-maxage=120, stale-while-revalidate=60" } },
    );
  } catch (error) {
    console.error("[USER_STATS_ERROR]", error);
    return new Response(
      JSON.stringify({ success: false, error: "Failed to load stats" }),
      {
        status: 500,
      },
    );
  }
}
