// src/app/api/sudoku-duel/match/[matchId]/timeline/route.ts
//
// GET — the post-match TIMELINE ("Mistake Finder") for a Sudoku Duel.
//
//   FREE  → the final score plus basic stats only (`locked: true`, no events).
//   PRO   → the same basics plus every judged action from both stored logs, with
//           incorrect/cleared entries, time-loss spikes and lead changes marked,
//           and a per-move preview the scrubber can draw.
//
// The shape and the rules are the SAME as the Solitaire Duel timeline route:
// `src/lib/solitaire-duel/postMatchTimeline.ts` assembles both. Only this
// adapter knows that Sudoku progress is "correct entries", and that a wrong
// placement is the mistake the game itself recorded.
//
// AUTHORISATION reuses the Sudoku match route exactly: `requirePracticePlayer`
// resolves the account (or signed guest), `fetchMatch` refuses a non-participant
// with 403. The identity never comes from the URL.
//
// WHAT IS EXPOSED, AND WHEN
//   * Only a TERMINAL match.
//   * The SOLUTION is never returned. The preview carries the public clue grid
//     plus the viewer's own moves tagged with `correct` (which the Mistake
//     Finder already reveals as a wasted move), so the board can be drawn
//     without handing over the answer.
//   * PRO comes from `getMembershipTier` — server-authoritative, never client.

import { NextResponse } from "next/server";

import { requirePracticePlayer } from "../../../../../../lib/auth/guestSession";
import { logError } from "../../../../../../lib/logError";
import { getMembershipTier } from "../../../../../../lib/stripe/subscriptions";
import {
  CELL_COUNT,
  TERMINAL_STATUSES,
} from "../../../../../../lib/sudoku-duel/constants";
import {
  fetchMatch,
  fetchSeatMoves,
  isMatchId,
} from "../../../../../../lib/sudoku-duel/serverStore";
import type { Seat } from "../../../../../../lib/sudoku-duel/types";
import {
  buildMatchTimeline,
  type TimelineRatingInput,
  type TimelineSeatInput,
  type TimelineSeatMove,
} from "../../../../../../lib/solitaire-duel/postMatchTimeline";

export const dynamic = "force-dynamic";

type StoredAction = { kind?: string; index?: number; value?: number };

function rowLabel(action: StoredAction): string {
  const index = Number(action?.index);
  if (!Number.isInteger(index) || index < 0) return "Action";
  const cell = `R${Math.floor(index / 9) + 1}C${(index % 9) + 1}`;
  if (action?.kind === "clear") return `Clear ${cell}`;
  return `${cell} = ${Number(action?.value)}`;
}

/**
 * Replay one seat's judged actions into the two series the timeline needs:
 * verified progress (correct entries held) and the plies the game itself judged
 * wasteful.
 *
 * A wrong placement is stored in the log but never written to the board, and a
 * clear only ever removes a CORRECT entry — so `held` mirrors the server state
 * exactly without reading `p*_state`.
 */
