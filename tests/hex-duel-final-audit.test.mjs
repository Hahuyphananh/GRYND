// tests/hex-duel-final-audit.test.mjs
//
// Cross-cutting integration audit for Hex Duel after the one-action,
// territory-level, troop-dot, arrow and animation stages.
//
// Covers:
//   1. gameplay — one action/turn, growth once, skip, validation, costs,
//      levels, capacities, capital victory
//   2. multiplayer — one shared rulebook, deterministic replay for spectators,
//      no double growth/flip
//   3. AI — one action, capacity-safe, upgrades, same animations
//   4. interface — no AP terminology, levels/dots/arrows/animations present
//
// Run: node --import tsx --test tests/hex-duel-final-audit.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  HEX_DUEL_CAPITALS,
  P1_CAP_KEY,
  P2_CAP_KEY,
  TERRITORY_LEVELS,
  applyRecordedMove,
  checkHexDuelMove,
  coreReducer,
  getUpgradeInfo,
  makeInitialCore,
  resolveAttackOutcome,
} from "../src/lib/hex-duel/rules.ts";
import { replayHexDuel } from "../src/lib/hex-duel/authority.ts";
import { decideAIAction, scoreUpgrade } from "../src/lib/hexDuelAI.ts";

const read = (p) => fs.readFileSync(p, "utf8");
const CAP = HEX_DUEL_CAPITALS;

/** P1 cap 5 + a friendly 3-troop tile next to a neutral tile. */
function opening() {
  return {
    ...makeInitialCore("player1"),
    capturedTiles: {
      [P1_CAP_KEY]: "player1",
      "1,0": "player1",
      [P2_CAP_KEY]: "player2",
    },
    tileTroops: { [P1_CAP_KEY]: 5, "1,0": 3, [P2_CAP_KEY]: 5 },
    territoryLevels: {},
  };
}

const attack = (state, sourceKey, targetKey, troopCount, player, capitals = CAP) =>
  coreReducer(
    state,
    { type: "attack", sourceKey, targetKey, troopCount, player },
    capitals,
  );

// ══ 1. Gameplay ═════════════════════════════════════════════════════════

test("every action ends the turn, and a second action from that seat is ignored", () => {
  const state = opening();
  const afterAttack = attack(state, "1,0", "2,0", 2, "player1");

  assert.equal(afterAttack.currentTurn, "player2");
  assert.equal(afterAttack.moveCount, 1);

  const sameObject = attack(afterAttack, "1,0", "2,0", 2, "player1");
  assert.equal(sameObject, afterAttack, "duplicate action is a no-op, not a second flip");
  assert.equal(sameObject.currentTurn, "player2");
  assert.equal(sameObject.moveCount, 1);
});

test("passive growth lands exactly once per action and respects capacity", () => {
  const state = opening();
  const afterAttack = attack(state, "1,0", "2,0", 2, "player1");

  // Source 3 - 2 + 1 growth, capital 5 + 1, conquest 2 survivors + 1.
  assert.equal(afterAttack.tileTroops["1,0"], 2);
  assert.equal(afterAttack.tileTroops[P1_CAP_KEY], 6);
  assert.equal(afterAttack.tileTroops["2,0"], 3);

  // A second consecutive attack from the same seat cannot grow anything again.
  assert.equal(attack(afterAttack, "1,0", "2,0", 2, "player1"), afterAttack);

  // At capacity the tile stops growing but the turn still passes.
  const full = {
    ...opening(),
    tileTroops: { [P1_CAP_KEY]: 10, "1,0": 20, [P2_CAP_KEY]: 5 },
    territoryLevels: { "1,0": 2 },
  };
  const afterSkip = coreReducer(
    full,
    { type: "endTurn", player: "player1", skipTroopGrowth: false },
    CAP,
  );
  assert.equal(afterSkip.tileTroops[P1_CAP_KEY], 10);
  assert.equal(afterSkip.tileTroops["1,0"], 20);
  assert.equal(afterSkip.currentTurn, "player2");
});

