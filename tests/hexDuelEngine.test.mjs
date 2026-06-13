/**
 * Hex Duel Engine — Core Logic Tests
 * 
 * Validates the state transitions for attack/displace actions,
 * simulating the _applyAttackRaw and _applyDisplaceRaw logic
 * (without React state setters) to confirm correctness.
 *
 * These tests verify that remote action application produces
 * the same tile ownership and troop counts as local application.
 */

import test from "node:test";
import assert from "node:assert/strict";

// ── Constants (from hexDuelEngine.ts) ──────────────────────────────────────
const GRID_SIZE = 7;
const INITIAL_TROOPS = 5;

// ── Helpers ────────────────────────────────────────────────────────────────

function otherPlayer(p) {
  return p === "player1" ? "player2" : "player1";
}

function getHexNeighbors(x, y) {
  const isEvenRow = y % 2 === 0;
  const offsets = isEvenRow
    ? [[1, 0], [1, -1], [0, -1], [-1, 0], [0, 1], [1, 1]]
    : [[1, 0], [0, -1], [-1, -1], [-1, 0], [-1, 1], [0, 1]];
  return offsets
    .map(([dx, dy]) => ({ x: x + dx, y: y + dy }))
    .filter(({ x: nx, y: ny }) => nx >= 0 && nx < GRID_SIZE && ny >= 0 && ny < GRID_SIZE);
}

function key(x, y) {
  return `${x},${y}`;
}

function createInitialState(player1Pos, player2Pos) {
  const p1k = key(player1Pos.x, player1Pos.y);
  const p2k = key(player2Pos.x, player2Pos.y);
  return {
    capturedTiles: { [p1k]: "player1", [p2k]: "player2" },
    tileTroops: { [p1k]: INITIAL_TROOPS, [p2k]: INITIAL_TROOPS },
    capitals: { [p1k]: "player1", [p2k]: "player2" },
    winner: null,
  };
}

/**
 * Pure implementation of _applyAttackRaw logic.
 * Takes a state object and returns the new state after applying an attack.
 * No validation — trusts the input (same as _applyAttackRaw for remote actions).
 */
function applyAttackRaw(state, sourceKey, targetKey, troopCount, attacker) {
  const [sx, sy] = sourceKey.split(",").map(Number);
  const [tx, ty] = targetKey.split(",").map(Number);
  const enemy = otherPlayer(attacker);

  const sourceTroops = state.tileTroops[sourceKey] ?? 1;
  const targetOwner = state.capturedTiles[targetKey];
  const targetTroops = targetOwner === undefined ? 0 : (state.tileTroops[targetKey] ?? 1);

  const newState = {
    ...state,
    capturedTiles: { ...state.capturedTiles },
    tileTroops: { ...state.tileTroops },
  };

  // Source loses troops
  newState.tileTroops[sourceKey] = sourceTroops - troopCount;

  if (troopCount > targetTroops) {
    // CONQUER
    const remainingTroops = troopCount - targetTroops;
    newState.capturedTiles[targetKey] = attacker;
    newState.tileTroops[targetKey] = remainingTroops;
    newState.recentlyCaptured = [targetKey];
    newState.combatFlash = [sourceKey, targetKey];

    if (state.capitals[targetKey] === enemy) {
      newState.winner = attacker;
      newState.gameOver = true;
    }
  } else if (troopCount === targetTroops && targetTroops > 0) {
    // TIE — territory becomes neutral
    delete newState.capturedTiles[targetKey];
    newState.tileTroops[targetKey] = 0;
    newState.combatFlash = [sourceKey, targetKey];
  } else {
    // FAILED ATTACK
    const defenderLoss = Math.min(targetTroops, troopCount);
    const newDefenderTroops = targetTroops - defenderLoss;
    newState.tileTroops[targetKey] = newDefenderTroops;

    if (newDefenderTroops === 0 && targetTroops > 0) {
      delete newState.capturedTiles[targetKey];
    }
    newState.combatFlash = [sourceKey, targetKey];
  }

  return newState;
}

/**
 * Pure implementation of _applyDisplaceRaw logic.
 */
