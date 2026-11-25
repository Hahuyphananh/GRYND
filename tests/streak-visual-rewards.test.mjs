/**
 * streak-visual-rewards.test.mjs
 *
 * Pins the Phase 10 reward flow:
 *   * profile_glow / username_effect entries are on the existing milestones;
 *   * 0266 catalogues them as streak-only and the journal runs it;
 *   * the writer mirrors them into user_cosmetics without touching ownership;
 *   * grant-all still skips them and equip still checks user_unlocks;
 *   * /rewards previews them and the profile/picker equip + render them;
 *   * EN/FR/ES copy exists, with no external image asset claimed.
 *
 * Run: node --import tsx --test tests/streak-visual-rewards.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  STREAK_MILESTONES,
  itemsForDay,
  streakDayForItem,
  unlocksForRange,
} from "../src/lib/streaks/schedule.js";
import {
  PROFILE_STREAK_ITEMS,
  profileStreakItem,
} from "../src/lib/solitaire-duel/boardCosmetics.ts";
import { APP_TEXT_TRANSLATIONS } from "../src/lib/appTextTranslations.js";

const read = (path) => fs.readFileSync(path, "utf8");
const schedule = read("src/lib/streaks/schedule.js");
const server = read("src/lib/streaks/server.ts");
const cosmetics = read("src/lib/cosmetics.ts");
const migration = read("src/db/migrations/0266_streak_visual_rewards.sql");
const journal = JSON.parse(read("src/db/migrations/meta/_journal.json"));
const api = read("src/app/api/streaks/me/route.ts");
const card = read("src/components/StreakMilestonesCard.tsx");
const unlock = read("src/components/streaks/StreakUnlockModal.tsx");
const picker = read("src/components/ChooseFrameModal.jsx");
const owner = read("src/app/profil/PageClient.jsx");
const publicProfile = read("src/app/profil/[clerkId]/PageClient.tsx");
const css = read("src/app/globals.css");

const NEW_REWARDS = {
  glow_streak_ember: { day: 14, category: "profile_glow" },
  username_streak_emerald: { day: 30, category: "username_effect" },
  glow_streak_frost: { day: 60, category: "profile_glow" },
  username_streak_centurion: { day: 100, category: "username_effect" },
  glow_streak_electric: { day: 180, category: "profile_glow" },
  username_streak_crimson: { day: 275, category: "username_effect" },
  glow_streak_eternal: { day: 365, category: "profile_glow" },
};

function resolve(locale, key) {
  return key.split(".").reduce((node, part) => node?.[part], locale);
}

test("the existing milestones now include the visual rewards at the right days", () => {
  for (const [id, reward] of Object.entries(NEW_REWARDS)) {
    assert.equal(streakDayForItem(id), reward.day, `${id} day`);
    assert.ok(itemsForDay(reward.day).includes(id), `${id} must be on day ${reward.day}`);
    const item = profileStreakItem(id);
    assert.ok(item, `${id} must resolve as a profile reward`);
    assert.equal(item.kind, reward.category, `${id} category`);
    assert.equal(item.streakDay, reward.day);
  }

  // Crossing a milestone grants only that day's new item; re-crossing is a no-op.
  assert.ok(unlocksForRange(13, 14).includes("glow_streak_ember"));
  assert.ok(!unlocksForRange(13, 13).includes("glow_streak_ember"));
  assert.ok(unlocksForRange(29, 30).includes("username_streak_emerald"));
  assert.deepEqual(unlocksForRange(14, 14), []);
  assert.equal(new Set(PROFILE_STREAK_ITEMS.map((item) => item.id)).size, PROFILE_STREAK_ITEMS.length);
});

test("0266 catalogues both categories as streak-only, with no missing artwork claim", () => {
  for (const [id, reward] of Object.entries(NEW_REWARDS)) {
    assert.ok(migration.includes(`'${id}'`), `0266 must insert ${id}`);
    assert.ok(migration.includes(reward.category), `${id} category`);
    assert.match(migration, /"streak_only"/);
    assert.match(migration, /"unlock_streak_day"/);
    assert.match(migration, /"price_tokens" = NULL/);
  }

  assert.match(migration, /"visual"/);
  assert.match(migration, /"cssClass"/);
  assert.doesNotMatch(migration, /\.png|\.jpg|https?:\/\//i, "no external artwork is claimed");
  assert.match(css, /streak-glow-ember/);
  assert.match(css, /streak-name-emerald/);

  const entry = journal.entries.find((row) => row.tag === "0266_streak_visual_rewards");
  assert.ok(entry, "0266 must be journaled or db:migrate skips it");
  assert.equal(entry.idx, 247);
});

test("milestone granting mirrors profile categories, preserves ownership, and is idempotent", () => {
  assert.match(server, /profileStreakItem\(itemId\)/);
  assert.match(server, /insert\(userCosmetics\)/);
  assert.match(server, /source: "streak"/);
  assert.match(server, /onConflictDoNothing/);
  assert.doesNotMatch(server, /delete\(userUnlocks\)|userCosmetics\).*delete/i);
  assert.ok(schedule.includes("glow_streak_ember"));
  assert.ok(schedule.includes("username_streak_emerald"));
});

test("mass grant still excludes streak-only rows and equip still validates the unlock", () => {
  assert.match(cosmetics, /c\."streak_only" = FALSE/);
  assert.match(cosmetics, /catalog\.streakOnly/);
  assert.match(cosmetics, /userUnlocks\.itemId/);
  assert.match(cosmetics, /Unlock this at a/);
  assert.match(cosmetics, /userCosmetics/);
});

test("the rewards page receives visuals and previews both new categories", () => {
  assert.match(api, /getEnabledCosmetics/);
  assert.match(api, /visualByKey/);
  assert.match(api, /visual: visualByKey\.get\(id\)/);
  assert.match(card, /cosmeticEffectClass/);
  assert.match(card, /streak-reward-preview/);
  assert.match(card, /profile\.streakRewards\./);
  assert.match(card, /item\.kind === "profile_glow"/);
  assert.match(card, /item\.kind === "username_effect"/);
});

test("profile renderers apply both effects and let the glow own the card shadow", () => {
  for (const [name, source] of [
    ["owner", owner],
    ["public", publicProfile],
  ]) {
    assert.match(source, /profileGlowClass/, `${name} profile glow`);
    assert.match(source, /usernameEffectClass/, `${name} username effect`);
    assert.match(source, /cosmeticEffectClass/, `${name} catalog visual resolver`);
    assert.match(
      source,
      /boxShadow: profileGlowClass\s*\?\s*undefined/,
      `${name} must not override the equipped glow`,
    );
  }
  assert.match(css, /streak-glow-frost/);
  assert.match(css, /streak-glow-electric/);
  assert.match(css, /streak-name-centurion/);
  assert.match(css, /prefers-reduced-motion/);
});

test("rewards and the shared picker equip and unequip through the existing API", () => {
  assert.match(unlock, /profileStreakItem/);
  assert.match(unlock, /key: itemId/);
  assert.match(unlock, /\/api\/cosmetics\/equip/);
  assert.match(picker, /\/api\/cosmetics\/equip/);
  assert.match(picker, /\{ key: null, category \}/);
  assert.match(picker, /profile\.streakRewards\./);
  assert.doesNotMatch(picker, /\/api\/cosmetics\/equip\/unequip/);
});

test("EN/FR/ES names and descriptions exist for every new reward", () => {
  for (const lang of ["en", "fr", "es"]) {
    for (const id of Object.keys(NEW_REWARDS)) {
      const name = resolve(APP_TEXT_TRANSLATIONS[lang], `profile.streakRewards.${id}.name`);
      const description = resolve(
        APP_TEXT_TRANSLATIONS[lang],
        `profile.streakRewards.${id}.description`,
      );
      assert.equal(typeof name, "string", `${lang}.${id}.name`);
      assert.equal(typeof description, "string", `${lang}.${id}.description`);
      assert.ok(name.trim().length > 0, `${lang}.${id}.name is empty`);
      assert.ok(description.trim().length > 0, `${lang}.${id}.description is empty`);
    }
  }

  assert.equal(
    resolve(APP_TEXT_TRANSLATIONS.en, "profile.streakRewards.glow_streak_ember.name"),
    "Ember Profile Glow",
  );
  assert.equal(
    resolve(APP_TEXT_TRANSLATIONS.fr, "profile.streakRewards.glow_streak_ember.name"),
    "Lueur de profil Braise",
  );
  assert.equal(
    resolve(APP_TEXT_TRANSLATIONS.es, "profile.streakRewards.glow_streak_ember.name"),
    "Brillo de perfil Ascua",
  );
});
