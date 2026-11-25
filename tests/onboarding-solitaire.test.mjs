// tests/onboarding-solitaire.test.mjs
//
// The SOLITAIRE onboarding contract:
//
//   * questionnaire v2 (the five Solitaire questions, optional answers)
//   * version isolation — stored v1 rows can never read as v2 answers
//   * personalization recommends a Solitaire MODE, never a game rating
//   * the welcome flow sends the player to the real Solitaire lobby
//   * tutorial start / complete / skip are recorded distinctly (migration 0246)
//   * no token, RPS or Mines messaging survives in the active onboarding
//
// Run: node --import tsx --test tests/onboarding-solitaire.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const {
  QUESTIONNAIRE_QUESTIONS,
  QUESTIONNAIRE_VERSION,
  QUESTION_KEYS,
  MULTI_QUESTION_KEYS,
  SINGLE_QUESTION_KEYS,
  OPTIONAL_QUESTION_KEYS,
  MAX_TOTAL_ANSWERS,
  getQuestion,
  getAllowedAnswers,
  validateQuestionnaireAnswers,
  groupStoredResponses,
  hasCurrentVersionAnswers,
} = await import("../src/lib/onboardingQuestionnaire.js");

const {
  SOLITAIRE_MODES,
  MODE_LABEL_KEYS,
  MODE_ROUTES,
  recommendedMode,
  recommendedRoute,
  recommendationReasonKey,
  tutorialTone,
  wantsRankedExplainer,
} = await import("../src/lib/solitairePersonalization.js");

const { t } = await import("../src/lib/appTextTranslations.js");

const read = (relPath) => fs.readFileSync(path.join(process.cwd(), relPath), "utf8");
const LOCALES = ["en", "fr", "es"];

const WELCOME_CLIENT = "src/app/welcome/PageClient.tsx";
const QUESTIONNAIRE_CLIENT = "src/app/welcome/questionnaire/PageClient.tsx";
const PROGRESS_ROUTE = "src/app/api/onboarding/progress/route.ts";
const MIGRATION = "src/db/migrations/0246_solitaire_onboarding_progress.sql";
const SCHEMA = "src/db/schema.ts";

// ── Catalog / versioning ──────────────────────────────────────────────────

test("the catalog is questionnaire version 2 with five Solitaire questions", () => {
  assert.equal(QUESTIONNAIRE_VERSION, 2);
  assert.deepEqual(QUESTION_KEYS, [
    "solitaire_experience",
    "solitaire_modes",
    "solitaire_goal",
    "solitaire_difficulty",
    "discovery",
  ]);
  assert.deepEqual(MULTI_QUESTION_KEYS, ["solitaire_modes"]);
  assert.deepEqual(SINGLE_QUESTION_KEYS, [
    "solitaire_experience",
    "solitaire_goal",
    "solitaire_difficulty",
    "discovery",
  ]);
  // Only experience is required; every other question is skippable.
  assert.deepEqual(OPTIONAL_QUESTION_KEYS, [
    "solitaire_modes",
    "solitaire_goal",
    "solitaire_difficulty",
    "discovery",
  ]);
});

test("the option ids match the product spec", () => {
  assert.deepEqual(
    getQuestion("solitaire_experience").options.map((o) => o.value),
    ["complete_beginner", "know_basics", "experienced", "expert"],
  );
  assert.deepEqual(
    getQuestion("solitaire_modes").options.map((o) => o.value),
    ["solo_practice", "daily_challenge", "play_vs_bots", "ranked_pvp"],
  );
  assert.deepEqual(
    getQuestion("solitaire_goal").options.map((o) => o.value),
    ["learn_the_game", "improve_skills", "beat_opponents", "climb_leaderboard"],
  );
  assert.deepEqual(
    getQuestion("solitaire_difficulty").options.map((o) => o.value),
    ["beginner", "intermediate", "advanced"],
  );
  // Discovery analytics are preserved exactly.
  assert.deepEqual(getAllowedAnswers("discovery"), [
    "tiktok",
    "instagram",
    "youtube",
    "friend",
    "google_search",
    "other",
  ]);
  for (const question of QUESTIONNAIRE_QUESTIONS) {
    const values = question.options.map((o) => o.value);
    assert.equal(new Set(values).size, values.length);
    for (const value of values) assert.match(value, /^[a-z][a-z0-9_]*$/);
  }
});

