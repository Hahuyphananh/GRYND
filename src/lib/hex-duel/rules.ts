// src/lib/hex-duel/rules.ts
//
// THE Hex Duel rulebook, in a form the SERVER can run.
//
// WHY THIS FILE EXISTS: a staked match must never settle on a client's word
// (src/lib/games/stakes.js + src/lib/tokens/pvpPot.ts). Hex Duel's board used
// to live only inside the React hook (`src/lib/hexDuelEngine.ts`, which carries
// a "use client" directive and React imports), so "who won" was whatever the
// finishing client said. The pure parts of that engine are therefore moved here
// — verbatim, same arithmetic, same order of operations — and the engine now
// imports them. The API route replays the SAME functions over the action rows it
// accepted, so the winner it settles on is the winner this rulebook computes,
// not one a request body named.
//
// WHAT LIVES HERE: the initial position, the attack resolution, troop growth,
// turn switching and the pure reducer. React state, animation fields, logs and
// everything presentation-shaped stay in the engine hook.
//
// WHAT MUST NOT LIVE HERE: no "use client", no React, no DOM, no db — a route
// handler imports this module directly.
//
// THE ONE INVARIANT: `hexDuelReducer` must be byte-for-byte the reducer the
// client runs. `src/lib/hexDuelEngine.ts` calls it for every local and remote
// action, and `src/lib/hex-duel/authority.ts` calls it once per recorded action
// when it replays a match, so a rule change is a single edit that both sides
// pick up. `tests/hex-duel-rules.test.mjs` pins the client engine to this file.

import { GRID_SIZE, getHexNeighbors } from "../hexGridUtils";

// ── Types ──────────────────────────────────────────────────────────────────

export type DuelPlayer = "player1" | "player2";

/** A territory's permanent level. 1 is the base, 4 the maximum. */
export type TerritoryLevel = 1 | 2 | 3 | 4;

/** Core game state managed by the reducer. */
export interface CoreState {
  /** ownership per tile key */
  capturedTiles: Record<string, DuelPlayer>;
  /** troop count per tile key */
  tileTroops: Record<string, number>;
  /**
   * Permanent level per OWNED tile key. A key with no entry is level 1, which
   * is also what a neutral tile is treated as — levels are only meaningful for
   * a territory somebody holds.
   */
  territoryLevels: Record<string, TerritoryLevel>;
  /** whose turn it is */
  currentTurn: DuelPlayer;
  /** winner, or null if ongoing */
  winner: DuelPlayer | null;
  /** click+capture flash effect: tile just conquered */
  recentlyCaptured: string[];
  /** combat flash effect: tiles involved in last combat */
  combatFlash: string[];
  /** per-player move counts (for stats endpoints) */
  p1MoveCount: number;
  p2MoveCount: number;
  /** total moves count */
  moveCount: number;
}

/** Computes the conquer/tie/fail outcome of an attack from current state. */
export type AttackOutcome =
  | { kind: "conquer"; remainingTroops: number; conqueredCapital: boolean }
  | { kind: "tie"; tileTroops: 0 }
  | { kind: "failed"; newDefenderTroops: number; defenderWipedOut: boolean };

/** Every action the reducer understands. */
export type ReducerAction =
  | {
      type: "attack";
      sourceKey: string;
      targetKey: string;
      troopCount: number;
      player: DuelPlayer;
    }
  | {
      type: "displace";
      sourceKey: string;
      targetKey: string;
      troopCount: number;
      player: DuelPlayer;
    }
  | {
      type: "upgrade";
      sourceKey: string;
      player: DuelPlayer;
    }
  | {
      type: "endTurn";
      player: DuelPlayer;
      /** When true, skip troop growth (the caller already applied it). */
      skipTroopGrowth: boolean;
    }
  | { type: "troopGrowth"; player: DuelPlayer }
  | { type: "reset" }
  | { type: "syncSnapshot"; snapshot: CoreState };

