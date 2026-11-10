// src/lib/solitairePersonalization.js
//
// GRYND has ONE primary game, so "which game is recommended" is no longer a
// meaningful question. This module turns the Solitaire questionnaire into the
// two things onboarding can actually use:
//
//   1. WHICH SOLITAIRE MODE to put first (solo / daily / bots / ranked).
//   2. WHICH tutorial line to show (beginner vs experienced framing).
//
// It deliberately does NOT produce a ranking of games, does not read
// `src/lib/gameRecommendations.js` (the legacy multi-game engine, still used by
// the lobby's For You strip), and never touches Elo, trophies, matchmaking or
// bot difficulty. A questionnaire answer is a preference, not a skill rating.
//
// Pure and dependency-free so it can be unit tested and reused by the client.

/** Stable ids for the four Solitaire modes. */
export const SOLITAIRE_MODES = Object.freeze([
  "solo_practice",
  "daily_challenge",
  "play_vs_bots",
  "ranked_pvp",
]);

/** Real routes, taken from the game's own constants at the call site. Keeping
 *  the mode → route decision here means onboarding cannot link to an archived
 *  game or an old route. */
export const MODE_ROUTES = Object.freeze({
  solo_practice: "/casino/solitaire-duel",
  daily_challenge: "/casino/solitaire-duel",
  play_vs_bots: "/casino/solitaire-duel/play-ai",
  ranked_pvp: "/casino/solitaire-duel",
});

/** English fallback labels; the UI renders translated copy from
 *  appTextTranslations through `modeLabelKey`. */
export const MODE_LABEL_KEYS = Object.freeze({
  solo_practice: "onboarding.solitaire.modes.solo_practice.title",
  daily_challenge: "onboarding.solitaire.modes.daily_challenge.title",
  play_vs_bots: "onboarding.solitaire.modes.play_vs_bots.title",
  ranked_pvp: "onboarding.solitaire.modes.ranked_pvp.title",
});

const asArray = (value) => (Array.isArray(value) ? value.filter(Boolean) : []);
const one = (value) => (Array.isArray(value) ? value[0] : value);

/**
 * The mode onboarding should put first for this player.
 *
 * Order of precedence:
 *   1. An explicitly selected mode (first selected, catalog order) — the
 *      player said what they want.
 *   2. Ranked interest + experience → Ranked PvP.
 *   3. "Learn the game" or a complete beginner → Solo practice (the tutorial
 *      is the on-ramp; ranked is explained, never pushed).
 *   4. Otherwise Solo practice.
 *
 * `null`/partial answers simply fall through to Solo.
 */
export function recommendedMode(answers) {
  const selected = asArray(answers?.solitaire_modes).filter((mode) =>
    SOLITAIRE_MODES.includes(mode),
  );
  if (selected.length > 0) {
    return SOLITAIRE_MODES.find((mode) => mode === selected[0]) ?? "solo_practice";
  }

  const experience = one(answers?.solitaire_experience);
  const goal = one(answers?.solitaire_goal);

  if (
    goal === "climb_leaderboard" ||
    goal === "beat_opponents" ||
    experience === "experienced" ||
    experience === "expert"
  ) {
    return "ranked_pvp";
  }

  return "solo_practice";
}

/** The other modes, in catalog order, excluding the recommended one. */
export function otherModes(recommended) {
  return SOLITAIRE_MODES.filter((mode) => mode !== recommended);
}

/**
 * Which tutorial framing to lead with. This changes COPY only: the tutorial
 * deal, the rules engine and every legal move are identical for everyone.
 */
export function tutorialTone(answers) {
  const experience = one(answers?.solitaire_experience);
  if (experience === "complete_beginner" || one(answers?.solitaire_goal) === "learn_the_game") {
    return "guided";
  }
  if (experience === "experienced" || experience === "expert") return "quick";
  return "standard";
}

/** The Glitch line key for the tutorial framing. */
export function tutorialToneMessageKey(answers) {
  const tone = tutorialTone(answers);
  if (tone === "quick") return "onboarding.solitaire.glitch.welcome.step3Quick";
  if (tone === "guided") return "onboarding.solitaire.glitch.welcome.step3Guided";
  return "onboarding.solitaire.glitch.welcome.step3";
}

/** Where the completion CTA should point: the recommended mode's real route. */
export function recommendedRoute(answers) {
  return MODE_ROUTES[recommendedMode(answers)] ?? MODE_ROUTES.solo_practice;
}

/** A one-line reason, as a translation key, for the recommendation. */
export function recommendationReasonKey(answers) {
  const mode = recommendedMode(answers);
  return `onboarding.solitaire.modes.reason.${mode}`;
}

/** True when the player explicitly asked for ranked, so onboarding must explain
 *  that ranked pairs humans only (never an AI fallback) while keeping the
 *  tutorial accessible. */
export function wantsRankedExplainer(answers) {
  return (
    asArray(answers?.solitaire_modes).includes("ranked_pvp") ||
    one(answers?.solitaire_goal) === "climb_leaderboard" ||
    one(answers?.solitaire_goal) === "beat_opponents"
  );
}
