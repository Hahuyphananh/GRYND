import crypto from "node:crypto";
import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { db } from "../../../../db/client";
import { users } from "../../../../db/schema";
import { eq, sql } from "drizzle-orm";
import { CacheKeys, CacheTTL } from "../../../../lib/redis/keys";
import { cacheSet } from "../../../../lib/redis/cache";

export async function POST(req: Request) {
  try {
    const { userId: clerkId } = await auth();

    if (!clerkId) {
      return NextResponse.json(
        { success: false, error: "Unauthorized — please sign in" },
        { status: 401 }
      );
    }

    const body = await req.json();
    const wager = Number(body.wager);
    const isAiGame = body?.isAiGame === true;

    if (!Number.isFinite(wager) || wager <= 0) {
      return NextResponse.json(
        { success: false, error: "Invalid wager amount" },
        { status: 400 }
      );
    }

    // AI games are free play — no balance deduction, no `totalWagered`
    // bump. We still return the user's CURRENT balance (without any
    // deduction) so the client can keep its balance display accurate;
    // returning a sentinel would clobber the displayed balance to 0.
    //
    // We also mint a short-lived, single-use AI session token in Redis.
    // /api/hex-duel/end-game requires this token to honour the
    // `isAiGame: true` claim, so a player cannot forge an end-game
    // request to skip a PvP payout.
    if (isAiGame) {
      const [currentUser] = await db
        .select({ balance: users.balance })
        .from(users)
        .where(eq(users.clerkId, clerkId));
      const aiSessionId = crypto.randomUUID();
      // Best-effort cache write — if Redis is unavailable, /end-game
      // will see no matching session and fall back to treating the
      // request as PvP (i.e. fail closed). The game still plays fine;
      // the worst case is the user loses access to free-play treatment.
      //
      // We bind (userId, wager, aiDifficulty) to the token so /end-game
      // can refuse a forged end-game that simply re-uses an
      // intercepted aiSessionId with different game parameters. We
      // deliberately do NOT store `startedAt`: client and server
      // clocks can drift milliseconds apart and a strict equality
      // check there would 400 legitimate users.
      await cacheSet(
        CacheKeys.hexDuelAiSession(aiSessionId),
        {
          userId: clerkId,
          wager,
          aiDifficulty: body?.aiDifficulty ?? null,
        },
        CacheTTL.hexDuelAiSession,
      ).catch((err) => {
        console.error("[hex-duel] failed to store AI session token:", err);
      });
      return NextResponse.json({
        success: true,
        data: {
          wager,
          newBalance: currentUser ? Number(currentUser.balance) : 0,
          aiSessionId,
        },
      });
    }

    // Atomic: deduct wager only if balance is sufficient
    const [updatedUser] = await db
      .update(users)
      .set({
        balance: sql`${users.balance} - ${wager}`,
        totalWagered: sql`${users.totalWagered} + ${wager}`,
      })
      .where(
        sql`${users.clerkId} = ${clerkId} AND ${users.balance} >= ${wager}`
      )
      .returning({ balance: users.balance });

    if (!updatedUser) {
      return NextResponse.json(
        { success: false, error: "Insufficient balance" },
        { status: 400 }
      );
    }

    return NextResponse.json({
      success: true,
      data: {
        wager,
        newBalance: Number(updatedUser.balance),
      },
    });
  } catch (error) {
    console.error("❌ Hex Duel start-game error:", error);
    return NextResponse.json(
      {
        success: false,
        error: "Server error",
        details: error instanceof Error ? error.message : "Unknown",
      },
      { status: 500 }
    );
  }
}
