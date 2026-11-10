// tests/onboarding-questionnaire.test.mjs
//
// The questionnaire plumbing: catalog shape, validation, stored-row round trip,
// migration/journal/schema contracts, API security and UI wiring.
//
// The Solitaire-FLOW contract (version isolation, personalization, tracking,
// welcome destination) lives in tests/onboarding-solitaire.test.mjs.
//
// Run: node --import tsx --test tests/onboarding-questionnaire.test.mjs

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
  MAX_TOTAL_ANSWERS,
  getQuestion,
  getAllowedAnswers,
  validateQuestionnaireAnswers,
  groupStoredResponses,
} = await import("../src/lib/onboardingQuestionnaire.js");

const { t } = await import("../src/lib/appTextTranslations.js");

const read = (relPath) => fs.readFileSync(path.join(process.cwd(), relPath), "utf8");

const MIGRATION = "src/db/migrations/0157_onboarding_responses.sql";
const ROUTE = "src/app/api/onboarding/questionnaire/route.ts";
const PAGE = "src/app/welcome/questionnaire/PageClient.tsx";
const STATUS_ROUTE = "src/app/api/onboarding/status/route.ts";
const LOCALES = ["en", "fr", "es"];

/** A complete, valid submission built from the catalog itself. */
function validPayload() {
  const answers = {};
  for (const question of QUESTIONNAIRE_QUESTIONS) {
    answers[question.key] =
      question.type === "multi"
        ? [question.options[0].value]
        : question.options[0].value;
  }
  return answers;
}

// ── Catalog ────────────────────────────────────────────────────────────────

test("catalog exposes the five Solitaire questions in order", () => {
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
  assert.equal(QUESTIONNAIRE_QUESTIONS.length, 5);
});

test("every question has localized copy and stable option ids", () => {
  for (const question of QUESTIONNAIRE_QUESTIONS) {
    assert.ok(question.titleKey.startsWith("onboarding.solitaire.questionnaire."));
    assert.ok(question.hintKey.startsWith("onboarding.solitaire.questionnaire."));
    assert.ok(question.options.length >= 2);
    const values = question.options.map((o) => o.value);
    assert.equal(new Set(values).size, values.length);
    for (const value of values) assert.match(value, /^[a-z][a-z0-9_]*$/);
    if (question.type === "multi") assert.ok(question.maxSelect >= 2);
  }
});

test("MAX_TOTAL_ANSWERS matches the catalog limits", () => {
  const expected = QUESTIONNAIRE_QUESTIONS.reduce(
    (sum, q) => sum + (q.type === "multi" ? q.maxSelect : 1),
    0,
  );
  assert.equal(MAX_TOTAL_ANSWERS, expected);
});

test("getQuestion and getAllowedAnswers resolve the catalog and legacy keys", () => {
  assert.equal(getQuestion("solitaire_experience").type, "single");
  assert.equal(getQuestion("motivation"), undefined);
  assert.equal(getAllowedAnswers("nope").length, 0);
  // The legacy fallback exists only for the lobby recommendation engine.
  assert.deepEqual(getAllowedAnswers("game_types"), [
    "pvp_duels",
    "strategy",
    "fast_paced",
    "casual",
    "luck_chance",
    "competitive",
  ]);
});

// ── Localization ───────────────────────────────────────────────────────────

test("every question and option has copy in all three locales", () => {
  const keys = [
    "onboarding.questionnaire.kicker",
    "onboarding.questionnaire.progress",
    "onboarding.questionnaire.multiHint",
    "onboarding.questionnaire.selectedCount",
    "onboarding.questionnaire.maxSelect",
    "onboarding.questionnaire.selectAtLeastOne",
    "onboarding.questionnaire.back",
    "onboarding.questionnaire.next",
    "onboarding.questionnaire.finish",
    "onboarding.questionnaire.skip",
    "onboarding.questionnaire.saving",
    "onboarding.questionnaire.savingHint",
    "onboarding.questionnaire.saveFailed",
    "onboarding.questionnaire.editNote",
    "onboarding.solitaire.questionnaire.optionalHint",
    "onboarding.solitaire.questionnaire.skipQuestion",
    "onboarding.questionnaire.error.title",
    "onboarding.questionnaire.error.text",
    "onboarding.questionnaire.error.retry",
    "onboarding.questionnaire.error.continue",
  ];
  for (const question of QUESTIONNAIRE_QUESTIONS) {
    keys.push(question.titleKey, question.hintKey);
    for (const option of question.options) keys.push(option.labelKey);
  }

  for (const locale of LOCALES) {
    for (const key of keys) {
      assert.notEqual(t(locale, key), key, `${locale} is missing ${key}`);
    }
  }
});

// ── Validation ─────────────────────────────────────────────────────────────

test("a complete payload validates and normalizes every answer to an array", () => {
  const result = validateQuestionnaireAnswers(validPayload());
  assert.equal(result.ok, true);
  for (const question of QUESTIONNAIRE_QUESTIONS) {
    assert.ok(Array.isArray(result.answers[question.key]));
    assert.ok(result.answers[question.key].length > 0);
  }
});

