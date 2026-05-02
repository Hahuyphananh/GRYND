import { auth } from "@clerk/nextjs/server";
import { neon } from "@neondatabase/serverless";
import { getLevelProgress, getUserLevel  } from "../../../lib/vipLevels";
import { getHighestTitle } from "../../../lib/titles";

// 👇 ADD THESE (from your history route)
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
  diceMatches,
  connectFourGames,
} from "../../../db/schema";

const sql = neon(process.env.DATABASE_URL);

export async function GET() {
  const { userId } = await auth();

  if (!userId) {
    return new Response(JSON.stringify({ success: false, error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    // ✅ Get DB user
    const dbUser = await db.query.users.findFirst({
      where: eq(users.clerkId, userId),
    });

    if (!dbUser) {
      return new Response(JSON.stringify({ success: false, error: "User not found" }), {
        status: 404,
      });
    }

    const uid = dbUser.id;
    const clerkId = userId;

    // ✅ Fetch all bets
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
      connectFourRows,
    ] = await Promise.all([
      db.select().from(rouletteGames).where(eq(rouletteGames.userId, uid)),
      db.select().from(blackjackGames).where(eq(blackjackGames.userId, uid)),
      db.select().from(minesGames).where(eq(minesGames.userId, uid)),
      db.select().from(plinkoGames).where(eq(plinkoGames.userId, userId)),
      db.select().from(crashGames).where(eq(crashGames.userId, uid)),
      db.select().from(rpsGames).where(eq(rpsGames.userId, clerkId)),
      db.select().from(unoGames).where(eq(unoGames.userId, uid)),
      db.select().from(chessGames).where(
        or(eq(chessGames.playerWhiteId, clerkId), eq(chessGames.playerBlackId, clerkId))
      ),
      db.select().from(sportsBets).where(eq(sportsBets.userId, uid)),
      db.select().from(slotGames).where(eq(slotGames.userId, userId)),
      db.select().from(coinFlipGames).where(
        or(eq(coinFlipGames.player1Id, clerkId), eq(coinFlipGames.player2Id, clerkId))
      ),
      db.select().from(keno_games).where(eq(keno_games.user_id, uid)),
      db.select().from(diceMatches).where(
  or(
    eq(diceMatches.player1Id, clerkId),
    eq(diceMatches.player2Id, clerkId)
  )
),
      db.select().from(connectFourGames).where(
  or(
    eq(connectFourGames.hostClerkId, clerkId),
    eq(connectFourGames.guestClerkId, clerkId)
  )
),
    ]);

    // ✅ SIMPLE formatter (light version)
    const normalize = (bets, type) =>
      bets.map((b) => {
        const amount = Number(b.betAmount || b.bet_amount || b.amount || 0);
        const payout = Number(b.payout ?? 0);

        let result = "lost";
        if (payout > amount) result = "won";
        if (payout === amount) result = "tie";

        return { type, amount, payout, result, tokenDiff: payout - amount };
      });

 const connectFourNormalized = connectFourRows
  .map((game) => {
    if (!game.winnerClerkId) return null; // ✅ ignore unfinished games

    const amount = Number(game.betAmount ?? 0);
    const payout = Number(game.payout ?? 0);

    const result =
      game.winnerClerkId === clerkId ? "won" : "lost";

    return {
      type: "Connect Four",
      amount,
      payout,
      result,
      tokenDiff:
        result === "won" ? payout - amount : -amount,
    };
  })
  .filter(Boolean); // ✅ removes nulls);

  const diceNormalized = diceRows
  .map((game) => {
    if (game.status !== "finished" && game.status !== "completed") return null;
    if (!game.winnerId) return null;

    const amount = Number(game.wager || 0);
    const payout = Number(game.prizePaid || 0);

    const result =
      game.winnerId === clerkId ? "won" : "lost";

    return {
      type: "Dice Duel",
      amount,
      payout,
      result,
      tokenDiff:
        result === "won"
          ? payout - amount
          : -amount,
    };
  })
  .filter(Boolean);

    const allBets = [
      ...normalize(roulette, "Roulette"),
      ...normalize(blackjack, "Blackjack"),
      ...normalize(mines, "Mines"),
      ...normalize(plinko, "Plinko"),
      ...normalize(crash, "Crash"),
      ...normalize(rps, "RPS"),
      ...normalize(uno, "UNO"),
      ...normalize(chess, "Chess"),
      ...normalize(sports, "Sports"),
      ...normalize(slots, "Slots"),
      ...normalize(coinflipRows, "Coinflip"),
      ...normalize(kenoRows, "Keno"),
      ...diceNormalized,
      ...connectFourNormalized,
    ];

    // ✅ COMPUTE STATS
    const totalBets = allBets.length;
    const wins = allBets.filter(b => b.result === "won").length;
    const losses = allBets.filter(b => b.result === "lost").length;

    const winRate = totalBets > 0 ? (wins / totalBets) * 100 : 0;

    const biggestWin = Math.max(0, ...allBets.map(b => b.tokenDiff || 0));
    const totalWagered = allBets.reduce((sum, b) => sum + b.amount, 0);

    const gameCount = {};
    for (const b of allBets) {
      gameCount[b.type] = (gameCount[b.type] || 0) + 1;
    }

    const favoriteGame =
      Object.entries(gameCount).sort((a, b) => b[1] - a[1])[0]?.[0] || "N/A";

    // ✅ UPSERT INTO user_stats
    await sql`
      INSERT INTO user_stats (
        user_id,
        total_bets,
        wins,
        losses,
        win_rate,
        biggest_win,
        favorite_game
      )
      VALUES (
        ${uid},
        ${totalBets},
        ${wins},
        ${losses},
        ${winRate},
        ${biggestWin},
        ${favoriteGame}
      )
      ON CONFLICT (user_id)
      DO UPDATE SET
        total_bets = EXCLUDED.total_bets,
        wins = EXCLUDED.wins,
        losses = EXCLUDED.losses,
        win_rate = EXCLUDED.win_rate,
        biggest_win = EXCLUDED.biggest_win,
        favorite_game = EXCLUDED.favorite_game;
    `;

    // ✅ Get user meta (level, referrals)
    const rows = await sql`
      SELECT
        referral_code,
        referral_count,
        referral_earnings,
        total_wagered,
        level
      FROM users
      WHERE clerk_id = ${userId}
      LIMIT 1
    `;

    const row = rows[0];

const computedLevel = getUserLevel(totalWagered);
const progress = getLevelProgress(totalWagered);
const computedHighestTitle = getHighestTitle(computedLevel)?.title || null;

await sql`
  UPDATE users
  SET level = ${computedLevel},
      total_wagered = ${totalWagered},
      highest_title = COALESCE(${computedHighestTitle}, highest_title)
  WHERE clerk_id = ${userId}
`;

    return new Response(JSON.stringify({
      success: true,
      stats: {
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
      },
    }), { status: 200 });

  } catch (error) {
    console.error("[USER_STATS_ERROR]", error);
    return new Response(JSON.stringify({ success: false, error: "Failed to load stats" }), {
      status: 500,
    });
  }
}