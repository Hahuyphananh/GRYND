// tests/onboarding-questionnaire.test.mjs
//
// Checks for the onboarding questionnaire:
//   * src/lib/onboardingQuestionnaire.js — the catalog + validation rules
//     shared by the UI and /api/onboarding/questionnaire
//   * full localization coverage for every question/option label
//   * the migration / schema / API / UI source contracts, asserted the same
//     way the repo's other tests assert migration SQL and route source
//     (tests/quick-queue-*.test.mjs)

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

/** A complete, valid submission built from the catalog itself, so these
 *  tests keep passing if an option id is added/removed. */
function validPayload() {
  const answers = {};
  for (const question of QUESTIONNAIRE_QUESTIONS) {
    answers[question.key] =
      question.type === "multi"
        ? [question.options[0].value, question.options[1].value]
        : question.options[0].value;
  }
  return answers;
}

// ── Catalog ────────────────────────────────────────────────────────────────

test("catalog exposes the five questionnaire questions in order", () => {
  assert.equal(QUESTIONNAIRE_VERSION, 1);
  assert.deepEqual(QUESTION_KEYS, [
    "motivation",
    "game_types",
    "experience",
    "priorities",
    "discovery",
  ]);
  assert.equal(QUESTIONNAIRE_QUESTIONS.length, 5);
});

test("question types match the product spec", () => {
  assert.deepEqual(MULTI_QUESTION_KEYS, ["motivation", "game_types", "priorities"]);
  assert.deepEqual(SINGLE_QUESTION_KEYS, ["experience", "discovery"]);
  for (const question of QUESTIONNAIRE_QUESTIONS) {
    assert.ok(question.titleKey.startsWith("onboarding.questionnaire."));
    assert.ok(question.hintKey.startsWith("onboarding.questionnaire."));
    assert.ok(question.options.length >= 2);
    if (question.type === "multi") {
      assert.ok(question.maxSelect >= 2);
    }
  }
});

test("option ids are stable, unique ids — never display text", () => {
  for (const question of QUESTIONNAIRE_QUESTIONS) {
    const values = question.options.map((o) => o.value);
    assert.equal(new Set(values).size, values.length);
    for (const value of values) {
      assert.match(value, /^[a-z][a-z0-9_]*$/, `${question.key}: ${value}`);
    }
  }
  // The five spec'd discovery sources are all present.
  assert.deepEqual(getAllowedAnswers("discovery"), [
    "tiktok",
    "instagram",
    "youtube",
    "friend",
    "google_search",
    "other",
  ]);
  assert.deepEqual(getAllowedAnswers("experience"), [
    "new",
    "casual",
    "experienced",
    "highly_competitive",
  ]);
});

test("MAX_TOTAL_ANSWERS matches the catalog limits", () => {
  const expected = QUESTIONNAIRE_QUESTIONS.reduce(
    (sum, q) => sum + (q.type === "multi" ? q.maxSelect : 1),
    0
  );
  assert.equal(MAX_TOTAL_ANSWERS, expected);
});

