// tests/hex-duel-territory-levels.test.mjs
//
// Territory progression: every territory has a permanent level 1–4, the level
// sets its troop ceiling, and upgrading costs troops from the tile itself.
//
// Run: node --import tsx --test tests/hex-duel-territory-levels.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  HEX_DUEL_CAPITALS,
  INITIAL_TERRITORY_LEVEL,
  MAX_TERRITORY_LEVEL,
  P1_CAP_KEY,
  P2_CAP_KEY,
  TERRITORY_LEVELS,
  applyRecordedMove,
  checkHexDuelMove,
  coreReducer,
  getUpgradeInfo,
  makeInitialCore,
  territoryLevelOf,
  territoryMaxTroops,
  upgradeCostFor,
} from "../src/lib/hex-duel/rules.ts";
import { HEX_DUEL_MOVE_TYPES, replayHexDuel } from "../src/lib/hex-duel/authority.ts";

const P1_CAP = P1_CAP_KEY;
const P2_CAP = P2_CAP_KEY;
const SEATS = { player1Id: "user_1", player2Id: "user_2" };

/** A board with the capital owned by player1 at `troops`, at `level`. */
function board({ troops = 5, level = 1 } = {}) {
  const state = makeInitialCore();
  state.tileTroops[P1_CAP] = troops;
  state.territoryLevels[P1_CAP] = level;
  return state;
}

// ── The level table ──────────────────────────────────────────────────────

test("the level table matches the rulebook", () => {
  assert.deepEqual(TERRITORY_LEVELS[1], { maxTroops: 10, upgradeCost: 5 });
  assert.deepEqual(TERRITORY_LEVELS[2], { maxTroops: 20, upgradeCost: 10 });
  assert.deepEqual(TERRITORY_LEVELS[3], { maxTroops: 50, upgradeCost: 25 });
  assert.deepEqual(TERRITORY_LEVELS[4], { maxTroops: 100, upgradeCost: null });
  assert.equal(territoryMaxTroops(MAX_TERRITORY_LEVEL), 100);
  assert.equal(upgradeCostFor(MAX_TERRITORY_LEVEL), null);
});

test("start capitals are level 1 and conquerable tiles start at level 1", () => {
  const state = makeInitialCore();
  assert.equal(state.territoryLevels[P1_CAP], INITIAL_TERRITORY_LEVEL);
  assert.equal(state.territoryLevels[P2_CAP], INITIAL_TERRITORY_LEVEL);
  assert.equal(territoryMaxTroops(INITIAL_TERRITORY_LEVEL), 10);

  const after = applyRecordedMove(state, "player1", {
    type: "attack",
    sourceKey: P1_CAP,
    targetKey: "1,0",
    troopCount: 2,
  });
  assert.equal(after.capturedTiles["1,0"], "player1");
  assert.equal(territoryLevelOf(after, "1,0"), 1, "conquest lands at level 1");
  assert.equal(after.territoryLevels["1,0"], 1);
});

// ── The three upgrades ───────────────────────────────────────────────────

test("level 1 → 2 costs 5 troops and raises the ceiling to 20", () => {
  const state = board({ troops: 8, level: 1 });
  const after = applyRecordedMove(state, "player1", { type: "upgrade", sourceKey: P1_CAP });

  assert.equal(after.territoryLevels[P1_CAP], 2);
  assert.equal(after.tileTroops[P1_CAP], 4, "8 - 5 cost + 1 growth");
  assert.equal(after.currentTurn, "player2", "the upgrade ends the turn");
  assert.equal(after.moveCount, 1);
  assert.equal(territoryMaxTroops(territoryLevelOf(after, P1_CAP)), 20);
});

test("level 2 → 3 costs 10 troops and raises the ceiling to 50", () => {
  const state = board({ troops: 15, level: 2 });
  const after = applyRecordedMove(state, "player1", { type: "upgrade", sourceKey: P1_CAP });

  assert.equal(after.territoryLevels[P1_CAP], 3);
  assert.equal(after.tileTroops[P1_CAP], 6, "15 - 10 cost + 1 growth");
  assert.equal(territoryMaxTroops(territoryLevelOf(after, P1_CAP)), 50);
});

