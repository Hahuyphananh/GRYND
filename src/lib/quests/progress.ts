// src/lib/quests/progress.ts
//
// The rules. Everything here is pure — no database, no clock unless one is
// passed in — so the one thing that must never be wrong (what may move a quest)
// is directly unit-testable.
//
// THE RULE
//   Only a genuinely completed, server-verified match against another real
//   human may advance a quest. That is enforced structurally: `advanceQuest`
//   takes `QuestMatchEvidence`, whose every field is required, and rejects it
//   unless `completed === true`, `opponentKind === "human"` and the game key
//   normalizes to a canonical game. AI seats, bots, guest seats, empty lobbies,
//   cancels, abandons and unfinished rows therefore have no representation that
//   can pass — and a rejected match returns the row completely unchanged.
//
//   The same guard means a settlement writer cannot "accidentally" feed quests
//   from a practice match: it would have to assert `opponentKind: "human"` and
//   `completed: true` for a match that has no human opponent, which is a lie the
//   rest of the settlement path independently contradicts.
//
// REWARDS stay separate from Elo, trophies, wager winnings and the daily login
// reward: this module only decides that a quest is COMPLETE and CLAIMABLE. It
// never credits anything; a claim path (not built yet) owns that, through the
// normal coin ledger.

import { findQuestDefinition, QUEST_OBJECTIVES } from "./definitions";
import { canonicalQuestGame } from "./games";
import type {
  QuestDefinition,
  QuestMatchEvidence,
  QuestMeta,
  QuestObjectiveType,
  QuestPeriodType,
  QuestProgressReason,
  QuestProgressResult,
  QuestRow,
  QuestView,
} from "./types";

