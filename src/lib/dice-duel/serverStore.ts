// src/lib/dice-duel/serverStore.ts
//
// Shared server-side helpers for Dice Duel matches. The resign
// settlement is extracted here so the user-initiated resign route
// and the realtime-server disconnect-forfeit route settle
// identically (mirrors the pool / rps-pvp pattern).

import { db } from "../../db";
import { and, eq, sql } from "drizzle-orm";
import { diceMatches, users } from "../../db/schema";
import { applyLeaderboardCounters } from "../leaderboardCounters";
import { sendSystemNotificationEmail } from "../emails/system";

export interface ResignResult {
  ok: boolean;
  message?: string;
  status?: number;
  winnerId?: string;
  ended?: boolean;
  matchId?: string;
}

// Resigns from a Dice Duel match (active state only).
//   • Resigner forfeits their stake; the opponent wins the pot
//     minus the shared 5% house rake.
//   • AI matches are free play — no balance moves, the AI is simply
//     declared the winner.
// Mirrors the settlement math in `/api/dice-duel/submit-turn`.
export async function resignDiceDuelMatch({
  userId,
  matchId,
}: {
  userId: string;
  matchId: string;
}): Promise<ResignResult> {
  const [m] = await db
    .select()
    .from(diceMatches)
    .where(and(eq(diceMatches.id, matchId), eq(diceMatches.status, "active")))
    .limit(1);

  if (!m) {
    return { ok: false, message: "Match unavailable", status: 404 };
  }

  const isPlayer1 = m.player1Id === userId;
  const isPlayer2 = m.player2Id === userId;
  if (!isPlayer1 && !isPlayer2) {
    return { ok: false, message: "Not a participant", status: 403 };
  }

  const isAI = m.player2Id === "AI_BOT";

  // The resigner loses; the opponent (or the AI) wins.
  const winnerId = isPlayer1 ? m.player2Id : m.player1Id;

  const wager = Number(m.wager || 0);
  const isPvp = !isAI && m.player2Id !== null && m.player2Id !== "AI_BOT";
  // Harmonized to the shared 5% PvP rake (must match PVP_RAKE_PCT in
  // src/lib/games/economy.ts): winner keeps 95% of the 2x pot.
  const houseFee = Math.floor(wager * 2 * 0.05);
  const payout = isPvp ? wager * 2 - houseFee : 0;

  await db.transaction(async (tx) => {
    // Credit the winner (PvP only — AI matches move no tokens).
    if (isPvp && winnerId) {
      await tx
        .update(users)
        .set({ balance: sql`${users.balance} + ${payout}` })
        .where(eq(users.clerkId, String(winnerId)));
    }

    await tx
      .update(diceMatches)
      .set({
        status: "finished",
        winnerId,
        prizePaid: payout,
        houseFee,
        endedAt: new Date(),
      })
      .where(eq(diceMatches.id, matchId));
  });

  // Fire system notification for large dice duel bets (≥ 1000 tokens).
  if (wager >= 1000) {
    sendSystemNotificationEmail({
      eventType: "bet_placed",
      description: `User ${userId} resigned a large Dice Duel game (wager: ${wager}, winner: ${winnerId}).`,
      metadata: { userId, matchId, wager, winnerId, isPvp },
    }).catch((err) => console.warn("[system_notify] Failed to send dice-duel resign:", err));
  }

  // Leaderboard stats — only for paid PvP matches.
  const betAmountForCounters = isPvp ? wager : 0;
  if (isPvp && winnerId) {
    applyLeaderboardCounters({
      clerkId: winnerId,
      game: "Dice Duel",
      betAmount: betAmountForCounters,
      payout,
      isPvpWin: true,
    }).catch(() => {});
  }
  if (isPvp) {
    applyLeaderboardCounters({
      clerkId: userId,
      game: "Dice Duel",
      betAmount: betAmountForCounters,
      payout: 0,
    }).catch(() => {});
  }

  return { ok: true, winnerId, ended: true, matchId };
}
