/**
 * energy-grant.test.mjs
 *
 * The daily energy grant (src/lib/tokens/energyGrant.ts) is the only free coin
 * faucet. It must top a low balance up to the floor, never above it, never by
 * more than the daily cap, and only once per UTC day.
 *
 * Run:  node --import tsx --test tests/energy-grant.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  ENERGY_GRANT_REFERENCE,
  energyGrantAmount,
  utcDayKey,
} from "../src/lib/tokens/energyGrant.ts";
import {
  DAILY_ENERGY_GRANT,
  ENERGY_GRANT_FLOOR,
  WALLET_HARD_CAP,
} from "../src/lib/games/economy.ts";

test("the grant tops a low balance up to the floor", () => {
  assert.equal(energyGrantAmount(0), ENERGY_GRANT_FLOOR);
  assert.equal(energyGrantAmount(100), ENERGY_GRANT_FLOOR - 100);
  assert.equal(energyGrantAmount(ENERGY_GRANT_FLOOR - 1), 1);
});

test("the grant never fires at or above the floor", () => {
  for (const balance of [
    ENERGY_GRANT_FLOOR,
    ENERGY_GRANT_FLOOR + 1,
    5_000,
    WALLET_HARD_CAP,
  ]) {
    assert.equal(energyGrantAmount(balance), 0, `balance ${balance}`);
  }
});

test("the grant never exceeds the daily cap", () => {
  // With the shipped numbers the cap and the floor are equal, so a fresh
  // balance lands exactly on the floor.
  assert.equal(energyGrantAmount(0), Math.min(DAILY_ENERGY_GRANT, ENERGY_GRANT_FLOOR));
  // A cap smaller than the shortfall is still honoured.
  assert.equal(energyGrantAmount(0, 500, 200), 200);
  // A player can never be topped past the floor by one grant.
  assert.ok(energyGrantAmount(0) <= ENERGY_GRANT_FLOOR);
});

test("a non-finite balance grants nothing rather than guessing", () => {
  for (const balance of [NaN, Infinity, -Infinity, undefined, "abc"]) {
    assert.equal(energyGrantAmount(balance), 0, `balance ${String(balance)}`);
  }
  // An empty balance (0, or a null that coerces to 0) is topped up to the
  // floor — not more.
  assert.equal(energyGrantAmount(null), ENERGY_GRANT_FLOOR);
  // A negative (impossible) balance is treated as empty, not as a bonus.
  assert.equal(energyGrantAmount(-500), ENERGY_GRANT_FLOOR);
});

test("the day key is the UTC calendar day", () => {
  assert.equal(utcDayKey(new Date("2026-03-09T23:59:59.999Z")), "2026-03-09");
  assert.equal(utcDayKey(new Date("2026-03-10T00:00:00.000Z")), "2026-03-10");
  // Two instants on the same UTC day share a key; the next day differs.
  assert.equal(
    utcDayKey(new Date("2026-03-10T01:00:00.000Z")),
    utcDayKey(new Date("2026-03-10T22:00:00.000Z")),
  );
  assert.notEqual(
    utcDayKey(new Date("2026-03-10T22:00:00.000Z")),
    utcDayKey(new Date("2026-03-11T00:00:00.000Z")),
  );
});

test("the grant records one ledger row per day and locks the player row", () => {
  const src = fs.readFileSync("src/lib/tokens/energyGrant.ts", "utf8");
  assert.ok(src.includes(ENERGY_GRANT_REFERENCE));
  // The reference id is day + player, so retries in one day are no-ops.
  assert.match(src, /referenceId = `\$\{utcDayKey\(now\)\}:\$\{clerkId\}`/);
  assert.match(src, /ledgerRowExists|existing\.length > 0/);
  // Atomic, guarded credit and the wallet ceiling.
  assert.match(src, /sql`\$\{users\.balance\} \+ \$\{credit\}`/);
  assert.match(src, /WALLET_HARD_CAP/);
  assert.match(src, /\.for\("update"\)/);
});
