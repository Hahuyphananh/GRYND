// tests/prestige.test.mjs
//
// Pure-logic + static-guard tests for the permanent Prestige system.
//
//   * Pure rules are tested through computePrestigeTransition /
//     getPrestigeStatus (no database needed).
//   * Static guards mirror the repo's banners.test.mjs pattern: they read the
//     source/migration files and assert the server-authority + idempotency
//     invariants hold (no client-writable prestige surface, atomic guarded
//     writes, defaults for existing users).
//
// Run: node --import tsx --test tests/prestige.test.mjs
//
// Database-backed integration tests (real duplicate/concurrency behavior)
// live in tests/prestige-db.test.mjs and are skipped without DATABASE_URL.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  PRESTIGE_REQUIREMENTS,
  MAX_PRESTIGE_LEVEL,
  computePrestigeTransition,
  getPrestigeStatus,
  prestigeRequirementForLevel,
  resolvePrestigeBadge,
} from "../src/lib/prestige.js";
import { expToReachLevel, MAX_LEVEL } from "../src/lib/battlepass.js";

const read = (path) => fs.readFileSync(path, "utf8");
const prestigeLib = read("src/lib/prestige.js");
const migration = read("src/db/migrations/0136_prestige.sql");
const badgeMigration = read("src/db/migrations/0137_prestige_badge.sql");
const badgeRoute = read("src/app/api/user/prestige-badge/route.js");
const chatMessagesRoute = read("src/app/api/chat/messages/route.js");
const battlepassClient = read("src/app/battlepass/PageClient.jsx");
const profilClient = read("src/app/profil/PageClient.jsx");
const publicProfileClient = read("src/app/profil/[clerkId]/PageClient.tsx");
const battlepassRoute = read("src/app/api/battlepass/route.js");
const statsRoute = read("src/app/api/user/stats/route.ts");
const publicProfileRoute = read("src/app/api/user/public-profile/route.ts");

const win = (level, net) =>
  computePrestigeTransition({ prestigeLevel: level, prestigeNetWins: net, outcome: "win", eligible: true });
const loss = (level, net) =>
  computePrestigeTransition({ prestigeLevel: level, prestigeNetWins: net, outcome: "loss", eligible: true });

test("Prestige requirements match the spec and stay centralized", () => {
  assert.deepEqual(PRESTIGE_REQUIREMENTS, [
    25, 50, 100, 175, 275, 400, 550, 725, 900, 1100,
  ]);
  assert.equal(MAX_PRESTIGE_LEVEL, 10);
  // Config lives only in src/lib/prestige.js — never hardcoded into routes.
  assert.ok(!battlepassRoute.includes("nextPrestigeRequirement: 25"));
});

test("prestigeRequirementForLevel maps tier to requirement, null when maxed", () => {
  assert.equal(prestigeRequirementForLevel(0), 25);
  assert.equal(prestigeRequirementForLevel(1), 50);
  assert.equal(prestigeRequirementForLevel(5), 400);
  assert.equal(prestigeRequirementForLevel(9), 1100);
  assert.equal(prestigeRequirementForLevel(10), null);
  assert.equal(prestigeRequirementForLevel(-3), 25);
  assert.equal(prestigeRequirementForLevel("2"), 100);
});

test("a player below Level 100 cannot gain Prestige progression", () => {
  for (const outcome of ["win", "loss", "draw"]) {
    const r = computePrestigeTransition({
      prestigeLevel: 3,
      prestigeNetWins: 40,
      outcome,
      eligible: false, // below Level 100
    });
    assert.deepEqual(r, { level: 3, netWins: 40, delta: 0 }, `outcome ${outcome} must be a no-op below L100`);
  }
  // Unlock flag is XP-based (Level 100 = expToReachLevel(100)).
  assert.equal(expToReachLevel(MAX_LEVEL), 63360);
  assert.equal(getPrestigeStatus({ prestigeLevel: 0, prestigeNetWins: 7, xp: 63359 }).prestigeUnlocked, false);
  assert.equal(getPrestigeStatus({ prestigeLevel: 0, prestigeNetWins: 7, xp: 63360 }).prestigeUnlocked, true);
});

test("Level 100 win adds 1 net win", () => {
  assert.deepEqual(win(0, 0), { level: 0, netWins: 1, delta: 1 });
  assert.deepEqual(win(2, 30), { level: 2, netWins: 31, delta: 1 });
});

