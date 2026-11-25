// tests/streak-cosmetics.test.mjs
//
// THE UTC STREAK + BOARD COSMETIC CONTRACT.
//
// Pins the rules a player is promised:
//   * a UTC calendar-day streak with no shields — a missed day resets to 1;
//   * one credit per UTC day (a second completion is a no-op);
//   * the exact milestone schedule and permanent unlocks;
//   * the post-365 loop: one pip and a 2-day PRO trial per completed 30 days;
//   * every cosmetic design exists in the registry with its milestone day;
//   * PRO means paid OR an unexpired trial;
//   * the completion routes report the streak and the server — never the client
//     — decides an unlock.
//
// Run: node --import tsx --test tests/streak-cosmetics.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  MAX_BESPOKE_DAY,
  POST_365_INTERVAL,
  POST_365_TRIAL_DAYS,
  STREAK_ITEM_IDS,
  STREAK_MILESTONES,
  advanceStreak,
  daysBetween,
  daysToNextMilestone,
  isPrestigeHit,
  msUntilUtcMidnight,
  nextMilestone,
  prestigeBadgeLabel,
  prestigeFor,
  streakDayForItem,
  unlocksForRange,
  utcDateKey,
} from "../src/lib/streaks/schedule.js";
import {
  BOARD_ITEMS,
  CARD_BACKS,
  DECK_SKINS,
  PROFILE_STREAK_ITEMS,
  boardItem,
  cardBackFor,
  deckSkinFor,
} from "../src/lib/solitaire-duel/boardCosmetics.ts";
import { BOARD_THEMES, boardThemeFor } from "../src/lib/solitaire-duel/boardThemes.ts";

const read = (path) => fs.readFileSync(path, "utf8");

// ── The UTC day ───────────────────────────────────────────────────────────

test("the streak day is the UTC calendar date, not the local one", () => {
  assert.equal(utcDateKey(new Date("2026-11-15T00:00:00Z")), "2026-11-15");
  assert.equal(utcDateKey(new Date("2026-11-15T23:59:59Z")), "2026-11-15");
  assert.equal(daysBetween("2026-11-14", "2026-11-15"), 1);

  // The countdown always points at the next 00:00 UTC.
  const left = msUntilUtcMidnight(new Date("2026-11-15T23:00:00Z"));
  assert.equal(left, 60 * 60 * 1000);
});

// ── Streak arithmetic ─────────────────────────────────────────────────────

test("a UTC day is credited once, and consecutive days extend the streak", () => {
  const first = advanceStreak({ current: 0, longest: 0, lastDate: null }, "2026-11-15");
  assert.deepEqual(first, { current: 1, longest: 1, credited: true });

  const second = advanceStreak(
    { current: 1, longest: 1, lastDate: "2026-11-15" },
    "2026-11-16",
  );
  assert.deepEqual(second, { current: 2, longest: 2, credited: true });

  // Same UTC day: nothing moves and nothing can unlock.
  const again = advanceStreak(
    { current: 2, longest: 2, lastDate: "2026-11-16" },
    "2026-11-16",
  );
  assert.equal(again.credited, false);
  assert.equal(again.current, 2);
});

test("a missed UTC day resets the streak to 1 — there is no shield", () => {
  const missed = advanceStreak(
    { current: 42, longest: 42, lastDate: "2026-11-15" },
    "2026-11-17",
  );
  assert.equal(missed.current, 1);
  assert.equal(missed.credited, true);
  // The all-time best is never reduced.
  assert.equal(missed.longest, 42);
});

// ── Milestones ────────────────────────────────────────────────────────────

test("the milestone schedule is the promised one", () => {
  const byDay = new Map(STREAK_MILESTONES.map((m) => [m.day, m.items]));
  assert.deepEqual(byDay.get(3), ["felt_slate"]);
  assert.deepEqual(byDay.get(7), ["card_back_carbon"]);
  assert.equal(STREAK_MILESTONES.find((m) => m.day === 7).proTrialDays, 3);
  assert.deepEqual(byDay.get(14), ["badge_flame_14", "glow_streak_ember"]);
  assert.deepEqual(byDay.get(30), [
    "felt_royal_emerald",
    "card_back_emerald_gold",
    "username_streak_emerald",
  ]);
  assert.deepEqual(byDay.get(60), ["felt_midnight_navy", "glow_streak_frost"]);
  assert.deepEqual(byDay.get(100), [
    "title_centurion",
    "card_back_centurion",
    "username_streak_centurion",
  ]);
  assert.deepEqual(byDay.get(180), [
    "deck_grandmaster",
    "badge_flame_blue",
    "glow_streak_electric",
  ]);
  assert.deepEqual(byDay.get(275), [
    "felt_crimson_velvet",
    "card_back_crimson_monogram",
    "username_streak_crimson",
  ]);
  assert.deepEqual(byDay.get(365), [
    "felt_eternal_obsidian",
    "card_back_eternal",
    "frame_eternal",
    "badge_365_plus",
    "glow_streak_eternal",
  ]);
});

