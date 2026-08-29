import { QUICK_QUEUE_GAME_KEYS, type QuickQueueGameKey } from "./quickQueue";

export interface QuickQueueReadinessInput {
  userId: string;
  preferredGames: QuickQueueGameKey[];
  preferredModes: string[];
  region: string | null;
  playerCount: number;
  maxWaitMs: number | null;
  minesStakeAmount: number | null;
  minesCount: number | null;
  expiresAt: Date | null;
}

export function normalizeQuickQueueReadiness(input: unknown): QuickQueueReadinessInput {
  const value = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const userId = String(value.userId ?? "").trim();
  if (!userId) throw new Error("userId is required");

  const preferredGames = Array.isArray(value.preferredGames)
    ? value.preferredGames.filter((game): game is QuickQueueGameKey =>
        typeof game === "string" && (QUICK_QUEUE_GAME_KEYS as readonly string[]).includes(game),
      )
    : [...QUICK_QUEUE_GAME_KEYS];
  const uniqueGames = [...new Set(preferredGames)];
  if (uniqueGames.length === 0) throw new Error("At least one supported game is required");

  const preferredModes = Array.isArray(value.preferredModes)
    ? value.preferredModes
        .filter((mode): mode is string => typeof mode === "string" && mode.trim().length > 0)
        .map((mode) => mode.trim())
    : [];
  const playerCount = Number(value.playerCount ?? 2);
  if (!Number.isInteger(playerCount) || playerCount < 1 || playerCount > 100) {
    throw new Error("playerCount must be an integer from 1 to 100");
  }
  const maxWaitMs = value.maxWaitMs == null ? null : Number(value.maxWaitMs);
  if (maxWaitMs !== null && (!Number.isInteger(maxWaitMs) || maxWaitMs <= 0)) {
    throw new Error("maxWaitMs must be a positive integer");
  }
  const minesStakeAmount = value.minesStakeAmount == null ? null : Number(value.minesStakeAmount);
  if (minesStakeAmount !== null && (!Number.isFinite(minesStakeAmount) || minesStakeAmount < 1)) throw new Error("minesStakeAmount must be at least 1");
  const minesCount = value.minesCount == null ? null : Number(value.minesCount);
  if (minesCount !== null && (!Number.isInteger(minesCount) || minesCount < 1 || minesCount > 24)) throw new Error("minesCount must be an integer from 1 to 24");
  const expiresAt = value.expiresAt == null ? null : new Date(String(value.expiresAt));
  if (expiresAt && Number.isNaN(expiresAt.getTime())) throw new Error("expiresAt must be a valid date");
  if (expiresAt && expiresAt.getTime() <= Date.now()) throw new Error("expiresAt must be in the future");

  return {
    userId,
    preferredGames: uniqueGames,
    preferredModes: [...new Set(preferredModes)],
    region: value.region == null ? null : String(value.region).trim() || null,
    playerCount,
    maxWaitMs,
    minesStakeAmount,
    minesCount,
    expiresAt,
  };
}
