// src/app/api/mines-pvp/match/[matchId]/route.js
//
// GET — fetch current match state with auto-resolve behaviour. The
// server store handles three auto-advance paths inside
// `fetchMatchWithAutoResolve`:
//   1. `ready` deadline elapsed → advance to first pick state
//      (p1_turn or p2_turn depending on the host's first-player
//      roll).
//   2. `p1_turn` / `p2_turn` deadline elapsed → force-pick a random
//      cell for the current player (AFK nudge), then advance the
//      turn OR resolve the match (if it was player2's auto-pick).
//
// CRITICAL — visibility model (odds turn flow):
//   • During active play (`ready` / `p1_turn` / `p2_turn`):
//     - the `board` jsonb is HIDDEN (replaced with `null`) so the
//       client can't peek at mine positions mid-match.
//     - the `picks` jsonb array is FULLY visible to BOTH seats.
//       Every pick on the array must be a SAFE pick — if any had
//       been a mine the match would have ended immediately, so
//       revealing safe picks (cell indexes only, NOT
//       isMine/autoPicked which would otherwise leak AFK state)
//       gives both players faithful board progress without
//       leaking mine positions.
//     - the proximity `hint` on each pick is PRIVATE: only the
//       viewer's OWN picks carry their number mid-match, so the
//       opponent's picks give away no clues (each player builds
//       their own picture of the board).
//     - the viewer sees their OWN auto-pick flag (true/false) so
//       they can render their own AFK state; the OPPONENT's
//       auto-pick flag is scrubbed to false to avoid leaking
//       whether the opponent is AFK.
//   • Once `finished`: full reveal — every pick in the array has
//     its full metadata exposed (cellIndex, isMine, autoPicked,
//     pickedAt), plus the full board.
//
// Mirrors the auth/error/visibility pattern of
// `src/app/api/blackjack-pvp/match/[matchId]/route.js`.

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import {
  fetchMatchWithAutoResolve,
  fetchMatchRounds,
} from "../../../../../lib/mines-pvp/serverStore";
import {
  GRID_CELLS,
  MATCH_STATUS,
} from "../../../../../lib/mines-pvp/constants";

function isTerminalStatus(status) {
  return status === MATCH_STATUS.FINISHED || status === MATCH_STATUS.CANCELLED;
}

// Per-seat scrub helper for the legacy single-pick columns. Kept
// for backwards-compat with any client that still reads
// `p1Pick` / `p2Pick` etc. directly; new clients should consume the
// `picks` array (returned by `scrubPicksForViewer`) instead. The
// legacy columns show the MOST RECENT pick from each seat (mirrored
// server-side) so the rendered cell matches the latest entry in
// the per-seat slice of `picks`.
function scrubPickColumnsForViewer(match, viewerUserId) {
  const viewerIsPlayer1 = match.player1Id === viewerUserId;
  const finished = isTerminalStatus(match.status);

  return {
    p1Pick: match.p1Pick ?? null,
    p1PickIsMine:
      finished || viewerIsPlayer1 ? match.p1PickIsMine ?? null : null,
    p1PickedAt:
      finished || viewerIsPlayer1 ? match.p1PickedAt ?? null : null,
    p1AutoPicked:
      finished || viewerIsPlayer1 ? Boolean(match.p1AutoPicked) : false,
    p2Pick: match.p2Pick ?? null,
    p2PickIsMine:
      finished || !viewerIsPlayer1 ? match.p2PickIsMine ?? null : null,
    p2PickedAt:
      finished || !viewerIsPlayer1 ? match.p2PickedAt ?? null : null,
    p2AutoPicked:
      finished || !viewerIsPlayer1 ? Boolean(match.p2AutoPicked) : false,
  };
}

// Scrub the per-pick `picks` array for the viewer. Mid-game, only
// safe picks can exist (a mine would have ended the match), so we
// hardcode `isMine: false` and scrub the OPPONENT's `autoPicked`
// flag to false so neither side can deduce the other's AFK state.
function scrubPicksForViewer(picks, viewerUserId, match, finished) {
  if (!Array.isArray(picks)) return [];
  const sanitized = [];
  for (const raw of picks) {
    if (!raw || typeof raw !== "object") continue;
    const isViewerPick =
      typeof raw.userId === "string" && raw.userId === viewerUserId;
    sanitized.push({
      userId: raw.userId ?? null,
      seat: raw.seat ?? null,
      cell: Number(raw.cell) || 0,
      // Mid-game scrub: every pick is safe (game would have ended).
      // Finished: reveal the actual isMine flag (the game-ending
      // mine is the one whose isMine=true inside this array).
      isMine:
        finished || isViewerPick ? Boolean(raw.isMine) : false,
      // Proximity hint (distance to the nearest mine, 1+ for safe
      // picks). PRIVATE: only the picker's own picks carry it
      // mid-match (the opponent's are stripped so they can't scrape
      // free clues off the shared board); the post-match reveal
      // shows everything.
      hint:
        finished || isViewerPick
          ? raw.hint != null
            ? Number(raw.hint)
            : null
          : null,
      pickedAt: typeof raw.pickedAt === "string" ? raw.pickedAt : null,
      // The viewer's own auto-pick is fine to reveal; the OPPONENT's
      // is scrubbed to false (AFK should not be visible to a peer).
      autoPicked:
        finished || isViewerPick ? Boolean(raw.autoPicked) : false,
      // Flag discriminator: true when this entry ended the match via
      // the "call a mine" move. A flag is terminal, so it can only
      // ever appear in the finished reveal — pass it through so the
      // client can render flag-specific result copy.
      flag: Boolean(raw.flag),
    });
  }
  return sanitized;
}

