// src/lib/crash-arena/cleanup.ts
//
// Shared seat-release logic for Crash Arena. Both the realtime-server's
// disconnect-cleanup endpoint and the stale-seat sweep route release a
// player's seat through this one function, so every exit path behaves
// identically:
//
//   1. Locks in any unresolved mid-round entry fairly:
//        • "pending"  → marked "lost" (they never cashed out, the crash
//          busts them anyway) so refunding can't be gamed.
//        • "won"      → the player cashed out and could still win the pot.
//          Nothing is released yet — the function returns deferred: true
//          and the caller re-checks shortly; once the round settles (the
//          win lands on the row first) the retry performs the full
//          cleanup. Marking "left" here would strand the winnings.
//   2. Refunds the remaining table balance to the user's wallet.
//   3. Marks the player row "left" and records a LEAVE transaction.

import { db } from "../../db/client";
import {
  users,
  crashArenaTables,
  crashArenaPlayers,
  crashArenaRounds,
  crashArenaEntries,
  crashArenaTransactions,
} from "../../db/schema";
import { eq, and, ne, inArray, sql } from "drizzle-orm";
import {
  broadcastLobbyUpdate,
  broadcastTableUpdate,
} from "./rooms";
import { closeAiCrashArenaTable } from "./aiBot";

export interface ReleaseCrashArenaSeatResult {
  cleaned: boolean;
  deferred: boolean;
  returned: number;
}

/**
 * Release a crash arena player's seat.
 *
 * Idempotent: if the player has no seated/waiting row (already released,
 * never joined, or the account is gone) it returns `{ cleaned: false,
 * deferred: false }` without doing anything.
 *
 * @param tableId  crash_arena_tables.id
 * @param clerkId  Clerk user id of the player whose seat to release
 * @param reason   reason recorded on the LEAVE transaction
 */