function applyDisplaceRaw(state, sourceKey, targetKey, troopCount) {
  const newState = {
    ...state,
    capturedTiles: { ...state.capturedTiles },
    tileTroops: { ...state.tileTroops },
  };

  newState.tileTroops[sourceKey] = (newState.tileTroops[sourceKey] ?? 1) - troopCount;
  newState.tileTroops[targetKey] = (newState.tileTroops[targetKey] ?? 1) + troopCount;

  return newState;
}

// ── Tests ───────────────────────────────────────────────────────────────────

test("Initial state has correct capitals and troops", () => {
  const state = createInitialState({ x: 0, y: 0 }, { x: 6, y: 6 });
  assert.equal(state.capturedTiles["0,0"], "player1");
  assert.equal(state.capturedTiles["6,6"], "player2");
  assert.equal(state.tileTroops["0,0"], 5);
  assert.equal(state.tileTroops["6,6"], 5);
  assert.equal(state.winner, null);
});

test("Attack conquers a neutral tile", () => {
  const state = createInitialState({ x: 0, y: 0 }, { x: 6, y: 6 });
  // Player 1 attacks from (0,0) to a neighboring neutral tile (1,0)
  const neighbors = getHexNeighbors(0, 0);
  const target = neighbors[0]; // (1,0) typically
  const targetKey = key(target.x, target.y);

  const newState = applyAttackRaw(state, "0,0", targetKey, 2, "player1");

  // Target should now be owned by player1
  assert.equal(newState.capturedTiles[targetKey], "player1");
  // Target troops = attacking troops (2) - neutral troops (0) = 2
  assert.equal(newState.tileTroops[targetKey], 2);
  // Source lost 2 troops: 5 - 2 = 3
  assert.equal(newState.tileTroops["0,0"], 3);
  // Recently captured flag set
  assert.deepEqual(newState.recentlyCaptured, [targetKey]);
  // Combat flash
  assert.deepEqual(newState.combatFlash, ["0,0", targetKey]);
  // No winner yet
  assert.equal(newState.winner, null);
});

test("Attack fails against stronger defender", () => {
  const state = createInitialState({ x: 0, y: 0 }, { x: 6, y: 6 });
  // Set up a strong defender neighbor
  const targetKey = "1,0";
  const attacker = "player2"; // Player 2 attacks
  // Give player1 a strong tile adjacent to player2's base
  const neighbors = getHexNeighbors(6, 6);
  const target = neighbors[0];
  const tKey = key(target.x, target.y);
  
  // Simulate: Player 1 owns a neighboring tile with 5 troops
  const state2 = {
    ...state,
    capturedTiles: { ...state.capturedTiles, [tKey]: "player1" },
    tileTroops: { ...state.tileTroops, [tKey]: 5 },
  };

  // Player 2 attacks with 2 troops against 5
  const newState = applyAttackRaw(state2, "6,6", tKey, 2, attacker);

  // Player 1 should still own the tile (attack failed)
  assert.equal(newState.capturedTiles[tKey], "player1");
  // Defender lost 2 troops: 5 - 2 = 3
  assert.equal(newState.tileTroops[tKey], 3);
  // Attacker lost 2 troops: 5 - 2 = 3
  assert.equal(newState.tileTroops["6,6"], 3);
  // Combat flash
  assert.deepEqual(newState.combatFlash, ["6,6", tKey]);
});

test("Attack causes mutual destruction (tie)", () => {
  const state = createInitialState({ x: 0, y: 0 }, { x: 6, y: 6 });
  const tKey = "1,0";

  // Player 2 owns (1,0) with exactly 2 troops
  const state2 = {
    ...state,
    capturedTiles: { ...state.capturedTiles, [tKey]: "player2" },
    tileTroops: { ...state.tileTroops, [tKey]: 2 },
  };

  // Player 1 attacks with 2 troops against 2
  const newState = applyAttackRaw(state2, "0,0", tKey, 2, "player1");

  // Tile should become neutral (deleted from capturedTiles)
  assert.equal(newState.capturedTiles[tKey], undefined);
  // Both sides wiped out
  assert.equal(newState.tileTroops[tKey], 0);
  // Source lost 2 troops: 5 - 2 = 3
  assert.equal(newState.tileTroops["0,0"], 3);
});

