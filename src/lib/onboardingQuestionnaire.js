// src/lib/onboardingQuestionnaire.js
//
// Single source of truth for the GRYND onboarding questionnaire: the five
// SOLITAIRE questions, their stable option ids, and the validation used by
// PUT/POST /api/onboarding/questionnaire.
//
// VERSIONING (important, and deliberately migration-free)
// ------------------------------------------------------
// GRYND is Solitaire-first, so the old multi-game questionnaire (version 1:
// motivation / game_types / experience / priorities / discovery) no longer
// describes the product. This catalog is version 2 and every personalization
// question uses a NEW key (`solitaire_experience`, `solitaire_modes`,
// `solitaire_goal`, `solitaire_difficulty`). Only `discovery` is carried over
// unchanged because it is analytics-only and its options are still useful.
//
// That key change IS the version safety: stored v1 rows can never be read as
// v2 answers because `groupStoredResponses` only maps keys that exist in the
// current catalog. No column change and no destructive migration is needed —
// old rows stay in onboarding_responses as history. Likewise a v1
// `questionnaire_completed_at` stays meaningful ("has answered the
// questionnaire once"), so an existing player is never forced through the new
// questions unless they explicitly open Settings → Your GRYND Preferences.
//
// Conventions:
//   * `key` / `value` are STABLE internal ids — never display text. They are
//     what lands in onboarding_responses, so re-wording or re-translating the
//     questionnaire never touches stored data.
//   * `labelKey` points at src/lib/appTextTranslations.js
//     (`onboarding.questionnaire.*`), which is where all user-facing copy
//     lives (en / fr / es).
//   * Nothing here is sensitive, and nothing here feeds Elo, matchmaking or
//     difficulty. It only picks which Solitaire mode to put first.

/** Bump when the question set changes meaningfully (stored alongside the
 *  answers by the API so a future version can decide to re-prompt). */
export const QUESTIONNAIRE_VERSION = 2;

/**
 * The five questions, in display order. `type` drives both rendering and
 * validation; `maxSelect` caps multi-select answers — the UI disables further
 * options once the cap is reached and the API rejects an over-long list, so
 * the limit is enforced on both sides from this single value.
 *
 * `optional: true` means the question may be left unanswered: the API accepts
 * the submission and the UI offers "Skip this question". Personalization is a
 * nicety; it must never block access to Solitaire.
 */
export const QUESTIONNAIRE_QUESTIONS = [
  {
    key: "solitaire_experience",
    type: "single",
    titleKey: "onboarding.solitaire.questionnaire.q1.title",
    hintKey: "onboarding.solitaire.questionnaire.q1.hint",
    options: [
      { value: "complete_beginner", labelKey: "onboarding.solitaire.questionnaire.q1.options.complete_beginner" },
      { value: "know_basics", labelKey: "onboarding.solitaire.questionnaire.q1.options.know_basics" },
      { value: "experienced", labelKey: "onboarding.solitaire.questionnaire.q1.options.experienced" },
      { value: "expert", labelKey: "onboarding.solitaire.questionnaire.q1.options.expert" },
    ],
  },
  {
    key: "solitaire_modes",
    type: "multi",
    maxSelect: 4,
    optional: true,
    titleKey: "onboarding.solitaire.questionnaire.q2.title",
    hintKey: "onboarding.solitaire.questionnaire.q2.hint",
    options: [
      { value: "solo_practice", labelKey: "onboarding.solitaire.questionnaire.q2.options.solo_practice" },
      { value: "daily_challenge", labelKey: "onboarding.solitaire.questionnaire.q2.options.daily_challenge" },
      { value: "play_vs_bots", labelKey: "onboarding.solitaire.questionnaire.q2.options.play_vs_bots" },
      { value: "ranked_pvp", labelKey: "onboarding.solitaire.questionnaire.q2.options.ranked_pvp" },
    ],
  },
  {
    key: "solitaire_goal",
    type: "single",
    optional: true,
    titleKey: "onboarding.solitaire.questionnaire.q3.title",
    hintKey: "onboarding.solitaire.questionnaire.q3.hint",
    options: [
      { value: "learn_the_game", labelKey: "onboarding.solitaire.questionnaire.q3.options.learn_the_game" },
      { value: "improve_skills", labelKey: "onboarding.solitaire.questionnaire.q3.options.improve_skills" },
      { value: "beat_opponents", labelKey: "onboarding.solitaire.questionnaire.q3.options.beat_opponents" },
      { value: "climb_leaderboard", labelKey: "onboarding.solitaire.questionnaire.q3.options.climb_leaderboard" },
    ],
  },
  {
    key: "solitaire_difficulty",
    type: "single",
    optional: true,
    titleKey: "onboarding.solitaire.questionnaire.q4.title",
    hintKey: "onboarding.solitaire.questionnaire.q4.hint",
    options: [
      { value: "beginner", labelKey: "onboarding.solitaire.questionnaire.q4.options.beginner" },
      { value: "intermediate", labelKey: "onboarding.solitaire.questionnaire.q4.options.intermediate" },
      { value: "advanced", labelKey: "onboarding.solitaire.questionnaire.q4.options.advanced" },
    ],
  },
  {
    key: "discovery",
    type: "single",
    optional: true,
    // Analytics-only question — it never feeds Solitaire personalization.
    titleKey: "onboarding.solitaire.questionnaire.q5.title",
    hintKey: "onboarding.solitaire.questionnaire.q5.hint",
    options: [
      { value: "tiktok", labelKey: "onboarding.solitaire.questionnaire.q5.options.tiktok" },
      { value: "instagram", labelKey: "onboarding.solitaire.questionnaire.q5.options.instagram" },
      { value: "youtube", labelKey: "onboarding.solitaire.questionnaire.q5.options.youtube" },
      { value: "friend", labelKey: "onboarding.solitaire.questionnaire.q5.options.friend" },
      { value: "google_search", labelKey: "onboarding.solitaire.questionnaire.q5.options.google_search" },
      { value: "other", labelKey: "onboarding.solitaire.questionnaire.q5.options.other" },
    ],
  },
];