/** The move types a player can send over the wire. */
export type HexDuelMoveType =
  | "attack"
  | "displace"
  | "upgrade"
  | "endTurn"
  | "skipRound";

/** One move as it travels (and as it is stored in `hex_duel_actions`). */
export interface HexDuelMoveInput {
  type: HexDuelMoveType;
  sourceKey?: string | null;
  targetKey?: string | null;
  troopCount?: number | null;
}

/** A legal move, or why it was refused. */
export type HexDuelMoveCheck =
  | { ok: true }
  | { ok: false; code: string; error: string };

// ── Constants ──────────────────────────────────────────────────────────────

// ONE ACTION PER TURN.
//
// There is deliberately NO action-point pool: no cost, no regeneration and no
// "spend until empty" loop. A seat acts once (attack, displace, upgrade or skip)
// and the turn passes with that action — which is also why a move from the seat
// that is NOT to act is a no-op rather than a second action.

// ── Territory levels ──────────────────────────────────────────────────────
//
// Every territory has a permanent level from 1 to 4. The level decides the
// tile's troop CEILING and what it costs (in troops, paid from the tile itself)
// to reach the next level. `upgradeCost: null` marks the maximum level.
//
// Levels are permanent while ownership is unchanged, and any ownership change
// resets the tile to level 1 (a conquest takes the territory at level 1).

export const MAX_TERRITORY_LEVEL: TerritoryLevel = 4;
export const INITIAL_TERRITORY_LEVEL: TerritoryLevel = 1;

export const TERRITORY_LEVELS: Record<
  TerritoryLevel,
  { maxTroops: number; upgradeCost: number | null }
> = {
  1: { maxTroops: 10, upgradeCost: 5 },
  2: { maxTroops: 20, upgradeCost: 10 },
  3: { maxTroops: 50, upgradeCost: 25 },
  4: { maxTroops: 100, upgradeCost: null },
};

/** Clamp anything from the wire or an old snapshot onto a real level. */
export function normalizeTerritoryLevel(value: unknown): TerritoryLevel {
  const n = Number(value);
  if (n === 2 || n === 3 || n === 4) return n;
  return INITIAL_TERRITORY_LEVEL;
}

/** The level of a territory (a tile nobody upgraded is level 1). */
export function territoryLevelOf(
  state: { territoryLevels?: Record<string, TerritoryLevel> },
  key: string,
): TerritoryLevel {
  return normalizeTerritoryLevel(state.territoryLevels?.[key]);
}

/** Troop ceiling for a level. */
export function territoryMaxTroops(level: TerritoryLevel): number {
  return TERRITORY_LEVELS[normalizeTerritoryLevel(level)].maxTroops;
}

/** Troops paid to reach the next level, or null at the maximum level. */
export function upgradeCostFor(level: TerritoryLevel): number | null {
  return TERRITORY_LEVELS[normalizeTerritoryLevel(level)].upgradeCost;
}

/**
 * What upgrading `sourceKey` would cost and produce, and whether it is legal
 * for `seat`. The rulebook, the server validator, the engine and the panel all
 * read this one function, so the preview a player sees is the rule that runs.
 */
export interface UpgradeInfo {
  ok: boolean;
  code?: string;
  error?: string;
  /** Current level. */
  level: TerritoryLevel;
  /** Level after a successful upgrade, or null at the maximum. */
  nextLevel: TerritoryLevel | null;
  /** Troops paid from this territory, or null at the maximum. */
  cost: number | null;
  /** Troop count before the upgrade. */
  troops: number;
  /** Troop ceiling of the CURRENT level. */
  maxTroops: number;
  /** Troop ceiling after the upgrade (unchanged at the maximum). */
  nextMaxTroops: number;
  /** Troops remaining after paying the cost (never below 1 when legal). */
  remainingTroops: number;
}

