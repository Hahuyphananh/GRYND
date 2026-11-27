/**
 * solitaire-analytics.test.mjs
 *
 * The analytics contract:
 *
 *   * one taxonomy, one spelling per event, no retired-game or token events;
 *   * properties are allowlisted — a deal, a log, a card, an email or a token
 *     can never reach PostHog even if a caller passes one;
 *   * nothing is captured without cookie consent, and nothing is captured in
 *     SSR;
 *   * page events dedupe per session; server dedupe is bounded;
 *   * a ranked result is emitted ONLY by the settlement path, never by a page.
 *
 * Run:  node --import tsx --test tests/solitaire-analytics.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  ALLOWED_PROPERTY_KEYS,
  SOLITAIRE_EVENTS,
  __resetServerDedupe,
  __resetSolitaireAnalytics,
  __setSolitaireCaptureForTests,
  detectPlatform,
  isSolitaireEvent,
  onceOnServer,
  sanitizeSolitaireProperties,
  trackSolitaireEvent,
  trackSolitaireEventOnce,
} from "../src/lib/solitaire-analytics.ts";

const EXPECTED_EVENTS = [
  "landing_page_viewed",
  "signup_completed",
  "onboarding_started",
  "onboarding_step_completed",
  "onboarding_completed",
  "onboarding_skipped",
  "first_game_started",
  "first_game_completed",
  "solitaire_game_started",
  "solitaire_game_completed",
  "solitaire_game_abandoned",
  "solitaire_game_restarted",
  "ranked_queue_started",
  "ranked_queue_cancelled",
  "ranked_match_found",
  "ranked_match_started",
  "ranked_match_completed",
  "ranked_match_forfeited",
  "daily_challenge_started",
  "daily_challenge_completed",
  "solitaire_review_opened",
  "solitaire_review_completed",
  "review_practice_clicked",
  "practice_drill_started",
  "practice_drill_completed",
  "leaderboard_viewed",
  "profile_viewed",
  "academy_lesson_started",
  "academy_lesson_completed",
];

/** Install a browser-ish globals set for the consent gate. */
function withBrowser(consent, fn) {
  const previousWindow = globalThis.window;
  const previousNavigator = globalThis.navigator;
  const store = new Map();
  if (consent) store.set("grynd_cookie_consent", consent);
  globalThis.window = {
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, v),
    },
  };
  Object.defineProperty(globalThis, "navigator", {
    value: { userAgent: "Mozilla/5.0 GRYNDApp/1.0" },
    configurable: true,
    writable: true,
  });
  try {
    return fn();
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (previousNavigator === undefined) {
      delete globalThis.navigator;
    } else {
      Object.defineProperty(globalThis, "navigator", { value: previousNavigator, configurable: true, writable: true });
    }
    __setSolitaireCaptureForTests(null);
    __resetSolitaireAnalytics();
  }
}

test("the taxonomy is exactly the requested set, with no duplicates", () => {
  const names = Object.values(SOLITAIRE_EVENTS);
  assert.deepEqual([...names].sort(), [...EXPECTED_EVENTS].sort());
  assert.equal(new Set(names).size, names.length);
  for (const retired of names) {
    assert.doesNotMatch(retired, /token|coin|blackjack|roulette|plinko|mines|memory/i);
  }
  assert.ok(isSolitaireEvent("solitaire_game_started"));
  assert.equal(isSolitaireEvent("made_up_event"), false);
});

test("properties are allowlisted and validated", () => {
  const clean = sanitizeSolitaireProperties({
    mode: "ranked",
    game_id: "solitaire-duel",
    is_first_game: true,
    is_authenticated: true,
    platform: "ios",
    source: "utm_source",
    duration_seconds: 91.4,
    result: "win",
    opponent_type: "human",
    step: 2,
    steps_total: 6,
    lesson_id: "foundations-101",
    surface: "review",
    queue_duration_ms: 4200,
    rating_diff: 73,
    skill_id: "foundation-timing",
    exercise_id: "foundation-timing-beginner-1",
    // Everything below must be dropped.
    deal: ["AS", "2D"],
    log: [{ move: "A->B" }],
    cards: ["AS"],
    email: "player@example.com",
    token: "secret",
    userId: "user_123",
    url: "https://x.test/?utm_source=y",
  });
  assert.deepEqual(Object.keys(clean).sort(), [...ALLOWED_PROPERTY_KEYS].sort());
  assert.equal(clean.duration_seconds, 91);
  assert.equal("deal" in clean, false);
  assert.equal("log" in clean, false);
  assert.equal("cards" in clean, false);
  assert.equal("email" in clean, false);
  assert.equal("token" in clean, false);
});

