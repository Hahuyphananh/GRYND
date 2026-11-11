// src/app/api/solitaire/solo/route.ts
//
// SOLO SOLITAIRE records — deliberately separate from ranked PvP.
//
// GET  — the caller's solo summary (games, completions, best/average time).
// POST — record one finished solo attempt after the server replays it.
//
// The server re-derives the deal from the submitted seed with the SAME
// `dealFromSeed` the client used and replays every move. `completed` is read
// from the replayed board, never from the body, so a client cannot claim a win.
//
// GAME REVIEW HISTORY: a COMPLETED attempt also stores the canonical log, so the
// game can be reviewed after the browser session is gone. An incomplete attempt
// still records its summary (existing statistics are unchanged) but stores no
// move log, so an abandoned game can never be presented as a complete review.
//
// IDEMPOTENCY: a completed submission is keyed by (user, seed, digest of the
// ordered canonical log). Retrying the same request conflicts and writes
// nothing; the route never updates a row, so a different log can never be
// attached to an existing result.
//
// Nothing here touches Elo, trophies, the ranked queue or `solitaire_duel_*`
// rows: solo rows live in `solitaire_solo_results`, which no ranked query reads.
//
// Signed-out play remains fully supported in the browser and its records stay in
// localStorage (now including the completed game itself); this endpoint is only
// the authenticated persistence path.

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { desc, eq } from "drizzle-orm";

import { db } from "../../../../db/client";
import { solitaireSoloResults } from "../../../../db/schema";
import { logError } from "../../../../lib/logError";
import { summariseSolo } from "../../../../lib/solitaire-duel/soloStats.js";
import { dealFromSeed } from "../../../../lib/solitaire-duel/deck";
import { replayMoves } from "../../../../lib/solitaire-duel/rules";
import {
  canonicalMoveLog,
  moveLogDigest,
} from "../../../../lib/solitaire-duel/soloPersistence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_MOVES = 4000;
const MAX_ELAPSED_MS = 6 * 60 * 60 * 1000;
const MAX_UINT32 = 0xffff_ffff;

type SubmittedMove = { kind?: unknown; move?: unknown };

function readSeed(value: unknown): number | null {
  const seed = Number(value);
  if (!Number.isInteger(seed) || seed < 0 || seed > MAX_UINT32) return null;
  return seed;
}

function readMoves(value: unknown): SubmittedMove[] | null {
  if (!Array.isArray(value) || value.length > MAX_MOVES) return null;
  return value as SubmittedMove[];
}

function clampElapsed(value: unknown): number {
  const ms = Math.round(Number(value));
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.min(ms, MAX_ELAPSED_MS);
}

async function summaryFor(userId: string) {
  const rows = await db
    .select({
      completed: solitaireSoloResults.completed,
      moves: solitaireSoloResults.moves,
      elapsedMs: solitaireSoloResults.elapsedMs,
    })
    .from(solitaireSoloResults)
    .where(eq(solitaireSoloResults.userId, userId))
    .orderBy(desc(solitaireSoloResults.createdAt))
    .limit(500);
  return summariseSolo(rows);
}

export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json(
      { success: false, error: "Unauthenticated", code: "SIGN_IN_REQUIRED" },
      { status: 401 },
    );
  }
  try {
    return NextResponse.json({ success: true, data: { summary: await summaryFor(userId) } });
  } catch (error) {
    await logError({
      errorType: "solitaire_solo_get_error",
      errorMessage: error instanceof Error ? error.message : "Solo summary failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/solitaire/solo",
      game: "Solitaire Solo",
      metadata: { operation: "get" },
    });
    return NextResponse.json({ success: false, error: "Server error" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json(
      { success: false, error: "Unauthenticated", code: "SIGN_IN_REQUIRED" },
      { status: 401 },
    );
  }

  const body = (await req.json().catch(() => null)) as
    | { seed?: unknown; moves?: unknown; elapsedMs?: unknown }
    | null;
  const seed = readSeed(body?.seed);
  const moves = readMoves(body?.moves);
  if (seed === null || !moves) {
    return NextResponse.json({ success: false, error: "Invalid solo result" }, { status: 400 });
  }

  try {
    const deal = dealFromSeed(seed);
    const replayed = replayMoves({ deal, moves: moves as { kind: string; move: unknown }[] });
    if (!replayed.ok) {
      return NextResponse.json(
        { success: false, error: "The submitted moves are not legal for that deal" },
        { status: 422 },
      );
    }

    // The replay proved every move legal, so this pass only rebuilds the log in
    // the engine's canonical shape. If it ever disagrees, persist nothing.
    const canonical = canonicalMoveLog(moves);
    if (!canonical.ok) {
      return NextResponse.json(
        { success: false, error: "The submitted moves are not legal for that deal" },
        { status: 422 },
      );
    }

    // A win is the engine's fact, never the client's. Only a completed board
    // earns a stored log; an abandoned attempt keeps its summary row and stops.
    const completed = replayed.state.completed === true;
    const moveLog = completed ? canonical.log : null;
    const logDigest = moveLog ? moveLogDigest(moveLog) : null;
    const elapsedMs = clampElapsed(body?.elapsedMs);

    const inserted = await db
      .insert(solitaireSoloResults)
      .values({
        userId,
        seed: String(seed),
        completed,
        moves: moves.length,
        elapsedMs,
        moveLog,
        logDigest,
      })
      .onConflictDoNothing({
        target: [
          solitaireSoloResults.userId,
          solitaireSoloResults.seed,
          solitaireSoloResults.logDigest,
        ],
      })
      .returning({ id: solitaireSoloResults.id });

    const duplicate = inserted.length === 0;

    return NextResponse.json({
      success: true,
      data: {
        completed,
        moves: moves.length,
        recorded: !duplicate,
        duplicate,
        // The recorded game's id, so the result popup can link straight to its
        // analysis. A duplicate submission wrote nothing and returns no id.
        id: inserted[0]?.id ?? null,
        // A stored log is the only thing a review can be built from.
        reviewable: Boolean(moveLog),
        summary: await summaryFor(userId),
      },
    });
  } catch (error) {
    await logError({
      errorType: "solitaire_solo_post_error",
      errorMessage: error instanceof Error ? error.message : "Solo record failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/solitaire/solo",
      game: "Solitaire Solo",
      metadata: { operation: "post" },
    });
    return NextResponse.json({ success: false, error: "Server error" }, { status: 500 });
  }
}