/** The slice of the board an upgrade decision needs. */
export interface TerritoryBoardView {
  capturedTiles: Record<string, DuelPlayer>;
  tileTroops: Record<string, number>;
  territoryLevels?: Record<string, TerritoryLevel>;
}

export function getUpgradeInfo(
  state: TerritoryBoardView,
  seat: DuelPlayer,
  sourceKey: string,
): UpgradeInfo {
  const level = territoryLevelOf(state, sourceKey);
  const cost = upgradeCostFor(level);
  const troops = state.tileTroops[sourceKey] ?? 1;
  const nextLevel =
    cost === null ? null : ((level + 1) as TerritoryLevel);
  const nextMaxTroops = nextLevel === null ? territoryMaxTroops(level) : territoryMaxTroops(nextLevel);

  const base = {
    level,
    nextLevel,
    cost,
    troops,
    maxTroops: territoryMaxTroops(level),
    nextMaxTroops,
    remainingTroops: cost === null ? troops : troops - cost,
  };

  if (state.capturedTiles[sourceKey] !== seat) {
    return {
      ...base,
      ok: false,
      code: "NOT_YOUR_TILE",
      error: "You can only upgrade your own territories",
    };
  }
  if (cost === null) {
    return {
      ...base,
      ok: false,
      code: "MAX_LEVEL",
      error: "This territory is already at the maximum level",
    };
  }
  if (troops - cost < 1) {
    return {
      ...base,
      ok: false,
      code: "NOT_ENOUGH_TROOPS",
      error: `Upgrading costs ${cost} troops and must leave at least 1 behind`,
    };
  }
  return { ...base, ok: true };
}

// ── Initial positions ─────────────────────────────────────────────────────

const INITIAL_P1 = { x: 0, y: 0 };
const INITIAL_P2 = { x: GRID_SIZE - 1, y: GRID_SIZE - 1 };

export const P1_CAP_KEY = `${INITIAL_P1.x},${INITIAL_P1.y}`;
export const P2_CAP_KEY = `${INITIAL_P2.x},${INITIAL_P2.y}`;

export const INITIAL_TROOPS = 5;

/**
 * Capitals: fixed for the whole game. Exported because the server needs the
 * same map to tell a capital capture from any other conquest.
 */
export const HEX_DUEL_CAPITALS: Record<string, DuelPlayer> = Object.freeze({
  [P1_CAP_KEY]: "player1",
  [P2_CAP_KEY]: "player2",
});

// ── Helpers ────────────────────────────────────────────────────────────────

/** Check if two tiles are adjacent (including diagonals) */
export function areAdjacent(keyA: string, keyB: string): boolean {
  const [ax, ay] = keyA.split(",").map(Number);
  const [bx, by] = keyB.split(",").map(Number);
  return getHexNeighbors(ax, ay).some((n) => n.x === bx && n.y === by);
}

/** Get the other player */
export function otherPlayer(p: DuelPlayer): DuelPlayer {
  return p === "player1" ? "player2" : "player1";
}

/** The starting position: both capitals held, 5 troops each, player1 to move. */
export function makeInitialCore(startingTurn: DuelPlayer = "player1"): CoreState {
  return {
    capturedTiles: {
      [P1_CAP_KEY]: "player1",
      [P2_CAP_KEY]: "player2",
    },
    tileTroops: {
      [P1_CAP_KEY]: INITIAL_TROOPS,
      [P2_CAP_KEY]: INITIAL_TROOPS,
    },
    // Starting capitals also start at level 1.
    territoryLevels: {
      [P1_CAP_KEY]: INITIAL_TERRITORY_LEVEL,
      [P2_CAP_KEY]: INITIAL_TERRITORY_LEVEL,
    },
    currentTurn: startingTurn,
    winner: null,
    recentlyCaptured: [],
    combatFlash: [],
    p1MoveCount: 0,
    p2MoveCount: 0,
    moveCount: 0,
  };
}