test("level 3 → 4 costs 25 troops and raises the ceiling to 100", () => {
  const state = board({ troops: 30, level: 3 });
  const after = applyRecordedMove(state, "player1", { type: "upgrade", sourceKey: P1_CAP });

  assert.equal(after.territoryLevels[P1_CAP], 4);
  assert.equal(after.tileTroops[P1_CAP], 6, "30 - 25 cost + 1 growth");
  assert.equal(territoryMaxTroops(territoryLevelOf(after, P1_CAP)), 100);
});

// ── Refusals ─────────────────────────────────────────────────────────────

test("an upgrade needs enough troops to pay and still keep one", () => {
  const state = board({ troops: 5, level: 1 });
  const info = getUpgradeInfo(state, "player1", P1_CAP);
  assert.equal(info.ok, false);
  assert.equal(info.code, "NOT_ENOUGH_TROOPS");

  const check = checkHexDuelMove(state, "player1", { type: "upgrade", sourceKey: P1_CAP });
  assert.equal(check.ok, false);
  assert.equal(check.code, "NOT_ENOUGH_TROOPS");

  assert.deepEqual(
    applyRecordedMove(state, "player1", { type: "upgrade", sourceKey: P1_CAP }),
    state,
    "the reducer refuses it too",
  );

  // Exactly the cost + 1 is enough, and leaves exactly 1 (then grows to 2).
  const exact = board({ troops: 6, level: 1 });
  const after = applyRecordedMove(exact, "player1", { type: "upgrade", sourceKey: P1_CAP });
  assert.equal(after.territoryLevels[P1_CAP], 2);
  assert.equal(after.tileTroops[P1_CAP], 2);
});

test("level 4 cannot be upgraded further", () => {
  const state = board({ troops: 80, level: 4 });
  const info = getUpgradeInfo(state, "player1", P1_CAP);
  assert.equal(info.ok, false);
  assert.equal(info.code, "MAX_LEVEL");
  assert.equal(info.nextLevel, null);

  assert.equal(
    checkHexDuelMove(state, "player1", { type: "upgrade", sourceKey: P1_CAP }).code,
    "MAX_LEVEL",
  );
  assert.deepEqual(
    applyRecordedMove(state, "player1", { type: "upgrade", sourceKey: P1_CAP }),
    state,
  );
});

test("only the owner can upgrade a territory", () => {
  const state = board({ troops: 8, level: 1 });
  const info = getUpgradeInfo(state, "player1", P2_CAP);
  assert.equal(info.ok, false);
  assert.equal(info.code, "NOT_YOUR_TILE");

  const check = checkHexDuelMove(state, "player1", { type: "upgrade", sourceKey: P2_CAP });
  assert.equal(check.ok, false);
  assert.equal(check.code, "NOT_YOUR_TILE");
  assert.equal(checkHexDuelMove(state, "player2", { type: "upgrade", sourceKey: P2_CAP }).code, "NOT_YOUR_TURN");

  // And an out-of-turn upgrade from the owner of the other tile is refused by
  // the turn rule before ownership is even considered.
  assert.deepEqual(
    applyRecordedMove(state, "player2", { type: "upgrade", sourceKey: P2_CAP }),
    state,
  );
});

test("upgrading consumes the turn: a second action is refused", () => {
  const state = board({ troops: 12, level: 1 });
  const after = applyRecordedMove(state, "player1", { type: "upgrade", sourceKey: P1_CAP });
  assert.equal(after.currentTurn, "player2");

  assert.equal(
    checkHexDuelMove(after, "player1", { type: "upgrade", sourceKey: P1_CAP }).code,
    "NOT_YOUR_TURN",
  );
  assert.deepEqual(
    applyRecordedMove(after, "player1", { type: "upgrade", sourceKey: P1_CAP }),
    after,
    "no second upgrade, no second growth, no second flip",
  );
});

// ── Capacity: growth, displacement, combat ───────────────────────────────

test("passive growth stops at the territory's ceiling", () => {
  const l1 = applyRecordedMove(board({ troops: 10, level: 1 }), "player1", { type: "skipRound" });
  assert.equal(l1.tileTroops[P1_CAP], 10, "level 1 caps at 10");

  const l2 = applyRecordedMove(board({ troops: 20, level: 2 }), "player1", { type: "skipRound" });
  assert.equal(l2.tileTroops[P1_CAP], 20, "level 2 caps at 20");

  const l4 = applyRecordedMove(board({ troops: 100, level: 4 }), "player1", { type: "skipRound" });
  assert.equal(l4.tileTroops[P1_CAP], 100, "level 4 caps at 100");

  const room = applyRecordedMove(board({ troops: 9, level: 1 }), "player1", { type: "skipRound" });
  assert.equal(room.tileTroops[P1_CAP], 10, "still grows while there is room");
});

