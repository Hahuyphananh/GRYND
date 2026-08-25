import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db/client";
import {
  users,
  crashArenaTables,
  crashArenaPlayers,
  crashArenaRounds,
  crashArenaEntries,
} from "../../../../db/schema";
import { eq, ne, and, inArray, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import {
  CRASH_WAGERS,
  CRASH_MIN_BUYIN_MULTIPLIER,
} from "../../../../lib/games/crash/constants";
import {
  isMissingCrashArenaColumn,
  CRASH_ARENA_SCHEMA_HINT,
} from "../../../../lib/crash-arena/errors";
import { resolveCrashArenaAiBotId } from "../../../../lib/crash-arena/aiBot";

/** Default tables to seed if none exist. Min buy-in = 5× wager. */
const DEFAULT_TABLES = CRASH_WAGERS.map((wager) => ({
  name: `$${wager} Crash Arena`,
  wager: wager,
  minBuyIn: wager * CRASH_MIN_BUYIN_MULTIPLIER,
  maxPlayers: 6,
}));

async function ensureDefaultTables() {
  // Re-seed when no *open real* tables remain (stale cleanup may have
  // closed them). AI practice tables don't count — they're private rooms
  // hidden from the public grid.
  const existing = await db
    .select({ id: crashArenaTables.id })
    .from(crashArenaTables)
    .where(and(ne(crashArenaTables.status, "closed"), eq(crashArenaTables.isAi, false)))
    .limit(1);
  if (existing.length > 0) return;

  for (const t of DEFAULT_TABLES) {
    await db.insert(crashArenaTables).values({
      name: t.name,
      wagerAmount: t.wager.toFixed(2),
      minimumBuyin: t.minBuyIn.toFixed(2),
      maxPlayers: t.maxPlayers,
      status: "waiting",
    });
  }
}

/**
 * GET /api/crash-arena/tables
 *
 * Returns all available (non-closed) Crash Arena tables with:
 *   - current player count and seated player details (including display
 *     names, and isYou for the caller's own seat)
 *   - latest round status
 *   - whether the signed-in user is already seated (amISeated / myBalance)
 * Auto-seeds default tables if none exist.
 */
export async function GET() {
  try {
    // Public lobby listing — signed-out visitors can browse the table grid.
    // auth() is used only to flag the caller's own seats (false when signed out).
    const { userId } = await auth();

    // Internal user id for the caller (if any) — used to match their seats.
    let internalUserId = null;
    if (userId) {
      const [userRow] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.clerkId, userId))
        .limit(1);
      internalUserId = userRow?.id ?? null;
    }

    // ── Auto-seed default tables ──────────────────────────────────────────
    await ensureDefaultTables();

    // Closed tables are not joinable and are hidden from the lobby.
    const tables = await db
      .select()
      .from(crashArenaTables)
      .where(ne(crashArenaTables.status, "closed"))
      .orderBy(crashArenaTables.wagerAmount);

    const tableIds = tables.map((t) => t.id);

    // ── Bulk-fetch all seated + wait-listed players for these tables ──────
    let allPlayers = [];
    if (tableIds.length > 0) {
      allPlayers = await db
        .select()
        .from(crashArenaPlayers)
        .where(
          and(
            inArray(crashArenaPlayers.tableId, tableIds),
            inArray(crashArenaPlayers.status, ["seated", "waiting"]),
          ),
        );
    }

    // ── Internal id of the reserved AI bot (null until a practice table
    //    has ever been created) — used to flag bot seats so the UI never
    //    offers to report them.
    const aiBotId = await resolveCrashArenaAiBotId();

    // ── Bulk-fetch display names for players AND hosts ─────────────────────
    const hostIds = tables
      .map((t) => t.hostId)
      .filter((id) => id != null);
    const userIdsToResolve = [
      ...new Set([...allPlayers.map((p) => p.userId), ...hostIds]),
    ];
    let userNameById = new Map();
    let userClerkIdById = new Map();
    if (userIdsToResolve.length > 0) {
      const userRows = await db
        .select({ id: users.id, name: users.name, clerkId: users.clerkId })
        .from(users)
        .where(inArray(users.id, userIdsToResolve));
      userNameById = new Map(userRows.map((u) => [u.id, u.name]));
      userClerkIdById = new Map(
        userRows
          .filter((u) => u.clerkId != null)
          .map((u) => [u.id, u.clerkId]),
      );
    }

    // ── Enrich each table ──────────────────────────────────────────────────
    const enriched = await Promise.all(
      tables.map(async (table) => {
        const players = allPlayers.filter(
          (p) => p.tableId === table.id && p.status === "seated",
        );
        const waiting = allPlayers.filter(
          (p) => p.tableId === table.id && p.status === "waiting",
        );

        // Latest round
        const latestRound = await db
          .select()
          .from(crashArenaRounds)
          .where(eq(crashArenaRounds.tableId, table.id))
          .orderBy(sql`${crashArenaRounds.createdAt} DESC`)
          .limit(1);

        // Latest round details — lets table-room clients reconcile the
        // live round (crash point, seed commitment, per-player entry
        // results) so every player sees the same running/settled state
        // even when they weren't the one who started it.
        let latestRoundInfo = null;
        if (latestRound[0]) {
          const roundEntries = await db
            .select()
            .from(crashArenaEntries)
            .where(eq(crashArenaEntries.roundId, latestRound[0].id));
          latestRoundInfo = {
            id: latestRound[0].id,
            status: latestRound[0].status,
            crashPoint:
              latestRound[0].crashPoint != null
                ? Number(latestRound[0].crashPoint)
                : null,
            seedHash: latestRound[0].seedHash ?? null,
            createdAt: latestRound[0].createdAt,
            entries: roundEntries.map((e) => ({
              userId: e.userId,
              result: e.result,
              cashoutMultiplier:
                e.cashoutMultiplier != null
                  ? Number(e.cashoutMultiplier)
                  : null,
            })),
          };
        }

        // Sum of player balances at table
        const pot = players.reduce((sum, p) => sum + Number(p.balance), 0);

        const mySeat = internalUserId != null
          ? players.find((p) => p.userId === internalUserId)
          : undefined;
        const myWait = internalUserId != null
          ? waiting.find((p) => p.userId === internalUserId)
          : undefined;

        return {
          id: table.id,
          name: table.name,
          wager: Number(table.wagerAmount),
          minBuyIn: Number(table.minimumBuyin),
          maxPlayers: table.maxPlayers,
          status: table.status,
          isAi: table.isAi,
          aiDifficulty: table.aiDifficulty ?? "medium",
          hostId: table.hostId,
          hostName:
            table.hostId != null
              ? userNameById.get(table.hostId) || null
              : null,
          players: players.map((p) => ({
            userId: p.userId,
            // clerkId lets clients (e.g. the report modal) address the
            // player by their Clerk identity — the userId field above is
            // the internal users.id, which is not a public identity.
            clerkId: userClerkIdById.get(p.userId) ?? null,
            name: userNameById.get(p.userId) || `Player ${p.userId}`,
            balance: Number(p.balance),
            status: p.status,
            isYou: internalUserId != null && p.userId === internalUserId,
            isBot: aiBotId != null && p.userId === aiBotId,
          })),
          waitingPlayers: waiting.map((p) => ({
            userId: p.userId,
            clerkId: userClerkIdById.get(p.userId) ?? null,
            name: userNameById.get(p.userId) || `Player ${p.userId}`,
            balance: Number(p.balance),
            status: p.status,
            isYou: internalUserId != null && p.userId === internalUserId,
            isBot: aiBotId != null && p.userId === aiBotId,
          })),
          playerCount: players.length,
          waitingCount: waiting.length,
          pot,
          roundStatus: latestRound[0]?.status ?? null,
          latestRound: latestRoundInfo,
          amISeated: Boolean(mySeat),
          amIWaiting: Boolean(myWait),
          myBalance: mySeat ? Number(mySeat.balance) : null,
        };
      }),
    );

    return NextResponse.json({ success: true, data: enriched });
  } catch (err) {
    console.error("[crash-arena:tables]", err);
    if (isMissingCrashArenaColumn(err)) {
      return NextResponse.json(
        { success: false, error: CRASH_ARENA_SCHEMA_HINT },
        { status: 500 },
      );
    }
    return NextResponse.json({ success: false, error: "Server error" }, { status: 500 });
  }
}
