/**
 * onboarding-activation.test.mjs
 *
 * Phase 4 pins:
 *   * step-level onboarding measurement uses the EXISTING taxonomy event
 *     (`onboarding_step_completed`) and props (`step`, `steps_total`, `surface`);
 *   * the flow hands off to the home dashboard's single recommendation instead
 *     of inventing a second recommendation engine;
 *   * first-game copy no longer promises ranked is live-humans-only, which the
 *     ghost fallback would contradict (Phase 3).
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  ALLOWED_PROPERTY_KEYS,
  SOLITAIRE_EVENTS,
  sanitizeSolitaireProperties,
} from "../src/lib/solitaire-analytics.ts";

const read = (path) => fs.readFileSync(path, "utf8").replace(/\r\n/g, "\n");

const WELCOME = "src/app/welcome/PageClient.tsx";
const COPY = "src/lib/appTextTranslations.js";
const RANKED_PAGE = "src/app/play/ranked/page.tsx";

test("the step event already belongs to the Phase 1 taxonomy", () => {
  assert.equal(SOLITAIRE_EVENTS.onboardingStepCompleted, "onboarding_step_completed");
  assert.ok(ALLOWED_PROPERTY_KEYS.includes("step"));
  assert.ok(ALLOWED_PROPERTY_KEYS.includes("steps_total"));
  const clean = sanitizeSolitaireProperties({
    step: 3,
    steps_total: 6,
    surface: "welcome",
  });
  assert.deepEqual(clean, { step: 3, steps_total: 6, surface: "welcome" });
});

test("the welcome flow emits step completion for forward moves only", () => {
  const src = read(WELCOME);
  assert.match(src, /SOLITAIRE_EVENTS\.onboardingStepCompleted/);
  assert.match(src, /step: step \+ 1, steps_total: TOTAL_STEPS, surface: "welcome"/);
  assert.match(src, /if \(target > step\) \{/);
  // Once per step per session, so Back/Next cannot inflate the funnel.
  assert.match(src, /trackSolitaireEventOnce\(\s*`onboarding-step:\$\{step\}`/);
  // The six-step flow and its session recovery are untouched.
  assert.match(src, /const TOTAL_STEPS = 6;/);
  assert.match(src, /grynd:welcome:step:/);
});

test("completion hands off to the existing dashboard recommendation", () => {
  const src = read(WELCOME);
  assert.match(src, /const doneTarget = replay \? "\/settings" : "\/";/);
  // No second recommendation engine: the dashboard owns `selectNextAction`.
  assert.doesNotMatch(src, /selectNextAction/);
  assert.doesNotMatch(src, /\/api\/home\/dashboard/);
  // Replay still returns to Settings.
  assert.match(src, /replay \? "\/settings"/);
});

test("the completion CTA names the hand-off honestly", () => {
  const copy = read(COPY);
  assert.match(copy, /cta: "See your next step"/);
  assert.doesNotMatch(copy, /cta: "Enter the Solitaire lobby"/);
});

test("onboarding no longer claims ranked is live humans only", () => {
  const copy = read(COPY);
  assert.doesNotMatch(copy, /real players only/i);
  assert.doesNotMatch(copy, /matchmaking never silently falls back to AI/);
  assert.match(copy, /recorded run by a real player — never an AI/);
  assert.match(copy, /recorded run of the same deal when nobody is waiting/);
});

test("the ranked entry page states the recorded fallback too", () => {
  const src = read(RANKED_PAGE);
  assert.doesNotMatch(src, /against real human players/i);
  assert.match(src, /recorded run of the same deal/);
  assert.match(src, /live player/i);
});

test("solo and daily entries stay open without an auth wall", () => {
  const solo = read("src/app/solitaire/PageClient.tsx");
  const daily = read("src/app/daily/PageClient.tsx");
  for (const src of [solo, daily]) {
    assert.doesNotMatch(src, /redirect\(|useAuth\(\)|SignIn/);
  }
});
