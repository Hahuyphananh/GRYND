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

/** Core game state managed by the reducer. */
export interface CoreState {
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
      type: "endTurn";
      player: DuelPlayer;
      /** When true, skip troop growth (the caller already applied it). */
      skipTroopGrowth: boolean;
    }
  | { type: "troopGrowth"; player: DuelPlayer }
  | { type: "reset" }
  | { type: "syncSnapshot"; snapshot: CoreState };

/** The four move types a player can send over the wire. */
export type HexDuelMoveType = "attack" | "displace" | "endTurn" | "skipRound";

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

export const MAX_AP = 3;
export const REINFORCE_COST = 1; // reused for displace
export const ATTACK_COST = 1;
export const DISPLACE_COST = 1;

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
export function makeInitialCore(): CoreState {
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
//                keeps at least 1 troop, which is why `maxTroops = troops - 1`
//                in the engine's displace picker).
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

  if (move.type === "endTurn" || move.type === "skipRound") return { ok: true };

  const cost = move.type === "attack" ? ATTACK_COST : DISPLACE_COST;
  if (state.currentAP < cost) {
    return {
      ok: false,
      code: "NO_ACTION_POINTS",
      error: `Not enough action points (${state.currentAP} left)`,
    };
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
 * uses to replay a match it stored.
 *
 * This is deliberately not the same entry point as `coreReducer`: it mirrors
 * `applyRemoteAction` in the engine, including its idempotency guard for turn
 * flips. A client that depleted its action points auto-flipped its own turn AND
 * echoes an explicit `endTurn`, and the receiver ignores that echo because it
 * has already advanced past the sender. The server must ignore it too, or its
 * replay would flip the turn twice and drift away from both boards.
 *
 * Returns the state unchanged for a move it cannot apply (missing fields, or an
 * endTurn echo), so a replay can never throw on a malformed row.
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
    case "endTurn":
    case "skipRound": {
      // Already past this seat's turn — the flip was mirrored by the move that
      // emptied its action points, so this echo is a no-op.
      if (state.currentTurn === otherPlayer(seat)) return state;
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

