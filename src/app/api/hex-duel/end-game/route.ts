import { auth, currentUser } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { db } from "../../../../db/client";
import { hexDuelGames, users } from "../../../../db/schema";
import { eq, sql } from "drizzle-orm";
import { recordBigWinIfNeeded } from "../../../../lib/bigWins";
import { applyLeaderboardCounters } from "../../../../lib/leaderboardCounters";
import { CacheKeys } from "../../../../lib/redis/keys";
import { cacheDelete, cacheGet } from "../../../../lib/redis/cache";

const PAYOUT_MULTIPLIER = 1.9; // 5% house edge

/**
 * AI session payload stored in Redis at start-game time.
 * `end-game` re-reads it (and deletes it) to confirm the caller
 * actually started a Hex Duel AI match — defeating forged
 * `isAiGame: true` claims on PvP end-game requests.
 *
 * We deliberately do NOT cache `startedAt` — the client and server
 * clocks can drift milliseconds apart and a strict equality check
 * would 400 legitimate users. The 15-min TTL + atomic consume
 * already bound replay tightly enough.
 */
interface HexDuelAiSessionPayload {
  userId: string;
  wager: number;
  aiDifficulty: string | null;
}

export async function POST(req: Request) {
  try {
    const { userId: clerkId } = await auth();

    if (!clerkId) {
      return NextResponse.json(
        { success: false, error: "Unauthorized. Please sign in" },
        { status: 401 }
      );
    }

    const body = await req.json();
    const {
      wager,
      winner,
      isFunMode,
      isAiGame,
      aiDifficulty,
      player1Moves,
      player2Moves,
      player1Territory,
      player2Territory,
      durationSeconds,
      startedAt,
      aiSessionId,
    } = body as {
      wager: unknown;
      winner: string;
      isFunMode?: boolean;
      isAiGame?: boolean;
      aiDifficulty?: string | null;
      player1Moves?: number;
      player2Moves?: number;
      player1Territory?: number;
      player2Territory?: number;
      durationSeconds?: number;
      startedAt?: string;
      /** Single-use token issued by /api/hex-duel/start-game for AI matches. */
      aiSessionId?: string | null;
    };

    if (winner !== "player1" && winner !== "player2") {
      return NextResponse.json(
        { success: false, error: "Invalid winner. Must be player1 or player2" },
        { status: 400 }
      );
    }

    // Normalize wager once up front so it can be used by both the AI
    // session guard (above) and the balance / payout paths (below).
    const wagerAmount = Number(wager);
    if (!Number.isFinite(wagerAmount) || wagerAmount <= 0) {
      // For pure "for fun" matches (no wager ever placed) this would
      // reject — allow wager=0 in the fun-mode-only shape.
      if (!isFunMode) {
        return NextResponse.json(
          { success: false, error: "Invalid wager amount" },
          { status: 400 }
        );
      }
    }

    const result = winner === "player1" ? "win" : "loss";
    const endedAt = new Date().toISOString();

    // ── Defense-in-depth: when the caller claims `isAiGame: true`, verify
    //    against the AI session token that /start-game stored in Redis.
    //    If no matching token exists (or it's malformed / belongs to a
    //    different user / has expired) we refuse the AI/fun-mode
    //    treatment entirely so a forged PvP request cannot skip a
    //    winner's payout. Pure "for fun" matches (`isFunMode: true` only)
    //    don't need this — they bypass /start-game and never credited any
    //    wager in the first place.
    let aiModeAuthorised = false;
    if (isAiGame === true) {
      if (typeof aiSessionId !== "string" || aiSessionId.length === 0) {
        return NextResponse.json(
          {
            success: false,
            error: "AI session token required for isAiGame claim.",
          },
          { status: 400 }
        );
      }
      // Wrap the matcher + token burn in try/finally so the token is
      // consumed on EVERY exit (success, mismatch, or unexpected
      // throw). Burning on a mismatch prevents an attacker from
      // re-attaching a captured token to a forged end-game that
      // simply corrects the wager/difficulty.
      //
      // Two genuinely simultaneous end-game calls with the same
      // token still race between `cacheGet` and `await cacheDelete`
      // resolving — both may observe the cached entry before the
      // first DEL fires. For true single-round-trip atomicity, port
      // `cacheGet` to use Redis `GETDEL` (Redis 6.2+) which deletes
      // as part of the read. For AI-flow this is benign (no balance
      // moves): the worst case is a duplicate history row.
      const tokenIdToBurn = aiSessionId;
      try {
        const session = await cacheGet<HexDuelAiSessionPayload>(
          CacheKeys.hexDuelAiSession(aiSessionId),
        );
        // Strict match on the fields we bind at start-game time —
        //   userId (cache must belong to this Clerk user)
        //   wager   (an intercepted token can't be re-attached to a
        //            different wager within the 15-min TTL window)
        //   aiDifficulty (same rationale)
        // We deliberately do NOT match startedAt: the server and
        // client take their timestamps a few ms apart and `Date.now()`
        // can drift across timezones, so a strict equality check
        // would 400 legitimate users on clock skew.
        if (
          !session ||
          session.userId !== clerkId ||
          Number(session.wager) !== wagerAmount ||
          // difficulty may be null/missing in either the cached
          // entry or the request body — treat both null as a match.
          (session.aiDifficulty ?? null) !== (aiDifficulty ?? null)
        ) {
          return NextResponse.json(
            {
              success: false,
              error: "Invalid or expired AI session token.",
            },
            { status: 400 }
          );
        }
        aiModeAuthorised = true;
      } finally {
        // Fires on every exit above: success, 400 mismatch, throw.
        // Idempotent — DEL on a missing key is a no-op.
        await cacheDelete(
          CacheKeys.hexDuelAiSession(tokenIdToBurn),
        ).catch((err) => {
          console.error(
            "[hex-duel] failed to delete AI session token after consume:",
            err,
          );
        });
      }
    }

    const funMode = isFunMode === true || aiModeAuthorised;

    // ── Fun mode / AI mode: only record history, skip all balance changes ─────
    if (funMode) {
      db.insert(hexDuelGames)
        .values({
          player1Id: clerkId,
          player2Id: null,
          wagerAmount: "0.00",
          winner,
          result,
          payout: "0.00",
          isAiGame: isAiGame ?? false,
          aiDifficulty: aiDifficulty ?? null,
          player1Moves: player1Moves ?? 0,
          player2Moves: player2Moves ?? 0,
          player1Territory: player1Territory ?? 1,
          player2Territory: player2Territory ?? 1,
          durationSeconds: durationSeconds ?? 0,
          status: "completed",
          isFunMode: true,
          startedAt: startedAt ?? null,
          endedAt,
        } as unknown as typeof hexDuelGames.$inferInsert)
        .catch((e) => console.error("Failed to insert hex duel history (fun):", e));

      return NextResponse.json({
        success: true,
        data: { won: winner === "player1", wager: 0, payout: 0 },
      });
    }

    // ── Real mode: validate wager, update balances, record history ──
    if (winner !== "player1") {
      // Player lost — reset streak, track games lost
      // applyLeaderboardCounters handles all stat columns (total_wagered,
      // weekly_wagered, weekly_profit, current_streak, etc.)
      const [updatedUser] = await db
        .update(users)
        .set({
          gamesLost: sql`${users.gamesLost} + 1`,
        })
        .where(eq(users.clerkId, clerkId))
        .returning({ balance: users.balance });

      // Fire-and-forget history insert
      db.insert(hexDuelGames)
        .values({
          player1Id: clerkId,
          player2Id: null,
          wagerAmount: wagerAmount.toFixed(2),
          winner,
          result,
          payout: "0.00",
          isAiGame: isAiGame ?? false,
          aiDifficulty: aiDifficulty ?? null,
          player1Moves: player1Moves ?? 0,
          player2Moves: player2Moves ?? 0,
          player1Territory: player1Territory ?? 1,
          player2Territory: player2Territory ?? 1,
          durationSeconds: durationSeconds ?? 0,
          status: "completed",
          isFunMode: false,
          startedAt: startedAt ?? null,
          endedAt,
        } as unknown as typeof hexDuelGames.$inferInsert)
        .catch((e) => console.error("Failed to insert hex duel history (loss):", e));

      // Record leaderboard stats for the loss
      applyLeaderboardCounters({
        clerkId,
        game: "Hex Duel",
        betAmount: wagerAmount,
        payout: 0,
      }).catch(() => {});

      return NextResponse.json({
        success: true,
        data: {
          won: false,
          wager: wagerAmount,
          payout: 0,
          newBalance: updatedUser ? Number(updatedUser.balance) : undefined,
        },
      });
    }

    // Player won — pay out
    const payout = Number((wagerAmount * PAYOUT_MULTIPLIER).toFixed(2));

    // applyLeaderboardCounters handles all stat columns (total_won,
    // weekly_wagered, weekly_won, weekly_profit, weekly_wins,
    // current_streak, best_streak, biggest_win, etc.)
    // Only update balance and gamesWon here — everything else goes
    // through the shared helper to avoid double-counting.
    const [updatedUser] = await db
      .update(users)
      .set({
        balance: sql`${users.balance} + ${payout}`,
        gamesWon: sql`${users.gamesWon} + 1`,
      })
      .where(eq(users.clerkId, clerkId))
      .returning({ balance: users.balance });

    if (!updatedUser) {
      return NextResponse.json(
        { success: false, error: "User not found" },
        { status: 404 }
      );
    }

    // Record big win if payout >= 1M tokens
    if (payout >= 1_000_000) {
      const clerkUser = await currentUser();
      recordBigWinIfNeeded({
        userId: clerkId,
        username:
          clerkUser?.firstName
            ? `${clerkUser.firstName} ${clerkUser.lastName || ""}`.trim()
            : "Player",
        game: "Hex Duel",
        betAmount: wagerAmount,
        winAmount: payout,
        multiplier: PAYOUT_MULTIPLIER,
      }).catch(() => {});
    }

    // Fire-and-forget history insert for win path
    db.insert(hexDuelGames)
      .values({
        player1Id: clerkId,
        player2Id: null,
        wagerAmount: wagerAmount.toFixed(2),
          winner,
          result,
          payout: payout.toFixed(2),
          isAiGame: isAiGame ?? false,
          aiDifficulty: aiDifficulty ?? null,
          player1Moves: player1Moves ?? 0,
          player2Moves: player2Moves ?? 0,
          player1Territory: player1Territory ?? 1,
          player2Territory: player2Territory ?? 1,
          durationSeconds: durationSeconds ?? 0,
          status: "completed",
          isFunMode: false,
          startedAt: startedAt ?? null,
          endedAt,
        } as unknown as typeof hexDuelGames.$inferInsert)
        .catch((e) => console.error("Failed to insert hex duel history (win):", e));

    // Record leaderboard stats for the win
    applyLeaderboardCounters({
      clerkId,
      game: "Hex Duel",
      betAmount: wagerAmount,
      payout,
    }).catch(() => {});

    return NextResponse.json({
      success: true,
      data: {
        won: true,
        wager: wagerAmount,
        payout,
        multiplier: PAYOUT_MULTIPLIER,
        newBalance: Number(updatedUser.balance),
      },
    });
  } catch (error) {
    console.error(" Hex Duel end-game error:", error);
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