test("displacement can never exceed the destination's capacity", () => {
  const state = board({ troops: 5, level: 1 });
  state.capturedTiles["1,0"] = "player1";
  state.tileTroops["1,0"] = 9;
  state.territoryLevels["1,0"] = 1;

  const tooMany = checkHexDuelMove(state, "player1", {
    type: "displace",
    sourceKey: P1_CAP,
    targetKey: "1,0",
    troopCount: 2,
  });
  assert.equal(tooMany.ok, false);
  assert.equal(tooMany.code, "CAPACITY");

  const refused = applyRecordedMove(state, "player1", {
    type: "displace",
    sourceKey: P1_CAP,
    targetKey: "1,0",
    troopCount: 2,
  });
  assert.deepEqual(refused, state, "no troops invented or deleted");
  assert.equal(refused.currentTurn, "player1");

  const fits = checkHexDuelMove(state, "player1", {
    type: "displace",
    sourceKey: P1_CAP,
    targetKey: "1,0",
    troopCount: 1,
  });
  assert.equal(fits.ok, true);

  const after = applyRecordedMove(state, "player1", {
    type: "displace",
    sourceKey: P1_CAP,
    targetKey: "1,0",
    troopCount: 1,
  });
  assert.equal(after.tileTroops["1,0"], 10, "fills the tile exactly");
  assert.equal(after.currentTurn, "player2");
});

test("an upgraded destination accepts more troops", () => {
  const state = board({ troops: 5, level: 1 });
  state.capturedTiles["1,0"] = "player1";
  state.tileTroops["1,0"] = 9;
  state.territoryLevels["1,0"] = 2; // ceiling 20

  const after = applyRecordedMove(state, "player1", {
    type: "displace",
    sourceKey: P1_CAP,
    targetKey: "1,0",
    troopCount: 2,
  });
  assert.equal(after.tileTroops["1,0"], 12, "9 + 2 displaced + 1 growth");
  assert.equal(after.territoryLevels["1,0"], 2, "displacement never changes a level");
});

test("a conquest is capped by the level-1 ceiling, and over-sends are refused", () => {
  const state = board({ troops: 12, level: 1 });

  const over = checkHexDuelMove(state, "player1", {
    type: "attack",
    sourceKey: P1_CAP,
    targetKey: "1,0",
    troopCount: 11,
  });
  assert.equal(over.ok, false);
  assert.equal(over.code, "CAPACITY");

  const legal = checkHexDuelMove(state, "player1", {
    type: "attack",
    sourceKey: P1_CAP,
    targetKey: "1,0",
    troopCount: 10,
  });
  assert.equal(legal.ok, true);

  const after = applyRecordedMove(state, "player1", {
    type: "attack",
    sourceKey: P1_CAP,
    targetKey: "1,0",
    troopCount: 10,
  });
  assert.equal(after.tileTroops["1,0"], 10, "conquered at level 1, ten survivors");
  assert.equal(territoryLevelOf(after, "1,0"), 1);
});

test("conquering a high-level territory resets it to level 1", () => {
  const state = board({ troops: 11, level: 1 });
  state.capturedTiles["1,0"] = "player2";
  state.tileTroops["1,0"] = 2;
  state.territoryLevels["1,0"] = 3;

  const after = applyRecordedMove(state, "player1", {
    type: "attack",
    sourceKey: P1_CAP,
    targetKey: "1,0",
    troopCount: 8,
  });

  assert.equal(after.capturedTiles["1,0"], "player1", "ownership changed");
  assert.equal(after.territoryLevels["1,0"], 1, "ownership change resets the level");
  assert.equal(after.tileTroops["1,0"], 7, "6 survivors + 1 growth");
});

test("a territory that becomes neutral loses its level", () => {
  const state = board({ troops: 5, level: 1 });
  state.capturedTiles["1,0"] = "player2";
  state.tileTroops["1,0"] = 3;
  state.territoryLevels["1,0"] = 2;

  // Exactly the defenders: mutual destruction leaves the tile neutral.
  const after = applyRecordedMove(state, "player1", {
    type: "attack",
    sourceKey: P1_CAP,
    targetKey: "1,0",
    troopCount: 3,
  });

  assert.equal(after.capturedTiles["1,0"], undefined);
  assert.equal(after.territoryLevels["1,0"], undefined, "no level on a neutral tile");
  assert.equal(territoryLevelOf(after, "1,0"), 1, "a neutral read is level 1");
});

