/**
 * streak-milestones.test.mjs
 *
 * The daily token reward is retired; the daily STREAK is not. These tests pin
 * the replacement contract:
 *
 *   1. The existing milestone thresholds still resolve to their titles, and the
 *      title/progress arithmetic lives in ONE utility (lib/streakTitles).
 *   2. Next-milestone progress and achieved/next states are calculated from the
 *      same utility, never re-derived per surface.
 *   3. The streak is credited by FINISHING A GAME. The read API is GET-only and
 *      has no claim, so a page visit cannot advance it.
 *   4. Both streak surfaces render the current/best streak, title, next
 *      milestone and progress, and hold no reward claim or token amount.
 *   5. No retired daily-reward module, endpoint or client call remains.
 *
 * Run: npm run test:streak-milestones
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  getAllStreakTitles,
  getNextStreakMilestone,
  getStreakMilestoneState,
  getStreakTitle,
} from "../src/lib/streakTitles.js";
import {
  daysBetween,
  projectDailyStreakDay,
  toDateStr,
} from "../src/lib/dailyStreak.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const MODULE_MOCKING_AVAILABLE = typeof mock?.module === "function";
const SKIP_REASON = MODULE_MOCKING_AVAILABLE
  ? false
  : "module mocking is off — run: npm run test:streak-milestones";

const ROUTE = "src/app/api/user/daily-streak/route.js";
const HOOK = "src/hooks/useDailyStreak.ts";
const WIDGET = "src/components/StreakWidget.tsx";
const BOARD = "src/components/StreakMilestonesBoard.tsx";
const CARD = "src/components/StreakMilestonesCard.tsx";
const ENGINE = "src/lib/streaks/server.ts";
const STREAK_LIB = "src/lib/dailyStreak.js";

test("one completion per day: several games on the same day count once", () => {
  // Built from LOCAL calendar parts, the way the streak columns are keyed.
  const today = new Date(2026, 10, 19, 12, 0, 0);

  // Already credited today → the stored day is what the next completion sees.
  assert.equal(
    projectDailyStreakDay({ lastLoginDate: "2026-11-19", current: 6 }, today),
    6,
  );

  // The shared writer is idempotent for the same local day...
  assert.match(
    read(STREAK_LIB),
    /if \(user\.lastLoginDate === todayStr\)[\s\S]*?updated: false/,
  );
  // ...and the milestone engine also refuses to credit the same UTC day twice.
  assert.match(read(ENGINE), /if \(!advanced\.credited\)/);
});

test("a missed day resets the current streak and keeps the best", () => {
  const today = new Date(2026, 10, 19, 12, 0, 0);

  // Credited yesterday → the next day.
  assert.equal(
    projectDailyStreakDay({ lastLoginDate: "2026-11-18", current: 6 }, today),
    7,
  );
  // A longer gap → back to day 1.
  assert.equal(
    projectDailyStreakDay({ lastLoginDate: "2026-11-15", current: 9 }, today),
    1,
  );

  // The stored best is a high-water mark: a reset can never lower it.
  assert.match(
    read(STREAK_LIB),
    /const newDailyBest = Math\.max\(Number\(user\.dailyStreakBest\) \|\| 0, newDailyCurrent\)/,
  );
  assert.match(read(STREAK_LIB), /dailyStreakBest: newDailyBest/);
});

test("an existing streak shield still absorbs exactly one missed day", () => {
  const today = new Date(2026, 10, 19, 12, 0, 0);

  assert.equal(
    projectDailyStreakDay(
      { lastLoginDate: "2026-11-17", current: 9, shieldAvailable: true },
      today,
    ),
    9,
  );
  // The shield is CONSUMED by the write path, not by any read surface.
  assert.match(read(STREAK_LIB), /await consumeItem\(user\.id, "streak_shield", 1\)/);
  assert.doesNotMatch(stripComments(read(HOOK)), /consumeItem|streak_shield/);
});

test("date arithmetic is whole-day and DST-safe", () => {
  assert.equal(daysBetween("2026-11-18", "2026-11-19"), 1);
  assert.equal(daysBetween("2026-11-15", "2026-11-19"), 4);
  assert.equal(daysBetween("2026-03-07", "2026-03-09"), 2); // US spring-forward
  assert.equal(daysBetween("2026-10-31", "2026-11-01"), 1);

  assert.equal(toDateStr(new Date(2026, 10, 19, 12, 0, 0)), "2026-11-19");
  assert.equal(toDateStr("2026-11-19T23:59:00.000Z"), "2026-11-19");
  assert.equal(toDateStr(null), null);
});

const EXPECTED_MILESTONES = [
  { days: 1, title: "Daily Visitor" },
  { days: 3, title: "Loyal Player" },
  { days: 5, title: "Card Collector" },
  { days: 7, title: "Weekly Winner" },
  { days: 10, title: "Streak Starter" },
  { days: 14, title: "Lucky Regular" },
  { days: 21, title: "Dedicated Roller" },
  { days: 30, title: "Monthly Champion" },
  { days: 45, title: "Prize Chaser" },
  { days: 60, title: "Veteran" },
  { days: 75, title: "Lucky Legend" },
  { days: 100, title: "Streak Master" },
  { days: 150, title: "Vault Elite" },
  { days: 200, title: "Milestone Grinder" },
  { days: 365, title: "King" },
];

// ── Thresholds and titles ────────────────────────────────────────────────────

test("every milestone threshold keeps its title and ordering", () => {
  assert.deepEqual(getAllStreakTitles(), EXPECTED_MILESTONES);

  for (const milestone of EXPECTED_MILESTONES) {
    assert.equal(getStreakTitle(milestone.days), milestone.title);
  }

  // The retired token naming is gone from the ladder.
  assert.ok(
    !EXPECTED_MILESTONES.some((m) => /token/i.test(m.title)),
    "no streak title may reference the retired token reward",
  );
});

test("the title is the highest milestone reached", () => {
  assert.equal(getStreakTitle(0), null);
  assert.equal(getStreakTitle(-4), null);
  assert.equal(getStreakTitle(1), "Daily Visitor");
  assert.equal(getStreakTitle(2), "Daily Visitor");
  assert.equal(getStreakTitle(4), "Loyal Player");
  assert.equal(getStreakTitle(5), "Card Collector");
  assert.equal(getStreakTitle(13), "Streak Starter");
  assert.equal(getStreakTitle(14), "Lucky Regular");
  assert.equal(getStreakTitle(364), "Milestone Grinder");
  assert.equal(getStreakTitle(365), "King");
  assert.equal(getStreakTitle(10_000), "King");
});

test("the next milestone and the remaining days are calculated correctly", () => {
  assert.deepEqual(getNextStreakMilestone(0), { days: 1, title: "Daily Visitor" });
  assert.deepEqual(getNextStreakMilestone(1), { days: 3, title: "Loyal Player" });
  assert.deepEqual(getNextStreakMilestone(12), { days: 14, title: "Lucky Regular" });
  assert.deepEqual(getNextStreakMilestone(13), { days: 14, title: "Lucky Regular" });
  assert.deepEqual(getNextStreakMilestone(14), { days: 21, title: "Dedicated Roller" });
  assert.equal(getNextStreakMilestone(365), null);
});

test("milestone progress is one shared calculation", () => {
  const at12 = getStreakMilestoneState(12);
  assert.equal(at12.current, 12);
  assert.equal(at12.title, "Streak Starter");
  assert.deepEqual(at12.nextMilestone, { days: 14, title: "Lucky Regular" });
  assert.equal(at12.daysRemaining, 2);
  assert.equal(at12.progress, 12 / 14);
  assert.equal(at12.milestones.length, EXPECTED_MILESTONES.length);
  assert.equal(
    at12.milestones.filter((m) => m.achieved).length,
    5,
    "days 1, 3, 5, 7 and 10 are achieved at a 12-day streak",
  );
  assert.deepEqual(
    at12.milestones.filter((m) => m.isNext).map((m) => m.days),
    [14],
  );
  assert.equal(at12.milestones.at(-1).achieved, false);

  const fresh = getStreakMilestoneState(0);
  assert.equal(fresh.title, null);
  assert.equal(fresh.nextMilestone.days, 1);
  assert.equal(fresh.daysRemaining, 1);
  assert.equal(fresh.progress, 0);
  assert.equal(fresh.milestones.filter((m) => m.achieved).length, 0);

  const complete = getStreakMilestoneState(365);
  assert.equal(complete.title, "King");
  assert.equal(complete.nextMilestone, null);
  assert.equal(complete.daysRemaining, 0);
  assert.equal(complete.progress, 1);
  assert.ok(complete.milestones.every((m) => m.achieved));

  // Non-numeric input can never produce a fractional or negative streak.
  assert.equal(getStreakMilestoneState("12").current, 12);
  assert.equal(getStreakMilestoneState(NaN).current, 0);
  assert.equal(getStreakMilestoneState(-9).current, 0);
});

// ── The read API and the one write path ─────────────────────────────────────

test("the streak read API is GET-only and never claims or advances", () => {
  const route = read(ROUTE);
  const code = stripComments(route);

  assert.match(code, /export async function GET\(\)/);
  assert.doesNotMatch(code, /export async function POST/);
  assert.doesNotMatch(code, /updateDailyStreak|claim|lastDailyRewardClaimed/);
  assert.match(code, /getStreakMilestoneState/);
  assert.match(code, /Cache-Control/);

  assert.ok(
    !existsSync(join(root, "src/app/api/rewards/daily/route.ts")),
    "the retired reward endpoint must not exist",
  );
});

test("the client hook only reads the streak", () => {
  const hook = read(HOOK);
  const code = stripComments(hook);

  assert.match(code, /fetch\("\/api\/user\/daily-streak", \{ cache: "no-store" \}\)/);
  assert.doesNotMatch(code, /method: "POST"/);
  assert.doesNotMatch(code, /\/api\/rewards\/daily/);
  assert.doesNotMatch(code, /claim/);
});

test("finishing a game is the only thing that advances the streak", () => {
  const engine = read(ENGINE);
  // The authoritative completion writer credits the shared streak day...
  assert.match(engine, /await updateDailyStreak\(clerkId\)/);

  // ...and every completion route goes through that writer.
  for (const route of [
    "src/app/api/solitaire/solo/route.ts",
    "src/app/api/solitaire/daily/route.ts",
    "src/app/api/solitaire-duel/match/[matchId]/move/route.ts",
  ]) {
    assert.match(
      read(route),
      /recordStreakCompletion\(userId\)/,
      `${route} must credit the streak through the shared completion writer`,
    );
  }

  // No page render or read path calls the writer.
  for (const surface of [ROUTE, HOOK, WIDGET, CARD]) {
    assert.doesNotMatch(stripComments(read(surface)), /updateDailyStreak/);
  }
});

test("no retired daily-reward module or client call remains", () => {
  for (const path of [
    "src/lib/tokens/dailyReward.ts",
    "src/lib/dailyRewardCycle.ts",
    "src/lib/dailyRewardWin.ts",
    "src/lib/practiceWin.ts",
    "src/lib/practiceWinClient.ts",
    "src/hooks/useDailyReward.ts",
    "src/components/DailyRewardWidget.tsx",
    "src/components/DailyRewardCard.tsx",
    "src/components/DailyRewardBoard.tsx",
  ]) {
    assert.equal(existsSync(join(root, path)), false, `${path} must be deleted`);
  }

  for (const path of [
    WIDGET,
    CARD,
    "src/app/rewards/PageClient.tsx",
    "src/app/PageClient.jsx",
    "src/lib/games/economy.ts",
    "src/app/api/solitaire/solo/route.ts",
    "src/components/result/PvpResultScreen.jsx",
  ]) {
    const code = stripComments(read(path));
    assert.doesNotMatch(
      code,
      /DailyReward|dailyReward|daily-reward|DAILY_REWARD|last_won_game_date|markDailyRewardWin/,
      `${path} must not reference the retired reward`,
    );
  }
});

// ── Surfaces ────────────────────────────────────────────────────────────────

test("the widget is compact, dismissible and mounted once on the home page", () => {
  const widget = read(WIDGET);
  assert.match(widget, /data-testid="streak-widget"/);
  assert.match(widget, /data-testid="streak-widget-dismiss"/);
  assert.match(widget, /if \(!isLoaded \|\| !isSignedIn\) return null;/);
  assert.match(widget, /md:fixed/);
  assert.match(widget, /md:right-4/);
  assert.match(
    widget,
    /md:top-\[calc\(var\(--safe-top,0px\)_\+_112px\)\]/,
    "the fixed offset must clear the navbar AND its safe-area padding",
  );
  assert.match(widget, /md:z-30/);
  assert.match(widget, /mt-3 px-4 md:mt-0 md:px-0/);
  assert.match(widget, /FlameMark/);
  assert.match(widget, /data-testid="streak-widget-open"/);
  assert.match(widget, /<StreakMilestonesBoard/);
  assert.doesNotMatch(widget, /fetch\(/);

  const home = read("src/app/PageClient.jsx");
  const renders = home.match(/<StreakWidget\s*\/>/g) || [];
  assert.equal(renders.length, 1, "the home page mounts the widget exactly once");
  assert.ok(
    home.indexOf("<NavigationBar") < home.indexOf("<StreakWidget />"),
    "the widget follows the navbar so its inline layout starts at the top",
  );
});

test("the streak popup is the milestone board, not a reward board", async () => {
  const board = stripComments(read(BOARD));

  // It is a real dialog with the same escape/scroll/focus behaviour as the
  // retired board, portalled above the fixed navbar.
  assert.match(board, /createPortal/);
  assert.match(board, /role="dialog"/);
  assert.match(board, /aria-modal="true"/);
  assert.match(board, /event\.key === "Escape"/);
  assert.match(board, /document\.body\.style\.overflow/);

  // It renders the server's milestone ladder and nothing payable.
  assert.match(board, /MilestoneGrid milestones=\{streak\.milestones\}/);
  assert.doesNotMatch(board, /fetch\(|IconCoins|daily reward|token reward/i);
  assert.doesNotMatch(board, /claim|coins/i);

  const React = (await import("react")).default;
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { MilestoneGrid } = await import("../src/components/StreakMilestonesBoard.tsx");
  const STATUS = getStreakMilestoneState(12);
  const grid = renderToStaticMarkup(
    React.createElement(MilestoneGrid, { milestones: STATUS.milestones }),
  );

  for (const milestone of EXPECTED_MILESTONES) {
    assert.match(grid, new RegExp(`Day ${milestone.days}`));
    assert.ok(grid.includes(milestone.title), `${milestone.title} must render`);
  }
  assert.match(grid, /data-state="achieved"/);
  assert.match(grid, /data-state="next"/);
  assert.match(grid, /data-state="locked"/);
  assert.match(grid, /data-testid="streak-board-day-365"/);
  assert.doesNotMatch(grid, /claim|coins/i);
});

test("the /rewards page hosts the milestone card, not a reward claim", () => {
  const page = stripComments(read("src/app/rewards/PageClient.tsx"));
  assert.match(page, /<StreakMilestonesCard \/>/);
  assert.doesNotMatch(page, /DailyReward|daily reward|\/api\/rewards\/daily/i);
});

// ── What the surfaces render ────────────────────────────────────────────────

test("both surfaces render the streak, title, next milestone and progress", { skip: SKIP_REASON }, async (t) => {
  const WORLD = {
    isLoaded: true,
    isSignedIn: true,
    streak: null,
    loading: false,
    error: null,
    load: async () => {},
  };

  t.mock.module("../src/hooks/useDailyStreak.ts", {
    namedExports: {
      useDailyStreak: () => WORLD,
    },
  });

  const React = (await import("react")).default;
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { default: StreakWidget } = await import("../src/components/StreakWidget.tsx");
  const { default: StreakMilestonesCard } = await import(
    "../src/components/StreakMilestonesCard.tsx"
  );

  const renderWidget = () => renderToStaticMarkup(React.createElement(StreakWidget));
  const renderCard = () =>
    renderToStaticMarkup(React.createElement(StreakMilestonesCard));

  const STATUS = getStreakMilestoneState(12);
  const STREAK = {
    current: 12,
    best: 21,
    weeklyCurrent: 4,
    weeklyBest: 9,
    title: STATUS.title,
    nextMilestone: STATUS.nextMilestone,
    daysRemaining: STATUS.daysRemaining,
    progress: STATUS.progress,
    milestones: STATUS.milestones,
    lastCompletedDate: "2026-11-18",
    shieldAvailable: true,
  };

  // Signed out (or session unresolved) → nothing in the corner.
  Object.assign(WORLD, { isLoaded: true, isSignedIn: false });
  assert.equal(renderWidget(), "");
  assert.match(renderCard(), /Sign in/);
  Object.assign(WORLD, { isLoaded: false, isSignedIn: false });
  assert.equal(renderWidget(), "");
  assert.match(renderCard(), /Loading your streak/);

  // Signed in → streak, title, best, next milestone, remaining days, progress.
  Object.assign(WORLD, { isLoaded: true, isSignedIn: true, streak: STREAK });
  const widget = renderWidget();
  assert.match(widget, /Daily Streak/);
  assert.match(widget, /data-testid="daily-streak-count"/);
  assert.match(widget, />12</);
  assert.match(widget, /Streak Starter/);
  assert.match(widget, /Best 21 days/);
  assert.match(widget, /14 days — Lucky Regular/);
  assert.match(widget, /2 days to go/);
  assert.match(widget, /12\/14/);
  assert.match(widget, /role="progressbar"/);
  assert.match(widget, /Shield ready/);
  assert.match(widget, /data-testid="streak-widget-open"/);
  assert.match(widget, /View milestones/);
  assert.doesNotMatch(widget, /claim|coins/i);

  const card = renderCard();
  assert.match(card, /Streak Milestones/);
  assert.match(card, /Current streak/);
  assert.match(card, /Best streak/);
  assert.match(card, /Current title/);
  assert.match(card, /Next milestone/);
  assert.match(card, /14 days — Lucky Regular/);
  assert.match(card, /2 more days to reach it/);
  assert.match(card, /data-state="next"/);
  assert.match(card, /data-state="achieved"/);
  assert.doesNotMatch(card, /claim|coins/i);

  // A failed read stays honest and offers a retry; it invents no reward.
  Object.assign(WORLD, { streak: null, error: "We couldn't load your streak." });
  assert.match(renderWidget(), /Try again/);
  assert.doesNotMatch(renderWidget(), /days to go/);
  assert.match(renderCard(), /Try again/);
});
