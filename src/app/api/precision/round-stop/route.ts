// POST /api/precision/round-stop
//
// Per-player STOP signal for the active round. The client sends:
//   - matchId  : canonical match identifier
//   - userId   : caller's Clerk userId
//   - roundId  : server-stamped round identifier (read from match.roundId
//                after the precision:roundArmStart broadcast)
//   - nonce    : server-rolled cryptographic nonce (read from
//                match.roundNonce at the same time)
// The server stamps the STOP instant at receive time and computes the
// elapsed time authoritatively as
// `stopInstant - match.roundGoInstant`. The server uses that elapsed
// to compute the round winner against the server-stored `match.targetMs`
// once BOTH seats have submitted. This is the "never trust the client"
// and "all timing on the server" model: a malicious client cannot
// fabricate the opponent's stopMs (there is no client-stopMs), cannot
// influence the GO instant (server-stamped), cannot fabricate elapsed,
// and CANNOT submit a stop packet carrying a stale `roundId`/`nonce`
// (the server hard-rejects mismatches \u2014 see recordRoundStop for the
// replay-attack enforcement details). Duplicate stops within the same
// round are also hard-rejected: the bucket is NOT refreshed, so an
// attacker can't iterate their telemetry until they like the diff.
//
// Score / win-condition / phase transitions are server-side. Returns
// 200 with `RecordRoundStopResult`-shaped payload on success; 4xx for
// the various rejection reasons (match not found, wrong phase, caller
// is not a participant, server-measured elapsed out of range, stale
// roundId/nonce, duplicate stop, etc.).

import { NextRequest, NextResponse } from "next/server";
import { recordRoundStop } from "../../../../lib/precision/serverStore";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const matchId = String(body?.matchId ?? "");
    const userId = String(body?.userId ?? "");
    const roundId = String(body?.roundId ?? "");
    const nonce = String(body?.nonce ?? "");

    if (!matchId) {
      return NextResponse.json(
        { success: false, error: "Missing matchId." },
        { status: 400 },
      );
    }
    if (!userId) {
      return NextResponse.json(
        { success: false, error: "Missing userId." },
        { status: 400 },
      );
    }
    if (!roundId) {
      return NextResponse.json(
        { success: false, error: "Missing roundId." },
        { status: 400 },
      );
    }
    if (!nonce) {
      return NextResponse.json(
        { success: false, error: "Missing nonce." },
        { status: 400 },
      );
    }
    // The route no longer accepts `stopMs` from the network. The
    // server stamps the STOP instant inside `recordRoundStop` and
    // computes elapsed authoritatively from `match.roundGoInstant`.
    // Any stopMs in the request body is intentionally ignored \u2014 the
    // client cannot influence the score.

    const result = recordRoundStop(matchId, userId, roundId, nonce);
    if (!result.match) {
      return NextResponse.json(
        { success: false, error: "Match not found." },
        { status: 404 },
      );
    }
    if (result.error) {
      // 400 covers numeric-input validation (roundId/nonce missing OR
      // mismatched, duplicate stop, server-measured elapsed out of
      // range, etc.); 409 covers all other domain-level rejections
      // (wrong phase, non-participant caller). Discriminated by the
      // typed `validationError` flag rather than by string-matching
      // the human-readable error message.
      return NextResponse.json(
        {
          success: false,
          error: result.error,
          validationError: result.validationError,
          bothStopped: result.bothStopped,
          roundWinnerSeat: result.roundWinnerSeat,
          matchFinished: result.matchFinished,
          match: result.match,
        },
        { status: result.validationError ? 400 : 409 },
      );
    }
    return NextResponse.json({
      success: true,
      alreadySubmitted: result.alreadySubmitted,
      bothStopped: result.bothStopped,
      roundWinnerSeat: result.roundWinnerSeat,
      matchFinished: result.matchFinished,
      match: result.match,
    });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: (err as Error)?.message ?? "Unknown error" },
      { status: 500 },
    );
  }
}