test("Level 100 loss subtracts 1 net win", () => {
  assert.deepEqual(loss(0, 10), { level: 0, netWins: 9, delta: -1 });
  assert.deepEqual(loss(3, 1), { level: 3, netWins: 0, delta: -1 });
});

test("progress cannot go below 0", () => {
  assert.deepEqual(loss(0, 0), { level: 0, netWins: 0, delta: 0 });
  assert.deepEqual(loss(5, 0), { level: 5, netWins: 0, delta: 0 });
  // 100 losses at 0 net wins never go negative and never demote.
  let state = { level: 3, netWins: 0 };
  for (let i = 0; i < 100; i += 1) {
    state = loss(state.level, state.netWins);
  }
  assert.deepEqual(state, { level: 3, netWins: 0, delta: 0 });
});

test("reaching 25 net wins awards Prestige 1 and resets progress to 0 / 50", () => {
  // The spec example: Prestige 0 at 24/25 → win → Prestige 1 with 0/50.
  assert.deepEqual(win(0, 24), { level: 1, netWins: 0, delta: 1 });
  assert.deepEqual(win(0, 23), { level: 0, netWins: 24, delta: 1 });
  assert.deepEqual(win(0, 25), { level: 1, netWins: 0, delta: 1 });
});

test("an earned Prestige tier can never be lost", () => {
  // Loss inside the tier reduces progress only.
  assert.deepEqual(loss(1, 12), { level: 1, netWins: 11, delta: -1 });
  assert.deepEqual(loss(5, 20), { level: 5, netWins: 19, delta: -1 });
  // Loss at 0 progress keeps the tier at 0 progress.
  assert.deepEqual(loss(5, 0), { level: 5, netWins: 0, delta: 0 });
  assert.deepEqual(loss(9, 0), { level: 9, netWins: 0, delta: 0 });
});

test("reaching every subsequent Prestige level works from the config", () => {
  for (let tier = 0; tier < PRESTIGE_REQUIREMENTS.length - 1; tier += 1) {
    const requirement = PRESTIGE_REQUIREMENTS[tier];
    const r = computePrestigeTransition({
      prestigeLevel: tier,
      prestigeNetWins: requirement - 1,
      outcome: "win",
      eligible: true,
    });
    assert.deepEqual(
      r,
      { level: tier + 1, netWins: 0, delta: 1 },
      `tier ${tier}: (requirement-1) net wins + a win must tier up`,
    );
  }
  // Max tier: wins stop counting (delta 0) and the tier is preserved.
  assert.deepEqual(win(MAX_PRESTIGE_LEVEL, 9999), { level: 10, netWins: 9999, delta: 0 });
});

test("full 10-tier marathon from a fresh Level-100 player", () => {
  let level = 0;
  let netWins = 0;
  for (const requirement of PRESTIGE_REQUIREMENTS) {
    for (let i = 1; i <= requirement; i += 1) {
      const r = computePrestigeTransition({ prestigeLevel: level, prestigeNetWins: netWins, outcome: "win", eligible: true });
      level = r.level;
      netWins = r.netWins;
      if (i === requirement) {
        // Exact landing on the requirement always tier-ups and resets.
        assert.equal(netWins, 0);
      }
    }
    assert.ok(level >= 1, `a tier must have been earned after ${requirement} net wins`);
  }
  assert.equal(level, MAX_PRESTIGE_LEVEL);
  assert.equal(netWins, 0);
});

test("draws never change Prestige progress", () => {
  const r = computePrestigeTransition({ prestigeLevel: 4, prestigeNetWins: 100, outcome: "draw", eligible: true });
  assert.deepEqual(r, { level: 4, netWins: 100, delta: 0 });
});

test("unknown outcomes are a defensive no-op", () => {
  const r = computePrestigeTransition({ prestigeLevel: 1, prestigeNetWins: 5, outcome: "surrendered", eligible: true });
  assert.deepEqual(r, { level: 1, netWins: 5, delta: 0 });
});

test("the module never writes Battle Pass level or XP", () => {
  // Prestige is an additive layer: reaching a tier preserves Level 100, XP,
  // rewards, titles, and cosmetics. The prestige write path only touches
  // prestige_level / prestige_net_wins.
  assert.match(prestigeLib, /SET prestige_level = \$2,\s*prestige_net_wins = \$3/);
  assert.ok(!/UPDATE users[\s\S]*?SET[\s\S]*?\bxp\s*=/.test(prestigeLib), "prestige must not write xp");
  assert.ok(!/\bxp = \$/.test(prestigeLib), "prestige must not write xp");
  assert.ok(!/SET[\s\S]*\blevel = /.test(prestigeLib), "prestige must not write the battlepass level column");
});

