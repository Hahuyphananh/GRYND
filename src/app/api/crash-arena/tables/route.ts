import { db } from "../../../../db/client";
import {
  crashArenaTables,
  crashArenaPlayers,
  crashArenaRounds,
} from "../../../../db/schema";
import { eq, and, sql } from "drizzle-orm";
import { NextResponse } from "next/server";

/** Default tables to seed if none exist. Min buy-in = 5× wager. */
const DEFAULT_TABLES = [
  { name: "$1 Crash Arena",   wager: 1,   minBuyIn: 5,   maxPlayers: 6 },
  { name: "$5 Crash Arena",   wager: 5,   minBuyIn: 25,  maxPlayers: 6 },
  { name: "$10 Crash Arena",  wager: 10,  minBuyIn: 50,  maxPlayers: 6 },
  { name: "$25 Crash Arena",  wager: 25,  minBuyIn: 125, maxPlayers: 6 },
  { name: "$50 Crash Arena",  wager: 50,  minBuyIn: 250, maxPlayers: 6 },
  { name: "$100 Crash Arena", wager: 100, minBuyIn: 500, maxPlayers: 6 },
];

async function ensureDefaultTables() {
  const existing = await db.select({ id: crashArenaTables.id }).from(crashArenaTables).limit(1);
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
 * Returns all available Crash Arena tables with:
 *   - current player count and seated player details
 *   - latest round status
 * Auto-seeds default tables if none exist.
 */
export async function GET() {
  try {
    // Public lobby listing — signed-out visitors can browse the table grid
    // (consistent with /api/mines-pvp/available). Joining/playing still
    // requires auth in the join/start-round/settle routes.

    // ── Auto-seed default tables ──────────────────────────────────────────
    await ensureDefaultTables();

    const tables = await db
      .select()
      .from(crashArenaTables)
      .orderBy(crashArenaTables.wagerAmount);

    // Enrich with player counts and latest-round data
    const enriched = await Promise.all(
      tables.map(async (table) => {
        const players = await db
          .select()
          .from(crashArenaPlayers)
          .where(
            and(
              eq(crashArenaPlayers.tableId, table.id),
              eq(crashArenaPlayers.status, "seated"),
            ),
          );

        // Latest round
        const latestRound = await db
          .select()
          .from(crashArenaRounds)
          .where(eq(crashArenaRounds.tableId, table.id))
          .orderBy(sql`${crashArenaRounds.createdAt} DESC`)
          .limit(1);

        // Sum of player balances at table
        const pot = players.reduce((sum, p) => sum + Number(p.balance), 0);

        return {
          id: table.id,
          name: table.name,
          wager: Number(table.wagerAmount),
          minBuyIn: Number(table.minimumBuyin),
          maxPlayers: table.maxPlayers,
          status: table.status,
          players: players.map((p) => ({
            userId: p.userId,
            balance: Number(p.balance),
            status: p.status,
          })),
          playerCount: players.length,
          pot,
          roundStatus: latestRound[0]?.status ?? null,
        };
      }),
    );

    return NextResponse.json({ success: true, data: enriched });
  } catch (err) {
    console.error("[crash-arena:tables]", err);
    return NextResponse.json({ success: false, error: "Server error" }, { status: 500 });
  }
}
