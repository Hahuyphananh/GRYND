// src/app/api/mines-pvp/match/[matchId]/route.js
//
// GET — fetch the caller's current match state with auto-advance /
// auto-resolve behaviour. The server store handles the paths inside
// `fetchMatchWithAutoResolve`:
//   1. `ready` deadline elapsed → go `active` and open the single
//      server-authoritative 180s match timer.
//   2. `active` + timer expired → settle by score (the tiebreak ladder).
//   3. `active` + free vs-AI → let the bot play its own board.
//
// There are NO turns any more: nothing force-picks for an AFK seat and
// no per-turn deadline exists. Both seats act at will until their board
// completes or the 180s clock runs out.
//
// CRITICAL — visibility model (simultaneous independent boards). The
// actual per-viewer serialisation lives in `src/lib/mines-pvp/matchView.js`
// (pure + unit-tested), which every read path shares so a client can never
// receive two divergent descriptions of the same row:
//   • During active play (`waiting` / `ready` / `active`):
//     - the hidden `board` jsonb is HIDDEN (replaced with `null`) so the
//       client can't peek at mine positions mid-match.
//     - each seat sees ONLY its OWN resolved cells (`myRevealed`),
//       its own flags (`myFlags` / `myCorrectFlagCells` /
//       `myIncorrectFlagCells`) and its own score. The CLUE (`hint`) on
//       a safe reveal is the server-computed distance to that seat's
//       OWN nearest mine — the player already saw it, and it is never
//       shared with the opponent.
//     - the opponent is exposed ONLY as PUBLIC progress: score, safe
//       reveals, mines hit, correct/incorrect flag counts and the
//       completion flag. Their board, mine positions and mine values
//       are never serialised.
//     - a confirmed mine (a correct flag) renders on the flagging
//       seat's own board; the opponent never learns WHICH mine it was.
//     - mine VALUES are never sent while the match is live — only the
//       awarded score delta appears (see the action routes).
//   • Once `finished`: the full replay is revealed — both seats' boards
//     with their mine values, plus the `result` / `winnerId` /
//     `winReason` triple.
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

    // The match only advances because a status request arrived (there is
    // no background scheduler), so the player whose request advanced it
    // sees the new state immediately while the other one is still up to
    // one poll tick behind. Push a bare refetch hint to the per-match
    // room so the opponent's HUD (score / progress / clock) catches up in
    // milliseconds (fire and forget; a missed push just falls back to the
    // poll). It carries public state only — never a board or mine value.
    if (result.advanced) {
      broadcastMatchUpdate(matchId, {
        status: match.status,
        matchDeadline: match.matchDeadline ?? null,
        p1Score: Number(match.p1Score) || 0,
        p2Score: Number(match.p2Score) || 0,
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
          // Final replay snapshot — both seats' scores, both boards (with
          // mine values) and each seat's full play history (revealed tiles,
          // flags, mines hit, completion times). Only ever present once the
          // match has settled; an active match returns `rounds: []`.
          p1Score: r.p1Score ?? null,
          p2Score: r.p2Score ?? null,
          boardSnapshot: r.boardSnapshot ?? null,
          p2BoardSnapshot: r.p2BoardSnapshot ?? null,
          p1FinalState: r.p1FinalState ?? null,
          p2FinalState: r.p2FinalState ?? null,
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
