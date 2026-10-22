export const QUICK_QUEUE_GAME_KEYS = [
  "keno-pvp",
  "mines-pvp",
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
  "mini-golf",
  "speed-typing",
  "tic-tac-toe",
  // Barricade is a lobby-style destination like Tic-Tac-Toe: its `createOrJoin`
  // returns the SAME waiting-lobby id for both paired seats, and it is unstaked,
  // so the queue's normalized stake is never passed to it.
  "barricade",
  // Dominoes is the same shape: its store's `createOrJoin` seats the first
  // caller in a waiting lobby and hands the second caller THAT SAME row, and it
  // is free to play — a Dominoes match has no stake column at all, so the
  // queue's normalized stake is never passed to it.
  "dominoes",
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
   * gameKey → Elo snapshot, loaded server-side at claim time. The second skill
   * signal, used alongside trophies so two players match on BOTH their trophy
   * count and their rating for the chosen game. Optional: absent = no Elo
   * constraint.
   */
  ratings?: Record<string, number> | null;
  /**
   * TRUE when the server has verified this player holds an ACTIVE GRYND PRO
   * subscription. Set ONLY from the authoritative subscription read in
   * quickQueueWorker — never from a request field — and used ONLY to break a
   * near-tie in candidate ORDERING. It never widens a skill window and never
   * overrides a game/mode/region constraint. Absent/false = no priority.
   */
  memberPriority?: boolean;
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
  ratings?: Record<string, number> | null;
  /** Server-verified active GRYND PRO member (see QuickQueueRequest). */
  memberPriority?: boolean;
}

// ── Trophy + Elo matchmaking ───────────────────────────────────────────────
//
// Two independent skill signals decide a quick-queue pair:
//
//   * TROPHIES — the primary visible progression (src/lib/trophies.js), and
//   * ELO      — per-game rating (src/lib/elo.js / src/lib/rating.js).
//
// Trophies are unbounded, so there is no cap at which the queue switches
// signal: BOTH gaps are checked for every pair. Each acceptable gap starts
// small and WIDENS the longer a player waits, so nobody is starved by a thin
// ladder — and a side with no data for a signal simply imposes no constraint
// for it (a brand-new player, or an unplayed game).
//
// MEMBERSHIP (GRYND PRO) touches none of the above. It never widens a window
// and never relaxes a constraint; it only breaks a near-tie in the ORDER of
// already-eligible candidates (see PRO_PRIORITY_SKILL_TOLERANCE and
// findCompatibleQuickQueueCandidate). Skill eligibility is decided purely by
// trophies/Elo, for members and free players alike.

/** Acceptable |trophyA − trophyB| at time zero. */
export const TROPHY_MATCH_INITIAL_WINDOW = 200;

/** How much the acceptable trophy gap grows per second of waiting. */
export const TROPHY_MATCH_WINDOW_GROWTH_PER_SEC = 60;

/**
 * Hard ceiling for the trophy gap. Once this is reached the range spans a very
 * wide trophy band, so even a top and bottom player can eventually be paired
 * rather than waiting forever.
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

/** Acceptable |eloA − eloB| at time zero. */
export const ELO_MATCH_INITIAL_WINDOW = 100;

/** How much the acceptable Elo gap grows per second of waiting. */
export const ELO_MATCH_WINDOW_GROWTH_PER_SEC = 30;

/** Hard ceiling for the Elo gap (spans the whole Elo band eventually). */
export const ELO_MATCH_MAX_WINDOW = 2000;

/** The acceptable Elo gap for someone who has waited `waitMs`. */
export function eloMatchWindow(waitMs: number): number {
  const waited = Math.max(0, Number(waitMs) || 0);
  const grown =
    ELO_MATCH_INITIAL_WINDOW +
    Math.floor(waited / 1000) * ELO_MATCH_WINDOW_GROWTH_PER_SEC;
  return Math.min(ELO_MATCH_MAX_WINDOW, grown);
}