test("invalid values are omitted, not guessed", () => {
  const clean = sanitizeSolitaireProperties({
    mode: "arena",
    result: "victory",
    opponent_type: "ghost",
    platform: "desktop",
    duration_seconds: -3,
    step: "2",
  });
  assert.deepEqual(clean, {});
});

test("nothing is captured without consent, and nothing in SSR", () => {
  const sent = [];
  __setSolitaireCaptureForTests((e) => sent.push(e));

  // No window at all → SSR path.
  assert.equal(trackSolitaireEvent(SOLITAIRE_EVENTS.landingPageViewed), false);
  assert.deepEqual(sent, []);

  withBrowser("declined", () => {
    assert.equal(trackSolitaireEvent(SOLITAIRE_EVENTS.landingPageViewed), false);
  });
  assert.deepEqual(sent, []);

  withBrowser(null, () => {
    assert.equal(trackSolitaireEventOnce("k", SOLITAIRE_EVENTS.landingPageViewed), false);
  });
  assert.deepEqual(sent, []);
});

test("with consent the event is sent once, with the sanitized payload and platform", () => {
  const sent = [];
  withBrowser("accepted", () => {
    __setSolitaireCaptureForTests((event, props) => sent.push({ event, props }));
    assert.equal(
      trackSolitaireEventOnce("view", SOLITAIRE_EVENTS.leaderboardViewed, {
        surface: "classement",
        email: "nope@example.com",
      }),
      true,
    );
    // Same key again: deduped.
    assert.equal(
      trackSolitaireEventOnce("view", SOLITAIRE_EVENTS.leaderboardViewed),
      false,
    );
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].event, "leaderboard_viewed");
  assert.equal(sent[0].props.surface, "classement");
  assert.equal(sent[0].props.platform, "android");
  assert.equal("email" in sent[0].props, false);
});

test("platform detection is web unless the native shell says otherwise", () => {
  const previous = globalThis.navigator;
  const setUa = (ua) =>
    Object.defineProperty(globalThis, "navigator", {
      value: { userAgent: ua },
      configurable: true,
      writable: true,
    });
  setUa("Mozilla/5.0 (Windows NT 10.0)");
  assert.equal(detectPlatform(), "web");
  setUa("Mozilla/5.0 GRYNDApp/1.0 (iPhone; CPU iPhone OS 18_0)");
  assert.equal(detectPlatform(), "ios");
  if (previous === undefined) delete globalThis.navigator;
  else
    Object.defineProperty(globalThis, "navigator", {
      value: previous,
      configurable: true,
      writable: true,
    });
});

test("server dedupe fires once per key and stays bounded", () => {
  __resetServerDedupe();
  assert.equal(onceOnServer("settled:abc"), true);
  assert.equal(onceOnServer("settled:abc"), false);
  __resetServerDedupe();
});

test("a ranked result is emitted only by settlement, never by a page", () => {
  const page = fs.readFileSync(
    "src/app/casino/solitaire-duel/[matchId]/PageClient.tsx",
    "utf8",
  );
  assert.doesNotMatch(page, /ranked_match_completed|rankedMatchCompleted/);
  const store = fs.readFileSync("src/lib/solitaire-duel/serverStore.ts", "utf8");
  assert.match(store, /rankedMatchCompleted/);
  // …and after the settlement call, not before it.
  const settleAt = store.indexOf("await settleSolitaireDuelMatch(");
  const emitAt = store.indexOf("rankedMatchCompleted");
  assert.ok(settleAt > -1 && emitAt > settleAt, "capture must follow settlement");
});

test("no hidden card data is ever passed to the tracker", () => {
  const files = [
    "src/components/solitaire-duel/SoloSolitaireGame.tsx",
    "src/app/casino/solitaire-duel/[matchId]/PageClient.tsx",
    "src/app/solitaire/review/[kind]/[gameId]/PageClient.tsx",
  ];
  for (const path of files) {
    const src = fs.readFileSync(path, "utf8");
    for (const line of src.split("\n")) {
      if (!/trackSolitaireEvent(Once)?\(/.test(line)) continue;
      assert.doesNotMatch(line, /\b(deal|log|cards|hand|email|token)\b/i, path);
    }
  }
});
