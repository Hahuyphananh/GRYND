import { NextRequest, NextResponse } from "next/server";
import { db } from "../../../../db/client";
import {
  users,
  crashArenaTables,
  crashArenaPlayers,
} from "../../../../db/schema";
import { eq, inArray } from "drizzle-orm";
import { releaseCrashArenaSeat } from "../../../../lib/crash-arena/cleanup";

export const dynamic = "force-dynamic";

/**
 * POST /api/crash-arena/sweep-stale
 *
 * Internal endpoint driven by the realtime server's periodic stale-seat
 * sweep (see `runCrashArenaStaleSweep` in realtime-server/server.js). It
 * is the belt-and-suspenders safety net for rows whose socket vanished
 * without the per-socket disconnect timer catching it (realtime server
 * restart, missed disconnect, process crash) — stale "seated"/"waiting"
 * rows can never linger.
 *
 * Two actions:
 *
 *   { action: "list" }
 *     Returns every currently seated / wait-listed player row as
 *     { tableId, userId } where userId is the CLERK id (the realtime
 *     server matches these against live socket ids).
 *
 *   { action: "release", release: [{ tableId, userId }] }
 *     Releases each listed seat through the shared releaseCrashArenaSeat
 *     helper (refund + mark "left" + LEAVE transaction, deferring when
 *     an unresolved win is mid-flight). Returns the released / deferred
 *     seats so the realtime server can push an instant refresh.
 *
 * The route is internal-only: when REALTIME_INTERNAL_SECRET is set, the
 * caller must send it in the `x-internal-secret` header. When the env
 * var is unset (local dev) the check is skipped.
 */
export async function POST(req: NextRequest) {
  try {
    // ── Optional shared-secret guard for the internal sweep ─────────────
    const secret = process.env.REALTIME_INTERNAL_SECRET;
    if (secret) {
      const header = req.headers.get("x-internal-secret");
      if (header !== secret) {
        return NextResponse.json(
          { success: false, error: "Unauthorized" },
          { status: 401 },
        );
      }
    }

    const body = await req.json().catch(() => ({}));
    const action = body?.action;

    // ── List candidate rows (seated or waiting, any real table) ─────────
    // AI practice tables are excluded entirely: their seats are released
    // by the per-socket disconnect timer (which closes the whole practice
    // session) and the bot never has a socket to begin with.
    if (action === "list") {
      const aiTableRows = await db
        .select({ id: crashArenaTables.id })
        .from(crashArenaTables)
        .where(eq(crashArenaTables.isAi, true));
      const aiTableIds = new Set(aiTableRows.map((r) => r.id));

      const rows = await db
        .select({
          tableId: crashArenaPlayers.tableId,
          userId: crashArenaPlayers.userId,
        })
        .from(crashArenaPlayers)
        .where(inArray(crashArenaPlayers.status, ["seated", "waiting"]));

      if (rows.length === 0) {
        return NextResponse.json({ success: true, data: { rows: [] } });
      }

      // Resolve internal user ids → Clerk ids (what the realtime server
      // sees on its sockets).
      const userIds = [...new Set(rows.map((r) => r.userId))];
      const userRows = await db
        .select({ id: users.id, clerkId: users.clerkId })
        .from(users)
        .where(inArray(users.id, userIds));
      const clerkById = new Map(userRows.map((u) => [u.id, u.clerkId]));

      const data = rows
        .filter((r) => !aiTableIds.has(r.tableId))
        .map((r) => ({ tableId: r.tableId, userId: clerkById.get(r.userId) ?? null }))
        .filter((r) => r.userId != null);

      return NextResponse.json({ success: true, data: { rows: data } });
    }

    // ── Release confirmed-stale seats ───────────────────────────────────
    if (action === "release") {
      const release = Array.isArray(body?.release) ? body.release : [];
      const released: { tableId: number; userId: string }[] = [];
      const deferred: { tableId: number; userId: string }[] = [];

      for (const item of release) {
        const tableId = Number(item?.tableId);
        const userId = typeof item?.userId === "string" ? item.userId : "";
        if (!Number.isFinite(tableId) || !userId) continue;

        const result = await releaseCrashArenaSeat(
          tableId,
          userId,
          "Auto-released by stale-seat sweep",
        );

        if (result.cleaned) released.push({ tableId, userId });
        else if (result.deferred) deferred.push({ tableId, userId });
      }

      return NextResponse.json({ success: true, data: { released, deferred } });
    }

    return NextResponse.json(
      { success: false, error: "Unknown action" },
      { status: 400 },
    );
  } catch (err) {
    console.error("[crash-arena:sweep-stale]", err);
    return NextResponse.json({ success: false, error: "Server error" }, { status: 500 });
  }
}
