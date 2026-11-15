// src/app/api/solitaire/puzzle/route.ts
//
// THE SOLITAIRE PUZZLE (daily + unlimited).
//
// GET  ?kind=daily      — today's UTC puzzle, the caller's attempt (if any) and
//                         the unlimited allowance.
//      ?kind=unlimited  — a fresh practice puzzle plus the allowance.
// POST                  — answer ONE puzzle. The server rebuilds the exact
//                         puzzle from its own key+seed, so the client never
//                         supplies the position or the answer.
//
// RULES
//   * The daily puzzle is FREE for everyone (guests included) and can be
//     answered exactly ONCE per identity per UTC day: the unique
//     (user_id, puzzle_key) index is the backstop, and the route checks it
//     before accepting an answer.
//   * The unlimited puzzle is free for 5 attempts per UTC day and unlimited for
//     GRYND PRO. A submission consumes one slot — the slot is taken BEFORE the
//     answer is checked, so a wrong answer still spends it and retrying cannot
//     farm the day.
//   * The answer is never in a GET response before the puzzle is answered.
//
// IDENTITY: a Clerk session, or the signed `grynd_guest` cookie (minted on the
// first puzzle request). The identity is never read from the URL or the body.

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { and, eq } from "drizzle-orm";

import { db } from "../../../../db/client";
import { solitairePuzzleAttempts } from "../../../../db/schema";
import { resolveGuestId } from "../../../../lib/auth/guestSession";
import { logError } from "../../../../lib/logError";
import { getMembershipTier } from "../../../../lib/stripe/subscriptions";
import {
  dailyPuzzleDateKey,
  getDailyPuzzle,
  getUnlimitedPuzzle,
  publicPuzzle,
  puzzleForKey,
  verifyPuzzleChoice,
  type PuzzleChoiceLabel,
  type PuzzleKind,
} from "../../../../lib/solitaire-duel/puzzle";
import {
  consumePuzzleAllowance,
  readPuzzleAllowance,
  type PuzzleAllowance,
} from "../../../../lib/solitaire-duel/puzzleAllowance";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_ELAPSED_MS = 5 * 60 * 1000;

type Player = { playerId: string; isPro: boolean; signedIn: boolean };

function readKind(value: unknown): PuzzleKind {
  return value === "unlimited" ? "unlimited" : "daily";
}

function readChoice(value: unknown): PuzzleChoiceLabel | null {
  return value === "A" || value === "B" || value === "C" ? value : null;
}

function clampElapsed(value: unknown): number {
  const ms = Math.round(Number(value));
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.min(ms, MAX_ELAPSED_MS);
}

/**
 * The caller's identity. A signed-in player is a Clerk user; a guest is the
 * signed cookie identity, minted on first use so the free daily puzzle does not
 * require an account.
 */
async function playerFor(create: boolean): Promise<Player | null> {
  const { userId } = await auth();
  if (userId) {
    let isPro = false;
    try {
      isPro = (await getMembershipTier(userId)) === "pro";
    } catch {
      // Unreadable subscription state grants nothing, exactly like every other
      // PRO check — the player is treated as free.
      isPro = false;
    }
    return { playerId: userId, isPro, signedIn: true };
  }

  try {
    const guestId = await resolveGuestId({ create });
    if (guestId) return { playerId: guestId, isPro: false, signedIn: false };
  } catch {
    // No request scope / unreadable cookie: the caller cannot be identified.
  }
  return null;
}

