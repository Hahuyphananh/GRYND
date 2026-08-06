import { NextRequest, NextResponse } from "next/server";
import { verifyToken } from "@clerk/backend";
import { db } from "../../../../db/client";
import {
  users,
  crashArenaPlayers,
  crashArenaRounds,
  crashArenaEntries,
  crashArenaTransactions,
} from "../../../../db/schema";
import { eq, and, ne, inArray, sql } from "drizzle-orm";
import {
  broadcastLobbyUpdate,
  broadcastTableUpdate,
} from "../../../../lib/crash-arena/rooms";

export const dynamic = "force-dynamic";

/**
 * POST /api/crash-arena/disconnect-cleanup
 *
 * Body: { tableId: number, token: string }
 *
 * Internal endpoint called by the realtime server when a crash arena
 * participant's socket has stayed disconnected past the grace window
 * (tab closed, long network drop). Releases the player's seat so they
 * are no longer shown as being inside the game:
 *
 *   1. Verifies the Clerk session token the player authenticated their
 *      socket with — only the token owner's own seat can be removed,
 *      so the endpoint can't be used to grief another player.
 *   2. Locks in any unresolved mid-round entry fairly:
 *        • "pending"  → marked "lost" (they never cashed out, the crash
 *          busts them anyway) so refunding can't be gamed.
 *        • "won"      → the player cashed out and could still win the
 *          pot. Nothing is released yet — the route returns
 *          `deferred: true` and the realtime server re-checks shortly;
 *          once the round settles (the win lands on the row first) the
 *          retry performs the full cleanup below.
 *   3. Refunds the remaining table balance to the user's wallet.
 *   4. Marks the player row "left" (same as "Back to Lobby").
 *
 * Returns { success, deferred } — the realtime server re-checks when
 * deferred so winnings are never stranded.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const tableId = Number(body?.tableId);
    const token = typeof body?.token === "string" ? body.token : "";

    if (!Number.isFinite(tableId) || !token) {
      return NextResponse.json(
        { success: false, error: "Missing tableId or token" },
        { status: 400 },
      );
    }

    // ── Verify the socket's Clerk session token ─────────────────────────
    const CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY;
    if (!CLERK_SECRET_KEY) {
      return NextResponse.json(
        { success: false, error: "Server authentication is not configured" },
        { status: 500 },
      );
    }
    let clerkUserId: string;
    try {
      const verified = await verifyToken(token, { secretKey: CLERK_SECRET_KEY });
      clerkUserId = verified.sub ?? "";
    } catch {
      return NextResponse.json(
        { success: false, error: "Invalid token" },
        { status: 401 },
      );
    }
    if (!clerkUserId) {
      return NextResponse.json(
        { success: false, error: "Invalid token" },
        { status: 401 },
      );
    }

    // ── Resolve internal user id ────────────────────────────────────────
    const userData = await db
      .select()
      .from(users)
      .where(eq(users.clerkId, clerkUserId))
      .limit(1);

    if (!userData.length) {
      // User account is gone — nothing left to clean up.
      return NextResponse.json({ success: true, data: { cleaned: false, deferred: false } });
    }
    const user = userData[0];

    // ── Find the player row (idempotent if already gone) ────────────────
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
      // Seat already released (manual leave / previous cleanup).
      return NextResponse.json({ success: true, data: { cleaned: false, deferred: false } });
    }
    const player = playerData[0];

    // ── Is a round mid-flight at this table? ────────────────────────────
    // A running round older than 5 minutes is treated as abandoned
    // (mirrors the join / start-round recovery rules) → clean up freely.
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

    let roundIsLive = false;
    if (activeRound[0]) {
      const st = activeRound[0].status;
      if (st === "running" || st === "crashed") {
        const ageMs = Date.now() - new Date(activeRound[0].createdAt).getTime();
        roundIsLive = ageMs < 5 * 60 * 1000;
      }
    }

    if (roundIsLive) {
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
          // loss in now so the refund below can't be gamed, then release.
          await db
            .update(crashArenaEntries)
            .set({ result: "lost" })
            .where(eq(crashArenaEntries.id, entryData[0].id));
        } else if (entryData[0].result === "won") {
          // Cashed out and could still win the pot. Keep the seat in
          // place (no refund, no "left" yet) and ask the realtime
          // server to re-check shortly — once the round settles, the
          // payout lands on this row and the retry performs the full
          // cleanup. Marking "left" here would strand the winnings,
          // because the retry can no longer find the row to refund.
          return NextResponse.json({
            success: true,
            data: { cleaned: false, deferred: true },
          });
        }
        // result === "lost" → nothing owed, fall through to full cleanup.
      }
    }

    // ── Safe to fully clean up: refund + mark left ──────────────────────
    const returnAmount = Number(player.balance);

    if (returnAmount > 0) {
      await db
        .update(users)
        .set({ balance: sql`${users.balance} + ${returnAmount}` })
        .where(eq(users.clerkId, clerkUserId));
    }

    await db
      .update(crashArenaPlayers)
      .set({ status: "left" })
      .where(eq(crashArenaPlayers.id, player.id));

    await db.insert(crashArenaTransactions).values({
      userId: user.id,
      tableId,
      amount: returnAmount.toFixed(2),
      type: "LEAVE",
      reason: "Auto-leave after disconnect",
    });

    // Best-effort fanout so the remaining players + lobby refresh.
    broadcastTableUpdate(tableId, { left: true, userId: user.id, disconnected: true });
    broadcastLobbyUpdate({ left: true, tableId, disconnected: true });

    return NextResponse.json({
      success: true,
      data: { cleaned: true, deferred: false, returned: returnAmount },
    });
  } catch (err) {
    console.error("[crash-arena:disconnect-cleanup]", err);
    return NextResponse.json({ success: false, error: "Server error" }, { status: 500 });
  }
}