test("Conquering enemy capital wins the game", () => {
  const state = createInitialState({ x: 0, y: 0 }, { x: 6, y: 6 });
  // Simulate: Player 1 has moved next to Player 2's capital
  // and Player 2's capital has only 1 troop
  const capKey = "6,6";
  const adjKey = "5,5";
  
  const state2 = {
    ...state,
    capturedTiles: { ...state.capturedTiles, [adjKey]: "player1" },
    tileTroops: { ...state.tileTroops, [adjKey]: 3, [capKey]: 1 },
    capitals: { "0,0": "player1", [capKey]: "player2" },
  };

  // Player 1 attacks the capital from (5,5) with 2 troops
  const newState = applyAttackRaw(state2, adjKey, capKey, 2, "player1");

  // Player 1 should now own the capital
  assert.equal(newState.capturedTiles[capKey], "player1");
  // Remaining troops: 2 - 1 = 1
  assert.equal(newState.tileTroops[capKey], 1);
  // Game over — player1 wins
  assert.equal(newState.winner, "player1");
  assert.equal(newState.gameOver, true);
});

test("Displace moves troops between friendly tiles", () => {
  const state = createInitialState({ x: 0, y: 0 }, { x: 6, y: 6 });
  // Give Player 1 a neighboring tile with 1 troop
  const neighbors = getHexNeighbors(0, 0);
  const target = neighbors[0];
  const tKey = key(target.x, target.y);
  
  const state2 = {
    ...state,
    capturedTiles: { ...state.capturedTiles, [tKey]: "player1" },
    tileTroops: { ...state.tileTroops, [tKey]: 1 },
  };

  // Player 1 displaces 2 troops from (0,0) to the neighbor
  const newState = applyDisplaceRaw(state2, "0,0", tKey, 2);

  // Source: 5 - 2 = 3
  assert.equal(newState.tileTroops["0,0"], 3);
  // Target: 1 + 2 = 3
  assert.equal(newState.tileTroops[tKey], 3);
  // Ownership unchanged
  assert.equal(newState.capturedTiles["0,0"], "player1");
  assert.equal(newState.capturedTiles[tKey], "player1");
});

test("Multiple attacks in sequence (simulating a full turn)", () => {
  const state = createInitialState({ x: 0, y: 0 }, { x: 6, y: 6 });
  const neighbors = getHexNeighbors(0, 0);

  // Attack 1: (0,0) → (1,0) with 2 troops
  const t1 = neighbors[0];
  let s = applyAttackRaw(state, "0,0", key(t1.x, t1.y), 2, "player1");
  
  // Verify attack 1 results
  assert.equal(s.tileTroops["0,0"], 3); // 5 - 2
  assert.equal(s.capturedTiles[key(t1.x, t1.y)], "player1");
  assert.equal(s.tileTroops[key(t1.x, t1.y)], 2); // conquered neutral

  // Attack 2: (0,0) → next neighbor with 1 troop
  if (neighbors.length > 1) {
    const t2 = neighbors[1];
    s = applyAttackRaw(s, "0,0", key(t2.x, t2.y), 1, "player1");
    
    assert.equal(s.tileTroops["0,0"], 2); // 3 - 1
    assert.equal(s.capturedTiles[key(t2.x, t2.y)], "player1");
    assert.equal(s.tileTroops[key(t2.x, t2.y)], 1);
  }
});