async function findAttempt(playerId: string, puzzleKey: string) {
  try {
    const rows = await db
      .select({
        choice: solitairePuzzleAttempts.choice,
        correct: solitairePuzzleAttempts.correct,
        createdAt: solitairePuzzleAttempts.createdAt,
      })
      .from(solitairePuzzleAttempts)
      .where(
        and(
          eq(solitairePuzzleAttempts.userId, playerId),
          eq(solitairePuzzleAttempts.puzzleKey, puzzleKey),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const kind = readKind(url.searchParams.get("kind"));
  const player = await playerFor(true);
  const now = new Date();

  let allowance: PuzzleAllowance | null = null;
  if (player) {
    allowance = await readPuzzleAllowance({
      playerId: player.playerId,
      isPro: player.isPro,
      now,
    });
  }

  try {
    if (kind === "daily") {
      const dateKey = dailyPuzzleDateKey(now);
      const puzzle = getDailyPuzzle(dateKey);
      const attempt = player ? await findAttempt(player.playerId, puzzle.key) : null;
      return NextResponse.json({
        success: true,
        data: {
          ...publicPuzzle(puzzle),
          // Only a player who has already answered sees the answer.
          answer: attempt ? puzzle.answer : null,
          attempt: attempt
            ? {
                choice: attempt.choice,
                correct: attempt.correct,
                answeredAt: attempt.createdAt?.toISOString?.() ?? null,
              }
            : null,
          allowance,
        },
      });
    }

    const requestedSeed = url.searchParams.get("seed");
    const seed = requestedSeed === null ? undefined : Number(requestedSeed);
    const puzzle = getUnlimitedPuzzle(seed);
    return NextResponse.json({
      success: true,
      data: {
        ...publicPuzzle(puzzle),
        answer: null,
        attempt: null,
        allowance,
      },
    });
  } catch (error) {
    await logError({
      errorType: "solitaire_puzzle_get_error",
      errorMessage: error instanceof Error ? error.message : "Puzzle generation failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/solitaire/puzzle",
      game: "Solitaire Puzzle",
      metadata: { operation: "get", kind },
    });
    return NextResponse.json(
      { success: false, error: "Today's puzzle could not be built. Please try again shortly." },
      { status: 503 },
    );
  }
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as
    | { kind?: unknown; key?: unknown; choice?: unknown; elapsedMs?: unknown }
    | null;

  const kind = readKind(body?.kind);
  const key = typeof body?.key === "string" ? body.key : "";
  const choice = readChoice(body?.choice);
  if (!key || !choice) {
    return NextResponse.json(
      { success: false, error: "A puzzle key and choice A, B or C are required" },
      { status: 400 },
    );
  }

  const player = await playerFor(true);
  if (!player) {
    return NextResponse.json(
      { success: false, error: "Sign in to answer a puzzle" },
      { status: 401 },
    );
  }

  const now = new Date();
  const puzzle = puzzleForKey({ key, kind, dateKey: dailyPuzzleDateKey(now) });
  if (!puzzle) {
    return NextResponse.json(
      { success: false, error: "That puzzle is not available" },
      { status: 400 },
    );
  }

  try {
    if (kind === "daily") {
      // ONE answer per identity per day, right or wrong.
      const existing = await findAttempt(player.playerId, puzzle.key);
      if (existing) {
        return NextResponse.json({
          success: true,
          data: {
            alreadyPlayed: true,
            correct: existing.correct,
            answer: puzzle.answer,
            choice: existing.choice,
            allowance: await readPuzzleAllowance({
              playerId: player.playerId,
              isPro: player.isPro,
              now,
            }),
          },
        });
      }
    }

    let allowance = await readPuzzleAllowance({
      playerId: player.playerId,
      isPro: player.isPro,
      now,
    });

    // The unlimited puzzle is the paid/free-limited mode; the daily puzzle is
    // free and never touches the quota.
    if (kind === "unlimited") {
      const consumed = await consumePuzzleAllowance({
        playerId: player.playerId,
        isPro: player.isPro,
        now,
      });
      allowance = consumed.allowance;
      if (!consumed.allowed) {
        return NextResponse.json(
          {
            success: false,
            error: "You have used all 5 free puzzles today. GRYND PRO is unlimited.",
            code: "PUZZLE_LIMIT_REACHED",
            data: { allowance },
          },
          { status: 429 },
        );
      }
    }

    const correct = verifyPuzzleChoice(puzzle, choice);
    const inserted = await db
      .insert(solitairePuzzleAttempts)
      .values({
        userId: player.playerId,
        kind,
        puzzleKey: puzzle.key,
        choice,
        correct,
        elapsedMs: clampElapsed(body?.elapsedMs),
      })
      .onConflictDoNothing({
        target: [solitairePuzzleAttempts.userId, solitairePuzzleAttempts.puzzleKey],
      })
      .returning({ id: solitairePuzzleAttempts.id });

    // The unique index lost a race (a double click / retry). The first recorded
    // answer stands; this submission changed nothing.
    const duplicate = inserted.length === 0;

    return NextResponse.json({
      success: true,
      data: {
        correct,
        answer: puzzle.answer,
        choice,
        duplicate,
        alreadyPlayed: duplicate,
        allowance,
      },
    });
  } catch (error) {
    await logError({
      errorType: "solitaire_puzzle_post_error",
      errorMessage: error instanceof Error ? error.message : "Puzzle submission failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/solitaire/puzzle",
      game: "Solitaire Puzzle",
      metadata: { operation: "post", kind },
    });
    return NextResponse.json({ success: false, error: "Server error" }, { status: 500 });
  }
}
