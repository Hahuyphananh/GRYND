// app/api/quests/route.js
//
// GET /api/quests
//
// Returns the player's current daily + weekly quests with progress and
// claim state. Quest rows are generated once per period (seeded per
// player/period) on first fetch and stored in `user_quests`, so the same
// set persists all day / all week and progress survives reloads.

import { auth } from "@clerk/nextjs/server";
import {
  dailyPeriodKey,
  ensureQuestsForPeriod,
  weeklyPeriodKey,
} from "../../../lib/quests";

function serializeQuest(q) {
  return {
    id: q.id,
    periodType: q.period_type,
    periodKey: q.period_key,
    slot: q.slot,
    questType: q.quest_type,
    gameKey: q.game_key,
    target: Number(q.target),
    reward: Number(q.reward),
    progress: Number(q.progress),
    claimed: !!q.claimed,
  };
}

export async function GET() {
  try {
    const { userId } = await auth();
    if (!userId) {
      return Response.json(
        { success: false, error: "Not authenticated" },
        { status: 401 },
      );
    }

    const [daily, weekly] = await Promise.all([
      ensureQuestsForPeriod(userId, "daily", dailyPeriodKey()),
      ensureQuestsForPeriod(userId, "weekly", weeklyPeriodKey()),
    ]);

    return Response.json({
      success: true,
      daily: daily.map(serializeQuest),
      weekly: weekly.map(serializeQuest),
      periodKey: dailyPeriodKey(),
      weekKey: weeklyPeriodKey(),
    });
  } catch (err) {
    console.error("[QUESTS_GET_ERROR]", err);
    return Response.json(
      { success: false, error: "Failed to load quests" },
      { status: 500 },
    );
  }
}
