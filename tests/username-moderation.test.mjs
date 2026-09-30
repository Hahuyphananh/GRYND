/**
 * username-moderation.test.mjs
 *
 * The username filter, driven directly.
 *
 * Two failure modes matter equally and both are covered here:
 *
 *   FALSE NEGATIVES — a profane name reaching the public leaderboard. The
 *     reported case ("Stupidgayzz") plus the usual evasions (leetspeak,
 *     diacritics, spacing, letter padding) must all be caught.
 *
 *   FALSE POSITIVES — a legitimate player blocked at signup. An over-eager
 *     filter is a worse product than a leaky one, so ordinary names that merely
 *     CONTAIN a blocked substring (ClassicGamer, PeacockFan, GrapeApe, …) must
 *     pass. These are the cases that rot first when an allowlist is edited.
 *
 * Run:  node --import tsx --test tests/username-moderation.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  findProfanity,
  foldForModeration,
  isNameAllowed,
  moderatedDisplayName,
  normalizeForModeration,
  safeFallbackName,
} from "../src/lib/moderation/profanity.ts";

// ── The reported incident ─────────────────────────────────────────────────

test("the reported leaderboard name is blocked, however it is spelled", () => {
  const variants = [
    "Stupidgayzz",
    "stupidgayzz",
    "STUPIDGAYZZ",
    "StupidGayz",
    "stuuupidgayzz",
    "5tup1dgayzz",
    "stup1dgayzz",
    "s t u p i d g a y z z",
    "s.t.u.p.i.d.g.a.y.z.z",
    "stüpidgayzz",
    "Stupid_gay_zz",
  ];
  for (const name of variants) {
    assert.equal(isNameAllowed(name), false, `${name} must be rejected`);
  }
  // The match is reported as a term, never as the input — an error message is
  // not the place to echo a slur back at the player.
  assert.equal(findProfanity("Stupidgayzz"), "stupid");
});

// ── Evasion techniques ───────────────────────────────────────────────────

test("leet, spacing, diacritics and padding do not evade the filter", () => {
  const blocked = [
    "fuck",
    "F U C K",
    "f.u.c.k",
    "fuuuck",
    "fuk",
    "phuckfuck",
    "sh1t",
    "$hit",
    "b1tch",
    "a$$hole",
    "n1gga",
    "n i g g e r",
    "f4gg0t",
    "wh0re",
    "r3tard",
    "p0rn",
    "s3x",
    "kys",
    "kill yourself",
    "kill.yourself",
    "pedo",
    "p3do",
    "nazi",
  ];
  for (const name of blocked) {
    assert.equal(isNameAllowed(name), false, `${name} must be rejected`);
  }
});

// ── The false-positive guard ─────────────────────────────────────────────

test("ordinary names that merely contain a blocked substring stay allowed", () => {
  const allowed = [
    // "ass"
    "ClassicGamer",
    "ClassyKate",
    "GrassRoots",
    "GlassHouse",
    "PassTheSalt",
    "CompassRose",
    "MassiveAttack",
    "BassistBoy",
    "CassetteKid",
    "AssassinPro",
    "HarassmentFree",
    "SassySam",
    "Cassandra",
    // "spic"
    "SpicyNoodle",
    "SuspiciousOwl",
    // "rape"
    "GrapeApe",
    "DrapeArtist",
    "TherapistLife",
    // "cock"
    "PeacockFan",
    "CocktailBob",
    "Woodcock",
    "Hancock",
    // "coon"
    "RaccoonGuy",
    // "cum"
    "CucumberSalad",
    "DocumentDan",
    "Incumbent",
    // "anal"
    "AnalystAnn",
    "AnalogKid",
    "AnalyticsPro",
    "CanalRunner",
    // "sex"
    "SussexBoy",
    "EssexLad",
    // "anus"
    "Janus",
    "Uranus",
    // "loser" / "dick" / "pussy"
    "CloserLook",
    "Dickinson",
    "DickensFan",
    "PussycatDoll",
    // "cunt"
    "Scunthorpe",
    // names that merely look risky
    "NightOwl",
    "KnightRider",
    "Nigeria",
    "Richard",
    "GameMaster",
    "SolitaireKing",
    "Classified",
  ];
  for (const name of allowed) {
    assert.equal(isNameAllowed(name), true, `${name} must be allowed`);
    assert.equal(findProfanity(name), null, `${name} must report no match`);
  }
});

test("an empty or non-string name is not treated as profanity", () => {
  for (const value of ["", "   ", null, undefined, 42, {}, []]) {
    assert.equal(findProfanity(value), null);
    assert.equal(normalizeForModeration(value), "");
  }
});

// ── Normalization is inspectable ─────────────────────────────────────────

test("normalization folds to one letter stream, and unhooks allowlisted words", () => {
  assert.equal(foldForModeration("Stupid Gayzz"), "stupidgayzz");
  assert.equal(foldForModeration("5tüp1d"), "stupid");
  assert.equal(foldForModeration("stuuuupid"), "stupid");
  // `!` is a leet `i`, so it folds in rather than being dropped.
  assert.equal(foldForModeration("a.b-c!d"), "abcid");
  assert.equal(foldForModeration("a.b-c.d"), "abcd");
  // The allowlist removes the safe word, so the shared substring is not a match.
  assert.equal(normalizeForModeration("ClassicGamer"), "icgamer");
  assert.equal(isNameAllowed("ClassicGamer"), true);
});

// ── The fallback identity ────────────────────────────────────────────────

test("the fallback name is deterministic, clean and never random", () => {
  const a = safeFallbackName("user_2abc");
  const b = safeFallbackName("user_2abc");
  assert.equal(a, b, "the same account must always get the same fallback");
  assert.match(a, /^Player[0-9A-Z]{5}$/);
  assert.equal(isNameAllowed(a), true);
  assert.notEqual(a, safeFallbackName("user_2xyz"));
  // No seed / bad seed still produces something usable.
  assert.equal(isNameAllowed(safeFallbackName(null)), true);
  assert.equal(isNameAllowed(safeFallbackName("")), true);
});

test("a provider name passes through when clean and degrades when not", () => {
  assert.equal(moderatedDisplayName("Alice Navarro", "user_1"), "Alice Navarro");
  assert.equal(moderatedDisplayName("  Alice  ", "user_1"), "Alice");
  // A profane provider name must NOT block the account — it is replaced.
  const replaced = moderatedDisplayName("Stupidgayzz", "user_1");
  assert.equal(replaced, safeFallbackName("user_1"));
  assert.equal(isNameAllowed(replaced), true);
  // Missing/blank provider names degrade too.
  assert.equal(moderatedDisplayName("", "user_2"), safeFallbackName("user_2"));
  assert.equal(moderatedDisplayName(null, "user_2"), safeFallbackName("user_2"));
  // Long names are capped at the column limit.
  assert.equal(moderatedDisplayName("a".repeat(200), "user_3").length, 80);
});

// ── The module is pure ───────────────────────────────────────────────────

test("the filter is pure — no randomness, no clock, no I/O", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(
    new URL("../src/lib/moderation/profanity.ts", import.meta.url),
    "utf8",
  );
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  for (const forbidden of ["Math.random", "Date.now", "process.env", "fetch(", "require("]) {
    assert.equal(
      code.includes(forbidden),
      false,
      `the filter must not reach for ${forbidden}`,
    );
  }
});
