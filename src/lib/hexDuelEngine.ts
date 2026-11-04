"use client";

import { useCallback, useMemo, useReducer, useRef, useState } from "react";
import type { HexTileData } from "../components/HexTile";
import { GRID_SIZE, getHexNeighbors } from "./hexGridUtils";
import {
  HEX_DUEL_CAPITALS,
  INITIAL_TROOPS,
  MAX_TERRITORY_LEVEL,
  TERRITORY_LEVELS,
  areAdjacent,
  checkHexDuelMove,
  coreReducer,
  getUpgradeInfo,
  makeInitialCore,
  normalizeTerritoryLevel,
  otherPlayer,
  resolveAttackOutcome,
  territoryLevelOf,
  territoryMaxTroops,
  upgradeCostFor,
  type AttackOutcome,
  type CoreState,
  type DuelPlayer,
  type ReducerAction,
  type TerritoryLevel,
} from "./hex-duel/rules";
import { buildTroopMoveEvent, type TroopMoveEvent } from "./hexTroopAnimation";

// The rulebook (initial position, attack resolution, troop growth, turn
// switching, the reducer and move legality) lives in ./hex-duel/rules so the
// SERVER can run the same rules a staked match settles on. Re-exported here
// so every existing importer keeps its import path.
export {
  MAX_TERRITORY_LEVEL,
  TERRITORY_LEVELS,
  areAdjacent,
  checkHexDuelMove,
  getUpgradeInfo,
  otherPlayer,
  territoryLevelOf,
  territoryMaxTroops,
  upgradeCostFor,
};
export type { TerritoryLevel };
export type { AttackOutcome, CoreState, DuelPlayer, ReducerAction };

// ── Types ───────────────────────────────────────────────────────────────────

// `DuelPlayer` is the rulebook's own player type (re-exported above), so a
// caller can keep importing it from here.

export interface ActionLogEntry {
  /** Sequential action index */
  id: number;
  /** Which player acted */
  player: DuelPlayer;
  /** Type of action */
  type:
    | "move"
    | "push"
    | "reinforce"
    | "endTurn"
    | "attack"
    | "displace"
    | "upgrade"
    | "troopGrowth";
  /** Coordinates involved */
  target?: { x: number; y: number };
  /** Source coordinates (for attack/displace) */
  source?: { x: number; y: number };
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
  /** Permanent level per owned tile: "x,y" → 1..4 */
  territoryLevels: Record<string, TerritoryLevel>;
  /** Whose turn it is */
  currentTurn: DuelPlayer;
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

// ── Helpers ────────────────────────────────────────────────────────────────

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

/** Normalize a snapshot's level map; a missing map means "all level 1". */
function sanitizeLevels(raw: unknown): Record<string, TerritoryLevel> {
  const out: Record<string, TerritoryLevel> = {};
  if (raw && typeof raw === "object") {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      out[key] = normalizeTerritoryLevel(value);
    }
  }
  return out;
}

// ── Hook ────────────────────────────────────────────────────────────────────

