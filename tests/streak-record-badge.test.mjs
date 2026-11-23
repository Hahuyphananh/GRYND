/**
 * streak-record-badge.test.mjs
 *
 * Pins the Phase 8 dynamic record badge:
 *   * one component, driven by the canonical `user_streaks.longest_streak`;
 *   * both profile APIs read that column (not the legacy login counters);
 *   * the badge is rendered on the owner and public profile headers;
 *   * no per-day cosmetic/ownership/claim rows are created;
 *   * longest is monotonic across a reset and same-day completion;
 *   * EN/FR/ES copy exists.
 *
 * Run: node --import tsx --test tests/streak-record-badge.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { advanceStreak } from "../src/lib/streaks/schedule.js";
import { APP_TEXT_TRANSLATIONS } from "../src/lib/appTextTranslations.js";

const read = (path) => fs.readFileSync(path, "utf8");
const component = read("src/components/profil/DailyStreakRecordBadge.tsx");
const ownerProfile = read("src/app/profil/PageClient.jsx");
const publicProfile = read("src/app/profil/[clerkId]/PageClient.tsx");
const tokenRoute = read("src/app/api/get-user-tokens/route.ts");
const publicRoute = read("src/app/api/user/public-profile/route.ts");
const playerLevelBadge = read("src/components/player-level/PlayerLevelBadge.tsx");

function resolve(locale, key) {
  return key.split(".").reduce((node, part) => node?.[part], locale);
}

test("one dynamic record badge exists and renders the best from its prop", () => {
  assert.match(component, /data-testid="daily-streak-record-badge"/);
  assert.match(component, /bestStreak: number/);
  assert.match(component, /Math\.max\(0, Math\.floor\(Number\(bestStreak\)/);
  assert.match(component, /if \(best <= 0\) return null/);
  assert.match(component, /FlameMark/);
  assert.match(component, /profile\.badges\.dailyStreakRecord/);
  assert.match(component, /profile\.info\.unitDay/);
  assert.match(component, /profile\.info\.unitDays/);
});

test("both profile APIs read the canonical user_streaks record", () => {
  for (const [name, source] of [
    ["get-user-tokens", tokenRoute],
    ["public-profile", publicRoute],
  ]) {
    assert.match(source, /userStreaks/, `${name} must read user_streaks`);
    assert.match(source, /longestStreak/, `${name} must read longest_streak`);
    assert.match(source, /streakRecordBest/, `${name} must expose the record`);
    assert.match(source, /leftJoin\(userStreaks/, `${name} must join user_streaks`);
  }

  // The owner route must pass a number through, never a raw nullable column.
  assert.match(tokenRoute, /streakRecordBest: Math\.max\(0, Number\(user\.streakRecordBest\) \|\| 0\)/);
});

test("owner and public profiles render the badge, distinct from the trophy rank", () => {
  for (const [name, source] of [
    ["owner profile", ownerProfile],
    ["public profile", publicProfile],
  ]) {
    assert.match(source, /DailyStreakRecordBadge/, `${name} must import the badge`);
    assert.match(source, /<DailyStreakRecordBadge\b/, `${name} must render the badge`);
    assert.match(source, /streakRecordBest/, `${name} must pass the canonical record`);
  }

  assert.doesNotMatch(component, /import[^\n]*PlayerLevelBadge|<PlayerLevelBadge/);
  assert.doesNotMatch(playerLevelBadge, /daily-streak-record/);
  assert.match(component, /border-amber-400/, "the record badge is amber, not the rank shield");
});

test("longest never downgrades and survives a current-streak reset", () => {
  // First completion creates the record at day 1.
  const first = advanceStreak(
    { current: 0, longest: 0, lastDate: null },
    "2026-01-01",
  );
  assert.equal(first.current, 1);
  assert.equal(first.longest, 1);

  // Current streak 7 yesterday, gap today: current resets, record stays 7.
  const reset = advanceStreak(
    { current: 7, longest: 7, lastDate: "2026-01-01" },
    "2026-01-03",
  );
  assert.equal(reset.current, 1);
  assert.equal(reset.longest, 7);

  // A second completion today is a no-op and cannot lower the record.
  const sameDay = advanceStreak(
    { current: 7, longest: 30, lastDate: "2026-01-03" },
    "2026-01-03",
  );
  assert.equal(sameDay.credited, false);
  assert.equal(sameDay.current, 7);
  assert.equal(sameDay.longest, 30);

  // A new personal record raises it exactly once.
  const record = advanceStreak(
    { current: 30, longest: 30, lastDate: "2026-01-01" },
    "2026-01-02",
  );
  assert.equal(record.current, 31);
  assert.equal(record.longest, 31);

  // A later reset cannot bring it down again.
  const afterReset = advanceStreak(
    { current: 5, longest: 31, lastDate: "2026-01-01" },
    "2026-01-04",
  );
  assert.equal(afterReset.current, 1);
  assert.equal(afterReset.longest, 31);
});

test("the writer persists the monotonic longest and stops on same-day replay", () => {
  const writer = read("src/lib/streaks/server.ts");
  assert.match(writer, /if \(!advanced\.credited\)/);
  assert.match(writer, /"longest_streak" = \$\{advanced\.longest\}/);
});

test("the badge creates no ownership, claim, or per-day records", () => {
  for (const forbidden of [
    "user_unlocks",
    "user_cosmetics",
    "user_special_titles",
    "INSERT",
    "localStorage",
  ]) {
    assert.ok(
      !component.includes(forbidden),
      `the dynamic badge must not depend on ${forbidden}`,
    );
  }

  // Comments may explain that it neither fetches nor claims; the code must
  // contain neither a request nor a claim call.
  assert.doesNotMatch(component, /\bfetch\s*\(/);
  assert.doesNotMatch(component, /\bclaim\s*\(/);
});

test("record badge copy exists in EN, FR and ES", () => {
  const expected = {
    en: {
      label: "Daily Streak Record",
      aria: "Daily Streak Record: best {count} {unit}",
    },
    fr: {
      label: "Record de série quotidienne",
      aria: "Record de série quotidienne : meilleur {count} {unit}",
    },
    es: {
      label: "Récord de racha diaria",
      aria: "Récord de racha diaria: mejor {count} {unit}",
    },
  };

  for (const [lang, copy] of Object.entries(expected)) {
    const label = resolve(APP_TEXT_TRANSLATIONS[lang], "profile.badges.dailyStreakRecord");
    const aria = resolve(
      APP_TEXT_TRANSLATIONS[lang],
      "profile.badges.dailyStreakRecordAria",
    );
    assert.equal(label, copy.label, `${lang} record badge label drifted`);
    assert.equal(aria, copy.aria, `${lang} record badge aria drifted`);

    for (const key of ["profile.info.unitDay", "profile.info.unitDays"]) {
      const value = resolve(APP_TEXT_TRANSLATIONS[lang], key);
      assert.equal(typeof value, "string", `${lang} is missing ${key}`);
      assert.ok(value.trim().length > 0, `${lang}.${key} is empty`);
    }
  }
});
