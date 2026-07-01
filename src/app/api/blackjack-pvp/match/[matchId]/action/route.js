// src/app/api/blackjack-pvp/match/[matchId]/action/route.js
//
// POST — submit a per-round action for the calling player. The
// supported action vocabulary is defined in
// `src/lib/blackjack-pvp/constants.js`:
//   * `hit`           — draw one card from the deck
//   * `stand`         — mark seat as stood
//   * `swap`          — replace one of the two ORIGINAL starting
//                       cards with a fresh card (1 use per round)
//   * `hold`          — stash the LAST drawn card aside (1 use/round,
//                       only after at least one hit)
//   * `use_held`      — resolve a held card (`subaction: "add"` to
//                       append to hand, `"discard"` to throw it away)
//
// The route is intentionally thin: it forwards the (action, payload)
// pair to `recordAction` in the server store, which performs:
//
//   * participant + active-round validation
//   * deadline AFK check (force-stand on stale clock)
//   * per-action precondition gate (swap-limit/hold-limit/etc.)
//   * FOR UPDATE row lock so two parallel seats cannot race
//   * conditional UPDATE on `match.status` to refuse stale POSTs
//   * synchronous round-resolution when both seats are terminal
//
// Anti-cheat considerations baked into `recordAction`:
//   * a player can only act on their own seat (server-trusted clerkId)
//   * a stale or empty shoe cannot be drawn from (deck.length gate)// * per-round caps (1 swap, 1 hold) prevent stacking
//   * Per Prompt 7: once a seat leaves `playing` (stood or busted)
//     every remaining gameplay action is rejected with a 409 — the
//     previous swap-after-bust revival escape hatch is closed so the
//     "any additional gameplay actions disabled" invariant holds
//     from the moment the player finalises their hand.

//
// Response shape matches
// `src/app/api/roulette-pvp/match/[matchId]/bet/route.js` so any
// shared polling/state helpers can stay reusable.

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import {
  recordAction,
  viewerPlayerState,
} from "../../../../../../lib/blackjack-pvp/serverStore";
import {
  ACTION_TYPE,
  MATCH_STATUS,
  USE_HELD_SUBACTIONS,
} from "../../../../../../lib/blackjack-pvp/constants";

const VALID_ACTIONS = new Set(Object.values(ACTION_TYPE));

function isTerminalStatus(status) {
  return status === MATCH_STATUS.FINISHED || status === MATCH_STATUS.CANCELLED;
}

function scrubHandInPlace(hand) {
  if (!Array.isArray(hand)) return [];
  return hand.map(() => ({ suit: "?", value: "?" }));
}

function scrubHeldCardInPlace(heldCard) {
  if (!heldCard) return null;
  return { suit: "?", value: "?" };
}

