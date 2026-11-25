// src/app/api/solitaire/review/route.ts
//
// READ BACK ONE COMPLETED SOLO / DAILY GAME.
//
// The single read path for both single-player modes. It returns the exact deal
// and the canonical validated log, in the same top-level shape the duel review
// uses (`gameId`, `gameKind`, `status`, `deal`, `moves`, `result`, timing,
// `analysisEligible`, and the cached analysis). The analysis is owned by
// src/lib/solitaire-duel/analysisCache.ts: this route only supplies the game's
// canonical log digest, and a cache hit never recomputes it.
//
// IDENTITY: a Clerk session, or the signed `grynd_guest` cookie for a guest's
// own practice rows. The identity is never read from the URL or body. Queries
// filter by BOTH the row id and that identity, so another player's id is a 404
// and cannot be probed.
//
// REVIEWABLE ONLY: a row is returned only when `completed` is true, the stored
// log is a non-empty canonical array, its length matches the recorded move
// count, and replaying it solves the derived deal. Abandoned attempts, legacy
// rows that predate the log, and corrupt rows are 404 — never an empty review.

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { and, eq } from "drizzle-orm";

import { db } from "../../../../db/client";
import { solitaireDailyResults, solitaireSoloResults } from "../../../../db/schema";
import { readGuestId } from "../../../../lib/auth/guestSession";
import { logError } from "../../../../lib/logError";
import { loadReviewAnalysis } from "../../../../lib/solitaire-duel/reviewAnalysis";
import { dealFromSeed } from "../../../../lib/solitaire-duel/deck";
import { dailyDealFor } from "../../../../lib/solitaire-duel/daily";
import { replayMoves } from "../../../../lib/solitaire-duel/rules";
import { durationMsBetween, toIso } from "../../../../lib/solitaire-duel/review";
import { canonicalMoveLog, moveLogDigest } from "../../../../lib/solitaire-duel/soloPersistence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function notFound() {
  return NextResponse.json(
    { success: false, error: "No reviewable game for that id" },
    { status: 404 },
  );
}

/**
 * The caller's own identity: Clerk first, else an EXISTING signed guest cookie.
 * Never creates a guest here (a read must not mint an identity), and a cookie
 * read failure outside a request scope is simply "not signed in".
 */
async function resolveReviewPlayer(): Promise<{
  playerId: string;
  isGuest: boolean;
} | null> {
  const { userId } = await auth();
  if (userId) return { playerId: userId, isGuest: false };
  try {
    const guestId = await readGuestId();
    if (guestId) return { playerId: guestId, isGuest: true };
  } catch {
    // No request scope / unreadable cookie: treat as signed out.
  }
  return null;
}

