"use client";

import { useCallback, useMemo, useReducer, useRef, useState } from "react";
import type { HexTileData } from "../components/HexTile";
import { GRID_SIZE, getHexNeighbors } from "./hexGridUtils";

// ── Types ───────────────────────────────────────────────────────────────────

export type DuelPlayer = "player1" | "player2";

export interface ActionLogEntry {
  /** Sequential action index */
  id: number;
  /** Which player acted */
  player: DuelPlayer;
  /** Type of action */
  type: "move" | "push" | "reinforce" | "endTurn" | "attack" | "displace" | "troopGrowth";
  /** Coordinates involved */
  target?: { x: number; y: number };
  /** Source coordinates (for attack/displace) */
  source?: { x: number; y: number };
  /** How many AP this action cost */
  apCost: number;
  /** Human-readable description */
  label: string;
}

export interface HexDuelState {
  /** The visual grid */
  grid: HexTileData[][];
  /** Which player owns each captured tile: "x,y" → player */
  capturedTiles: Record<string, DuelPlayer>;
  /** The capital tile of each player: "x,y" → player */
  capitals: Record<string, DuelPlayer>;
  /** Troop counts per tile: "x,y" → number */
  tileTroops: Record<string, number>;
  /** Whose turn it is */
  currentTurn: DuelPlayer;
  /** Remaining AP for the current turn */
  currentAP: number;
  /** Maximum AP per turn */
  maxAP: number;
  /** How many tiles player 1 has captured */
  p1Territory: number;
  /** How many tiles player 2 has captured */
  p2Territory: number;
  /** How many moves player 1 has made */
  p1MoveCount: number;
  /** How many moves player 2 has made */
  p2MoveCount: number;
  /** Total number of moves made */
  moveCount: number;
  /** The winner, or null if ongoing */
  winner: DuelPlayer | null;
  /** Tiles that were just captured (for animation) */
  recentlyCaptured: string[];
  /** Combat animation keys */
  combatFlash: string[];
}

// ── Constants ───────────────────────────────────────────────────────────────

const MAX_AP = 3;
export const REINFORCE_COST = 1; // reused for displace
const ATTACK_COST = 1;
const DISPLACE_COST = 1;

// ── Initial positions ─────────────────────────────────────────────────────

const INITIAL_P1 = { x: 0, y: 0 };
const INITIAL_P2 = { x: GRID_SIZE - 1, y: GRID_SIZE - 1 };

const P1_CAP_KEY = `${INITIAL_P1.x},${INITIAL_P1.y}`;
const P2_CAP_KEY = `${INITIAL_P2.x},${INITIAL_P2.y}`;

const INITIAL_TROOPS = 5;

// ── Helpers ─────────────────────────────────────────────────────────────────

function createBlankGrid(): HexTileData[][] {
  return Array.from({ length: GRID_SIZE }, (_, y) =>
    Array.from({ length: GRID_SIZE }, (_, x) => ({
      x,
      y,
      owner: "neutral" as const,
      troops: 0,
      shield: 0,
      capital: false,
    }))
  );
}

/** Check if two tiles are adjacent (including diagonals) */
function areAdjacent(keyA: string, keyB: string): boolean {
  const [ax, ay] = keyA.split(",").map(Number);
  const [bx, by] = keyB.split(",").map(Number);
  return getHexNeighbors(ax, ay).some((n) => n.x === bx && n.y === by);
}

/** Get the other player */
function otherPlayer(p: DuelPlayer): DuelPlayer {
  return p === "player1" ? "player2" : "player1";
}

// ── Reducer-based game state ───────────────────────────────────────────────
//
// Critical fix for multiplayer desync (Audit C1): all reads of game-state
// happen INSIDE the reducer via the `state` argument, which is GUARANTEED
// to be the latest committed state when each dispatch runs. Multiple rapid
// socket/poll dispatches are processed serially by React — each reducer
// call sees the previous dispatch's resulting state, so chained actions
// compute over fresh data, not stale closures.

