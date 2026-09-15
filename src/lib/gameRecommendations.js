// src/lib/gameRecommendations.js
//
// GRYND's personalization engine, v1: a DETERMINISTIC, EXPLAINABLE
// scoring/ranking function over the questionnaire answers. There is no
// machine learning anywhere in here — no training, no model, no randomness,
// no network. Given the same answers it always returns the same order, and
// every score can be read back as a list of human-readable reasons.
//
// Full rules + the per-game rationale table: docs/PERSONALIZATION.md
//
// ── INPUT ─────────────────────────────────────────────────────────────────
// Questionnaire answers in the shape stored by /api/onboarding/questionnaire
// (see src/lib/onboardingQuestionnaire.js for the question + option ids):
//
//   { game_types: ["pvp_duels", "strategy"],
//     motivation: ["competition"],
//     experience: "experienced",
//     priorities: ["ranking_up"],
//     discovery: "tiktok" }        ← analytics only, NEVER a ranking input
//
// Anything missing, partial or unknown is tolerated: unknown option values are
// dropped, and no usable ranking preference at all means "not personalized" —
// the caller then gets exactly the lobby's default order.
//
// ── SCORING ───────────────────────────────────────────────────────────────
// Every game starts at 0 and accumulates a weight for each signal it matches.
// Signals come from three of the five questions, plus a light experience
// tie-breaker:
//
//   Q2 game_types  (10 each) — the primary signal. Each option maps to one
//                              game tag, so "Strategy" lifts every strategy
//                              game by the largest single amount.
//   Q1 motivation  ( 4 each) — a supporting signal, one hop away from a tag:
//                              competition→competitive, versus_players→pvp,
//                              fun→casual, rewards→token-wager support.
//                              "variety" (play different games) is a breadth
//                              preference, so it is order-neutral and
//                              deliberately produces NO signal.
//   Q4 priorities  ( 4 each) — the goals signal: winning→skill,
//                              ranking_up→competitive, earning_tokens→token
//                              wager support, improving_skills→skill,
//                              fun→casual.
//   Q3 experience  ( 2)      — intentionally the smallest weight: experience
//                              tunes MESSAGING first (see below) and only
//                              lightly breaks ties in game choice. Beginners
//                              lean casual, experienced players lean
//                              competitive. Experience NEVER hides a game.
//
// Q5 discovery is stored for analytics/marketing and is not read here.
//
// Signals stack: two different answers can reward the same tag, and each one
// adds its own weight and its own reason.
//
// ── ORDERING ──────────────────────────────────────────────────────────────
// Highest score first; TIES BREAK BY THE LOBBY'S FEATURED ORDER (the catalog
// order in src/lib/gameTags.js). That single rule gives us the required
// backwards-compatible fallback for free:
//
//   * no questionnaire / skipped / empty answers → every score is 0 → the
//     ranking IS the default lobby order, and `personalized` is false;
//   * one weak preference → only the games it matches move up, everything
//     else keeps its existing relative order;
//   * a strong preference → that slice of the catalog floats to the top.
//
// NOTHING IS EVER HIDDEN: the engine returns all games, always. Personalization
// reorders, it never filters, locks or shortens the lobby.
//
// ── COMPLETENESS ──────────────────────────────────────────────────────────
// Ranking partial answers is useful (the tests cover it) but it must not drive
// a "For You" surface: half a questionnaire is not a stated preference. So the
// payload also reports whether the answer set is a COMPLETE questionnaire
// submission, using the same required-questions rule the write API enforces.
// The lobby shows the section only for `personalized && complete`.
//
// ── MESSAGING ─────────────────────────────────────────────────────────────
// "Primary game suggestions" are the first PRIMARY_GAME_COUNT ids. The
// follow-up copy is picked from the player's primary goal (Q4, first in
// catalog order) and their experience tier (Q3) as translation keys under
// `onboarding.personalization.*` — never literal English — so the UI can
// localize without knowing anything about scoring.

import { QUESTIONNAIRE_QUESTIONS, getAllowedAnswers } from "./onboardingQuestionnaire";
import { GAME_CATALOG, supportsTokenWager } from "./gameTags";

