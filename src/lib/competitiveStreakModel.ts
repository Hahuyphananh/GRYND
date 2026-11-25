// Pure model for the ranked win streaks. Kept free of DB imports so the badge
// and API contracts can be tested without a database connection.

export const COMPETITIVE_STREAK_GAME_KEYS = [
  "solitaire-duel",
  "solitaire-puzzle",
] as const;

export type CompetitiveGameKey = (typeof COMPETITIVE_STREAK_GAME_KEYS)[number];

export type CompetitiveStreak = {
  current: number;
  best: number;
};

/** Display names for the two independent ranked ladders. */
export const COMPETITIVE_STREAK_LABELS: Record<CompetitiveGameKey, string> = {
  "solitaire-duel": "Solitaire Ranked",
  "solitaire-puzzle": "Puzzle Ranked",
};

/** Whether a query value names one of the two supported ladders. */
export function isCompetitiveStreakGameKey(
  value: unknown,
): value is CompetitiveGameKey {
  return (
    typeof value === "string" &&
    (COMPETITIVE_STREAK_GAME_KEYS as readonly string[]).includes(value)
  );
}

/**
 * Normalize a request value to one ladder. An unknown value falls back to the
 * Solitaire Duel board rather than ever combining the two formats.
 */
export function normalizeCompetitiveStreakGameKey(
  value: unknown,
): CompetitiveGameKey {
  return isCompetitiveStreakGameKey(value) ? value : "solitaire-duel";
}

export type CompetitiveStreakRow = {
  gameKey: string;
  current?: unknown;
  best?: unknown;
};

/**
 * Normalize the rows returned by the competitive-streak read into one map that
 * ALWAYS contains both game keys, even when a player has no row yet. Rows for
 * any other game key are ignored, which is what keeps the two ladders from
 * contaminating each other.
 */
export function normalizeCompetitiveStreaks(
  rows: readonly CompetitiveStreakRow[] | null | undefined,
  gameKeys: readonly string[] = COMPETITIVE_STREAK_GAME_KEYS,
): Record<string, CompetitiveStreak> {
  const streaks: Record<string, CompetitiveStreak> = {};
  for (const gameKey of gameKeys) {
    streaks[gameKey] = { current: 0, best: 0 };
  }

  for (const row of rows ?? []) {
    if (!row || typeof row.gameKey !== "string") continue;
    if (!(row.gameKey in streaks)) continue;

    const current = Math.max(0, Math.floor(Number(row.current) || 0));
    const best = Math.max(current, Math.floor(Number(row.best) || 0));
    streaks[row.gameKey] = { current, best };
  }

  return streaks;
}
