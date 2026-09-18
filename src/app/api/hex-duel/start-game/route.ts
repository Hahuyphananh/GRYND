import crypto from "node:crypto";
import { auth } from "@clerk/nextjs/server";
import { requireAgeVerifiedUser } from "../../../../lib/auth/requireAgeVerified";
import { NextResponse } from "next/server";
import { db } from "../../../../db/client";
import { users } from "../../../../db/schema";
import { and, eq, gte, sql } from "drizzle-orm";
import { CacheKeys, CacheTTL } from "../../../../lib/redis/keys";
import { cacheSet } from "../../../../lib/redis/cache";

export async function POST(req: Request) {
  try {
    const gate = await requireAgeVerifiedUser();
    if (gate.response) return gate.response;

    const { userId: clerkId } = await auth();

    if (!clerkId) {
      return NextResponse.json(
        { success: false, error: "Unauthorized. Please sign in" },
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
    // Global bet cap (must match GLOBAL_MAX_BET in src/lib/games/economy.ts).
    if (wager > 100000) {
      return NextResponse.json(
        { success: false, error: "Wager exceeds the maximum of 100,000 tokens" },
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

    // Atomic: deduct wager only if balance is sufficient.
    // The raw `sql\`${users.clerkId} = ${clerkId} AND ${users.balance} >= ${wager}\``
    // template was replaced with typed `and(eq(...), gte(...))` because
    // multi-column raw sql templates have parameter-binder fragility
    // under `drizzle-orm/neon-serverless` and were the root cause of
    // 500s on the sibling `multiplayer/actions/route.ts`.
    const [updatedUser] = await db
      .update(users)
      .set({
        // Sql templates for SET-clause arithmetic (single column)
        // are kept \u2014 the binder fragility is specific to multi-column
        // comparison WHERE clauses, not to arithmetic expressions.
        balance: sql`${users.balance} - ${wager}`,
        totalWagered: sql`${users.totalWagered} + ${wager}`,
      })
      .where(
        // users.balance is declared as numeric(30, 2) in schema.ts,
        // which Drizzle types as `string` (precision overflows JS
        // number safety). gte() therefore refuses a JS number; pass
        // the wager as a fixed-2 string to match the column's scale.
        and(eq(users.clerkId, clerkId), gte(users.balance, wager.toFixed(2)))
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
    console.error(" Hex Duel start-game error:", error);
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