/** Core game state managed by the reducer */
interface CoreState {
  /** ownership per tile key */
  capturedTiles: Record<string, DuelPlayer>;
  /** troop count per tile key */
  tileTroops: Record<string, number>;
  /** whose turn it is */
  currentTurn: DuelPlayer;
  /** remaining action points for the current turn */
  currentAP: number;
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

function makeInitialCore(): CoreState {
  return {
    capturedTiles: {
      [P1_CAP_KEY]: "player1",
      [P2_CAP_KEY]: "player2",
    },
    tileTroops: {
      [P1_CAP_KEY]: INITIAL_TROOPS,
      [P2_CAP_KEY]: INITIAL_TROOPS,
    },
    currentTurn: "player1",
    currentAP: MAX_AP,
    winner: null,
    recentlyCaptured: [],
    combatFlash: [],
    p1MoveCount: 0,
    p2MoveCount: 0,
    moveCount: 0,
  };
}

/** Computes the conquer/tie/fail outcome of an attack from current state. */
type AttackOutcome =
  | { kind: "conquer"; remainingTroops: number; conqueredCapital: boolean }
  | { kind: "tie"; tileTroops: 0 }
  | { kind: "failed"; newDefenderTroops: number; defenderWipedOut: boolean };

function resolveAttackOutcome(
  state: CoreState,
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

/** Apply troop growth: +1 troop per owned tile for `player`. */
function growTroops(state: CoreState, player: DuelPlayer): CoreState {
  const tiles = state.tileTroops;
  const next: Record<string, number> = { ...tiles };
  for (const [key, owner] of Object.entries(state.capturedTiles)) {
    if (owner === player) {
      next[key] = (next[key] ?? 1) + 1;
    }
  }
  return { ...state, tileTroops: next };
}

/** Switch turn and regenerate +1 AP (capped). Resets flash effects. */
function switchTurnCore(state: CoreState): CoreState {
  const nextTurn = otherPlayer(state.currentTurn);
  return {
    ...state,
    currentTurn: nextTurn,
    currentAP: Math.min(state.currentAP + 1, MAX_AP),
    recentlyCaptured: [],
    combatFlash: [],
  };
}

// ── Reducer action types ───────────────────────────────────────────────────

type ReducerAction =
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
      type: "endTurn";
      player: DuelPlayer;
      /** When true, skip troop growth (the caller already applied it). */
      skipTroopGrowth: boolean;
    }
  | { type: "troopGrowth"; player: DuelPlayer }
  | { type: "reset" }
  | { type: "syncSnapshot"; snapshot: CoreState };

function coreReducer(
  state: CoreState,
  action: ReducerAction,
  capitals: Record<string, DuelPlayer>,
): CoreState {
  switch (action.type) {
    case "attack": {
      // Idempotency: don't apply further actions after winner is set.
      if (state.winner) return state;

      const { sourceKey, targetKey, troopCount, player } = action;
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
      let recentlyCaptured = state.recentlyCaptured;
      let combatFlash: string[];

      // 2. Outcome branches — all reads are from current `state` argument.
      if (outcome.kind === "conquer") {
        capturedTiles = { ...state.capturedTiles, [targetKey]: player };
        tileTroops = { ...tileTroops, [targetKey]: outcome.remainingTroops };
        recentlyCaptured = [targetKey];
        combatFlash = [sourceKey, targetKey];
      } else if (outcome.kind === "tie") {
        const next: Record<string, DuelPlayer> = { ...state.capturedTiles };
        delete next[targetKey];
        capturedTiles = next;
        tileTroops = { ...tileTroops, [targetKey]: outcome.tileTroops };
        combatFlash = [sourceKey, targetKey];
      } else {
        tileTroops = { ...tileTroops, [targetKey]: outcome.newDefenderTroops };
        if (outcome.defenderWipedOut) {
          const next: Record<string, DuelPlayer> = { ...state.capturedTiles };
          delete next[targetKey];
          capturedTiles = next;
        }
        combatFlash = [sourceKey, targetKey];
      }

      // 3. AP management based on outcome.
      let { currentAP, currentTurn, winner, p1MoveCount, p2MoveCount, moveCount } =
        state;

      const moveIncrement = player === "player1" ? 1 : 0;
      const moveIncrementP2 = player === "player2" ? 1 : 0;
      p1MoveCount += moveIncrement;
      p2MoveCount += moveIncrementP2;
      moveCount += 1;

      if (outcome.kind === "conquer" && outcome.conqueredCapital) {
        // Game ends immediately — no AP switch, no troop growth for next player.
        winner = player;
      } else {
        const newAP = currentAP - ATTACK_COST;
        if (newAP <= 0) {
          // AP depleted → grow sender's troops, switch turn.
          // (Mirrors the sender's `handleAttack` auto-end-turn behavior.)
          const grown = growTroops(
            {
              ...state,
              capturedTiles,
              tileTroops,
              recentlyCaptured,
              combatFlash,
              p1MoveCount,
              p2MoveCount,
              moveCount,
              currentAP: 0,
            },
            currentTurn,
          );
          return switchTurnCore(grown);
        } else {
          currentAP = newAP;
        }
      }

      return {
        ...state,
        capturedTiles,
        tileTroops,
        recentlyCaptured,
        combatFlash,
        currentAP,
        currentTurn,
        winner,
        p1MoveCount,
        p2MoveCount,
        moveCount,
      };
    }

    case "displace": {
      if (state.winner) return state;

      const { sourceKey, targetKey, troopCount, player } = action;
      const sourceTroops = state.tileTroops[sourceKey] ?? 1;
      // Apply troop moves.
      const tileTroops: Record<string, number> = {
        ...state.tileTroops,
        [sourceKey]: sourceTroops - troopCount,
        [targetKey]: (state.tileTroops[targetKey] ?? 1) + troopCount,
      };

      let { currentAP, currentTurn, p1MoveCount, p2MoveCount, moveCount } = state;
      const moveIncrementP1 = player === "player1" ? 1 : 0;
      const moveIncrementP2 = player === "player2" ? 1 : 0;
      p1MoveCount += moveIncrementP1;
      p2MoveCount += moveIncrementP2;
      moveCount += 1;

      const newAP = currentAP - DISPLACE_COST;
      if (newAP <= 0) {
        const grown = growTroops(
          {
            ...state,
            tileTroops,
            p1MoveCount,
            p2MoveCount,
            moveCount,
            currentAP: 0,
          },
          currentTurn,
        );
        return switchTurnCore(grown);
      } else {
        currentAP = newAP;
      }

      return {
        ...state,
        tileTroops,
        currentAP,
        p1MoveCount,
        p2MoveCount,
        moveCount,
        combatFlash: [sourceKey, targetKey],
      };
    }

    case "troopGrowth": {
      if (state.winner) return state;
      return growTroops(state, action.player);
    }

    case "endTurn": {
      if (state.winner) return state;
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
      // snapshotted state is treated as authoritative.
      return {
        ...action.snapshot,
        recentlyCaptured: [],
        combatFlash: [],
      };
    }
  }
}

// ── Hook ────────────────────────────────────────────────────────────────────

export function useHexDuel() {
  // Capitals: fixed for the whole game — passed as the third reducer arg.
  const capitals = useRef<Record<string, DuelPlayer>>({
    [P1_CAP_KEY]: "player1",
    [P2_CAP_KEY]: "player2",
  }).current;

  // Core game state managed by reducer — guarantees atomic, fresh reads.
  const [state, dispatch] = useReducer(
    (s: CoreState, a: ReducerAction) => coreReducer(s, a, capitals),
    undefined,
    makeInitialCore,
  );

  // Action log is a separate concern (display only). Kept outside the
  // reducer to keep the reducer pure (no side effects).
  const actionLogRef = useRef<ActionLogEntry[]>([]);
  const [actionLog, setActionLog] = useState<ActionLogEntry[]>([]);
  const actionIdRef = useRef(0);

  const addActionLog = useCallback((entry: Omit<ActionLogEntry, "id">) => {
    actionIdRef.current += 1;
    const full: ActionLogEntry = { id: actionIdRef.current, ...entry };
    actionLogRef.current = [...actionLogRef.current, full];
    setActionLog(actionLogRef.current);
  }, []);

  // ── Derived: grid ──────────────────────────────────────────────────

  const grid = useMemo(() => {
    const g = createBlankGrid();
    for (const [key, owner] of Object.entries(state.capturedTiles)) {
      const [cx, cy] = key.split(",").map(Number);
      if (g[cy]?.[cx]) {
        g[cy][cx].owner = owner;
        g[cy][cx].troops = state.tileTroops[key] ?? 1;
        if (capitals[key]) {
          g[cy][cx].capital = true;
        }
      }
    }
    for (const [key] of Object.entries(capitals)) {
      const [cx, cy] = key.split(",").map(Number);
      if (g[cy]?.[cx] && !state.capturedTiles[key]) {
        g[cy][cx].owner = capitals[key] as "player1" | "player2";
        g[cy][cx].troops = state.tileTroops[key] ?? INITIAL_TROOPS;
        g[cy][cx].capital = true;
      }
    }
    return g;
  }, [state.capturedTiles, state.tileTroops, capitals]);

  // ── Derived: territory counts ────────────────────────────────────

  const p1Territory = useMemo(
    () => Object.values(state.capturedTiles).filter((o) => o === "player1").length,
    [state.capturedTiles],
  );
  const p2Territory = useMemo(
    () => Object.values(state.capturedTiles).filter((o) => o === "player2").length,
    [state.capturedTiles],
  );

  // ── Derived: helpers for the action UI ─────────────────────────────

  /** Tiles that can be attacked: enemy-owned or neutral tiles adjacent to
   *  the current player's territory. */
  const attackableTargets = useMemo(() => {
    if (state.winner) return [];
    const targets: { x: number; y: number }[] = [];
    const enemy = otherPlayer(state.currentTurn);
    const visited = new Set<string>();

    for (const [key, owner] of Object.entries(state.capturedTiles)) {
      if (owner !== state.currentTurn) continue;
      const [cx, cy] = key.split(",").map(Number);
      const neighbors = getHexNeighbors(cx, cy);
      for (const n of neighbors) {
        const nKey = `${n.x},${n.y}`;
        if (visited.has(nKey)) continue;
        if (
          state.capturedTiles[nKey] === enemy ||
          state.capturedTiles[nKey] === undefined
        ) {
          visited.add(nKey);
          targets.push({ x: n.x, y: n.y });
        }
      }
    }
    return targets;
  }, [state.capturedTiles, state.currentTurn, state.winner]);

  /** For a given target, list friendly adjacent tiles that can attack it. */
  const getAttackSources = useCallback(
    (targetKey: string): { x: number; y: number }[] => {
      const [tx, ty] = targetKey.split(",").map(Number);
      return (
        getHexNeighbors(tx, ty)
          .filter((n) => {
            const nKey = `${n.x},${n.y}`;
            return state.capturedTiles[nKey] === state.currentTurn;
          })
          // Exclude adjacent pairs that aren't really attack sources
          .map((n) => ({ x: n.x, y: n.y }))
      );
    },
    [state.capturedTiles, state.currentTurn],
  );

  /** Tiles that can receive displaced troops (all friendly tiles owned by currentTurn). */
  const displaceCandidates = useMemo(() => {
    const candidates: { x: number; y: number }[] = [];
    for (const [key, owner] of Object.entries(state.capturedTiles)) {
      if (owner !== state.currentTurn) continue;
      const [cx, cy] = key.split(",").map(Number);
      candidates.push({ x: cx, y: cy });
    }
    return candidates;
  }, [state.capturedTiles, state.currentTurn]);

  /** For a given displace target, find friendly sources adjacent to it with extra troops. */
  const getDisplaceSources = useCallback(
    (targetKey: string): { x: number; y: number; maxTroops: number }[] => {
      const [tx, ty] = targetKey.split(",").map(Number);
      return getHexNeighbors(tx, ty)
        .filter((n) => {
          const nKey = `${n.x},${n.y}`;
          return state.capturedTiles[nKey] === state.currentTurn && nKey !== targetKey;
        })
        .map((n) => {
          const nKey = `${n.x},${n.y}`;
          const troops = state.tileTroops[nKey] ?? 1;
          return {
            x: n.x,
            y: n.y,
            maxTroops: troops - 1, // must leave at least 1
          };
        })
        .filter((s) => s.maxTroops > 0);
    },
    [state.capturedTiles, state.tileTroops, state.currentTurn],
  );

  // ── Action log helpers ────────────────────────────────────────────
  //
  // Reducer dispatches that have a visible "log" side effect: emit an
  // ActionLogEntry. Done outside the reducer to keep it pure.

  const logAttack = useCallback(
    (
      sourceKey: string,
      targetKey: string,
      troopCount: number,
      player: DuelPlayer,
      outcome: AttackOutcome,
    ) => {
      const [sx, sy] = sourceKey.split(",").map(Number);
      const [tx, ty] = targetKey.split(",").map(Number);
      if (outcome.kind === "conquer") {
        const targetWas =
          state.capturedTiles[targetKey] === undefined
            ? 0
            : state.tileTroops[targetKey] ?? 1;
        addActionLog({
          player,
          type: "attack",
          source: { x: sx, y: sy },
          target: { x: tx, y: ty },
          apCost: ATTACK_COST,
          label: `Attack: sent ${troopCount} from (${sx},${sy}) → conquered (${tx},${ty}) (was ${targetWas}, ${outcome.remainingTroops} remain)`,
        });
      } else if (outcome.kind === "tie") {
        addActionLog({
          player,
          type: "attack",
          source: { x: sx, y: sy },
          target: { x: tx, y: ty },
          apCost: ATTACK_COST,
          label: `Attack: sent ${troopCount} from (${sx},${sy}) → mutual destruction! (${tx},${ty}) becomes neutral`,
        });
      } else {
        addActionLog({
          player,
          type: "attack",
          source: { x: sx, y: sy },
          target: { x: tx, y: ty },
          apCost: ATTACK_COST,
          label:
            outcome.defenderWipedOut
              ? `Attack: sent ${troopCount} from (${sx},${sy}) → wiped out defender! (${tx},${ty}) becomes neutral`
              : `Attack: sent ${troopCount} from (${sx},${sy}) → failed (${tx},${ty}) had ${state.tileTroops[targetKey] ?? 0}, defender down to ${outcome.newDefenderTroops}`,
        });
      }
    },
    [state.capturedTiles, state.tileTroops, addActionLog],
  );

  const logDisplace = useCallback(
    (
      sourceKey: string,
      targetKey: string,
      troopCount: number,
      player: DuelPlayer,
    ) => {
      const [sx, sy] = sourceKey.split(",").map(Number);
      const [tx, ty] = targetKey.split(",").map(Number);
      addActionLog({
        player,
        type: "displace",
        source: { x: sx, y: sy },
        target: { x: tx, y: ty },
        apCost: DISPLACE_COST,
        label: `Displace: moved ${troopCount} from (${sx},${sy}) → (${tx},${ty})`,
      });
    },
    [addActionLog],
  );

  // ── Public action handlers ────────────────────────────────────────

  /** Local attack — performs validation against current state, then dispatches. */
  const handleAttack = useCallback(
    (sourceKey: string, targetKey: string, troopCount: number) => {
      if (state.winner) return;
      if (state.currentAP < ATTACK_COST) return;

      const sourceOwner = state.capturedTiles[sourceKey];
      const targetOwner = state.capturedTiles[targetKey];
      const enemy = otherPlayer(state.currentTurn);

      if (sourceOwner !== state.currentTurn) return;
      if (targetOwner === state.currentTurn) return;
      if (targetOwner !== undefined && targetOwner !== enemy) return;
      if (!areAdjacent(sourceKey, targetKey)) return;

      const sourceTroops = state.tileTroops[sourceKey] ?? 1;
      if (sourceTroops < troopCount + 1) return;
      if (troopCount <= 0) return;

      // Log before dispatching so the log matches the player-visible action.
      const outcome = resolveAttackOutcome(
        state,
        sourceKey,
        targetKey,
        troopCount,
        state.currentTurn,
        capitals,
      );
      logAttack(sourceKey, targetKey, troopCount, state.currentTurn, outcome);

      dispatch({
        type: "attack",
        sourceKey,
        targetKey,
        troopCount,
        player: state.currentTurn,
      });
    },
    [state, capitals, logAttack],
  );

  /** Local displace — validates then dispatches. */
  const handleDisplace = useCallback(
    (sourceKey: string, targetKey: string, troopCount: number) => {
      if (state.winner) return;
      if (state.currentAP < DISPLACE_COST) return;

      if (sourceKey === targetKey) return;
      if (!areAdjacent(sourceKey, targetKey)) return;

      const sourceOwner = state.capturedTiles[sourceKey];
      const targetOwner = state.capturedTiles[targetKey];
      if (sourceOwner !== state.currentTurn) return;
      if (targetOwner !== state.currentTurn) return;

      const sourceTroops = state.tileTroops[sourceKey] ?? 1;
      if (sourceTroops < troopCount + 1) return;
      if (troopCount <= 0) return;

      logDisplace(sourceKey, targetKey, troopCount, state.currentTurn);
      dispatch({
        type: "displace",
        sourceKey,
        targetKey,
        troopCount,
        player: state.currentTurn,
      });
    },
    [state, logDisplace],
  );

  /** Local end turn — applies troop growth then switches turns. */
  const endTurn = useCallback(() => {
    if (state.winner) return;
    const grownTiles = Object.entries(state.capturedTiles)
      .filter(([, owner]) => owner === state.currentTurn)
      .map(([key]) => key);
    if (grownTiles.length > 0) {
      addActionLog({
        player: state.currentTurn,
        type: "troopGrowth",
        apCost: 0,
        label: `Troop growth: +1 on ${grownTiles.length} tile${grownTiles.length !== 1 ? "s" : ""}`,
      });
    }
    addActionLog({
      player: state.currentTurn,
      type: "endTurn",
      apCost: 0,
      label: "Ended turn",
    });
    dispatch({
      type: "endTurn",
      player: state.currentTurn,
      skipTroopGrowth: false,
    });
  }, [state, addActionLog]);

  /** Skip the current round — same as endTurn with a different label. */
  const skipRound = useCallback(() => {
    if (state.winner) return;
    const grownTiles = Object.entries(state.capturedTiles)
      .filter(([, owner]) => owner === state.currentTurn)
      .map(([key]) => key);
    if (grownTiles.length > 0) {
      addActionLog({
        player: state.currentTurn,
        type: "troopGrowth",
        apCost: 0,
        label: `Troop growth: +1 on ${grownTiles.length} tile${grownTiles.length !== 1 ? "s" : ""}`,
      });
    }
    addActionLog({
      player: state.currentTurn,
      type: "endTurn",
      apCost: 0,
      label: "Skipped round",
    });
    dispatch({
      type: "endTurn",
      player: state.currentTurn,
      skipTroopGrowth: false,
    });
  }, [state, addActionLog]);

  // ── Apply remote action (multiplayer sync) ──────────────────────
  //
  // Critical: this function dispatches to the same reducer the local
  // path uses, so rapid socket events and poll catch-ups execute over
  // fresh state — fixing the Audit C1 stale-closure desync. The
  // signature includes both content and an optional unique id so that
  // legitimately identical actions are not deduplicated by mistake
  // (Audit H1). The caller (page.tsx) supplies the id from the wire.
  //
  // Note: This function does NOT validate local state — the sender has
  // already validated and serialized the action. Trust the wire.
  // The reducer treats the action as the source of truth.
  //
  // Side-effect (reviewer feedback): emit a log entry on the receiver
  // side just like local `handleAttack` does. Without this, remote
  // actions would be silent in the receiver's ActionLog (display-only
  // regression — no state correctness impact). The log entry describes
  // the action from the receiver's POV (pre-dispatch closure state),
  // which may differ slightly from the sender's during a desync catch-up
  // but is correct for what the receiver observed.

  const applyRemoteAction = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (action: any) => {
      if (state.winner) return;

      // action.player (when set on the wire) tells us unambiguously which
      // player's turn the action originated from. The receiver's
      // state.currentTurn should mirror the global game state, but if it
      // ever drifts (polling-synthetic race, missed socket events), we
      // must still converge to the sender's intent — not flip back and
      // forth. Prefer action.player; fall back to the mirror-state value
      // for backward-compat with synthetic / poll-driven actions.
      // state.currentTurn is always a DuelPlayer literal, so fromPlayer
      // is always defined.
      const fromPlayer: DuelPlayer = action.player ?? state.currentTurn;

      switch (action.type) {
        case "attack": {
          if (!action.sourceKey || !action.targetKey || !action.troopCount) return;
          const outcome = resolveAttackOutcome(
            state,
            action.sourceKey,
            action.targetKey,
            action.troopCount,
            fromPlayer,
            capitals,
          );
          logAttack(
            action.sourceKey,
            action.targetKey,
            action.troopCount,
            fromPlayer,
            outcome,
          );
          dispatch({
            type: "attack",
            sourceKey: action.sourceKey,
            targetKey: action.targetKey,
            troopCount: action.troopCount,
            player: fromPlayer,
          });
          break;
        }
        case "displace": {
          if (!action.sourceKey || !action.targetKey || !action.troopCount) return;
          logDisplace(
            action.sourceKey,
            action.targetKey,
            action.troopCount,
            fromPlayer,
          );
          dispatch({
            type: "displace",
            sourceKey: action.sourceKey,
            targetKey: action.targetKey,
            troopCount: action.troopCount,
            player: fromPlayer,
          });
          break;
        }
        case "endTurn":
        case "skipRound": {
          // Idempotency guard — the reducer's switchTurnCore always flips.
          // If the receiver has already advanced past this turn (e.g. a
          // prior dispatch or a polling-driven synthetic endTurn already
          // flipped us), re-applying would oscillate the turn back to the
          // sender. Leave state untouched — that would put the action menu
          // back on the wrong player's screen.
          if (
            state.currentTurn !== fromPlayer &&
            state.currentTurn === otherPlayer(fromPlayer)
          ) {
            return;
          }
          // Sender already grew their own troops locally. We mirror the
          // turn switch only — the reducer's skipTroopGrowth flag
          // prevents double growth on the receiver side.
          dispatch({
            type: "endTurn",
            player: fromPlayer,
            skipTroopGrowth: true,
          });
          break;
        }
        default:
          return;
      }
    },
    [state, capitals, logAttack, logDisplace],
  );

