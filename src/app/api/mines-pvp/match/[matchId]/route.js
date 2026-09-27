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
//      turn OR resolve the match (if the auto-pick hit a mine).
//
// CRITICAL — visibility model (shared-board rules). The actual scrubbing
// lives in `src/lib/mines-pvp/matchView.js` (pure + unit-tested), which every
// read path shares so a client can never receive two divergent descriptions
// of the same row:
//   • During active play (`waiting` / `ready` / `p1_turn` / `p2_turn`):
//     - the `board` jsonb is HIDDEN (replaced with `null`) so the
//       client can't peek at mine positions mid-match.
//     - the `picks` jsonb array is FULLY visible to BOTH seats.
//       Every REVEAL on the array is a safe cell — if any had been a
//       mine the match would have ended immediately — so revealing the
//       reveals gives both players the same shared board progress
//       without leaking mine positions.
//     - the CLUE (`hint`) on each reveal is PUBLIC: the shared-board
//       rules give both players the same board, so the server-computed
//       number on a revealed cell is the SAME information for both
//       seats. The client never computes a clue itself; it renders the
//       one the server stamped. (Flag entries carry no clue: a claim is
//       not a reveal.)
//     - FLAG claims are public per seat via `p1Flags` / `p2Flags`.
//       A flag never states whether it was correct — that verdict only
//       exists in the finished reveal, derived from the board.
//     - the viewer sees their OWN auto-pick flag (true/false) so
//       they can render their own AFK state; the OPPONENT's
//       auto-pick flag is scrubbed to false to avoid leaking
//       whether the opponent is AFK.
//   • Once `finished`: full reveal — every reveal in the array has
//     its real `isMine` verdict exposed, plus the full board and the
//     `winnerId` / `winReason` pair.
//
// The match is NEVER mutated from anything the client sends: this route takes
// no body and derives every field from the server-side row.
//
// Mirrors the auth/error/visibility pattern of
// `src/app/api/blackjack-pvp/match/[matchId]/route.js`.

import { NextResponse } from "next/server";
import { requireAgeVerifiedUser } from "../../../../../lib/auth/requireAgeVerified";
import {
  fetchMatchWithAutoResolve,
  fetchMatchRounds,
  enrichMatchWithPlayers,
} from "../../../../../lib/mines-pvp/serverStore";
import { broadcastMatchUpdate } from "../../../../../lib/mines-pvp/rooms";
import { normaliseMatchForViewer } from "../../../../../lib/mines-pvp/matchView";

export async function GET(req, { params }) {
  const gate = await requireAgeVerifiedUser();
  if (gate.response) return gate.response;
  const userId = gate.userId;

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

    // Enrich with player usernames + icon keys so the match view can
    // render proper player heads. Best-effort — never crash the route
    // on lookup failure (the client falls back to seat labels).
    let enrichedMatch = match;
    try {
      const e = await enrichMatchWithPlayers(match);
      if (e) enrichedMatch = e;
    } catch (err) {
      console.warn(
        "[mines-pvp/match] player enrichment failed:",
        err && err.message ? err.message : err,
      );
      enrichedMatch = match;
    }

    // A turn only ever passes because a status request arrived (there is
    // no background scheduler), so the player whose request advanced the
    // match sees the new turn in this response while the other one is
    // still one poll tick — up to 5 s of a 20 s turn — behind. That is
    // worst for the player whose turn it now IS: their clock is already
    // running. Push the new turn to the per-match room so their board
    // becomes usable within milliseconds (fire and forget; a missed push
    // just falls back to the poll).
    if (result.advanced) {
      broadcastMatchUpdate(matchId, {
        status: match.status,
        currentTurnUserId: match.currentTurnUserId ?? null,
        roundDeadline: match.roundDeadline ?? null,
      });
    }

    // Always returns 1 row (this is a single-round game) — kept as
    // an array for API symmetry with the multi-round PvP systems. A row
    // only exists once the match settled (it carries the board snapshot),
    // so an active match returns `rounds: []` and nothing can leak.
    const rounds = await fetchMatchRounds(matchId);

    return NextResponse.json({
      success: true,
      data: {
        match: normaliseMatchForViewer(enrichedMatch, userId),
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
          winReason: r.winReason ?? null,
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