// ── Reducer-based game state ───────────────────────────────────────────────
//
// Critical fix for multiplayer desync (Audit C1): all reads of game-state
// happen INSIDE the reducer via the `state` argument, which is GUARANTEED
// to be the latest committed state when each dispatch runs. Multiple rapid
// socket/poll dispatches are processed serially by React — each reducer
// call sees the previous dispatch's resulting state, so chained actions
// compute over fresh data, not stale closures. The same property is what lets
// the server replay a recorded match one action at a time.

export function resolveAttackOutcome(
  state: TerritoryBoardView,
  sourceKey: string,
  targetKey: string,
  troopCount: number,
  attacker: DuelPlayer,
  capitals: Record<string, DuelPlayer>,
): AttackOutcome {
  const enemy = otherPlayer(attacker);
  const targetOwner = state.capturedTiles[targetKey];
  const targetTroops =
    targetOwner === undefined ? 0 : state.tileTroops[targetKey] ?? 1;

  if (troopCount > targetTroops) {
    const remainingTroops = troopCount - targetTroops;
    const conqueredCapital = capitals[targetKey] === enemy;
    return { kind: "conquer", remainingTroops, conqueredCapital };
  }
  if (troopCount === targetTroops && targetTroops > 0) {
    return { kind: "tie", tileTroops: 0 };
  }
  const defenderLoss = Math.min(targetTroops, troopCount);
  const newDefenderTroops = targetTroops - defenderLoss;
  const defenderWipedOut = newDefenderTroops === 0 && targetTroops > 0;
  return { kind: "failed", newDefenderTroops, defenderWipedOut };
}

/**
 * Apply troop growth: +1 troop per owned tile for `player`, never past the
 * tile's level capacity. A tile already at its ceiling simply does not grow.
 */
function growTroops(state: CoreState, player: DuelPlayer): CoreState {
  const tiles = state.tileTroops;
  const next: Record<string, number> = { ...tiles };
  for (const [key, owner] of Object.entries(state.capturedTiles)) {
    if (owner === player) {
      const capacity = territoryMaxTroops(territoryLevelOf(state, key));
      next[key] = Math.min((next[key] ?? 1) + 1, capacity);
    }
  }
  return { ...state, tileTroops: next };
}

/** Drop a tile's level entry (it became neutral). */
function withoutLevel(
  levels: Record<string, TerritoryLevel>,
  key: string,
): Record<string, TerritoryLevel> {
  if (levels[key] === undefined) return levels;
  const next = { ...levels };
  delete next[key];
  return next;
}

/**
 * Pass the turn to the other seat. Resets the flash effects.
 *
 * The ONLY turn transition in the rulebook: every successful action (attack,
 * displace) and the skip action ends here, after the acting seat's passive
 * growth has been applied once. No action-point bookkeeping happens here.
 */
function switchTurnCore(state: CoreState): CoreState {
  return {
    ...state,
    currentTurn: otherPlayer(state.currentTurn),
    recentlyCaptured: [],
    combatFlash: [],
  };
}

/**
 * The reducer. `capitals` is a parameter (not a module read) so a caller can
 * never accidentally run a match against a different board.
 */
