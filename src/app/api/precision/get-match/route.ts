// GET /api/precision/get-match?matchId=...
//
// Scaffold stub: returns the current `PrecisionState` for the match.
// We first look for a match by exact id; if none is found we look for a
// lobby and convert it into a waiting-room state so the waiting UI works
// immediately after a host creates a lobby.

import { NextRequest, NextResponse } from "next/server";
import { requirePracticePlayer } from "../../../../lib/auth/guestSession";
import { GUEST_DISPLAY_NAME, isGuestId } from "../../../../lib/guestIdentity";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../../../db/client";
import { glows, tokenSubscriptions, users } from "../../../../db/schema";
import { ACTIVE_SUBSCRIPTION_STATUSES } from "../../../../lib/stripe/subscriptions";
import { getFrameDecorations } from "../../../../lib/cosmetics";
import {
  getWaitingLobby,
  readMatch,
  sweepPrecisionGamesIfDue,
} from "../../../../lib/precision/serverStore";
import type { PrecisionState } from "../../../../lib/precision/types";

/**
 * Server-authoritative seat-identity decoration for the players in a
 * precision state payload: official Grynd icon key + equipped name color
 * (equipped glow wins; the GRYND PRO chat color only surfaces for active
 * members). Only the resolved labels leave the server; raw columns never
 * reach the client. Non-user ids (the AI sentinel "AI_BOT") keep nulls so
 * the client falls back to its label.
 */
async function decoratePlayerBadges<T extends { userId: string }>(
  players: T[],
): Promise<
  (T & {
    iconKey: string | null;
    nameColor: string | null;
    profileFrame: unknown;
    isGuest: boolean;
  })[]
> {
  // A guest holds no `users` row, so it is never a badge lookup target: it is
  // decorated as the guest seat (name "Guest", no icon) which the client
  // renders as the "G" badge instead of the default catalog icon.
  const badgeFor = (
    p: T,
    icons: Map<string, string | null>,
    colors: Map<string, string | null>,
    frames: Map<string, unknown>,
  ) => {
    if (isGuestId(p.userId)) {
      return {
        ...p,
        name: GUEST_DISPLAY_NAME,
        iconKey: null,
        nameColor: null,
        profileFrame: null,
        isGuest: true,
      };
    }
    return {
      ...p,
      iconKey: icons.get(String(p.userId)) ?? null,
      nameColor: colors.get(String(p.userId)) ?? null,
      profileFrame: frames.get(String(p.userId)) ?? null,
      isGuest: false,
    };
  };

  const humanIds = players
    .filter(
      (p) =>
        p.userId &&
        p.userId !== "opponent" &&
        p.userId !== "AI_BOT" &&
        !isGuestId(p.userId),
    )
    .map((p) => p.userId);
  if (humanIds.length === 0) {
    return players.map((p) =>
      badgeFor(p, new Map(), new Map(), new Map()),
    );
  }
  const rows = await db
    .select({
      clerkId: users.clerkId,
      iconKey: users.selectedIcon,
      equippedCosmetics: users.equippedCosmetics,
      chatColor: users.chatColor,
      glowColor: glows.color,
      isPremium: sql`(${tokenSubscriptions.status} IS NOT NULL)`,
    })
    .from(users)
    .leftJoin(
      glows,
      and(eq(glows.key, users.selectedGlow), eq(glows.enabled, true)),
    )
    .leftJoin(
      tokenSubscriptions,
      and(
        eq(tokenSubscriptions.clerkId, users.clerkId),
        inArray(tokenSubscriptions.status, ACTIVE_SUBSCRIPTION_STATUSES),
      ),
    )
    .where(inArray(users.clerkId, humanIds));
  const iconByUser = new Map<string, string | null>();
  const colorByUser = new Map<string, string | null>();
  const frameByUser = new Map<string, unknown>();
  const decorations = await getFrameDecorations(
    rows.map((row) => row.equippedCosmetics),
  );
  const decorationByClerkId = new Map(
    rows.map((row, index) => [String(row.clerkId), decorations[index]]),
  );
  for (const row of rows) {
    iconByUser.set(String(row.clerkId), row.iconKey || null);
    colorByUser.set(
      String(row.clerkId),
      row.glowColor ||
        (Boolean(row.isPremium) ? row.chatColor || null : null) ||
        null,
    );
    frameByUser.set(String(row.clerkId), decorationByClerkId.get(String(row.clerkId)) || null);
  }
  return players.map((p) => badgeFor(p, iconByUser, colorByUser, frameByUser));
}

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const gate = await requirePracticePlayer();
  if (gate.response) return gate.response;

  const url = new URL(req.url);
  const matchId = String(url.searchParams.get("matchId") ?? "");
  if (!matchId) {
    return NextResponse.json(
      { success: false, match: null, error: "Missing matchId." },
      { status: 400 },
    );
  }
  // Opportunistic housekeeping: reclaim lobbies/matches nothing can use any
  // more (throttled internally, best-effort).
  void sweepPrecisionGamesIfDue();

  // Our own wall clock, read ONCE for the response. The client pairs it with
  // its own request timestamps to estimate the device→server clock offset
  // (`estimateServerClockOffset`) and express the server's GO instant in the
  // clock it displays. WITHOUT it the client can only bridge through its raw
  // device clock, so a skewed device shows a round timer that disagrees with
  // the server-measured numbers on the round-result panel — the player stops on
  // the value they were shown and is graded somewhere else entirely.
  const serverNowMs = Date.now();

  // ── Self-healing transitions, now the ONLY path ────────────────────────
  // There are no timers any more. The arming countdown and the bot's stop are
  // stored INSTANTS, so `readMatch` performs whichever transition has come due
  // (revealing the round, recording the bot's stop, deciding the round) and
  // persists it before answering. A frozen or recycled instance therefore
  // cannot strand a round at "0" — the next poll anywhere completes it.
  const row = await readMatch(matchId);
  if (row) {
    const match = row.state;
    return NextResponse.json({
      success: true,
      now: serverNowMs,
      match: {
        ...match,
        players: await decoratePlayerBadges(match.players ?? []),
      },
    });
  }

  const lobby = await getWaitingLobby(matchId);
  if (lobby) {
    // Synthesised lobby-as-state: safe defaults so the client UI doesn't
    // crash when reading score / currentRound before matchmaking has
    // populated the real PrecisionState entry.
    const waitingState: PrecisionState = {
      matchId,
      phase: "waiting",
      wager: lobby.wager,
      players: await decoratePlayerBadges([
        {
          seat: 1,
          userId: lobby.hostUserId,
          name: lobby.hostName || "Player 1",
          isReady: true,
          isConnected: true,
        },
      ]),

      turn: 1,
      score: { seat1: 0, seat2: 0 },
      currentRound: 1,
      // Replay-attack envelope: a waiting lobby has no armed round, so
      // the envelope is null. `precision:stop` rejects packets when
      // either roundId OR nonce is null. Real values land when
      // `markPlayerReady` arms the first round, once both seats have
      // clicked Ready.
      roundSequence: 0,
      roundId: null,
      roundNonce: null,
      // The server rolls the per-round target into the SERVER-ONLY column;
      // the public state stays null until the round opens.
      targetMs: null,
      winnerSeat: null,
      lastRoundWinnerSeat: null,
      lastRoundTargetMs: null,
      armingStartedAt: null,
      countdownEndsAt: null,
      roundGoInstant: null,
      lastRoundStops: null,
      version: 0,
    };
    return NextResponse.json({ success: true, now: serverNowMs, match: waitingState });
  }

  return NextResponse.json({ success: true, now: serverNowMs, match: null });
}
