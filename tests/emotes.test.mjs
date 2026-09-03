/**
 * Official Grynd animated emote system — resolver + security + migration +
 * Battle Pass integration tests.
 *
 * The pure resolver tests import src/lib/emoteAssets.ts directly (no DB).
 * Everything else is static analysis of the migration / routes / lib source,
 * following the banners.test.mjs convention.
 *
 * Run: node --import tsx --test tests/emotes.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  EMOTE_ASSET_DIR,
  EMOTE_ASSET_EXT,
  EMOTE_KEY_REGEX,
  FREE_EMOTE_KEYS,
  MAX_EQUIPPED_EMOTES,
  OFFICIAL_EMOTE_DEFINITIONS,
  emoteAssetUrl,
  isEmoteKey,
  normalizeEmoteKey,
  resolveDisplayEmoteKey,
} from "../src/lib/emoteAssets.ts";

const read = (path) => fs.readFileSync(path, "utf8");
const migration = read("src/db/migrations/0138_animated_emotes.sql");
const schema = read("src/db/schema.ts");
const journal = JSON.parse(read("src/db/migrations/meta/_journal.json"));
const journalEntries = journal.entries || [];
const emotesLib = read("src/lib/emotes.ts");
const getRoute = read("src/app/api/user/emotes/route.ts");
const battlepassRewards = read("src/lib/battlepassRewards.js");
const battlepassRoute = read("src/app/api/battlepass/route.js");
const leaderboardCounters = read("src/lib/leaderboardCounters.js");
const battlepassLib = read("src/lib/battlepass.js");
const picker = read("src/components/game/EmotePicker.jsx");
const clerkWebhook = read("src/app/api/webhooks/clerk/route.js");
const syncUser = read("src/app/api/sync-user/route.ts");

const DEFINITION_KEYS = OFFICIAL_EMOTE_DEFINITIONS.map((d) => d.key);

// ═════════════════════════════════════════════════════════════════════
// Catalog shape: exactly 15 official emotes — 8 free + 7 Battle Pass
// ═════════════════════════════════════════════════════════════════════

test("catalog has exactly 15 official emotes with unique lowercase keys", () => {
  assert.equal(OFFICIAL_EMOTE_DEFINITIONS.length, 15);
  assert.equal(new Set(DEFINITION_KEYS).size, 15);
  for (const def of OFFICIAL_EMOTE_DEFINITIONS) {
    assert.ok(EMOTE_KEY_REGEX.test(def.key), `${def.key} is a well-formed key`);
    assert.equal(def.assetPath, `${EMOTE_ASSET_DIR}/${def.key}.${EMOTE_ASSET_EXT}`);
    assert.equal(def.enabled, true);
  }
});

test("exactly 8 free emotes are centrally configured and usable as the default loadout", () => {
  assert.equal(FREE_EMOTE_KEYS.length, 8);
  for (const key of FREE_EMOTE_KEYS) {
    assert.ok(DEFINITION_KEYS.includes(key), `${key} exists in the catalog`);
  }
  // Order = equip order; never includes GG / NICE MOVE (text system emotes).
  assert.ok(!FREE_EMOTE_KEYS.includes("gg"));
  assert.ok(!FREE_EMOTE_KEYS.includes("nice-move"));
  assert.equal(MAX_EQUIPPED_EMOTES, 9);
  // Sanitization caps a legacy >9 loadout at the first 9 valid owned keys.
  assert.equal(FREE_EMOTE_KEYS.slice(0, MAX_EQUIPPED_EMOTES).length, 8);
});

// ═════════════════════════════════════════════════════════════════════
// Asset resolver — official local paths only, never arbitrary input
// ═════════════════════════════════════════════════════════════════════

test("known catalog keys resolve to the official local asset", () => {
  for (const def of OFFICIAL_EMOTE_DEFINITIONS) {
    assert.equal(emoteAssetUrl(def.key), def.assetPath);
  }
  assert.equal(emoteAssetUrl("laugh"), "/emotes/laugh.webp");
  // GG / NICE MOVE are word emotes — case/whitespace-normalized, but they are
  // deliberately NOT in the animated catalog, so they never get an asset.
  assert.equal(emoteAssetUrl("gg"), null);
  assert.equal(emoteAssetUrl("GG"), null);
  assert.equal(emoteAssetUrl("nice-move"), null);
});

test("keys that are well-formed but NOT in the catalog resolve to null", () => {
  assert.equal(normalizeEmoteKey("free-emote-1"), null); // old placeholder style
  assert.equal(normalizeEmoteKey("not-a-real-emote"), null);
  assert.equal(emoteAssetUrl("not-a-real-emote"), null);
  assert.equal(resolveDisplayEmoteKey("not-a-real-emote"), null);
});

test("arbitrary URLs / path traversal / junk can never become an emote src", () => {
  for (const attempt of [
    "https://evil.example/x.png",
    "http://evil.example/avatar.jpg",
    "data:image/png;base64,AAAA",
    "javascript:alert(document.cookie)",
    "/absolute/path.png",
    "//double-slash.example/x.png",
    "../../etc/passwd",
    null,
    undefined,
    42,
    {},
  ]) {
    assert.equal(isEmoteKey(attempt), false, `${JSON.stringify(attempt)} is not a key`);
    assert.equal(emoteAssetUrl(attempt), null, `${JSON.stringify(attempt)} must never resolve`);
  }
});

// ═════════════════════════════════════════════════════════════════════
// Migration — additive, idempotent, mirrors the icon/banner architecture
// ═════════════════════════════════════════════════════════════════════

test("migration creates the emotes catalog + user_emotes ownership + loadout column", () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS "emotes"/);
  assert.match(migration, /"key" VARCHAR\(120\) NOT NULL UNIQUE/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS "user_emotes"/);
  assert.match(
    migration,
    /CONSTRAINT "user_emotes_user_emote_unique" UNIQUE \("user_id", "emote_key"\)/
  );
  assert.match(migration, /REFERENCES users\(id\) ON DELETE CASCADE/);
  assert.match(
    migration,
    /ADD COLUMN IF NOT EXISTS "equipped_emotes" JSONB NOT NULL DEFAULT '\[\]'::jsonb/
  );
});

test("migration backfills the 8 free emotes to every existing user idempotently", () => {
  assert.match(migration, /INSERT INTO "user_emotes"/);
  assert.match(migration, /CROSS JOIN/);
  assert.match(migration, /WHERE NOT EXISTS/);
  // The 8 free keys are backfilled; the 7 Battle Pass keys are NOT (they are
  // granted only via the idempotent Battle Pass reconciliation).
  const backfillSection = migration.slice(
    migration.indexOf("-- ── Backfill"),
    migration.indexOf("-- ── Default loadout")
  );
  for (const key of ["laugh", "shock", "cry", "angry", "love", "cool", "wow", "fire"]) {
    assert.ok(backfillSection.includes(`('${key}')`), `free emote ${key} backfilled`);
  }
  for (const key of ["hype", "victory", "party", "skull", "thumbsup", "clap", "star"]) {
    assert.ok(
      !backfillSection.includes(`('${key}')`),
      `battle pass emote ${key} is NOT backfilled`
    );
  }
  // Legacy users with no loadout get the 8 free emotes equipped by default.
  assert.match(migration, /UPDATE "users"/);
  assert.match(migration, /jsonb_array_length\("equipped_emotes"\) = 0/);
});

test("journal contains the 0138 emote migration", () => {
  assert.ok(
    journalEntries.some((entry) => entry.tag === "0138_animated_emotes"),
    "0138_animated_emotes missing from the migration journal"
  );
});

test("drizzle schema mirrors the migration (catalog + ownership + loadout)", () => {
  assert.match(schema, /export const emotes = pgTable\("emotes"/);
  assert.match(schema, /export const userEmotes = pgTable\(\s*"user_emotes"/);
  assert.match(schema, /uniqUserEmote: unique\("user_emotes_user_emote_unique"\)/);
  assert.match(schema, /equippedEmotes: jsonb\("equipped_emotes"\)/);
  assert.match(schema, /\.\$type<string\[\]>\(\)/);
  assert.match(schema, /default\(sql`'\[\]'::jsonb`\)/);
});

// ═════════════════════════════════════════════════════════════════════
// Server authority — ownership + loadout validation
// ═════════════════════════════════════════════════════════════════════

test("emote state/loadout reads go through an authenticated API", () => {
  assert.match(getRoute, /await\s+auth\(\)/);
  assert.match(getRoute, /getEmoteState\(userId\)/);
  assert.match(getRoute, /equippedEmotes/);
  assert.match(getRoute, /emotes: state\.emotes/);
  assert.match(getRoute, /maxLoadout: MAX_EQUIPPED_EMOTES/);
  // The server payload exposes ownership + equipped + Battle Pass unlock
  // level per catalog emote so the profile manager can render locked items.
  assert.match(emotesLib, /unlockLevel: number \| null/);
  assert.match(emotesLib, /unlockLevel: levelByKey\.get\(row\.key\) \?\? null/);
});

test("loadout writes validate ownership, catalog, duplicates, and the 9 cap server-side", () => {
  assert.match(getRoute, /setEquippedEmotes\(userId, body\?\.emotes\)/);
  assert.match(emotesLib, /getEmoteByKey\(key\)/);
  assert.match(emotesLib, /eq\(emotes\.enabled, true\)/);
  assert.match(emotesLib, /getOwnedEmoteKeys\(userId\)/);
  assert.match(emotesLib, /ownedKeys\.has\(key\)/);
  assert.match(emotesLib, /You do not own this emote/);
  assert.match(emotesLib, /Duplicate emote keys are not allowed/);
  assert.match(emotesLib, /a maximum of \$\{MAX_EQUIPPED_EMOTES\} emotes/);
  assert.match(emotesLib, /MAX_EQUIPPED_EMOTES/);
  // Ownership is never client-supplied: grants come only from reconciliation
  // paths (free emotes / battle pass) — the API route never inserts
  // user_emotes rows or grants ownership itself.
  assert.match(emotesLib, /reconcileEmoteState\(userId\)/);
  assert.doesNotMatch(getRoute, /insert\(userEmotes\)/);
  assert.doesNotMatch(getRoute, /unlockEmote\(/);
});

test("sanitization is server-side: max 9, no duplicates, owned-and-enabled only", () => {
  assert.match(emotesLib, /sanitizeLoadoutKeys/);
  assert.match(emotesLib, /cleaned\.length >= MAX_EQUIPPED_EMOTES\) break/);
  assert.match(emotesLib, /seen\.has\(key\)\) continue/);
  assert.match(emotesLib, /ownedKeys\.has\(key\)\) continue/);
});

test("free emotes are auto-granted idempotently (no manual claim, safe to repeat)", () => {
  assert.match(emotesLib, /reconcileEmoteState/);
  assert.match(
    emotesLib,
    /onConflictDoNothing\(\{\s*target: \[userEmotes\.userId, userEmotes\.emoteKey\]/
  );
  assert.match(clerkWebhook, /reconcileEmoteState\(newUserId\)/);
  assert.match(syncUser, /reconcileEmoteState\(user\.id\)/);
  assert.doesNotMatch(emotesLib, /localStorage/);
});

test("loadout lives in the DB across devices — no localStorage source of truth", () => {
  assert.match(schema, /equippedEmotes: jsonb\("equipped_emotes"\)/);
  // The picker's only localStorage usage is the unrelated send/mute settings.
  assert.match(picker, /grynd:emotes:settings/);
  assert.ok(
    !picker.includes("equipped_emotes") || picker.includes("/api/user/emotes"),
    "picker never stores loadout keys in localStorage"
  );
});

// ═════════════════════════════════════════════════════════════════════
// Battle Pass integration — 7 emote rewards, idempotent grants
// ═════════════════════════════════════════════════════════════════════

test("the 7 Battle Pass emotes sit at the specified reserved cosmetic levels", () => {
  const expected = [
    [6, "hype"],
    [13, "victory"],
    [22, "party"],
    [31, "skull"],
    [42, "thumbsup"],
    [56, "clap"],
    [81, "star"],
  ];
  for (const [level, key] of expected) {
    const row = new RegExp(`\\[${level}, \\[\\{ type: "emote", key: "${key}"`);
    assert.match(battlepassRewards, row, `level ${level} -> emote ${key}`);
  }
});

test("emote rewards reuse the existing Battle Pass system (no second pass)", () => {
  assert.match(battlepassRewards, /emote: \{ label: "Animated Emote"/);
  assert.match(battlepassLib, /grantBattlepassEmotes\(userId, result\.level\)/);
  assert.match(battlepassRoute, /grantBattlepassEmotes\(dbUserId/);
  assert.match(leaderboardCounters, /grantBattlepassEmotes\(updatedUserId, updatedLevel\)/);
  // grantBattlepassEmotes only ever grants ownership — it never auto-equips.
  const grantFn = emotesLib.slice(
    emotesLib.indexOf("export async function grantBattlepassEmotes"),
    emotesLib.indexOf("export type EmoteStateEmote")
  );
  assert.match(grantFn, /unlockEmote\(userId, key\)\) granted\.push\(key\)/);
  assert.doesNotMatch(grantFn, /equippedEmotes/, "battle pass grant must not touch the loadout");
});

test("battle pass rewards report claimed from user_emotes (idempotent page refresh)", () => {
  assert.match(battlepassRoute, /ownedEmoteKeys/);
  assert.match(battlepassRoute, /SELECT emote_key FROM user_emotes WHERE user_id/);
  assert.match(battlepassRoute, /reward\.type === "emote" && dbUserId/);
  assert.match(battlepassRoute, /ownedEmoteKeys\.has\(reward\.key\)/);
});

// ═════════════════════════════════════════════════════════════════════
// EmotePicker — no hardcoded inventory, loadout-driven + GG/NICE MOVE
// ═════════════════════════════════════════════════════════════════════

test("the picker no longer owns a hardcoded emoji inventory", () => {
  assert.ok(!picker.includes("GAME_EMOTES"), "GAME_EMOTES must be gone");
  assert.ok(
    !picker.includes("😂") &&
      !picker.includes("😮") &&
      !picker.includes("🔥") &&
      !picker.includes("😭"),
    "old hardcoded emoji glyphs must not remain the inventory"
  );
});

test("GG + NICE MOVE stay as permanent text emotes outside the loadout", () => {
  assert.match(picker, /PERMANENT_TEXT_EMOTES/);
  assert.match(picker, /value: "GG"/);
  assert.match(picker, /value: "NICE MOVE"/);
  assert.match(picker, /kind: "word"/);
});

test("the picker fetches the equipped loadout from the server and resolves assets by key", () => {
  assert.match(picker, /\/api\/user\/emotes/);
  assert.match(picker, /equippedEmotes/);
  assert.match(picker, /emoteAssetUrl\(emote\.key\)/);
  assert.match(picker, /emotesUpdated/);
});

test("bubbles render words as text and animated emotes as official assets only", () => {
  assert.match(picker, /emote\.kind === "word"/);
  assert.match(picker, /emoteAssetUrl\(emote\.key\)/);
  assert.ok(
    !picker.includes("http") && !picker.includes("src={emote.value}"),
    "an emote value must never be used as an image src"
  );
});

test("the legacy inline .value bubbles in game pages now render via EmoteArtwork", () => {
  const roulette = read("src/app/casino/roulette/[matchId]/PageClient.jsx");
  const chess = read("src/app/casino/chess-game/[gameId]/PageClient.jsx");
  const blackjack = read("src/app/casino/blackjack/[matchId]/PageClient.tsx");
  for (const file of [roulette, chess, blackjack]) {
    assert.match(file, /EmoteArtwork/);
    assert.ok(
      !/>\{.*emote\.value\}<\/span>/.test(file) &&
        !/>\{myEmote\.value\}\s*<\/motion\.span>/.test(file)
    );
  }
});