/**
 * How close (in normalised skill units) a Pro candidate's skill score must be to
 * the BEST available match before membership may reorder candidates.
 *
 * 1.0 unit = one initial trophy window (200 trophies) or one initial Elo window
 * (100 points). 0.05 therefore means "within ~10 trophies or ~5 Elo of the
 * closest available opponent". A Pro candidate who is further away than this
 * never jumps ahead of a closer free player, so SKILL REMAINS PRIMARY: a
 * strictly better match always wins, and a Pro member is never paired on a
 * worse match than a free player would have been.
 *
 * The band is deliberately small; combined with the wait-time window widening
 * below (which keeps pulling previously-incompatible players into range as
 * everyone waits) it cannot starve a free player: once the closest candidate is
 * more than the band away, priority stops applying entirely and the free player
 * is matched on skill alone.
 */
export const PRO_PRIORITY_SKILL_TOLERANCE = 0.05;

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
 * One player's Elo rating for a game, or null when unknown/unplayed. Missing
 * data is "no signal" — it never blocks a match. A rating is bounded below by
 * the Elo floor but the raw value is used as-is for a symmetric gap.
 */
export function eloForGame(
  ratings: Record<string, number> | null | undefined,
  gameKey: string,
): number | null {
  if (!ratings) return null;
  const value = Number(ratings[gameKey]);
  if (!Number.isFinite(value)) return null;
  return value;
}

/** The raw |trophy gap| for a game, or null when either side has no trophies. */
export function trophyGapForGame({
  requester,
  candidate,
  gameKey,
}: {
  requester?: Record<string, number> | null;
  candidate?: Record<string, number> | null;
  gameKey: string;
}): number | null {
  const a = trophyForGame(requester, gameKey);
  const b = trophyForGame(candidate, gameKey);
  if (a === null || b === null) return null;
  return Math.abs(a - b);
}

/** The raw |Elo gap| for a game, or null when either side has no rating. */
export function eloGapForGame({
  requesterRatings,
  candidateRatings,
  gameKey,
}: {
  requesterRatings?: Record<string, number> | null;
  candidateRatings?: Record<string, number> | null;
  gameKey: string;
}): number | null {
  const a = eloForGame(requesterRatings, gameKey);
  const b = eloForGame(candidateRatings, gameKey);
  if (a === null || b === null) return null;
  return Math.abs(a - b);
}

/**
 * The pair's combined skill score for one game, used to ORDER eligible partners
 * (closest first). Each available signal is normalised by its own initial
 * window and the two are added, so a 50-trophy gap and a 50-Elo gap are
 * comparable, and neither signal can be ignored. Returns null when NEITHER
 * side has any data (no skill signal at all).
 */
export function skillGapForGame({
  requester,
  candidate,
  requesterRatings,
  candidateRatings,
  gameKey,
}: {
  requester?: Record<string, number> | null;
  candidate?: Record<string, number> | null;
  requesterRatings?: Record<string, number> | null;
  candidateRatings?: Record<string, number> | null;
  gameKey: string;
}): number | null {
  const trophyGap = trophyGapForGame({ requester, candidate, gameKey });
  const eloGap = eloGapForGame({
    requesterRatings,
    candidateRatings,
    gameKey,
  });
  if (trophyGap === null && eloGap === null) return null;
  let score = 0;
  if (trophyGap !== null) {
    score += trophyGap / Math.max(1, TROPHY_MATCH_INITIAL_WINDOW);
  }
  if (eloGap !== null) {
    score += eloGap / Math.max(1, ELO_MATCH_INITIAL_WINDOW);
  }
  return score;
}

/**
 * True when two players are within the acceptable skill window for `gameKey`:
 * EVERY signal both sides have must be inside its own (wait-widening) window.
 * A signal missing on either side imposes no constraint (FIFO fallback), and a
 * pair with no shared signal at all always passes.
 */