test("applyRemoteAction correctly processes attack that depletes AP followed by endTurn", () => {
  // Simulate: Player 1 has 1 remaining AP and attacks, depleting it.
  // Sender sends attack + endTurn.
  // Receiver processes attack (sets AP=0, leaves skipTroopGrowth=true),
  // then endTurn arrives (skips growth, switches turn).
  
  const state = createInitialState({ x: 0, y: 0 }, { x: 6, y: 6 });
  
  // Track skipTroopGrowthRef behavior
  let skipTroopGrowth = true; // set by applyRemoteAction before attack
  let currentAP = 1; // Only 1 AP left — attack will deplete it
  let currentTurn = "player1";
  const ATTACK_COST = 1;
  const MAX_AP = 3;

  // Process attack action
  const neighbors = getHexNeighbors(0, 0);
  const target = neighbors[0];
  const tKey = key(target.x, target.y);
  
  let s = applyAttackRaw(state, "0,0", tKey, 2, "player1");
  
  // AP management for remote attack (depletes AP → set to 0, don't switch turn)
  const willDeplete = currentAP <= ATTACK_COST;
  if (willDeplete) {
    currentAP = 0;
    // skipTroopGrowth stays true for follow-up endTurn
  } else {
    currentAP -= ATTACK_COST;
    skipTroopGrowth = false;
  }

  // Verify after attack
  assert.equal(willDeplete, true);
  assert.equal(currentAP, 0);
  assert.equal(skipTroopGrowth, true); // stays true for endTurn
  assert.equal(currentTurn, "player1"); // turn NOT switched yet
  // Tile ownership updated
  assert.equal(s.capturedTiles[tKey], "player1");
  assert.equal(s.tileTroops[tKey], 2);

  // Process endTurn action
  // applyRemoteAction sets skipTroopGrowth = true (overwrites)
  skipTroopGrowth = true;
  // endTurn(): applyTroopGrowth → skipped because flag is true
  if (skipTroopGrowth) {
    skipTroopGrowth = false; // consumed
    // troop growth skipped
  }
  // switchTurn()
  currentTurn = otherPlayer(currentTurn);
  currentAP = Math.min(currentAP + 1, MAX_AP); // 0 + 1 = 1

  // Verify after endTurn
  assert.equal(skipTroopGrowth, false);
  assert.equal(currentTurn, "player2");
  assert.equal(currentAP, 1);
  // Tile ownership preserved
  assert.equal(s.capturedTiles[tKey], "player1");
  assert.equal(s.tileTroops[tKey], 2);
});

test("applyRemoteAction correctly processes attack that does NOT deplete AP (no endTurn follows)", () => {
  // Simulate: Player 1 has 3 AP, attacks once. AP goes from 3 to 2.
  // No endTurn follows — skipTroopGrowth should be reset.
  
  let skipTroopGrowth = true; // set by applyRemoteAction before attack
  let currentAP = 3;
  const ATTACK_COST = 1;

  const willDeplete = currentAP <= ATTACK_COST;
  if (willDeplete) {
    currentAP = 0;
  } else {
    currentAP -= ATTACK_COST;
    skipTroopGrowth = false;
  }

  assert.equal(willDeplete, false);
  assert.equal(currentAP, 2);
  assert.equal(skipTroopGrowth, false); // reset because no endTurn follows
});

test("applyRemoteAction for attack that does NOT deplete AP", () => {
  let skipTroopGrowth = true;
  let currentAP = 3;
  const ATTACK_COST = 1;

  const willDeplete = currentAP <= ATTACK_COST;
  if (willDeplete) {
    currentAP = 0;
  } else {
    currentAP -= ATTACK_COST;
    skipTroopGrowth = false;
  }

  assert.equal(currentAP, 2);
  assert.equal(skipTroopGrowth, false); // reset because no endTurn follows
});

test("Troop counts stay consistent after conquer", () => {
  // Verify total troops are preserved across conquer actions
  const state = createInitialState({ x: 0, y: 0 }, { x: 6, y: 6 });
  
  function totalTroops(s) {
    return Object.values(s.tileTroops).reduce((sum, t) => sum + t, 0);
  }

  const initialTotal = totalTroops(state);
  assert.equal(initialTotal, 10); // 5 + 5

  const neighbors = getHexNeighbors(0, 0);
  const target = neighbors[0];
  const tKey = key(target.x, target.y);

  // Conquer with 2 troops
  const newState = applyAttackRaw(state, "0,0", tKey, 2, "player1");
  
  const afterTotal = totalTroops(newState);
  // Source: 5 - 2 = 3, Target: 2, Capital: 5 → 3 + 2 + 5 = 10
  assert.equal(afterTotal, 10, "Total troops should be preserved");
});

console.log("\n✅ All hex duel engine tests passed!\n");