test("the questionnaire copy exists in every locale", () => {
  const keys = [
    "onboarding.solitaire.questionnaire.optionalHint",
    "onboarding.solitaire.questionnaire.skipQuestion",
  ];
  for (const question of QUESTIONNAIRE_QUESTIONS) {
    keys.push(question.titleKey, question.hintKey);
    for (const option of question.options) keys.push(option.labelKey);
  }
  for (const locale of LOCALES) {
    for (const key of keys) assert.notEqual(t(locale, key), key, `${locale} is missing ${key}`);
  }
});

// ── Validation / optional answers ─────────────────────────────────────────

test("a required-only submission is valid and skips are stored as empty", () => {
  const result = validateQuestionnaireAnswers({ solitaire_experience: "complete_beginner" });
  assert.equal(result.ok, true);
  assert.deepEqual(result.answers.solitaire_experience, ["complete_beginner"]);
  for (const key of OPTIONAL_QUESTION_KEYS) {
    assert.deepEqual(result.answers[key], [], `${key} must stay blank, not fabricated`);
  }
});

test("a fully skipped optional questionnaire validates", () => {
  const result = validateQuestionnaireAnswers({});
  assert.equal(result.ok, false);
  assert.equal(result.code, "missing_answer");
  assert.equal(result.questionKey, "solitaire_experience");
});

test("multi-select answers are normalized to catalog order and capped", () => {
  const ok = validateQuestionnaireAnswers({
    solitaire_experience: "experienced",
    solitaire_modes: ["ranked_pvp", "solo_practice"],
  });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.answers.solitaire_modes, ["solo_practice", "ranked_pvp"]);

  const tooMany = validateQuestionnaireAnswers({
    solitaire_experience: "expert",
    solitaire_modes: ["solo_practice", "daily_challenge", "play_vs_bots", "ranked_pvp", "solo_practice"],
  });
  assert.equal(tooMany.ok, false);
  assert.equal(tooMany.code, "duplicate_answer");
});

test("unknown questions and out-of-catalog values are rejected", () => {
  assert.equal(
    validateQuestionnaireAnswers({ solitaire_experience: "new" }).code,
    "invalid_answer",
  );
  assert.equal(
    validateQuestionnaireAnswers({ solitaire_experience: "expert", experience: "new" }).code,
    "unknown_question",
  );
  assert.equal(validateQuestionnaireAnswers(null).code, "invalid_payload");
});

test("MAX_TOTAL_ANSWERS still reflects the catalog", () => {
  const expected = QUESTIONNAIRE_QUESTIONS.reduce(
    (sum, q) => sum + (q.type === "multi" ? q.maxSelect : 1),
    0,
  );
  assert.equal(MAX_TOTAL_ANSWERS, expected);
});

// ── Version isolation ─────────────────────────────────────────────────────

test("stored v1 answers are never read as Solitaire answers", () => {
  const legacyRows = [
    { questionKey: "motivation", answer: "competition" },
    { questionKey: "game_types", answer: "pvp_duels" },
    { questionKey: "experience", answer: "experienced" },
    { questionKey: "priorities", answer: "earning_tokens" },
    { questionKey: "discovery", answer: "tiktok" },
  ];
  const grouped = groupStoredResponses(legacyRows);
  // Only the analytics key survives, because it is genuinely the same question.
  assert.deepEqual(grouped, { discovery: "tiktok" });
  assert.equal(hasCurrentVersionAnswers(legacyRows), true);

  // A row that cannot map at all is indistinguishable from "never answered".
  assert.equal(hasCurrentVersionAnswers([{ questionKey: "motivation", answer: "fun" }]), false);
  assert.deepEqual(groupStoredResponses([{ questionKey: "experience", answer: "new" }]), {});
});

test("legacy answers cannot masquerade as difficulty or experience", () => {
  const grouped = groupStoredResponses([
    { questionKey: "experience", answer: "experienced" },
    { questionKey: "solitaire_experience", answer: "expert" },
  ]);
  assert.equal(grouped.solitaire_experience, "expert");
  assert.equal(grouped.experience, undefined);
  // The old multi-game keys stay readable ONLY for the legacy lobby engine.
  assert.deepEqual(getAllowedAnswers("experience"), [
    "new",
    "casual",
    "experienced",
    "highly_competitive",
  ]);
});

