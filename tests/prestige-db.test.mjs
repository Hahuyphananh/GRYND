/**
 * Permanent Prestige — optional DATABASE-backed integration checks.
 *
 * These exercise the REAL idempotency + atomicity path (prestige_results
 * journal + users row lock) against a Postgres database. They are SKIPPED
 * unless BOTH of these hold, so they can never fire against an un-migrated
 * or production database by accident:
 *   * DATABASE_URL is set, AND
 *   * PRESTIGE_DB_TESTS=1 (explicit opt-in — these tests WRITE rows).
 *
 * Safety: every test inserts its own throwaway user and deletes it (or rolls
 * the transaction back) afterward — nothing is left behind. Run against a
 * dedicated, MIGRATED (0136 applied) test database:
 *
 *   PRESTIGE_DB_TESTS=1 node --import tsx --test tests/prestige-db.test.mjs
 *
 * Covered here (mirrors the spec's integration rules):
 *   * a Level-100 win applies +1 and a loss applies -1 (never below 0)
 *   * 24/25 → win → Prestige 1 with 0/50; Prestige cannot be lost
 *   * level (derived from XP) and XP are untouched by prestige writes
 *   * a below-Level-100 player cannot gain progress (event journaled, no-op)
 *   * a duplicate result (same source + source_id) can never apply twice
 *   * two concurrent settlements of the same match apply exactly once
 */

import test from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";

import { db } from "../src/db";
import { users } from "../src/db/schema";
import { applyPrestigeResult } from "../src/lib/prestige.js";

const hasDb = Boolean(process.env.DATABASE_URL);
const optIn = process.env.PRESTIGE_DB_TESTS === "1";
// node:test skip option — a string skips with that reason, false runs.
const dbTestOptions = hasDb
  ? optIn
    ? {}
    : { skip: "PRESTIGE_DB_TESTS=1 not set (write tests require explicit opt-in)" }
  : { skip: "DATABASE_URL not set" };

const GAME = "prestige-test-game";
const LEVEL_100_XP = 70000; // > expToReachLevel(100) = 63360

function rand() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Insert a throwaway user (returns clerkId) — cleanup is the test's job. */
async function seedUser({ xp = LEVEL_100_XP, prestigeLevel = 0, prestigeNetWins = 0 } = {}) {
  const clerkId = `prestige-test-${rand()}`;
  const [row] = await db
    .insert(users)
    .values({
      clerkId,
      name: `Prestige Test ${rand()}`,
      email: `prestige-test-${rand()}@example.test`,
      password: "not-a-real-password",
      xp,
      prestigeLevel,
      prestigeNetWins,
    })
    .returning({ id: users.id });
  return { clerkId, userId: row.id };
}

async function cleanupUser(clerkId) {
  await db.delete(users).where(sql`clerk_id = ${clerkId}`);
}

async function readPrestige(clerkId) {
  const [row] = await db
    .select({
      xp: users.xp,
      prestigeLevel: users.prestigeLevel,
      prestigeNetWins: users.prestigeNetWins,
    })
    .from(users)
    .where(sql`clerk_id = ${clerkId}`)
    .limit(1);
  return row;
}

test(
  "Level-100 win applies +1 and preserves XP and the Level-100 cap",
  { ...dbTestOptions },
  async () => {
    const { clerkId, userId } = await seedUser({ xp: LEVEL_100_XP, prestigeLevel: 0, prestigeNetWins: 5 });
    try {
      const before = await readPrestige(clerkId);
      const r = await applyPrestigeResult({ clerkId, outcome: "win", source: GAME, sourceId: "m1" });
      assert.equal(r.applied, true);
      assert.equal(r.delta, 1);
      const after = await readPrestige(clerkId);
      assert.equal(after.prestigeNetWins, 6);
      assert.equal(after.prestigeLevel, 0);
      // XP untouched → Battle Pass level (derived from XP) stays 100.
      assert.equal(Number(after.xp), before.xp);
      assert.ok(userId > 0);
    } finally {
      await cleanupUser(clerkId);
    }
  },
);

