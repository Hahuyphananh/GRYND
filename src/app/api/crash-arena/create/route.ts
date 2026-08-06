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
  CRASH_WAGERS,
  CRASH_MIN_BUYIN_MULTIPLIER,
} from "../../../../lib/games/crash/constants";
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

    if (!CRASH_WAGERS.includes(wagerNum)) {
      return NextResponse.json(
        { success: false, error: "Invalid wager amount" },
        { status: 400 },
      );
    }

    const minBuyIn = wagerNum * CRASH_MIN_BUYIN_MULTIPLIER;

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
    const [created] = await db
      .insert(crashArenaTables)
      .values({
        name: `$${wagerNum} Crash Arena`,
        wagerAmount: wagerNum.toFixed(2),
        minimumBuyin: minBuyIn.toFixed(2),
        maxPlayers: 6,
        hostId,
        status: "waiting",
      })
      .returning();

    // Best-effort live fanout so lobby clients refresh their grid
    // instantly. Silently no-ops when the realtime server runs in a
    // separate process (the 5 s lobby poll covers it).
    broadcastLobbyUpdate({ created: true, tableId: created.id, wager: wagerNum });
    broadcastTableUpdate(created.id, { created: true });

    return NextResponse.json({
      success: true,
      data: {
        tableId: created.id,
        name: created.name,
        wager: wagerNum,
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