// ── Personalization ───────────────────────────────────────────────────────

test("personalization recommends a Solitaire mode, not a game", () => {
  assert.deepEqual(SOLITAIRE_MODES, [
    "solo_practice",
    "daily_challenge",
    "play_vs_bots",
    "ranked_pvp",
  ]);
  for (const mode of SOLITAIRE_MODES) {
    const key = MODE_LABEL_KEYS[mode];
    assert.deepEqual(Object.keys(key ? { key } : {}), ["key"]);
    for (const locale of LOCALES) assert.notEqual(t(locale, key), key);
    assert.equal(MODE_ROUTES[mode].startsWith("/casino/solitaire-duel"), true);
  }
});

test("an explicit mode choice wins", () => {
  assert.equal(recommendedMode({ solitaire_modes: ["daily_challenge"] }), "daily_challenge");
  assert.equal(recommendedMode({ solitaire_modes: ["play_vs_bots"] }), "play_vs_bots");
  assert.equal(recommendedMode({ solitaire_modes: ["ranked_pvp"] }), "ranked_pvp");
});

test("experience and goals fall back to ranked, otherwise solo", () => {
  assert.equal(recommendedMode({ solitaire_experience: "expert" }), "ranked_pvp");
  assert.equal(recommendedMode({ solitaire_goal: "climb_leaderboard" }), "ranked_pvp");
  assert.equal(recommendedMode({ solitaire_goal: "learn_the_game" }), "solo_practice");
  assert.equal(recommendedMode({ solitaire_experience: "complete_beginner" }), "solo_practice");
  assert.equal(recommendedMode({}), "solo_practice");
  assert.equal(recommendedMode(undefined), "solo_practice");
});

