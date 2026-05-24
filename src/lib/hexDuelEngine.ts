"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import type { HexTileData } from "../components/HexTile";
import { GRID_SIZE, getHexNeighbors } from "./hexGridUtils";
import { checkWinCondition } from "./hexWinDetection";

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
const MOVE_COST = 1;
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

// ── Hook ────────────────────────────────────────────────────────────────────

export function useHexDuel() {
  const [currentTurn, setCurrentTurn] = useState<DuelPlayer>("player1");
  const [currentAP, setCurrentAP] = useState(MAX_AP);
  const [moveCount, setMoveCount] = useState(0);
  const [p1MoveCount, setP1MoveCount] = useState(0);
  const [p2MoveCount, setP2MoveCount] = useState(0);
  const [winner, setWinner] = useState<DuelPlayer | null>(null);
  const [recentlyCaptured, setRecentlyCaptured] = useState<string[]>([]);
  const [combatFlash, setCombatFlash] = useState<string[]>([]);

  // Capitals: fixed for the whole game
  const capitals = useRef<Record<string, DuelPlayer>>({
    [P1_CAP_KEY]: "player1",
    [P2_CAP_KEY]: "player2",
  }).current;

  // Initial ownership: each player owns their capital
  const [capturedTiles, setCapturedTiles] = useState<Record<string, DuelPlayer>>({
    [P1_CAP_KEY]: "player1",
    [P2_CAP_KEY]: "player2",
  });

  // Initial troops: 5 on each capital
  const [tileTroops, setTileTroops] = useState<Record<string, number>>({
    [P1_CAP_KEY]: INITIAL_TROOPS,
    [P2_CAP_KEY]: INITIAL_TROOPS,
  });

  // Derived territory counts
  const p1Territory = useMemo(
    () => Object.values(capturedTiles).filter((o) => o === "player1").length,
    [capturedTiles]
  );
  const p2Territory = useMemo(
    () => Object.values(capturedTiles).filter((o) => o === "player2").length,
    [capturedTiles]
  );

  // ── Action log ───────────────────────────────────────────────────
  const actionLogRef = useRef<ActionLogEntry[]>([]);
  const [actionLog, setActionLog] = useState<ActionLogEntry[]>([]);
  const actionIdRef = useRef(0);

  const addActionLog = useCallback((entry: Omit<ActionLogEntry, 'id'>) => {
    actionIdRef.current += 1;
    const full: ActionLogEntry = { id: actionIdRef.current, ...entry };
    actionLogRef.current = [...actionLogRef.current, full];
    setActionLog(actionLogRef.current);
  }, []);

  // ── Derived: grid ──────────────────────────────────────────────────

  const grid = useMemo(() => {
    const g = createBlankGrid();
    // Stamp owned tiles
    for (const [key, owner] of Object.entries(capturedTiles)) {
      const [cx, cy] = key.split(",").map(Number);
      if (g[cy]?.[cx]) {
        g[cy][cx].owner = owner;
        g[cy][cx].troops = tileTroops[key] ?? 1;
        // Mark if this is a capital
        if (capitals[key]) {
          g[cy][cx].capital = true;
        }
      }
    }
    // Also ensure capital tiles show up even if somehow not in capturedTiles
    for (const [key] of Object.entries(capitals)) {
      const [cx, cy] = key.split(",").map(Number);
      if (g[cy]?.[cx] && !capturedTiles[key]) {
        g[cy][cx].owner = capitals[key] as "player1" | "player2";
        g[cy][cx].troops = tileTroops[key] ?? INITIAL_TROOPS;
        g[cy][cx].capital = true;
      }
    }
    return g;
  }, [capturedTiles, tileTroops, capitals]);

  // ── Helpers: adjacent enemy tiles & adjacent friendly tiles ────────

  /** Tiles that can be attacked: enemy-owned or neutral tiles adjacent to the current player's territory */
  const attackableTargets = useMemo(() => {
    if (winner) return [];
    const targets: { x: number; y: number }[] = [];
    const enemy = otherPlayer(currentTurn);
    const visited = new Set<string>();

    for (const [key, owner] of Object.entries(capturedTiles)) {
      if (owner !== currentTurn) continue;
      const [cx, cy] = key.split(",").map(Number);
      const neighbors = getHexNeighbors(cx, cy);
      for (const n of neighbors) {
        const nKey = `${n.x},${n.y}`;
        if (visited.has(nKey)) continue;
        // Allow attacking enemy tiles OR neutral (unowned) tiles
        if (capturedTiles[nKey] === enemy || capturedTiles[nKey] === undefined) {
          visited.add(nKey);
          targets.push({ x: n.x, y: n.y });
        }
      }
    }
    return targets;
  }, [capturedTiles, currentTurn, winner]);

  /** For a given target tile, list friendly adjacent tiles that can attack it */
  const getAttackSources = useCallback(
    (targetKey: string): { x: number; y: number }[] => {
      const [tx, ty] = targetKey.split(",").map(Number);
      return getHexNeighbors(tx, ty)
        .filter((n) => {
          const nKey = `${n.x},${n.y}`;
          return capturedTiles[nKey] === currentTurn;
        })
        .map((n) => ({ x: n.x, y: n.y }));
    },
    [capturedTiles, currentTurn]
  );

  /** Tiles that can receive displaced troops (friendly tiles adjacent to other friendly tiles) */
  const displaceCandidates = useMemo(() => {
    const candidates: { x: number; y: number }[] = [];
    const myTiles = Object.entries(capturedTiles)
      .filter(([, o]) => o === currentTurn)
      .map(([k]) => k);

    for (const key of myTiles) {
      const [cx, cy] = key.split(",").map(Number);
      const neighbors = getHexNeighbors(cx, cy);
      for (const n of neighbors) {
        const nKey = `${n.x},${n.y}`;
        if (capturedTiles[nKey] === currentTurn && nKey !== key) {
          candidates.push({ x: n.x, y: n.y });
        }
      }
    }
    // Deduplicate
    const seen = new Set<string>();
    return candidates.filter((c) => {
      const k = `${c.x},${c.y}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }, [capturedTiles, currentTurn]);

  /** For a given displace target, find friendly sources adjacent to it with extra troops */
  const getDisplaceSources = useCallback(
    (targetKey: string): { x: number; y: number; maxTroops: number }[] => {
      const [tx, ty] = targetKey.split(",").map(Number);
      return getHexNeighbors(tx, ty)
        .filter((n) => {
          const nKey = `${n.x},${n.y}`;
          return capturedTiles[nKey] === currentTurn && nKey !== targetKey;
        })
        .map((n) => {
          const nKey = `${n.x},${n.y}`;
          const troops = tileTroops[nKey] ?? 1;
          return {
            x: n.x,
            y: n.y,
            maxTroops: troops - 1, // must leave at least 1
          };
        })
        .filter((s) => s.maxTroops > 0);
    },
    [capturedTiles, tileTroops, currentTurn]
  );

  // ── Turn management ────────────────────────────────────────────────

  const switchTurn = useCallback(() => {
    setCurrentTurn((t) => (t === "player1" ? "player2" : "player1"));
    // Regenerate 1 AP per turn (capped at MAX_AP)
    setCurrentAP((prev) => Math.min(prev + 1, MAX_AP));
    setRecentlyCaptured([]);
    setCombatFlash([]);
  }, []);

  /** Apply troop growth: +1 troop on all owned tiles for the next player */
  const applyTroopGrowth = useCallback(
    (player: DuelPlayer) => {
      const growthTiles: string[] = [];
      setTileTroops((prev) => {
        const next = { ...prev };
        for (const [key, owner] of Object.entries(capturedTiles)) {
          if (owner === player) {
            next[key] = (next[key] ?? 1) + 1;
            growthTiles.push(key);
          }
        }
        return next;
      });
      if (growthTiles.length > 0) {
        addActionLog({
          player,
          type: "troopGrowth",
          apCost: 0,
          label: `Troop growth: +1 on ${growthTiles.length} tile${growthTiles.length !== 1 ? "s" : ""}`,
        });
      }
    },
    [capturedTiles, addActionLog]
  );

  const endTurn = useCallback(() => {
    if (winner) return;
    // Apply troop growth for the player ending their turn
    applyTroopGrowth(currentTurn);
    addActionLog({ player: currentTurn, type: "endTurn", apCost: 0, label: "Ended turn" });
    switchTurn();
  }, [winner, currentTurn, applyTroopGrowth, addActionLog, switchTurn]);

  const skipRound = useCallback(() => {
    if (winner) return;
    applyTroopGrowth(currentTurn);
    addActionLog({ player: currentTurn, type: "endTurn", apCost: 0, label: "Skipped round" });
    switchTurn();
  }, [winner, currentTurn, applyTroopGrowth, addActionLog, switchTurn]);

  // ── Attack action ─────────────────────────────────────────────────

  const handleAttack = useCallback(
    (sourceKey: string, targetKey: string, troopCount: number) => {
      if (winner) return;
      if (currentAP < ATTACK_COST) return;

      const sourceOwner = capturedTiles[sourceKey];
      const targetOwner = capturedTiles[targetKey];
      const enemy = otherPlayer(currentTurn);

      // Validate: target must be enemy-owned or neutral (unowned)
      if (sourceOwner !== currentTurn) return;
      if (targetOwner === currentTurn) return; // can't attack own tiles
      if (targetOwner !== undefined && targetOwner !== enemy) return;
      if (!areAdjacent(sourceKey, targetKey)) return;

      const sourceTroops = tileTroops[sourceKey] ?? 1;
      if (sourceTroops < troopCount + 1) return; // leave at least 1
      if (troopCount <= 0) return;

      // Neutral/unowned tiles have 0 troops; enemy tiles use their actual troop count
      const targetTroops = capturedTiles[targetKey] === undefined ? 0 : (tileTroops[targetKey] ?? 1);

      const [sx, sy] = sourceKey.split(",").map(Number);
      const [tx, ty] = targetKey.split(",").map(Number);

      // Deduct AP
      const newAP = currentAP - ATTACK_COST;

      // Source loses troops
      setTileTroops((prev) => ({
        ...prev,
        [sourceKey]: sourceTroops - troopCount,
      }));

      if (troopCount > targetTroops) {
        // ── CONQUER! ─────────────────────────────────────────────
        setCapturedTiles((prev) => ({
          ...prev,
          [targetKey]: currentTurn,
        }));
        setTileTroops((prev) => ({
          ...prev,
          [targetKey]: 1, // conquered tile has 1 troop
        }));

        setRecentlyCaptured([targetKey]);
        setCombatFlash([sourceKey, targetKey]);

        addActionLog({
          player: currentTurn,
          type: "attack",
          source: { x: sx, y: sy },
          target: { x: tx, y: ty },
          apCost: ATTACK_COST,
          label: `Attack: sent ${troopCount} from (${sx},${sy}) → conquered (${tx},${ty}) (was ${targetTroops})`,
        });

        // Check if conquered tile is the enemy's capital
        if (capitals[targetKey] === enemy) {
          setWinner(currentTurn);
          // Don't do AP management — game is over
          return;
        }
      } else {
        // ── FAILED ATTACK ─────────────────────────────────────────
        const defenderLoss = Math.min(targetTroops, troopCount);
        setTileTroops((prev) => ({
          ...prev,
          [targetKey]: targetTroops - defenderLoss,
        }));

        setCombatFlash([sourceKey, targetKey]);

        addActionLog({
          player: currentTurn,
          type: "attack",
          source: { x: sx, y: sy },
          target: { x: tx, y: ty },
          apCost: ATTACK_COST,
          label: `Attack: sent ${troopCount} from (${sx},${sy}) → failed (${tx},${ty}) had ${targetTroops}, defender lost ${defenderLoss}`,
        });
      }

      // AP management
      if (newAP <= 0) {
        applyTroopGrowth(currentTurn);
        addActionLog({ player: currentTurn, type: "endTurn", apCost: 0, label: "Ended turn (AP depleted)" });
        switchTurn();
      } else {
        setCurrentAP(newAP);
      }
    },
    [winner, currentAP, capturedTiles, tileTroops, capitals, addActionLog, applyTroopGrowth, switchTurn]
  );

  // ── Displace / Reinforce action ──────────────────────────────────

  const handleDisplace = useCallback(
    (sourceKey: string, targetKey: string, troopCount: number) => {
      if (winner) return;
      if (currentAP < DISPLACE_COST) return;

      if (sourceKey === targetKey) return;
      if (!areAdjacent(sourceKey, targetKey)) return;

      const sourceOwner = capturedTiles[sourceKey];
      const targetOwner = capturedTiles[targetKey];

      if (sourceOwner !== currentTurn) return;
      if (targetOwner !== currentTurn) return;

      const sourceTroops = tileTroops[sourceKey] ?? 1;
      if (sourceTroops < troopCount + 1) return; // leave at least 1
      if (troopCount <= 0) return;

      const [sx, sy] = sourceKey.split(",").map(Number);
      const [tx, ty] = targetKey.split(",").map(Number);

      // Move troops
      setTileTroops((prev) => ({
        ...prev,
        [sourceKey]: sourceTroops - troopCount,
        [targetKey]: (prev[targetKey] ?? 1) + troopCount,
      }));

      const newAP = currentAP - DISPLACE_COST;

      addActionLog({
        player: currentTurn,
        type: "displace",
        source: { x: sx, y: sy },
        target: { x: tx, y: ty },
        apCost: DISPLACE_COST,
        label: `Displace: moved ${troopCount} from (${sx},${sy}) → (${tx},${ty})`,
      });

      // AP management
      if (newAP <= 0) {
        applyTroopGrowth(currentTurn);
        addActionLog({ player: currentTurn, type: "endTurn", apCost: 0, label: "Ended turn (AP depleted)" });
        switchTurn();
      } else {
        setCurrentAP(newAP);
      }
    },
    [winner, currentAP, capturedTiles, tileTroops, addActionLog, applyTroopGrowth, switchTurn]
  );

  // ── Legacy: old grid actions (no-op stubs to prevent crashes) ─────

  const handleTileClick = useCallback((_x: number, _y: number) => {
    // Legacy no-op — new action system handles everything
  }, []);

  const handleReinforceTile = useCallback((_x: number, _y: number) => {
    // Legacy no-op — replaced by displace
  }, []);

  // ── Apply remote action (for multiplayer sync) ──────────────────

  const applyRemoteAction = useCallback((action: {
    type: 'attack' | 'displace' | 'endTurn' | 'skipRound';
    sourceKey?: string;
    targetKey?: string;
    troopCount?: number;
  }) => {
    if (winner) return;
    if (action.type === 'attack' && action.sourceKey && action.targetKey && action.troopCount) {
      handleAttack(action.sourceKey, action.targetKey, action.troopCount);
    } else if (action.type === 'displace' && action.sourceKey && action.targetKey && action.troopCount) {
      handleDisplace(action.sourceKey, action.targetKey, action.troopCount);
    } else if (action.type === 'endTurn') {
      endTurn();
    } else if (action.type === 'skipRound') {
      skipRound();
    }
  }, [winner, handleAttack, handleDisplace, endTurn, skipRound]);

  // ── Reset ─────────────────────────────────────────────────────────

  const resetGame = useCallback(() => {
    setCurrentTurn("player1");
    setCurrentAP(MAX_AP);
    setMoveCount(0);
    setP1MoveCount(0);
    setP2MoveCount(0);
    setWinner(null);
    setRecentlyCaptured([]);
    setCombatFlash([]);
    setCapturedTiles({
      [P1_CAP_KEY]: "player1",
      [P2_CAP_KEY]: "player2",
    });
    setTileTroops({
      [P1_CAP_KEY]: INITIAL_TROOPS,
      [P2_CAP_KEY]: INITIAL_TROOPS,
    });
    // Reset action log
    actionLogRef.current = [];
    actionIdRef.current = 0;
    setActionLog([]);
  }, []);

  // ── Derived: valid moves (empty stub for backward compat) ─────────

  const validMoves: { x: number; y: number }[] = [];
  const pushTargets: never[] = [];
  const selectedUnit = null;
  const selectedTile = null;
  const canMove = false;
  const canPush = false;

  const state: HexDuelState = {
    grid,
    capturedTiles,
    capitals,
    tileTroops,
    currentTurn,
    currentAP,
    maxAP: MAX_AP,
    p1Territory,
    p2Territory,
    p1MoveCount,
    p2MoveCount,
    moveCount,
    winner,
    recentlyCaptured,
    combatFlash,
  };

  return {
    ...state,
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
  };
}
