/**
 * Tower Arena — balance/duration simulation.
 *
 * Drives the pure turn resolver through complete matches for every supported
 * player count and measures how long each match takes (in 60s placement
 * windows, plus occasional 60s reserve windows), for a range of representative
 * playing strategies. Because the engine is deterministic, these numbers are
 * exact for the given strategy and seed.
 *
 * Run:  node --import tsx scripts/tower-arena-balance-sim.mjs
 */

import { buildResourcePool } from "../src/lib/tower-arena/engine.ts";
import {
  resolvePlacement,
  safeFallbackIntent,
  MAX_RESERVE_USES,
} from "../src/lib/tower-arena/turnResolver.ts";

const TP_MS = 60000; // placement window (server)
const RP_MS = 60000; // reserve window (server)

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

function heightAt(tower, col) {
  let h = 0;
  for (const b of tower || []) for (const c of b.cells || []) if (c.x === col) h = Math.max(h, c.z);
  return h;
}

/** Safest play: the engine's own stable-drop search (smallest shape that balances). */
function safeIntent(state) {
  return safeFallbackIntent(state);
}

/** Risk-happy: build a 1-cell pillar, then force 3-wide beams onto it
 * (the beam tips off the skinny pillar into the void). */
function driveIntent(state) {
  return heightAt(state.towerState, 0) >= 1
    ? { shape: "I", positionX: 0, rotation: 0, actionType: "PLACE" }
    : { shape: "short", positionX: 0, rotation: 0, actionType: "PLACE" };
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

function runMatch(maxPlayers, nonce, strategy, maxTurns = 5000) {
  let state = snapshot(maxPlayers, nonce);
  let players = makePlayers(Array.from({ length: maxPlayers }, (_, i) => `u${i}`));
  let placements = 0;
  let reserveWindows = 0;
  let collapses = 0;
  let eliminations = 0;
  const placementsByPlayer = {};
  let maxHeight = 0;

  for (let i = 0; i < maxTurns; i += 1) {
    const actor = state.currentTurnPlayerId;
    const p = players.find((x) => x.userId === actor);
    if (!p || p.status !== "active") break;

    let intent;
    if (strategy === "safe") intent = safeIntent(state);
    else intent = driveIntent(state);

    let r = resolvePlacement(state, players, intent, actor);
    if (!("resolved" in r)) {
      const fb = resolvePlacement(state, players, safeFallbackIntent(state), actor);
      if (!("resolved" in fb)) break;
      r = fb;
    }
    const res = r.resolved;

    ({ players, state } = apply(state, players, res));
    placements += 1;
    if (res.collapsed) collapses += 1;
    eliminations += res.eliminations.length;
    for (const b of res.towerState) for (const c of b.cells) maxHeight = Math.max(maxHeight, c.z);
    placementsByPlayer[actor] = (placementsByPlayer[actor] || 0) + 1;
    if (res.finished) break;
    if (res.nextPhase === "reserve") reserveWindows += 1;
  }

  const minutes = ((placements * TP_MS + reserveWindows * RP_MS) / 60000).toFixed(2);
  return { placements, reserveWindows, collapses, eliminations, maxHeight, minutes, placementsByPlayer };
}

console.log("=== Tower Arena duration/balance simulation (deterministic) ===");
console.log("No height ceiling: safe play sustains forever; risky drops end matches.\n");
for (const n of [2, 3, 4, 5, 6]) {
  const row = [];
  for (const strat of ["safe", "drive"]) {
    // Safe play never finishes (no ceiling) — cap its turns so the tail-tower
    // sweep stays fast; drive play ends on its own within the full budget.
    const r = runMatch(n, `${n}-${strat}`, strat, strat === "safe" ? 150 : 5000);
    row.push(`${strat}: ${r.placements}pl ${r.minutes}min (${r.eliminations} elims, ${r.collapses} void-falls, H${r.maxHeight})`);
  }
  console.log(`${n} players`);
  console.log(`   ${row.join("\n   ")}`);
  console.log("");
}