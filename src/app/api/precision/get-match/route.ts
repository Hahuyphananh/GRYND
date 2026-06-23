// GET /api/precision/get-match?matchId=...
//
// Scaffold stub: returns the current `PrecisionState` for the match.
// We first look for a match by exact id; if none is found we look for a
// lobby and convert it into a waiting-room state so the waiting UI works
// immediately after a host creates a lobby.

import { NextRequest, NextResponse } from "next/server";
import {
  precisionLobbyStore,
  precisionMatchStore,
} from "../../../../lib/precision/serverStore";
import type { PrecisionState } from "../../../../lib/precision/types";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const matchId = String(url.searchParams.get("matchId") ?? "");
  if (!matchId) {
    return NextResponse.json(
      { success: false, match: null, error: "Missing matchId." },
      { status: 400 },
    );
  }

  const match = precisionMatchStore.get(matchId);
  if (match) {
    return NextResponse.json({ success: true, match });
  }

  const lobby = precisionLobbyStore.get(matchId);
  if (lobby && lobby.status === "waiting") {
    // Synthesised lobby-as-state: safe defaults so the client UI doesn't
    // crash when reading score / currentRound before matchmaking has
    // populated the real PrecisionState entry.
    const waitingState: PrecisionState = {
      matchId,
      phase: "waiting",
      wager: lobby.wager,
      players: [
        {
          seat: 1,
          userId: lobby.hostUserId,
          name: lobby.hostName ?? "Player 1",
          isReady: true,
          isConnected: true,
        },
      ],
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
      roundGoInstant: null,
      lastRoundStops: null,
      version: 0,
    };
    return NextResponse.json({ success: true, match: waitingState });
  }

  return NextResponse.json({ success: true, match: null });
}