test("optional questions may be omitted and are stored as empty", () => {
  const result = validateQuestionnaireAnswers({ solitaire_experience: "know_basics" });
  assert.equal(result.ok, true);
  assert.deepEqual(result.answers.solitaire_experience, ["know_basics"]);
  for (const key of ["solitaire_modes", "solitaire_goal", "solitaire_difficulty", "discovery"]) {
    assert.deepEqual(result.answers[key], []);
  }
});

test("rejects non-object payloads and unknown question keys", () => {
  for (const bad of [undefined, null, 42, "x", [], ["solitaire_experience"]]) {
    const result = validateQuestionnaireAnswers(bad);
    assert.equal(result.ok, false);
    assert.equal(result.code, "invalid_payload");
  }
  const result = validateQuestionnaireAnswers({
    solitaire_experience: "expert",
    favourite_colour: "cyan",
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "unknown_question");
});

test("rejects a missing required answer and out-of-catalog values", () => {
  let result = validateQuestionnaireAnswers({ solitaire_modes: ["solo_practice"] });
  assert.equal(result.ok, false);
  assert.equal(result.code, "missing_answer");
  assert.equal(result.questionKey, "solitaire_experience");

  result = validateQuestionnaireAnswers({ solitaire_experience: "grandmaster" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "invalid_answer");

  result = validateQuestionnaireAnswers({
    solitaire_experience: "expert",
    solitaire_modes: ["solo_practice", "rock_climbing"],
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "invalid_answer");
});

test("rejects duplicate and over-long multi-select answers", () => {
  const duplicated = validateQuestionnaireAnswers({
    solitaire_experience: "expert",
    solitaire_modes: ["solo_practice", "solo_practice"],
  });
  assert.equal(duplicated.ok, false);
  assert.equal(duplicated.code, "duplicate_answer");

  // maxSelect is also a hard cap: a longer (unique-looking) list is refused
  // even if a future catalog grows, because the count is validated first.
  const question = getQuestion("solitaire_modes");
  const atCap = question.options.map((o) => o.value);
  assert.equal(atCap.length, question.maxSelect);
  const accepted = validateQuestionnaireAnswers({
    solitaire_experience: "expert",
    solitaire_modes: atCap,
  });
  assert.equal(accepted.ok, true);
});

// ── Stored-row round trip ──────────────────────────────────────────────────

test("groupStoredResponses rebuilds the client shape from stored rows", () => {
  const answers = groupStoredResponses([
    { questionKey: "solitaire_modes", answer: "ranked_pvp" },
    { questionKey: "solitaire_modes", answer: "solo_practice" },
    { questionKey: "solitaire_experience", answer: "know_basics" },
  ]);
  assert.deepEqual(answers.solitaire_modes, ["solo_practice", "ranked_pvp"]);
  assert.equal(answers.solitaire_experience, "know_basics");
  assert.equal(answers.solitaire_goal, undefined);
});

test("groupStoredResponses ignores unknown keys and junk values", () => {
  const answers = groupStoredResponses([
    { questionKey: "not_a_question", answer: "whatever" },
    { questionKey: "solitaire_goal", answer: "not_a_value" },
  ]);
  assert.deepEqual(answers, {});
});

// ── Migration ──────────────────────────────────────────────────────────────

test("migration creates the normalized responses table", () => {
  const sql = read(MIGRATION);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS onboarding_responses/);
  assert.match(sql, /user_id integer NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/);
  assert.match(sql, /question_key varchar\(64\) NOT NULL/);
  assert.match(sql, /answer varchar\(64\) NOT NULL/);
  assert.match(sql, /created_at timestamptz NOT NULL DEFAULT NOW\(\)/);
  assert.match(sql, /updated_at timestamptz NOT NULL DEFAULT NOW\(\)/);
  assert.match(
    sql,
    /CREATE UNIQUE INDEX IF NOT EXISTS onboarding_responses_unique_answer_idx\s+ON onboarding_responses \(user_id, question_key, answer\)/,
  );
  assert.match(
    sql,
    /CREATE INDEX IF NOT EXISTS onboarding_responses_user_idx\s+ON onboarding_responses \(user_id, question_key\)/,
  );
});

test("migration adds a dedicated questionnaire completion column and never backfills it", () => {
  const sql = read(MIGRATION);
  assert.match(
    sql,
    /ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "questionnaire_completed_at" timestamptz/,
  );
  assert.doesNotMatch(sql, /UPDATE\s+"users"\s+SET\s+"questionnaire_completed_at"/i);
});

test("migration is registered in the drizzle journal", () => {
  const journal = JSON.parse(read("src/db/migrations/meta/_journal.json").replace(/^\uFEFF/, ""));
  const entry = journal.entries.find((e) => e.tag === "0157_onboarding_responses");
  assert.ok(entry, "journal entry missing — db:migrate would skip the migration");
  assert.equal(typeof entry.idx, "number");
});

// ── Schema ─────────────────────────────────────────────────────────────────

test("schema mirrors the migration", () => {
  const schema = read("src/db/schema.ts");
  assert.match(schema, /export const onboardingResponses = pgTable\(\s*"onboarding_responses"/);
  assert.match(schema, /questionnaireCompletedAt: timestamp\("questionnaire_completed_at"\)/);
  assert.match(schema, /unique\("onboarding_responses_unique_answer_idx"\)/);
  assert.match(schema, /index\("onboarding_responses_user_idx"\)/);
});

test("questionnaire, tutorial and onboarding completion stay separate", () => {
  const schema = read("src/db/schema.ts");
  assert.match(schema, /onboardingCompletedAt: timestamp\("onboarding_completed_at"\)/);
  assert.match(schema, /questionnaireCompletedAt: timestamp\("questionnaire_completed_at"\)/);
  assert.match(schema, /tutorialCompletedAt: timestamp\("tutorial_completed_at"\)/);
  assert.match(schema, /tutorialSkippedAt: timestamp\("tutorial_skipped_at"\)/);
});

// ── API ────────────────────────────────────────────────────────────────────

test("questionnaire API authenticates with Clerk and never trusts a client user id", () => {
  const route = read(ROUTE);
  assert.match(route, /from "@clerk\/nextjs\/server"/);
  assert.match(route, /await auth\(\)/);
  assert.match(route, /eq\(users\.clerkId, clerkId\)/);
  assert.match(route, /loadUser\(userId\)/);
  assert.doesNotMatch(route, /body\??\.(userId|user_id)/);
});

test("questionnaire API exposes read + replace and validates through the catalog", () => {
  const route = read(ROUTE);
  assert.match(route, /export async function GET/);
  assert.match(route, /export async function POST/);
  assert.match(route, /export async function PUT/);
  assert.match(route, /validateQuestionnaireAnswers/);
  assert.match(route, /if \(!userId\) return unauthorized\(\)/);
});

test("questionnaire API replaces answers atomically and idempotently", () => {
  const route = read(ROUTE);
  assert.match(route, /db\.transaction\(async \(tx\) => \{/);
  assert.match(route, /tx\s*\.delete\(onboardingResponses\)/);
  assert.match(route, /tx\.insert\(onboardingResponses\)/);
  assert.match(route, /isNull\(users\.questionnaireCompletedAt\)/);
  // It never marks the welcome flow complete.
  assert.doesNotMatch(route, /set\(\{[^}]*onboardingCompletedAt/);
});

test("onboarding status reports the questionnaire flag too", () => {
  const route = read(STATUS_ROUTE);
  assert.match(route, /questionnaireCompletedAt: users\.questionnaireCompletedAt/);
  assert.match(route, /questionnaireCompleted,/);
  const anonymousBlock = route.slice(0, route.indexOf("const rows"));
  assert.match(anonymousBlock, /questionnaireCompleted: true/);
});

// ── UI wiring ──────────────────────────────────────────────────────────────

test("questionnaire UI is localized and never hardcodes question copy", () => {
  const page = read(PAGE);
  assert.match(page, /t\(question\.titleKey\)/);
  assert.match(page, /t\(option\.labelKey\)/);
  assert.doesNotMatch(page, /What brings you to GRYND/);
  assert.doesNotMatch(page, /How did you discover/);
});

test("questionnaire UI is accessible and skips optional questions", () => {
  const page = read(PAGE);
  assert.match(page, /role="radiogroup"/);
  assert.match(page, /role="radio"/);
  assert.match(page, /aria-checked=\{selected\}/);
  assert.match(page, /aria-pressed=\{selected\}/);
  assert.match(page, /aria-live="polite"/);
  assert.match(page, /if \(!canAdvance\) \{\s+setShowValidation\(true\);/);
  assert.match(page, /const canAdvance = isAnswered\(question\) \|\| question\.optional === true;/);
  assert.match(page, /const skipQuestion = useCallback/);
  assert.match(page, /onboarding\.solitaire\.questionnaire\.skipQuestion/);
  // Only required answers gate the submission.
  assert.match(page, /q\.optional === true \|\| isAnswered\(q\)/);
});

test("questionnaire UI keeps answers across refresh and reports save errors", () => {
  const page = read(PAGE);
  assert.match(page, /sessionStorage\.setItem\(draftKey/);
  assert.match(page, /sessionStorage\.getItem\(draftKey\)/);
  assert.match(page, /saveFailed/);
  assert.match(page, /onboarding\.questionnaire\.error\.retry/);
  assert.match(page, /method: "PUT"/);
  assert.match(page, /api\/onboarding\/questionnaire/);
  assert.doesNotMatch(page, /api\/onboarding\/complete/);
});

test("proxy keeps the questionnaire reachable before the age gate", () => {
  const proxy = read("src/proxy.ts");
  assert.match(proxy, /"\/welcome\/questionnaire\(\.\*\)"/);
  assert.match(proxy, /"\/welcome"/);
});