export function coreReducer(
  state: CoreState,
  action: ReducerAction,
  capitals: Record<string, DuelPlayer>,
): CoreState {
  switch (action.type) {
    case "attack": {
      // Idempotency: don't apply further actions after winner is set.
      if (state.winner) return state;

      const { sourceKey, targetKey, troopCount, player } = action;
      // ONE ACTION PER TURN. A move arriving from the seat that is not to act
      // has already been applied — a duplicate socket/poll delivery, an
      // out-of-order snapshot replay, or a second click before React
      // re-rendered — so it is ignored instead of applied, and it can never
      // flip the turn a second time.
      if (state.currentTurn !== player) return state;
      const sourceTroops = state.tileTroops[sourceKey] ?? 1;
      const outcome = resolveAttackOutcome(
        state,
        sourceKey,
        targetKey,
        troopCount,
        player,
        capitals,
      );

      // 1. Source always loses `troopCount` troops.
      let tileTroops: Record<string, number> = {
        ...state.tileTroops,
        [sourceKey]: sourceTroops - troopCount,
      };
      let capturedTiles = state.capturedTiles;
      let territoryLevels = state.territoryLevels;
      let recentlyCaptured = state.recentlyCaptured;
      let combatFlash: string[];

      // 2. Outcome branches — all reads are from current `state` argument.
      if (outcome.kind === "conquer") {
        capturedTiles = { ...state.capturedTiles, [targetKey]: player };
        // A newly conquered territory starts at level 1, so its ceiling is the
        // level-1 capacity. `checkHexDuelMove` refuses an attack that would
        // overflow it, so this clamp only ever guards a state that predates
        // validation — it is the invariant, not the normal path.
        tileTroops = {
          ...tileTroops,
          [targetKey]: Math.min(
            outcome.remainingTroops,
            territoryMaxTroops(INITIAL_TERRITORY_LEVEL),
          ),
        };
        territoryLevels = {
          ...state.territoryLevels,
          [targetKey]: INITIAL_TERRITORY_LEVEL,
        };
        recentlyCaptured = [targetKey];
        combatFlash = [sourceKey, targetKey];
      } else if (outcome.kind === "tie") {
        const next: Record<string, DuelPlayer> = { ...state.capturedTiles };
        delete next[targetKey];
        capturedTiles = next;
        territoryLevels = withoutLevel(state.territoryLevels, targetKey);
        tileTroops = { ...tileTroops, [targetKey]: outcome.tileTroops };
        combatFlash = [sourceKey, targetKey];
      } else {
        tileTroops = { ...tileTroops, [targetKey]: outcome.newDefenderTroops };
        if (outcome.defenderWipedOut) {
          const next: Record<string, DuelPlayer> = { ...state.capturedTiles };
          delete next[targetKey];
          capturedTiles = next;
          // Neutral again — no territory to carry a level.
          territoryLevels = withoutLevel(state.territoryLevels, targetKey);
        }
        combatFlash = [sourceKey, targetKey];
      }

      // 3. Bookkeeping — move counts are stats only.
      let { winner, p1MoveCount, p2MoveCount, moveCount } = state;
      p1MoveCount += player === "player1" ? 1 : 0;
      p2MoveCount += player === "player2" ? 1 : 0;
      moveCount += 1;

      const moved: CoreState = {
        ...state,
        capturedTiles,
        tileTroops,
        territoryLevels,
        recentlyCaptured,
        combatFlash,
        winner,
        p1MoveCount,
        p2MoveCount,
        moveCount,
      };

      if (outcome.kind === "conquer" && outcome.conqueredCapital) {
        // Capturing the enemy capital ends the match immediately: no growth,
        // no turn switch, nothing else to apply.
        return { ...moved, winner: player };
      }

      // ONE ACTION PER TURN: the acting seat's passive growth lands on the
      // transition, exactly once, and the turn passes with the action.
      return switchTurnCore(growTroops(moved, player));
    }

    case "displace": {
      if (state.winner) return state;

      const { sourceKey, targetKey, troopCount, player } = action;
      // Same one-action guard as `attack` (duplicate / out-of-order delivery).
      if (state.currentTurn !== player) return state;
      const sourceTroops = state.tileTroops[sourceKey] ?? 1;
      const destTroops = state.tileTroops[targetKey] ?? 1;
      // Capacity: a displacement may never push the destination past its
      // level's ceiling. Refused outright (not clamped) so no troop is ever
      // silently created or deleted; the validator reports the same rule.
      if (destTroops + troopCount > territoryMaxTroops(territoryLevelOf(state, targetKey))) {
        return state;
      }
      // Apply troop moves.
      const tileTroops: Record<string, number> = {
        ...state.tileTroops,
        [sourceKey]: sourceTroops - troopCount,
        [targetKey]: destTroops + troopCount,
      };

      let { p1MoveCount, p2MoveCount, moveCount } = state;
      p1MoveCount += player === "player1" ? 1 : 0;
      p2MoveCount += player === "player2" ? 1 : 0;
      moveCount += 1;

      const moved: CoreState = {
        ...state,
        tileTroops,
        p1MoveCount,
        p2MoveCount,
        moveCount,
        combatFlash: [sourceKey, targetKey],
      };

      // One action per turn — displace included: growth once, then the turn.
      return switchTurnCore(growTroops(moved, player));
    }

    case "upgrade": {
      if (state.winner) return state;
      const { sourceKey, player } = action;
      // One action per turn: an upgrade is an action like any other.
      if (state.currentTurn !== player) return state;
      const info = getUpgradeInfo(state, player, sourceKey);
      if (!info.ok || info.nextLevel === null || info.cost === null) return state;

      let { p1MoveCount, p2MoveCount, moveCount } = state;
      p1MoveCount += player === "player1" ? 1 : 0;
      p2MoveCount += player === "player2" ? 1 : 0;
      moveCount += 1;

      const upgraded: CoreState = {
        ...state,
        // Level up, pay the cost from this territory's own troops, keep at
        // least one troop (guaranteed by `getUpgradeInfo`).
        territoryLevels: { ...state.territoryLevels, [sourceKey]: info.nextLevel },
        tileTroops: { ...state.tileTroops, [sourceKey]: info.troops - info.cost },
        p1MoveCount,
        p2MoveCount,
        moveCount,
        combatFlash: [sourceKey],
      };

      // Same transition as every other action: one growth tick, then the turn.
      return switchTurnCore(growTroops(upgraded, player));
    }

    case "troopGrowth": {
      if (state.winner) return state;
      return growTroops(state, action.player);
    }

    case "endTurn": {
      if (state.winner) return state;
      // The SKIP action (and a legacy endTurn row). A seat that is not to act
      // cannot skip the other player's turn, and an obsolete echo of a turn a
      // successful action already ended is a no-op.
      if (state.currentTurn !== action.player) return state;
      // When skipTroopGrowth=true, this is a remote explicit endTurn.
      // The sender already applied troop growth + switched turns locally,
      // so we just need to mirror the side-effects — but with our own
      // current state. (Idempotent — safe even if already reflected.)
      //
      // When skipTroopGrowth=false, this is a local endTurn() and we must
      // apply troop growth first before switching turns.
      const grown = action.skipTroopGrowth
        ? state
        : growTroops(state, action.player);
      return switchTurnCore(grown);
    }

    case "reset": {
      return makeInitialCore();
    }

    case "syncSnapshot": {
      // Snapshots are explicit overrides — do not validate here. The
      // snapshotted state is treated as authoritative. `territoryLevels` is
      // normalized because a snapshot from an older build (or a hostile one)
      // may carry nothing usable: every tile then reads as level 1.
      const levels: Record<string, TerritoryLevel> = {};
      for (const [key, value] of Object.entries(action.snapshot.territoryLevels ?? {})) {
        levels[key] = normalizeTerritoryLevel(value);
      }
      return {
        ...action.snapshot,
        territoryLevels: levels,
        recentlyCaptured: [],
        combatFlash: [],
      };
    }
  }
}

