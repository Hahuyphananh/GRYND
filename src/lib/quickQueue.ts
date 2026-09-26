import { TROPHY_MAX } from "./trophies";

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
  /**
   * gameKey → Elo snapshot, loaded server-side at claim time. Used ONLY above
   * the trophy cap (where trophies are identical and Prestige separates
   * players). Optional: absent = the trophy gap (or FIFO) decides.
   */
  prestige?: Record<string, number> | null;
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
  /** gameKey → Elo snapshot, when the caller supplied one. */
  prestige?: Record<string, number> | null;
}

// ── Trophy + prestige matchmaking ─────────────────────────────────────────
//
// Trophies are the skill signal BELOW the cap (see src/lib/trophies.js), so a
// quick-queue pair is preferred when the two players' trophies for the chosen
// game are close. Once BOTH players have capped the game their trophies are
// identical, so the queue switches to that game's PRESTIGE (Elo) gap instead.
// The acceptable gap starts small and WIDENS the longer a player waits, so
// nobody is starved by a thin ladder — and it collapses back to plain FIFO
// whenever either side has no data (a brand-new player, or an unplayed game).
// Membership never influences any of this.

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

// ── Prestige-aware matchmaking (at/above the trophy cap) ──────────────────
//
// Once BOTH players have capped a game (trophies === TROPHY_MAX) their trophy
// counts are identical, so a trophy gap of 0 would pair them at random. Above
// the cap the queue therefore switches to that game's PRESTIGE — the player's
// Elo, revealed at the cap (see src/lib/prestige.js) — using the same
// widening-window idea scaled to Elo.

/** Acceptable |prestigeA − prestigeB| at time zero. */
export const PRESTIGE_MATCH_INITIAL_WINDOW = 100;

/** How much the acceptable prestige gap grows per second of waiting. */
export const PRESTIGE_MATCH_WINDOW_GROWTH_PER_SEC = 30;

/** Hard ceiling for the prestige gap (spans the whole Elo band eventually). */
export const PRESTIGE_MATCH_MAX_WINDOW = 2000;

/** The acceptable prestige gap for someone who has waited `waitMs`. */
export function prestigeMatchWindow(waitMs: number): number {
  const waited = Math.max(0, Number(waitMs) || 0);
  const grown =
    PRESTIGE_MATCH_INITIAL_WINDOW +
    Math.floor(waited / 1000) * PRESTIGE_MATCH_WINDOW_GROWTH_PER_SEC;
  return Math.min(PRESTIGE_MATCH_MAX_WINDOW, grown);
}

/**
 * One player's prestige (Elo) for a game, or null when unknown/unplayed.
 * Missing prestige is "no signal" — it never blocks a match.
 */
export function prestigeForGame(
  prestige: Record<string, number> | null | undefined,
  gameKey: string,
): number | null {
  if (!prestige) return null;
  const value = Number(prestige[gameKey]);
  if (!Number.isFinite(value)) return null;
  return value;
}

/** True when a player has reached the trophy cap for a game (prestige unlocked). */
export function trophiesAtCap(
  trophies: Record<string, number> | null | undefined,
  gameKey: string,
): boolean {
  const value = trophyForGame(trophies, gameKey);
  return value !== null && value >= TROPHY_MAX;
}

/**
 * The pair's skill gap for one game, or null when there is no signal:
 *   * BOTH capped  → |prestige gap| (Elo),
 *   * otherwise    → |trophy gap|.
 */
export function skillGapForGame({
  requester,
  candidate,
  requesterPrestige,
  candidatePrestige,
  gameKey,
}: {
  requester?: Record<string, number> | null;
  candidate?: Record<string, number> | null;
  requesterPrestige?: Record<string, number> | null;
  candidatePrestige?: Record<string, number> | null;
  gameKey: string;
}): number | null {
  if (trophiesAtCap(requester, gameKey) && trophiesAtCap(candidate, gameKey)) {
    const a = prestigeForGame(requesterPrestige, gameKey);
    const b = prestigeForGame(candidatePrestige, gameKey);
    if (a === null || b === null) return null;
    return Math.abs(a - b);
  }
  const a = trophyForGame(requester, gameKey);
  const b = trophyForGame(candidate, gameKey);
  if (a === null || b === null) return null;
  return Math.abs(a - b);
}

/**
 * True when two players are within the acceptable skill window for `gameKey`:
 * prestige when BOTH are capped, trophies otherwise. Missing data on either
 * side always passes (FIFO fallback).
 */
export function trophiesCompatible({
  requester,
  candidate,
  requesterPrestige,
  candidatePrestige,
  gameKey,
  waitMs,
}: {
  requester?: Record<string, number> | null;
  candidate?: Record<string, number> | null;
  requesterPrestige?: Record<string, number> | null;
  candidatePrestige?: Record<string, number> | null;
  gameKey: string;
  waitMs: number;
}): boolean {
  const gap = skillGapForGame({
    requester,
    candidate,
    requesterPrestige,
    candidatePrestige,
    gameKey,
  });
  if (gap === null) return true;
  const bothCapped =
    trophiesAtCap(requester, gameKey) && trophiesAtCap(candidate, gameKey);
  return (
    gap <= (bothCapped ? prestigeMatchWindow(waitMs) : trophyMatchWindow(waitMs))
  );
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
        requesterPrestige: request.prestige,
        candidatePrestige: candidate.prestige,
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
    const gapFor = (candidate: QuickQueueCandidate) => {
      const gap = skillGapForGame({
        requester: request.trophies,
        candidate: candidate.trophies,
        requesterPrestige: request.prestige,
        candidatePrestige: candidate.prestige,
        gameKey: candidate.gameKey,
      });
      return gap === null ? Number.POSITIVE_INFINITY : gap;
    };
    const gapA = gapFor(a);
    const gapB = gapFor(b);
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
            requesterPrestige: source.prestige,
            candidatePrestige: candidate.prestige,
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
          prestige: candidate.prestige ?? null,
          available: candidate.userId !== source.userId && (source.maxWaitMs === null || now - candidate.queuedAt <= source.maxWaitMs) && (candidate.maxWaitMs === null || now - source.queuedAt <= candidate.maxWaitMs),
        })),
    );
    const candidate = findCompatibleQuickQueueCandidate(source, candidates, now);
    if (candidate?.requestId) return { source, partner: requests.find((request) => request.requestId === candidate.requestId)!, candidate };
  }
  return null;
}