/** Every valid question key, in display order. */
export const QUESTION_KEYS = QUESTIONNAIRE_QUESTIONS.map((q) => q.key);

/** Question keys that accept several answers. */
export const MULTI_QUESTION_KEYS = QUESTIONNAIRE_QUESTIONS.filter((q) => q.type === "multi").map(
  (q) => q.key
);

/** Question keys that accept exactly one answer. */
export const SINGLE_QUESTION_KEYS = QUESTIONNAIRE_QUESTIONS.filter((q) => q.type === "single").map(
  (q) => q.key
);

/** Questions that may be left blank. */
export const OPTIONAL_QUESTION_KEYS = QUESTIONNAIRE_QUESTIONS.filter((q) => q.optional).map(
  (q) => q.key
);

/** Hard cap on the total number of stored answers (multi-select maxima +
 *  one per single-select). The API rejects anything above this before it
 *  touches the database, so a crafted payload can't write an unbounded
 *  number of rows for one user. */
export const MAX_TOTAL_ANSWERS = QUESTIONNAIRE_QUESTIONS.reduce(
  (sum, q) => sum + (q.type === "multi" ? q.maxSelect : 1),
  0
);

/**
 * Answers accepted by the RETIRED version-1 questionnaire.
 *
 * Kept only so the existing lobby recommendation engine
 * (src/lib/gameRecommendations.js, which is outside onboarding and still reads
 * `game_types` / `experience` / `priorities`) keeps validating its own legacy
 * inputs. Nothing in onboarding reads this map, and no archived game is
 * recommended by ANY onboarding surface.
 */
const LEGACY_ALLOWED_ANSWERS = Object.freeze({
  motivation: ["competition", "rewards", "variety", "versus_players", "fun"],
  game_types: ["pvp_duels", "strategy", "fast_paced", "casual", "luck_chance", "competitive"],
  experience: ["new", "casual", "experienced", "highly_competitive"],
  priorities: ["winning", "ranking_up", "earning_tokens", "improving_skills", "fun"],
  discovery: ["tiktok", "instagram", "youtube", "friend", "google_search", "other"],
});

/** The question definition for a key (or undefined). */
export function getQuestion(key) {
  return QUESTIONNAIRE_QUESTIONS.find((q) => q.key === key);
}

/** The allowed answer values for a question key. */
export function getAllowedAnswers(key) {
  const question = getQuestion(key);
  if (question) return question.options.map((o) => o.value);
  return LEGACY_ALLOWED_ANSWERS[key] ?? [];
}