function normaliseMatchForViewer(match, viewerUserId) {
  if (!match) return null;
  const viewerIsPlayer1 = match.player1Id === viewerUserId;
  const finished = isTerminalStatus(match.status);
  const picks = scrubPicksForViewer(
    Array.isArray(match.picks) ? match.picks : [],
    viewerUserId,
    match,
    finished,
  );

  // Safe-tiles counter — the zugzwang legibility stat. The client
  // CANNOT derive this mid-match (the opponent's picks have their
  // `isMine` scrubbed, so a viewer can't count safe reveals they
  // didn't make), so the server stamps it from the board + raw pick
  // history: total safe cells (25 − mines) minus every safe pick so
  // far (mine picks never count — and mid-match there are none yet,
  // because a mine would have ended the game). As it approaches 0,
  // only mines are left unrevealed: whoever's turn it is next loses
  // by logic — the zugzwang endgame.
  const safeTilesTotal = GRID_CELLS - Number(match.minesCount);
  const safePicksMade = (Array.isArray(match.picks) ? match.picks : []).filter(
    (p) => p && !Boolean(p.isMine),
  ).length;

  return {
    id: match.id,
    player1Id: match.player1Id,
    player2Id: match.player2Id,
    stakeAmount: Number(match.stakeAmount),
    minesCount: match.minesCount,
    safeTilesRemaining: Math.max(0, safeTilesTotal - safePicksMade),
    status: match.status,
    firstPlayerId: match.firstPlayerId,
    currentTurnUserId: match.currentTurnUserId,
    roundDeadline: match.roundDeadline,
    viewerIsPlayer1,
    isViewerTurn: match.currentTurnUserId === viewerUserId,
    // New odds-turn fields: the chronological pick history is the
    // authoritative source. Clients render the board from this
    // array; the legacy single-pick scalars are mirrored for
    // backwards-compat only.
    picks,
    pickCount: picks.length,
    ...scrubPickColumnsForViewer(match, viewerUserId),
    // Board: full reveal at finished, hidden mid-match.
    board: finished ? match.board : null,
    // Result + payout. Loser sees zero prize/fees (avoids leaking
    // the winner's exact payout amount). The new odds-turn flow
    // never produces a DRAW; the field stays on the response for
    // legacy consumers.
    result: match.result ?? null,
    winnerId: match.winnerId ?? null,
    prizePaid:
      finished && match.winnerId === viewerUserId
        ? Number(match.prizePaid) || 0
        : 0,
    houseFee:
      finished && match.winnerId === viewerUserId
        ? Number(match.houseFee) || 0
        : 0,
    startedAt: match.startedAt,
    endedAt: match.endedAt,
    createdAt: match.createdAt,
  };
}

export async function GET(req, { params }) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 },
    );
  }

  // Next.js 15+/16: API route `params` is a Promise — must await before
  // reading properties. Accessing it synchronously yields `undefined`,
  // which `Number(undefined)` coerces to `NaN`, which the finite-check
  // below rejects with "Invalid matchId" — masking the real match and
  // stranding the user on the "Invalid match link." panel right after
  // they create a lobby. Same fix applied to the roulette-pvp and
  // blackjack-pvp match routes.
  const resolvedParams = (await params) || {};
  const matchId = Number(resolvedParams?.matchId);
  if (!Number.isFinite(matchId)) {
    return NextResponse.json(
      { success: false, error: "Invalid matchId" },
      { status: 400 },
    );
  }

  try {
    const result = await fetchMatchWithAutoResolve(userId, matchId);
    if (result.error) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: result.status || 400 },
      );
    }
    const match = result.match;
    if (!match) {
      return NextResponse.json(
        { success: false, error: "Match not found" },
        { status: 404 },
      );
    }

    // Always returns 1 row (this is a single-round game) — kept as
    // an array for API symmetry with the multi-round PvP systems.
    const rounds = await fetchMatchRounds(matchId);

    return NextResponse.json({
      success: true,
      data: {
        match: normaliseMatchForViewer(match, userId),
        rounds: rounds.map((r) => ({
          id: r.id,
          roundNumber: r.roundNumber,
          p1Pick: r.p1Pick,
          p2Pick: r.p2Pick,
          p1PickIsMine: r.p1PickIsMine,
          p2PickIsMine: r.p2PickIsMine,
          p1AutoPicked: Boolean(r.p1AutoPicked),
          p2AutoPicked: Boolean(r.p2AutoPicked),
          boardSnapshot: r.boardSnapshot ?? null,
          roundWinner: r.roundWinner,
          createdAt: r.createdAt,
        })),
      },
    });
  } catch (error) {
    console.error("[mines-pvp/match] error:", error);
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
