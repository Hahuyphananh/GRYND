/**
 * prestige-retirement.test.mjs
 *
 * Phase 1 of the trophy system (docs/TROPHY_SYSTEM_PLAN.md): the legacy
 * XP/net-wins Prestige must be fully retired.
 *
 * These tests assert that:
 *   * no settlement path writes Prestige any more (no `applyPrestigeResult`),
 *   * the retired read seams report a neutral "no prestige" state,
 *   * the legacy requirements / transition math are gone,
 *   * the rating + trophy anti-reset ledgers are still NOT purged with an
 *     account (retiring Prestige must not reopen those resets).
 *
 * Run:  node --import tsx --test tests/prestige-retirement.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { getPrestigeStatus, resolvePrestigeBadge } from "../src/lib/prestige.js";

// ════════════════════════════════════════════════════════════════════════
// 1. Neutral read seams
// ════════════════════════════════════════════════════════════════════════

test("getPrestigeStatus: always reports a neutral, earned-nothing state", () => {
  // The historical call shape must still be accepted…
  const a = getPrestigeStatus({ prestigeLevel: 9, prestigeNetWins: 900, xp: 999999 });
  const b = getPrestigeStatus();
  for (const s of [a, b]) {
    assert.equal(s.prestige, 0);
    assert.equal(s.prestigeNetWins, 0);
    assert.equal(s.nextPrestigeRequirement, 0);
    assert.equal(s.prestigeProgressPercent, 0);
    assert.equal(s.prestigeUnlocked, false);
    assert.equal(s.maxPrestige, 0);
  }
  // A maxed legacy account must NOT surface as unlocked — no stale columns.
  assert.equal(a.prestigeUnlocked, false);
});

test("resolvePrestigeBadge: never returns a badge", () => {
  assert.equal(
    resolvePrestigeBadge({ xp: 999999, prestigeLevel: 10, showPrestigeBadge: true }),
    null,
  );
  assert.equal(resolvePrestigeBadge(), null);
});

// ════════════════════════════════════════════════════════════════════════
// 2. The writer and its mechanics are gone
// ════════════════════════════════════════════════════════════════════════

test("prestige.js: the legacy writer and requirement math are removed", async () => {
  const mod = await import("../src/lib/prestige.js");
  assert.equal(mod.applyPrestigeResult, undefined);
  assert.equal(mod.computePrestigeTransition, undefined);
  assert.equal(mod.PRESTIGE_REQUIREMENTS, undefined);
  assert.equal(mod.MAX_PRESTIGE_LEVEL, undefined);
  assert.equal(mod.prestigeRequirementForLevel, undefined);
  // The two read seams remain.
  assert.equal(typeof mod.getPrestigeStatus, "function");
  assert.equal(typeof mod.resolvePrestigeBadge, "function");
});

test("prestige.js: no longer depends on XP / Battle Pass gating", () => {
  const src = fs
    .readFileSync("src/lib/prestige.js", "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(src, /battlepass/i);
  assert.doesNotMatch(src, /prestige_level|prestige_net_wins/i);
});

// ════════════════════════════════════════════════════════════════════════
// 3. No settlement writes Prestige any more
// ════════════════════════════════════════════════════════════════════════

test("SETTLEMENTS: nothing in src imports or calls applyPrestigeResult", () => {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".next") continue;
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx|js|jsx)$/.test(entry.name)) continue;
      // Strip comments: prestige.js deliberately DOCUMENTS the removal by
      // naming the old writer in prose, which is not a call site.
      const src = fs
        .readFileSync(full, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      if (/applyPrestigeResult/.test(src)) offenders.push(full);
    }
  };
  walk("src");
  assert.deepEqual(
    offenders,
    [],
    `applyPrestigeResult must be fully removed; found: ${offenders.join(", ")}`,
  );
});

test("SETTLEMENTS: the retired journal table is no longer written", () => {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".next") continue;
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx|js|jsx|sql)$/.test(entry.name)) continue;
      if (full === "src/db/schema.ts") continue;
      const src = fs.readFileSync(full, "utf8");
      if (/INSERT INTO prestige_results|UPDATE prestige_results/i.test(src)) {
        offenders.push(full);
      }
    }
  };
  walk("src");
  assert.deepEqual(
    offenders,
    [],
    `prestige_results must not be written; found: ${offenders.join(", ")}`,
  );
});

// ════════════════════════════════════════════════════════════════════════
// 4. Retiring Prestige must not reopen the anti-reset holes
// ════════════════════════════════════════════════════════════════════════

test("PURGE: an account deletion still keeps the rating + trophy identities", () => {
  const purgeCode = fs
    .readFileSync("src/lib/security/deleteUserData.ts", "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(purgeCode, /ratingIdentities|rating_identities/i);
  assert.doesNotMatch(purgeCode, /trophyIdentities|trophy_identities/i);
});