/**
 * Validate + normalize a submitted answer map.
 *
 * Input shape (from the client):
 *   { solitaire_experience: "complete_beginner", solitaire_modes: ["solo_practice"], ... }
 *
 * Required questions must be present; `optional` questions may be omitted or
 * empty. Single-select answers must be plain strings, multi-select answers
 * arrays of allowed values.
 *
 * Output:
 *   { ok: true, answers: { <questionKey>: [<value>, ...] } }  // every value an array
 *   { ok: false, code, error, questionKey? }
 *
 * Error codes are stable so the UI/API can react without string matching.
 */
export function validateQuestionnaireAnswers(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {
      ok: false,
      code: "invalid_payload",
      error: "answers must be an object keyed by question id.",
    };
  }

  const keys = Object.keys(input);
  const unknown = keys.filter((key) => !QUESTION_KEYS.includes(key));
  if (unknown.length > 0) {
    return {
      ok: false,
      code: "unknown_question",
      error: `Unknown question: ${unknown[0]}`,
      questionKey: unknown[0],
    };
  }

  const normalized = {};
  let total = 0;

  for (const question of QUESTIONNAIRE_QUESTIONS) {
    const raw = input[question.key];
    const allowed = question.options.map((o) => o.value);

    // Optional: absent or empty is a valid "prefer not to say".
    const absent = raw === undefined || raw === null;
    const emptyMulti = Array.isArray(raw) && raw.length === 0;
    if (question.optional && (absent || emptyMulti)) {
      normalized[question.key] = [];
      continue;
    }

    // Required: an unselected question short-circuits with a clear code.
    if (absent) {
      return {
        ok: false,
        code: "missing_answer",
        error: `Missing answer for ${question.key}.`,
        questionKey: question.key,
      };
    }

    if (question.type === "single") {
      if (typeof raw !== "string" || !allowed.includes(raw)) {
        return {
          ok: false,
          code: "invalid_answer",
          error: `Invalid answer for ${question.key}.`,
          questionKey: question.key,
        };
      }
      normalized[question.key] = [raw];
      total += 1;
      continue;
    }

    if (!Array.isArray(raw) || raw.length === 0) {
      return {
        ok: false,
        code: "missing_answer",
        error: `Select at least one option for ${question.key}.`,
        questionKey: question.key,
      };
    }
    if (raw.some((value) => typeof value !== "string" || !allowed.includes(value))) {
      const bad = raw.find((value) => typeof value !== "string" || !allowed.includes(value));
      return {
        ok: false,
        code: "invalid_answer",
        error: `Invalid answer for ${question.key}: ${String(bad)}`,
        questionKey: question.key,
      };
    }
    const unique = new Set(raw);
    if (unique.size !== raw.length) {
      return {
        ok: false,
        code: "duplicate_answer",
        error: `Duplicate answers for ${question.key}.`,
        questionKey: question.key,
      };
    }
    if (raw.length > question.maxSelect) {
      return {
        ok: false,
        code: "too_many_answers",
        error: `Select at most ${question.maxSelect} options for ${question.key}.`,
        questionKey: question.key,
      };
    }

    // Store in catalog order so reads are deterministic regardless of the
    // order the client happened to send.
    normalized[question.key] = allowed.filter((value) => unique.has(value));
    total += normalized[question.key].length;
  }

  if (total > MAX_TOTAL_ANSWERS) {
    return {
      ok: false,
      code: "too_many_answers",
      error: "Too many answers.",
    };
  }

  return { ok: true, answers: normalized };
}

/**
 * Turn stored rows ({ questionKey, answer }) back into the client shape:
 * `{ solitaire_experience: "beginners", solitaire_modes: ["solo_practice"] }`.
 *
 * Only keys in the CURRENT catalog are read, which is what makes old v1 rows
 * permanently uninterpretable as v2 answers.
 */
export function groupStoredResponses(rows) {
  const answers = {};
  for (const question of QUESTIONNAIRE_QUESTIONS) {
    const values = rows
      .filter((row) => row.questionKey === question.key)
      .map((row) => row.answer)
      .filter((value) => question.options.some((o) => o.value === value));
    const ordered = question.options.map((o) => o.value).filter((value) => values.includes(value));
    if (ordered.length === 0) continue;
    answers[question.key] = question.type === "multi" ? ordered : ordered[0];
  }
  return answers;
}

/** True when the stored rows contain no answers the current catalog can read
 *  (e.g. a version-1 record). Used by callers that need to distinguish "never
 *  answered the Solitaire questionnaire" from "answered it". */
export function hasCurrentVersionAnswers(rows) {
  return Object.keys(groupStoredResponses(rows)).length > 0;
}
