// src/app/api/chess/engine-health/route.ts
//
// DIAGNOSTIC: can the chess engine boot and answer on THIS host?
//
// WHY THIS EXISTS
// ---------------
// The VS-AI bot plays through the single-threaded Stockfish 16 WASM build that
// ships inside `node_modules/stockfish`. When that module cannot load (a missing
// .wasm in the release artifact, a broken boot, a hung search), every AI turn
// used to answer 503 — and from outside, "the engine is not there", "the engine
// is there but broken" and "the process is out of memory" all looked identical.
//
// This endpoint answers that question directly, on the box that is serving:
//
//   GET /api/chess/engine-health
//   200 { ok: true,  engine: "Stockfish 16 …", bestMove: "e2e4", ms: 214, assets }
//   503 { ok: false, error: "…", assets }
//
// It performs ONE small real search (`go depth 2 movetime 150`) so a green answer
// is proof the engine RUNS and plays, not merely that two files exist. Search is
// serialised through the engine's own mutex, so a probe cannot corrupt a game's
// move, and it shares the warm instance — repeated calls cost one small search.
//
// `assets` names every directory the loader looked in and which of them carries
// both files, which is the one fact you cannot get from a 503 on the board.
//
// PUBLIC, DELIBERATELY: it exposes no game data, no user data and no secret —
// only the engine's own identity string and file paths inside the release.
// Rate-limit-worthiness is low (a single 150 ms search); it is a diagnostic, not
// a game endpoint.

import { NextResponse } from "next/server";

import {
  analyzePosition,
  describeStockfishAssets,
  getEngineIdentity,
} from "../../../../lib/evaluation/engine/stockfishEngine";

/** The position every probe searches: the initial one, always legal. */
const PROBE_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

/** Small enough to be cheap, long enough that a hung engine still times out. */
const PROBE_DEPTH = 2;
const PROBE_MOVE_TIME_MS = 150;

// Never cached or statically optimised: the answer is about THIS process, now.
export const dynamic = "force-dynamic";

export async function GET() {
  const assets = describeStockfishAssets();
  const startedAt = Date.now();

  try {
    const result = await analyzePosition(PROBE_FEN, {
      depth: PROBE_DEPTH,
      moveTimeMs: PROBE_MOVE_TIME_MS,
      // The probe states its options like every other caller (see the engine's
      // per-call reset), so it can neither inherit nor leave a setting behind.
      skillLevel: 20,
      multiPv: 1,
    });

    const ok = Boolean(result.bestMoveUci);
    const body = {
      ok,
      engine: getEngineIdentity() || null,
      bestMove: result.bestMoveUci,
      ms: Date.now() - startedAt,
      assets,
      ...(ok ? {} : { error: "the engine answered with no legal best move" }),
    };

    return NextResponse.json(body, { status: ok ? 200 : 503 });
  } catch (error: any) {
    console.warn("[chess-engine-health] probe failed", {
      message: error?.message,
      assets,
    });
    return NextResponse.json(
      {
        ok: false,
        engine: getEngineIdentity() || null,
        error: error?.message || String(error),
        ms: Date.now() - startedAt,
        assets,
      },
      { status: 503 },
    );
  }
}
