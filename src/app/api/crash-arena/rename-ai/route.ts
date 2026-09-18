import { db } from "../../../../db/client";
import {
  users,
  crashArenaTables,
  crashArenaPlayers,
} from "../../../../db/schema";
import { eq, and } from "drizzle-orm";
import { NextResponse } from "next/server";
import { requireAgeVerifiedUser } from "../../../../lib/auth/requireAgeVerified";
import { isCrashArenaAiBotId } from "../../../../lib/crash-arena/aiBot";
import { broadcastTableUpdate } from "../../../../lib/crash-arena/rooms";

/** Max length of a custom AI name (matches the nickname column). */
const MAX_AI_NAME_LENGTH = 40;

/**
 * POST /api/crash-arena/rename-ai
 *
 * Body: { tableId: number, userId: number, name: string }
 *
 * Renames an AI bot at a PRIVATE table (host only, mirroring the poker
 * table AIs — the host who added the AIs manages them).
 *
 *   1. Validates the caller is the table host and the table is private.
 *   2. Validates the target is a reserved bot seated at this table.
 *   3. Stores the custom name on the SEAT (crash_arena_players.nickname) —
 *      never on the shared users row, so renaming at one table can't leak
 *      into another.
 *
 * The renamed bot shows up everywhere via the roster refetch (the tables
 * route resolves display names from the nickname override).
 */
export async function POST(req: Request) {
  try {
    const gate = await requireAgeVerifiedUser();
    if (gate.response) return gate.response;
    const userId = gate.userId;

    const { tableId, userId: botUserId, name } = await req.json();
    if (!tableId || !Number.isFinite(Number(botUserId))) {
      return NextResponse.json({ success: false, error: "Invalid request" }, { status: 400 });
    }

    const nickname =
      typeof name === "string" ? name.trim().slice(0, MAX_AI_NAME_LENGTH) : "";
    if (!nickname) {
      return NextResponse.json({ success: false, error: "Enter a name for the AI" }, { status: 400 });
    }

    const [userRow] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.clerkId, userId))
      .limit(1);
    if (!userRow) {
      return NextResponse.json({ success: false, error: "User not found" }, { status: 404 });
    }

    const [table] = await db
      .select()
      .from(crashArenaTables)
      .where(eq(crashArenaTables.id, tableId))
      .limit(1);
    if (!table) {
      return NextResponse.json({ success: false, error: "Table not found" }, { status: 404 });
    }
    if (table.status === "closed") {
      return NextResponse.json({ success: false, error: "Table is closed" }, { status: 400 });
    }
    // AIs are private-only, and only the host may manage them.
    if (!table.isPrivate) {
      return NextResponse.json({
        success: false,
        error: "AIs can only be managed on private tables",
      }, { status: 400 });
    }
    if (table.hostId !== userRow.id) {
      return NextResponse.json({ success: false, error: "Only the host can rename AIs" }, { status: 403 });
    }

    // ── The target must be a reserved bot seated at THIS table ───────────
    const botId = Number(botUserId);
    if (!(await isCrashArenaAiBotId(botId))) {
      return NextResponse.json({ success: false, error: "Not an AI seat" }, { status: 400 });
    }
    const [seat] = await db
      .select({ id: crashArenaPlayers.id })
      .from(crashArenaPlayers)
      .where(
        and(
          eq(crashArenaPlayers.tableId, tableId),
          eq(crashArenaPlayers.userId, botId),
          eq(crashArenaPlayers.status, "seated"),
        ),
      )
      .limit(1);
    if (!seat) {
      return NextResponse.json({ success: false, error: "AI is not seated at this table" }, { status: 400 });
    }

    // ── Store the custom name on the SEAT ────────────────────────────────
    await db
      .update(crashArenaPlayers)
      .set({ nickname })
      .where(eq(crashArenaPlayers.id, seat.id));

    broadcastTableUpdate(tableId, { aiRenamed: true, userId: botId, name: nickname });

    return NextResponse.json({
      success: true,
      data: {
        userId: botId,
        name: nickname,
      },
    });
  } catch (err) {
    console.error("[crash-arena:rename-ai]", err);
    return NextResponse.json({ success: false, error: "Server error" }, { status: 500 });
  }
}
