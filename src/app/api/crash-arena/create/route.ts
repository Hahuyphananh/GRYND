import { db } from "../../../../db/client";
import {
  users,
  crashArenaTables,
  crashArenaPlayers,
} from "../../../../db/schema";
import { eq, and, or, isNull, lt, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { requireAgeVerifiedUser } from "../../../../lib/auth/requireAgeVerified";
import {
  CRASH_MIN_WAGER,
  CRASH_MAX_WAGER,
  CRASH_MIN_BUYIN_MULTIPLIER,
} from "../../../../lib/games/crash/constants";
import {
  broadcastLobbyUpdate,
  broadcastTableUpdate,
} from "../../../../lib/crash-arena/rooms";
import { generateJoinCode } from "../../../../lib/crash-arena/joinCode";
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
    const gate = await requireAgeVerifiedUser();
    if (gate.response) return gate.response;
    const userId = gate.userId;

    const { wager, isPrivate } = await req.json();
    const wagerNum = Number(wager);
    const privateTable = Boolean(isPrivate);

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
    // Every player posts the wager as a flat ante each hand — no blinds to
    // persist (small_blind stays NULL).
    // Private tables get an invite code — the ONLY way non-members can join
    // (the table URL alone no longer grants access). Public tables don't
    // need one (anyone can join from the lobby).
    const joinCode = privateTable ? generateJoinCode() : null;
    const [created] = await db
      .insert(crashArenaTables)
      .values({
        name: `$${roundedWager} Crash Arena`,
        wagerAmount: roundedWager.toFixed(2),
        minimumBuyin: minBuyIn.toFixed(2),
        maxPlayers: 6,
        hostId,
        status: "waiting",
        // Private tables are hidden from the public lobby grid — the host
        // shares the invite code (and may add AI seats there, like poker).
        isPrivate: privateTable,
        joinCode,
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
        isPrivate: privateTable,
        // The host needs the code to invite friends — shared in the lobby
        // "Join with invite code" flow and on the table page.
        joinCode,
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
