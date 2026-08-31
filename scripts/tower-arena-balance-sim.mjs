/**
 * Tower Arena — balance/duration simulation.
 *
 * Drives the pure turn resolver through complete matches for every supported
 * player count and measures how long each match takes (in 8s placement windows,
 * plus occasional 8s reserve windows), for a range of representative playing
 * strategies. Because the engine is deterministic, these numbers are exact for
 * the given strategy and seed.
 *
 * Run:  node --import tsx scripts/tower-arena-balance-sim.mjs
 */

import { buildResourcePool, centerDepthFor, GRID_WIDTH } from "../src/lib/tower-arena/engine.ts";
import {
  resolvePlacement,
  safeFallbackIntent,
  MAX_RESERVE_USES,
} from "../src/lib/tower-arena/turnResolver.ts";

const TP_MS = 8000; // placement window (server)
const RP_MS = 8000; // reserve window (server)

function makePlayers(ids) {
  return ids.map((id, i) => ({
    userId: id,
    seat: i + 1,
    status: "active",
    isAi: false,
    reserveUsesRemaining: MAX_RESERVE_USES,
  }));
}

function snapshot(maxPlayers, nonce) {
  return {
    id: `m-${nonce}`,
    status: "active",
    phase: "placement",
    maxPlayers,
    resourceCycle: 1,
    turnNumber: 0,
    currentTurnPlayerId: "u0",
    turnDeadline: null,
    resourcePool: buildResourcePool(maxPlayers, `${nonce}:cycle:1`),
    towerState: [],
    reserveState: {},
    placements: [],
  };
}

/** Pick the most stable choice from the current pool for the given shape preference. */
function poolHas(state, shape) {
  return state.resourcePool.some((p) => p.shape === shape);
}

/** Safest play: shortest block available, centered, no rotation. */
function safeIntent(state) {
  for (const shape of ["short", "square", "I", "L", "T"]) {
    if (poolHas(state, shape)) {
      return { shape, positionX: 2, rotation: 0, actionType: "PLACE" };
    }
  }
  return safeFallbackIntent(state);
}

/** Maximize height: prefer the longest block, centered-ish, no rotation. */
function greedyIntent(state) {
  // Long blocks cover more columns → tower grows faster. Conservative anchors.
  for (const shape of ["I", "L", "T", "square", "short"]) {
    if (poolHas(state, shape)) {
      return { shape, positionX: 2, rotation: 0, actionType: "PLACE" };
    }
  }
  throw new Error("pool empty unexpectedly");
}

function apply(state, players, res) {
  const pl = players.map((p) =>
    res.eliminations.some((e) => e.userId === p.userId)
      ? { ...p, status: "eliminated" }
      : p,
  );
  return {
    players: pl,
    state: {
      ...state,
      currentTurnPlayerId: res.nextTurnPlayerId,
      turnDeadline: res.nextDeadlineMs ? new Date(res.nextDeadlineMs).toISOString() : null,
      phase: res.nextPhase || state.phase,
      resourcePool: res.pool,
      towerState: res.towerState,
      reserveState: res.reserveState,
      resourceCycle: res.resourceCycle,
      turnNumber: res.entry.turnNumber,
      placements: [...state.placements, res.entry],
    },
    res,
  };
}

function runMatch(maxPlayers, nonce, strategy) {
  let state = snapshot(maxPlayers, nonce);
  let players = makePlayers(Array.from({ length: maxPlayers }, (_, i) => `u${i}`));
  let placements = 0;
  let reserveWindows = 0;
  let collapses = 0;
  let eliminations = 0;
  const placementsByPlayer = {};
  let maxHeight = 0;

  for (let i = 0; i < 5000; i += 1) {
    const actor = state.currentTurnPlayerId;
    const p = players.find((x) => x.userId === actor);
    if (!p || p.status !== "active") break;

    let intent;
    if (strategy === "safe") intent = safeIntent(state);
    else if (strategy === "greedy") intent = greedyIntent(state);
    else intent = safeFallbackIntent(state);

    const r = resolvePlacement(state, players, intent, actor);
    if (!("resolved" in r)) {
      // Shouldn't happen with the strategy's availability check; guard against
      // float by pushing the safe fallback through.
      const fb = resolvePlacement(state, players, safeFallbackIntent(state), actor);
      if (!("resolved" in fb)) break;
      ({ players, state } = apply(state, players, fb.resolved));
      placements += 1;
      if (fb.resolved.collapsed) collapses += 1;
      eliminations += fb.resolved.eliminations.length;
      for (const b of fb.resolved.towerState) for (const c of b.cells) maxHeight = Math.max(maxHeight, c.z);
      placementsByPlayer[actor] = (placementsByPlayer[actor] || 0) + 1;
      if (fb.resolved.finished) break;
      if (fb.resolved.nextPhase === "reserve") reserveWindows += 1;
      continue;
    }

    ({ players, state } = apply(state, players, r.resolved));
    placements += 1;
    if (r.resolved.collapsed) collapses += 1;
    eliminations += r.resolved.eliminations.length;
    for (const b of r.resolved.towerState) for (const c of b.cells) maxHeight = Math.max(maxHeight, c.z);
    placementsByPlayer[actor] = (placementsByPlayer[actor] || 0) + 1;
    if (r.resolved.finished) break;
    if (r.resolved.nextPhase === "reserve") reserveWindows += 1;
  }

  const minutes = ((placements * TP_MS + reserveWindows * RP_MS) / 60000).toFixed(2);
  return { placements, reserveWindows, collapses, eliminations, maxHeight, minutes, placementsByPlayer };
}

const TARGET = {
  2: "1–2 min",
  3: "1.5–2.5 min",
  4: "2–3 min",
  5: "2.5–3.5 min",
  6: "3–4 min",
};

console.log("=== Tower Arena duration/balance simulation (deterministic) ===\n");
for (const n of [2, 3, 4, 5, 6]) {
  const row = [];
  for (const strat of ["safe", "greedy", "fallback"]) {
    const r = runMatch(n, `${n}-${strat}`, strat);
    row.push(`${strat}: ${r.placements}pl ${r.minutes}min (${r.eliminations} elims, H${r.maxHeight})`);
  }
  console.log(`${n} players  [target ${TARGET[n]}]\n   ${row.join("\n   ")}`);
}