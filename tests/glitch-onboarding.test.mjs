/**
 * glitch-onboarding.test.mjs
 *
 * GLITCH as the SOLITAIRE onboarding guide: the right line on the right step,
 * in every locale, inline only, reacting to real gameplay events and without
 * touching the flow it sits inside.
 *
 *   1. COPY. Every `onboarding.solitaire.glitch.*` key resolves in en / fr / es,
 *      and the English wording is the agreed wording.
 *   2. MAPPING. Six welcome steps, sparse questionnaire lines, and tutorial
 *      reactions that only exist for real events (ace / progress / reveal /
 *      invalid / stuck / complete).
 *   3. NON-INTERFERENCE. Onboarding renders GLITCH INLINE only, and the
 *      tutorial's reaction is derived from the engine's accepted move.
 *
 * Run: node --import tsx --test tests/glitch-onboarding.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const { t } = await import("../src/lib/appTextTranslations.js");
const {
  GLITCH_WELCOME_LINES,
  GLITCH_WELCOME_STEP_COUNT,
  GLITCH_TUTORIAL_LINES,
  GLITCH_FIRST_MATCH_LINES,
  glitchQuestionnaireLine,
  glitchWelcomeLine,
  glitchFirstMatchResultLine,
  tutorialMoveLine,
} = await import("../src/lib/mascot/glitchOnboarding.ts");

const read = (relPath) => fs.readFileSync(path.join(process.cwd(), relPath), "utf8");
const LOCALES = ["en", "fr", "es"];

const WELCOME_CLIENT = "src/app/welcome/PageClient.tsx";
const QUESTIONNAIRE_CLIENT = "src/app/welcome/questionnaire/PageClient.tsx";
const RPS_CLIENT = "src/app/casino/rps/play-ai/PageClient.tsx";
const TUTORIAL_UI = "src/components/solitaire-duel/SolitaireTutorial.tsx";

const SOLITAIRE_GLITCH_KEYS = [
  "onboarding.solitaire.glitch.questionnaire.q1",
  "onboarding.solitaire.glitch.questionnaire.q3",
  "onboarding.solitaire.glitch.questionnaire.q5",
  ...[0, 1, 2, 3, 4, 5].map((step) => `onboarding.solitaire.glitch.welcome.step${step}`),
  "onboarding.solitaire.glitch.welcome.step3Guided",
  "onboarding.solitaire.glitch.welcome.step3Quick",
  ...Object.values(GLITCH_TUTORIAL_LINES).map((line) => line.messageKey),
];

// ── Copy ──────────────────────────────────────────────────────────────────

test("every Solitaire onboarding GLITCH line exists in all three locales", () => {
  for (const locale of LOCALES) {
    for (const key of SOLITAIRE_GLITCH_KEYS) {
      const value = t(locale, key);
      assert.notEqual(value, key, `${locale} is missing ${key}`);
      assert.equal(typeof value, "string");
      assert.ok(value.trim().length > 0, `${locale} has an empty ${key}`);
    }
  }
});

test("translations are actually translated, not English copied across", () => {
  for (const locale of ["fr", "es"]) {
    const differing = SOLITAIRE_GLITCH_KEYS.filter((key) => t(locale, key) !== t("en", key));
    assert.ok(
      differing.length >= SOLITAIRE_GLITCH_KEYS.length - 2,
      `${locale} looks untranslated (${differing.length}/${SOLITAIRE_GLITCH_KEYS.length} differ)`,
    );
  }
});

test("the English copy matches the agreed Solitaire wording", () => {
  assert.equal(t("en", "onboarding.solitaire.glitch.welcome.step0").slice(0, 17), "Welcome to GRYND!");
  assert.equal(
    t("en", "onboarding.solitaire.glitch.welcome.step2"),
    "Down in rank, alternating colours, Aces to the foundations. That's most of Klondike already.",
  );
  assert.equal(
    t("en", "onboarding.solitaire.glitch.welcome.step5"),
    "You're ready! Practice, take today's challenge, or compete against real players. Your next move starts here.",
  );
  assert.equal(
    t("en", "onboarding.solitaire.glitch.tutorial.complete"),
    "Tutorial complete. Four real moves, no help needed. Let's find your mode.",
  );
  assert.equal(t("en", "onboarding.solitaire.glitch.tutorial.invalid").includes("isn't legal"), true);
  // Helpful, never insulting.
  assert.doesNotMatch(t("en", "onboarding.solitaire.glitch.tutorial.invalid"), /stupid|wrong|bad/i);
  // No retired tokens / RPS / Mines messaging in any onboarding GLITCH line.
  for (const key of SOLITAIRE_GLITCH_KEYS) {
    for (const locale of LOCALES) {
      assert.doesNotMatch(t(locale, key), /token|RPS|rock.?paper|mines/i, `${locale} ${key}`);
    }
  }
});

// ── Mapping ───────────────────────────────────────────────────────────────

test("each welcome step gets the agreed expression", () => {
  const expected = ["idle", "wink", "focused", "focused", "wink", "victory"];
  for (let step = 0; step < expected.length; step += 1) {
    const line = glitchWelcomeLine(step);
    assert.ok(line, `step ${step} has no GLITCH line`);
    assert.equal(line.expression, expected[step], `step ${step} expression`);
    assert.equal(line.messageKey, `onboarding.solitaire.glitch.welcome.step${step}`);
  }
  assert.equal(glitchWelcomeLine(-1), null);
  assert.equal(glitchWelcomeLine(GLITCH_WELCOME_STEP_COUNT), null);
});

test("the copy map covers exactly the page's six steps", () => {
  const match = read(WELCOME_CLIENT).match(/const TOTAL_STEPS = (\d+);/);
  assert.ok(match, "TOTAL_STEPS not found — did the flow change shape?");
  assert.equal(Number(match[1]), 6);
  assert.equal(GLITCH_WELCOME_STEP_COUNT, Number(match[1]));
  assert.equal(GLITCH_WELCOME_LINES.length, Number(match[1]));
});

test("the questionnaire speaks on questions 1, 3 and 5 only", () => {
  assert.deepEqual(glitchQuestionnaireLine(0), {
    expression: "surprised",
    messageKey: "onboarding.solitaire.glitch.questionnaire.q1",
  });
  assert.equal(glitchQuestionnaireLine(1), null);
  assert.deepEqual(glitchQuestionnaireLine(2), {
    expression: "wink",
    messageKey: "onboarding.solitaire.glitch.questionnaire.q3",
  });
  assert.equal(glitchQuestionnaireLine(3), null);
  assert.deepEqual(glitchQuestionnaireLine(4), {
    expression: "focused",
    messageKey: "onboarding.solitaire.glitch.questionnaire.q5",
  });
});

test("tutorial reactions correspond to real engine events", () => {
  // Completing the last goal wins, regardless of which goal it was.
  assert.equal(
    tutorialMoveLine({ stepId: "draw", revealed: [], complete: true }).messageKey,
    "onboarding.solitaire.glitch.tutorial.complete",
  );
  // An Ace on the foundation gets the celebration.
  assert.equal(
    tutorialMoveLine({ stepId: "ace", revealed: [], complete: false }).messageKey,
    "onboarding.solitaire.glitch.tutorial.ace",
  );
  // A reveal is reported as a reveal even when it also advanced a goal.
  assert.equal(
    tutorialMoveLine({ stepId: "reveal", revealed: [{ suit: "spades", rank: 6 }], complete: false })
      .messageKey,
    "onboarding.solitaire.glitch.tutorial.reveal",
  );
  // A legal move that advanced nothing is still progress, never a celebration
  // of something that did not happen.
  assert.equal(
    tutorialMoveLine({ stepId: null, revealed: [], complete: false }).messageKey,
    "onboarding.solitaire.glitch.tutorial.progress",
  );
  assert.equal(GLITCH_TUTORIAL_LINES.invalid.expression, "focused");
  assert.equal(GLITCH_TUTORIAL_LINES.complete.expression, "victory");
});

test("the first match (legacy RPS surface) still reflects the outcome", () => {
  assert.equal(glitchFirstMatchResultLine(true).expression, "victory");
  assert.equal(glitchFirstMatchResultLine(false).expression, "defeat");
  assert.equal(GLITCH_FIRST_MATCH_LINES.start.expression, "idle");
  assert.equal(t("en", "onboarding.glitch.firstMatch.victory"), "That's how it works. Now do it for real.");
});

// ── Non-interference ──────────────────────────────────────────────────────

test("onboarding renders GLITCH inline only, never floating", () => {
  for (const file of [WELCOME_CLIENT, QUESTIONNAIRE_CLIENT, TUTORIAL_UI]) {
    const source = read(file);
    assert.doesNotMatch(source, /GlitchProvider/, `${file} must not mount the floating provider`);
    assert.doesNotMatch(source, /useGlitch\(/, `${file} must not request a floating message`);
    assert.doesNotMatch(
      source,
      /placement="(bottom-left|bottom-right|top-left)"/,
      `${file} floats`,
    );
    assert.match(source, /placement="inline"/, `${file} should use an inline mascot`);
  }
});

test("the welcome page renders GLITCH on every step", () => {
  const source = read(WELCOME_CLIENT);
  for (let step = 0; step < GLITCH_WELCOME_STEP_COUNT; step += 1) {
    assert.match(source, new RegExp(`<GlitchGuide step=\\{${step}\\}`), `step ${step} missing`);
  }
  // The helper resolves copy through t() — never a literal sentence — and may
  // swap the step's line for a tone variant.
  assert.match(source, /message=\{t\(messageKey \?\? line\.messageKey\)\}/);
});

test("the questionnaire hides GLITCH while loading, saving or retrying", () => {
  const source = read(QUESTIONNAIRE_CLIENT);
  assert.match(source, /mode === "first" && questionGlitch && !saving && !saveFailed &&/);
  assert.match(source, /mode: "first" \| "edit" = completed \? "edit" : "first"/);
});

test("no Solitaire onboarding copy is hardcoded in a component", () => {
  const sentences = [
    "Welcome to GRYND!",
    "Four areas, one game",
    "Ace on the foundation",
    "That one isn't legal yet",
    "Skip tutorial",
    "Enter the Solitaire lobby",
  ];
  for (const file of [WELCOME_CLIENT, QUESTIONNAIRE_CLIENT, TUTORIAL_UI]) {
    const source = read(file);
    for (const sentence of sentences) {
      assert.ok(!source.includes(sentence), `${file} hardcodes "${sentence}"`);
    }
  }
});

test("the tutorial only reacts after the engine accepts the move", () => {
  const source = read(TUTORIAL_UI);
  // The invalid branch is the engine's `!outcome.ok`, and the reaction is
  // derived from the goal the ENGINE says was reached.
  assert.match(source, /const outcome = applyTutorialMove/);
  assert.match(source, /if \(!outcome\.ok\) \{\s+react\(GLITCH_TUTORIAL_LINES\.invalid\);/);
  assert.match(source, /tutorialMoveLine\(\{/);
  assert.match(source, /stepId: completedStep\?\.id \?\? null/);
});

test("the floating provider is not used anywhere in the Solitaire onboarding", () => {
  for (const file of [WELCOME_CLIENT, QUESTIONNAIRE_CLIENT, TUTORIAL_UI]) {
    assert.doesNotMatch(read(file), /from ".*GlitchProvider/);
  }
});