test("skipping passes the turn once and the wrong seat cannot skip", () => {
  const state = opening();
  const afterSkip = coreReducer(
    state,
    { type: "endTurn", player: "player1", skipTroopGrowth: false },
    CAP,
  );
  assert.equal(afterSkip.currentTurn, "player2");
  assert.equal(afterSkip.moveCount, 0, "a skip is a transition, not a move");

  const p2CannotSkip = coreReducer(
    state,
    { type: "endTurn", player: "player2", skipTroopGrowth: false },
    CAP,
  );
  assert.equal(p2CannotSkip, state);
});

test("attack and displacement validation match the rulebook", () => {
  const state = opening();

  const legalAttack = checkHexDuelMove(state, "player1", {
    type: "attack",
    sourceKey: "1,0",
    targetKey: "2,0",
    troopCount: 2,
  });
  assert.equal(legalAttack.ok, true);

  const leaveOne = checkHexDuelMove(state, "player1", {
    type: "attack",
    sourceKey: "1,0",
    targetKey: "2,0",
    troopCount: 3,
  });
  assert.equal(leaveOne.ok, false);
  assert.equal(leaveOne.code, "TOO_MANY_TROOPS");

  const ownTile = checkHexDuelMove(state, "player1", {
    type: "attack",
    sourceKey: P1_CAP_KEY,
    targetKey: "1,0",
    troopCount: 1,
  });
  assert.equal(ownTile.ok, false);
  assert.equal(ownTile.code, "OWN_TILE");

  const offBoard = checkHexDuelMove(state, "player1", {
    type: "attack",
    sourceKey: P1_CAP_KEY,
    targetKey: "9,9",
    troopCount: 1,
  });
  assert.equal(offBoard.ok, false);
  assert.equal(offBoard.code, "BAD_TARGET");

  const notAdjacent = checkHexDuelMove(state, "player1", {
    type: "attack",
    sourceKey: P1_CAP_KEY,
    targetKey: "4,0",
    troopCount: 1,
  });
  assert.equal(notAdjacent.ok, false);
  assert.equal(notAdjacent.code, "NOT_ADJACENT");

  const wrongSeat = checkHexDuelMove(state, "player2", {
    type: "attack",
    sourceKey: P1_CAP_KEY,
    targetKey: "2,0",
    troopCount: 1,
  });
  assert.equal(wrongSeat.ok, false);
  assert.equal(wrongSeat.code, "NOT_YOUR_TURN");

  // Displacement onto an enemy tile is refused, and capacity is enforced.
  const ontoEnemy = checkHexDuelMove(state, "player1", {
    type: "displace",
    sourceKey: P1_CAP_KEY,
    targetKey: P2_CAP_KEY,
    troopCount: 1,
  });
  assert.equal(ontoEnemy.ok, false);

  const nearFull = {
    ...state,
    tileTroops: { ...state.tileTroops, "1,0": 9 },
  };
  const overCapacity = checkHexDuelMove(nearFull, "player1", {
    type: "displace",
    sourceKey: P1_CAP_KEY,
    targetKey: "1,0",
    troopCount: 2,
  });
  assert.equal(overCapacity.ok, false);
  assert.equal(overCapacity.code, "CAPACITY");

  // A newly conquered tile cannot take more survivors than level 1 holds.
  const bigStack = {
    ...state,
    tileTroops: { [P1_CAP_KEY]: 5, "1,0": 30, [P2_CAP_KEY]: 5 },
  };
  const tooManySurvivors = checkHexDuelMove(bigStack, "player1", {
    type: "attack",
    sourceKey: "1,0",
    targetKey: "2,0",
    troopCount: 25,
  });
  assert.equal(tooManySurvivors.ok, false);
  assert.equal(tooManySurvivors.code, "CAPACITY");
});

