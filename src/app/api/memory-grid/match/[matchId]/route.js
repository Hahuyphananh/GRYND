// src/app/api/memory-grid/match/[matchId]/route.js
//
// GET — fetch current match state with auto-resolve behaviour. The
// server store handles the auto-advance paths inside
// `fetchMatchWithAutoResolve`:
//   1. `ready` deadline elapsed → open round 1's memorize phase.
//   2. memorize deadline elapsed → the pattern hides for BOTH
//      players and reconstruct opens.
//   3. reconstruct deadline elapsed → AFK auto-lock of any seat that
//      hasn't submitted (score 0); once both seats are in the round
//      resolves (and the next round or match-end opens).
//
// SIMULTANEOUS play — no turns. Both players are always in the same
// phase (`status='active'` + `phase`), and the round resolves only
// once BOTH have submitted (`p1Submitted`/`p2Submitted`).
//
// CRITICAL — pattern visibility model:
//   • The round PATTERN (`board`: grid size + active tile indices) is
//     revealed to BOTH players simultaneously during the round's
//     memorize phase (they study the same grid at the same time),
//     and to both again during the round-result phase (so the result
//     screen can render the correct pattern) and once the match is
//     `finished` (post-match reveal). Any other time the `pattern`
//     field is `null`.
//   • `p1Submitted`/`p2Submitted` tell each client who has locked in;
//     a submitter freezes their grid and waits for the opponent.
//   • Both players always see rounds-won (`p1Score`/`p2Score`) and
//     current-round scores (`p1RoundScore`/`p2RoundScore`).
//   • During phase='result' (both submitted, round snapshot being
//     shown): the last completed round's snapshot is exposed via
//     `rounds` so BOTH clients render the round-result screen
//     (correct pattern + both reconstructions + accuracy/time/score).
//   • Once `finished`: full reveal — the final round's pattern + the
//     full per-round breakdown (`rounds`).
//
// Mirrors the auth/error pattern of
// `src/app/api/mines-pvp/match/[matchId]/route.js` and the
// synchronized-commit shape of plinko-pvp.

import { NextResponse } from "next/server";
import { requireAgeVerifiedUser } from "../../../../../lib/auth/requireAgeVerified";
import {
  fetchMatchWithAutoResolve,
  fetchMatchRounds,
  enrichMatchesWithUsers,
} from "../../../../../lib/memory-grid/serverStore";
import {
  OVERTIME_DRAW_FEE_PCT,
  PHASES,
  RECONSTRUCT_DEADLINE_MS,
  RESULT_WINDOW_MS,
  ROUNDS_PER_MATCH,
  phaseStartedAt,
  roundConfig,
} from "../../../../../lib/memory-grid/constants";
import { broadcastMatchUpdate } from "../../../../../lib/memory-grid/rooms";