export async function releaseCrashArenaSeat(
  tableId: number,
  clerkId: string,
  reason: string,
): Promise<ReleaseCrashArenaSeatResult> {
  // ── Resolve internal user id from the Clerk id ────────────────────────
  const userData = await db
    .select()
    .from(users)
    .where(eq(users.clerkId, clerkId))
    .limit(1);

  if (!userData.length) {
    // User account is gone — nothing left to clean up.
    return { cleaned: false, deferred: false, returned: 0 };
  }
  const user = userData[0];

  // ── Find the player row (idempotent if already gone) ──────────────────
  const playerData = await db
    .select()
    .from(crashArenaPlayers)
    .where(
      and(
        eq(crashArenaPlayers.tableId, tableId),
        eq(crashArenaPlayers.userId, user.id),
        inArray(crashArenaPlayers.status, ["seated", "waiting"]),
      ),
    )
    .limit(1);

  if (!playerData.length) {
    // Seat already released (manual leave / previous cleanup / sweep).
    return { cleaned: false, deferred: false, returned: 0 };
  }
  const player = playerData[0];

  // ── AI practice tables: chips are virtual ─────────────────────────────
  // Never refund to the wallet and never write a LEAVE transaction — just
  // close the whole practice session (a table with only the bot left has
  // no reason to exist). No deferral needed: there are no real winnings
  // to strand, and the close path locks pending entries as losses.
  const tableData = await db
    .select({
      id: crashArenaTables.id,
      isAi: crashArenaTables.isAi,
      isPrivate: crashArenaTables.isPrivate,
    })
    .from(crashArenaTables)
    .where(eq(crashArenaTables.id, tableId))
    .limit(1);

  if (tableData[0]?.isAi) {
    await closeAiCrashArenaTable(tableId);
    broadcastTableUpdate(tableId, { left: true, userId: user.id, disconnected: true });
    broadcastLobbyUpdate({ left: true, tableId, disconnected: true });
    return { cleaned: true, deferred: false, returned: 0 };
  }

  // ── Private tables: chips are virtual (play money) ────────────────────
  // The buy-in was never deducted from the wallet (join route skips the
  // wallet move for private tables), so the table balance is play money
  // and must NEVER be refunded. Mark the seat left without touching the
  // wallet or ledger — mirrors the manual leave route's isPrivate guard.
  const isVirtual = Boolean(tableData[0]?.isPrivate);
  if (isVirtual) {
    await db
      .update(crashArenaPlayers)
      .set({ status: "left" })
      .where(
        and(
          eq(crashArenaPlayers.id, player.id),
          inArray(crashArenaPlayers.status, ["seated", "waiting"]),
        ),
      );

    broadcastTableUpdate(tableId, { left: true, userId: user.id, disconnected: true });
    broadcastLobbyUpdate({ left: true, tableId, disconnected: true });
    return { cleaned: true, deferred: false, returned: 0 };
  }

  // ── Is a round still open at this table? ──────────────────────────────
  // Any non-settled round (running or crashed) with an entry for this
  // player must have that entry locked in BEFORE the seat is released —
  // including "abandoned" rounds older than 5 minutes. Without this, a
  // released player's entry would stay "pending", they'd be counted as
  // active at settlement, and a fold-out could crown them the winner and
  // credit the pot to their (already refunded) seat — a double payout.
  const activeRound = await db
    .select()
    .from(crashArenaRounds)
    .where(
      and(
        eq(crashArenaRounds.tableId, tableId),
        ne(crashArenaRounds.status, "settled"),
      ),
    )
    .orderBy(sql`${crashArenaRounds.createdAt} DESC`)
    .limit(1);

  if (activeRound[0]) {
    const st = activeRound[0].status;
    if (st === "running" || st === "crashed") {
      const entryData = await db
        .select()
        .from(crashArenaEntries)
        .where(
          and(
            eq(crashArenaEntries.roundId, activeRound[0].id),
            eq(crashArenaEntries.userId, user.id),
          ),
        )
        .limit(1);

      if (entryData.length) {
        if (entryData[0].result === "pending") {
          // Never cashed out → the crash would bust them anyway. Lock the
          // loss in now so the refund below can't be gamed and the hand
          // can't later crown a released player the winner.
          await db
            .update(crashArenaEntries)
            .set({ result: "lost" })
            .where(eq(crashArenaEntries.id, entryData[0].id));
        } else if (entryData[0].result === "won") {
          // Cashed out and could still win the pot. Keep the seat in place
          // (no refund, no "left" yet) and ask the caller to re-check
          // shortly — once the round settles, the payout lands on this row
          // and the retry performs the full cleanup.
          return { cleaned: false, deferred: true, returned: 0 };
        }
        // result === "lost" → nothing owed, fall through to full cleanup.
      }
    }
  }

  // ── Atomic claim before any money moves ───────────────────────────────
  // Mark the seat "left" ONLY if it is still seated/waiting. Multiple
  // release paths (the per-socket disconnect timer, the stale-seat sweep)
  // can run concurrently; this guarded UPDATE is the atomic claim. The
  // loser of the race matches zero rows and skips, so a table balance can
  // never be refunded twice.
  const [claimed] = await db
    .update(crashArenaPlayers)
    .set({ status: "left" })
    .where(
      and(
        eq(crashArenaPlayers.id, player.id),
        inArray(crashArenaPlayers.status, ["seated", "waiting"]),
      ),
    )
    .returning({ id: crashArenaPlayers.id });

  if (!claimed) {
    // Another release path got there first.
    return { cleaned: false, deferred: false, returned: 0 };
  }

  // ── We own the seat now: refund + record + fan out ────────────────────
  const returnAmount = Number(player.balance);

  if (returnAmount > 0) {
    await db
      .update(users)
      .set({ balance: sql`${users.balance} + ${returnAmount}` })
      .where(eq(users.clerkId, clerkId));
  }

  await db.insert(crashArenaTransactions).values({
    userId: user.id,
    tableId,
    amount: returnAmount.toFixed(2),
    type: "LEAVE",
    reason,
  });

  // Best-effort fanout so the remaining players + lobby refresh.
  broadcastTableUpdate(tableId, { left: true, userId: user.id, disconnected: true });
  broadcastLobbyUpdate({ left: true, tableId, disconnected: true });

  return { cleaned: true, deferred: false, returned: returnAmount };
}
