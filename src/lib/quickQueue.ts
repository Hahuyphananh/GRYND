export const QUICK_QUEUE_GAME_KEYS = [
  "keno-pvp",
  "mines-pvp",
  "plinko-pvp",
  "blackjack-pvp",
  "roulette-pvp",
  "lane-rush-duel",
  "four-in-a-row",
  "memory-grid",
  "dots-and-boxes",
  "rps-pvp",
  "uno",
  "tower-arena",
  "pool-masters",
  "precision",
  "hex-duel",
  "chess",
  "dice-flush",
  "crash-arena",
] as const;

export type QuickQueueGameKey = (typeof QUICK_QUEUE_GAME_KEYS)[number];

export interface QuickQueueRequest {
  userId: string;
  preferredGames: QuickQueueGameKey[];
  preferredModes: string[];
  region: string | null;
  playerCount: number;
  maxWaitMs: number | null;
  /**
   * gameKey → trophy count snapshot, loaded server-side at claim time (see
   * quickQueueWorker). Optional: when absent a request falls back to the pure
   * FIFO/preference matching, so every existing caller keeps working.
   */
  trophies?: Record<string, number> | null;
}

export interface QuickQueueCandidate {
  requestId?: string;
  userId?: string;
  gameKey: QuickQueueGameKey;
  mode: string;
  region?: string | null;
  playerCount: number;
  queuedAt: number;
  available: boolean;
  /** gameKey → trophy count snapshot, when the caller supplied one. */
  trophies?: Record<string, number> | null;
}

// ── Trophy-aware matchmaking ──────────────────────────────────────────────
//
// Trophies are the primary skill signal below the cap (see src/lib/trophies.js),
// so a quick-queue pair is preferred when the two players' trophies for the
// chosen game are close. The acceptable gap starts small and WIDENS the longer
// a player waits, so nobody is starved by a thin ladder — and it collapses back
// to plain FIFO whenever either side has no trophy data (a brand-new player, or
// a game with no trophy track). Membership never influences any of this.

/** Acceptable |trophyA − trophyB| at time zero. */
export const TROPHY_MATCH_INITIAL_WINDOW = 200;

/** How much the acceptable gap grows per second of waiting. */
export const TROPHY_MATCH_WINDOW_GROWTH_PER_SEC = 60;

/**
 * Hard ceiling for the gap. Once this is reached the range spans the whole
 * trophy band, so even a top and bottom player can eventually be paired rather
 * than waiting forever.
 */
export const TROPHY_MATCH_MAX_WINDOW = 10000;

/** The acceptable trophy gap for someone who has waited `waitMs`. */
export function trophyMatchWindow(waitMs: number): number {
  const waited = Math.max(0, Number(waitMs) || 0);
  const grown =
    TROPHY_MATCH_INITIAL_WINDOW +
    Math.floor(waited / 1000) * TROPHY_MATCH_WINDOW_GROWTH_PER_SEC;
  return Math.min(TROPHY_MATCH_MAX_WINDOW, grown);
}

/**
 * One player's trophy count for a game, or null when unknown/unplayed. A null
 * means "no skill signal" — it never blocks a match and never gains priority.
 */
export function trophyForGame(
  trophies: Record<string, number> | null | undefined,
  gameKey: string,
): number | null {
  if (!trophies) return null;
  const value = Number(trophies[gameKey]);
  if (!Number.isFinite(value)) return null;
  return Math.max(0, value);
}

/**
 * True when two players' trophies for `gameKey` are within the widening
 * window. Missing data on either side always passes (FIFO fallback).
 */
export function trophiesCompatible({
  requester,
  candidate,
  gameKey,
  waitMs,
}: {
  requester?: Record<string, number> | null;
  candidate?: Record<string, number> | null;
  gameKey: string;
  waitMs: number;
}): boolean {
  const a = trophyForGame(requester, gameKey);
  const b = trophyForGame(candidate, gameKey);
  if (a === null || b === null) return true;
  return Math.abs(a - b) <= trophyMatchWindow(waitMs);
}