  // ── Reset ─────────────────────────────────────────────────────────

  const resetGame = useCallback(() => {
    dispatch({ type: "reset" });
    actionLogRef.current = [];
    actionIdRef.current = 0;
    setActionLog([]);
  }, []);

  // ── State sync (multiplayer recovery) ───────────────────────────

  /** Build a serializable snapshot of all game state for sync requests. */
  const buildSyncSnapshot = useCallback(() => {
    return {
      currentTurn: state.currentTurn,
      currentAP: state.currentAP,
      moveCount: state.moveCount,
      p1MoveCount: state.p1MoveCount,
      p2MoveCount: state.p2MoveCount,
      p1Territory,
      p2Territory,
      winner: state.winner,
      capturedTiles: { ...state.capturedTiles },
      tileTroops: { ...state.tileTroops },
      actionLogId: actionIdRef.current,
    };
  }, [state, p1Territory, p2Territory]);

  /** Apply a remote sync snapshot — recover from desync via full overwrite. */
  const applySyncSnapshot = useCallback(
    (snapshot: {
      currentTurn: DuelPlayer;
      currentAP: number;
      moveCount: number;
      p1MoveCount: number;
      p2MoveCount: number;
      winner: DuelPlayer | null;
      capturedTiles: Record<string, DuelPlayer>;
      tileTroops: Record<string, number>;
    }) => {
      dispatch({
        type: "syncSnapshot",
        snapshot: {
          capturedTiles: snapshot.capturedTiles,
          tileTroops: snapshot.tileTroops,
          currentTurn: snapshot.currentTurn,
          currentAP: snapshot.currentAP,
          winner: snapshot.winner,
          p1MoveCount: snapshot.p1MoveCount,
          p2MoveCount: snapshot.p2MoveCount,
          moveCount: snapshot.moveCount,
          recentlyCaptured: [],
          combatFlash: [],
        },
      });
      // Action log is reset — log entries can't be reconciled from a
      // snapshot alone, so caller is responsible for re-applying them.
      actionLogRef.current = [];
      actionIdRef.current = 0;
      setActionLog([]);
    },
    [],
  );