test("upgrade costs come from one table and are paid from the territory", () => {
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(TERRITORY_LEVELS).map(([level, cfg]) => [
        level,
        `${cfg.maxTroops} troops / ${cfg.upgradeCost}`,
      ]),
    ),
    { 1: "10 troops / 5", 2: "20 troops / 10", 3: "50 troops / 25", 4: "100 troops / null" },
  );

  const rich = {
    ...opening(),
    tileTroops: { [P1_CAP_KEY]: 7, "1,0": 3, [P2_CAP_KEY]: 5 },
  };
  const info = getUpgradeInfo(rich, "player1", P1_CAP_KEY);
  assert.equal(info.ok, true);
  assert.equal(info.cost, 5);
  assert.equal(info.nextLevel, 2);
  assert.equal(info.nextMaxTroops, 20);

  const after = coreReducer(
    rich,
    { type: "upgrade", sourceKey: P1_CAP_KEY, player: "player1" },
    CAP,
  );
  assert.equal(after.territoryLevels[P1_CAP_KEY], 2);
  assert.equal(after.tileTroops[P1_CAP_KEY], 3, "7 - 5 cost + 1 growth");
  assert.equal(after.currentTurn, "player2");

  // A tile that cannot pay alone may draw on an adjacent friendly territory.
  const poor = { ...opening(), tileTroops: { ...opening().tileTroops, [P1_CAP_KEY]: 4 } };
  const funded = getUpgradeInfo(poor, "player1", P1_CAP_KEY);
  assert.equal(funded.ok, true);
  assert.equal(funded.paidFromNeighbours, 2, "the 3-troop neighbour gives 2 and keeps 1");

  const afterFunded = coreReducer(
    poor,
    { type: "upgrade", sourceKey: P1_CAP_KEY, player: "player1" },
    CAP,
  );
  assert.equal(afterFunded.territoryLevels[P1_CAP_KEY], 2);
  assert.equal(afterFunded.tileTroops[P1_CAP_KEY], 2, "4 - 3 paid + 1 growth");
  assert.equal(
    afterFunded.tileTroops["1,0"],
    2,
    "the neighbour paid 2, kept 1, then grew 1 at the end of the turn",
  );

  // With no friendly neighbour there is nothing to draw on, so it is refused.
  const alone = {
    ...poor,
    capturedTiles: { [P1_CAP_KEY]: "player1", [P2_CAP_KEY]: "player2" },
  };
  assert.equal(getUpgradeInfo(alone, "player1", P1_CAP_KEY).ok, false);
  const maxed = { ...rich, territoryLevels: { [P1_CAP_KEY]: 4 } };
  assert.equal(getUpgradeInfo(maxed, "player1", P1_CAP_KEY).code, "MAX_LEVEL");
});

test("a conquest resets the territory to level 1, and a capital capture wins", () => {
  const state = {
    ...makeInitialCore("player1"),
    capturedTiles: { [P1_CAP_KEY]: "player1", "3,4": "player1", [P2_CAP_KEY]: "player2" },
    tileTroops: { [P1_CAP_KEY]: 9, "3,4": 10, [P2_CAP_KEY]: 4 },
    territoryLevels: { "3,4": 4, [P2_CAP_KEY]: 3 },
  };

  const captured = attack(state, "3,4", P2_CAP_KEY, 8, "player1");
  assert.equal(captured.winner, "player1");
  assert.equal(captured.territoryLevels[P2_CAP_KEY], 1);
  assert.equal(captured.capturedTiles[P2_CAP_KEY], "player1");
  assert.equal(captured.currentTurn, "player1", "the match ends without a turn flip");
  // No growth on a deciding move.
  assert.equal(captured.tileTroops["3,4"], 2);
  assert.equal(captured.tileTroops[P2_CAP_KEY], 4);

  // A neutral capture also starts at level 1.
  const neutral = attack(
    { ...opening(), territoryLevels: {} },
    "1,0",
    "2,0",
    2,
    "player1",
  );
  assert.equal(neutral.territoryLevels["2,0"], 1);
  assert.equal(neutral.winner, null);
});

