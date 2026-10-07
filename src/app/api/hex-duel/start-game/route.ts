import crypto from "node:crypto";
import { auth } from "@clerk/nextjs/server";
import { requireAgeVerifiedUser } from "../../../../lib/auth/requireAgeVerified";
import { requirePracticePlayer } from "../../../../lib/auth/guestSession";
import { NextResponse } from "next/server";
import { db } from "../../../../db/client";
import { users } from "../../../../db/schema";
import { eq } from "drizzle-orm";
import { CacheKeys, CacheTTL } from "../../../../lib/redis/keys";
import { cacheSet } from "../../../../lib/redis/cache";
import { normalizeStake } from "../../../../lib/games/stakes";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    // STAKES ARE RETIRED (src/lib/games/stakes.js): a hex duel is free to
    // start. The requested wager is normalized to 0, so the atomic debit below
    // is a no-op whether the match is PvP or vs AI.
    const wager = normalizeStake(body.wager);
    const isAiGame = body?.isAiGame === true;

    // Free practice (vs AI) is open to signed-out guests: the match is
    // unrated and moves no tokens, so there is nothing to gate. The caller
    // becomes a `guest_<uuid>` identity via the HMAC-signed cookie. PvP
    // matchmaking keeps the full account + 18+ gate.
    if (isAiGame) {
      const gate = await requirePracticePlayer({ create: true });
      if (gate.response) return gate.response;
      const clerkId = gate.playerId as string;

      const [currentUser] = await db
        .select({ balance: users.balance })
        .from(users)
        .where(eq(users.clerkId, clerkId));
      const aiSessionId = crypto.randomUUID();
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
          // A guest owns no `users` row, so there is no balance to report.
          newBalance: currentUser ? Number(currentUser.balance) : 0,
          aiSessionId,
        },
      });
    }

    // ── PvP: account + age gate, unchanged ────────────────────────────
    const gate = await requireAgeVerifiedUser();
    if (gate.response) return gate.response;

    const { userId: clerkId } = await auth();

    if (!clerkId) {
      return NextResponse.json(
        { success: false, error: "Unauthorized. Please sign in" },
        { status: 401 }
      );
    }

    // AI games are free play — no balance deduction, no `totalWagered`
    // bump. We still return the user's CURRENT balance (without any
    // deduction) so the client can keep its balance display accurate;
    // returning a sentinel would clobber the displayed balance to 0.
    //
    // STAKES ARE RETIRED: the match is free, so no wager is deducted.
    return NextResponse.json({
      success: true,
      data: {
        wager,
        newBalance: 0,
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
