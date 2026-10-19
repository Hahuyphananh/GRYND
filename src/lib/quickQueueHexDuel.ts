import { and, asc, eq, isNull, not } from "drizzle-orm";
import { db } from "../db";
import { hexDuelGames } from "../db/schema";
import { normalizeStake } from "./games/stakes";
import { escrowMatchWagers } from "./tokens/wager";

/**
 * Quick Queue destination for Hex Duel: match a queued pair at the stake they
 * queued with, or open a waiting lobby at that stake.
 *
 * CHANGED WITH STAKING: this path seats the second player directly (it does not
 * go through `/multiplayer/join`), so it must escrow the two seats itself — the
 * worker's two calls are one match (`createOrJoin` for the source player, then
 * the partner lands on the SAME lobby id). Escrow runs inside the transaction
 * that fills the seat, so a queue pair can never play a staked match for free,
 * and a seat that cannot cover the stake leaves the lobby waiting (the pair is
 * simply unmatched and the queue retries) exactly as the public join does.
 */
export async function createOrJoinHexDuelDestination({ userId, wager = 10 }: { userId: string; wager?: number | string | null }) {
  const amount = normalizeStake(wager, "hex-duel");
  return db.transaction(async (tx) => {
    const [open] = await tx.select().from(hexDuelGames).where(and(eq(hexDuelGames.status, "waiting"), isNull(hexDuelGames.player2Id), not(eq(hexDuelGames.player1Id, userId)), eq(hexDuelGames.wagerAmount, amount.toFixed(2)))).orderBy(asc(hexDuelGames.createdAt)).for("update").limit(1);
    if (open) {
      const [matched] = await tx.update(hexDuelGames).set({ player2Id: userId, status: "in_progress", currentTurn: "player2", lastActionSeq: 0, startedAt: new Date() }).where(and(eq(hexDuelGames.id, open.id), eq(hexDuelGames.status, "waiting"), isNull(hexDuelGames.player2Id))).returning();
      if (!matched) return { error: "Game is no longer available", status: 409 };

      // Annotated rather than inferred: `strict` is off in this project, where a
      // discriminated union is not narrowed by `if (!x.ok)` (see
      // src/lib/tokens/pvpPot.ts). A refusal reports an error instead of
      // throwing so the worker marks the pair unmatched and retries.
      const escrow: { ok: boolean; error?: string; status?: number } = await escrowMatchWagers({
        clerkIds: [open.player1Id, userId],
        stake: amount,
        matchId: matched.id,
        gameKey: "hex-duel",
        tx,
      });
      if (!escrow.ok) {
        return { error: escrow.error || "Insufficient coins", status: escrow.status ?? 400 };
      }

      return { match: matched, joined: true };
    }
    const [created] = await tx.insert(hexDuelGames).values({ player1Id: userId, wagerAmount: amount.toFixed(2), winner: "pending", result: "pending", status: "waiting", isAiGame: false }).returning();
    return { match: created, joined: false };
  });
}