test("crossing a milestone unlocks only what was crossed", () => {
  assert.deepEqual(unlocksForRange(2, 3), ["felt_slate"]);
  assert.deepEqual(unlocksForRange(6, 7), ["card_back_carbon"]);
  // A jump over several milestones grants each one.
  assert.equal(unlocksForRange(0, 30).includes("felt_slate"), true);
  assert.equal(unlocksForRange(0, 30).includes("card_back_emerald_gold"), true);
  // A reset grants nothing on the way down, and nothing twice on the way back.
  assert.deepEqual(unlocksForRange(27, 1), []);
  assert.deepEqual(unlocksForRange(30, 45), []);
});

test("the next milestone and the days to it are derived, not stored", () => {
  assert.deepEqual(nextMilestone(2), { day: 3, items: ["felt_slate"] });
  assert.equal(daysToNextMilestone(2), 1);
  assert.equal(nextMilestone(365), null);
  assert.equal(daysToNextMilestone(500), null);
});

test("after Day 365 every completed 30-day loop adds a pip and a 2-day trial", () => {
  assert.equal(MAX_BESPOKE_DAY, 365);
  assert.equal(POST_365_INTERVAL, 30);
  assert.equal(POST_365_TRIAL_DAYS, 2);
  assert.equal(isPrestigeHit(365), false);
  assert.equal(isPrestigeHit(395), true);
  assert.equal(isPrestigeHit(396), false);
  assert.equal(isPrestigeHit(425), true);
  assert.equal(prestigeFor(365), 0);
  assert.equal(prestigeFor(395), 1);
  assert.equal(prestigeFor(425), 2);
  assert.equal(prestigeBadgeLabel(425, 2), "365+ ★2");
  assert.equal(prestigeBadgeLabel(300, 0), "365+");
});

test("every schedule item is unique and has its day", () => {
  assert.equal(new Set(STREAK_ITEM_IDS).size, STREAK_ITEM_IDS.length);
  assert.equal(streakDayForItem("deck_grandmaster"), 180);
  assert.equal(streakDayForItem("badge_365_plus"), 365);
  assert.equal(streakDayForItem("not_an_item"), null);
});

// ── The cosmetic registry ─────────────────────────────────────────────────

test("every felt design exists on the board catalog with its streak day", () => {
  const felts = {
    felt_slate: 3,
    felt_royal_emerald: 30,
    felt_midnight_navy: 60,
    felt_crimson_velvet: 275,
    felt_eternal_obsidian: 365,
  };
  for (const [key, day] of Object.entries(felts)) {
    const theme = BOARD_THEMES.find((entry) => entry.key === key);
    assert.ok(theme, `${key} must be a board theme`);
    assert.equal(theme.streakDay, day);
    assert.match(theme.felt, /gradient/);
  }
  // The schema default means "no choice" and resolves to Classic Green.
  assert.equal(boardThemeFor("felt_default").key, "classic");
});