// ── Move legality ──────────────────────────────────────────────────────────
//
// THE move validator — the local handlers in src/lib/hexDuelEngine.ts and the
// server's action route both call it, so a move the board refuses is a move the
// server records nothing for (and vice versa). It encodes exactly what the
// client already enforced while allowing a move:
//
//   * attack   — own tile → adjacent tile you do not own (neutral or enemy),
//                sending more than 0 troops and leaving at least 1 behind.
//   * displace — own tile → adjacent own tile, same troop rules (the source
//                keeps at least 1 troop), and the destination may not exceed
//                its level capacity.
//   * upgrade  — own tile below level 4 with enough troops to pay the cost
//                and still keep at least one.
//   * endTurn / skipRound — always legal for the player to move.
//
// `seat` is the player the move is being checked FOR: the client passes
// `state.currentTurn`, the server passes the authenticated caller's seat. A move
// by a seat that is not to act is refused with `NOT_YOUR_TURN`.

export function checkHexDuelMove(
  state: CoreState,
  seat: DuelPlayer,
  move: HexDuelMoveInput,
): HexDuelMoveCheck {
  if (state.winner) {
    return { ok: false, code: "GAME_OVER", error: "This match is already over" };
  }
  if (state.currentTurn !== seat) {
    return {
      ok: false,
      code: "NOT_YOUR_TURN",
      error: `Not your turn (current turn: ${state.currentTurn})`,
    };
  }

  // Skipping needs no payload: it is always legal for the seat that is to act.
  if (move.type === "endTurn" || move.type === "skipRound") return { ok: true };

  // Upgrades carry only a source tile: the level and the cost are read from
  // the SERVER's board, never from the request, so a client cannot name the
  // level it wants or the troops it would pay.
  if (move.type === "upgrade") {
    const upgradeKey = typeof move.sourceKey === "string" ? move.sourceKey : null;
    if (!upgradeKey) {
      return { ok: false, code: "BAD_TARGET", error: "Missing source" };
    }
    if (!isTileKey(upgradeKey)) {
      return { ok: false, code: "BAD_TARGET", error: "Tile is off the board" };
    }
    const info = getUpgradeInfo(state, seat, upgradeKey);
    if (!info.ok) {
      return { ok: false, code: info.code ?? "UPGRADE_REFUSED", error: info.error ?? "Upgrade refused" };
    }
    return { ok: true };
  }

  const sourceKey = typeof move.sourceKey === "string" ? move.sourceKey : null;
  const targetKey = typeof move.targetKey === "string" ? move.targetKey : null;
  const troopCount =
    typeof move.troopCount === "number" && Number.isFinite(move.troopCount)
      ? move.troopCount
      : null;

  if (!sourceKey || !targetKey) {
    return { ok: false, code: "BAD_TARGET", error: "Missing source or target" };
  }
  if (!isTileKey(sourceKey) || !isTileKey(targetKey)) {
    return { ok: false, code: "BAD_TARGET", error: "Tile is off the board" };
  }
  if (troopCount === null || !Number.isInteger(troopCount) || troopCount <= 0) {
    return {
      ok: false,
      code: "BAD_TROOPS",
      error: "Troop count must be a whole number of at least 1",
    };
  }

  const sourceOwner = state.capturedTiles[sourceKey];
  const targetOwner = state.capturedTiles[targetKey];
  if (sourceOwner !== seat) {
    return { ok: false, code: "NOT_YOUR_TILE", error: "Source tile is not yours" };
  }
  if (move.type === "displace" && targetOwner !== seat) {
    return {
      ok: false,
      code: "NOT_YOUR_TILE",
      error: "You can only displace troops onto your own tiles",
    };
  }
  if (move.type === "attack" && targetOwner === seat) {
    return { ok: false, code: "OWN_TILE", error: "You already hold that tile" };
  }
  if (sourceKey === targetKey || !areAdjacent(sourceKey, targetKey)) {
    return { ok: false, code: "NOT_ADJACENT", error: "Tiles are not adjacent" };
  }

  // The source keeps at least one troop — the same bound the engine's own
  // attack/displace handlers enforce (and the picker's `troops - 1` offers).
  const sourceTroops = state.tileTroops[sourceKey] ?? 1;
  if (sourceTroops < troopCount + 1) {
    return {
      ok: false,
      code: "TOO_MANY_TROOPS",
      error: "You must leave at least one troop behind",
    };
  }

  if (move.type === "displace") {
    // The destination cannot take more than its level's ceiling.
    const destTroops = state.tileTroops[targetKey] ?? 1;
    const destCapacity = territoryMaxTroops(territoryLevelOf(state, targetKey));
    if (destTroops + troopCount > destCapacity) {
      return {
        ok: false,
        code: "CAPACITY",
        error: `That territory holds at most ${destCapacity} troops`,
      };
    }
  }

  if (move.type === "attack") {
    // A conquest takes the territory at level 1, so the survivors cannot exceed
    // the level-1 ceiling. Refusing an over-large send is how the rulebook keeps
    // "never silently delete excess troops" true: the player is told, and the
    // reducer's clamp only backstops a state that predates this check.
    const targetTroops = targetOwner === undefined ? 0 : state.tileTroops[targetKey] ?? 1;
    const survivors = troopCount - targetTroops;
    const conquestCapacity = territoryMaxTroops(INITIAL_TERRITORY_LEVEL);
    if (survivors > conquestCapacity) {
      return {
        ok: false,
        code: "CAPACITY",
        error: `Only ${conquestCapacity} troops can hold a newly conquered territory (${survivors} would survive)`,
      };
    }
  }

  return { ok: true };
}