/** Weights are exported so the rules are testable and documentable rather
 *  than magic numbers buried in a sort comparator. */
export const RECOMMENDATION_WEIGHTS = {
  /** Q2 game_types → one tag each (primary signal). */
  gameType: 10,
  /** Q1 motivation → a supporting signal. */
  motivation: 4,
  /** Q4 priorities → a supporting signal. */
  priority: 4,
  /** Q3 experience → messaging first, a small tie-breaker second. */
  experience: 2,
};

/** How many games count as the "primary" suggestions. */
export const PRIMARY_GAME_COUNT = 3;

/** Q2 answer → game tag. Every option in the questionnaire catalog appears
 *  here (a test enforces it), so no option is silently ignored. */
export const GAME_TYPE_SIGNALS = {
  pvp_duels: "pvp",
  strategy: "strategy",
  fast_paced: "fast_paced",
  casual: "casual",
  luck_chance: "chance",
  competitive: "competitive",
};

/** Q1 answer → supporting signal. `"tokens"` is the pseudo-signal "supports a
 *  configurable token wager" (src/lib/gameTags.js). `variety` is intentionally
 *  absent — see the header. */
export const MOTIVATION_SIGNALS = {
  competition: "competitive",
  rewards: "tokens",
  versus_players: "pvp",
  fun: "casual",
};

/** Q4 answer → supporting signal (same vocabulary as MOTIVATION_SIGNALS). */
export const PRIORITY_SIGNALS = {
  winning: "skill",
  ranking_up: "competitive",
  earning_tokens: "tokens",
  improving_skills: "skill",
  fun: "casual",
};

/** Q3 answer → the tag it lightly favours (null = no game-ranking bias). */
export const EXPERIENCE_SIGNALS = {
  new: "casual",
  casual: null,
  experienced: "competitive",
  highly_competitive: "competitive",
};

const MESSAGE_PREFIX = "onboarding.personalization";

/** Lobby "For You" section chrome (no consumer yet — the engine just owns the
 *  keys so the copy lives in one place). */
export const FOR_YOU_MESSAGE_KEY = `${MESSAGE_PREFIX}.forYou`;
export const FOR_YOU_HINT_MESSAGE_KEY = `${MESSAGE_PREFIX}.forYouHint`;

/** Q4 primary goal → follow-up message. The English copy is fixed by the
 *  product spec; every locale lives in src/lib/appTextTranslations.js. */
export const PRIMARY_GOAL_MESSAGE_KEYS = {
  winning: `${MESSAGE_PREFIX}.goals.winning`,
  ranking_up: `${MESSAGE_PREFIX}.goals.ranking_up`,
  earning_tokens: `${MESSAGE_PREFIX}.goals.earning_tokens`,
  improving_skills: `${MESSAGE_PREFIX}.goals.improving_skills`,
  fun: `${MESSAGE_PREFIX}.goals.fun`,
};

/** Q3 experience → tone of the follow-up message. */
export const EXPERIENCE_MESSAGE_KEYS = {
  new: `${MESSAGE_PREFIX}.experience.new`,
  casual: `${MESSAGE_PREFIX}.experience.casual`,
  experienced: `${MESSAGE_PREFIX}.experience.experienced`,
  highly_competitive: `${MESSAGE_PREFIX}.experience.highly_competitive`,
};

/** The one-line follow-up shown right after the questionnaire (the first
 *  step of the welcome tutorial), picked by `welcomeMessageKey` below. */
export const WELCOME_MESSAGE_KEYS = {
  rewards: `${MESSAGE_PREFIX}.welcome.rewards`,
  competitive: `${MESSAGE_PREFIX}.welcome.competitive`,
  casual: `${MESSAGE_PREFIX}.welcome.casual`,
  beginner: `${MESSAGE_PREFIX}.welcome.beginner`,
};

/** Every key above, for localization checks. */
export const PERSONALIZATION_MESSAGE_KEYS = [
  FOR_YOU_MESSAGE_KEY,
  FOR_YOU_HINT_MESSAGE_KEY,
  ...Object.values(PRIMARY_GOAL_MESSAGE_KEYS),
  ...Object.values(EXPERIENCE_MESSAGE_KEYS),
  ...Object.values(WELCOME_MESSAGE_KEYS),
];

