import { auth, currentUser } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { cashoutRound, ensureClickerUser } from "../../../../lib/goonbet-clicker-db";
import { recordBigWinIfNeeded } from "../../../../lib/bigWins";
import { applyLeaderboardCounters } from "../../../../lib/leaderboardCounters";
import { db } from "../../../../db";
import { clickerGames } from "../../../../db/schema";
import { sql } from "@vercel/postgres";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const { userId } = await auth();

  if (!userId) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401, headers: { "Cache-Control": "no-store" } }
    );
  }

  const clerkUser = await currentUser();

  await ensureClickerUser(userId, clerkUser?.emailAddresses?.[0]?.emailAddress ?? null);

  const body = await req.json().catch(() => ({}));

  const roundId = Number(body.roundId);
  if (!roundId) {
    return NextResponse.json(
      { error: "roundId required" },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  }

  try {
    const result = await cashoutRound(
      userId,
      roundId,
      Number(body.clientClicks ?? 0),
      Number(body.clientMultiplier ?? 1),
      Number(body.durationMs ?? 0)
    );

    // Track leaderboard stats
    const betAmount = Number(result.betAmount ?? 0);
    const payoutNumber = Number(result.payout);
    applyLeaderboardCounters({
      clerkId: userId,
      game: "GoonBet Clicker",
      betAmount: betAmount || 1,
      payout: payoutNumber,
    }).catch(() => {});

    // Persist clicker round history for bet-history / user-stats
    db.insert(clickerGames)
      .values({
        userId,
        betAmount: betAmount || 1,
        payout: payoutNumber,
        multiplier: String(result.multiplier || 1),
        busted: result.busted ?? false,
        clicks: Number(body.clientClicks ?? 0),
        durationMs: Number(body.durationMs ?? 0),
      })
      .catch((e) => console.error("Failed to insert clicker history:", e));

    // Record big win if payout >= 1 million tokens
    if (payoutNumber >= 1000000 && !result.busted) {
      // Get username for the big wins record
      const userResult = await sql`SELECT name FROM users WHERE clerk_id = ${userId} LIMIT 1`;
      const username = userResult.rows[0]?.name || "Unknown";

      recordBigWinIfNeeded({
        userId: userId,
        username: username,
        game: "GoonBet Clicker",
        betAmount: payoutNumber / Math.max(1, result.multiplier),
        winAmount: payoutNumber,
        multiplier: result.multiplier,
      }).catch(() => {}); // Fire and forget
    }

    return NextResponse.json(
      {
        ...result,
        payout: result.payout.toString(),
        betAmount: result.betAmount.toString(),
      },
      {
        headers: { "Cache-Control": "no-store" },
      }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "FAILED";
    const status = message === "ROUND_NOT_FOUND" || message === "ROUND_NOT_ACTIVE" ? 409 : 400;

    return NextResponse.json(
      { error: message },
      { status, headers: { "Cache-Control": "no-store" } }
    );
  }
}