test("the recommendation never fabricates a rating or reads matchmaking", () => {
  for (const locale of LOCALES) {
    for (const mode of SOLITAIRE_MODES) {
      assert.notEqual(t(locale, recommendationReasonKey({ solitaire_modes: [mode] })), "");
    }
  }
  // Comments explain the boundary; the CODE must not implement any of it.
  const code = read("src/lib/solitairePersonalization.js").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(code, /elo|rating|trophy|matchmak|gameRecommendations/i);
  assert.doesNotMatch(code, /fetch\(|localStorage|sessionStorage/);
});

test("tutorial tone changes copy only, and ranked interest is explained", () => {
  assert.equal(tutorialTone({ solitaire_experience: "complete_beginner" }), "guided");
  assert.equal(tutorialTone({ solitaire_experience: "expert" }), "quick");
  assert.equal(tutorialTone({ solitaire_experience: "know_basics" }), "standard");
  assert.equal(wantsRankedExplainer({ solitaire_modes: ["ranked_pvp"] }), true);
  assert.equal(wantsRankedExplainer({ solitaire_goal: "climb_leaderboard" }), true);
  assert.equal(wantsRankedExplainer({ solitaire_modes: ["solo_practice"] }), false);
});

// ── Welcome flow ──────────────────────────────────────────────────────────

test("the welcome flow is six steps and has no retired onboarding messaging", () => {
  const source = read(WELCOME_CLIENT);
  assert.match(source, /const TOTAL_STEPS = 6;/);
  // Comments may name what was removed; the rendered code must not.
  const code = source.replace(/\/\/.*$/gm, "");
  for (const banned of [
    /onboarding\.tokens/,
    /\bRPS\b/,
    /rock.?paper/i,
    /\bMines\b/,
    /FIRST_GAME_URL/,
    /free tokens/i,
    /\/casino\/rps/,
    /\/casino\/mines/,
  ]) {
    assert.doesNotMatch(code, banned);
  }
  // The first real destination is the discovered Solitaire route.
  assert.match(source, /import \{ GAME_ROUTE \} from "\.\.\/\.\.\/lib\/solitaire-duel\/constants"/);
  assert.match(source, /const LOBBY_URL = GAME_ROUTE;/);
});

test("the welcome flow resumes, is replayable and never auto-completes", () => {
  const source = read(WELCOME_CLIENT);
  assert.match(source, /grynd:welcome:step:/);
  assert.match(
    source,
    /if \(Number\.isInteger\(saved\) && saved > 0 && saved <= TOTAL_STEPS - 1\)/,
  );
  // Completion is only ever written from the final CTA / Skip, and only via the
  // existing endpoint.
  assert.match(source, /api\/onboarding\/complete/);
  assert.equal((source.match(/completeOnboarding\(\)/g) ?? []).length >= 1, true);
  assert.doesNotMatch(source, /api\/onboarding\/complete[\s\S]{0,80}=.*useEffect/s);
});

test("the tutorial is a real engine-backed step, and its outcomes are tracked distinctly", () => {
  const source = read(WELCOME_CLIENT);
  assert.match(source, /<SolitaireTutorial/);
  assert.match(source, /onStarted=\{\(\) => track\("tutorial_started"\)\}/);
  assert.match(source, /track\("tutorial_completed"\)/);
  assert.match(source, /track\("tutorial_skipped"\)/);
  // Skipping advances; it never marks the tutorial complete.
  assert.match(source, /track\("tutorial_skipped"\);\s+goTo\(4\);/);
  assert.doesNotMatch(source, /tutorial_skipped[\s\S]{0,40}tutorial_completed/);
});

test("the questionnaire UI lets optional questions be skipped", () => {
  const source = read(QUESTIONNAIRE_CLIENT);
  assert.match(source, /q\.optional === true \|\| isAnswered\(q\)/);
  assert.match(source, /question\.optional === true/);
  assert.match(source, /onboarding\.solitaire\.questionnaire\.skipQuestion/);
  assert.match(source, /const skipQuestion = useCallback/);
  // No "all questions answered" gate remains.
  assert.doesNotMatch(source, /every\(\(q\) => isAnswered\(q\)\)/);
});

// ── Progress tracking (migration 0246) ────────────────────────────────────

test("migration 0246 is additive, nullable and never backfilled", () => {
  // Strip the explanatory header: only the DDL must be additive.
  const sql = read(MIGRATION).replace(/^--.*$/gm, "");
  for (const column of [
    "onboarding_started_at",
    "tutorial_started_at",
    "tutorial_completed_at",
    "tutorial_skipped_at",
  ]) {
    assert.match(
      sql,
      new RegExp(`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "${column}" timestamp`),
    );
  }
  assert.doesNotMatch(sql, /UPDATE|DELETE|DROP|NOT NULL|DEFAULT/i);
  assert.equal((sql.match(/ALTER TABLE "users" ADD COLUMN/gi) ?? []).length, 4);
  const journal = JSON.parse(
    read("src/db/migrations/meta/_journal.json").replace(/^\uFEFF/, ""),
  );
  assert.ok(journal.entries.some((e) => e.tag === "0246_solitaire_onboarding_progress"));
});

test("the schema mirrors the migration", () => {
  const schema = read(SCHEMA);
  for (const column of [
    "onboarding_started_at",
    "tutorial_started_at",
    "tutorial_completed_at",
    "tutorial_skipped_at",
  ]) {
    assert.match(schema, new RegExp(`timestamp\\("${column}"\\)`));
  }
});

test("the progress endpoint keeps completion, skip and complete distinct", () => {
  const route = read(PROGRESS_ROUTE);
  assert.match(route, /const \{ userId \} = await auth\(\);/);
  assert.match(route, /if \(!userId\)/);
  assert.match(route, /welcome_started: "onboardingStartedAt"/);
  assert.match(route, /tutorial_started: "tutorialStartedAt"/);
  assert.match(route, /tutorial_completed: "tutorialCompletedAt"/);
  assert.match(route, /tutorial_skipped: "tutorialSkippedAt"/);
  // First event wins, and this route never completes onboarding.
  assert.match(route, /isNull\(users\[column\]\)/);
  assert.doesNotMatch(route, /onboardingCompletedAt/);
  assert.doesNotMatch(route, /body\??\.(userId|user_id)/);
});

test("no onboarding surface links to a retired game", () => {
  for (const file of [WELCOME_CLIENT, QUESTIONNAIRE_CLIENT]) {
    const source = read(file);
    assert.doesNotMatch(source, /\/casino\/rps/);
    assert.doesNotMatch(source, /\/casino\/mines/);
  }
  // The engine, ranked settlement, bots and rules are untouched by onboarding.
  assert.doesNotMatch(read(PROGRESS_ROUTE), /bots|matchmaking|elo|settle/i);
});
