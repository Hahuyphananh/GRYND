import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { matchesAvailabilitySignal } from "../src/lib/availabilityAlerts.ts";

const migration = fs.readFileSync("src/db/migrations/0106_availability_alerts.sql", "utf8");

test("matches wildcard and constrained availability alerts", () => {
  const signal = { gameKey: "keno-pvp", mode: "pvp", region: "eu", playerCount: 2, availabilityKey: "keno:pvp:eu" };
  assert.equal(matchesAvailabilitySignal({ gameKey: null, mode: "pvp", region: "eu", minPlayerCount: 2, maxWaitMs: null }, signal), true);
  assert.equal(matchesAvailabilitySignal({ gameKey: "pool", mode: "pvp", region: "eu", minPlayerCount: 2, maxWaitMs: null }, signal), false);
  assert.equal(matchesAvailabilitySignal({ gameKey: "keno-pvp", mode: "pvp", region: "eu", minPlayerCount: 3, maxWaitMs: null }, signal), false);
});

test("availability persistence has expiry, active state, and deduplication", () => {
  assert.match(migration, /expires_at timestamp/);
  assert.match(migration, /active boolean NOT NULL DEFAULT true/);
  assert.match(migration, /UNIQUE \(alert_id, availability_key\)/);
  assert.match(migration, /availability_alerts_active_lookup_idx/);
});