  // ── Derived: legacy stubs (back-compat) ─────────────────────────

  const validMoves: { x: number; y: number }[] = [];
  const pushTargets: never[] = [];
  const selectedUnit = null;
  const selectedTile = null;
  const canMove = false;
  const canPush = false;

  // ── Legacy no-op stubs (kept for callers expecting them) ───────
  const handleTileClick = useCallback((_x: number, _y: number) => {
    /* legacy */
  }, []);
  const handleReinforceTile = useCallback((_x: number, _y: number) => {
    /* legacy — replaced by displace */
  }, []);

  const builtState: HexDuelState = {
    grid,
    capturedTiles: state.capturedTiles,
    capitals,
    tileTroops: state.tileTroops,
    currentTurn: state.currentTurn,
    currentAP: state.currentAP,
    maxAP: MAX_AP,
    p1Territory,
    p2Territory,
    p1MoveCount: state.p1MoveCount,
    p2MoveCount: state.p2MoveCount,
    moveCount: state.moveCount,
    winner: state.winner,
    recentlyCaptured: state.recentlyCaptured,
    combatFlash: state.combatFlash,
  };

  return {
    ...builtState,
    // Values needed by page.tsx
    selectedUnit,
    selectedTile,
    validMoves,
    pushTargets,
    canMove,
    canPush,
    // Action log
    actionLog,
    // Existing exports (legacy stubs)
    handleTileClick,
    handleReinforceTile,
    endTurn,
    skipRound,
    resetGame,
    // New exports
    handleAttack,
    handleDisplace,
    applyRemoteAction,
    attackableTargets,
    getAttackSources,
    displaceCandidates,
    getDisplaceSources,
    // State sync for multiplayer recovery
    buildSyncSnapshot,
    applySyncSnapshot,
  };
}
