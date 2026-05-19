import { auth, currentUser } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { db } from "../../../../db/client";
import { hexDuelGames, users } from "../../../../db/schema";
import { eq, sql } from "drizzle-orm";
import { recordBigWinIfNeeded } from "../../../../lib/bigWins";

const PAYOUT_MULTIPLIER = 1.9; // 5% house edge

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
    };

    if (winner !== "player1" && winner !== "player2") {
      return NextResponse.json(
        { success: false, error: "Invalid winner — must be player1 or player2" },
        { status: 400 }
      );
    }

    const result = winner === "player1" ? "win" : "loss";
    const endedAt = new Date().toISOString();
    const funMode = isFunMode === true;

    // ── Fun mode: only record history, skip all balance changes ─────
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
    const wagerAmount = Number(wager);
    if (!Number.isFinite(wagerAmount) || wagerAmount <= 0) {
      return NextResponse.json(
        { success: false, error: "Invalid wager amount" },
        { status: 400 }
      );
    }

    if (winner !== "player1") {
      // Player lost — reset streak, track weekly stats
      const [updatedUser] = await db
        .update(users)
        .set({
          currentStreak: sql`0`,
          gamesLost: sql`${users.gamesLost} + 1`,
          weeklyWagered: sql`${users.weeklyWagered} + ${wagerAmount}`,
          weeklyProfit: sql`${users.weeklyProfit} - ${wagerAmount}`,
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

    const [updatedUser] = await db
      .update(users)
      .set({
        balance: sql`${users.balance} + ${payout}`,
        totalWon: sql`${users.totalWon} + ${payout}`,
        gamesWon: sql`${users.gamesWon} + 1`,
        currentStreak: sql`${users.currentStreak} + 1`,
        bestStreak: sql`GREATEST(${users.bestStreak}, ${users.currentStreak} + 1)`,
        biggestWin: sql`GREATEST(${users.biggestWin}, ${payout})`,
      })
      .where(eq(users.clerkId, clerkId))
      .returning({ balance: users.balance });

    if (!updatedUser) {
      return NextResponse.json(
        { success: false, error: "User not found" },
        { status: 404 }
      );
    }

    // Update weekly stats for winner
    await db
      .update(users)
      .set({
        weeklyWagered: sql`${users.weeklyWagered} + ${wagerAmount}`,
        weeklyWon: sql`${users.weeklyWon} + ${payout}`,
        weeklyProfit: sql`${users.weeklyProfit} + ${payout - wagerAmount}`,
        weeklyWins: sql`${users.weeklyWins} + 1`,
      })
      .where(eq(users.clerkId, clerkId));

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
        player2Id: null,          wagerAmount: wagerAmount.toFixed(2),
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
    console.error("❌ Hex Duel end-game error:", error);
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
