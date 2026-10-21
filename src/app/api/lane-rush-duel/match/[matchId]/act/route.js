// src/app/api/lane-rush-duel/match/[matchId]/act/route.js
//
// POST — a player action:
//   * RACE (state version 1) — `{ actionId, round, stateVersion, actions }`,
//     where `actions` is a validated planning sequence (deploy / recall /
//     setRoute / buy / merge / repair / workshopRecovery / lockIn). The race
//     store applies the whole plan inside one row-locked transaction.
//   * LEGACY BRIDGE (state version 0) — `action: "jump"` (or `"pick"`) with the
//     `row`/`tile`, or `action: "flag"` for a tile this player landed on
//     safely. Preserved only for unfinished historical rows.
//
// The client stamps every action with:
//   * `actionId` — a unique id, so a retried POST is an idempotent
//     no-op instead of a second resolution — and
//   * `round` (race) or `row` (legacy) — what the control was rendered
//     against, so a stale request is rejected instead of resolving on
//     state the player never saw.

import { NextResponse } from "next/server";
import { requireAgeVerifiedUser } from "../../../../../../lib/auth/requireAgeVerified";
import { act, fetchMatch } from "../../../../../../lib/lane-rush-duel/serverStore";
import { broadcastMatchUpdate } from "../../../../../../lib/lane-rush-duel/rooms";
import {
  isRaceMatch,
  submitRacePlan,
} from "../../../../../../lib/lane-rush/raceStore";

export async function POST(req, { params }) {
  const gate = await requireAgeVerifiedUser();
  if (gate.response) return gate.response;
  const userId = gate.userId;

  const resolvedParams = (await params) || {};
  const matchId = Number(resolvedParams?.matchId);
  if (!Number.isFinite(matchId)) {
    return NextResponse.json(
      { success: false, error: "Invalid matchId" },
      { status: 400 },
    );
  }

  let body;
  try {
    body = await req.json();
  } catch (e) {
    return NextResponse.json(
      { success: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  const action = String(body?.action || "");
  // TILE SELECTION (`jump`) sends the `row` the player is standing on plus the
  // `tile` they chose; a MEMORY FLAG (`flag`) sends the row/tile to flag.
  const row = body?.row ?? null;
  const tile = body?.tile ?? null;
  const actionId = body?.actionId ?? null;

  try {
    const existingRow = await fetchMatch(matchId);
    if (!existingRow) {
      return NextResponse.json(
        { success: false, error: "Match not found" },
        { status: 404 },
      );
    }

    // ── Racing game (gameStateVersion 1) ─────────────────────────────
    // The request carries `actions: [...]` (optionally ending in a lock-in),
    // never a score, roll, DNF or opponent plan. The rows are dispatched by
    // version, so an unfinished legacy bridge match keeps using the old
    // turn/tile transition below.
    if (isRaceMatch(existingRow)) {
      if (
        existingRow.player1Id !== userId &&
        existingRow.player2Id !== userId
      ) {
        return NextResponse.json(
          { success: false, error: "Forbidden", code: "forbidden" },
          { status: 403 },
        );
      }

      if (typeof body?.action === "string") {
        return NextResponse.json(
          {
            success: false,
            error: "This match uses racing actions, not bridge tiles",
            code: "legacy_action",
          },
          { status: 400 },
        );
      }

      const submitted = Array.isArray(body?.actions)
        ? body.actions
        : body?.action && typeof body.action === "object"
          ? [body.action]
          : [];
      const plan = await submitRacePlan({
        userId,
        matchId,
        actionId,
        actions: submitted,
        expectedRound: body?.round ?? body?.expectedRound,
        expectedStateVersion: body?.stateVersion ?? body?.expectedStateVersion,
      });

      if (plan.error) {
        // An expired plan may still have resolved the round; tell both seats.
        if (plan.resolved) {
          broadcastMatchUpdate(matchId, {
            status: plan.resolution?.finished ? "finished" : "active",
            action: "race-resolved",
            resolvedRound: plan.resolution?.round ?? null,
          });
        }
        return NextResponse.json(
          {
            success: false,
            error: plan.error,
            code: plan.code,
            resolved: Boolean(plan.resolved),
          },
          { status: plan.status || 400 },
        );
      }

      const round =
        plan.match?.gameState?.round ?? plan.state?.round ?? null;
      if (!plan.duplicate) {
        broadcastMatchUpdate(matchId, {
          status: plan.match?.status ?? "active",
          action: "plan",
          round,
          resolved: Boolean(plan.resolved),
          resolvedRound: plan.resolution?.round ?? null,
          finished: plan.resolution?.finished === true,
        });
      }

      return NextResponse.json({
        success: true,
        data: {
          status: plan.match?.status ?? "active",
          duplicate: Boolean(plan.duplicate),
          round,
          stateVersion: 1,
          locked: Boolean(plan.locked),
          resolved: Boolean(plan.resolved),
          resolvedRound: plan.resolution?.round ?? null,
          finished: plan.resolution?.finished === true,
          result: plan.match?.result ?? null,
          winnerId: plan.match?.winnerId ?? null,
        },
      });
    }

    const result = await act({ userId, matchId, action, row, tile, actionId });

    if (result.error) {
      // A tile that arrived after its 15s window still MOVED the match (the
      // attempt ended and the turn switched), so push it — otherwise the
      // opponent's board would wait for its next poll to see the timeout.
      if (result.timedOut) {
        broadcastMatchUpdate(matchId, {
          status: result.matchStatus,
          action: "timeout",
        });
      }
      return NextResponse.json(
        {
          success: false,
          error: result.error,
          timedOut: result.timedOut === true,
        },
        { status: result.status || 400 },
      );
    }

    // A duplicate (already-resolved actionId) is a success no-op — the
    // action landed on the first attempt, so nothing changed and there
    // is nothing new to broadcast.
    if (result.duplicate) {
      return NextResponse.json({
        success: true,
        data: {
          status: result.status,
          duplicate: true,
          result: null,
          winnerId: null,
        },
      });
    }

    // Best-effort live push to the per-match room so BOTH seats' status poll
    // fires inside ~50ms instead of waiting for the 5s safety net.
    //
    // BROKEN-TILE UPDATE: a tile that was just stepped on stays broken for the
    // rest of the match and is public from that moment, so the exact tile rides
    // this existing event (null on a safe choice). The payload carries only
    // public information — the one tile that broke plus the public broken list —
    // never the bridge layout, and a safe tile is never revealed.
    broadcastMatchUpdate(matchId, {
      status: result.status,
      action,
      brokeTile: result.newlyBroken ? result.brokeTile : null,
      broken: Array.isArray(result.broken) ? result.broken : undefined,
      // MEMORY FLAGS are PUBLIC: a newly placed flag (null when this action was
      // a tile choice) plus both seats' full flag lists, so both players see it
      // immediately. Flags only ever mark a tile that seat landed on safely, so
      // nothing hidden is revealed by them.
      flagPlaced: result.flagPlaced ?? null,
      p1Flags: Array.isArray(result.p1Flags) ? result.p1Flags : undefined,
      p2Flags: Array.isArray(result.p2Flags) ? result.p2Flags : undefined,
    });

    return NextResponse.json({
      success: true,
      data: {
        status: result.status,
        duplicate: false,
        result: result.result ?? null,
        winnerId: result.winnerId ?? null,
      },
    });
  } catch (error) {
    console.error("[lane-rush-duel/act] error:", error);
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