export async function GET(req: Request) {
  const player = await resolveReviewPlayer();
  if (!player) {
    return NextResponse.json(
      { success: false, error: "Unauthenticated", code: "SIGN_IN_REQUIRED" },
      { status: 401 },
    );
  }

  const url = new URL(req.url);
  const mode = url.searchParams.get("mode");
  const id = url.searchParams.get("id");
  if ((mode !== "solo" && mode !== "daily") || !id || !UUID.test(id)) {
    return NextResponse.json(
      { success: false, error: "mode must be solo|daily and id must be a uuid" },
      { status: 400 },
    );
  }

  try {
    if (mode === "solo") {
      const rows = await db
        .select({
          seed: solitaireSoloResults.seed,
          completed: solitaireSoloResults.completed,
          moves: solitaireSoloResults.moves,
          moveLog: solitaireSoloResults.moveLog,
          elapsedMs: solitaireSoloResults.elapsedMs,
          createdAt: solitaireSoloResults.createdAt,
        })
        .from(solitaireSoloResults)
        .where(
          and(
            eq(solitaireSoloResults.id, id),
            eq(solitaireSoloResults.userId, player.playerId),
          ),
        )
        .limit(1);
      const row = rows[0];
      if (!row?.completed || !Array.isArray(row.moveLog) || row.moveLog.length === 0) {
        return notFound();
      }

      const canonical = canonicalMoveLog(row.moveLog);
      const seed = Number(row.seed);
      if (!canonical.ok || !Number.isInteger(seed) || seed < 0) return notFound();
      if (row.moves > 0 && canonical.log.length !== row.moves) return notFound();

      const soloDeal = dealFromSeed(seed);
      const replayed = replayMoves({ deal: soloDeal, moves: canonical.log });
      if (!replayed.ok || !replayed.state.completed) return notFound();

      // Cache identity = game + SHA-256 of THIS canonical log + engine version.
      // The route never trusts a client digest and never writes the log twice.
      // The analysis is costed by the caller's daily allowance: a cached
      // re-view is free, a fresh one is taken from the free plan's 3/day (PRO
      // is unlimited). The deal and the log are always returned; only the
      // scored analysis is withheld when the allowance is spent.
      const { analysis, limited, allowance } = await loadReviewAnalysis({
        gameKind: "solo",
        gameId: id,
        logDigest: moveLogDigest(canonical.log),
        deal: soloDeal,
        moves: canonical.log,
        playerId: player.playerId,
        isGuest: player.isGuest,
      });

      const completedAt = toIso(row.createdAt);
      const elapsedMs = row.elapsedMs > 0 ? row.elapsedMs : null;
      const startedAt =
        completedAt && elapsedMs
          ? toIso(new Date(new Date(completedAt).getTime() - elapsedMs))
          : null;

      return NextResponse.json({
        success: true,
        data: {
          gameId: id,
          gameKind: "solo",
          mode,
          variant: soloDeal.variant,
          variantVersion: soloDeal.variantVersion,
          status: "complete",
          deal: soloDeal,
          moves: canonical.log,
          seed,
          result: {
            completed: true,
            moveCount: canonical.log.length,
            elapsedMs,
            seed,
          },
          startedAt,
          completedAt,
          durationMs:
            elapsedMs ?? durationMsBetween(startedAt, completedAt),
          analysisEligible: true,
          analysis,
          analysisLimited: limited,
          analysisAllowance: allowance,
          incompleteReason: null,
        },
      });
    }

    const rows = await db
      .select({
        challengeDate: solitaireDailyResults.challengeDate,
        completed: solitaireDailyResults.completed,
        moves: solitaireDailyResults.moves,
        moveLog: solitaireDailyResults.moveLog,
        elapsedMs: solitaireDailyResults.elapsedMs,
        createdAt: solitaireDailyResults.createdAt,
      })
      .from(solitaireDailyResults)
      .where(
        and(
          eq(solitaireDailyResults.id, id),
          eq(solitaireDailyResults.userId, player.playerId),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row?.completed || !Array.isArray(row.moveLog) || row.moveLog.length === 0) {
      return notFound();
    }

    const canonical = canonicalMoveLog(row.moveLog);
    if (!canonical.ok) return notFound();
    if (row.moves > 0 && canonical.log.length !== row.moves) return notFound();

    const dailyDeal = dailyDealFor(row.challengeDate);
    const replayed = replayMoves({ deal: dailyDeal, moves: canonical.log });
    if (!replayed.ok || !replayed.state.completed) return notFound();

    const { analysis, limited, allowance } = await loadReviewAnalysis({
      gameKind: "daily",
      gameId: id,
      logDigest: moveLogDigest(canonical.log),
      deal: dailyDeal,
      moves: canonical.log,
      playerId: player.playerId,
      isGuest: player.isGuest,
    });

    const completedAt = toIso(row.createdAt);
    const elapsedMs = row.elapsedMs > 0 ? row.elapsedMs : null;
    const startedAt =
      completedAt && elapsedMs
        ? toIso(new Date(new Date(completedAt).getTime() - elapsedMs))
        : null;

    return NextResponse.json({
      success: true,
      data: {
        gameId: id,
        gameKind: "daily",
        mode,
        variant: dailyDeal.variant,
        variantVersion: dailyDeal.variantVersion,
        status: "complete",
        deal: dailyDeal,
        moves: canonical.log,
        dateKey: row.challengeDate,
        result: {
          completed: true,
          moveCount: canonical.log.length,
          elapsedMs,
          dateKey: row.challengeDate,
        },
        startedAt,
        completedAt,
        durationMs: elapsedMs ?? durationMsBetween(startedAt, completedAt),
        analysisEligible: true,
        analysis,
        analysisLimited: limited,
        analysisAllowance: allowance,
        incompleteReason: null,
      },
    });
  } catch (error) {
    await logError({
      errorType: "solitaire_review_get_error",
      errorMessage: error instanceof Error ? error.message : "Review fetch failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/solitaire/review",
      game: mode === "daily" ? "Solitaire Daily" : "Solitaire Solo",
      metadata: { mode, operation: "get" },
    });
    return NextResponse.json({ success: false, error: "Server error" }, { status: 500 });
  }
}
