// src/app/api/mines-pvp/match/[matchId]/flag/route.js
//
// POST — submit a per-match FLAG (a per-player CLAIM) instead of a pick.
// On your turn you may declare a tile you believe is a mine:
//   • The claim is added to YOUR OWN flag set (`p1Flags` / `p2Flags`).
//     The two seats' collections are independent.
//   • A WRONG claim is NOT a loss — the turn simply passes to the
//     opponent.
//   • Claiming EVERY mine wins IMMEDIATELY
//     (`winReason: 'all_mines_flagged'`).
//
// Thin mirror of the /pick route: forwards `{ cellIndex }` to
// `flagTile` in the server store, which performs the same
// validation chain as `pickTile` (participant + active state, FOR
// UPDATE row lock, conditional UPDATE on `match.status`, turn
// enforcement via the closed-form odds formula, deadline freshness,
// cell-not-already-REVEALED, cell-not-already-claimed-by-you).
//
// Anti-cheat considerations baked into `flagTile`:
//   * only the player whose turn it is can flag (server-trusted
//     clerkId from Clerk's `auth()`)
//   * the board column is never exposed mid-match
//   * a stale submission (post-deadline) is rejected with 400 so
//     the client waits for the next poll's AFK auto-pick instead
//   * flagging an already-REVEALED cell, or re-flagging a cell you
//     already claimed, is rejected with 409
//   * whether a claim was CORRECT is board-derived and never leaves
//     the server while the match is live — the flag entry itself
//     carries no verdict, so a claim leaks nothing
//
// The POST response deliberately omits any correctness verdict (the
// client learns the outcome from the subsequent /status poll, which
// fully reveals the board once status='finished'). It DOES return the
// caller's updated flag set so the toggle reflects the claim at once.

import { NextResponse } from "next/server";
import { requireAgeVerifiedUser } from "../../../../../../lib/auth/requireAgeVerified";
import { flagTile } from "../../../../../../lib/mines-pvp/serverStore";
import {
  GRID_CELLS,
  flagsForSeat,
} from "../../../../../../lib/mines-pvp/constants";
import { broadcastMatchUpdate } from "../../../../../../lib/mines-pvp/rooms";

function normaliseFlagResult(match) {
  if (!match) return null;
  // Only return structural fields plus the PUBLIC flag claims — never any
  // correctness verdict (that would leak the answer before the full
  // reveal). The client refetches /status right after, which shows the
  // finished board when the sweep completed.
  return {
    id: match.id,
    status: match.status,
    p1Pick: match.p1Pick ?? null,
    p2Pick: match.p2Pick ?? null,
    currentTurnUserId: match.currentTurnUserId,
    roundDeadline: match.roundDeadline,
    p1Flags: flagsForSeat(match, "player1"),
    p2Flags: flagsForSeat(match, "player2"),
    winReason: match.winReason ?? null,
    winnerId: match.winnerId ?? null,
  };
}

export async function POST(req, { params }) {
  const gate = await requireAgeVerifiedUser();
  if (gate.response) return gate.response;
  const userId = gate.userId;

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

    // Best-effort push to the match room so the opponent sees the new
    // turn (or the all-mines-flagged finish) without waiting for a poll.
    // Same `lobby:updated` event as the rest of the game — listeners
    // refetch `/status` for authoritative state and the payload never
    // carries board or flag-correctness data.
    broadcastMatchUpdate(matchId, {
      status: result.match?.status,
      currentTurnUserId: result.match?.currentTurnUserId ?? null,
      roundDeadline: result.match?.roundDeadline ?? null,
      winnerId: result.match?.winnerId ?? null,
      winReason: result.match?.winReason ?? null,
      justResolved: Boolean(result.justResolved),
    });

    // Server-side AI trigger: if the match is a free AI game and the human
    // just flagged, trigger the bot's response. Best-effort only — a flag
    // is no longer terminal, so the bot may well have a turn now.
    if (result.match?.isAi && !result.justResolved) {
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
        justResolved: Boolean(result.justResolved),
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
