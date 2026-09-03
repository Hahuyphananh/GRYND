// GET /api/precision/get-match?matchId=...
//
// Scaffold stub: returns the current `PrecisionState` for the match.
// We first look for a match by exact id; if none is found we look for a
// lobby and convert it into a waiting-room state so the waiting UI works
// immediately after a host creates a lobby.

import { NextRequest, NextResponse } from "next/server";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../../../db/client";
import { users } from "../../../../db/schema";
import { resolvePrestigeBadge } from "../../../../lib/prestige";
import {
  precisionLobbyStore,
  precisionMatchStore,
} from "../../../../lib/precision/serverStore";
import type { PrecisionState } from "../../../../lib/precision/types";

/**
 * Server-authoritative prestige badge decoration for the players in a
 * precision state payload. Only the resolved label (or nothing) leaves
 * the server; raw prestige columns never reach the client.
 */
async function decoratePlayerBadges<T extends { userId: string }>(
  players: T[],
): Promise<(T & { prestigeBadge: string | null })[]> {
  const humanIds = players
    .filter((p) => p.userId && p.userId !== "opponent")
    .map((p) => p.userId);
  if (humanIds.length === 0) {
    return players.map((p) => ({ ...p, prestigeBadge: null }));
  }
  const rows = await db
    .select({
      clerkId: users.clerkId,
      xp: users.xp,
      prestigeLevel: users.prestigeLevel,
      showPrestigeBadge: users.showPrestigeBadge,
    })
    .from(users)
    .where(inArray(users.clerkId, humanIds));
  const badgeByUser = new Map<string, string | null>();
  for (const row of rows) {
    badgeByUser.set(
      String(row.clerkId),
      resolvePrestigeBadge({
        xp: row.xp,
        prestigeLevel: row.prestigeLevel,
        showPrestigeBadge: row.showPrestigeBadge,
      }),
    );
  }
  return players.map((p) => ({
    ...p,
    prestigeBadge: badgeByUser.get(String(p.userId)) ?? null,
  }));
}

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const matchId = String(url.searchParams.get("matchId") ?? "");
  if (!matchId) {
    return NextResponse.json(
      { success: false, match: null, error: "Missing matchId." },
      { status: 400 },
    );
  }  const match = precisionMatchStore.get(matchId);
  if (match) {
    return NextResponse.json({
      success: true,
      match: {
        ...match,
        players: await decoratePlayerBadges(match.players ?? []),
      },
    });
  }

  const lobby = precisionLobbyStore.get(matchId);
  if (lobby && lobby.status === "waiting") {
    // Synthesised lobby-as-state: safe defaults so the client UI doesn't
    // crash when reading score / currentRound before matchmaking has
    // populated the real PrecisionState entry.
    const waitingState: PrecisionState = {
      matchId,
      phase: "waiting",
      wager: lobby.wager,      players: await decoratePlayerBadges([
        {
          seat: 1,
          userId: lobby.hostUserId,
          name: lobby.hostName ?? "Player 1",
          isReady: true,
          isConnected: true,
        },
      ]),

      turn: 1,
      score: { seat1: 0, seat2: 0 },
      currentRound: 1,
      // Replay-attack envelope: a waiting lobby has no armed round, so
      // the envelope is null. `precision:stop` rejects packets when
      // either roundId OR nonce is null. Real values land on the next
      // armMatchRound call inside `markPlayerReady` once both seats
      // click Ready.
      roundSequence: 0,
      roundId: null,
      roundNonce: null,
      // Server rolls the per-round target behind `armMatchRound`'s
      // timer; the public state stays null until the round opens.
      targetMs: null,
      winnerSeat: null,
      lastRoundWinnerSeat: null,
      armingStartedAt: null,
      countdownEndsAt: null,
      roundGoInstant: null,
      lastRoundStops: null,
      version: 0,
    };
    return NextResponse.json({ success: true, match: waitingState });
  }

  return NextResponse.json({ success: true, match: null });
}
