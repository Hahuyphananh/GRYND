// src/lib/quests/definitions.ts
//
// The quest catalog and the deterministic slot planner.
//
// DESIGN
//   * A period offers a POOL of quests and shows `QUEST_SLOTS[periodType]` of
//     them. The selection rotates with the period key, so every player sees the
//     same set in the same day/week (fair, debuggable, screenshot-comparable)
//     while consecutive periods differ.
//   * Selection is a pure function of (periodType, periodKey): a retried or
//     concurrent generation derives the SAME slots, and the unique
//     (user, period, slot) constraint plus ON CONFLICT DO NOTHING in the store
//     makes a duplicate slot impossible.
//   * The pools are longer than the slot count, so a period never shows the same
//     quest twice.
//
// REWARDS are virtual coins, calibrated against the existing economy: a daily
// quest pays less than one MAX_WIN_PER_MATCH (1,000) and roughly a login day; a
// weekly quest pays about a day's worth of daily rewards. Nothing here is
// purchasable, cashable or convertible — the rewards are the existing coin
// balance only, credited later through the normal token ledger.

import type {
  QuestDefinition,
  QuestObjectiveType,
  QuestPeriodType,
  QuestRow,
} from "./types";

/** How many quests a period shows. Configurable in one place, by design. */
export const QUEST_SLOTS: Readonly<Record<QuestPeriodType, number>> = {
  daily: 3,
  weekly: 2,
};

/**
 * Daily pool: short, achievable objectives that nudge a player into one more
 * game and into a second game. Targets are per UTC day.
 */
export const DAILY_QUESTS: readonly QuestDefinition[] = [
  {
    id: "daily-first-match",
    periodType: "daily",
    objective: "pvp_matches",
    target: 1,
    reward: 40,
    gameKey: null,
    title: "First match",
    description: "Play 1 match against a human opponent.",
  },
  {
    id: "daily-three-matches",
    periodType: "daily",
    objective: "pvp_matches",
    target: 3,
    reward: 50,
    gameKey: null,
    title: "Warmed up",
    description: "Play 3 matches against human opponents.",
  },
  {
    id: "daily-two-wins",
    periodType: "daily",
    objective: "pvp_wins",
    target: 2,
    reward: 75,
    gameKey: null,
    title: "Winning form",
    description: "Win 2 matches against human opponents.",
  },
  {
    id: "daily-two-games",
    periodType: "daily",
    objective: "pvp_games",
    target: 2,
    reward: 60,
    gameKey: null,
    title: "Change it up",
    description: "Play human-vs-human matches in 2 different games.",
  },
  {
    id: "daily-three-games",
    periodType: "daily",
    objective: "pvp_games",
    target: 3,
    reward: 90,
    gameKey: null,
    title: "Tour the lobby",
    description: "Play human-vs-human matches in 3 different games.",
  },
];

/**
 * Weekly pool: the same three objectives, with a target a week can carry. The
 * distinct-games quests are the point of the track — they are what asks a
 * player to explore rather than grind one game.
 */
export const WEEKLY_QUESTS: readonly QuestDefinition[] = [
  {
    id: "weekly-fifteen-matches",
    periodType: "weekly",
    objective: "pvp_matches",
    target: 15,
    reward: 200,
    gameKey: null,
    title: "Weekly regular",
    description: "Play 15 matches against human opponents this week.",
  },
  {
    id: "weekly-eight-wins",
    periodType: "weekly",
    objective: "pvp_wins",
    target: 8,
    reward: 250,
    gameKey: null,
    title: "Weekly champion",
    description: "Win 8 matches against human opponents this week.",
  },
  {
    id: "weekly-four-games",
    periodType: "weekly",
    objective: "pvp_games",
    target: 4,
    reward: 250,
    gameKey: null,
    title: "Weekly sampler",
    description: "Play human-vs-human matches in 4 different games this week.",
  },
  {
    id: "weekly-five-games",
    periodType: "weekly",
    objective: "pvp_games",
    target: 5,
    reward: 300,
    gameKey: null,
    title: "Weekly explorer",
    description: "Play human-vs-human matches in 5 different games this week.",
  },
];

/** Every objective a stored row may carry — used to reject unknown values. */
export const QUEST_OBJECTIVES: readonly QuestObjectiveType[] = [
  "pvp_matches",
  "pvp_wins",
  "pvp_games",
];

/** The candidate pool for a period. Throws on an unknown period type. */
export function questPool(periodType: QuestPeriodType): readonly QuestDefinition[] {
  if (periodType === "daily") return DAILY_QUESTS;
  if (periodType === "weekly") return WEEKLY_QUESTS;
  throw new Error(`Unknown quest period type: ${String(periodType)}`);
}

/** FNV-1a (32-bit). Small, stable and dependency-free — enough to rotate a pool. */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * The quest plan for one period: `QUEST_SLOTS[periodType]` definitions, in
 * slot order.
 *
 * Deterministic: the same (periodType, periodKey) always returns the same list,
 * so two requests that race to create today's slots agree on what they are.
 */
export function planQuests(
  periodType: QuestPeriodType,
  periodKey: string,
): QuestDefinition[] {
  const pool = questPool(periodType);
  const slots = QUEST_SLOTS[periodType];
  if (typeof periodKey !== "string" || periodKey.length === 0) {
    throw new Error("A quest period key is required");
  }
  if (slots > pool.length) {
    throw new Error(
      `${periodType} asks for ${slots} quests but the pool only has ${pool.length}`,
    );
  }

  const offset = fnv1a(`${periodType}:${periodKey}`) % pool.length;
  const plan: QuestDefinition[] = [];
  for (let slot = 0; slot < slots; slot += 1) {
    plan.push(pool[(offset + slot) % pool.length]);
  }
  return plan;
}

/**
 * The rows that should exist for one player and one period.
 *
 * `slot` is the array index and the row's identity together with
 * (userId, periodType, periodKey); `meta.definitionId` records which definition
 * produced the slot so a row can still be explained if the catalog changes.
 * Progress starts at 0 and `completedAt` at null — only a settled human match
 * may move either.
 */
export function buildQuestRows({
  userId,
  periodType,
  periodKey,
}: {
  userId: number;
  periodType: QuestPeriodType;
  periodKey: string;
}): QuestRow[] {
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new Error(`A quest row needs a real user id, got ${String(userId)}`);
  }

  return planQuests(periodType, periodKey).map((definition, slot) => ({
    userId,
    periodType,
    periodKey,
    slot,
    questType: definition.objective,
    gameKey: definition.gameKey,
    target: definition.target,
    reward: definition.reward,
    progress: 0,
    claimed: false,
    meta: { definitionId: definition.id, games: [] },
    completedAt: null,
  }));
}

/** Look a definition up by its stable id (used to title a stored row). */
export function findQuestDefinition(
  id: string | null | undefined,
): QuestDefinition | null {
  if (!id) return null;
  for (const pool of [DAILY_QUESTS, WEEKLY_QUESTS]) {
    const found = pool.find((definition) => definition.id === id);
    if (found) return found;
  }
  return null;
}