function toCount(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toDate(value: unknown): Date | null {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Convert a stored row (Drizzle camelCase, or a raw SQL snake_case row) into the
 * domain shape. numeric(14,2) columns may arrive as strings, so every count is
 * parsed here rather than trusted downstream.
 */
export function normalizeQuestRow(row: any): QuestRow {
  const rawMeta = row?.meta ?? row?.meta_json ?? {};
  const meta: QuestMeta =
    rawMeta && typeof rawMeta === "object" && !Array.isArray(rawMeta)
      ? (rawMeta as QuestMeta)
      : {};

  const periodType: QuestPeriodType =
    (row?.periodType ?? row?.period_type) === "weekly" ? "weekly" : "daily";

  const normalized: QuestRow = {
    userId: toCount(row?.userId ?? row?.user_id),
    periodType,
    periodKey: String(row?.periodKey ?? row?.period_key ?? ""),
    slot: toCount(row?.slot),
    questType: String(
      row?.questType ?? row?.quest_type ?? "",
    ) as QuestObjectiveType,
    gameKey: (row?.gameKey ?? row?.game_key ?? null) as string | null,
    target: toCount(row?.target),
    reward: toCount(row?.reward),
    progress: toCount(row?.progress),
    claimed: Boolean(row?.claimed),
    meta,
    completedAt: toDate(row?.completedAt ?? row?.completed_at),
  };

  // `id` stays absent for a row that has not been inserted yet, rather than
  // being present-but-undefined — the drafts built by `buildQuestRows` and a
  // freshly read row then have the same shape.
  if (row?.id !== undefined && row?.id !== null) {
    normalized.id = toCount(row.id);
  }

  return normalized;
}

/**
 * Whether this evidence describes a match a quest may count.
 *
 * Every clause maps to a way a match is NOT a completed human game:
 *   completed      cancelled / abandoned / still playing / void
 *   opponentKind   AI practice, a bot seat, an empty lobby, a spectator view
 *   matchId        no settled match row to point at
 *   outcome        anything the settlement layer did not decide
 *   gameKey        a game the platform cannot identify (counted as no game)
 */
export function isQuestEligibleMatch(
  match: QuestMatchEvidence | null | undefined,
): boolean {
  if (!match || typeof match !== "object") return false;
  if (match.completed !== true) return false;
  if (match.opponentKind !== "human") return false;
  if (typeof match.matchId !== "string" || match.matchId.length === 0) return false;
  if (
    match.outcome !== "win" &&
    match.outcome !== "loss" &&
    match.outcome !== "draw"
  ) {
    return false;
  }
  return canonicalQuestGame(match.gameKey) !== null;
}

/** The canonical games this row has already counted (distinct-games quests). */
function countedGames(meta: QuestMeta): string[] {
  const raw = Array.isArray(meta?.games) ? meta.games : [];
  const games: string[] = [];
  for (const value of raw) {
    const game = canonicalQuestGame(value);
    if (game && !games.includes(game)) games.push(game);
  }
  return games;
}

/** Has the objective been met? Derived from progress, so a re-read cannot drift. */
export function isQuestComplete(row: QuestRow): boolean {
  const target = toCount(row.target);
  if (target <= 0) return false;
  return toCount(row.progress) >= target;
}

/**
 * May this quest pay its reward right now?
 *
 * `claimed` is the durable flag from the row; a claim path must still write the
 * coin ledger atomically (duplicate prevention lives there, exactly like the
 * daily login reward), but this is the single eligibility rule both the UI and
 * that path read.
 */
export function canClaimQuest(row: QuestRow): boolean {
  return isQuestComplete(row) && !row.claimed;
}

/**
 * Apply one settled match to one quest slot.
 *
 * Returns the row unchanged (`advanced: false`) with a reason for every refusal,
 * so a settlement writer can call this unconditionally and log only what it
 * needs. Progress clamps at `target`, and `completedAt` is stamped exactly once.
 */
export function advanceQuest(
  row: QuestRow,
  match: QuestMatchEvidence,
  at: Date = new Date(),
): QuestProgressResult {
  const current = normalizeQuestRow(row);

  if (current.claimed) {
    return { advanced: false, reason: "claimed", row: current };
  }
  if (isQuestComplete(current)) {
    return { advanced: false, reason: "complete", row: current };
  }

  const gameKey = canonicalQuestGame(match?.gameKey);
  if (!isQuestEligibleMatch(match) || !gameKey) {
    return { advanced: false, reason: "ineligible", row: current };
  }
  if (current.gameKey && current.gameKey !== gameKey) {
    return { advanced: false, reason: "wrong-game", row: current };
  }
  if (!QUEST_OBJECTIVES.includes(current.questType)) {
    return { advanced: false, reason: "unknown-objective", row: current };
  }

  let next: QuestRow;

  if (current.questType === "pvp_wins") {
    // A completed match is not a win: losses and draws move nothing here.
    if (match.outcome !== "win") {
      return { advanced: false, reason: "not-a-win", row: current };
    }
    next = { ...current, progress: current.progress + 1 };
  } else if (current.questType === "pvp_games") {
    const games = countedGames(current.meta);
    if (games.includes(gameKey)) {
      return { advanced: false, reason: "already-counted", row: current };
    }
    next = {
      ...current,
      progress: games.length + 1,
      meta: { ...current.meta, games: [...games, gameKey] },
    };
  } else {
    // pvp_matches: any completed human match, whatever the result.
    next = { ...current, progress: current.progress + 1 };
  }

  const progress = Math.min(next.progress, Math.max(0, next.target));
  // A corrupt target (0/negative, already normalized) never "completes":
  // completion is only meaningful for a positive goal.
  const completedAt =
    current.completedAt ??
    (next.target > 0 && progress >= next.target ? at : null);

  return { advanced: true, reason: "advanced", row: { ...next, progress, completedAt } };
}

function defaultQuestTitle(periodType: QuestPeriodType): string {
  return periodType === "weekly" ? "Weekly quest" : "Daily quest";
}

/** Objective text used when a stored row no longer resolves to a definition. */
export function describeQuestObjective(
  objective: QuestObjectiveType,
  target: number,
): string {
  const count = Math.max(0, toCount(target));
  const matches = count === 1 ? "match" : "matches";

  if (objective === "pvp_wins") {
    return `Win ${count} ${matches} against human opponents.`;
  }
  if (objective === "pvp_games") {
    return `Play human-vs-human matches in ${count} different games.`;
  }
  return `Play ${count} ${matches} against human opponents.`;
}

/**
 * The UI projection: everything the player must be able to see (objective,
 * target, progress, reward, period and state) in one flat object.
 *
 * The title/description come from the definition recorded in `meta`, so a
 * catalog edit cannot retroactively change what a finished row says — an
 * unresolvable id falls back to neutral objective text.
 */
export function toQuestView(row: QuestRow): QuestView {
  const normalized = normalizeQuestRow(row);
  const definition: QuestDefinition | null = findQuestDefinition(
    normalized.meta?.definitionId,
  );

  return {
    id: normalized.id,
    periodType: normalized.periodType,
    periodKey: normalized.periodKey,
    slot: normalized.slot,
    definitionId: normalized.meta?.definitionId ?? null,
    objective: normalized.questType,
    gameKey: normalized.gameKey,
    title: definition?.title ?? defaultQuestTitle(normalized.periodType),
    description:
      definition?.description ??
      describeQuestObjective(normalized.questType, normalized.target),
    target: normalized.target,
    progress: normalized.progress,
    reward: normalized.reward,
    completed: isQuestComplete(normalized),
    claimed: normalized.claimed,
    claimable: canClaimQuest(normalized),
  };
}

