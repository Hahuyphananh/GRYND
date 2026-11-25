// src/app/api/solitaire-duel/match/[matchId]/timeline/route.ts
//
// GET — the post-match TIMELINE ("Mistake Finder").
//
//   FREE  → the final score plus basic stats only (`locked: true`, no events).
//   PRO   → the same basics plus every event from both stored move logs, with
//           wasted moves, time-loss spikes and lead changes marked, ready for
//           the replay scrubber.
//
// AUTHORISATION reuses the review route's gate exactly: `requirePracticePlayer`
// resolves the account (or signed guest), and `fetchMatch` refuses a
// non-participant with 403. The id comes from the URL; the identity never does.
//
// WHAT IS EXPOSED, AND WHEN
//   * Only a TERMINAL match. A live match would leak the deal's face-down cards
//     and the stock order, so it is 409.
//   * Aimed at the stored logs, never the boards. No deal and no `p_*_state`
//     JSON is ever returned, so the timeline can show the race without handing
//     over a solvable board.
//   * PRO comes from `getMembershipTier` — the same server-authoritative source
//     as every other PRO perk. It is never read from the client.
//
// COST: a free request reads the match row only. The viewer's Game Review
// analysis (the move ratings behind "wasted moves") is loaded AFTER the PRO
// check, through the existing cache-first allowance path, so this endpoint can
// never spend a free account's daily analyses.

import { NextResponse } from "next/server";

import { requirePracticePlayer } from "../../../../../../lib/auth/guestSession";
import { logError } from "../../../../../../lib/logError";
import { getMembershipTier } from "../../../../../../lib/stripe/subscriptions";
import { loadReviewAnalysis } from "../../../../../../lib/solitaire-duel/reviewAnalysis";
import {
  MATCH_STATUS,
  TERMINAL_STATUSES,
} from "../../../../../../lib/solitaire-duel/constants";
import { toIso } from "../../../../../../lib/solitaire-duel/review";
import {
  buildMatchTimeline,
  type TimelineSeat,
  type TimelineSeatInput,
  type TimelineSeatMove,
} from "../../../../../../lib/solitaire-duel/postMatchTimeline";
import {
  canonicalMoveLog,
  moveLogDigest,
} from "../../../../../../lib/solitaire-duel/soloPersistence";
import {
  fetchMatch,
  fetchSeatMoves,
  isMatchId,
  stateForSeat,
} from "../../../../../../lib/solitaire-duel/serverStore";

export const dynamic = "force-dynamic";