test("getPrestigeStatus exposes the battlepass-style read shape", () => {
  const s = getPrestigeStatus({ prestigeLevel: 0, prestigeNetWins: 24, xp: 70000 });
  assert.equal(s.prestige, 0);
  assert.equal(s.prestigeNetWins, 24);
  assert.equal(s.nextPrestigeRequirement, 25);
  assert.equal(s.prestigeProgressPercent, 96);
  assert.equal(s.prestigeUnlocked, true);

  const fresh = getPrestigeStatus({ prestigeLevel: 0, prestigeNetWins: 0, xp: 0 });
  assert.equal(fresh.prestige, 0);
  assert.equal(fresh.prestigeUnlocked, false);
  assert.equal(fresh.prestigeProgressPercent, 0);
  assert.equal(fresh.nextPrestigeRequirement, 25);

  const maxed = getPrestigeStatus({ prestigeLevel: 10, prestigeNetWins: 3, xp: 70000 });
  assert.equal(maxed.nextPrestigeRequirement, 0);
  assert.equal(maxed.prestigeProgressPercent, 100);
  assert.equal(maxed.maxPrestige, 10);
});

test("migration defaults existing users to prestige 0 / 0 net wins and never alters XP", () => {
  assert.match(migration, /ADD COLUMN IF NOT EXISTS "prestige_level" INTEGER NOT NULL DEFAULT 0/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS "prestige_net_wins" INTEGER NOT NULL DEFAULT 0/);
  // Idempotency journal + unique guard.
  assert.match(migration, /CREATE TABLE IF NOT EXISTS "prestige_results"/);
  assert.match(migration, /CONSTRAINT "prestige_results_unique_event" UNIQUE \("user_id", "source", "source_id"\)/);
  assert.ok(!/ALTER TABLE "users"[\s\S]*xp/.test(migration), "migration must not alter xp");
  assert.ok(!/prestige_level" INTEGER NOT NULL DEFAULT [1-9]/.test(migration), "existing users must not default to a prestige tier");
});

test("journal entries exist for the prestige migrations", () => {
  const journal = JSON.parse(read("src/db/migrations/meta/_journal.json"));
  const entries = (journal.journal || journal).entries || journal.entries || journal;
  const list = Array.isArray(entries) ? entries : Object.values(entries);
  assert.ok(list.some((e) => e.tag === "0136_prestige"), "0136_prestige missing from the migration journal");
  assert.ok(list.some((e) => e.tag === "0137_prestige_badge"), "0137_prestige_badge missing from the migration journal");
});

test("resolvePrestigeBadge never renders an unearned badge", () => {
  // Flag off → never shown, even when fully earned.
  assert.equal(
    resolvePrestigeBadge({ xp: 70000, prestigeLevel: 5, showPrestigeBadge: false }),
    null,
  );
  // Below Level 100 → never shown, even when flagged on.
  assert.equal(
    resolvePrestigeBadge({ xp: 50000, prestigeLevel: 5, showPrestigeBadge: true }),
    null,
  );
  // Level 100 but no earned tier → a "Prestige 0" badge is meaningless.
  assert.equal(
    resolvePrestigeBadge({ xp: 63360, prestigeLevel: 0, showPrestigeBadge: true }),
    null,
  );
  // Earned + equipped → exact authoritative label.
  assert.equal(
    resolvePrestigeBadge({ xp: 63360, prestigeLevel: 5, showPrestigeBadge: true }),
    "Prestige 5",
  );
  assert.equal(
    resolvePrestigeBadge({ xp: 90000, prestigeLevel: 1, showPrestigeBadge: true }),
    "Prestige 1",
  );
  // Out-of-range stored level is capped by getPrestigeStatus.
  assert.equal(
    resolvePrestigeBadge({ xp: 90000, prestigeLevel: 12, showPrestigeBadge: true }),
    "Prestige 10",
  );
});

test("badge preference migration is additive and never touches progression", () => {
  assert.match(badgeMigration, /ADD COLUMN IF NOT EXISTS "show_prestige_badge" BOOLEAN NOT NULL DEFAULT false/);
  // It never adds/alters the progression columns (comments may mention them).
  assert.ok(
    !/ADD COLUMN IF NOT EXISTS "prestige_level"/.test(badgeMigration),
    "badge migration must not add/alter prestige_level",
  );
  assert.ok(
    !/ADD COLUMN IF NOT EXISTS "prestige_net_wins"/.test(badgeMigration),
    "badge migration must not add/alter prestige_net_wins",
  );
  assert.ok(!/ALTER TABLE "users"[\s\S]*?\bxp\b/.test(badgeMigration), "badge migration must not alter xp");
  assert.match(read("src/db/schema.ts"), /showPrestigeBadge: boolean\("show_prestige_badge"\)\.notNull\(\)\.default\(false\)/);
});

test("clients can toggle the badge preference but never claim a prestige level", () => {
  // The endpoint only accepts a boolean and only writes the preference
  // column; it never imports the writer and never accepts prestige values.
  assert.match(badgeRoute, /body\?\.enabled === true/);
  assert.match(badgeRoute, /\.set\(\{ showPrestigeBadge: enabled \}\)/);
  assert.ok(!badgeRoute.includes("applyPrestigeResult"), "badge endpoint must never call the prestige writer");
  // Nothing derived from the request body ever reaches a prestige column:
  // the only body field read is the boolean `enabled`.
  assert.ok(
    !/body\??\.prestige/i.test(badgeRoute),
    "badge endpoint must never accept a prestige value from the client",
  );
  assert.ok(
    !/\.set\(\{[^}]*prestige_level[^}]*\}/.test(badgeRoute),
    "badge endpoint writes only the preference column",
  );
  // Every read path renders through the authoritative resolver.
  assert.match(publicProfileRoute, /resolvePrestigeBadge/);
  assert.match(publicProfileRoute, /prestigeBadge,/);
  assert.match(chatMessagesRoute, /resolvePrestigeBadge/);
  assert.match(chatMessagesRoute, /showPrestigeBadge: users\.showPrestigeBadge/);
});

