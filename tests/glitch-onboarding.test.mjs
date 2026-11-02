/**
 * glitch-onboarding.test.mjs
 *
 * GLITCH as the onboarding guide: the right line on the right step, in every
 * locale, inline only, and without touching the flow it sits inside.
 *
 * Three kinds of assertion:
 *
 *   1. COPY. Every `onboarding.glitch.*` key resolves in en / fr / es, and the
 *      English wording is the agreed wording. A missing locale would silently
 *      fall back to English, which is why this is checked by key rather than by
 *      eyeballing the UI.
 *   2. MAPPING. Which step uses which expression (glitchOnboarding.ts), pinned
 *      so the questionnaire, /welcome and the RPS tutorial cannot drift apart,
 *      and pinned to the welcome page's own TOTAL_STEPS so adding a step cannot
 *      silently leave it without a line.
 *   3. NON-INTERFERENCE. The onboarding surfaces render GLITCH INLINE only
 *      (never the floating provider, never a corner placement), the
 *      questionnaire hides it while loading/saving/retrying and in edit mode,
 *      and no English copy is hardcoded into a component.
 *
 * Run: npm run test:glitch-onboarding
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const { t } = await import("../src/lib/appTextTranslations.js");
const {
  GLITCH_WELCOME_LINES,
  GLITCH_WELCOME_STEP_COUNT,
  GLITCH_FIRST_MATCH_LINES,
  glitchQuestionnaireLine,
  glitchWelcomeLine,
  glitchFirstMatchResultLine,
} = await import("../src/lib/mascot/glitchOnboarding.ts");

const read = (relPath) => fs.readFileSync(path.join(process.cwd(), relPath), "utf8");
const LOCALES = ["en", "fr", "es"];

const WELCOME_CLIENT = "src/app/welcome/PageClient.tsx";
const QUESTIONNAIRE_CLIENT = "src/app/welcome/questionnaire/PageClient.tsx";
const RPS_CLIENT = "src/app/casino/rps/play-ai/PageClient.tsx";

const ALL_KEYS = [
  "onboarding.glitch.questionnaire.q1",
  "onboarding.glitch.questionnaire.q5",
  "onboarding.glitch.welcome.step0",
  "onboarding.glitch.welcome.step1",
  "onboarding.glitch.welcome.step2",
  "onboarding.glitch.welcome.step3",
  "onboarding.glitch.welcome.step4",
  "onboarding.glitch.firstMatch.start",
  "onboarding.glitch.firstMatch.victory",
  "onboarding.glitch.firstMatch.defeat",
];

// ── Copy ──────────────────────────────────────────────────────────────────

test("every GLITCH onboarding line exists in all three locales", () => {
  for (const locale of LOCALES) {
    for (const key of ALL_KEYS) {
      const value = t(locale, key);
      assert.notEqual(value, key, `${locale} is missing ${key}`);
      assert.equal(typeof value, "string");
      assert.ok(value.trim().length > 0, `${locale} has an empty ${key}`);
    }
  }
});

test("translations are actually translated, not English copied across", () => {
  // A short line could legitimately match across languages, so compare the
  // whole block: at least the majority must differ from English.
  for (const locale of ["fr", "es"]) {
    const differing = ALL_KEYS.filter((key) => t(locale, key) !== t("en", key));
    assert.ok(
      differing.length >= ALL_KEYS.length - 1,
      `${locale} looks untranslated (${differing.length}/${ALL_KEYS.length} differ)`
    );
  }
});

test("the English copy matches the agreed wording", () => {
  assert.equal(t("en", "onboarding.glitch.questionnaire.q1"), "No wrong answers. Promise.");
  assert.equal(
    t("en", "onboarding.glitch.questionnaire.q5"),
    "Last one. This one actually matters."
  );
  assert.equal(t("en", "onboarding.glitch.welcome.step0"), "Hey. I'm GLITCH. I'll keep this quick.");
  assert.equal(t("en", "onboarding.glitch.welcome.step1"), "Play. Outplay. Progress. That's the loop.");
  assert.equal(t("en", "onboarding.glitch.welcome.step2"), "Tokens buy entries. Practice is always free.");
  assert.equal(t("en", "onboarding.glitch.welcome.step3"), "Get matched, play, climb. That's it.");
  assert.equal(t("en", "onboarding.glitch.welcome.step4"), "First match is on me. Let's get your win.");
  assert.equal(t("en", "onboarding.glitch.firstMatch.start"), "Tap one. That's the whole tutorial.");
  assert.equal(
    t("en", "onboarding.glitch.firstMatch.victory"),
    "That's how it works. Now do it for real."
  );
  assert.equal(t("en", "onboarding.glitch.firstMatch.defeat"), "Rough one. Run it back.");
});

// ── Mapping ───────────────────────────────────────────────────────────────

test("each tutorial step gets the agreed expression", () => {
  const expected = ["idle", "wink", "focused", "focused", "victory"];
  for (let step = 0; step < expected.length; step += 1) {
    const line = glitchWelcomeLine(step);
    assert.ok(line, `step ${step} has no GLITCH line`);
    assert.equal(line.expression, expected[step], `step ${step} expression`);
    assert.equal(line.messageKey, `onboarding.glitch.welcome.step${step}`);
  }
  assert.equal(glitchWelcomeLine(-1), null);
  assert.equal(glitchWelcomeLine(5), null);
});

test("the copy map covers exactly the page's five steps", () => {
  const match = read(WELCOME_CLIENT).match(/const TOTAL_STEPS = (\d+);/);
  assert.ok(match, "TOTAL_STEPS not found — did the tutorial change shape?");
  assert.equal(GLITCH_WELCOME_STEP_COUNT, Number(match[1]));
  assert.equal(GLITCH_WELCOME_LINES.length, Number(match[1]));
});

test("the questionnaire speaks on question 1 and question 5 only", () => {
  assert.deepEqual(
    glitchQuestionnaireLine(0),
    { expression: "surprised", messageKey: "onboarding.glitch.questionnaire.q1" }
  );
  for (const quiet of [1, 2, 3]) {
    assert.equal(glitchQuestionnaireLine(quiet), null, `question ${quiet + 1} should be silent`);
  }
  assert.deepEqual(
    glitchQuestionnaireLine(4),
    { expression: "focused", messageKey: "onboarding.glitch.questionnaire.q5" }
  );
});

test("the first match reflects the outcome", () => {
  assert.equal(glitchFirstMatchResultLine(true).expression, "victory");
  assert.equal(glitchFirstMatchResultLine(false).expression, "defeat");
  assert.equal(
    t("en", glitchFirstMatchResultLine(true).messageKey),
    "That's how it works. Now do it for real."
  );
  assert.equal(t("en", glitchFirstMatchResultLine(false).messageKey), "Rough one. Run it back.");
  assert.equal(GLITCH_FIRST_MATCH_LINES.start.expression, "idle");
});

// ── Non-interference ──────────────────────────────────────────────────────

test("onboarding renders GLITCH inline only, never floating", () => {
  for (const file of [WELCOME_CLIENT, QUESTIONNAIRE_CLIENT, RPS_CLIENT]) {
    const source = read(file);
    assert.doesNotMatch(source, /GlitchProvider/, `${file} must not mount the floating provider`);
    assert.doesNotMatch(source, /useGlitch\(/, `${file} must not request a floating message`);
    assert.doesNotMatch(source, /placement="(bottom-left|bottom-right|top-left)"/, `${file} floats`);
    assert.match(source, /placement="inline"/, `${file} should use an inline mascot`);
  }
});

test("the welcome page renders GLITCH on every step", () => {
  const source = read(WELCOME_CLIENT);
  for (let step = 0; step < GLITCH_WELCOME_STEP_COUNT; step += 1) {
    assert.match(source, new RegExp(`<GlitchGuide step=\\{${step}\\}`), `step ${step} missing`);
  }
  // The helper resolves copy through t() — never a literal sentence.
  assert.match(source, /message=\{t\(line\.messageKey\)\}/);
});

test("the questionnaire hides GLITCH while loading, saving or retrying", () => {
  const source = read(QUESTIONNAIRE_CLIENT);
  assert.match(
    source,
    /mode === "first" && questionGlitch && !saving && !saveFailed &&/
  );
  // Edit mode is a returning player changing saved answers — not onboarding.
  assert.match(source, /mode: "first" \| "edit" = completed \? "edit" : "first"/);
});

test("no GLITCH onboarding copy is hardcoded in a component", () => {
  const sentences = [
    "No wrong answers",
    "This one actually matters",
    "Hey. I'm GLITCH",
    "That's the loop",
    "Practice is always free",
    "Get matched, play, climb",
    "First match is on me",
    "Tap one. That's the whole tutorial",
    "Now do it for real",
    "Rough one. Run it back",
  ];
  for (const file of [WELCOME_CLIENT, QUESTIONNAIRE_CLIENT, RPS_CLIENT]) {
    const source = read(file);
    for (const sentence of sentences) {
      assert.ok(!source.includes(sentence), `${file} hardcodes "${sentence}"`);
    }
  }
});

test("the tutorial's opening line lives in the rounds card, not over the board", () => {
  const source = read(RPS_CLIENT);
  // Gated on the onboarding run, the picking phase, and an empty history —
  // i.e. before the first throw, and gone as soon as a round exists.
  assert.match(
    source,
    /\{tutorialActive && phase === "picking" && history\.length === 0 && \(/
  );
  assert.match(source, /t\("onboarding\.glitch\.firstMatch\.start"\)/);
  // The terminal line rides the result screen's EXISTING optional slot, so the
  // shared competitive component is not modified for onboarding.
  assert.match(source, /extraContent=\{/);
  assert.match(source, /tutorial\.mode === "complete" \? \(/);
  assert.match(source, /glitchFirstMatchResultLine\(wonMatch\)/);
});

test("the first-game completion claim is untouched", () => {
  const source = read(RPS_CLIENT);
  assert.match(source, /api\/onboarding\/first-game-complete/);
  // Exactly one CALL (the header comment also names the endpoint, so count the
  // quoted path rather than every mention).
  assert.equal((source.match(/"\/api\/onboarding\/first-game-complete"/g) ?? []).length, 1);
  // The exact guard the onboarding-flow test pins.
  assert.match(source, /if \(tutorial\.mode !== "active" \|\| !matchOver\) return;/);
  // No scoring, outcome or rule constants were touched by this work.
  assert.match(source, /const ROUNDS_TO_WIN = 4;/);
  assert.match(source, /const TOTAL_ROUNDS = 7;/);
});