function isoMs(value: unknown): number | null {
  const iso = toIso(value);
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function toSeatMoves(
  rows: readonly { ply: number; kind: string; move: unknown; createdAt: Date }[],
): TimelineSeatMove[] {
  return rows.map((row) => ({
    ply: Number(row.ply) || 0,
    kind: row.kind,
    move: row.move,
    atMs: row.createdAt instanceof Date ? row.createdAt.getTime() : Number(row.createdAt),
  }));
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ matchId: string }> },
) {
  const gate = await requirePracticePlayer();
  if (gate.response) return gate.response;
  const userId = gate.playerId;
  if (!userId) {
    return NextResponse.json({ success: false, error: "Unauthenticated" }, { status: 401 });
  }

  const resolved = (await params) || ({} as { matchId?: string });
  const matchId = resolved.matchId;
  if (!isMatchId(matchId)) {
    return NextResponse.json({ success: false, error: "Invalid matchId" }, { status: 400 });
  }

  try {
    const result = await fetchMatch({ userId, matchId });
    if ("error" in result) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: result.status },
      );
    }
    const { match, dto } = result;

    if (!TERMINAL_STATUSES.includes(match.status)) {
      return NextResponse.json(
        {
          success: false,
          error: "The match has not finished yet",
          code: "TIMELINE_NOT_READY",
        },
        { status: 409 },
      );
    }
    if (match.status === MATCH_STATUS.CANCELLED) {
      return NextResponse.json(
        { success: false, error: "The match was cancelled before it was played" },
        { status: 409 },
      );
    }

    const seat: TimelineSeat = dto.seat;
    const opposingSeat: TimelineSeat = seat === "player1" ? "player2" : "player1";
    const startedAtMs = isoMs(match.startedAt ?? match.goAt ?? match.createdAt);
    const endedAtMs = isoMs(match.endedAt);

    // ── FREE PAYLOAD — final score + basic stats, from the match row alone ──
    const youPly = Number(seat === "player1" ? match.p1Ply : match.p2Ply) || 0;
    const opponentPly =
      Number(opposingSeat === "player1" ? match.p1Ply : match.p2Ply) || 0;
    const youPeak = Number(
      seat === "player1" ? match.p1PeakFoundation : match.p2PeakFoundation,
    );
    const opponentPeak = Number(
      opposingSeat === "player1" ? match.p1PeakFoundation : match.p2PeakFoundation,
    );
    const youFinishedAt = isoMs(
      seat === "player1" ? match.p1FinishedAt : match.p2FinishedAt,
    );
    const opponentFinishedAt = isoMs(
      opposingSeat === "player1" ? match.p1FinishedAt : match.p2FinishedAt,
    );

    const basic = {
      durationMs:
        startedAtMs !== null && endedAtMs !== null
          ? Math.max(0, endedAtMs - startedAtMs)
          : null,
      yourSeat: seat,
      moves: { you: youPly, opponent: opponentPly },
      peakProgress: {
        you: Number.isFinite(youPeak) ? youPeak : 0,
        opponent: Number.isFinite(opponentPeak) ? opponentPeak : 0,
      },
      finishedAtMs: {
        you:
          startedAtMs !== null && youFinishedAt !== null
            ? Math.max(0, youFinishedAt - startedAtMs)
            : null,
        opponent:
          startedAtMs !== null && opponentFinishedAt !== null
            ? Math.max(0, opponentFinishedAt - startedAtMs)
            : null,
      },
    };

    // Guests own no subscription row, so this answer is "free" for them with
    // no special case — and a membership read failure fails closed.
    let isPro = false;
    try {
      isPro = (await getMembershipTier(userId)) === "pro";
    } catch {
      isPro = false;
    }

    if (!isPro) {
      return NextResponse.json({
        success: true,
        data: {
          pro: false,
          locked: true,
          gameKey: "solitaire-duel",
          progressLabel: "foundation cards",
          progressMax: 52,
          reviewHref: `/solitaire/review/duel/${encodeURIComponent(String(match.id))}`,
          basic,
        },
      });
    }

    // ── PRO PAYLOAD — both stored logs, never the boards ────────────────────
    const [youRows, opponentRows] = await Promise.all([
      fetchSeatMoves(String(match.id), seat),
      fetchSeatMoves(String(match.id), opposingSeat),
    ]);

    // The stored log must match the settled ply count; a short or long log
    // would silently produce a timeline of a different game.
    if (youRows.length !== youPly) {
      return NextResponse.json(
        {
          success: false,
          error: "The stored move history is inconsistent",
          code: "TIMELINE_HISTORY_INCONSISTENT",
        },
        { status: 409 },
      );
    }

    const canonical = canonicalMoveLog(youRows);
    const analysis = canonical.ok
      ? await loadReviewAnalysis({
          gameKind: "duel",
          gameId: String(match.id),
          logDigest: moveLogDigest(canonical.log),
          deal: match.deal as never,
          moves: canonical.log,
          playerId: userId,
        })
      : null;

    const youState = stateForSeat(match, seat);
    const opponentState = stateForSeat(match, opposingSeat);

    const seats: TimelineSeatInput[] = [
      {
        seat,
        label: "You",
        moves: toSeatMoves(youRows),
        completed: youState?.completed === true,
        forfeited: match.resolutionReason === "forfeit" && match.result !== seat,
      },
      {
        seat: opposingSeat,
        label: "Opponent",
        moves: toSeatMoves(opponentRows),
        completed: opponentState?.completed === true,
        forfeited: match.resolutionReason === "forfeit" && match.result !== opposingSeat,
      },
    ];

    const timeline = buildMatchTimeline({
      startedAtMs,
      endedAtMs,
      seats,
      ratings: analysis?.analysis
        ? { seat, perMove: analysis.analysis.perMove }
        : null,
      progressMax: 52,
    });

    return NextResponse.json({
      success: true,
      data: {
        pro: true,
        locked: false,
        gameKey: "solitaire-duel",
        progressLabel: "foundation cards",
        progressMax: 52,
        reviewHref: `/solitaire/review/duel/${encodeURIComponent(String(match.id))}`,
        basic,
        timeline,
        analysisCached: analysis?.cached ?? false,
        // Board preview: the viewer's OWN deal and validated log, so the
        // scrubber can rebuild the position at any ply. Only a terminal match
        // reaches here, and only for its participant — the same deal the Game
        // Review page already shows them.
        preview: {
          game: "solitaire",
          deal: match.deal,
          moves: canonical.ok ? canonical.log : [],
        },
      },
    });
  } catch (error) {
    await logError({
      errorType: "solitaire_duel_timeline_error",
      errorMessage:
        error instanceof Error ? error.message : "Solitaire Duel timeline failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/solitaire-duel/match/[matchId]/timeline",
      game: "Solitaire Duel",
      metadata: { operation: "timeline" },
    });
    return NextResponse.json({ success: false, error: "Server error" }, { status: 500 });
  }
}