test("every card back and deck skin is a pure-CSS design", () => {
  const days = {
    card_back_default: 0,
    card_back_carbon: 7,
    card_back_emerald_gold: 30,
    card_back_centurion: 100,
    card_back_crimson_monogram: 275,
    card_back_eternal: 365,
  };
  for (const [key, day] of Object.entries(days)) {
    const back = CARD_BACKS.find((entry) => entry.key === key);
    assert.ok(back, `${key} must exist`);
    assert.equal(back.streakDay, day);
    assert.match(back.background, /gradient/);
    assert.match(back.border, /^#|rgba/);
  }
  // The luxury back carries a CSS animation SHORTHAND (keyframes + timing).
  assert.match(CARD_BACKS.find((b) => b.key === "card_back_eternal").animation, /sol-shimmer/);

  assert.equal(DECK_SKINS.find((d) => d.key === "deck_grandmaster").streakDay, 180);
  assert.equal(DECK_SKINS.find((d) => d.key === "deck_grandmaster").crest, "♛");
  assert.equal(deckSkinFor("nonsense").key, "deck_default");
  assert.equal(cardBackFor(null).key, "card_back_default");
});

test("profile rewards keep their promised days", () => {
  const byId = new Map(PROFILE_STREAK_ITEMS.map((item) => [item.id, item.streakDay]));
  assert.equal(byId.get("badge_flame_14"), 14);
  assert.equal(byId.get("glow_streak_ember"), 14);
  assert.equal(byId.get("username_streak_emerald"), 30);
  assert.equal(byId.get("glow_streak_frost"), 60);
  assert.equal(byId.get("title_centurion"), 100);
  assert.equal(byId.get("username_streak_centurion"), 100);
  assert.equal(byId.get("badge_flame_blue"), 180);
  assert.equal(byId.get("glow_streak_electric"), 180);
  assert.equal(byId.get("username_streak_crimson"), 275);
  assert.equal(byId.get("glow_streak_eternal"), 365);
  assert.equal(byId.get("frame_eternal"), 365);
  assert.equal(byId.get("badge_365_plus"), 365);
});

test("board items cover the three slots with no duplicate id", () => {
  const ids = BOARD_ITEMS.map((item) => item.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.includes("felt_slate") && ids.includes("card_back_carbon") && ids.includes("deck_grandmaster"));
  assert.equal(boardItem("felt_slate").kind, "felt");
  assert.equal(boardItem("card_back_carbon").kind, "card_back");
  assert.equal(boardItem("deck_grandmaster").kind, "deck_skin");
  assert.equal(boardItem("unknown"), null);
});

// ── Server authority ──────────────────────────────────────────────────────

test("the engine locks the row, grants once, and refuses shields", () => {
  const engine = read("src/lib/streaks/server.ts");
  assert.match(engine, /for update of s/);
  assert.match(engine, /on conflict \("user_id"\) do nothing/);
  assert.match(engine, /userUnlocks/);
  assert.match(engine, /greatest\(coalesce\("pro_trial_expires_at", now\(\)\), now\(\)\)/);
  // No branch preserves a streak across a missed day (comments excluded: the
  // header states the no-shield rule, it does not implement one).
  const engineCode = engine.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(engineCode, /shield/i);
});

test("PRO is a paid subscription OR an unexpired trial", () => {
  const pro = read("src/lib/proStatus.ts");
  assert.match(pro, /hasActiveProTrial/);
  const subs = read("src/lib/stripe/subscriptions.ts");
  assert.match(subs, /hasActiveProTrial\(clerkId\)/);
  const trial = read("src/lib/streaks/trial.ts");
  assert.match(trial, /pro_trial_expires_at.*>.*\$\{now\}/s);
});

test("both completion routes report the streak and unlock list", () => {
  const daily = read("src/app/api/solitaire/daily/route.ts");
  assert.match(daily, /recordStreakCompletion\(userId\)/);
  assert.match(daily, /current_streak:/);
  assert.match(daily, /newly_unlocked_rewards:/);
  assert.match(daily, /next_milestone:/);

  const move = read("src/app/api/solitaire-duel/match/[matchId]/move/route.ts");
  assert.match(move, /recordStreakCompletion\(userId\)/);
  assert.match(move, /newly_unlocked_rewards:/);
});

test("the equip route validates the streak unlock server-side", () => {
  const route = read("src/app/api/cosmetics/equip/route.ts");
  assert.match(route, /equipBoardCosmetic/);
  assert.match(route, /"felt" \|\| category === "card_back" \|\| category === "deck_skin"/);
  const engine = read("src/lib/streaks/server.ts");
  assert.match(engine, /ownsStreakItem/);
  assert.match(engine, /Unlock this at a/);
});

test("the streak endpoint and migration exist", () => {
  assert.ok(fs.existsSync("src/app/api/streaks/me/route.ts"));
  const migration = read("src/db/migrations/0262_streaks_board_cosmetics.sql");
  for (const needle of [
    'CREATE TABLE IF NOT EXISTS "user_streaks"',
    '"current_streak"',
    '"longest_streak"',
    '"last_completed_utc_date"',
    '"initial_pro_trial_claimed"',
    '"pro_trial_expires_at"',
    '"prestige_pips"',
    'CREATE TABLE IF NOT EXISTS "user_unlocks"',
    '"equipped_felt"',
    '"equipped_card_back"',
    '"equipped_deck_skin"',
    "ENABLE ROW LEVEL SECURITY",
  ]) {
    assert.ok(migration.includes(needle), `migration must contain ${needle}`);
  }
});

// ── Surfaces ──────────────────────────────────────────────────────────────

test("the board paints the cosmetics and offers the drawer", () => {
  const board = read("src/components/solitaire-duel/SolitaireBoard.tsx");
  assert.match(board, /useSolitaireBoardCosmetics/);
  assert.match(board, /--sol-card-back-image/);
  assert.match(board, /--sol-deck-crest/);
  assert.match(board, /BoardAppearanceDrawer/);

  const card = read("src/components/solitaire-duel/PlayingCard.tsx");
  assert.match(card, /sol-card-back/);
  assert.match(card, /sol-face-card/);
});

test("the streak surfaces carry their test ids and guest copy", () => {
  // The duplicate flame chip is gone: the daily-streak card is the one surface.
  assert.doesNotMatch(read("src/components/SiteChrome.tsx"), /StreakChip/);
  assert.match(read("src/components/streaks/StreakUnlockModal.tsx"), /data-testid="streak-unlock-modal"/);
  const guest = read("src/components/streaks/GuestStreakPrompt.tsx");
  assert.match(guest, /data-testid="guest-streak-prompt"/);
  assert.match(guest, /Day 1 streak/);
  assert.match(read("src/components/solitaire/BoardAppearanceDrawer.tsx"), /Unlock at \$\{streakDay\}-day streak/);
});