/**
 * Normalize raw questionnaire answers into the four ranking inputs.
 *
 * Everything is validated against the questionnaire catalog: unknown keys are
 * ignored, unknown option values are dropped, and stored values are returned
 * in CATALOG order (so "first priority" is stable no matter what order the
 * player clicked). `discovery` is deliberately not returned — it is analytics
 * data and must never reach the ranking.
 */
export function normalizePreferences(answers) {
  const source = answers && typeof answers === "object" ? answers : {};
  const list = (key) => {
    const raw = source[key];
    const values = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
    // getAllowedAnswers returns the catalog order for this question.
    return getAllowedAnswers(key).filter((value) => values.includes(value));
  };
  const experience = source.experience;
  return {
    game_types: list("game_types"),
    motivation: list("motivation"),
    priorities: list("priorities"),
    experience: getAllowedAnswers("experience").includes(experience) ? experience : null,
  };
}

/** Build the weighted signals for a normalized preference set. */
export function buildSignals(preferences) {
  const signals = [];
  const add = (target, weight, reason) => {
    signals.push(
      target === "tokens"
        ? // "Supports a token wager" — reused from src/lib/defaultWagers.js.
          { reason, weight, matches: (game) => supportsTokenWager(game.id) }
        : { reason, weight, matches: (game) => game.tags.includes(target) }
    );
  };

  for (const value of preferences.game_types) {
    const tag = GAME_TYPE_SIGNALS[value];
    if (tag) add(tag, RECOMMENDATION_WEIGHTS.gameType, `game_type:${value}`);
  }
  for (const value of preferences.motivation) {
    const target = MOTIVATION_SIGNALS[value];
    if (target) add(target, RECOMMENDATION_WEIGHTS.motivation, `motivation:${value}`);
  }
  for (const value of preferences.priorities) {
    const target = PRIORITY_SIGNALS[value];
    if (target) add(target, RECOMMENDATION_WEIGHTS.priority, `priority:${value}`);
  }
  const experienceTarget = EXPERIENCE_SIGNALS[preferences.experience];
  if (experienceTarget) {
    add(
      experienceTarget,
      RECOMMENDATION_WEIGHTS.experience,
      `experience:${preferences.experience}`
    );
  }
  return signals;
}

/**
 * Score + order every game for a preference set. Pure and deterministic.
 *
 * Returns:
 *   { personalized, signals, recommendations: [{ id, href, tags, score, reasons }] }
 *
 * `personalized` is true only when at least one ranking signal was derived —
 * so answers that carry no signal (only `variety`, only `discovery`, or an
 * unknown value) correctly fall back to the default order.
 */
export function rankGamesForPreferences(preferences) {
  const signals = buildSignals(preferences);
  const recommendations = GAME_CATALOG.map((game, index) => {
    const reasons = [];
    let score = 0;
    for (const signal of signals) {
      if (signal.matches(game)) {
        score += signal.weight;
        reasons.push(signal.reason);
      }
    }
    return { id: game.id, href: game.href, tags: [...game.tags], score, reasons, index };
  });

  // Deterministic: score desc, then the lobby's featured order.
  recommendations.sort((a, b) => b.score - a.score || a.index - b.index);

  return {
    personalized: signals.length > 0,
    signals,
    recommendations: recommendations.map(({ index, ...game }) => game),
  };
}

/**
 * Is this a complete questionnaire submission?
 *
 * True only when every question in the catalog has at least one valid answer —
 * the same bar PUT/POST /api/onboarding/questionnaire enforces, and checking
 * it against the raw answers (rather than the normalized preferences) means
 * the analytics-only question still counts toward completeness, exactly as it
 * does at write time.
 */
export function questionnaireCompleteness(answers) {
  const source = answers && typeof answers === "object" ? answers : {};
  const missingQuestionKeys = QUESTIONNAIRE_QUESTIONS.filter((question) => {
    const raw = source[question.key];
    const values = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
    const allowed = question.options.map((option) => option.value);
    return !values.some((value) => allowed.includes(value));
  }).map((question) => question.key);
  return { complete: missingQuestionKeys.length === 0, missingQuestionKeys };
}