/** Is `key` a tile on the board ("x,y" inside the grid)? */
export function isTileKey(key: string): boolean {
  const parts = String(key).split(",");
  if (parts.length !== 2) return false;
  const x = Number(parts[0]);
  const y = Number(parts[1]);
  return (
    Number.isInteger(x) &&
    Number.isInteger(y) &&
    x >= 0 &&
    x < GRID_SIZE &&
    y >= 0 &&
    y < GRID_SIZE
  );
}

/**
 * Apply a RECORDED move to a state — the receiver's semantics, which the server
 * uses to replay a match it stored, and which the engine's remote path mirrors.
 *
 * Both seats go through the SAME reducer, so replay, live play and the AI can
 * never diverge: every successful action (including an upgrade, whose level
 * and cost are recomputed from this state) applies its passive growth once and
 * passes the turn once. The reducer's own turn guard is what makes an
 * out-of-order or duplicate delivery (socket + poll + snapshot in any order) a
 * no-op, and what makes an obsolete `endTurn` echo from a turn a successful
 * action already ended a no-op too — no double growth, no double flip.
 *
 * Returns the state unchanged for a move it cannot apply (missing fields, or a
 * move whose seat is not to act), so a replay can never throw on a malformed
 * row.
 */
export function applyRecordedMove(
  state: CoreState,
  seat: DuelPlayer,
  move: HexDuelMoveInput,
  capitals: Record<string, DuelPlayer> = HEX_DUEL_CAPITALS,
): CoreState {
  if (state.winner) return state;

  switch (move.type) {
    case "attack":
    case "displace": {
      const { sourceKey, targetKey } = move;
      const troopCount =
        typeof move.troopCount === "number" && Number.isFinite(move.troopCount)
          ? move.troopCount
          : null;
      if (!sourceKey || !targetKey || !troopCount || troopCount <= 0) return state;
      return coreReducer(
        state,
        { type: move.type, sourceKey, targetKey, troopCount, player: seat },
        capitals,
      );
    }
    case "upgrade": {
      // The recorded row carries the tile only; the level and cost are always
      // recomputed from the state this replay built.
      if (!move.sourceKey) return state;
      return coreReducer(
        state,
        { type: "upgrade", sourceKey: move.sourceKey, player: seat },
        capitals,
      );
    }
    case "endTurn":
    case "skipRound": {
      // The dedicated skip-turn action (both types are accepted so rows written
      // before the action-point removal still replay). Growth + the single flip
      // happen in the reducer; a row from the seat that is not to act —
      // including an obsolete echo — is a no-op.
      return coreReducer(
        state,
        { type: "endTurn", player: seat, skipTroopGrowth: false },
        capitals,
      );
    }
    default:
      return state;
  }
}

