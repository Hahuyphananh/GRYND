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

  /** Tiles that can receive displaced troops (all friendly tiles) */
  const displaceCandidates = useMemo(() => {
    const candidates: { x: number; y: number }[] = [];
    for (const [key, owner] of Object.entries(capturedTiles)) {
      if (owner !== currentTurn) continue;
      const [cx, cy] = key.split(",").map(Number);
      candidates.push({ x: cx, y: cy });
    }
    return candidates;
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

  // ── Remote action flag ───────────────────────────────────────────
  // Set to true before calling a handler from applyRemoteAction so that
  // troop growth (which the sender already applied) is skipped.
  const skipTroopGrowthRef = useRef(false);

  /** Apply troop growth: +1 troop on all owned tiles for the next player.
   *  When called from applyRemoteAction, the ref flag suppresses double growth. */
  const applyTroopGrowth = useCallback(
    (player: DuelPlayer) => {
      if (skipTroopGrowthRef.current) {
        skipTroopGrowthRef.current = false;
        return;
      }
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
  //
  // _applyAttackRaw: applies the raw tile state changes for an attack
  // without any validation. Used by both handleAttack (after local
  // validation) and applyRemoteAction (where the sender already validated).
  // Reads current state from closure (same as handleAttack did before),
  // which is safe because the closure is always up-to-date via useCallback
  // dependencies on capturedTiles and tileTroops.

  const _applyAttackRaw = useCallback(
    (sourceKey: string, targetKey: string, troopCount: number, attacker: DuelPlayer) => {
      const [sx, sy] = sourceKey.split(",").map(Number);
      const [tx, ty] = targetKey.split(",").map(Number);
      const enemy = otherPlayer(attacker);

      const sourceTroops = tileTroops[sourceKey] ?? 1;
      const targetOwner = capturedTiles[targetKey];
      const targetTroops = targetOwner === undefined ? 0 : (tileTroops[targetKey] ?? 1);

      // Source loses troops
      setTileTroops((prev) => ({
        ...prev,
        [sourceKey]: sourceTroops - troopCount,
      }));

      if (troopCount > targetTroops) {
        // ── CONQUER! ─────────────────────────────────────────────
        const remainingTroops = troopCount - targetTroops;
        setCapturedTiles((prev) => ({
          ...prev,
          [targetKey]: attacker,
        }));
        setTileTroops((prev) => ({
          ...prev,
          [targetKey]: remainingTroops,
        }));

        setRecentlyCaptured([targetKey]);
        setCombatFlash([sourceKey, targetKey]);

        addActionLog({
          player: attacker,
          type: "attack",
          source: { x: sx, y: sy },
          target: { x: tx, y: ty },
          apCost: ATTACK_COST,
          label: `Attack: sent ${troopCount} from (${sx},${sy}) → conquered (${tx},${ty}) (was ${targetTroops}, ${remainingTroops} remain)`,
        });

        // Check if conquered tile is the enemy's capital
        if (capitals[targetKey] === enemy) {
          setWinner(attacker);
          return true; // game over
        }
        return false;
      } else if (troopCount === targetTroops && targetTroops > 0) {
        // ── TIE: both sides wiped out, territory becomes neutral ──
        setCapturedTiles((prev) => {
          const next = { ...prev };
          delete next[targetKey];
          return next;
        });
        setTileTroops((prev) => ({
          ...prev,
          [targetKey]: 0,
        }));

        setCombatFlash([sourceKey, targetKey]);

        addActionLog({
          player: attacker,
          type: "attack",
          source: { x: sx, y: sy },
          target: { x: tx, y: ty },
          apCost: ATTACK_COST,
          label: `Attack: sent ${troopCount} from (${sx},${sy}) → mutual destruction! (${tx},${ty}) becomes neutral`,
        });
        return false;
      } else {
        // ── FAILED ATTACK ─────────────────────────────────────────
        const defenderLoss = Math.min(targetTroops, troopCount);
        const newDefenderTroops = targetTroops - defenderLoss;
        setTileTroops((prev) => ({
          ...prev,
          [targetKey]: newDefenderTroops,
        }));

        // If defender drops to 0, territory becomes neutral
        if (newDefenderTroops === 0 && targetTroops > 0) {
          setCapturedTiles((prev) => {
            const next = { ...prev };
            delete next[targetKey];
            return next;
          });
        }

        setCombatFlash([sourceKey, targetKey]);

        addActionLog({
          player: attacker,
          type: "attack",
          source: { x: sx, y: sy },
          target: { x: tx, y: ty },
          apCost: ATTACK_COST,
          label: newDefenderTroops === 0
            ? `Attack: sent ${troopCount} from (${sx},${sy}) → wiped out defender! (${tx},${ty}) becomes neutral`
            : `Attack: sent ${troopCount} from (${sx},${sy}) → failed (${tx},${ty}) had ${targetTroops}, defender down to ${newDefenderTroops}`,
        });
        return false;
      }
    },
    [capturedTiles, tileTroops, capitals, addActionLog]
  );

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

      const newAP = currentAP - ATTACK_COST;

      // Apply the raw state changes — returns true if game ended (capital conquered)
      const gameOver = _applyAttackRaw(sourceKey, targetKey, troopCount, currentTurn);

      // AP management — skip if the attack conquered the enemy capital (game over)
      if (!gameOver) {
        if (newAP <= 0) {
          applyTroopGrowth(currentTurn);
          addActionLog({ player: currentTurn, type: "endTurn", apCost: 0, label: "Ended turn (AP depleted)" });
          switchTurn();
        } else {
          setCurrentAP(newAP);
        }
      }
    },
    [winner, currentAP, capturedTiles, tileTroops, capitals, addActionLog, applyTroopGrowth, switchTurn, _applyAttackRaw]
  );

  // ── Displace / Reinforce action ──────────────────────────────────
  //
  // _applyDisplaceRaw: applies the raw tile state changes for a displace
  // without any validation. Used by both handleDisplace and applyRemoteAction.

  const _applyDisplaceRaw = useCallback(
    (sourceKey: string, targetKey: string, troopCount: number, attacker: DuelPlayer) => {
      const [sx, sy] = sourceKey.split(",").map(Number);
      const [tx, ty] = targetKey.split(",").map(Number);

      setTileTroops((prev) => ({
        ...prev,
        [sourceKey]: (prev[sourceKey] ?? 1) - troopCount,
        [targetKey]: (prev[targetKey] ?? 1) + troopCount,
      }));

      addActionLog({
        player: attacker,
        type: "displace",
        source: { x: sx, y: sy },
        target: { x: tx, y: ty },
        apCost: DISPLACE_COST,
        label: `Displace: moved ${troopCount} from (${sx},${sy}) → (${tx},${ty})`,
      });
    },
    [addActionLog]
  );

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

      _applyDisplaceRaw(sourceKey, targetKey, troopCount, currentTurn);

      const newAP = currentAP - DISPLACE_COST;

      // AP management
      if (newAP <= 0) {
        applyTroopGrowth(currentTurn);
        addActionLog({ player: currentTurn, type: "endTurn", apCost: 0, label: "Ended turn (AP depleted)" });
        switchTurn();
      } else {
        setCurrentAP(newAP);
      }
    },
    [winner, currentAP, capturedTiles, tileTroops, addActionLog, applyTroopGrowth, switchTurn, _applyDisplaceRaw]
  );

  // ── Legacy: old grid actions (no-op stubs to prevent crashes) ─────

  const handleTileClick = useCallback((_x: number, _y: number) => {
    // Legacy no-op — new action system handles everything
  }, []);

  const handleReinforceTile = useCallback((_x: number, _y: number) => {
    // Legacy no-op — replaced by displace
  }, []);

  // ── Apply remote action (for multiplayer sync) ──────────────────
  //
  // For attack/displace: applies state changes directly via the raw helpers,
  // bypassing validation checks (currentAP, currentTurn matching, ownership,
  // troop availability) that depend on the receiver's local state, which may
  // be slightly stale compared to the sender's state at action time.
  //
  // For endTurn/skipRound: calls the turn functions with troop growth skipped
  // (the sender already applied troop growth).
  //
  // AP management for remote attack/displace: the receiver tracks AP in sync
  // with the sender, so we reduce AP by the cost and switch turns if depleted.

  const applyRemoteAction = useCallback((action: {
    type: 'attack' | 'displace' | 'endTurn' | 'skipRound';
    sourceKey?: string;
    targetKey?: string;
    troopCount?: number;
  }) => {
    if (winner) return;

    if (action.type === 'attack' && action.sourceKey && action.targetKey && action.troopCount) {
      skipTroopGrowthRef.current = true;
      const sender = currentTurn;
      const gameOver = _applyAttackRaw(action.sourceKey, action.targetKey, action.troopCount, sender);

      // AP management — skip if game ended from this attack.
      // Uses closure currentAP (same pattern as handleAttack).
      // Does NOT switch the turn when AP depletes — the follow-up endTurn
      // message from the sender will handle turn switching and troop growth.
      if (!gameOver) {
        const willDeplete = currentAP <= ATTACK_COST;
        if (willDeplete) {
          setCurrentAP(0);
          // Leave skipTroopGrowthRef = true so the follow-up endTurn
          // will skip double troop growth and switch the turn.
        } else {
          setCurrentAP(currentAP - ATTACK_COST);
          skipTroopGrowthRef.current = false;
        }
      } else {
        skipTroopGrowthRef.current = false;
      }
    } else if (action.type === 'displace' && action.sourceKey && action.targetKey && action.troopCount) {
      skipTroopGrowthRef.current = true;
      const sender = currentTurn;
      _applyDisplaceRaw(action.sourceKey, action.targetKey, action.troopCount, sender);

      // AP management — same pattern as attack (no turn switch for depleted AP)
      const willDeplete = currentAP <= DISPLACE_COST;
      if (willDeplete) {
        setCurrentAP(0);
        // Leave skipTroopGrowthRef = true for follow-up endTurn
      } else {
        setCurrentAP(currentAP - DISPLACE_COST);
        skipTroopGrowthRef.current = false;
      }
    } else if (action.type === 'endTurn') {
      skipTroopGrowthRef.current = true;
      endTurn();
    } else if (action.type === 'skipRound') {
      skipTroopGrowthRef.current = true;
      skipRound();
    }
  }, [winner, _applyAttackRaw, _applyDisplaceRaw, endTurn, skipRound, currentTurn, applyTroopGrowth, addActionLog, switchTurn]);

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

  // ── State sync (for multiplayer recovery) ──────────────────────────
  // Build a serializable snapshot of all game state for sync requests
  const buildSyncSnapshot = useCallback(() => {
    return {
      currentTurn,
      currentAP,
      moveCount,
      p1MoveCount,
      p2MoveCount,
      p1Territory,
      p2Territory,
      winner,
      capturedTiles: { ...capturedTiles },
      tileTroops: { ...tileTroops },
      actionLogId: actionIdRef.current,
    };
  }, [currentTurn, currentAP, moveCount, p1MoveCount, p2MoveCount, p1Territory, p2Territory, winner, capturedTiles, tileTroops]);

  /** Apply a remote sync snapshot — used to recover from desync */
  const applySyncSnapshot = useCallback((snapshot: {
    currentTurn: DuelPlayer;
    currentAP: number;
    moveCount: number;
    p1MoveCount: number;
    p2MoveCount: number;
    p1Territory: number;
    p2Territory: number;
    winner: DuelPlayer | null;
    capturedTiles: Record<string, DuelPlayer>;
    tileTroops: Record<string, number>;
    actionLogId: number;
  }) => {
    setCurrentTurn(snapshot.currentTurn);
    setCurrentAP(snapshot.currentAP);
    setMoveCount(snapshot.moveCount);
    setP1MoveCount(snapshot.p1MoveCount);
    setP2MoveCount(snapshot.p2MoveCount);
    setWinner(snapshot.winner);
    setCapturedTiles(snapshot.capturedTiles);
    setTileTroops(snapshot.tileTroops);      setRecentlyCaptured([]);
    setCombatFlash([]);
    actionIdRef.current = snapshot.actionLogId;
    actionLogRef.current = [];
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
    // State sync for multiplayer recovery
    buildSyncSnapshot,
    applySyncSnapshot,
  };
}
