// POST /api/precision/round-stop
//
// Per-player STOP signal for the active round. The client sends:
//   - matchId  : canonical match identifier
//   - userId   : caller's Clerk userId
//   - roundId  : server-stamped round identifier (read from match.roundId
//                after the precision:roundArmStart broadcast)
//   - nonce    : server-rolled cryptographic nonce (read from
//                match.roundNonce at the same time)
//   - elapsedMs: OPTIONAL, the elapsed the client froze at when the player
//                clicked. A bounded hint, never an authority — it can only
//                move the graded stop EARLIER, by at most
//                `STOP_CLIENT_SLACK_MS`, and never past the server's own
//                measurement (see `resolveStopElapsedMs` in the engine).
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
import { requireAgeVerifiedUser } from "../../../../lib/auth/requireAgeVerified";
import { verifyToken } from "@clerk/backend";
import { recordRoundStop } from "../../../../lib/precision/serverStore";
import { logError } from "../../../../lib/logError";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  // Stamp the STOP the moment the request lands. This is the earliest instant
  // this process can vouch for, and it is deliberately captured before the
  // body parse and before `recordRoundStop` opens its transaction (whose
  // connection handshake against a pooled remote database is a real round trip
  // — charging it to the player pushed every recorded stop later than the
  // click).
  const receivedAtMs = Date.now();
  try {
    const body = await req.json().catch(() => ({}));
    const matchId = String(body?.matchId ?? "");
    const roundId = String(body?.roundId ?? "");
    const nonce = String(body?.nonce ?? "");

    // ── Caller identity is NEVER taken from the body ────────────────────
    // IDOR hardening: the realtime server (no Clerk session) sends the
    // player's raw Clerk session token, which we verify to recover the
    // authoritative userId; direct callers authenticate via their session
    // cookie. A spoofed body.userId is ignored — a malicious client can
    // no longer submit a STOP (or a Ready) on another player's behalf.
    // The elapsed the player's client froze at when they hit STOP — the
    // number on their screen, measured against the same server GO instant this
    // route scores from. It is a HINT, not an input: `recordRoundStop` clamps
    // it against its own measurement (see `resolveStopElapsedMs`). It is
    // carried for exactly one reason — the packet needs one delivery to get
    // here, so our own stamp is the click plus that lag, and a MISS tier that
    // starts at 100ms would grade a dead-on click as a miss without it.
    const claimedElapsedMs = Number(body?.elapsedMs);
    const clientElapsedMs = Number.isFinite(claimedElapsedMs)
      ? claimedElapsedMs
      : null;

    const token = typeof body?.token === "string" ? body.token : "";
    let userId = "";
    if (token) {
      const CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY;
      if (!CLERK_SECRET_KEY) {
        return NextResponse.json(
          { success: false, error: "Server authentication is not configured" },
          { status: 500 },
        );
      }
      try {
        const verified = await verifyToken(token, {
          secretKey: CLERK_SECRET_KEY,
        });
        userId = verified.sub ?? "";
      } catch {
        return NextResponse.json(
          { success: false, error: "Invalid token" },
          { status: 401 },
        );
      }
    } else {
      // Browser path: enforce the 18+ gate. The token branch above is the
      // realtime server acting for a player mid-round and has no session to check.
      const gate = await requireAgeVerifiedUser();
      if (gate.response) return gate.response;
      userId = gate.userId ?? "";
    }
    if (!userId) {
      return NextResponse.json(
        { success: false, error: "Unauthorized" },
        { status: 401 },
      );
    }

    if (!matchId) {
      return NextResponse.json(
        { success: false, error: "Missing matchId." },
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
    // The route does not accept a `stopMs` instant from the network: the
    // server stamps the STOP instant inside `recordRoundStop` and computes
    // elapsed authoritatively from `match.roundGoInstant`. The only timing
    // value read from the body is the bounded `elapsedMs` hint above, which
    // the server clamps against its own measurement.

    // One transaction: lock the match row, apply any transition whose
    // instant has passed (the arming countdown reveal, the bot's due stop),
    // validate the replay envelope, stamp the STOP instant, and grade the
    // round once both seats have submitted.
    const result = await recordRoundStop(matchId, userId, roundId, nonce, {
      receivedAtMs,
      clientElapsedMs,
    });
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
          // True when the refusal is really "you already stopped this round".
          // The client's socket-ACK timeout fallback re-submits the same stop
          // over HTTPS, so it has to be able to tell "your click is already
          // recorded" apart from a genuine rejection — without it, a stop that
          // reached the server but lost its ACK would show the player an error
          // for a round the server had already accepted.
          alreadySubmitted: result.alreadySubmitted,
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
    await logError({
      errorType: "precision_round_stop_error",
      errorMessage: err instanceof Error ? err.message : "Precision round stop failed",
      stackTrace: err instanceof Error ? err.stack : undefined,
      endpoint: "/api/precision/round-stop",
      game: "Precision",
      metadata: { operation: "record_round_stop" },
    });
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