// Return the opponent's Swap/Hold counters + held card hidden from
// the viewer. The viewer sees only their OWN swap/hold state in full.
function normaliseMatchForViewer(match, viewerUserId) {
  if (!match) return null;
  const viewerIsPlayer1 = match.player1Id === viewerUserId;
  const terminal = isTerminalStatus(match.status);

  return {
    id: match.id,
    player1Id: match.player1Id,
    player2Id: match.player2Id,
    stakeAmount: Number(match.stakeAmount),
    status: match.status,
    roundNumber: match.roundNumber,
    roundsWonPlayer1: match.roundsWonPlayer1,
    roundsWonPlayer2: match.roundsWonPlayer2,
    player1Hand:
      terminal || viewerIsPlayer1 ? match.player1Hand : scrubHandInPlace(match.player1Hand),
    player2Hand:
      terminal || !viewerIsPlayer1 ? match.player2Hand : scrubHandInPlace(match.player2Hand),
    // Per Prompt 7: opponent's seat state is hidden during active
    // play (round_1/2/3) so we can't infer whether they've stood.
    // After the round resolves (between_rounds/finished) both seats
    // are revealed via the persisted rounds history payload.
    player1State: viewerPlayerState(match, 1, viewerUserId),
    player2State: viewerPlayerState(match, 2, viewerUserId),
    // Wire-only computed booleans (Prompt 9 schema refactor).
    player1Standing: viewerPlayerState(match, 1, viewerUserId) !== "playing",
    player2Standing: viewerPlayerState(match, 2, viewerUserId) !== "playing",
    viewerIsPlayer1,
    opponentHandRevealed: terminal,
    roundDeadline: match.roundDeadline,
    winner: match.winner,
    result: match.result,
    prizePaid: match.prizePaid ? Number(match.prizePaid) : 0,
    houseFee: match.houseFee ? Number(match.houseFee) : 0,
    roundTimer: match.roundTimerSeconds ?? 20,
    startedAt: match.startedAt,
    endedAt: match.endedAt,
    createdAt: match.createdAt,
    // Per-seat Swap/Hold counters. Only the VIEWER's seat is in full;
    // the opponent's seat is collapsed to a boolean so the UI can't
    // infer their strategy.
    player1UsedSwap: viewerIsPlayer1
      ? match.player1UsedSwap
      : match.player1UsedSwap > 0
        ? 1
        : 0,
    player2UsedSwap: !viewerIsPlayer1
      ? match.player2UsedSwap
      : match.player2UsedSwap > 0
        ? 1
        : 0,
    player1UsedFreeze: viewerIsPlayer1
      ? match.player1UsedFreeze
      : match.player1UsedFreeze > 0
        ? 1
        : 0,
    player2UsedFreeze: !viewerIsPlayer1
      ? match.player2UsedFreeze
      : match.player2UsedFreeze > 0
        ? 1
        : 0,
    // The viewer sees their own heldCard in full (so they can preview
    // it before deciding add vs discard). The opponent sees a stub.
    player1FrozenCard: viewerIsPlayer1
      ? match.player1FrozenCard
      : scrubHeldCardInPlace(match.player1FrozenCard),
    player2FrozenCard: !viewerIsPlayer1
      ? match.player2FrozenCard
      : scrubHeldCardInPlace(match.player2FrozenCard),
    player1HeldResolved: viewerIsPlayer1
      ? match.player1HeldResolved
      : Boolean(match.player1HeldResolved),
    player2HeldResolved: !viewerIsPlayer1
      ? match.player2HeldResolved
      : Boolean(match.player2HeldResolved),
  };
}

export async function POST(req, { params }) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 },
    );
  }

  const matchId = Number(params?.matchId);
  if (!Number.isFinite(matchId)) {
    return NextResponse.json(
      { success: false, error: "Invalid matchId" },
      { status: 400 },
    );
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  const action = String(body?.action || "").toLowerCase();
  if (!VALID_ACTIONS.has(action)) {
    return NextResponse.json(
      {
        success: false,
        error: `Action must be one of: ${[...VALID_ACTIONS].join(", ")}`,
      },
      { status: 400 },
    );
  }

  // Per-action payload validation. Server-side authority: the client
  // cannot smuggle an unsupported `swapIndex` or `subaction` value.
  const payload =
    body?.payload && typeof body.payload === "object" ? body.payload : {};
  if (action === ACTION_TYPE.SWAP) {
    if (payload.swapIndex !== 0 && payload.swapIndex !== 1) {
      return NextResponse.json(
        { success: false, error: "swap requires payload.swapIndex (0 or 1)" },
        { status: 400 },
      );
    }
  }
  if (action === ACTION_TYPE.USE_HELD) {
    if (
      payload.subaction !== USE_HELD_SUBACTIONS.ADD &&
      payload.subaction !== USE_HELD_SUBACTIONS.DISCARD
    ) {
      return NextResponse.json(
        {
          success: false,
          error: "use_held requires payload.subaction ('add' or 'discard')",
        },
        { status: 400 },
      );
    }
  }

  try {
    const result = await recordAction({ userId, matchId, action, payload });
    if (result.error) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: result.status || 400 },
      );
    }
    return NextResponse.json({
      success: true,
      data: {
        match: normaliseMatchForViewer(result.match, userId),
        justResolved: Boolean(result.justResolved),
        forceAdvanced: Boolean(result.forceAdvanced),
        raced: Boolean(result.raced),
      },
    });
  } catch (error) {
    console.error("[blackjack-pvp/match/action] error:", error);
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
