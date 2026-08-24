// src/app/api/memory-grid/match/[matchId]/reconstruct/route.js
//
// POST — submit a player's RECONSTRUCT phase picks (the tile indices
// they remember from the memorize phase). SIMULTANEOUS play — no
// turns: a player can submit as soon as they finish, and their seat
// locks immediately (grid frozen, "Waiting for opponent") while the
// other player keeps reconstructing. The round resolves once BOTH
// seats have submitted (or been AFK auto-locked). Server-side
// authoritative:
//   • participant + one-submission-per-seat enforcement (a repeat
//     POST is rejected with 409)
//   • picks validated: distinct tile indices within the current
//     round's grid, up to the full grid (a player may select any
//     number of tiles — over-selection is penalised by the server's
//     full-grid accuracy scoring)
//   • server-authoritative timing: a submission is REJECTED before
//     the official reconstruct start (the memorize pattern-hide
//     deadline). If it arrives after the deadline but the server
//     still shows 'memorize' (poll gap), the server advances to
//     reconstruct anchored on the memorize deadline and accepts —
//     the window and the recorded completion time are identical for
//     both players, and the client clock never affects scoring
//
// The response returns the submitter's round score + the round's
// answer key (`active`) so they can see what they got right/wrong.
// This feedback is only ever returned to the submitter — the
// opponent's /status polls never include the pattern or picks.
//
// The route is intentionally thin: it forwards `picks` to
// `submitReconstruction` in the server store, which performs the
// FOR UPDATE row lock, conditional phase UPDATEs, scoring, and
// synchronous round advancement (next round / match end).

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { submitReconstruction } from "../../../../../../lib/memory-grid/serverStore";
import {
  PHASES,
  RECONSTRUCT_DEADLINE_MS,
  ROUNDS_PER_MATCH,
  phaseStartedAt,
  roundConfig,
} from "../../../../../../lib/memory-grid/constants";
import { broadcastMatchUpdate } from "../../../../../../lib/memory-grid/rooms";

function normaliseMatchForSubmitter(match, viewerUserId) {
  if (!match) return null;
  const finished = match.status === "finished";
  const cfg = roundConfig(match.roundNumber);

  // Authoritative phase timing — same absolute server timestamps the
  // /status route sends, so both players stay synchronized.
  const phaseDurationMs =
    match.phase === PHASES.MEMORIZE
      ? cfg.memorizeMs
      : match.phase === PHASES.RECONSTRUCT
        ? (Number(match.roundTimerSeconds) || 0) * 1000 ||
          RECONSTRUCT_DEADLINE_MS
        : null;
  const phaseStartedAtValue = phaseStartedAt({
    phase: match.phase,
    roundDeadlineMs: match.roundDeadline
      ? new Date(match.roundDeadline).getTime()
      : null,
    phaseDurationMs,
  });

  return {
    id: match.id,
    status: match.status,
    isAi: Boolean(match.isAi),
    phase: match.phase ?? null,
    roundNumber: Number(match.roundNumber || 1),
    roundsPerMatch: ROUNDS_PER_MATCH,
    roundConfig: {
      gridSize: cfg.gridSize,
      activeCount: cfg.activeCount,
      memorizeMs: cfg.memorizeMs,
    },
    // Who has locked in (so the submitter's client can show the
    // frozen "Waiting for opponent" state instantly).
    p1Submitted: Boolean(match.p1Submitted),
    p2Submitted: Boolean(match.p2Submitted),
    phaseStartedAt: phaseStartedAtValue,
    phaseDeadline: match.roundDeadline,
    p1Score: Number(match.p1Score || 0),
    p2Score: Number(match.p2Score || 0),
    p1Total: Number(match.p1Total || 0),
    p2Total: Number(match.p2Total || 0),
    p1RoundScore: Number(match.p1RoundScore || 0),
    p2RoundScore: Number(match.p2RoundScore || 0),
    // Never include the pattern here — the score + active feedback
    // fields carry the submitter's review data instead.
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
  // before reading properties (same fix as the mines-pvp routes).
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

  const picks = body?.picks;
  if (!Array.isArray(picks)) {
    return NextResponse.json(
      { success: false, error: "picks must be an array of tile indices" },
      { status: 400 },
    );
  }

  try {
    const result = await submitReconstruction({ userId, matchId, picks });
    if (result.error) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: result.status || 400 },
      );
    }

    // Best-effort push to the match room so the opponent sees the
    // turn/phase change without waiting for the 1.5s poll. The
    // helper internally handles the no-op case when the
    // realtime-server runs in a separate process.
    broadcastMatchUpdate(matchId, {
      status: result.match?.status,
      roundNumber: result.match?.roundNumber,
      justResolved: Boolean(result.justResolved),
    });

    return NextResponse.json({
      success: true,
      data: {
        match: normaliseMatchForSubmitter(result.match, userId),
        // Submitter-only feedback: their authoritative round
        // assessment (final score + full-grid accuracy breakdown +
        // completion time + speed tier — all computed server-side,
        // never accepted from the client) plus the round's answer key
        // for review.
        score: Number(result.score) || 0,
        total: Number(result.total) || 0,
        correct: Number(result.correct) || 0,
        incorrect: Number(result.incorrect) || 0,
        accuracy: Number(result.accuracy) || 0,
        accuracyPct: Number(result.accuracyPct) || 0,
        completionTimeMs: Number(result.completionTimeMs) || 0,
        speedTier: result.speedTier ?? "very_slow",
        speedMultiplier: Number(result.speedMultiplier) || 1,
        active: Array.isArray(result.active) ? result.active : [],
        roundNumber: Number(result.roundNumber) || 1,
        justResolved: Boolean(result.justResolved),
      },
    });
  } catch (error) {
    console.error("[memory-grid/match/reconstruct] error:", error);
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