test("UI displays the server prestige value, never a client-authored one", () => {
  // Battle Pass page: the unlock card + celebration read pass.* (server),
  // and the celebration only fires on an observed level increase.
  assert.match(battlepassClient, /pass\.prestigeUnlocked/);
  assert.match(battlepassClient, /const level = Math\.max\(0, Number\(pass\.prestige\) \|\| 0\);/);
  assert.match(battlepassClient, /level > seen/);
  assert.match(battlepassClient, /grynd\.prestige\.celebrated\.v1/);
  // Own + public profiles render the server-resolved badge only.
  assert.match(profilClient, /prestigeBadge\.display/);
  assert.match(publicProfileClient, /profile\.prestigeBadge/);
});

test("Prestige is server-authoritative: no client-facing API accepts prestige input", () => {
  // The battlepass / stats / public-profile endpoints only READ prestige via
  // getPrestigeStatus and never import the writer or accept prestige fields.
  assert.match(battlepassRoute, /getPrestigeStatus/);
  assert.match(statsRoute, /getPrestigeStatus/);
  assert.match(publicProfileRoute, /getPrestigeStatus/);
  for (const route of [battlepassRoute, statsRoute, publicProfileRoute]) {
    assert.ok(!route.includes("applyPrestigeResult"), "client-facing routes must never call the prestige writer");
  }
  // The writer is wired only into server settlement libraries.
  const writerImports = [
    // Family-B match pipelines (Prompt 2 wiring).
    "src/lib/blackjack-pvp/serverStore.js",
    "src/lib/mines-pvp/serverStore.js",
    "src/lib/keno-pvp/serverStore.js",
    "src/lib/lane-rush-duel/serverStore.js",
    "src/lib/memory-grid/serverStore.js",
    "src/lib/plinko-pvp/serverStore.js",
    "src/lib/precision/finishMatch.ts",
    // Remaining competitive settlements (Prompt 3 wiring).
    "src/app/api/chess/move/route.js",
    "src/app/api/chess/game-state/route.js",
    "src/app/api/chess/end-game/route.js",
    "src/app/api/uno/determine-winner/route.js",
    "src/app/api/rps/pvp/choose/route.js",
    "src/lib/rps-pvp/serverStore.js",
    "src/app/api/dice-flush/_lib.js",
    "src/app/api/pool/resign/route.ts",
    "src/lib/fourInARowServer.js",
    "src/lib/dotsAndBoxesServer.js",
    "src/lib/tower-arena/serverStore.ts",
    "src/app/api/hex-duel/multiplayer/end/route.ts",
    "src/app/api/odds/pvp/pick/route.ts",
    "src/app/api/odds/pvp/forfeit/route.ts",
    "src/app/api/odds/pvp/cleanup/route.ts",
  ];
  for (const file of writerImports) {
    assert.ok(read(file).includes("applyPrestigeResult"), `${file} must wire the prestige hook`);
  }
});