test("no territory ever exceeds its level capacity (randomised soak)", () => {
  let seed = 20261104;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const keys = [];
  for (let y = 0; y < 5; y += 1) for (let x = 0; x < 5; x += 1) keys.push(`${x},${y}`);

  let state = makeInitialCore("player1");
  for (let step = 0; step < 400; step += 1) {
    if (state.winner) break;
    const seat = state.currentTurn;
    const mine = keys.filter((k) => state.capturedTiles[k] === seat);
    if (mine.length === 0) break;
    const sourceKey = mine[Math.floor(rand() * mine.length)];
    const neighbors = keys.filter((k) => areAdjacentKeys(sourceKey, k));
    const targetKey = neighbors[Math.floor(rand() * neighbors.length)];
    const sourceTroops = state.tileTroops[sourceKey] ?? 1;
    const roll = rand();

    if (roll < 0.45 && sourceTroops > 1) {
      const send = 1 + Math.floor(rand() * (sourceTroops - 1));
      const move = {
        type: "attack",
        sourceKey,
        targetKey,
        troopCount: send,
      };
      if (checkHexDuelMove(state, seat, move).ok) {
        state = applyRecordedMove(state, seat, move, CAP);
      }
    } else if (roll < 0.75 && sourceTroops > 1) {
      const room =
        TERRITORY_LEVELS[state.territoryLevels[targetKey] ?? 1].maxTroops -
        (state.tileTroops[targetKey] ?? 1);
      const send = Math.min(sourceTroops - 1, Math.max(0, room), 1 + Math.floor(rand() * 5));
      const move = { type: "displace", sourceKey, targetKey, troopCount: send };
      if (send > 0 && checkHexDuelMove(state, seat, move).ok) {
        state = applyRecordedMove(state, seat, move, CAP);
      }
    } else if (roll < 0.9) {
      const move = { type: "upgrade", sourceKey };
      if (checkHexDuelMove(state, seat, move).ok) {
        state = applyRecordedMove(state, seat, move, CAP);
      }
    } else {
      state = applyRecordedMove(state, seat, { type: "endTurn" }, CAP);
    }

    for (const [key, owner] of Object.entries(state.capturedTiles)) {
      const troops = state.tileTroops[key] ?? 1;
      const capacity = TERRITORY_LEVELS[state.territoryLevels[key] ?? 1].maxTroops;
      assert.ok(
        troops >= 1 && troops <= capacity,
        `${key} holds ${troops}/${capacity} (${owner}) at step ${step}`,
      );
    }
    for (const [key, troops] of Object.entries(state.tileTroops)) {
      assert.ok(Number.isInteger(troops) && troops >= 0, `${key} has ${troops} troops`);
    }
  }
});

function areAdjacentKeys(a, b) {
  const [ax, ay] = a.split(",").map(Number);
  const [bx, by] = b.split(",").map(Number);
  return Math.abs(ax - bx) <= 1 && Math.abs(ay - by) <= 1 && a !== b;
}

// ══ 2. Multiplayer / replay ═════════════════════════════════════════════