/** The follow-up message key for the player's primary goal (Q4, first in
 *  catalog order), or null when they didn't state one. */
export function primaryGoalMessageKey(preferences) {
  const goal = preferences.priorities.find((value) => PRIMARY_GOAL_MESSAGE_KEYS[value]);
  return goal ? PRIMARY_GOAL_MESSAGE_KEYS[goal] : null;
}

/** The experience-tier message key (Q3), or null when they didn't state one. */
export function experienceMessageKey(preferences) {
  return EXPERIENCE_MESSAGE_KEYS[preferences.experience] ?? null;
}

/**
 * The single follow-up line shown immediately after the questionnaire — the
 * first step of the welcome tutorial.
 *
 * Rules (first match wins, all deterministic):
 *   1. tokens/rewards is a stated goal or motivation → the "find games you'll
 *      enjoy" line;
 *   2. experienced / highly competitive → the "into the action" line;
 *   3. casual → a middle line;
 *   4. new → the "comfortable with GRYND" line.
 *
 * Returns null for an incomplete answer set (or none at all), so the welcome
 * hero renders exactly as it always has for everybody else. Deliberately ONE
 * warm line: no name, no stats, nothing that reads as profiling.
 */
export function welcomeMessageKey(answers) {
  if (!questionnaireCompleteness(answers).complete) return null;
  const preferences = normalizePreferences(answers);
  if (
    preferences.priorities.includes("earning_tokens") ||
    preferences.motivation.includes("rewards")
  ) {
    return WELCOME_MESSAGE_KEYS.rewards;
  }
  if (preferences.experience === "experienced" || preferences.experience === "highly_competitive") {
    return WELCOME_MESSAGE_KEYS.competitive;
  }
  if (preferences.experience === "casual") return WELCOME_MESSAGE_KEYS.casual;
  return WELCOME_MESSAGE_KEYS.beginner;
}

/**
 * The engine's public entry point: raw questionnaire answers → a JSON-safe
 * recommendation payload.
 *
 *   {
 *     personalized,            false → this IS the default lobby order
 *     complete,                every question answered (a partial answer set
 *                              still ranks, but must NOT drive a "For You")
 *     source,                  "questionnaire" | "default"
 *     preferences,             the normalized inputs actually used
 *     recommendations,         ALL games, ranked (never filtered)
 *     primaryGameIds,          the first PRIMARY_GAME_COUNT ids
 *     messageKey,              primary-goal copy (or null)
 *     experienceMessageKey,    experience-tier copy (or null)
 *   }
 *
 * Accepts anything (null/undefined/partial/garbage) and always returns a
 * usable, complete payload.
 */
/**
 * Should a UI render a personalized "For You" surface from this payload?
 *
 * The single, tested gate the casino lobby uses — deliberately strict, and
 * false for every failure shape: nothing at all, an error response, no usable
 * answers, a partial answer set, or an empty ranking. Returning false must
 * always mean "behave exactly like the un-personalized lobby".
 *
 * Works on both shapes the caller can hold: the API response (`success: true`
 * added by the route) and the bare engine payload. An explicit
 * `success: false` is always rejected, even if the payload were to carry the
 * other fields.
 */
export function shouldShowPersonalizedSection(payload) {
  return (
    payload?.success !== false &&
    payload?.personalized === true &&
    payload?.complete === true &&
    Array.isArray(payload?.primaryGameIds) &&
    payload.primaryGameIds.length > 0
  );
}

export function recommendGames(answers) {
  const preferences = normalizePreferences(answers);
  const { personalized, recommendations } = rankGamesForPreferences(preferences);
  const { complete } = questionnaireCompleteness(answers);
  return {
    personalized,
    complete,
    source: personalized ? "questionnaire" : "default",
    preferences,
    recommendations,
    primaryGameIds: recommendations.slice(0, PRIMARY_GAME_COUNT).map((game) => game.id),
    messageKey: primaryGoalMessageKey(preferences),
    experienceMessageKey: experienceMessageKey(preferences),
  };
}