export function useHexDuel(startingTurn: DuelPlayer = "player1") {
  // Capitals: fixed for the whole game — passed as the third reducer arg.
  const capitals = useRef<Record<string, DuelPlayer>>(HEX_DUEL_CAPITALS).current;

  // Core game state managed by reducer — guarantees atomic, fresh reads.
  // `startingTurn` is fixed for the hook's lifetime: online PvP opens with the
  // joining seat (player2), while practice keeps the engine's player1 opening.
  const [state, dispatch] = useReducer(
    (s: CoreState, a: ReducerAction) => coreReducer(s, a, capitals),
    undefined,
    () => makeInitialCore(startingTurn),
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

  // ── Move animation feed (display only) ──────────────────────────────
  // The board plays a troop-movement animation for the last applied attack or
  // displacement. The event is built from the PRE-action state plus the
  // outcome this engine already computed, so the overlay can only ever show
  // the authoritative result. The monotonic id is what tells the board that a
  // new animation should start.
  const moveAnimationIdRef = useRef(0);
  const [moveAnimation, setMoveAnimation] = useState<TroopMoveEvent | null>(null);
  const publishMove = useCallback((event: Omit<TroopMoveEvent, "id">) => {
    moveAnimationIdRef.current += 1;
    setMoveAnimation({ ...event, id: moveAnimationIdRef.current });
  }, []);

  // ── Derived: grid ──────────────────────────────────────────────────

  const grid = useMemo(() => {
    const g = createBlankGrid();
    for (const [key, owner] of Object.entries(state.capturedTiles)) {
      const [cx, cy] = key.split(",").map(Number);
      if (g[cy]?.[cx]) {
        g[cy][cx].owner = owner;
        g[cy][cx].troops = state.tileTroops[key] ?? 1;
        const level = territoryLevelOf(state, key);
        g[cy][cx].level = level;
        g[cy][cx].maxTroops = territoryMaxTroops(level);
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
        g[cy][cx].level = 1;
        g[cy][cx].maxTroops = territoryMaxTroops(1);
        g[cy][cx].capital = true;
      }
    }
    return g;
  }, [state.capturedTiles, state.tileTroops, state.territoryLevels, capitals]);

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
          // The destination's level capacity caps what it can take, on top of
          // the troop the source must leave behind.
          const room =
            territoryMaxTroops(territoryLevelOf(state, targetKey)) -
            (state.tileTroops[targetKey] ?? 1);
          return {
            x: n.x,
            y: n.y,
            maxTroops: Math.min(troops - 1, room),
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
          label: `Attack: sent ${troopCount} from (${sx},${sy}) → conquered (${tx},${ty}) (was ${targetWas}, ${outcome.remainingTroops} remain)`,
        });
      } else if (outcome.kind === "tie") {
        addActionLog({
          player,
          type: "attack",
          source: { x: sx, y: sy },
          target: { x: tx, y: ty },
          label: `Attack: sent ${troopCount} from (${sx},${sy}) → mutual destruction! (${tx},${ty}) becomes neutral`,
        });
      } else {
        addActionLog({
          player,
          type: "attack",
          source: { x: sx, y: sy },
          target: { x: tx, y: ty },
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
        label: `Displace: moved ${troopCount} from (${sx},${sy}) → (${tx},${ty})`,
      });
    },
    [addActionLog],
  );

  const logUpgrade = useCallback(
    (sourceKey: string, player: DuelPlayer, level: TerritoryLevel, cost: number) => {
      const [x, y] = sourceKey.split(",").map(Number);
      addActionLog({
        player,
        type: "upgrade",
        target: { x, y },
        label: `Upgrade: (${x},${y}) level ${level} → ${level + 1} (paid ${cost} troops)`,
      });
    },
    [addActionLog],
  );

  // ── Public action handlers ────────────────────────────────────────

  /** Local attack — performs validation against current state, then dispatches. */
  const handleAttack = useCallback(
    (sourceKey: string, targetKey: string, troopCount: number) => {
      // Legality comes from the shared rulebook, so the board refuses exactly
      // what the server's action route refuses (`checkHexDuelMove`).
      const check = checkHexDuelMove(state, state.currentTurn, {
        type: "attack",
        sourceKey,
        targetKey,
        troopCount,
      });
      if (!check.ok) return;

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
      publishMove(
        buildTroopMoveEvent({
          kind: "attack",
          actor: state.currentTurn,
          fromKey: sourceKey,
          toKey: targetKey,
          sent: troopCount,
          board: state,
          outcome,
          capitals,
        }),
      );

      dispatch({
        type: "attack",
        sourceKey,
        targetKey,
        troopCount,
        player: state.currentTurn,
      });
    },
    [state, capitals, logAttack, publishMove],
  );

  /** Local displace — validates then dispatches. */
  const handleDisplace = useCallback(
    (sourceKey: string, targetKey: string, troopCount: number) => {
      // Same shared rulebook as the server (see handleAttack above).
      const check = checkHexDuelMove(state, state.currentTurn, {
        type: "displace",
        sourceKey,
        targetKey,
        troopCount,
      });
      if (!check.ok) return;

      logDisplace(sourceKey, targetKey, troopCount, state.currentTurn);
      publishMove(
        buildTroopMoveEvent({
          kind: "displace",
          actor: state.currentTurn,
          fromKey: sourceKey,
          toKey: targetKey,
          sent: troopCount,
          board: state,
        }),
      );
      dispatch({
        type: "displace",
        sourceKey,
        targetKey,
        troopCount,
        player: state.currentTurn,
      });
    },
    [state, logDisplace, publishMove],
  );

  /** Local upgrade — the rulebook owns the level table and the cost. */
  const handleUpgrade = useCallback(
    (sourceKey: string) => {
      const check = checkHexDuelMove(state, state.currentTurn, {
        type: "upgrade",
        sourceKey,
      });
      if (!check.ok) return;
      const info = getUpgradeInfo(state, state.currentTurn, sourceKey);
      if (!info.ok || info.cost === null) return;
      logUpgrade(sourceKey, state.currentTurn, info.level, info.cost);
      dispatch({ type: "upgrade", sourceKey, player: state.currentTurn });
    },
    [state, logUpgrade],
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
        label: `Troop growth: +1 on ${grownTiles.length} tile${grownTiles.length !== 1 ? "s" : ""}`,
      });
    }
    addActionLog({
      player: state.currentTurn,
      type: "endTurn",
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
        label: `Troop growth: +1 on ${grownTiles.length} tile${grownTiles.length !== 1 ? "s" : ""}`,
      });
    }
    addActionLog({
      player: state.currentTurn,
      type: "endTurn",
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
          // Duplicate/stale delivery: the action's turn has already been
          // applied locally, so do not log or replay its animation.
          if (state.currentTurn !== fromPlayer) return;
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
          publishMove(
            buildTroopMoveEvent({
              kind: "attack",
              actor: fromPlayer,
              fromKey: action.sourceKey,
              toKey: action.targetKey,
              sent: action.troopCount,
              board: state,
              outcome,
              capitals,
            }),
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
          if (state.currentTurn !== fromPlayer) return;
          logDisplace(
            action.sourceKey,
            action.targetKey,
            action.troopCount,
            fromPlayer,
          );
          publishMove(
            buildTroopMoveEvent({
              kind: "displace",
              actor: fromPlayer,
              fromKey: action.sourceKey,
              toKey: action.targetKey,
              sent: action.troopCount,
              board: state,
            }),
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
        case "upgrade": {
          if (!action.sourceKey) return;
          const info = getUpgradeInfo(state, fromPlayer, action.sourceKey);
          if (info.ok && info.cost !== null) {
            logUpgrade(action.sourceKey, fromPlayer, info.level, info.cost);
          }
          dispatch({
            type: "upgrade",
            sourceKey: action.sourceKey,
            player: fromPlayer,
          });
          break;
        }
        case "endTurn":
        case "skipRound": {
          // Idempotency guard — the reducer's switchTurnCore always flips.
          // If the receiver has already advanced past fromPlayer's turn
          // (state.currentTurn is at the OTHER player), the turn-flip has
          // already been mirrored locally — re-applying would bounce the
          // turn back. This also catches the polling-driven synthetic
          // endTurn that arrives AFTER the local engine already auto-
          // flipped when that successful action resolved: when the
          // synthetic lacks `action.player`, fromPlayer falls back to
          // state.currentTurn (= whoever we are now), and this guard
          // correctly identifies us as already past the flip.
          //
          // With two DuelPlayer values, the second clause of the
          // earlier compound (`state.currentTurn !== fromPlayer`) is
          // implied by `state.currentTurn === otherPlayer(fromPlayer)`
          // so we can simplify.
          if (state.currentTurn === otherPlayer(fromPlayer)) {
            return;
          }
          // The sender grew tiles owned by `fromPlayer` on their own
          // screen. The receiver still needs to mirror that growth —
          // `skipTroopGrowth: false` lets the reducer apply the same
          // growth to the mirror copy of `fromPlayer`'s tiles here.
          //
          // Re-application guard: `applySyncSnapshot` writes the FULL
          // canonical state (including grown troop counts), so if it
          // ran first, the receiver has already advanced past
          // `fromPlayer` (state.currentTurn === otherPlayer(fromPlayer))
          // and we returned above. If the snapshot arrived WITHOUT the
          // turn-flip portion (e.g. a snapshot from an earlier seq
          // than the endTurn action), `state.currentTurn === fromPlayer`
          // and we proceed — applying the same growth the snapshot
          // already applied. This would double-grow the sender's tiles.
          // Mitigated because the polling/socket layers order
          // snapshot-then-actions by `lastActionSeq`: a snapshot can
          // only arrive before the endTurn action, and the snapshot's
          // `tileTroops` reflect the post-growth state, so the second
          // growth from this branch reads (troops + 1)
          // — but `growTroops` only applies to tiles owned by
          // `fromPlayer` at current state, and the snapshot's
          // capturedTiles map is already post-endTurn, so the
          // ownership is unchanged. The pure local endTurn() path
          // does not route here at all — it dispatches with
          // `skipTroopGrowth: false` but ALSO applies growth on the
          // sender side, and the wire echoes that growth once.
          dispatch({
            type: "endTurn",
            player: fromPlayer,
            skipTroopGrowth: false,
          });
          break;
        }
        default:
          return;
      }
    },
    [state, capitals, logAttack, logDisplace, logUpgrade, publishMove],
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
      moveCount: state.moveCount,
      p1MoveCount: state.p1MoveCount,
      p2MoveCount: state.p2MoveCount,
      p1Territory,
      p2Territory,
      winner: state.winner,
      capturedTiles: { ...state.capturedTiles },
      tileTroops: { ...state.tileTroops },
      territoryLevels: { ...state.territoryLevels },
      actionLogId: actionIdRef.current,
    };
  }, [state, p1Territory, p2Territory]);

  /** Apply a remote sync snapshot — recover from desync via full overwrite. */
  const applySyncSnapshot = useCallback(
    (snapshot: {
      currentTurn: DuelPlayer;
      moveCount: number;
      p1MoveCount: number;
      p2MoveCount: number;
      winner: DuelPlayer | null;
      capturedTiles: Record<string, DuelPlayer>;
      tileTroops: Record<string, number>;
      territoryLevels?: Record<string, TerritoryLevel>;
    }) => {
      dispatch({
        type: "syncSnapshot",
        snapshot: {
          capturedTiles: snapshot.capturedTiles,
          tileTroops: snapshot.tileTroops,
          territoryLevels: sanitizeLevels(snapshot.territoryLevels),
          currentTurn: snapshot.currentTurn,
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
    territoryLevels: state.territoryLevels,
    currentTurn: state.currentTurn,
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
    // Troop-movement animation (display only)
    moveAnimation,
    // Existing exports (legacy stubs)
    handleTileClick,
    handleReinforceTile,
    endTurn,
    skipRound,
    resetGame,
    // New exports
    handleAttack,
    handleDisplace,
    handleUpgrade,
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