export function normalizeQuickQueueRequest(input: unknown): QuickQueueRequest {
  const value = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const userId = String(value.userId ?? "").trim();
  if (!userId) throw new Error("userId is required");

  const preferredGames = Array.isArray(value.preferredGames)
    ? value.preferredGames.filter((game): game is QuickQueueGameKey =>
        typeof game === "string" && (QUICK_QUEUE_GAME_KEYS as readonly string[]).includes(game),
      )
    : [...QUICK_QUEUE_GAME_KEYS];
  if (preferredGames.length === 0) throw new Error("At least one supported game is required");

  const preferredModes = Array.isArray(value.preferredModes)
    ? value.preferredModes.filter((mode): mode is string => typeof mode === "string" && mode.trim().length > 0).map((mode) => mode.trim())
    : [];
  const playerCount = Number(value.playerCount ?? 2);
  if (!Number.isInteger(playerCount) || playerCount < 1 || playerCount > 100) {
    throw new Error("playerCount must be an integer from 1 to 100");
  }
  const maxWaitMs = value.maxWaitMs == null ? null : Number(value.maxWaitMs);
  if (maxWaitMs !== null && (!Number.isInteger(maxWaitMs) || maxWaitMs <= 0)) {
    throw new Error("maxWaitMs must be a positive integer");
  }

  return {
    userId,
    preferredGames: [...new Set(preferredGames)],
    preferredModes: [...new Set(preferredModes)],
    region: value.region == null ? null : String(value.region).trim() || null,
    playerCount,
    maxWaitMs,
  };
}

export function findCompatibleQuickQueueCandidate(
  request: QuickQueueRequest,
  candidates: readonly QuickQueueCandidate[],
  now = Date.now(),
): QuickQueueCandidate | null {
  const eligible = candidates.filter((candidate) => {
    if (!candidate.available || candidate.userId === request.userId) return false;
    if (!request.preferredGames.includes(candidate.gameKey)) return false;
    if (request.preferredModes.length > 0 && !request.preferredModes.includes(candidate.mode)) return false;
    if (request.region && candidate.region && request.region !== candidate.region) return false;
    if (candidate.playerCount < request.playerCount) return false;
    if (request.maxWaitMs !== null && now - candidate.queuedAt > request.maxWaitMs) return false;
    // Trophy-aware: prefer a close skill gap, widening by how long the
    // candidate has waited. No trophy data on either side = no constraint.
    if (
      !trophiesCompatible({
        requester: request.trophies,
        candidate: candidate.trophies,
        gameKey: candidate.gameKey,
        waitMs: now - candidate.queuedAt,
      })
    )
      return false;
    return true;
  });

  return [...eligible].sort((a, b) => {
    // Matching is fair for everyone: game preference first, then the closest
    // trophy gap (unknown gaps sort last), then FIFO. Membership NEVER affects
    // matchmaking (no priority queue).
    const gamePriority = request.preferredGames.indexOf(a.gameKey) - request.preferredGames.indexOf(b.gameKey);
    if (gamePriority !== 0) return gamePriority;
    const trophyGap = (candidate: QuickQueueCandidate) => {
      const mine = trophyForGame(request.trophies, candidate.gameKey);
      const theirs = trophyForGame(candidate.trophies, candidate.gameKey);
      if (mine === null || theirs === null) return Number.POSITIVE_INFINITY;
      return Math.abs(mine - theirs);
    };
    const gapA = trophyGap(a);
    const gapB = trophyGap(b);
    if (gapA !== gapB) return gapA - gapB;
    return a.queuedAt - b.queuedAt;
  })[0] ?? null;
}

export function findCompatibleQuickQueuePair(
  requests: readonly (QuickQueueRequest & { requestId: string; queuedAt: number; row?: Record<string, unknown> })[],
  now = Date.now(),
) {
  for (const source of requests) {
    const candidates = requests.filter((candidate) => candidate.requestId !== source.requestId).flatMap((candidate) =>
      source.preferredGames
        .filter((gameKey) => candidate.preferredGames.includes(gameKey))
        .filter((gameKey) => source.preferredModes.length === 0 || candidate.preferredModes.length === 0 || source.preferredModes.some((mode) => candidate.preferredModes.includes(mode)))
        .filter(() => !source.region || !candidate.region || source.region === candidate.region)
        .filter(() => source.playerCount === candidate.playerCount)
        .filter((gameKey) =>
          trophiesCompatible({
            requester: source.trophies,
            candidate: candidate.trophies,
            gameKey,
            waitMs: now - Math.min(source.queuedAt, candidate.queuedAt),
          }),
        )
        .map((gameKey) => ({
          requestId: candidate.requestId,
          userId: candidate.userId,
          gameKey,
          mode: source.preferredModes.find((mode) => candidate.preferredModes.includes(mode)) ?? candidate.preferredModes[0] ?? source.preferredModes[0] ?? "pvp",
          region: source.region ?? candidate.region,
          playerCount: source.playerCount,
          queuedAt: candidate.queuedAt,
          trophies: candidate.trophies ?? null,
          available: candidate.userId !== source.userId && (source.maxWaitMs === null || now - candidate.queuedAt <= source.maxWaitMs) && (candidate.maxWaitMs === null || now - source.queuedAt <= candidate.maxWaitMs),
        })),
    );
    const candidate = findCompatibleQuickQueueCandidate(source, candidates, now);
    if (candidate?.requestId) return { source, partner: requests.find((request) => request.requestId === candidate.requestId)!, candidate };
  }
  return null;
}
