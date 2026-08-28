export const QUICK_QUEUE_GAME_KEYS = [
  "keno-pvp",
  "mines-pvp",
  "plinko-pvp",
  "blackjack-pvp",
  "roulette-pvp",
  "lane-rush-duel",
] as const;

export type QuickQueueGameKey = (typeof QUICK_QUEUE_GAME_KEYS)[number];

export interface QuickQueueRequest {
  userId: string;
  preferredGames: QuickQueueGameKey[];
  preferredModes: string[];
  region: string | null;
  playerCount: number;
  maxWaitMs: number | null;
}

export interface QuickQueueCandidate {
  gameKey: QuickQueueGameKey;
  mode: string;
  region?: string | null;
  playerCount: number;
  queuedAt: number;
  available: boolean;
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
    if (!candidate.available) return false;
    if (!request.preferredGames.includes(candidate.gameKey)) return false;
    if (request.preferredModes.length > 0 && !request.preferredModes.includes(candidate.mode)) return false;
    if (request.region && candidate.region && request.region !== candidate.region) return false;
    if (candidate.playerCount < request.playerCount) return false;
    if (request.maxWaitMs !== null && now - candidate.queuedAt > request.maxWaitMs) return false;
    return true;
  });

  return [...eligible].sort((a, b) => {
    const gamePriority = request.preferredGames.indexOf(a.gameKey) - request.preferredGames.indexOf(b.gameKey);
    if (gamePriority !== 0) return gamePriority;
    return a.queuedAt - b.queuedAt;
  })[0] ?? null;
}