test("idempotency mechanism exists at the SQL level", () => {
  assert.match(prestigeLib, /ON CONFLICT \(user_id, source, source_id\) DO NOTHING/);
  assert.match(prestigeLib, /FOR UPDATE/);
  assert.match(prestigeLib, /RETURNING id/);
});

test("every authoritative competitive settlement site wires the prestige hook", () => {
  // Expected number of applyPrestigeResult( CALL SITES per file (imports
  // are not calls). Every winner/loser terminal is one call; tower-arena
  // uses a single per-participant call (placement 1 wins, others lose) and
  // odds/pvp/pick settles both its timeout-forfeit and round-win paths.
  const callSites = {
    "src/lib/blackjack-pvp/serverStore.js": 2,
    "src/lib/mines-pvp/serverStore.js": 2,
    "src/lib/keno-pvp/serverStore.js": 2,
    "src/lib/lane-rush-duel/serverStore.js": 2,
    "src/lib/memory-grid/serverStore.js": 2,
    "src/lib/plinko-pvp/serverStore.js": 2,
    "src/lib/precision/finishMatch.ts": 2,
    "src/app/api/chess/move/route.js": 2,
    "src/app/api/chess/game-state/route.js": 2,
    "src/app/api/chess/end-game/route.js": 2,
    "src/app/api/uno/determine-winner/route.js": 2,
    "src/app/api/rps/pvp/choose/route.js": 2,
    "src/lib/rps-pvp/serverStore.js": 2,
    "src/app/api/dice-flush/_lib.js": 2,
    "src/app/api/pool/resign/route.ts": 2,
    "src/lib/fourInARowServer.js": 2,
    "src/lib/dotsAndBoxesServer.js": 2,
    "src/lib/tower-arena/serverStore.ts": 1,
    "src/app/api/hex-duel/multiplayer/end/route.ts": 2,
    "src/app/api/odds/pvp/pick/route.ts": 4,
    "src/app/api/odds/pvp/forfeit/route.ts": 2,
    "src/app/api/odds/pvp/cleanup/route.ts": 2,
  };
  for (const [file, expected] of Object.entries(callSites)) {
    const calls = read(file).match(/applyPrestigeResult\s*\(/g) || [];
    assert.equal(
      calls.length,
      expected,
      `${file} should contain ${expected} applyPrestigeResult call site(s), found ${calls.length}`,
    );
  }
});

test("prestige source keys are stable and well-formed across all wired modes", () => {
  const sourceByFile = {
    "src/app/api/chess/move/route.js": "chess",
    "src/app/api/chess/game-state/route.js": "chess",
    "src/app/api/chess/end-game/route.js": "chess",
    "src/app/api/uno/determine-winner/route.js": "uno",
    "src/app/api/rps/pvp/choose/route.js": "rps-pvp",
    "src/lib/rps-pvp/serverStore.js": "rps-pvp",
    "src/app/api/dice-flush/_lib.js": "dice-flush",
    "src/app/api/pool/resign/route.ts": "pool",
    "src/lib/fourInARowServer.js": "four-in-a-row",
    "src/lib/dotsAndBoxesServer.js": "dots-and-boxes",
    "src/lib/tower-arena/serverStore.ts": "tower-arena",
    "src/app/api/hex-duel/multiplayer/end/route.ts": "hex-duel",
    "src/app/api/odds/pvp/pick/route.ts": "odds-pvp",
    "src/app/api/odds/pvp/forfeit/route.ts": "odds-pvp",
    "src/app/api/odds/pvp/cleanup/route.ts": "odds-pvp",
  };
  for (const [file, key] of Object.entries(sourceByFile)) {
    assert.ok(
      read(file).includes(`source: "${key}"`),
      `${file} must use the stable prestige source key "${key}"`,
    );
    assert.match(
      key,
      /^[a-z0-9][a-z0-9._-]{0,63}$/,
      `invalid prestige source key: ${key}`,
    );
  }
});
