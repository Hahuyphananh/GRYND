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
import {
  resolveCrashArenaAiBotId,
  resolveCrashArenaAiBotIds,
} from "../../../../lib/crash-arena/aiBot";

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
export async function GET(req: Request) {
  try {
    // Public lobby listing — signed-out visitors can browse the table grid.
    // auth() is used only to flag the caller's own seats (false when signed out).
    const { userId } = await auth();

    // ?mode=lobby requests a lighter payload for the public table grid: it
    // skips the per-table latest-round/entries N+1 and trims fields the
    // lobby never reads (latestRound, waitingPlayers, clerkId, myBalance).
    // The table-room client calls without the param and gets the full
    // detail it needs for round reconciliation. Signed-out API responses
    // are CDN-cacheable, but this endpoint is per-request so we rely on the
    // reduced work rather than edge caching.
    const isLobbyMode =
      new URL(req.url).searchParams.get("mode") === "lobby";

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
    // Private + AI practice tables are hidden from the PUBLIC grid (lobby
    // mode) — they're reachable only via their table URL.
    const tables = await db
      .select()
      .from(crashArenaTables)
      .where(
        and(
          ne(crashArenaTables.status, "closed"),
          isLobbyMode ? eq(crashArenaTables.isPrivate, false) : undefined,
          isLobbyMode ? eq(crashArenaTables.isAi, false) : undefined,
        ),
      )
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

    // ── Internal ids of the reserved AI bots (null until any bot row
    //    exists) — used to flag bot seats so the UI never offers to report
    //    them and so the host can drive their decisions.
    const aiBotId = await resolveCrashArenaAiBotId();
    const aiBotIds = new Set((await resolveCrashArenaAiBotIds()).keys());

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

        // Latest round. In lobby mode we only need the status string (for
        // the LIVE badge); the lobby never reads the full round, so we do a
        // lightweight status-only select and skip the entries N+1. The
        // table-room client gets the full round + entries for reconciliation.
        let roundStatusValue: string | null = null;
        let latestRoundInfo = null;
        if (isLobbyMode) {
          const [last] = await db
            .select({ status: crashArenaRounds.status })
            .from(crashArenaRounds)
            .where(eq(crashArenaRounds.tableId, table.id))
            .orderBy(sql`${crashArenaRounds.createdAt} DESC`)
            .limit(1);
          roundStatusValue = last?.status ?? null;
        } else {
          const latestRound = await db
            .select()
            .from(crashArenaRounds)
            .where(eq(crashArenaRounds.tableId, table.id))
            .orderBy(sql`${crashArenaRounds.createdAt} DESC`)
            .limit(1);
          roundStatusValue = latestRound[0]?.status ?? null;
          // Latest round details — lets table-room clients reconcile the
          // live round (crash point, seed commitment, per-player entry
          // results) so every player sees the same running/settled state
          // even when they weren't the one who started it.
          if (latestRound[0]) {
            const roundEntries = await db
              .select()
              .from(crashArenaEntries)
              .where(eq(crashArenaEntries.roundId, latestRound[0].id));
            // The crash point is NEVER exposed while the hand is running
            // (it must stay unknown to clients until the crash) — it is
            // only revealed after the hand settles, alongside the seed, for
            // provable-fairness verification.
            const roundSettled =
              latestRound[0].status === "settled" ||
              latestRound[0].status === "crashed";
            latestRoundInfo = {
              id: latestRound[0].id,
              status: latestRound[0].status,
              crashPoint: roundSettled
                ? latestRound[0].crashPoint != null
                  ? Number(latestRound[0].crashPoint)
                  : null
                : null,
              seedHash: latestRound[0].seedHash ?? null,
              createdAt: latestRound[0].createdAt,
              // Server epoch ms when the hand started — clients align
              // their crash curve to it so every player renders the
              // same multiplier at the same moment.
              startedAt: new Date(latestRound[0].createdAt).getTime(),
              // Server-scheduled next-round deadline (epoch ms) — every
              // client counts down to the same moment.
              nextRoundAt:
                table.nextRoundAt != null
                  ? new Date(table.nextRoundAt).getTime()
                  : null,
              // ── Crash Poker hand window ────────────────────────────────
              smallBlind:
                latestRound[0].smallBlind != null
                  ? Number(latestRound[0].smallBlind)
                  : null,
              bigBlind:
                latestRound[0].bigBlind != null
                  ? Number(latestRound[0].bigBlind)
                  : null,
              dealerPosition: latestRound[0].dealerPosition ?? null,
              checkpointIndex: latestRound[0].checkpointIndex ?? -1,
              requiredBet:
                latestRound[0].requiredBet != null
                  ? Number(latestRound[0].requiredBet)
                  : 0,
              bettingOpen: Boolean(latestRound[0].bettingOpen),
              handState: latestRound[0].handState ?? null,
              // Stall-guard deadline (epoch ms) for the open checkpoint
              // window — clients render the auto-fold countdown from it.
              windowDeadlineAt:
                (latestRound[0].handState as { windowDeadlineAt?: number } | null)
                  ?.windowDeadlineAt ?? null,
              // Epoch-ms the current flight segment started — drives the
              // pause-aware curve so every client renders the same
              // multiplier (paused at open checkpoints) at the same moment.
              flightResumedAt:
                (latestRound[0].handState as { flightResumedAt?: number } | null)
                  ?.flightResumedAt ?? null,
              carryOver: Number(table.carryOver ?? 0),
              entries: roundEntries.map((e) => ({
                userId: e.userId,
                result: e.result,
                cashoutMultiplier:
                  e.cashoutMultiplier != null
                    ? Number(e.cashoutMultiplier)
                    : null,
                contributed: Number(e.contributed ?? 0),
                isActive: e.isActive !== false,
                allIn: e.allIn === true,
                foldedAtMultiplier:
                  e.foldedAtMultiplier != null
                    ? Number(e.foldedAtMultiplier)
                    : null,
                lastAction: e.lastAction ?? null,
              })),
            };
          }
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
          carryOver: Number(table.carryOver ?? 0),
          // Configurable per-table Small Blind (null = standard wager/2).
          smallBlind: table.smallBlind != null ? Number(table.smallBlind) : null,
          isAi: table.isAi,
          // Private host-created tables: hidden from the public grid; only
          // the host may add AI seats to them.
          isPrivate: table.isPrivate,
          aiDifficulty: table.aiDifficulty ?? "medium",
          hostId: table.hostId,
          hostName:
            table.hostId != null
              ? userNameById.get(table.hostId) || null
              : null,
          // Server-authoritative next-round deadline (epoch ms) — clients
          // count down to it so every client starts the round together.
          nextRoundAt:
            table.nextRoundAt != null
              ? new Date(table.nextRoundAt).getTime()
              : null,
          players: players.map((p) => ({
            userId: p.userId,
            // clerkId lets clients (e.g. the report modal) address the
            // player by their Clerk identity — the userId field above is
            // the internal users.id, which is not a public identity. Only
            // the table-room client needs it; the lobby trims it.
            ...(isLobbyMode
              ? {}
              : { clerkId: userClerkIdById.get(p.userId) ?? null }),
            // The seat's custom name (host-renamed AIs) wins over the
            // users-table name — renaming never touches the shared user.
            name: p.nickname ?? (userNameById.get(p.userId) || `Player ${p.userId}`),
            balance: Number(p.balance),
            status: p.status,
            isYou: internalUserId != null && p.userId === internalUserId,
            isBot: aiBotIds.size > 0 ? aiBotIds.has(p.userId) : aiBotId != null && p.userId === aiBotId,
            // Per-bot difficulty picked in the Add-AI dialog (null for humans).
            aiDifficulty: p.aiDifficulty ?? null,
          })),
          ...(isLobbyMode
            ? {}
            : {
                waitingPlayers: waiting.map((p) => ({
                  userId: p.userId,
                  clerkId: userClerkIdById.get(p.userId) ?? null,
                  name: p.nickname ?? (userNameById.get(p.userId) || `Player ${p.userId}`),
                  balance: Number(p.balance),
                  status: p.status,
                  isYou: internalUserId != null && p.userId === internalUserId,
                  isBot: aiBotIds.size > 0 ? aiBotIds.has(p.userId) : aiBotId != null && p.userId === aiBotId,
                  aiDifficulty: p.aiDifficulty ?? null,
                })),
              }),
          playerCount: players.length,
          waitingCount: waiting.length,
          pot,
          roundStatus: roundStatusValue,
          ...(isLobbyMode
            ? {}
            : {
                latestRound: latestRoundInfo,
                amISeated: Boolean(mySeat),
                amIWaiting: Boolean(myWait),
                amIHost:
                  internalUserId != null &&
                  table.hostId != null &&
                  internalUserId === table.hostId,
                // The invite code is only ever returned to the HOST (for
                // sharing) — other clients must already have the code to
                // have reached the table at all, so it never leaks here.
                joinCode:
                  internalUserId != null &&
                  table.hostId != null &&
                  internalUserId === table.hostId
                    ? table.joinCode ?? null
                    : null,
                myBalance: mySeat ? Number(mySeat.balance) : null,
              }),
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