// ── Determinism: reducer, replay, snapshots ──────────────────────────────

test("coreReducer and applyRecordedMove produce identical upgrade results", () => {
  const state = board({ troops: 12, level: 2 });

  const viaReducer = coreReducer(
    state,
    { type: "upgrade", sourceKey: P1_CAP, player: "player1" },
    HEX_DUEL_CAPITALS,
  );
  const viaRecorded = applyRecordedMove(state, "player1", {
    type: "upgrade",
    sourceKey: P1_CAP,
  });

  assert.deepEqual(viaReducer, viaRecorded);
  assert.equal(viaRecorded.territoryLevels[P1_CAP], 3);
});

test("a recorded upgrade replays identically on the server", () => {
  const rows = [
    { userId: SEATS.player1Id, actionType: "skipRound", sourceKey: null, targetKey: null, troopCount: null },
    { userId: SEATS.player2Id, actionType: "skipRound", sourceKey: null, targetKey: null, troopCount: null },
    { userId: SEATS.player1Id, actionType: "upgrade", sourceKey: P1_CAP, targetKey: null, troopCount: null },
  ];

  let local = makeInitialCore();
  local = applyRecordedMove(local, "player1", { type: "skipRound" });
  local = applyRecordedMove(local, "player2", { type: "skipRound" });
  local = applyRecordedMove(local, "player1", { type: "upgrade", sourceKey: P1_CAP });

  const replayed = replayHexDuel(SEATS, rows);

  assert.deepEqual(replayed.state, local);
  assert.equal(replayed.applied, 3);
  assert.equal(replayed.ignored, 0);
  assert.equal(replayed.state.territoryLevels[P1_CAP], 2);
  // 5 + 1 (skip) = 6, then -5 cost + 1 growth = 2.
  assert.equal(replayed.state.tileTroops[P1_CAP], 2);
});

test("the replayed state is identical for both seats and independent of the request", () => {
  // A client cannot name a level or a cost: the row only carries the tile.
  const rows = [
    { userId: SEATS.player1Id, actionType: "skipRound", sourceKey: null, targetKey: null, troopCount: null },
    { userId: SEATS.player2Id, actionType: "skipRound", sourceKey: null, targetKey: null, troopCount: null },
    // A hostile extra field is ignored because only sourceKey is read.
    { userId: SEATS.player1Id, actionType: "upgrade", sourceKey: P1_CAP, targetKey: null, troopCount: 999 },
  ];
  const replayed = replayHexDuel(SEATS, rows);
  assert.equal(replayed.state.territoryLevels[P1_CAP], 2);
  assert.equal(replayed.state.tileTroops[P1_CAP], 2);
});

test("snapshots normalize territory levels (old or junk maps read as level 1)", () => {
  const withJunk = coreReducer(
    makeInitialCore(),
    {
      type: "syncSnapshot",
      snapshot: {
        ...makeInitialCore(),
        territoryLevels: { [P1_CAP]: 9, [P2_CAP]: 2 },
      },
    },
    HEX_DUEL_CAPITALS,
  );
  assert.equal(withJunk.territoryLevels[P1_CAP], 1);
  assert.equal(withJunk.territoryLevels[P2_CAP], 2);

  const legacy = makeInitialCore();
  delete legacy.territoryLevels;
  const synced = coreReducer(legacy, { type: "syncSnapshot", snapshot: legacy }, HEX_DUEL_CAPITALS);
  assert.deepEqual(synced.territoryLevels, {}, "a snapshot without levels reads as all level 1");
  assert.equal(territoryLevelOf(synced, P1_CAP), 1);
});

test("the server's replay and action route accept the upgrade type", () => {
  assert.ok(HEX_DUEL_MOVE_TYPES.includes("upgrade"));

  const route = fs.readFileSync(
    "src/app/api/hex-duel/multiplayer/action/route.ts",
    "utf8",
  );
  assert.match(route, /ALLOWED_ACTION_TYPES = \[[^\]]*"upgrade"/);
  // The route never trusts a client-sent level or result.
  assert.doesNotMatch(route, /body\.(level|territoryLevel|upgradeCost)/);
});
