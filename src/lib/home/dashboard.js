// src/lib/home/dashboard.js
//
// PURE HOME-DASHBOARD LOGIC — no database, no I/O, no client state.
//
// Two decisions live here so they can be tested without a route or a browser:
//
//   1. The unified RECENT ACTIVITY list. Ranked duels, completed Solo games and
//      recorded Daily Challenges live in three different tables with three
//      different shapes; this module folds them into one newest-first list. A
//      row is only ever built from fields the server read, so the dashboard
//      cannot show an activity entry that no table contains. An attempt that was
//      not completed — or that has no stored, replayable log — is never given a
//      review link.
//
//   2. The NEXT ACTION recommendation. It is a fixed, explainable precedence
//      over real player state (new account → today's challenge → first ranked
//      match → a recent game to review → the ladder). There is no model, no
//      score and no randomness: the same state always produces the same
//      recommendation, and every card carries the reason it was chosen.
//
//   3. The PRACTICE FOCUS merge. A player whose device-local practice record
//      shows a weak skill gets one short drill instead of "play another ranked
//      game". Practice data never leaves the browser, so the server cannot see
//      it; the dashboard component passes the already-computed focus through
//      `mergePracticeFocus`. Account-level first steps (the Academy, today's
//      challenge, a first ranked match) keep their priority.
//
// The route in src/app/api/home/dashboard/route.ts is the only caller of
// `selectNextAction`; `buildRecentActivity` is used there and nowhere else.
// Keeping it all pure is what makes the recommendation auditable.

/** How many activity rows the dashboard shows. */
export const DASHBOARD_ACTIVITY_LIMIT = 8;

