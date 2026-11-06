// src/lib/guest/practiceProgress.ts
//
// GUEST PROGRESSION (Phase 2B–2E) — the ONLY writer of `guest_practice_results`
// and the read model behind GET /api/guest/progress.
//
// ── WHO MAY WRITE ─────────────────────────────────────────────────────────
//
// Only a guest identity that came out of the HMAC-verified session
// (src/lib/auth/guestSession.ts) AND the server's own settlement outcome. This
// module never reads a request: a caller hands it the guest id it already
// resolved from the cookie, and the result it already computed inside the
// match transaction. `isGuestId` + `normalizeGuestPracticeResult` reject
// anything else, so a Clerk id, a bot sentinel, a client-supplied string or a
// malformed id writes nothing at all.
//
// ── WHY IT CANNOT BREAK A MATCH ───────────────────────────────────────────
//
// `recordGuestPracticeResultSafely` never throws and never aborts the caller's
// transaction: it runs the write in a SAVEPOINT when the driver's transaction
// object supports one, so a failing insert rolls back only the guest rows and
// leaves the already-finalised match (and its registered-user settlement)
// intact. A driver without savepoints still gets a try/catch, and the write is
// the last statement in the AI settlement branch. A dropped practice row is a
// missing cosmetic record, never a stuck or double-settled game.
//
// ── WHAT IT IS NOT ────────────────────────────────────────────────────────
//
// Not a second statistics system. There are no counters here: wins/losses/
// draws are COUNT(*) over result rows, so a retry cannot distort a total. No
// Elo, trophy, token, quest, daily-reward or leaderboard code is imported or
// called — a guest result is a private practice record and nothing else.

import { desc, eq, sql } from "drizzle-orm";

import { db } from "../../db/client";
import { guestPracticeResults, guestProfiles } from "../../db/schema";
import { isGuestId } from "../guestIdentity";

/**
 * Games whose guest practice results may be persisted.
 *
 * Deliberately a closed list: a settlement for a game that has not been
 * designed and tested for guest progression must be a no-op rather than write
 * an unexpected row. "tic-tac-toe" is the Phase 2B pilot, "dominoes" joined it
 * in Phase 2C, "battleship" in Phase 2D and "odds" in Phase 2E; each is a
 * canonical key from the same `RATED_GAMES` vocabulary its store settles with.
 */
/**
 * Tic-Tac-Toe's canonical key — the pilot's, kept under its original name so
 * the pilot's settlement import is unchanged. Exported as ONE constant so the
 * writer cannot misspell it, and pinned to the same literal `RATED_GAMES` uses
 * in src/lib/rating.js.
 */
export const GUEST_PRACTICE_GAME_KEY = "tic-tac-toe" as const;

/**
 * Dominoes' canonical key (Phase 2C) — the same literal the Dominoes store
 * settles rated matches with.
 */
export const GUEST_PRACTICE_DOMINOES_GAME_KEY = "dominoes" as const;

/**
 * Battleship's canonical key (Phase 2D) — the same literal its store records a
 * practice win/loss/draw under. A guest battles the bot; nothing here is rated.
 */
export const GUEST_PRACTICE_BATTLESHIP_GAME_KEY = "battleship" as const;

/**
 * Odds' canonical key (Phase 2E) — the AI duel whose rounds the server resolves
 * from its own stored state (`/api/odds/ai/pick`), so the recorded verdict is
 * never a client claim.
 */
export const GUEST_PRACTICE_ODDS_GAME_KEY = "odds" as const;

export const GUEST_PRACTICE_GAME_KEYS = [
  GUEST_PRACTICE_GAME_KEY,
  GUEST_PRACTICE_DOMINOES_GAME_KEY,
  GUEST_PRACTICE_BATTLESHIP_GAME_KEY,
  GUEST_PRACTICE_ODDS_GAME_KEY,
] as const;

export type GuestPracticeGameKey = (typeof GUEST_PRACTICE_GAME_KEYS)[number];

/** The vocabulary stored in `guest_practice_results.result`. */
export const GUEST_PRACTICE_OUTCOMES = ["win", "loss", "draw"] as const;

export type GuestPracticeOutcome = (typeof GUEST_PRACTICE_OUTCOMES)[number];

/** Longest accepted match id — `match_id` is varchar(64). */
const MATCH_ID_MAX_LENGTH = 64;

/** Longest accepted difficulty token — `ai_difficulty` is varchar(16). */
const AI_DIFFICULTY_MAX_LENGTH = 16;

export const DEFAULT_HISTORY_LIMIT = 20;
export const MAX_HISTORY_LIMIT = 50;

export type GuestPracticeResultInput = {
  guestId: unknown;
  gameKey: unknown;
  matchId: unknown;
  result: unknown;
  aiDifficulty?: unknown;
};

