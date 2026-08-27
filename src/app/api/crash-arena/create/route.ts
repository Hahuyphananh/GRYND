import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db/client";
import {
  users,
  crashArenaTables,
  crashArenaPlayers,
} from "../../../../db/schema";
import { eq, and, or, isNull, lt, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import {
  CRASH_MIN_WAGER,
  CRASH_MAX_WAGER,
  CRASH_MIN_BUYIN_MULTIPLIER,
} from "../../../../lib/games/crash/constants";
import { computeBlinds } from "../../../../lib/crash-poker/roundSystem";
import {
  broadcastLobbyUpdate,
  broadcastTableUpdate,
} from "../../../../lib/crash-arena/rooms";
import {
  isMissingCrashArenaColumn,
  CRASH_ARENA_SCHEMA_HINT,
} from "../../../../lib/crash-arena/errors";

/**
 * POST /api/crash-arena/create
 *
 * Body: { wager: number }
 *
 * Creates a brand-new Crash Arena table with the given round wager so
 * other players can join it from the lobby. The creator is recorded as
 * the table's host (host_id).
 *
 * Per-user anti-spam: before creating, the caller's own stale tables
 * (waiting, empty, older than 30 min) are closed so a user can't pile up
 * dead tables.
 */
export async function POST(req: Request) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }

    const { wager } = await req.json();
    const wagerNum = Number(wager);

    if (!Number.isFinite(wagerNum) || wagerNum < CRASH_MIN_WAGER) {
      return NextResponse.json(
        { success: false, error: `Minimum wager is $${CRASH_MIN_WAGER}` },
        { status: 400 },
      );
    }
    if (wagerNum > CRASH_MAX_WAGER) {
      return NextResponse.json(
        { success: false, error: `Maximum wager is $${CRASH_MAX_WAGER.toLocaleString()}` },
        { status: 400 },
      );
    }
    // Round wager to 2 decimal places
    const roundedWager = Math.round(wagerNum * 100) / 100;

    const minBuyIn = roundedWager * CRASH_MIN_BUYIN_MULTIPLIER;

    // ── Get the creator's internal user id ──────────────────────────────────
    const [userRow] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.clerkId, userId))
      .limit(1);

    if (!userRow) {
      return NextResponse.json({ success: false, error: "User not found" }, { status: 404 });
    }
    const hostId = userRow.id;

    // ── Close stale empty tables (older than 30 min): the caller's own
    //    hosted tables (per-user attribution) plus leftover system-seeded
    //    tables (host_id IS NULL) that nobody has joined.
    const staleTables = await db
      .select({ id: crashArenaTables.id })
      .from(crashArenaTables)
      .where(
        and(
          eq(crashArenaTables.status, "waiting"),
          lt(crashArenaTables.createdAt, new Date(Date.now() - 30 * 60 * 1000)),
          or(
            eq(crashArenaTables.hostId, hostId),
            isNull(crashArenaTables.hostId),
          ),
        ),
      );

    for (const t of staleTables) {
      const seated = await db
        .select({ count: sql<number>`count(*)` })
        .from(crashArenaPlayers)
        .where(
          and(
            eq(crashArenaPlayers.tableId, t.id),
            eq(crashArenaPlayers.status, "seated"),
          ),
        );
      if (Number(seated[0]?.count ?? 0) === 0) {
        await db
          .update(crashArenaTables)
          .set({ status: "closed" })
          .where(eq(crashArenaTables.id, t.id));
      }
    }

    // ── Create the brand-new table ───────────────────────────────────────────
    // Configurable blinds: resolve the Small Blind once at creation (default
    // ratio round(wager/2)) and persist it so every hand at this table uses
    // the same blind structure.
    const { smallBlind } = computeBlinds(roundedWager);
    const [created] = await db
      .insert(crashArenaTables)
      .values({
        name: `$${roundedWager} Crash Arena`,
        wagerAmount: roundedWager.toFixed(2),
        minimumBuyin: minBuyIn.toFixed(2),
        maxPlayers: 6,
        hostId,
        status: "waiting",
        smallBlind: smallBlind.toFixed(2),
      })
      .returning();

    // Best-effort live fanout so lobby clients refresh their grid
    // instantly. Silently no-ops when the realtime server runs in a
    // separate process (the 5 s lobby poll covers it).
    broadcastLobbyUpdate({ created: true, tableId: created.id, wager: roundedWager });
    broadcastTableUpdate(created.id, { created: true });

    return NextResponse.json({
      success: true,
      data: {
        tableId: created.id,
        name: created.name,
        wager: roundedWager,
        minBuyIn,
      },
    });
  } catch (err) {
    console.error("[crash-arena:create]", err);
    if (isMissingCrashArenaColumn(err)) {
      return NextResponse.json(
        { success: false, error: CRASH_ARENA_SCHEMA_HINT },
        { status: 500 },
      );
    }
    return NextResponse.json({ success: false, error: "Server error" }, { status: 500 });
  }
}