test(
  "Level-100 loss applies -1 and never goes below 0",
  { ...dbTestOptions },
  async () => {
    const { clerkId } = await seedUser({ xp: LEVEL_100_XP, prestigeNetWins: 3 });
    try {
      const loss = await applyPrestigeResult({ clerkId, outcome: "loss", source: GAME, sourceId: "l1" });
      assert.equal(loss.delta, -1);
      assert.equal((await readPrestige(clerkId)).prestigeNetWins, 2);

      // Floor: two more losses clamp at 0.
      await applyPrestigeResult({ clerkId, outcome: "loss", source: GAME, sourceId: "l2" });
      await applyPrestigeResult({ clerkId, outcome: "loss", source: GAME, sourceId: "l3" });
      await applyPrestigeResult({ clerkId, outcome: "loss", source: GAME, sourceId: "l4" });
      const after = await readPrestige(clerkId);
      assert.equal(after.prestigeNetWins, 0);
    } finally {
      await cleanupUser(clerkId);
    }
  },
);

test(
  "24/25 win awards Prestige 1 with 0 net wins, and Prestige 1 can never be lost",
  { ...dbTestOptions },
  async () => {
    const { clerkId } = await seedUser({ xp: LEVEL_100_XP, prestigeLevel: 0, prestigeNetWins: 24 });
    try {
      const up = await applyPrestigeResult({ clerkId, outcome: "win", source: GAME, sourceId: "t1" });
      assert.equal(up.prestigeLevel, 1);
      assert.equal(up.prestigeNetWins, 0);
      let after = await readPrestige(clerkId);
      assert.equal(after.prestigeLevel, 1);
      assert.equal(after.prestigeNetWins, 0);

      // A loss at Prestige 1 progress 0 must not demote.
      const down = await applyPrestigeResult({ clerkId, outcome: "loss", source: GAME, sourceId: "t2" });
      assert.equal(down.delta, 0);
      after = await readPrestige(clerkId);
      assert.equal(after.prestigeLevel, 1);
      assert.equal(after.prestigeNetWins, 0);
    } finally {
      await cleanupUser(clerkId);
    }
  },
);

test(
  "a below-Level-100 player cannot gain Prestige progression",
  { ...dbTestOptions },
  async () => {
    const { clerkId } = await seedUser({ xp: 1000, prestigeNetWins: 0 }); // low level
    try {
      const r = await applyPrestigeResult({ clerkId, outcome: "win", source: GAME, sourceId: "p1" });
      assert.equal(r.applied, true); // event journaled for idempotency…
      assert.equal(r.delta, 0); // …but nothing applied
      const after = await readPrestige(clerkId);
      assert.equal(after.prestigeLevel, 0);
      assert.equal(after.prestigeNetWins, 0);
    } finally {
      await cleanupUser(clerkId);
    }
  },
);

test(
  "duplicate result for the same match can never award twice",
  { ...dbTestOptions },
  async () => {
    const { clerkId } = await seedUser({ xp: LEVEL_100_XP, prestigeNetWins: 10 });
    try {
      const first = await applyPrestigeResult({ clerkId, outcome: "win", source: GAME, sourceId: "dup-1" });
      assert.equal(first.applied, true);
      assert.equal(first.prestigeNetWins, 11);

      // Retry / reconnect / double processing of the SAME match id.
      const second = await applyPrestigeResult({ clerkId, outcome: "win", source: GAME, sourceId: "dup-1" });
      assert.equal(second.applied, false);
      assert.equal(second.reason, "duplicate");
      assert.equal((await readPrestige(clerkId)).prestigeNetWins, 11);
    } finally {
      await cleanupUser(clerkId);
    }
  },
);

test(
  "concurrent settlement of the same match applies exactly once",
  { ...dbTestOptions },
  async () => {
    const { clerkId } = await seedUser({ xp: LEVEL_100_XP, prestigeNetWins: 20 });
    try {
      const results = await Promise.all(
        Array.from({ length: 4 }, () =>
          applyPrestigeResult({ clerkId, outcome: "win", source: GAME, sourceId: "race-1" }),
        ),
      );
      const applied = results.filter((r) => r.applied);
      assert.equal(applied.length, 1, "only one concurrent settlement may apply");
      assert.equal(applied[0].prestigeNetWins, 21);
      const after = await readPrestige(clerkId);
      assert.equal(after.prestigeNetWins, 21);
    } finally {
      await cleanupUser(clerkId);
    }
  },
);