export type NormalizedGuestPracticeResult = {
  guestId: string;
  gameKey: GuestPracticeGameKey;
  matchId: string;
  result: GuestPracticeOutcome;
  aiDifficulty: string | null;
};

export function isGuestPracticeGameKey(value: unknown): value is GuestPracticeGameKey {
  return (
    typeof value === "string" &&
    (GUEST_PRACTICE_GAME_KEYS as readonly string[]).includes(value)
  );
}

export function isGuestPracticeOutcome(value: unknown): value is GuestPracticeOutcome {
  return (
    typeof value === "string" &&
    (GUEST_PRACTICE_OUTCOMES as readonly string[]).includes(value)
  );
}

/**
 * Validate everything a settlement may hand us. Returns null — never throws —
 * so a caller cannot accidentally persist a half-valid row.
 */
export function normalizeGuestPracticeResult(
  input: GuestPracticeResultInput | null | undefined,
): NormalizedGuestPracticeResult | null {
  if (!input || typeof input !== "object") return null;

  // The identity is the cookie's signed guest id, nothing else. A Clerk id, a
  // bot sentinel or a client-supplied string all fail here.
  if (!isGuestId(input.guestId)) return null;
  if (!isGuestPracticeGameKey(input.gameKey)) return null;
  if (!isGuestPracticeOutcome(input.result)) return null;

  const matchId = typeof input.matchId === "string" ? input.matchId.trim() : "";
  if (!matchId || matchId.length > MATCH_ID_MAX_LENGTH) return null;

  const rawDifficulty =
    typeof input.aiDifficulty === "string" ? input.aiDifficulty.trim().toLowerCase() : "";
  const aiDifficulty =
    rawDifficulty &&
    rawDifficulty.length <= AI_DIFFICULTY_MAX_LENGTH &&
    /^[a-z]+$/.test(rawDifficulty)
      ? rawDifficulty
      : null;

  return {
    guestId: input.guestId,
    gameKey: input.gameKey,
    matchId,
    result: input.result,
    aiDifficulty,
  };
}

/**
 * Write one normalised result inside `tx`.
 *
 * `ON CONFLICT` does the work in both statements:
 *   · the profile upsert creates the row on the guest's FIRST finished match
 *     and refreshes `last_seen_at` afterwards — this is the only creation path;
 *   · the result insert is a no-op when (game_key, match_id) already exists, so
 *     a retried settlement cannot duplicate it.
 *
 * Throws on a database error so `recordGuestPracticeResultSafely` can contain
 * it; callers inside a settlement must use the safe wrapper.
 */
async function writeGuestPracticeResult(
  tx: any,
  row: NormalizedGuestPracticeResult,
): Promise<void> {
  const now = new Date();

  await tx
    .insert(guestProfiles)
    .values({ guestId: row.guestId, createdAt: now, lastSeenAt: now })
    .onConflictDoUpdate({
      target: guestProfiles.guestId,
      set: { lastSeenAt: now },
    });

  await tx
    .insert(guestPracticeResults)
    .values({
      guestId: row.guestId,
      gameKey: row.gameKey,
      matchId: row.matchId,
      result: row.result,
      aiDifficulty: row.aiDifficulty,
      createdAt: now,
    })
    .onConflictDoNothing({
      target: [guestPracticeResults.gameKey, guestPracticeResults.matchId],
    });
}

/**
 * Validate + write, surfacing a database error (tests and non-settlement
 * callers). Returns false when the input is not an authoritative guest result.
 */
export async function recordGuestPracticeResult(
  tx: any,
  input: GuestPracticeResultInput,
): Promise<boolean> {
  const row = normalizeGuestPracticeResult(input);
  if (!row) return false;
  await writeGuestPracticeResult(tx, row);
  return true;
}

/**
 * Settlement-safe writer: NEVER throws, NEVER aborts the caller's transaction.
 *
 * The write runs inside a SAVEPOINT when `tx.transaction` exists (Drizzle's
 * node-postgres transaction provides one), so a failure rolls back only the
 * guest rows — the match row has already been finalised and its result stands.
 * A driver without savepoints still gets a try/catch; either way a guest
 * progression hiccup is logged and the game completes normally.
 */
export async function recordGuestPracticeResultSafely(
  tx: any,
  input: GuestPracticeResultInput,
): Promise<boolean> {
  const row = normalizeGuestPracticeResult(input);
  if (!row) return false;

  try {
    if (typeof tx?.transaction === "function") {
      await tx.transaction((savepoint: any) => writeGuestPracticeResult(savepoint, row));
    } else {
      await writeGuestPracticeResult(tx, row);
    }
    return true;
  } catch (error) {
    console.error(
      "[guest-progress] practice result was not recorded; the match result stands",
      error instanceof Error ? error.message : error,
    );
    return false;
  }
}

// ── Read model ─────────────────────────────────────────────────────────────