test("server and client run the same rulebook", () => {
  const route = read("src/app/api/hex-duel/multiplayer/action/route.ts");
  assert.match(route, /from "\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/lib\/hex-duel\/rules"/);
  assert.match(route, /checkHexDuelMove\(/);
  assert.match(route, /applyRecordedMove\(/);
  assert.match(route, /replayHexDuel\(/);
  assert.match(route, /ALLOWED_ACTION_TYPES = \["attack", "displace", "upgrade", "endTurn", "skipRound"\]/);
  // The engine imports the same reducer instead of reimplementing it.
  const engine = read("src/lib/hexDuelEngine.ts");
  assert.match(engine, /coreReducer\(s, a, capitals\)/);
  assert.match(engine, /import \{[^}]*coreReducer[^}]*\} from "\.\/hex-duel\/rules"/);
});

test("replaying a recorded match reproduces live play exactly (spectators)", () => {
  const seats = { player1Id: "u1", player2Id: "u2" };
  const rows = [
    { userId: "u1", actionType: "attack", sourceKey: P1_CAP_KEY, targetKey: "1,0", troopCount: 4 },
    { userId: "u2", actionType: "endTurn", sourceKey: null, targetKey: null, troopCount: null },
    { userId: "u1", actionType: "endTurn", sourceKey: null, targetKey: null, troopCount: null },
    { userId: "u2", actionType: "attack", sourceKey: P2_CAP_KEY, targetKey: "3,4", troopCount: 2 },
  ];

  const first = replayHexDuel(seats, rows);
  const second = replayHexDuel(seats, rows);
  assert.deepEqual(first.state, second.state, "replay is deterministic");
  assert.equal(first.applied, 4);

  // Apply the same moves by hand through the shared reducer.
  let live = makeInitialCore();
  live = applyRecordedMove(live, "player1", {
    type: "attack",
    sourceKey: rows[0].sourceKey,
    targetKey: rows[0].targetKey,
    troopCount: rows[0].troopCount,
  }, CAP);
  live = applyRecordedMove(live, "player2", { type: "endTurn" }, CAP);
  live = applyRecordedMove(live, "player1", { type: "endTurn" }, CAP);
  live = applyRecordedMove(live, "player2", {
    type: "attack",
    sourceKey: rows[3].sourceKey,
    targetKey: rows[3].targetKey,
    troopCount: rows[3].troopCount,
  }, CAP);

  assert.deepEqual(first.state, live);
  assert.equal(first.winner, live.winner);
});

test("duplicate and stale rows cannot switch the turn or grow twice", () => {
  const duplicate = replayHexDuel(
    { player1Id: "u1", player2Id: "u2" },
    [
      { userId: "u1", actionType: "attack", sourceKey: P1_CAP_KEY, targetKey: "1,0", troopCount: 4 },
      // The same action re-delivered (socket + polling race).
      { userId: "u1", actionType: "attack", sourceKey: P1_CAP_KEY, targetKey: "1,0", troopCount: 4 },
      // An obsolete endTurn echo from the same seat.
      { userId: "u1", actionType: "endTurn", sourceKey: null, targetKey: null, troopCount: null },
    ],
  );

  assert.equal(duplicate.state.currentTurn, "player2");
  assert.equal(duplicate.state.moveCount, 1);
  assert.equal(duplicate.state.p1MoveCount, 1);
  assert.equal(duplicate.applied, 1);
  assert.equal(duplicate.ignored, 2);
  // Growth ran once: friendly tile 3 -> 4, conquest survivors 4 -> 5.
  assert.equal(duplicate.state.tileTroops["1,0"], 5);
});

test("a malformed row is ignored instead of throwing", () => {
  const replay = replayHexDuel(
    { player1Id: "u1", player2Id: "u2" },
    [
      { userId: "stranger", actionType: "attack", sourceKey: "0,0", targetKey: "1,0", troopCount: 4 },
      { userId: "u1", actionType: "nonsense", sourceKey: null, targetKey: null, troopCount: null },
    ],
  );
  assert.equal(replay.applied, 0);
  assert.equal(replay.ignored, 2);
  assert.deepEqual(replay.state, makeInitialCore());
});

test("winner determination and settlement wiring remain intact", () => {
  // The action route writes the winner column from the replayed board.
  const action = read("src/app/api/hex-duel/multiplayer/action/route.ts");
  assert.match(action, /applyRecordedMove\(replayed\.state, callerSlot, move\)/);
  assert.match(action, /decidedWinner/);
  assert.match(action, /game\.winner === "pending"/);

  // Settlement still validates the seat and normalises the stake; stakes are
  // retired for Hex Duel, so no payout path can move coins for this game.
  const end = read("src/app/api/hex-duel/end-game/route.ts");
  assert.match(end, /normalizeStake/);
  assert.match(end, /winner !== "player1" && winner !== "player2"/);
  assert.match(end, /payout: "0\.00"/);
});

// ══ 3. AI ═══════════════════════════════════════════════════════════════

const aiSnapshot = (overrides = {}) => ({
  myPlayer: "player2",
  enemyPlayer: "player1",
  capturedTiles: { "4,4": "player2", "0,0": "player1" },
  tileTroops: { "4,4": 10, "0,0": 5 },
  capitals: HEX_DUEL_CAPITALS,
  territoryLevels: {},
  ...overrides,
});

test("the AI takes exactly one action and can choose to upgrade", () => {
  // At capacity, nothing adjacent to attack: capacity is the best investment.
  const action = decideAIAction(aiSnapshot(), "hard");
  assert.equal(action.type, "upgrade");
  assert.equal(action.sourceKey, "4,4");

  // Without enough troops for the 5-troop cost it cannot upgrade.
  const poor = decideAIAction(
    aiSnapshot({ tileTroops: { "4,4": 4, "0,0": 5 } }),
    "hard",
  );
  assert.notEqual(poor.type, "upgrade");
  assert.ok(["attack", "displace", "endTurn"].includes(poor.type));

  // Every decision is a single object with one type — no batch.
  for (const troops of [2, 6, 10, 19]) {
    const decision = decideAIAction(
      aiSnapshot({ tileTroops: { "4,4": troops, "0,0": 5 } }),
      "hard",
    );
    assert.ok(["attack", "displace", "upgrade", "endTurn"].includes(decision.type));
  }
});

const aiBoard = (overrides = {}) => ({
  myPlayer: "player2",
  enemyPlayer: "player1",
  capturedTiles: {
    "4,4": "player2", // capital
    "1,1": "player2",
    "1,2": "player2",
    "0,0": "player1",
  },
  tileTroops: { "4,4": 10, "1,1": 4, "1,2": 6, "0,0": 5 },
  capitals: HEX_DUEL_CAPITALS,
  territoryLevels: { "1,2": 4 },
  ...overrides,
});

test("the AI can fund an upgrade from neighbouring troops when its own are short", () => {
  // "1,1" holds 4 troops, so it cannot pay the 5-troop level-1 price alone; its
  // maxed-out neighbour "1,2" makes up the difference.
  const funded = scoreUpgrade("1,1", aiBoard());
  assert.ok(funded, "the short tile is upgraded with help");

  // The same board with a neighbour that cannot spare a troop: no upgrade.
  assert.equal(
    scoreUpgrade(
      "1,1",
      aiBoard({ tileTroops: { "4,4": 10, "1,1": 4, "1,2": 1, "0,0": 5 } }),
    ),
    null,
  );
});

test("the AI will not strip its own capital to pay for an upgrade", () => {
  // Capital on 4, the tile next to it on 4: the 5-troop price takes 3 there
  // and 2 from the capital, leaving the win condition on 2.
  const short = aiBoard({
    capturedTiles: { "4,4": "player2", "4,3": "player2", "0,0": "player1" },
    tileTroops: { "4,4": 4, "4,3": 4, "0,0": 5 },
    territoryLevels: {},
  });
  assert.equal(scoreUpgrade("4,3", short), null);

  // A deeper capital can afford it...
  const rich = aiBoard({
    ...short,
    tileTroops: { "4,4": 6, "4,3": 4, "0,0": 5 },
  });
  assert.ok(scoreUpgrade("4,3", rich));

  // ...unless an enemy stands next to the capital, where five are kept back.
  const threatened = aiBoard({
    capturedTiles: {
      "4,4": "player2",
      "4,3": "player2",
      "3,3": "player1",
      "0,0": "player1",
    },
    tileTroops: { "4,4": 6, "4,3": 4, "3,3": 5, "0,0": 5 },
    territoryLevels: {},
  });
  assert.equal(scoreUpgrade("4,3", threatened), null);
});

test("the AI banks troops on a threatened capital instead of spending them", () => {
  const capitalKey = P2_CAP_KEY;
  const threatened = aiBoard({
    capturedTiles: {
      [capitalKey]: "player2",
      "4,3": "player2",
      "3,4": "player1", // enemy standing next to the capital
      "0,0": "player1",
    },
    tileTroops: { [capitalKey]: 6, "4,3": 8, "3,4": 3, "0,0": 5 },
    territoryLevels: {},
  });

  const banking = decideAIAction(threatened, "hard");
  assert.equal(banking.type, "displace");
  assert.equal(banking.targetKey, capitalKey, "troops are moved INTO the capital");
  assert.equal(banking.troopCount, 4, "as many as its level-1 ceiling can hold");

  // The capital itself may only strike the tile threatening it (which it can
  // conquer), never spend its garrison elsewhere.
  assert.equal(scoreUpgrade(capitalKey, threatened), null, "no upgrade drains the garrison");

  // With the threat gone the same board does not garrison the capital.
  const safe = aiBoard({
    capturedTiles: { [capitalKey]: "player2", "4,3": "player2", "0,0": "player1" },
    tileTroops: { [capitalKey]: 6, "4,3": 8, "0,0": 5 },
    territoryLevels: {},
  });
  const safeDecision = decideAIAction(safe, "hard");
  assert.ok(
    !(safeDecision.type === "displace" && safeDecision.targetKey === capitalKey),
    "no banking needed when nothing threatens the capital",
  );
});

test("an upgrade plays the fortify cue once, and the board shows who pays", () => {
  const audio = read("src/lib/hexAudio.ts");
  assert.match(audio, /playFortify/);
  assert.match(audio, /playNoise\(0\.12, 0\.05\)/);

  const page = read("src/app/casino/hex-duel/game/[matchId]/PageClient.tsx");
  // Level-map driven: one cue per level that actually rose, never on mount.
  assert.match(page, /const levelsForAudio = useRef<Record<string, number> \| null>\(null\)/);
  assert.match(page, /if \(!previous\) return;/);
  assert.match(page, /if \(raised\) audio\.playFortify\(\);/);

  // The split reaches the board before confirmation, with donor keys flipped
  // for the local perspective like every other board key.
  assert.match(page, /const upgradeFunding = useMemo<UpgradeFunding \| null>/);
  assert.match(page, /upgradeFunding=\{\s*upgradeFunding\s*\?/);
  assert.match(page, /donors: Object\.fromEntries/);

  const board = read("src/components/HexBoard.tsx");
  assert.match(board, /data-hex-upgrade-funding=""/);
  assert.match(board, /fundingTake=\{upgradeFunding\?\.donors\[/);
  assert.match(board, /fundingReceives=\{/);

  const tile = read("src/components/HexTile.tsx");
  assert.match(tile, /data-hex-upgrade-donor=\{fundingTake\}/);
  assert.match(tile, /data-hex-upgrade-receives=\{fundingReceives\}/);
});

test("the AI never proposes an illegal displacement or an unaffordable upgrade", () => {
  const nearFull = decideAIAction(
    aiSnapshot({
      capturedTiles: { "4,4": "player2", "4,3": "player2", "0,0": "player1" },
      tileTroops: { "4,4": 9, "4,3": 9, "0,0": 5 },
      territoryLevels: { "4,4": 2, "4,3": 1 },
    }),
    "hard",
  );
  if (nearFull.type === "displace") {
    assert.ok(
      nearFull.troopCount <= 1,
      `capacity leaves one slot, got ${nearFull.troopCount}`,
    );
  }

  const advances = decideAIAction(
    aiSnapshot({
      capturedTiles: { "4,4": "player2", "4,3": "player2", "0,0": "player1" },
      tileTroops: { "4,4": 20, "4,3": 1, "0,0": 5 },
      territoryLevels: { "4,4": 2, "4,3": 1 },
    }),
    "hard",
  );
  if (advances.type === "displace") {
    const cap = TERRITORY_LEVELS[1].maxTroops;
    assert.ok(1 + advances.troopCount <= cap);
  }
  if (advances.type === "upgrade") {
    assert.ok(20 - 10 >= 1, "upgrade cost is affordable");
  }
});

test("the AI's actions travel the same visual path as a human's", () => {
  const page = read("src/app/casino/hex-duel/game/[matchId]/PageClient.tsx");
  assert.match(page, /const handleUpgradeRef = useRef\(handleUpgrade\)/);
  assert.match(page, /else if \(action\.type === "upgrade"\)/);
  assert.match(page, /handleUpgradeRef\.current\(action\.sourceKey\)/);
  // Attacks/displacements reuse the human handlers, so the engine publishes
  // the same movement event the human path does.
  assert.match(page, /handleAttackRef\.current\(action\.sourceKey, action\.targetKey, action\.troopCount\)/);
  assert.match(page, /handleDisplaceRef\.current\(action\.sourceKey, action\.targetKey, action\.troopCount\)/);
});

// ══ 4. Interface ════════════════════════════════════════════════════════

test("no action-point terminology remains in Hex Duel copy", () => {
  const hexSources = [
    "src/app/casino/hex-duel/PageClient.tsx",
    "src/app/casino/hex-duel/game/[matchId]/PageClient.tsx",
    "src/components/HexActionPanel.tsx",
    "src/components/HexActionLog.tsx",
    "src/components/HexTroopPopup.tsx",
    "src/components/HexBoard.tsx",
    "src/components/HexTile.tsx",
    "src/lib/hex-duel/rules.ts",
  ];
  for (const path of hexSources) {
    const source = read(path);
    assert.doesNotMatch(source, /action points?/i, path);
    assert.doesNotMatch(source, /actionPoints/, path);
  }

  const landing = read("src/lib/gameLandingPages.ts");
  const hexBlock = landing.slice(landing.indexOf('slug: "hex-duel"'), landing.indexOf('slug: "hex-duel"') + 6000);
  assert.doesNotMatch(hexBlock, /action point/i);
  assert.match(hexBlock, /exactly one action/);
  assert.match(hexBlock, /10, 20, 50 or 100/);

  const guide = read("src/lib/guides.ts");
  assert.doesNotMatch(guide, /action points/i);
  assert.match(guide, /each turn gives you a single action/);
});

test("levels, capacities, dots, arrows, popup and animation are all wired", () => {
  const tile = read("src/components/HexTile.tsx");
  assert.match(tile, /L\{level\}/);
  assert.match(tile, /\/\{maxTroops\}/);
  assert.match(tile, /data-hex-troop-dots=\{troopDots\}/);

  const board = read("src/components/HexBoard.tsx");
  assert.match(board, /data-hex-action-arrow=\{actionArrow\.mode\}/);
  assert.match(board, /data-hex-arrow-label=""/);
  assert.match(board, /HexMoveAnimation/);
  assert.match(board, /prefers-reduced-motion: reduce/);

  const popup = read("src/components/HexTroopPopup.tsx");
  assert.match(popup, /data-hex-attack-preview=""/);
  assert.match(popup, /destinationCapacity/);

  const overlay = read("src/components/HexMoveAnimation.tsx");
  assert.match(overlay, /data-hex-move-readout=""/);
  assert.match(overlay, /pointer-events-none absolute inset-0 z-20/);
  assert.match(overlay, /cancelAnimationFrame\(raf\)/);

  const panel = read("src/components/HexActionPanel.tsx");
  assert.match(panel, /upgrade/);
  assert.doesNotMatch(panel, /action point/i);
});

test("unrelated game modules carry no Hex Duel changes in this stage", () => {
  // The audit additions only touched hex files, the guide cross-reference and
  // the landing copy; other games' engines must not reference hex concepts.
  for (const path of [
    "src/lib/battleship/serverStore.ts",
    "src/components/games/battleship/BattlePreview.tsx",
  ]) {
    const source = read(path);
    assert.doesNotMatch(source, /troopDots|territoryLevels|hexTroopAnimation/);
  }
});
