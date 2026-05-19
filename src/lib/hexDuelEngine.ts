"use client";

import { useCallback, useMemo, useState } from "react";
import type { HexTileData } from "../components/HexTile";
import { GRID_SIZE, getHexNeighbors } from "./hexGridUtils";
import { checkWinCondition } from "./hexWinDetection";

// ── Types ───────────────────────────────────────────────────────────────────

export type DuelPlayer = "player1" | "player2";

export interface PushTarget {
  x: number;
  y: number;
  destX: number;
  destY: number;
}

export interface HexDuelState {
  /** The visual grid (all neutral with unit overlays) */
  grid: HexTileData[][];
  /** Current position of player 1's unit */
  player1Pos: { x: number; y: number };
  /** Current position of player 2's unit */
  player2Pos: { x: number; y: number };
  /** Whose turn it is */
  currentTurn: DuelPlayer;
  /** Which player's unit is currently selected (null if none) */
  selectedUnit: DuelPlayer | null;
  /** Set of coordinates the selected unit can move to */
  validMoves: { x: number; y: number }[];
  /** Push target info (enemy hex + push destination), empty if no valid push */
  pushTargets: PushTarget[];
  /** How many moves player 1 has made */
  p1MoveCount: number;
  /** How many moves player 2 has made */
  p2MoveCount: number;
  /** Total number of moves made */
  moveCount: number;
  /** Remaining AP for the current turn */
  currentAP: number;
  /** Maximum AP per turn */
  maxAP: number;
  /** Map of "x,y" → owner for captured neutral tiles */
  capturedTiles: Record<string, DuelPlayer>;
  /** How many tiles player 1 has captured */
  p1Territory: number;
  /** How many tiles player 2 has captured */
  p2Territory: number;
  /** The winner of the match, or null if still ongoing */
  winner: DuelPlayer | null;
}

const MAX_AP = 3;
const MOVE_COST = 1;
const PUSH_COST = 2;
const HARD_AP_CAP = 5;
const POWER_NODE_COUNT = 3;

/** Choose N random tiles for power nodes, excluding spawn positions */
function generatePowerNodes(): Set<string> {
  const candidates: string[] = [];
  for (let y = 0; y < GRID_SIZE; y++) {
    for (let x = 0; x < GRID_SIZE; x++) {
      if (
        (x === INITIAL_P1.x && y === INITIAL_P1.y) ||
        (x === INITIAL_P2.x && y === INITIAL_P2.y)
      ) continue;
      candidates.push(`${x},${y}`);
    }
  }
  // Fisher-Yates shuffle and pick first N
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }
  return new Set(candidates.slice(0, POWER_NODE_COUNT));
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Creates a blank 5×5 grid with all neutral tiles */
function createBlankGrid(): HexTileData[][] {
  return Array.from({ length: GRID_SIZE }, (_, y) =>
    Array.from({ length: GRID_SIZE }, (_, x) => ({
      x,
      y,
      owner: "neutral" as const,
      troops: 0,
      shield: 0,
    }))
  );
}

/** Initial positions: P1 top-left, P2 bottom-right */
const INITIAL_P1 = { x: 0, y: 0 };
const INITIAL_P2 = { x: GRID_SIZE - 1, y: GRID_SIZE - 1 };

/** Starting territory: each player owns their spawn hex */
const INITIAL_CAPTURES: Record<string, DuelPlayer> = {
  [`${INITIAL_P1.x},${INITIAL_P1.y}`]: "player1",
  [`${INITIAL_P2.x},${INITIAL_P2.y}`]: "player2",
};

// ── Hook ────────────────────────────────────────────────────────────────────

