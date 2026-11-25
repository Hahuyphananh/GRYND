/**
 * home-dashboard.test.mjs
 *
 * Pins the home dashboard's two pure decisions and the wiring around them:
 *
 *   1. `buildRecentActivity` merges ranked, Solo and Daily rows into one
 *      newest-first list. A review link exists only for a completed game with a
 *      stored log, practice is always marked unrated, and nothing is invented.
 *   2. `selectNextAction` follows one fixed, explainable precedence.
 *   3. A weak device-local practice skill turns into one targeted Academy drill
 *      without overriding onboarding or the daily habit.
 *   4. `/api/home/dashboard` is the page's ONE player read, is authenticated by
 *      the session only, and never writes.
 *   5. The page handles guest, brand-new, empty, partial and failed states.
 *
 * Run: npm run test:home-dashboard
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  DASHBOARD_ACTIVITY_LIMIT,
  REVIEW_WINDOW_MS,
  buildRecentActivity,
  fastestSolveMs,
  isNewPlayer,
  mergePracticeFocus,
  selectNextAction,
} from "../src/lib/home/dashboard.js";
import {
  PRACTICE_FOCUS_LOW_SUCCESS_RATE,
  PRACTICE_FOCUS_MIN_ATTEMPTS,
  weakestPracticeFocus,
} from "../src/lib/solitaire-duel/practiceFocus.ts";
import { COACHING_THRESHOLDS } from "../src/lib/learn/coaching.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");
const code = (source) =>
  source
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

const NOW = Date.UTC(2026, 10, 23, 12, 0, 0);
const HOUR = 60 * 60 * 1000;

// ── 1. Recent activity ─────────────────────────────────────────────────────

test("ranked, Solo and Daily rows merge newest-first and respect the cap", () => {
  const entries = buildRecentActivity({
    ranked: [
      {
        matchId: "m1",
        status: "finished",
        outcome: "win",
        isAi: false,
        createdAtMs: NOW - 5 * HOUR,
        endedAtMs: NOW - 4 * HOUR,
      },
      {
        matchId: "m2",
        status: "playing",
        outcome: null,
        isAi: false,
        createdAtMs: NOW - 1 * HOUR,
        endedAtMs: null,
      },
    ],
    solo: [
      {
        id: "s1",
        completed: true,
        reviewable: true,
        moves: 90,
        elapsedMs: 120_000,
        createdAtMs: NOW - 3 * HOUR,
      },
    ],
    daily: [
      {
        id: "d1",
        completed: true,
        reviewable: true,
        moves: 70,
        elapsedMs: 100_000,
        dateKey: "2026-11-23",
        createdAtMs: NOW - 2 * HOUR,
      },
    ],
  });

  assert.deepEqual(
    entries.map((entry) => entry.key),
    ["ranked:m2", "daily:d1", "solo:s1", "ranked:m1"],
  );
  assert.equal(entries[0].outcome, null, "an unfinished match has no result");
  assert.equal(entries[0].actionLabel, "Open");
  assert.equal(entries[0].href, "/casino/solitaire-duel/m2");

  const capped = buildRecentActivity(
    { ranked: Array.from({ length: 12 }, (_, i) => ({
      matchId: `m${i}`,
      status: "finished",
      outcome: "loss",
      isAi: false,
      createdAtMs: NOW - i * HOUR,
    })) },
    { limit: 3 },
  );
  assert.equal(capped.length, 3);
  assert.equal(DASHBOARD_ACTIVITY_LIMIT, 8);
});

test("a finished ranked match opens its review; practice stays unrated", () => {
  const [ranked] = buildRecentActivity({
    ranked: [
      {
        matchId: "abc",
        status: "finished",
        outcome: "loss",
        isAi: false,
        endedAtMs: NOW,
      },
    ],
  });
  assert.equal(ranked.href, "/solitaire/review/duel/abc");
  assert.equal(ranked.actionLabel, "Review");
  assert.equal(ranked.competitive, true);
  assert.equal(ranked.reviewable, true);

  const [practice] = buildRecentActivity({
    ranked: [
      {
        matchId: "ai-1",
        status: "finished",
        outcome: "win",
        isAi: true,
        endedAtMs: NOW,
      },
    ],
  });
  assert.equal(practice.isPractice, true);
  assert.equal(practice.competitive, false, "an AI match is never a ranked result");
});

test("only a completed game with a stored log gets a review link", () => {
  const entries = buildRecentActivity({
    solo: [
      {
        id: "done",
        completed: true,
        reviewable: true,
        moves: 80,
        createdAtMs: NOW,
      },
      {
        id: "abandoned",
        completed: false,
        reviewable: true,
        moves: 8,
        createdAtMs: NOW - 1,
      },
      {
        id: "legacy",
        completed: true,
        reviewable: false,
        moves: 80,
        createdAtMs: NOW - 2,
      },
    ],
    daily: [
      {
        id: "daily-done",
        completed: true,
        reviewable: true,
        moves: 60,
        dateKey: "2026-11-22",
        createdAtMs: NOW - 3,
      },
    ],
  });

  assert.deepEqual(
    entries.map((entry) => entry.key),
    ["solo:done", "solo:legacy", "daily:daily-done"],
    "an abandoned attempt is not activity",
  );
  assert.equal(entries[0].href, "/solitaire/review/solo/done");
  assert.equal(entries[1].href, "/solitaire");
  assert.equal(entries[1].actionLabel, "Play solo");
  assert.equal(entries[2].href, "/solitaire/review/daily/daily-done");
});

test("the fastest solve is the fastest real duration, never a zero", () => {
  assert.equal(fastestSolveMs({ bestMs: 90_000 }, { bestMs: 70_000 }), 70_000);
  assert.equal(fastestSolveMs({ bestMs: null }, { bestMs: 120_000 }), 120_000);
  assert.equal(fastestSolveMs({ bestMs: 0 }, { bestMs: 0 }), null);
  assert.equal(fastestSolveMs(null, null), null);
});

// ── 2. Recommendation ─────────────────────────────────────────────────────

test("a brand-new account is offered the Academy first", () => {
  assert.equal(
    isNewPlayer({ rankedGames: 0, soloGames: 0, dailyCompleted: 0, streakCurrent: 0 }),
    true,
  );
  assert.equal(isNewPlayer({ rankedGames: 0, soloGames: 1 }), false);
  assert.equal(isNewPlayer({ rankedGames: 2 }), false);

  const action = selectNextAction({
    newPlayer: true,
    dailyCompletedToday: false,
    rankedGames: 0,
    nowMs: NOW,
  });
  assert.equal(action.id, "academy");
  assert.equal(action.href, "/learn");
  assert.match(action.reason, /haven't played a game yet/);
});

test("the recommendation follows one fixed precedence", () => {
  const daily = selectNextAction({
    newPlayer: false,
    dailyCompletedToday: false,
    rankedGames: 0,
    nowMs: NOW,
  });
  assert.equal(daily.id, "daily");
  assert.equal(daily.href, "/daily");

  const firstRanked = selectNextAction({
    newPlayer: false,
    dailyCompletedToday: true,
    rankedGames: 0,
    nowMs: NOW,
  });
  assert.equal(firstRanked.id, "first-ranked");
  assert.equal(firstRanked.href, "/play/ranked");

  const review = selectNextAction({
    newPlayer: false,
    dailyCompletedToday: true,
    rankedGames: 4,
    recentReview: {
      kind: "ranked",
      href: "/solitaire/review/duel/m9",
      at: NOW - HOUR,
    },
    nowMs: NOW,
  });
  assert.equal(review.id, "review");
  assert.equal(review.href, "/solitaire/review/duel/m9");
  assert.match(review.title, /ranked/i);
  assert.ok(review.reason.length > 0, "every recommendation explains itself");

  const stale = selectNextAction({
    newPlayer: false,
    dailyCompletedToday: true,
    rankedGames: 4,
    recentReview: {
      kind: "solo",
      href: "/solitaire/review/solo/old",
      at: NOW - REVIEW_WINDOW_MS - 1,
    },
    nowMs: NOW,
  });
  assert.equal(stale.id, "ranked", "an old game is not \"your last game\"");

  const caughtUp = selectNextAction({
    newPlayer: false,
    dailyCompletedToday: true,
    rankedGames: 9,
    recentReview: null,
    nowMs: NOW,
  });
  assert.equal(caughtUp.id, "ranked");
});

test("the same state always produces the same recommendation", () => {
  const state = {
    newPlayer: false,
    dailyCompletedToday: true,
    rankedGames: 3,
    recentReview: { kind: "daily", href: "/solitaire/review/daily/d1", at: NOW - HOUR },
    nowMs: NOW,
  };
  assert.deepEqual(selectNextAction(state), selectNextAction({ ...state }));
});

// ── 3. Practice focus ─────────────────────────────────────────────────────

test("the weakest practiced skill becomes one validated drill link", () => {
  const focus = weakestPracticeFocus({
    bySkill: {
      "reveal-hidden-cards": { attempts: 4, completions: 1, hints: 0 },
    },
  });

  assert.ok(focus, "a 25% record is a weak skill");
  assert.equal(focus.skillId, "reveal-hidden-cards");
  assert.equal(focus.label, "Revealing hidden cards");
  assert.equal(focus.reason, "low-success");
  assert.equal(focus.detail, "a 25% completion rate across 4 attempts");
  assert.match(
    focus.href,
    /^\/learn\/practice\?skill=reveal-hidden-cards&difficulty=(beginner|intermediate|advanced)$/,
    "the deep link preselects the authored drill",
  );
});

test("a small sample or a strong record is not labelled a weakness", () => {
  assert.equal(
    weakestPracticeFocus({
      bySkill: { "reveal-hidden-cards": { attempts: 1, completions: 0, hints: 0 } },
    }),
    null,
    "one attempt is not enough to call a skill weak",
  );
  assert.equal(
    weakestPracticeFocus({
      bySkill: { "reveal-hidden-cards": { attempts: 6, completions: 6, hints: 0 } },
    }),
    null,
    "a clean record produces no drill",
  );
  assert.equal(
    weakestPracticeFocus({
      bySkill: { "not-a-real-skill": { attempts: 9, completions: 0, hints: 0 } },
    }),
    null,
    "a stale id from an older storage payload is ignored",
  );

  // The coaching report's other struggle signals still count, and each one is
  // reported as itself — never as a low completion rate.
  const hints = weakestPracticeFocus({
    bySkill: { "reveal-hidden-cards": { attempts: 3, completions: 3, hints: 3 } },
  });
  assert.equal(hints?.reason, "hint-reliance");
  assert.equal(hints?.detail, "hint use on every recorded attempt");

  const unfinished = weakestPracticeFocus({
    bySkill: { "reveal-hidden-cards": { attempts: 3, completions: 2, hints: 0 } },
  });
  assert.equal(unfinished?.reason, "unfinished");
  assert.equal(unfinished?.detail, "1 of 3 attempts left unfinished");
});

test("the practice focus is deterministic and picks the weaker skill", () => {
  const progress = {
    bySkill: {
      "reveal-hidden-cards": { attempts: 2, completions: 1, hints: 0 },
      "alternating-colors": { attempts: 3, completions: 0, hints: 0 },
    },
  };
  const first = weakestPracticeFocus(progress);
  const second = weakestPracticeFocus(progress);
  assert.deepEqual(first, second);
  assert.equal(first.skillId, "alternating-colors", "0% beats 50%");
});

test("home practice focus uses the coaching engine's weakness thresholds", () => {
  assert.equal(PRACTICE_FOCUS_MIN_ATTEMPTS, COACHING_THRESHOLDS.minAttemptsPerSkill);
  assert.equal(PRACTICE_FOCUS_LOW_SUCCESS_RATE, COACHING_THRESHOLDS.lowSuccessRate);
});

const FOCUS = {
  label: "Revealing hidden cards",
  href: "/learn/practice?skill=reveal-hidden-cards&difficulty=beginner",
  reason: "low-success",
  detail: "a 25% completion rate across 4 attempts",
};

function baseRanked() {
  return selectNextAction({
    newPlayer: false,
    dailyCompletedToday: true,
    rankedGames: 5,
    nowMs: NOW,
  });
}

test("a known weak skill replaces a generic ladder or review step", () => {
  const ranked = baseRanked();
  assert.equal(ranked.id, "ranked");

  const merged = mergePracticeFocus(ranked, FOCUS);
  assert.equal(merged.id, "practice");
  assert.equal(merged.href, FOCUS.href);
  assert.match(merged.title, /Revealing hidden cards/);
  assert.match(merged.body, /a 25% completion rate across 4 attempts/);
  assert.doesNotMatch(merged.body, /hint|unfinished|weakest/i);
  assert.match(merged.reason, /recorded attempts on this device/);
  assert.doesNotMatch(merged.body, /ranked rating will/i, "practice stays unrated");

  const review = selectNextAction({
    newPlayer: false,
    dailyCompletedToday: true,
    rankedGames: 5,
    recentReview: { kind: "solo", href: "/solitaire/review/solo/x", at: NOW - HOUR },
    nowMs: NOW,
  });
  assert.equal(review.id, "review");
  assert.equal(mergePracticeFocus(review, FOCUS).id, "practice");
});

test("onboarding and the daily habit keep priority over a practice drill", () => {
  const academy = selectNextAction({ newPlayer: true, nowMs: NOW });
  assert.equal(mergePracticeFocus(academy, FOCUS).id, "academy");

  const daily = selectNextAction({
    newPlayer: false,
    dailyCompletedToday: false,
    nowMs: NOW,
  });
  assert.equal(mergePracticeFocus(daily, FOCUS).id, "daily");

  const firstRanked = selectNextAction({
    newPlayer: false,
    dailyCompletedToday: true,
    rankedGames: 0,
    nowMs: NOW,
  });
  assert.equal(mergePracticeFocus(firstRanked, FOCUS).id, "first-ranked");
});

test("a perfect record is explained as hint use, not as a weak completion rate", () => {
  const focus = weakestPracticeFocus({
    bySkill: { "reveal-hidden-cards": { attempts: 3, completions: 3, hints: 3 } },
  });
  assert.equal(focus.reason, "hint-reliance");

  const card = mergePracticeFocus(baseRanked(), focus);
  assert.equal(card.id, "practice");
  assert.match(card.body, /hint use on every recorded attempt/);
  assert.doesNotMatch(card.body, /completion rate|weakest/i);
  assert.doesNotMatch(card.title, /weakest/i);
});

test("an unfinished drill is explained as unfinished, not as a completion rate", () => {
  const focus = weakestPracticeFocus({
    bySkill: { "reveal-hidden-cards": { attempts: 3, completions: 2, hints: 0 } },
  });
  assert.equal(focus.reason, "unfinished");

  const card = mergePracticeFocus(baseRanked(), focus);
  assert.match(card.body, /1 of 3 attempts left unfinished/);
  assert.doesNotMatch(card.body, /hint use|completion rate|weakest/i);
});

test("an absent or malformed focus never changes the recommendation", () => {
  const ranked = baseRanked();
  assert.equal(mergePracticeFocus(ranked, null), ranked);
  assert.equal(mergePracticeFocus(ranked, { ...FOCUS, href: "/phish" }).id, "ranked");
  assert.equal(mergePracticeFocus(ranked, { ...FOCUS, detail: "" }).id, "ranked");
  assert.equal(mergePracticeFocus(ranked, { ...FOCUS, label: "  " }).id, "ranked");
});

// ── 4. The API is one authenticated read ──────────────────────────────────

test("the dashboard endpoint aggregates server-side and never writes", () => {
  const route = code(read("src/app/api/home/dashboard/route.ts"));

  assert.match(route, /export async function GET/);
  assert.match(route, /await auth\(\)/, "identity comes from the session");
  assert.doesNotMatch(route, /searchParams/, "no identity or state from the URL");
  assert.doesNotMatch(route, /request\.json\(|req\.json\(/, "no request body");

  for (const source of [
    "getTotalTrophyProgressForUser",
    "getTrophiesForUser",
    "getRatingsForUser",
    "readStreakState",
    "summariseSolo",
    "summariseDaily",
    "buildRecentActivity",
    "selectNextAction",
  ]) {
    assert.match(route, new RegExp(source), `the route must reuse ${source}`);
  }

  assert.doesNotMatch(
    route,
    /\.insert\(|\.update\(|\.delete\(/,
    "a dashboard read must not write",
  );
  assert.match(route, /private, no-store/);
  assert.match(route, /status: 503/, "a failed progression read is explicit");
});

test("the home page makes one player request instead of five", () => {
  const home = code(read("src/app/PageClient.jsx"));

  assert.equal(
    (home.match(/fetch\("\/api\/home\/dashboard"/g) || []).length,
    1,
    "the dashboard is fetched exactly once",
  );
  for (const retired of [
    "/api/user-stats",
    "/api/get-user-tokens",
    "/api/solitaire-duel/lobby",
    "/api/solitaire/solo",
    "/api/solitaire/daily",
  ]) {
    assert.equal(
      home.includes(retired),
      false,
      `${retired} must not be fetched by the home dashboard any more`,
    );
  }
});

// ── 4. States and presentation contracts ──────────────────────────────────

test("guest, new-player, empty, partial and failure states all exist", () => {
  const dashboard = code(read("src/components/home/PlayerDashboard.tsx"));

  assert.match(dashboard, /function GuestPanel/);
  assert.match(dashboard, /Play a deal now/);
  assert.match(dashboard, /href="\/solitaire"/);
  assert.match(dashboard, /href="\/daily"/);
  assert.match(dashboard, /href="\/sign-up"/);
  assert.match(dashboard, /href="\/sign-in"/);

  assert.match(dashboard, /function DashboardSkeleton/);
  assert.match(dashboard, /function DashboardError/);
  assert.match(dashboard, /We couldn&apos;t load your dashboard/);
  assert.match(dashboard, /No games yet/);
  assert.match(dashboard, /No ranked matches yet/);
  assert.match(dashboard, /No solo games yet/);
  assert.match(dashboard, /Part of your dashboard didn&apos;t load/);
  assert.match(dashboard, /Recommended next/);
  assert.match(dashboard, /Why this\?/);

  // The practice drill is merged from the on-device record, not fetched.
  assert.match(dashboard, /usePracticeProgress/);
  assert.match(dashboard, /weakestPracticeFocus/);
  assert.match(dashboard, /mergePracticeFocus/);

  assert.doesNotMatch(dashboard, /fetch\(/, "the panel renders server data only");
});

test("the dashboard distinguishes ranked from practice and links reviews", () => {
  const dashboard = code(read("src/components/home/PlayerDashboard.tsx"));

  assert.match(dashboard, /Practice · unrated/);
  assert.match(dashboard, /entry\.actionLabel/);
  assert.match(dashboard, /entry\.href/);
  assert.match(dashboard, /Latest ranked change/);
});

test("the home page offers ranked as the primary action and the daily puzzle", () => {
  const home = read("src/app/PageClient.jsx");

  assert.match(home, /href="\/play\/ranked"/);
  assert.match(home, /Ranked · competitive/);
  assert.match(home, /href: "\/play\/daily-puzzle"/);
  assert.match(home, /href: "\/solitaire"/);
  assert.match(home, /href: "\/daily"/);
});