export type GuestProgressGameStats = {
  gameKey: string;
  matches: number;
  wins: number;
  losses: number;
  draws: number;
};

export type GuestProgressHistoryEntry = {
  gameKey: string;
  result: GuestPracticeOutcome;
  aiDifficulty: string | null;
  playedAt: string;
};

export type GuestProgress = {
  profile: { createdAt: string | null; lastSeenAt: string | null };
  totals: { matches: number; wins: number; losses: number; draws: number };
  games: GuestProgressGameStats[];
  history: GuestProgressHistoryEntry[];
};

export function emptyGuestProgress(): GuestProgress {
  return {
    profile: { createdAt: null, lastSeenAt: null },
    totals: { matches: 0, wins: 0, losses: 0, draws: 0 },
    games: [],
    history: [],
  };
}

function toIsoString(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return null;
}

/**
 * Pure aggregation: counts per game and overall, with games ordered by key so
 * two reads of the same data are byte-identical.
 */
export function summarizeGuestProgress(
  rows: Array<{ gameKey: string; result: string }>,
): { totals: GuestProgress["totals"]; games: GuestProgressGameStats[] } {
  const perGame = new Map<string, GuestProgressGameStats>();
  const totals = { matches: 0, wins: 0, losses: 0, draws: 0 };

  for (const row of rows) {
    if (!isGuestPracticeOutcome(row.result)) continue;
    const key = String(row.gameKey);
    const entry =
      perGame.get(key) ?? { gameKey: key, matches: 0, wins: 0, losses: 0, draws: 0 };

    entry.matches += 1;
    totals.matches += 1;
    if (row.result === "win") {
      entry.wins += 1;
      totals.wins += 1;
    } else if (row.result === "loss") {
      entry.losses += 1;
      totals.losses += 1;
    } else {
      entry.draws += 1;
      totals.draws += 1;
    }

    perGame.set(key, entry);
  }

  return {
    totals,
    games: [...perGame.values()].sort((a, b) => a.gameKey.localeCompare(b.gameKey)),
  };
}

/**
 * The authenticated guest's own progression.
 *
 * Every query is filtered by the guest id the caller resolved from the cookie;
 * there is no parameter through which another guest's rows could be requested.
 * Internal columns (`id`, `match_id`) are deliberately not selected.
 */
export async function loadGuestProgress(
  guestId: string,
  { limit = DEFAULT_HISTORY_LIMIT }: { limit?: number } = {},
): Promise<GuestProgress> {
  if (!isGuestId(guestId)) return emptyGuestProgress();

  const historyLimit = Number.isFinite(limit)
    ? Math.min(Math.max(Math.trunc(limit), 1), MAX_HISTORY_LIMIT)
    : DEFAULT_HISTORY_LIMIT;

  const [profile] = await db
    .select({
      createdAt: guestProfiles.createdAt,
      lastSeenAt: guestProfiles.lastSeenAt,
    })
    .from(guestProfiles)
    .where(eq(guestProfiles.guestId, guestId))
    .limit(1);

  const counts = await db
    .select({
      gameKey: guestPracticeResults.gameKey,
      result: guestPracticeResults.result,
      count: sql<number>`count(*)::int`,
    })
    .from(guestPracticeResults)
    .where(eq(guestPracticeResults.guestId, guestId))
    .groupBy(guestPracticeResults.gameKey, guestPracticeResults.result);

  const historyRows = await db
    .select({
      gameKey: guestPracticeResults.gameKey,
      result: guestPracticeResults.result,
      aiDifficulty: guestPracticeResults.aiDifficulty,
      playedAt: guestPracticeResults.createdAt,
    })
    .from(guestPracticeResults)
    .where(eq(guestPracticeResults.guestId, guestId))
    // Newest first, with `id` as the tie-break so identical timestamps still
    // produce one deterministic order on every request.
    .orderBy(desc(guestPracticeResults.createdAt), desc(guestPracticeResults.id))
    .limit(historyLimit);

  const { totals, games } = summarizeGuestProgress(
    counts.flatMap((row) =>
      Array.from({ length: Math.max(0, Number(row.count) || 0) }, () => ({
        gameKey: String(row.gameKey),
        result: String(row.result),
      })),
    ),
  );

  return {
    profile: {
      createdAt: toIsoString(profile?.createdAt),
      lastSeenAt: toIsoString(profile?.lastSeenAt),
    },
    totals,
    games,
    history: historyRows.map((row) => ({
      gameKey: String(row.gameKey),
      // Only win/loss/draw rows are writable (CHECK constraint + writer), so a
      // stray value can never reach the response as a fabricated outcome.
      result: isGuestPracticeOutcome(row.result) ? row.result : "draw",
      aiDifficulty: row.aiDifficulty ? String(row.aiDifficulty) : null,
      playedAt: toIsoString(row.playedAt) ?? "",
    })),
  };
}