export function useHexDuel() {
  const [player1Pos, setPlayer1Pos] = useState(INITIAL_P1);
  const [player2Pos, setPlayer2Pos] = useState(INITIAL_P2);
  const [currentTurn, setCurrentTurn] = useState<DuelPlayer>("player1");
  const [selectedUnit, setSelectedUnit] = useState<DuelPlayer | null>(null);
  const [moveCount, setMoveCount] = useState(0);
  const [p1MoveCount, setP1MoveCount] = useState(0);
  const [p2MoveCount, setP2MoveCount] = useState(0);
  const [currentAP, setCurrentAP] = useState(MAX_AP);
  const [capturedTiles, setCapturedTiles] = useState<Record<string, DuelPlayer>>(INITIAL_CAPTURES);
  const [recentlyCaptured, setRecentlyCaptured] = useState<string[]>([]);
  const [p1Territory, setP1Territory] = useState(1);
  const [p2Territory, setP2Territory] = useState(1);
  const [winner, setWinner] = useState<DuelPlayer | null>(null);
  const [pushedHere, setPushedHere] = useState<string[]>([]);
  const [powerNodes] = useState<Set<string>>(() => generatePowerNodes());

  // ── Derived state ──────────────────────────────────────────────────────

  /** Whether the current player has enough AP to move */
  const canMove = currentAP >= MOVE_COST;

  /** Whether the current player has enough AP to push */
  const canPush = currentAP >= PUSH_COST;

  const validMoves = useMemo(() => {
    if (!selectedUnit || !canMove) return [];

    const pos = selectedUnit === "player1" ? player1Pos : player2Pos;
    const enemyPos = selectedUnit === "player1" ? player2Pos : player1Pos;

    return getHexNeighbors(pos.x, pos.y).filter(
      (n) => !(n.x === enemyPos.x && n.y === enemyPos.y)
    );
  }, [selectedUnit, player1Pos, player2Pos, canMove]);

  /** When a unit is selected and the enemy is adjacent, compute the push target */
  const pushTargets = useMemo(() => {
    if (!selectedUnit || !canPush) return [];

    const myPos = selectedUnit === "player1" ? player1Pos : player2Pos;
    const enemyPos = selectedUnit === "player1" ? player2Pos : player1Pos;

    // Check if enemy is adjacent
    const isAdjacent = getHexNeighbors(myPos.x, myPos.y).some(
      (n) => n.x === enemyPos.x && n.y === enemyPos.y
    );
    if (!isAdjacent) return [];

    // Compute push destination: enemy + (enemy - player)
    const dx = enemyPos.x - myPos.x;
    const dy = enemyPos.y - myPos.y;
    const destX = enemyPos.x + dx;
    const destY = enemyPos.y + dy;

    // Validate destination: on board and not occupied by the pushing player
    if (destX < 0 || destX >= GRID_SIZE || destY < 0 || destY >= GRID_SIZE) return [];
    if (destX === myPos.x && destY === myPos.y) return [];

    return [{ x: enemyPos.x, y: enemyPos.y, destX, destY }];
  }, [selectedUnit, player1Pos, player2Pos, canPush]);

  const grid = useMemo(() => {
    const g = createBlankGrid();
    // Stamp captured territories first
    for (const [key, owner] of Object.entries(capturedTiles)) {
      const [cx, cy] = key.split(",").map(Number);
      if (g[cy]?.[cx]) {
        g[cy][cx].owner = owner;
      }
    }
    // Stamp unit positions on top (overrides captured tile colors at unit location)
    g[player1Pos.y][player1Pos.x].owner = "player1";
    g[player2Pos.y][player2Pos.x].owner = "player2";
    return g;
  }, [player1Pos, player2Pos, capturedTiles]);

  // ── Actions ────────────────────────────────────────────────────────────

  /** Derived: how many power nodes each player controls */
  const p1PowerNodes = useMemo(() => {
    let count = 0;
    for (const key of powerNodes) {
      const [px, py] = key.split(",").map(Number);
      if ((player1Pos.x === px && player1Pos.y === py) || capturedTiles[key] === "player1") {
        count++;
      }
    }
    return count;
  }, [player1Pos, capturedTiles, powerNodes]);

  const p2PowerNodes = useMemo(() => {
    let count = 0;
    for (const key of powerNodes) {
      const [px, py] = key.split(",").map(Number);
      if ((player2Pos.x === px && player2Pos.y === py) || capturedTiles[key] === "player2") {
        count++;
      }
    }
    return count;
  }, [player2Pos, capturedTiles, powerNodes]);

  const switchTurn = useCallback(
    (bonusAP = 0) => {
      setCurrentTurn((t) => (t === "player1" ? "player2" : "player1"));
      setCurrentAP(Math.min(MAX_AP + bonusAP, HARD_AP_CAP));
      setSelectedUnit(null);
    },
    []
  );

  /** Compute AP bonus for the next player (called before turn switch) */
  const getNextTurnBonus = useCallback(() => {
    const nextPlayer = currentTurn === "player1" ? "player2" : "player1";
    const nextPos = nextPlayer === "player1" ? player1Pos : player2Pos;
    let count = 0;
    for (const key of powerNodes) {
      const [px, py] = key.split(",").map(Number);
      if ((nextPos.x === px && nextPos.y === py) || capturedTiles[key] === nextPlayer) {
        count++;
      }
    }
    return count;
  }, [currentTurn, player1Pos, player2Pos, capturedTiles, powerNodes]);

  const handleTileClick = useCallback(
    (x: number, y: number) => {
      // Guard: no actions after game over
      if (winner) return;

      // Clear stale push arrival animations from previous actions
      setPushedHere([]);

      const clicked = { x, y };

      // ── Click on own unit → select it ─────────────────────────────────
      if (x === player1Pos.x && y === player1Pos.y && currentTurn === "player1") {
        if (canMove) setSelectedUnit("player1");
        return;
      }
      if (x === player2Pos.x && y === player2Pos.y && currentTurn === "player2") {
        if (canMove) setSelectedUnit("player2");
        return;
      }

      // ── Click on push target (enemy hex) → push them ─────────────────
      const pushTarget = pushTargets.find((p) => p.x === x && p.y === y);
      if (selectedUnit && pushTarget) {
        // Push the enemy unit to the destination
        // The PUSHER gets the move credit (they spent the AP)
        if (selectedUnit === "player1") {
          setPlayer2Pos({ x: pushTarget.destX, y: pushTarget.destY });
          setP1MoveCount((c) => c + 1);
        } else {
          setPlayer1Pos({ x: pushTarget.destX, y: pushTarget.destY });
          setP2MoveCount((c) => c + 1);
        }

        setMoveCount((c) => c + 1);
        setSelectedUnit(null);
        setRecentlyCaptured([]);

        // Mark the destination tile for push arrival animation
        const destKey = `${pushTarget.destX},${pushTarget.destY}`;
        setPushedHere((prev) => [...prev, destKey]);

        const newAP = currentAP - PUSH_COST;
        if (newAP <= 0) {
          // Compute bonus inline using the NEW enemy position (not stale closure)
          const nextPlayer = currentTurn === "player1" ? "player2" : "player1";
          const nextPos = { x: pushTarget.destX, y: pushTarget.destY };
          let bonus = 0;
          for (const key of powerNodes) {
            const [px, py] = key.split(",").map(Number);
            if ((nextPos.x === px && nextPos.y === py) || capturedTiles[key] === nextPlayer) {
              bonus++;
            }
          }
          switchTurn(bonus);
        } else {
          setCurrentAP(newAP);
        }
        return;
      }

      // ── Click on valid move hex → move the selected unit ──────────────
      if (
        selectedUnit &&
        validMoves.some((m) => m.x === x && m.y === y)
      ) {
        if (selectedUnit === "player1") {
          setPlayer1Pos(clicked);
          setP1MoveCount((c) => c + 1);
        } else {
          setPlayer2Pos(clicked);
          setP2MoveCount((c) => c + 1);
        }

        setMoveCount((c) => c + 1);
        setSelectedUnit(null);

        // ── Territory capture: claim neutral hexes ──────────────────
        const tileKey = `${x},${y}`;
        const isNeutral =
          !(player1Pos.x === x && player1Pos.y === y) &&
          !(player2Pos.x === x && player2Pos.y === y) &&
          !capturedTiles[tileKey];

        if (isNeutral) {
          const capturer = selectedUnit;
          setCapturedTiles((prev) => {
            const next = { ...prev, [tileKey]: capturer };
            // Check win after territory change
            const pos1 = capturer === "player1" ? clicked : player1Pos;
            const pos2 = capturer === "player2" ? clicked : player2Pos;
            const w = checkWinCondition({
              capturedTiles: next,
              player1Pos: pos1,
              player2Pos: pos2,
            });
            if (w) setWinner(w);
            return next;
          });
          setRecentlyCaptured([tileKey]);
          if (capturer === "player1") {
            setP1Territory((c) => c + 1);
          } else {
            setP2Territory((c) => c + 1);
          }
        } else {
          // Clear stale capture animations on non-capture moves
          setRecentlyCaptured([]);
        }

        const newAP = currentAP - MOVE_COST;
        if (newAP <= 0) {
          // Auto-switch turn when AP runs out
          const bonus = getNextTurnBonus();
          switchTurn(bonus);
        } else {
          setCurrentAP(newAP);
        }
        return;
      }

      // ── Clicking elsewhere deselects ──────────────────────────────────
      setSelectedUnit(null);
    },
    [
      player1Pos,
      player2Pos,
      currentTurn,
      selectedUnit,
      validMoves,
      pushTargets,
      canMove,
      currentAP,
      capturedTiles,
      switchTurn,
      winner,
      getNextTurnBonus,
    ]
  );

  const endTurn = useCallback(() => {
    if (winner) return;
    const bonus = getNextTurnBonus();
    switchTurn(bonus);
  }, [switchTurn, winner, getNextTurnBonus]);

  const resetGame = useCallback(() => {
    setPlayer1Pos(INITIAL_P1);
    setPlayer2Pos(INITIAL_P2);
    setCurrentTurn("player1");
    setSelectedUnit(null);
    setMoveCount(0);
    setP1MoveCount(0);
    setP2MoveCount(0);
    setCurrentAP(MAX_AP);
    setCapturedTiles(INITIAL_CAPTURES);
    setRecentlyCaptured([]);
    setP1Territory(1);
    setP2Territory(1);
    setWinner(null);
    setPushedHere([]);
  }, []);

  // ── Selected tile coordinates (for HexBoard) ──────────────────────────
  const selectedTile = useMemo(() => {
    if (!selectedUnit) return null;
    return selectedUnit === "player1" ? player1Pos : player2Pos;
  }, [selectedUnit, player1Pos, player2Pos]);

  const state: HexDuelState = {
    grid,
    player1Pos,
    player2Pos,
    currentTurn,
    selectedUnit,
    validMoves,
    pushTargets,
    p1MoveCount,
    p2MoveCount,
    moveCount,
    currentAP,
    maxAP: MAX_AP,
    capturedTiles,
    p1Territory,
    p2Territory,
    winner,
  };

  return {
    ...state,
    selectedTile,
    canMove,
    canPush,
    recentlyCaptured,
    pushedHere,
    powerNodes,
    p1PowerNodes,
    p2PowerNodes,
    handleTileClick,
    endTurn,
    resetGame,
  };
}
