// src/app/api/evaluation/[gameKey]/[matchId]/route.ts
//
// POST — evaluate one finished match for the authenticated caller.
//
// The shared Game Evaluation endpoint. It is deliberately vendor-shaped:
// the objective stats come from that game's evaluator (chess today) and the
// written analysis from the configured LLM provider, so adding a game means
// adding an evaluator, not another route.
//
// This handler does ONLY the framework work — the age/age-verified gate, the
// route params, and mapping the service's result onto a response. Every
// decision (ownership, finished state, Free/Pro daily limit, idempotent
// caching, the provider fallback) lives in
// src/lib/evaluation/evaluationService.ts, where it is unit-tested with fakes
// rather than through an HTTP harness.
//
// NOTHING THE CLIENT SENDS CAN CHANGE WHAT THE CALLER IS ENTITLED TO:
//   - the tier comes from the Stripe subscription row server-side,
//   - the daily count is a DB COUNT for the caller's own Clerk id,
//   - the caller identity comes from the Clerk session, never the body.
// There is no request body at all, so there is nothing to spoof: clearing
// cookies, local storage or reinstalling the app changes none of it.
//
// runtime/limits: the objective half runs a real Stockfish search per position
// (~100-250 ms each, ~8-20 s for a full game), so this must stay on the Node
// runtime (Node/edge both support the WASM, but the engine + pg pool are
// Node-only) and needs headroom beyond the default function timeout.

import { NextResponse } from "next/server";

import { requireAgeVerifiedUser } from "../../../../../lib/auth/requireAgeVerified";
import { logError } from "../../../../../lib/logError";
import { runEvaluation } from "../../../../../lib/evaluation/evaluationService";

export const runtime = "nodejs";
/** Engine analysis + one LLM call; the default 10s would cut off long games. */
export const maxDuration = 60;

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ gameKey: string; matchId: string }> },
) {
  // The page middleware does not cover /api/*, so the route gates itself.
  const gate = await requireAgeVerifiedUser();
  if (gate.response) return gate.response;
  const userId = gate.userId;
  if (!userId) {
    return NextResponse.json(
      { success: false, error: "Unauthenticated" },
      { status: 401 },
    );
  }

  const resolved =
    (await params) || ({} as { gameKey?: string; matchId?: string });
  const gameKey = String(resolved.gameKey ?? "").trim();
  const matchId = String(resolved.matchId ?? "").trim();

  try {
    const result = await runEvaluation({ userId, gameKey, matchId });

    // Every failure the service can produce is a deliberate, user-facing
    // answer (501 not supported, 403 not yours, 429 limit, 422 too short, ...)
    // so it is returned verbatim rather than flattened into a 500.
    if (result.ok) {
      return NextResponse.json(
        {
          success: true,
          // Set only for the degraded case: the objective stats are here, the
          // written analysis is not.
          message: result.message,
          data: {
            evaluationId: result.evaluationId,
            gameKey: result.gameKey,
            matchId: result.matchId,
            tier: result.tier,
            cached: result.cached,
            aiAvailable: result.aiAvailable,
            objective: result.objective,
            insight: result.insight,
            limits: result.limits,
          },
        },
        { status: result.status },
      );
    }

    return NextResponse.json(
      {
        success: false,
        error: result.message,
        code: result.code,
        tier: result.tier,
        gameKey: result.gameKey,
        matchId: result.matchId,
        limits: result.limits,
        // Present on 422 so the client can explain WHY the match can't be
        // evaluated without a second request.
        objective: result.objective,
      },
      { status: result.status },
    );
  } catch (error) {
    await logError({
      errorType: "game_evaluation_error",
      errorMessage:
        error instanceof Error ? error.message : "Game evaluation failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/evaluation/[gameKey]/[matchId]",
      game: gameKey,
      metadata: { operation: "evaluate_match", gameKey, matchId },
    });
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
