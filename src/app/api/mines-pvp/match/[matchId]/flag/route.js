// src/app/api/mines-pvp/match/[matchId]/flag/route.js
//
// POST — submit a per-match FLAG ("call a mine") instead of a pick.
// On your turn you may declare a tile you believe is a mine:
//   • CORRECT (tile really is a mine) → opponent loses, you win
//   • WRONG (tile is safe) → you lose
// Terminal either way — the match resolves immediately, so no
// mid-match state is ever leaked by a flag.
//
// Thin mirror of the /pick route: forwards `{ cellIndex }` to
// `flagTile` in the server store, which performs the same
// validation chain as `pickTile` (participant + active state, FOR
// UPDATE row lock, conditional UPDATE on `match.status`, turn
// enforcement via the closed-form odds formula, deadline freshness,
// cell-not-already-picked). Unlike picks, there is NO first-pick
// mercy for flags — a flag is a deliberate claim, not the
// definitionally-guessy opening pick.
//
// Anti-cheat considerations baked into `flagTile`:
//   * only the player whose turn it is can flag (server-trusted
//     clerkId from Clerk's `auth()`)
//   * the board column is never exposed mid-match
//   * a stale submission (post-deadline) is rejected with 400 so
//     the client waits for the next poll's AFK auto-pick instead
//   * duplicate/flag-of-an-already-picked cell rejected with 409
//
// The POST response deliberately omits the flag's isMine (the client
// learns the outcome from the subsequent /status poll, which fully
// reveals the board once status='finished').

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { flagTile } from "../../../../../../lib/mines-pvp/serverStore";
import { GRID_CELLS } from "../../../../../../lib/mines-pvp/constants";
import { broadcastMatchUpdate } from "../../../../../../lib/mines-pvp/rooms";

function normaliseFlagResult(match) {
  if (!match) return null;
  // Only return structural fields — never the flag's isMine (that
  // would leak the answer before the full reveal). The client
  // refetches /status right after, which shows the finished board.
  return {
    id: match.id,
    status: match.status,
    p1Pick: match.p1Pick ?? null,
    p2Pick: match.p2Pick ?? null,
    currentTurnUserId: match.currentTurnUserId,
    roundDeadline: match.roundDeadline,
  };
}

export async function POST(req, { params }) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 },
    );
  }

  // Next.js 15+/16: API route `params` is a Promise — must await
  // before reading properties (same fix as the /pick route).
  const resolvedParams = (await params) || {};
  const matchId = Number(resolvedParams?.matchId);
  if (!Number.isFinite(matchId)) {
    return NextResponse.json(
      { success: false, error: "Invalid matchId" },
      { status: 400 },
    );
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  const cellIndex = Number(body?.cellIndex);
  if (
    !Number.isInteger(cellIndex) ||
    cellIndex < 0 ||
    cellIndex >= GRID_CELLS
  ) {
    return NextResponse.json(
      {
        success: false,
        error: `cellIndex must be an integer in [0, ${GRID_CELLS - 1}]`,
      },
      { status: 400 },
    );
  }

  try {
    const result = await flagTile({ userId, matchId, cellIndex });
    if (result.error) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: result.status || 400 },
      );
    }

    // Best-effort push to the match room so the opponent sees the
    // resolution without waiting for the 1.5s poll.
    broadcastMatchUpdate(matchId, {
      status: result.match?.status,
      justResolved: true,
    });

    // Server-side AI trigger: if the match is a free AI game and the
    // human just flagged, trigger the bot's response. Flags are
    // terminal so this is best-effort only.
    if (result.match?.isAi && result.match?.status !== "finished") {
      try {
        const { playAiTurn } = await import("../../../../../../lib/mines-pvp/serverStore");
        await playAiTurn({ userId: result.match.player1Id, matchId });
      } catch (aiErr) {
        console.error("[mines-pvp/flag] AI turn trigger failed:", aiErr);
      }
    }

    return NextResponse.json({
      success: true,
      data: {
        match: normaliseFlagResult(result.match),
        justResolved: true,
      },
    });
  } catch (error) {
    console.error("[mines-pvp/match/flag] error:", error);
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