export function playersCompatible({
  requester,
  candidate,
  requesterRatings,
  candidateRatings,
  gameKey,
  waitMs,
}: {
  requester?: Record<string, number> | null;
  candidate?: Record<string, number> | null;
  requesterRatings?: Record<string, number> | null;
  candidateRatings?: Record<string, number> | null;
  gameKey: string;
  waitMs: number;
}): boolean {
  const trophyGap = trophyGapForGame({ requester, candidate, gameKey });
  if (trophyGap !== null && trophyGap > trophyMatchWindow(waitMs)) return false;
  const eloGap = eloGapForGame({
    requesterRatings,
    candidateRatings,
    gameKey,
  });
  if (eloGap !== null && eloGap > eloMatchWindow(waitMs)) return false;
  return true;
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
    // Trophy + Elo aware: prefer a close skill gap, widening by how long the
    // candidate has waited. No data on either side = no constraint.
    if (
      !playersCompatible({
        requester: request.trophies,
        candidate: candidate.trophies,
        requesterRatings: request.ratings,
        candidateRatings: candidate.ratings,
        gameKey: candidate.gameKey,
        waitMs: now - candidate.queuedAt,
      })
    )
      return false;
    return true;
  });

  // Skill score per eligible candidate (lower = closer match). Computed once so
  // the priority band and the sort agree on exactly the same numbers.
  const gapFor = (candidate: QuickQueueCandidate) => {
    const gap = skillGapForGame({
      requester: request.trophies,
      candidate: candidate.trophies,
      requesterRatings: request.ratings,
      candidateRatings: candidate.ratings,
      gameKey: candidate.gameKey,
    });
    return gap === null ? Number.POSITIVE_INFINITY : gap;
  };
  const gapByCandidate = new Map<QuickQueueCandidate, number>();
  for (const candidate of eligible) gapByCandidate.set(candidate, gapFor(candidate));
  const bestGap = eligible.reduce(
    (min, candidate) => Math.min(min, gapByCandidate.get(candidate) as number),
    Number.POSITIVE_INFINITY,
  );

  // BOUNDED MEMBERSHIP PRIORITY (candidate ORDERING only).
  //
  // A verified active Pro candidate is preferred over an otherwise EQUIVALENT
  // free candidate — "equivalent" meaning its skill score is within
  // PRO_PRIORITY_SKILL_TOLERANCE of the best match on offer. Outside that band
  // the flag is ignored entirely, so a closer free match always wins, skill
  // stays the primary criterion, and a free player can never be starved by a
  // worse-matched Pro player. Compatibility (game / mode / region / player
  // count / skill window) was already enforced by the filter above: priority
  // cannot buy a match the requester would otherwise be ineligible for.
  const priorityRank = (candidate: QuickQueueCandidate): number => {
    if (!candidate.memberPriority) return 1;
    const gap = gapByCandidate.get(candidate) as number;
    return gap <= bestGap + PRO_PRIORITY_SKILL_TOLERANCE ? 0 : 1;
  };

  return [...eligible].sort((a, b) => {
    // Game preference first, then the bounded Pro tie-break, then the closest
    // combined trophy + Elo gap (unknown gaps sort last), then FIFO.
    // With no eligible Pro candidate every rank is 1, so the ordering reduces
    // EXACTLY to game preference → skill gap → FIFO as it always was.
    const gamePriority = request.preferredGames.indexOf(a.gameKey) - request.preferredGames.indexOf(b.gameKey);
    if (gamePriority !== 0) return gamePriority;
    const rankA = priorityRank(a);
    const rankB = priorityRank(b);
    if (rankA !== rankB) return rankA - rankB;
    const gapA = gapByCandidate.get(a) as number;
    const gapB = gapByCandidate.get(b) as number;
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
          playersCompatible({
            requester: source.trophies,
            candidate: candidate.trophies,
            requesterRatings: source.ratings,
            candidateRatings: candidate.ratings,
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
          ratings: candidate.ratings ?? null,
          // Server-verified, carried straight through — never inferred from the
          // request body — so the bounded priority below is authoritative.
          memberPriority: Boolean(candidate.memberPriority),
          available: candidate.userId !== source.userId && (source.maxWaitMs === null || now - candidate.queuedAt <= source.maxWaitMs) && (candidate.maxWaitMs === null || now - source.queuedAt <= candidate.maxWaitMs),
        })),
    );
    const candidate = findCompatibleQuickQueueCandidate(source, candidates, now);
    if (candidate?.requestId) return { source, partner: requests.find((request) => request.requestId === candidate.requestId)!, candidate };
  }
  return null;
}