test("getQuestion returns the definition or undefined", () => {
  assert.equal(getQuestion("motivation").type, "multi");
  assert.equal(getQuestion("nope"), undefined);
  assert.deepEqual(getAllowedAnswers("nope"), []);
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
      // t() surfaces the raw key when a translation is missing — so an
      // unresolved key means the locale bundle has a gap.
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

test("multi-select answers are stored in catalog order", () => {
  const payload = validPayload();
  payload.game_types = ["luck_chance", "pvp_duels"];
  const result = validateQuestionnaireAnswers(payload);
  assert.equal(result.ok, true);
  assert.deepEqual(result.answers.game_types, ["pvp_duels", "luck_chance"]);
});

test("rejects non-object payloads", () => {
  for (const bad of [undefined, null, 42, "x", [], ["motivation"]]) {
    const result = validateQuestionnaireAnswers(bad);
    assert.equal(result.ok, false);
    assert.equal(result.code, "invalid_payload");
  }
});

test("rejects unknown question keys", () => {
  const payload = { ...validPayload(), favourite_colour: "cyan" };
  const result = validateQuestionnaireAnswers(payload);
  assert.equal(result.ok, false);
  assert.equal(result.code, "unknown_question");
});

test("rejects a missing required answer", () => {
  const payload = validPayload();
  delete payload.experience;
  const result = validateQuestionnaireAnswers(payload);
  assert.equal(result.ok, false);
  assert.equal(result.code, "missing_answer");
  assert.equal(result.questionKey, "experience");
});

test("rejects an empty multi-select answer", () => {
  const payload = validPayload();
  payload.priorities = [];
  const result = validateQuestionnaireAnswers(payload);
  assert.equal(result.ok, false);
  assert.equal(result.code, "missing_answer");
});

test("rejects answer values outside the catalog", () => {
  const payload = validPayload();
  payload.experience = "grandmaster";
  let result = validateQuestionnaireAnswers(payload);
  assert.equal(result.ok, false);
  assert.equal(result.code, "invalid_answer");

  const multi = validPayload();
  multi.game_types = ["pvp_duels", "rock_climbing"];
  result = validateQuestionnaireAnswers(multi);
  assert.equal(result.ok, false);
  assert.equal(result.code, "invalid_answer");

  // Wrong shape entirely (array where a single value is required).
  const shaped = validPayload();
  shaped.experience = ["new"];
  result = validateQuestionnaireAnswers(shaped);
  assert.equal(result.ok, false);
  assert.equal(result.code, "invalid_answer");
});

test("rejects duplicate answers inside one submission", () => {
  const payload = validPayload();
  payload.motivation = ["fun", "fun"];
  const result = validateQuestionnaireAnswers(payload);
  assert.equal(result.ok, false);
  assert.equal(result.code, "duplicate_answer");
});

test("rejects more selections than a question allows", () => {
  const question = getQuestion("game_types");
  const payload = validPayload();
  payload.game_types = question.options.map((o) => o.value).slice(0, question.maxSelect + 1);
  const result = validateQuestionnaireAnswers(payload);
  assert.equal(result.ok, false);
  assert.equal(result.code, "too_many_answers");
});

// ── Stored-row round trip ──────────────────────────────────────────────────

test("groupStoredResponses rebuilds the client shape from stored rows", () => {
  const answers = groupStoredResponses([
    { questionKey: "motivation", answer: "fun" },
    { questionKey: "motivation", answer: "competition" },
    { questionKey: "experience", answer: "casual" },
  ]);
  // Multi-select reads as an array in catalog order, single as a string.
  assert.deepEqual(answers.motivation, ["competition", "fun"]);
  assert.equal(answers.experience, "casual");
  // Unanswered questions are simply absent.
  assert.equal(answers.game_types, undefined);
});

test("groupStoredResponses ignores unknown keys and junk values", () => {
  const answers = groupStoredResponses([
    { questionKey: "not_a_question", answer: "whatever" },
    { questionKey: "experience", answer: "not_a_value" },
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
});

test("migration blocks uncontrolled duplicates and speeds up reads", () => {
  const sql = read(MIGRATION);
  assert.match(
    sql,
    /CREATE UNIQUE INDEX IF NOT EXISTS onboarding_responses_unique_answer_idx\s+ON onboarding_responses \(user_id, question_key, answer\)/
  );
  assert.match(
    sql,
    /CREATE INDEX IF NOT EXISTS onboarding_responses_user_idx\s+ON onboarding_responses \(user_id, question_key\)/
  );
});

test("migration adds a dedicated questionnaire completion column and does not backfill it", () => {
  const sql = read(MIGRATION);
  assert.match(
    sql,
    /ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "questionnaire_completed_at" timestamptz/
  );
  // Existing accounts must stay NULL so they can still be prompted; a backfill
  // here would silently disable that.
  assert.doesNotMatch(sql, /UPDATE\s+"users"\s+SET\s+"questionnaire_completed_at"/i);
});

test("migration is registered in the drizzle journal", () => {
  // The journal file carries a UTF-8 BOM.
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

test("questionnaire completion is separate from tutorial completion", () => {
  const schema = read("src/db/schema.ts");
  assert.match(schema, /onboardingCompletedAt: timestamp\("onboarding_completed_at"\)/);
  assert.match(schema, /firstGameCompletedAt: timestamp\("first_game_completed_at"\)/);
  assert.match(schema, /questionnaireCompletedAt: timestamp\("questionnaire_completed_at"\)/);
});

// ── API ────────────────────────────────────────────────────────────────────

test("questionnaire API authenticates with Clerk and never trusts a client user id", () => {
  const route = read(ROUTE);
  assert.match(route, /from "@clerk\/nextjs\/server"/);
  assert.match(route, /await auth\(\)/);
  assert.match(route, /eq\(users\.clerkId, clerkId\)/);
  // The row is always resolved from the session's userId.
  assert.match(route, /loadUser\(userId\)/);
  // The caller's own row is derived from the session; a body-supplied id is
  // never read.
  assert.doesNotMatch(route, /body\??\.(userId|user_id)/);
});

test("questionnaire API exposes read + replace and validates through the catalog", () => {
  const route = read(ROUTE);
  assert.match(route, /export async function GET/);
  assert.match(route, /export async function POST/);
  assert.match(route, /export async function PUT/);
  assert.match(route, /validateQuestionnaireAnswers/);
  // Auth-less requests are rejected, not silently resolved to "no user".
  assert.match(route, /if \(!userId\) return unauthorized\(\)/);
});

test("questionnaire API replaces answers atomically and idempotently", () => {
  const route = read(ROUTE);
  assert.match(route, /db\.transaction\(async \(tx\) => \{/);
  assert.match(route, /tx\s*\.delete\(onboardingResponses\)/);
  assert.match(route, /tx\.insert\(onboardingResponses\)/);
  // First submission stamps completion; later edits don't re-stamp it.
  assert.match(route, /isNull\(users\.questionnaireCompletedAt\)/);
});

test("questionnaire API never marks the welcome tutorial complete", () => {
  const route = read(ROUTE);
  assert.doesNotMatch(route, /set\(\{[^}]*onboardingCompletedAt/);
});

test("onboarding status reports the questionnaire flag too", () => {
  const route = read(STATUS_ROUTE);
  assert.match(route, /questionnaireCompletedAt: users\.questionnaireCompletedAt/);
  assert.match(route, /questionnaireCompleted,/);
  // Anonymous visitors are treated as completed for every onboarding state.
  const anonymousBlock = route.slice(0, route.indexOf("const rows"));
  assert.match(anonymousBlock, /questionnaireCompleted: true/);
});

// ── UI wiring ──────────────────────────────────────────────────────────────

test("questionnaire UI is localized and never hardcodes question copy", () => {
  const page = read(PAGE);
  assert.match(page, /t\(question\.titleKey\)/);
  assert.match(page, /t\(option\.labelKey\)/);
  assert.match(page, /onboarding\.questionnaire\./);
  // No literal English question text in the component.
  assert.doesNotMatch(page, /What brings you to GRYND/);
  assert.doesNotMatch(page, /How did you discover/);
});

test("questionnaire UI is accessible and validates before advancing", () => {
  const page = read(PAGE);
  assert.match(page, /role="radiogroup"/);
  assert.match(page, /role="radio"/);
  assert.match(page, /aria-checked=\{selected\}/);
  assert.match(page, /aria-pressed=\{selected\}/);
  assert.match(page, /aria-live="polite"/);
  // Advancing validates first and explains why when it can't proceed.
  assert.match(page, /if \(!canAdvance\) \{\s+setShowValidation\(true\);/);
  assert.match(page, /if \(!allAnswered\) \{/);
  assert.match(page, /onboarding\.questionnaire\.selectAtLeastOne/);
  // A submission is never sent for an incomplete questionnaire.
  assert.match(page, /if \(!QUESTIONNAIRE_QUESTIONS\.every\(\(q\) => isAnswered\(q\)\)\) return;/);
});

test("questionnaire UI keeps answers across refresh and reports save errors", () => {
  const page = read(PAGE);
  assert.match(page, /sessionStorage\.setItem\(draftKey/);
  assert.match(page, /sessionStorage\.getItem\(draftKey\)/);
  assert.match(page, /saveFailed/);
  assert.match(page, /onboarding\.questionnaire\.error\.retry/);
  assert.match(page, /method: "PUT"/);
  assert.match(page, /api\/onboarding\/questionnaire/);
});

test("questionnaire UI does not touch the tutorial completion endpoint", () => {
  const page = read(PAGE);
  assert.doesNotMatch(page, /api\/onboarding\/complete/);
});

test("proxy keeps the questionnaire reachable before the age gate", () => {
  const proxy = read("src/proxy.ts");
  assert.match(proxy, /"\/welcome\/questionnaire\(\.\*\)"/);
  assert.match(proxy, /"\/welcome"/);
});

test("new signups are routed to the questionnaire first", () => {
  const sync = read("src/app/sync/PageClient.tsx");
  assert.match(sync, /isNewUser \? "\/welcome\/questionnaire" : "\/"/);
});