function normaliseMatchForViewer(match, viewerUserId) {
  if (!match) return null;
  const finished = match.status === "finished";
  const active = match.status === "active";
  const cfg = roundConfig(match.roundNumber);

  // Authoritative phase timing — absolute server timestamps sent to
  // BOTH players identically, so both countdowns are synchronized and
  // the client clock never influences the official completion time.
  // phaseStartedAt = when the current phase began (derived from the
  // server-stamped roundDeadline minus the phase duration);
  // phaseDeadline = when it ends.
  const phaseDurationMs =
    match.phase === PHASES.MEMORIZE
      ? cfg.memorizeMs
      : match.phase === PHASES.RECONSTRUCT
        ? (Number(match.roundTimerSeconds) || 0) * 1000 ||
          RECONSTRUCT_DEADLINE_MS
        : match.phase === PHASES.RESULT
          ? RESULT_WINDOW_MS
          : null;
  const phaseStartedAtValue = phaseStartedAt({
    phase: match.phase,
    roundDeadlineMs: match.roundDeadline
      ? new Date(match.roundDeadline).getTime()
      : null,
    phaseDurationMs,
  });

  // The pattern (grid size + active tile indices) is server-only.
  // Reveal it only when BOTH players are entitled to see it: the
  // round's memorize phase (simultaneous study), the round-result
  // phase (result screen renders the correct pattern), or everyone
  // once the match is finished (post-match reveal).
  const canSeePattern =
    finished || (active && (match.phase === "memorize" || match.phase === "result"));

  return {
    id: match.id,
    player1Id: match.player1Id,
    player2Id: match.player2Id,
    isAi: Boolean(match.isAi),
    stakeAmount: Number(match.stakeAmount),
    status: match.status,
    phase: match.phase ?? null,
    roundNumber: Number(match.roundNumber || 1),
    roundsPerMatch: ROUNDS_PER_MATCH,
    // The current round's configuration so the client can render the
    // right grid size / pick count / memorize duration.
    roundConfig: {
      gridSize: cfg.gridSize,
      activeCount: cfg.activeCount,
      memorizeMs: cfg.memorizeMs,
    },
    viewerIsPlayer1: match.player1Id === viewerUserId,
    // The server's clock at the moment this payload was built. Client
    // clocks are regularly off by seconds, and every phase boundary
    // below is an absolute SERVER timestamp — a client running ahead
    // would hide the memorize pattern (and flip itself into the
    // reconstruct UI) the moment the payload landed, which is why the
    // preview sometimes never appeared. The match view tracks the
    // offset from this value and compares like-for-like.
    serverNow: new Date().toISOString(),
    // Who has locked in their reconstruction this round (drives the
    // "Waiting for opponent" / "Opponent submitted" UI states).
    p1Submitted: Boolean(match.p1Submitted),
    p2Submitted: Boolean(match.p2Submitted),
    phaseStartedAt: phaseStartedAtValue,
    phaseDeadline: match.roundDeadline,
    // Rounds-won tallies (match-level score).
    p1Score: Number(match.p1Score || 0),
    p2Score: Number(match.p2Score || 0),
    // Cumulative round-score points (each round scores /100) — the
    // compact in-match scoreboard's headline numbers.
    p1Total: Number(match.p1Total || 0),
    p2Total: Number(match.p2Total || 0),
    // Current-round reconstruction scores (0 until that player
    // submits; scores are non-negative so 0 is indistinguishable
    // from "not yet submitted").
    p1RoundScore: Number(match.p1RoundScore || 0),
    p2RoundScore: Number(match.p2RoundScore || 0),
    // Pattern per the reveal rules above; null otherwise.
    pattern: canSeePattern ? match.board : null,
    // Player heads (displayName + official iconKey) — populated by
    // enrichMatchesWithUsers in the server store. The match view
    // renders real names/avatars (official Grynd icons) for the player
    // cards instead of raw Clerk-id truncation (mirrors plinko-pvp / keno-pvp).
    players: match.players ?? null,
    // Provably-fair seed bookkeeping (lane-rush-duel convention):
    // the committed SHA-256 hash is always visible, and the raw
    // server seed is revealed only post-match so anyone can verify
    // every round's pattern was derived deterministically.
    serverSeedHash: match.serverSeedHash ?? null,
    serverSeed: finished ? (match.serverSeed ?? null) : null,
    // Result + payout. Loser sees zero prize/fees (avoids leaking
    // the winner's exact payout amount). On a finished DRAW (only
    // reachable when the round-6 tiebreak also ties) both players
    // get the same refundEach back — 95% of their stake (5% per-
    // side rake) — so it is safe to show to both.
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
    refundEach:
      finished && match.result === "draw"
        ? Number(
            (Number(match.stakeAmount) * (1 - OVERTIME_DRAW_FEE_PCT)).toFixed(
              2,
            ),
          ) || 0
        : null,
    startedAt: match.startedAt,
    endedAt: match.endedAt,
    createdAt: match.createdAt,
  };
}

export async function GET(req, { params }) {
  const gate = await requireAgeVerifiedUser();
  if (gate.response) return gate.response;
  const userId = gate.userId;

  // Next.js 15+/16: API route `params` is a Promise — must await
  // before reading properties (same fix as the mines-pvp routes).
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

    // Enrich with user names + profile images so the match view can
    // render proper player cards. Best-effort — degrades to raw
    // Clerk ids on lookup failure (never crash the route).
    let enrichedMatch = match;
    try {
      const e = await enrichMatchesWithUsers(match);
      if (e) enrichedMatch = e;
    } catch (err) {
      console.warn(
        "[memory-grid/match] user enrichment failed:",
        err && err.message ? err.message : err,
      );
    }

    const finished = enrichedMatch.status === "finished";
    // Round snapshots for the result screens. Exposed once the match
    // is finished (full per-round breakdown) AND while phase='result'
    // (the just-completed round's snapshot — both players render the
    // round-result screen from it before the server advances).
    const inResult = enrichedMatch.status === "active" && enrichedMatch.phase === PHASES.RESULT;
    const rounds = finished || inResult ? await fetchMatchRounds(matchId) : [];

    // A phase transition only ever happens because a status request
    // arrived (there is no background scheduler), so the player whose
    // request triggered it sees the new phase in this response while the
    // other player is still one poll tick — up to 5 s — behind. That is
    // fatal for the memorize preview: its window is only 2.5–4 s and the
    // pattern is never sent again once the round has moved to
    // reconstruct. Push the new phase to the per-match room (fire and
    // forget; a missed push just falls back to the poll).
    if (result.advanced) {
      broadcastMatchUpdate(matchId, {
        phase: match.phase ?? null,
        roundNumber: Number(match.roundNumber || 1),
        status: match.status,
      });
    }

    return NextResponse.json({
      success: true,
      data: {
        match: normaliseMatchForViewer(enrichedMatch, userId),
        rounds,
      },
    });
  } catch (error) {
    console.error("[memory-grid/match] error:", error);
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
