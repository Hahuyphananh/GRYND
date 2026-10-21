// src/lib/quests/types.ts
//
// Shared vocabulary for the quest domain. Pure types only — no imports, no
// side effects — so the rules can be unit-tested without a database.

/** The two quest periods. There is deliberately no monthly/season track. */
export type QuestPeriodType = "daily" | "weekly";

/**
 * What a quest counts.
 *
 * Deliberately NOT the retired 0132 vocabulary (`wager`, `multiplier`,
 * `streak`, `diversify`). Every quest that ships counts settled matches against
 * another human, and naming the objective narrowly is what keeps a "play 3
 * matches" quest from being satisfied by anything except a real match.
 */
export type QuestObjectiveType = "pvp_matches" | "pvp_wins" | "pvp_games";

export type QuestDefinition = {
  /** Stable slug, stored in `meta.definitionId` so a row can be explained later. */
  id: string;
  periodType: QuestPeriodType;
  objective: QuestObjectiveType;
  /** How many qualifying matches the quest needs. Whole numbers, at least 1. */
  target: number;
  /** Virtual coins paid on claim. Never cash, never a purchased shortcut. */
  reward: number;
  /** null = any game; otherwise only matches in this canonical game count. */
  gameKey: string | null;
  title: string;
  description: string;
};

/** `user_quests.meta`: the definition that generated the slot + quest state. */
export type QuestMeta = {
  definitionId?: string;
  /** Canonical game ids already counted by a distinct-games quest. */
  games?: string[];
};

/**
 * One quest slot, with numbers already parsed.
 *
 * `target`/`progress` are numeric(14,2) in Postgres (0132's type), so they can
 * arrive as strings; `normalizeQuestRow` is the one place that converts them.
 */
export type QuestRow = {
  id?: number;
  userId: number;
  periodType: QuestPeriodType;
  periodKey: string;
  slot: number;
  questType: QuestObjectiveType;
  gameKey: string | null;
  target: number;
  reward: number;
  progress: number;
  claimed: boolean;
  meta: QuestMeta;
  completedAt: Date | null;
};

/** Who the opponent actually was. Only `human` may move a quest. */
export type QuestOpponentKind = "human" | "ai" | "bot" | "none";

export type QuestMatchOutcome = "win" | "loss" | "draw";

/**
 * The ONLY thing a settlement writer may hand the quest module.
 *
 * Every field is required (no defaults) because a default is exactly how an AI
 * match or a cancelled row would slip into quest progress: a caller that cannot
 * say the opponent was human and the match completed cannot construct this.
 */
export type QuestMatchEvidence = {
  matchId: string;
  /** Settlement game key; normalized to the canonical id by `games.ts`. */
  gameKey: string;
  opponentKind: QuestOpponentKind;
  /** Reached a settled, server-decided end — not cancelled, abandoned or void. */
  completed: boolean;
  outcome: QuestMatchOutcome;
};

export type QuestProgressReason =
  | "advanced"
  | "ineligible"
  | "claimed"
  | "complete"
  | "already-counted"
  | "not-a-win"
  | "wrong-game"
  | "unknown-objective";

export type QuestProgressResult = {
  advanced: boolean;
  reason: QuestProgressReason;
  /** The row as it should now be stored (unchanged when `advanced` is false). */
  row: QuestRow;
};

/** What the UI renders. Objective, target, progress, reward and state, together. */
export type QuestView = {
  id?: number;
  periodType: QuestPeriodType;
  periodKey: string;
  slot: number;
  definitionId: string | null;
  objective: QuestObjectiveType;
  gameKey: string | null;
  title: string;
  description: string;
  target: number;
  progress: number;
  reward: number;
  completed: boolean;
  claimed: boolean;
  /** Completed and not yet claimed — the only state that may pay a reward. */
  claimable: boolean;
};