/** A completed game older than this is not offered as "review your last game". */
export const REVIEW_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Coerce a timestamp (ms or parseable date) into epoch ms, or null. */
export function instantMs(value) {
  if (value === null || value === undefined || value === "") return null;
  const ms = value instanceof Date ? value.getTime() : Number(value);
  if (Number.isFinite(ms)) return ms;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

/** A finite, positive duration, or null. */
function positiveMs(value) {
  const ms = Number(value);
  return Number.isFinite(ms) && ms > 0 ? Math.round(ms) : null;
}

/** A finite, non-negative count, or 0. */
function countOf(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

function isRankedOutcome(outcome) {
  return outcome === "win" || outcome === "loss" || outcome === "draw";
}

function soloEntry(row) {
  const id = row?.id === null || row?.id === undefined ? "" : String(row.id);
  if (!id || row?.completed !== true) return null;
  const reviewable = Boolean(row?.reviewable);
  return {
    key: `solo:${id}`,
    kind: "solo",
    at: instantMs(row?.createdAtMs ?? row?.completedAtMs) ?? 0,
    outcome: "completed",
    status: null,
    competitive: false,
    isPractice: false,
    reviewable,
    moves: countOf(row?.moves),
    elapsedMs: positiveMs(row?.elapsedMs),
    dateKey: null,
    // Only a completed game WITH a stored log has a review to open.
    href: reviewable
      ? `/solitaire/review/solo/${encodeURIComponent(id)}`
      : "/solitaire",
    actionLabel: reviewable ? "Review" : "Play solo",
  };
}

function dailyEntry(row) {
  const id = row?.id === null || row?.id === undefined ? "" : String(row.id);
  if (!id || row?.completed !== true) return null;
  const reviewable = Boolean(row?.reviewable);
  const dateKey = typeof row?.dateKey === "string" ? row.dateKey : null;
  return {
    key: `daily:${id}`,
    kind: "daily",
    at: instantMs(row?.createdAtMs ?? row?.completedAtMs) ?? 0,
    outcome: "completed",
    status: null,
    competitive: false,
    isPractice: false,
    reviewable,
    moves: countOf(row?.moves),
    elapsedMs: positiveMs(row?.elapsedMs),
    dateKey,
    href: reviewable
      ? `/solitaire/review/daily/${encodeURIComponent(id)}`
      : "/daily",
    actionLabel: reviewable ? "Review" : "Play daily",
  };
}

function rankedEntry(row) {
  const matchId =
    row?.matchId === null || row?.matchId === undefined ? "" : String(row.matchId);
  if (!matchId) return null;
  const outcome = isRankedOutcome(row?.outcome) ? row.outcome : null;
  const finished = outcome !== null;
  const isPractice = row?.isAi === true;
  return {
    key: `ranked:${matchId}`,
    kind: "ranked",
    at: instantMs(row?.endedAtMs ?? row?.createdAtMs) ?? 0,
    outcome,
    status: typeof row?.status === "string" ? row.status : null,
    // Practice against the bot is an unrated game, never a ranked result.
    competitive: !isPractice,
    isPractice,
    reviewable: finished,
    moves: null,
    elapsedMs: null,
    dateKey: null,
    // A finished match opens its saved review; an unfinished one reopens the
    // match so the player can see whether it is still live.
    href: finished
      ? `/solitaire/review/duel/${encodeURIComponent(matchId)}`
      : `/casino/solitaire-duel/${encodeURIComponent(matchId)}`,
    actionLabel: finished ? "Review" : "Open",
  };
}

/**
 * Fold the three activity sources into one newest-first list.
 *
 * Every entry is built from the row it came from; nothing is padded, sampled
 * or invented. Rows without a usable id or timestamp still appear (at the end)
 * rather than disappearing, so a real game is never hidden.
 *
 * @param {{ ranked?: object[], solo?: object[], daily?: object[] }} sources
 * @param {{ limit?: number }} [options]
 */
export function buildRecentActivity(
  { ranked = [], solo = [], daily = [] } = {},
  { limit = DASHBOARD_ACTIVITY_LIMIT } = {},
) {
  const cap = Math.max(1, Math.trunc(Number(limit)) || DASHBOARD_ACTIVITY_LIMIT);
  const entries = [
    ...(Array.isArray(ranked) ? ranked.map(rankedEntry) : []),
    ...(Array.isArray(solo) ? solo.map(soloEntry) : []),
    ...(Array.isArray(daily) ? daily.map(dailyEntry) : []),
  ].filter(Boolean);

  return entries
    .sort((a, b) => b.at - a.at || a.key.localeCompare(b.key))
    .slice(0, cap);
}

/** The fastest completed solve across Solo and the Daily Challenge, or null. */
export function fastestSolveMs(solo, daily) {
  const values = [solo?.bestMs, daily?.bestMs]
    .map((value) => positiveMs(value))
    .filter((value) => value !== null);
  return values.length > 0 ? Math.min(...values) : null;
}

/**
 * A brand-new account: no ranked match, no recorded Solo game, no completed
 * Daily Challenge and no streak day. All four are real server reads; a player
 * who has done any one of them is not new.
 */
export function isNewPlayer({
  rankedGames = 0,
  soloGames = 0,
  dailyCompleted = 0,
  streakCurrent = 0,
} = {}) {
  return (
    countOf(rankedGames) === 0 &&
    countOf(soloGames) === 0 &&
    countOf(dailyCompleted) === 0 &&
    countOf(streakCurrent) === 0
  );
}

/**
 * Pick the single next action, in a fixed order. The returned object is both
 * the card's content and its explanation (`reason`).
 *
 * Order:
 *   1. Brand-new account          → an Academy lesson
 *   2. Today's challenge unplayed → the Daily Challenge
 *   3. No ranked match yet        → the ranked ladder
 *   4. A recent game to review    → that game's review
 *   5. Otherwise                  → the ranked ladder
 *
 * The review branch only accepts a game inside REVIEW_WINDOW_MS, so an old
 * result is not presented as "your last game".
 */
export function selectNextAction({
  newPlayer = false,
  dailyCompletedToday = true,
  rankedGames = 0,
  recentReview = null,
  nowMs = Date.now(),
  reviewWindowMs = REVIEW_WINDOW_MS,
} = {}) {
  if (newPlayer) {
    return {
      id: "academy",
      title: "Start with one Academy lesson",
      body: "A short lesson covers the patterns that decide most Solitaire games, then you can take a real deal.",
      ctaLabel: "Open the Academy",
      href: "/learn",
      reason: "You haven't played a game yet, so a lesson is the fastest way in.",
    };
  }

  if (!dailyCompletedToday) {
    return {
      id: "daily",
      title: "Play today's Daily Challenge",
      body: "One deal, fixed for every player by the UTC date. Finishing it keeps your daily streak alive.",
      ctaLabel: "Play today's deal",
      href: "/daily",
      reason: "Today's Daily Challenge isn't recorded yet.",
    };
  }

  const games = countOf(rankedGames);
  if (games === 0) {
    return {
      id: "first-ranked",
      title: "Play your first ranked match",
      body: "Ranked is free and both seats get the same deal. A win or loss only moves your rating and trophies.",
      ctaLabel: "Play ranked",
      href: "/play/ranked",
      reason: "You haven't played a ranked match yet.",
    };
  }

  const reviewAt = instantMs(recentReview?.at);
  const withinWindow =
    reviewAt !== null && Math.abs(nowMs - reviewAt) <= Math.max(0, reviewWindowMs);
  if (recentReview?.href && withinWindow) {
    const kind = recentReview.kind;
    const title =
      kind === "daily"
        ? "Review your last Daily Challenge"
        : kind === "solo"
          ? "Review your last Solo game"
          : "Review your last ranked game";
    const body =
      kind === "ranked"
        ? "The exact deal and every move are saved. See where the match turned and what to do differently."
        : "The exact deal and every move are saved. Replay the board and find the faster line.";
    return {
      id: "review",
      title,
      body,
      ctaLabel: "Open the review",
      href: String(recentReview.href),
      reason: "Your latest completed game is still fresh enough to review.",
    };
  }

  return {
    id: "ranked",
    title: "Back to the ranked ladder",
    body: "Today's challenge is done. Put your rating on the line against a live opponent — or keep it light with Solo.",
    ctaLabel: "Play ranked",
    href: "/play/ranked",
    reason: "You're caught up, so the ladder is the next useful step.",
  };
}

/**
 * Recommendation ids a measured practice weakness may replace.
 *
 * Onboarding and habit steps stay first: a brand-new player still gets the
 * Academy, today's unrecorded challenge still comes before everything, and a
 * player with no ranked result still gets their first ranked match. Once those
 * are answered, a recorded weakness is more useful than another ladder game or
 * a second look at a game already reviewed.
 */
const PRACTICE_OVERRIDABLE = new Set(["review", "ranked"]);

/**
 * Replace a generic next step with one targeted drill, or keep the original.
 *
 * `practiceFocus` is the output of `weakestPracticeFocus` (device-local, never
 * sent to the server). Its `detail` already names the recorded fact that got
 * the skill flagged, so this function only wraps it in the card — it never
 * re-derives a rate or calls a perfect record "weak".
 */
export function mergePracticeFocus(recommendation, practiceFocus) {
  if (!recommendation || !practiceFocus) return recommendation;
  if (!PRACTICE_OVERRIDABLE.has(recommendation.id)) return recommendation;

  const label =
    typeof practiceFocus.label === "string" ? practiceFocus.label.trim() : "";
  const detail =
    typeof practiceFocus.detail === "string" ? practiceFocus.detail.trim() : "";
  const href = typeof practiceFocus.href === "string" ? practiceFocus.href : "";

  if (!label || !detail || !href.startsWith("/learn/practice?")) {
    return recommendation;
  }

  return {
    id: "practice",
    title: `Practise ${label}`,
    body: `${label} is flagged in your practice record: ${detail}. One short drill targets that decision, and practice never changes your ranked rating.`,
    ctaLabel: "Open the practice drill",
    href,
    reason:
      "This flag comes from your own recorded attempts on this device, not from a ranked result.",
  };
}
