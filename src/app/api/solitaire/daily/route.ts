// src/app/api/solitaire/daily/route.ts
//
// THE DAILY SOLITAIRE CHALLENGE.
//
// GET  — today's UTC date, the deterministic deal, and the caller's daily stats.
// POST — submit a finished attempt; the server REPLAYS the moves against the
//        deal it derives itself, and records at most one official result per
//        player per date.
//
// Protection model (there is no secret to keep — the deal is public):
//
//   1. The client never chooses the deal. `dailyDealFor(today)` is derived from
//      the server clock through SHA-256, so refreshing, opening a new tab or
//      switching account cannot reroll it.
//   2. The client never gets to claim a win. `POST` ignores any `completed`
//      flag in the body and only records after `replayMoves` reaches 52 cards
//      on the foundations.
//   3. The client never gets to record twice. `onConflictDoNothing` on the
//      (user_id, challenge_date) unique index means a replayed submission, a
//      double click or a retried request cannot inflate the count or streak.
//   4. Practice replays never POST at all — the client only submits the first
//      completed run of the day, and a replay of an already-recorded day is
//      returned with `duplicate: true`.
//
// GAME REVIEW HISTORY: the recorded row stores the canonical, server-verified
// log, so the official game can be reconstructed later. The route only ever
// INSERTS: a duplicate submission cannot attach a different log to the existing
// result, because the existing row is never updated.
//
// No Elo, ratings, trophies or queue rows are touched here. Daily results live
// in their own table, so ranked queries cannot see them.

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { and, desc, eq } from "drizzle-orm";

import { db } from "../../../../db/client";
import { solitaireDailyResults } from "../../../../db/schema";
import { logError } from "../../../../lib/logError";
import { dailyDateKey, summariseDaily } from "../../../../lib/solitaire-duel/soloStats.js";
import { dailyDealFor } from "../../../../lib/solitaire-duel/daily";
import { replayMoves } from "../../../../lib/solitaire-duel/rules";
import {
  canonicalMoveLog,
  moveLogDigest,
} from "../../../../lib/solitaire-duel/soloPersistence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_MOVES = 4000;
const MAX_ELAPSED_MS = 6 * 60 * 60 * 1000;

type SubmittedMove = { kind?: unknown; move?: unknown };

function readMoves(value: unknown): SubmittedMove[] | null {
  if (!Array.isArray(value) || value.length > MAX_MOVES) return null;
  return value as SubmittedMove[];
}

function clampElapsed(value: unknown): number {
  const ms = Math.round(Number(value));
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.min(ms, MAX_ELAPSED_MS);
}

async function statsFor(userId: string, dateKey: string) {
  const rows = await db
    .select({
      challengeDate: solitaireDailyResults.challengeDate,
      completed: solitaireDailyResults.completed,
      moves: solitaireDailyResults.moves,
      elapsedMs: solitaireDailyResults.elapsedMs,
    })
    .from(solitaireDailyResults)
    .where(eq(solitaireDailyResults.userId, userId))
    .orderBy(desc(solitaireDailyResults.challengeDate));

  return summariseDaily(rows, dateKey);
}

export async function GET() {
  const dateKey = dailyDateKey();
  const { userId } = await auth();

  try {
    const deal = dailyDealFor(dateKey);
    const summary = userId ? await statsFor(userId, dateKey) : null;
    return NextResponse.json({
      success: true,
      data: {
        dateKey,
        timezone: "UTC",
        deal,
        signedIn: Boolean(userId),
        summary,
      },
    });
  } catch (error) {
    await logError({
      errorType: "solitaire_daily_get_error",
      errorMessage: error instanceof Error ? error.message : "Daily challenge failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/solitaire/daily",
      game: "Solitaire Daily",
      metadata: { operation: "get" },
    });
    return NextResponse.json({ success: false, error: "Server error" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json(
      {
        success: false,
        error: "Sign in to record an official daily result. You can still play the deal.",
        code: "SIGN_IN_REQUIRED",
      },
      { status: 401 },
    );
  }

  const body = (await req.json().catch(() => null)) as
    | { moves?: unknown; elapsedMs?: unknown }
    | null;
  const moves = readMoves(body?.moves);
  if (!moves) {
    return NextResponse.json({ success: false, error: "Invalid move list" }, { status: 400 });
  }

  const dateKey = dailyDateKey();
  try {
    const deal = dailyDealFor(dateKey);
    const replayed = replayMoves({ deal, moves: moves as { kind: string; move: unknown }[] });
    if (!replayed.ok) {
      return NextResponse.json(
        { success: false, error: "The submitted moves are not legal for today's deal" },
        { status: 422 },
      );
    }
    if (!replayed.state.completed) {
      return NextResponse.json(
        { success: false, error: "Today's challenge is not complete yet" },
        { status: 422 },
      );
    }

    // Verified above: every move is legal and the board is solved. Store the
    // normalised log, never the raw body, and only through an INSERT.
    const canonical = canonicalMoveLog(moves);
    if (!canonical.ok) {
      return NextResponse.json(
        { success: false, error: "The submitted moves are not legal for today's deal" },
        { status: 422 },
      );
    }
    const elapsedMs = clampElapsed(body?.elapsedMs);

    const inserted = await db
      .insert(solitaireDailyResults)
      .values({
        userId,
        challengeDate: dateKey,
        completed: true,
        moves: moves.length,
        elapsedMs,
        moveLog: canonical.log,
        logDigest: moveLogDigest(canonical.log),
      })
      .onConflictDoNothing({
        target: [solitaireDailyResults.userId, solitaireDailyResults.challengeDate],
      })
      .returning({ id: solitaireDailyResults.id });

    const duplicate = inserted.length === 0;

    // On a duplicate, report whether the EXISTING row has a stored log. Never
    // read the submitted log into that answer: this submission was ignored.
    let reviewable = true;
    let resultId: string | null = inserted[0]?.id ?? null;
    if (duplicate) {
      const existing = await db
        .select({ id: solitaireDailyResults.id, moveLog: solitaireDailyResults.moveLog })
        .from(solitaireDailyResults)
        .where(
          and(
            eq(solitaireDailyResults.userId, userId),
            eq(solitaireDailyResults.challengeDate, dateKey),
          ),
        )
        .limit(1);
      reviewable = Boolean(existing[0]?.moveLog);
      // The existing row is this player's own recorded game, so its id is the
      // right analysis entry point (a legacy row without a log gets none).
      resultId = reviewable ? existing[0]?.id ?? null : null;
    }

    const summary = await statsFor(userId, dateKey);
    return NextResponse.json({
      success: true,
      data: {
        dateKey,
        recorded: !duplicate,
        duplicate,
        id: resultId,
        reviewable,
        moves: moves.length,
        elapsedMs,
        summary,
      },
    });
  } catch (error) {
    await logError({
      errorType: "solitaire_daily_post_error",
      errorMessage: error instanceof Error ? error.message : "Daily record failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/solitaire/daily",
      game: "Solitaire Daily",
      metadata: { operation: "post" },
    });
    return NextResponse.json({ success: false, error: "Server error" }, { status: 500 });
  }
}