function replaySeat(rows: readonly { action: unknown }[], solution: readonly number[]) {
  const held = new Map<number, number>();
  const progress: number[] = [];
  const ratings: TimelineRatingInput[] = [];
  const moves: TimelineSeatMove[] = [];

  rows.forEach((row, i) => {
    const action = (row.action ?? {}) as StoredAction;
    const index = Number(action.index);
    let wasted = false;

    if (action.kind === "place" && Number.isInteger(index)) {
      const value = Number(action.value);
      if (solution[index] === value) held.set(index, value);
      else wasted = true;
    } else if (action.kind === "clear" && Number.isInteger(index)) {
      if (held.delete(index)) wasted = true;
    }

    progress.push(held.size);
    if (wasted) ratings.push({ ply: i, rating: "normal", wasted: true });
    moves.push({
      ply: i,
      kind: String(action.kind ?? "place"),
      move: action,
      atMs: 0,
      label: rowLabel(action),
    });
  });

  return { progress, ratings, moves };
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

    if (!TERMINAL_STATUSES.includes(String(match.status))) {
      return NextResponse.json(
        {
          success: false,
          error: "The match has not finished yet",
          code: "TIMELINE_NOT_READY",
        },
        { status: 409 },
      );
    }

    const seat: "player1" | "player2" = dto.seat;
    const opposingSeat: "player1" | "player2" = seat === "player1" ? "player2" : "player1";
    const startedAtMs = match.startedAt ? new Date(match.startedAt).getTime() : null;
    const endedAtMs = match.endedAt ? new Date(match.endedAt).getTime() : null;

    const givens = Number(match.givens) || 0;
    const progressMax = Math.max(1, CELL_COUNT - givens);

    const yourPly = Number(seat === "player1" ? match.p1Ply : match.p2Ply) || 0;
    const opponentPly = Number(
      opposingSeat === "player1" ? match.p1Ply : match.p2Ply,
    ) || 0;
    const yourCorrect = Number(seat === "player1" ? match.p1Correct : match.p2Correct) || 0;
    const opponentCorrect =
      Number(opposingSeat === "player1" ? match.p1Correct : match.p2Correct) || 0;
    const yourFinishedAt = seat === "player1" ? match.p1FinishedAt : match.p2FinishedAt;
    const opponentFinishedAt =
      opposingSeat === "player1" ? match.p1FinishedAt : match.p2FinishedAt;

    const basic = {
      durationMs:
        startedAtMs !== null && endedAtMs !== null
          ? Math.max(0, endedAtMs - startedAtMs)
          : null,
      yourSeat: seat,
      moves: { you: yourPly, opponent: opponentPly },
      peakProgress: { you: yourCorrect, opponent: opponentCorrect },
      finishedAtMs: {
        you:
          startedAtMs !== null && yourFinishedAt
            ? Math.max(0, new Date(yourFinishedAt).getTime() - startedAtMs)
            : null,
        opponent:
          startedAtMs !== null && opponentFinishedAt
            ? Math.max(0, new Date(opponentFinishedAt).getTime() - startedAtMs)
            : null,
      },
    };

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
          gameKey: "sudoku-duel",
          progressLabel: "cells solved",
          progressMax,
          reviewHref: null,
          basic,
        },
      });
    }

    const [youRows, opponentRows] = await Promise.all([
      fetchSeatMoves(String(match.id), seat as Seat),
      fetchSeatMoves(String(match.id), opposingSeat as Seat),
    ]);

    if (youRows.length !== yourPly) {
      return NextResponse.json(
        {
          success: false,
          error: "The stored action history is inconsistent",
          code: "TIMELINE_HISTORY_INCONSISTENT",
        },
        { status: 409 },
      );
    }

    const solution = (match.solution as number[]) ?? [];
    const yours = replaySeat(youRows, solution);
    const theirs = replaySeat(opponentRows, solution);

    // Timestamps live on the row, not in the replayed move objects.
    const withTime = (
      moves: TimelineSeatMove[],
      rows: readonly { createdAt: Date }[],
    ): TimelineSeatMove[] =>
      moves.map((move, i) => ({
        ...move,
        atMs:
          rows[i]?.createdAt instanceof Date
            ? rows[i].createdAt.getTime()
            : new Date(rows[i]?.createdAt ?? 0).getTime(),
      }));

    const seats: TimelineSeatInput[] = [
      {
        seat,
        label: "You",
        moves: withTime(yours.moves, youRows),
        progress: yours.progress,
        completed: Boolean(yourFinishedAt),
        forfeited: match.resolutionReason === "forfeit" && match.result !== seat,
      },
      {
        seat: opposingSeat,
        label: "Opponent",
        moves: withTime(theirs.moves, opponentRows),
        progress: theirs.progress,
        completed: Boolean(opponentFinishedAt),
        forfeited:
          match.resolutionReason === "forfeit" && match.result !== opposingSeat,
      },
    ];

    const timeline = buildMatchTimeline({
      startedAtMs,
      endedAtMs,
      seats,
      ratings: { seat, perMove: yours.ratings },
      progressMax,
    });

    return NextResponse.json({
      success: true,
      data: {
        pro: true,
        locked: false,
        gameKey: "sudoku-duel",
        progressLabel: "cells solved",
        progressMax,
        reviewHref: null,
        basic,
        timeline,
        // Board preview: the PUBLIC clue grid plus the viewer's own actions,
        // each tagged with the correctness the game already judged. The
        // solution itself never leaves the server.
        preview: {
          game: "sudoku",
          puzzle: match.puzzle,
          moves: youRows.map((row, i) => {
            const action = (row.action ?? {}) as StoredAction;
            const index = Number(action.index);
            return {
              ply: i,
              kind: String(action.kind ?? "place"),
              index,
              value: Number.isFinite(Number(action.value))
                ? Number(action.value)
                : null,
              correct: solution[index] === Number(action.value),
            };
          }),
        },
      },
    });
  } catch (error) {
    await logError({
      errorType: "sudoku_duel_timeline_error",
      errorMessage:
        error instanceof Error ? error.message : "Sudoku Duel timeline failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/sudoku-duel/match/[matchId]/timeline",
      game: "Sudoku Duel",
      metadata: { operation: "timeline" },
    });
    return NextResponse.json({ success: false, error: "Server error" }, { status: 500 });
  }
}
