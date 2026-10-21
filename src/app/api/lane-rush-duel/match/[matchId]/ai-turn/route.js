// src/app/api/lane-rush-duel/match/[matchId]/ai-turn/route.js
//
// POST — execute the practice bot's turn (mirrors the PvP /ai-turn
// pattern).
//   * RACE (state version 1) — `botRaceAct` builds an ordinary validated plan
//     (`src/lib/lane-rush/bot.ts`) and applies it through the same engine a
//     human plan uses, then locks it in. Only the bot's route-risk appetite
//     depends on difficulty.
//   * LEGACY BRIDGE (state version 0) — `decideBridgeBotAction` picks a tile on
//     its own row through the preserved transition.
// Either path is throttled and idempotent per round, exactly like the human
// action route.

import { NextResponse } from "next/server";
import { requireAgeVerifiedUser } from "../../../../../../lib/auth/requireAgeVerified";
import { botAct, fetchMatch } from "../../../../../../lib/lane-rush-duel/serverStore";
import { broadcastMatchUpdate } from "../../../../../../lib/lane-rush-duel/rooms";
import {
  botRaceAct,
  isRaceMatch,
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

  // The client stamps each wake-up with a unique `actionId`, so a
  // retried request (or two poll effects firing for the same state)
  // resolves exactly one bot action instead of granting the bot a
  // second, extra turn.
  let body = null;
  try {
    body = await req.json();
  } catch (e) {
    body = null;
  }
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
    // The bot submits an ordinary validated plan (buy / merge / repair /
    // deploy / lock) through the same engine and lifecycle as a human. It
    // never picks a bridge tile and never decides a race outcome.
    if (isRaceMatch(existingRow)) {
      const plan = await botRaceAct({ matchId, requesterId: userId, actionId });
      if (plan.error) {
        return NextResponse.json(
          { success: false, error: plan.error, code: plan.code },
          { status: plan.status || 400 },
        );
      }
      if (!plan.duplicate && !plan.paused && !plan.noop) {
        broadcastMatchUpdate(matchId, {
          status: plan.match?.status ?? "active",
          action: "bot-plan",
          round: plan.match?.gameState?.round ?? plan.state?.round ?? null,
          planned: plan.planned ?? 0,
          locked: Boolean(plan.locked),
          resolved: Boolean(plan.resolved),
          resolvedRound: plan.resolution?.round ?? null,
        });
      }
      return NextResponse.json({
        success: true,
        data: {
          status: plan.match?.status ?? "active",
          duplicate: Boolean(plan.duplicate),
          paused: Boolean(plan.paused),
          planned: plan.planned ?? 0,
          locked: Boolean(plan.locked),
          resolved: Boolean(plan.resolved),
          resolvedRound: plan.resolution?.round ?? null,
          finished: plan.resolution?.finished === true,
        },
      });
    }

    const result = await botAct({ matchId, requesterId: userId, actionId });

    if (result.error) {
      // 409 = not the bot's turn / window expired — benign races the
      // polling loop handles naturally, so return ok:false (the page
      // just re-polls instead of surfacing an error).
      return NextResponse.json(
        { success: false, error: result.error },
        { status: result.status || 400 },
      );
    }

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

    // The bot's fall breaks a tile exactly like a human's, so it rides the
    // same existing event: both seats learn the broken tile without waiting
    // for a poll. Only public information (the tile + the public broken list).
    broadcastMatchUpdate(matchId, {
      status: result.status,
      action: "bot",
      brokeTile: result.newlyBroken ? result.brokeTile : null,
      broken: Array.isArray(result.broken) ? result.broken : undefined,
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
    console.error("[lane-rush-duel/ai-turn] error:", error);
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
