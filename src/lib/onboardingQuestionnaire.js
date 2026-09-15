// src/lib/onboardingQuestionnaire.js
//
// Single source of truth for the GRYND onboarding questionnaire: the five
// questions, their stable option ids, and the validation used by
// PUT/POST /api/onboarding/questionnaire.
//
// Shared by the client (renders the flow) and the server (validates a
// submission), exactly like src/lib/defaultWagers.js — so the API can never
// accept a question/answer the UI doesn't actually offer, and a UI change
// can't silently start storing junk.
//
// Conventions:
//   * `key` / `value` are STABLE internal ids — never display text. They are
//     what lands in onboarding_responses, so re-wording or re-translating the
//     questionnaire never touches stored data.
//   * `labelKey` points at src/lib/appTextTranslations.js
//     (`onboarding.questionnaire.*`), which is where all user-facing copy
//     lives (en / fr / es).
//   * Nothing here is sensitive: these are game preferences only.

/** Bump when the question set changes meaningfully (stored alongside the
 *  answers by the API so a future version can decide to re-prompt). */
export const QUESTIONNAIRE_VERSION = 1;

/**
 * The five questions, in display order. `type` drives both rendering and
 * validation; `maxSelect` caps multi-select answers — the UI disables further
 * options once the cap is reached and the API rejects an over-long list, so
 * the limit is enforced on both sides from this single value.
 */
export const QUESTIONNAIRE_QUESTIONS = [
  {
    key: "motivation",
    type: "multi",
    maxSelect: 3,
    titleKey: "onboarding.questionnaire.q1.title",
    hintKey: "onboarding.questionnaire.q1.hint",
    options: [
      { value: "competition", labelKey: "onboarding.questionnaire.q1.options.competition" },
      { value: "rewards", labelKey: "onboarding.questionnaire.q1.options.rewards" },
      { value: "variety", labelKey: "onboarding.questionnaire.q1.options.variety" },
      { value: "versus_players", labelKey: "onboarding.questionnaire.q1.options.versus_players" },
      { value: "fun", labelKey: "onboarding.questionnaire.q1.options.fun" },
    ],
  },
  {
    key: "game_types",
    type: "multi",
    maxSelect: 3,
    titleKey: "onboarding.questionnaire.q2.title",
    hintKey: "onboarding.questionnaire.q2.hint",
    options: [
      { value: "pvp_duels", labelKey: "onboarding.questionnaire.q2.options.pvp_duels" },
      { value: "strategy", labelKey: "onboarding.questionnaire.q2.options.strategy" },
      { value: "fast_paced", labelKey: "onboarding.questionnaire.q2.options.fast_paced" },
      { value: "casual", labelKey: "onboarding.questionnaire.q2.options.casual" },
      { value: "luck_chance", labelKey: "onboarding.questionnaire.q2.options.luck_chance" },
      { value: "competitive", labelKey: "onboarding.questionnaire.q2.options.competitive" },
    ],
  },
  {
    key: "experience",
    type: "single",
    titleKey: "onboarding.questionnaire.q3.title",
    hintKey: "onboarding.questionnaire.q3.hint",
    options: [
      { value: "new", labelKey: "onboarding.questionnaire.q3.options.new" },
      { value: "casual", labelKey: "onboarding.questionnaire.q3.options.casual" },
      { value: "experienced", labelKey: "onboarding.questionnaire.q3.options.experienced" },
      {
        value: "highly_competitive",
        labelKey: "onboarding.questionnaire.q3.options.highly_competitive",
      },
    ],
  },
  {
    key: "priorities",
    type: "multi",
    maxSelect: 3,
    titleKey: "onboarding.questionnaire.q4.title",
    hintKey: "onboarding.questionnaire.q4.hint",
    options: [
      { value: "winning", labelKey: "onboarding.questionnaire.q4.options.winning" },
      { value: "ranking_up", labelKey: "onboarding.questionnaire.q4.options.ranking_up" },
      { value: "earning_tokens", labelKey: "onboarding.questionnaire.q4.options.earning_tokens" },
      {
        value: "improving_skills",
        labelKey: "onboarding.questionnaire.q4.options.improving_skills",
      },
      { value: "fun", labelKey: "onboarding.questionnaire.q4.options.fun" },
    ],
  },
  {
    key: "discovery",
    type: "single",
    // Analytics-only question — it never feeds game recommendations.
    titleKey: "onboarding.questionnaire.q5.title",
    hintKey: "onboarding.questionnaire.q5.hint",
    options: [
      { value: "tiktok", labelKey: "onboarding.questionnaire.q5.options.tiktok" },
      { value: "instagram", labelKey: "onboarding.questionnaire.q5.options.instagram" },
      { value: "youtube", labelKey: "onboarding.questionnaire.q5.options.youtube" },
      { value: "friend", labelKey: "onboarding.questionnaire.q5.options.friend" },
      { value: "google_search", labelKey: "onboarding.questionnaire.q5.options.google_search" },
      { value: "other", labelKey: "onboarding.questionnaire.q5.options.other" },
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

/** Hard cap on the total number of stored answers (multi-select maxima +
 *  one per single-select). The API rejects anything above this before it
 *  touches the database, so a crafted payload can't write an unbounded
 *  number of rows for one user. */
export const MAX_TOTAL_ANSWERS = QUESTIONNAIRE_QUESTIONS.reduce(
  (sum, q) => sum + (q.type === "multi" ? q.maxSelect : 1),
  0
);

/** The question definition for a key (or undefined). */
export function getQuestion(key) {
  return QUESTIONNAIRE_QUESTIONS.find((q) => q.key === key);
}

/** The allowed answer values for a question key. */
export function getAllowedAnswers(key) {
  const question = getQuestion(key);
  return question ? question.options.map((o) => o.value) : [];
}

/**
 * Validate + normalize a submitted answer map.
 *
 * Input shape (from the client):
 *   { motivation: ["competition", "fun"], experience: "new", ... }
 * Every question is required, single-select answers must be plain strings,
 * multi-select answers must be arrays of allowed values.
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

    // Required: an unselected question short-circuits with a clear code.
    if (raw === undefined || raw === null) {
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
 * Turn stored rows ({ question_key, answer }) back into the client shape:
 * `{ motivation: ["competition"], experience: "new" }` — single-select
 * questions read as a string, multi-select as an array (catalog order).
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
