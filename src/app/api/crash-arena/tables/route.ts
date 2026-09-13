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
    let userIconKeyById = new Map();
    if (userIdsToResolve.length > 0) {
      const userRows = await db
        .select({
          id: users.id,
          name: users.name,
          clerkId: users.clerkId,
          // Official Grynd icon key — the ONLY avatar representation.
          selectedIcon: users.selectedIcon,
        })
        .from(users)
        .where(inArray(users.id, userIdsToResolve));
      userNameById = new Map(userRows.map((u) => [u.id, u.name]));
      userClerkIdById = new Map(
        userRows
          .filter((u) => u.clerkId != null)
          .map((u) => [u.id, u.clerkId]),
      );
      userIconKeyById = new Map(
        userRows.map((u) => [u.id, u.selectedIcon || "default"]),
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

        const mySeat = internalUserId != null
          ? players.find((p) => p.userId === internalUserId)
          : undefined;
        const myWait = internalUserId != null
          ? waiting.find((p) => p.userId === internalUserId)
          : undefined;

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

            // ── Private per-hand insights (signals) ──────────────────────
            // The hand snapshot carries one private `signal` per entered
            // player. While the hand runs ONLY the owner may see theirs
            // (myTip, below); everybody else's stays server-side. An
            // insight becomes public the moment its owner folds (fed into
            // revealedSignals), and ALL of them are public once the hand
            // settles. The hand_state handed to clients is therefore
            // sanitized (signals stripped) and the private/public views are
            // exposed explicitly.
            const rawHandState = (latestRound[0].handState ?? null) as
              | {
                  players?: Array<{
                    userId?: number;
                    signal?: unknown;
                    folded?: boolean;
                    foldedAtMultiplier?: number | null;
                  }>;
                }
              | null
              | undefined;
            const handRunning = latestRound[0].status === "running";
            const signalByUser = new Map<number, unknown>();
            let revealedUserIds: number[] = [];
            if (rawHandState && Array.isArray(rawHandState.players)) {
              for (const hp of rawHandState.players) {
                if (hp?.signal != null && hp.userId != null) {
                  signalByUser.set(hp.userId, hp.signal);
                }
              }
              // Running: only folded seats' insights are public. Settled:
              // the hand is over — every entered seat's insight is public.
              revealedUserIds = handRunning
                ? rawHandState.players
                    .filter((hp) => hp?.folded && hp.userId != null)
                    .map((hp) => hp.userId as number)
                : rawHandState.players
                    .filter((hp) => hp?.userId != null)
                    .map((hp) => hp.userId as number);
            }
            // Cloned handState with every `signal` stripped — a client can
            // only ever learn an insight through myTip / revealedSignals /
            // the settle payload, never by reading the shared snapshot.
            const sanitizedHandState = rawHandState
              ? {
                  ...rawHandState,
                  players: (rawHandState.players ?? []).map((p) => ({
                    ...p,
                    signal: undefined,
                  })),
                }
              : null;

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
              // big_blind keeps the table wager (the flat ante) — the
              // poker-era columns (small_blind, dealer_position,
              // checkpoint_index, required_bet, betting_open) are no
              // longer populated, so only the wager is exposed here.
              bigBlind:
                latestRound[0].bigBlind != null
                  ? Number(latestRound[0].bigBlind)
                  : null,
              handState: sanitizedHandState,
              // THIS caller's private insight for the running hand — only
              // delivered to the seated owner, and only while the hand runs
              // (at settle the broadcast + revealedSignals expose everyone).
              myTip:
                handRunning && mySeat
                  ? (signalByUser.get(mySeat.userId) ?? null)
                  : null,
              // Insights revealed so far — folded seats' tips while the hand
              // runs; every entered seat's tips once it has settled.
              revealedSignals: revealedUserIds.map((userId) => ({
                userId,
                signal: signalByUser.get(userId) ?? null,
              })),
              // Epoch-ms the hand started — the continuous-curve anchor
              // every client renders the multiplier from.
              flightResumedAt:
                (latestRound[0].handState as { flightResumedAt?: number } | null)
                  ?.flightResumedAt ?? null,
              carryOver: Number(table.carryOver ?? 0),
              entries: roundEntries.map((e) => ({
                userId: e.userId,
                result: e.result,
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

        return {
          id: table.id,
          name: table.name,
          wager: Number(table.wagerAmount),
          minBuyIn: Number(table.minimumBuyin),
          maxPlayers: table.maxPlayers,
          status: table.status,
          carryOver: Number(table.carryOver ?? 0),
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
            // Official Grynd icon key for the seat's avatar (AI seats fall
            // back to the default icon).
            iconKey: userIconKeyById.get(p.userId) || "default",
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
                  // Official Grynd icon key for the wait-list avatar.
                  iconKey: userIconKeyById.get(p.userId) || "default",
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
