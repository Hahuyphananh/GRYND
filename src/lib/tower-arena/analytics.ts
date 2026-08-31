// src/lib/tower-arena/analytics.ts
//
// Centralized server-side PostHog events for Tower Arena. Event names and
// safe property shaping live here so the store never hand-rolls capture
// calls (no duplicated / divergent analytics across routes).
//
// SECURITY: only non-sensitive, aggregate-friendly properties are emitted
// here — player count, wager tier, whether the match was free play, and a
// placement. We never log balances, exact internal settlement figures,
// private reserve contents, or any per-user sensitive data.

import { captureServerEvent } from "../analytics-server";

type SafeProps = Record<string, unknown>;

function fire(event: string, distinctId: string, properties: SafeProps) {
  captureServerEvent({ event, distinctId, properties });
}

/** A match transitioned from waiting → active. */
export function towerArenaStarted(args: {
  distinctId: string;
  matchId: string;
  maxPlayers: number;
  wager: number;
  isAi: boolean;
}) {
  fire("tower_arena_started", args.distinctId, {
    match_id: args.matchId,
    player_count: args.maxPlayers,
    wager: args.wager,
    lobby_type: args.isAi ? "ai_freeplay" : "pvp",
  });
}

/** A human placed a block (voluntary action). */
export function towerArenaBlockPlaced(args: {
  distinctId: string;
  matchId: string;
  turnNumber: number;
  collapsed: boolean;
  isAi: boolean;
}) {
  fire("tower_arena_block_placed", args.distinctId, {
    match_id: args.matchId,
    turn_number: args.turnNumber,
    collapsed: args.collapsed,
    lobby_type: args.isAi ? "ai_freeplay" : "pvp",
  });
}

/** The current player timed out and received the deterministic fallback. */
export function towerArenaTimeout(args: {
  distinctId: string;
  matchId: string;
  isAi: boolean;
}) {
  fire("tower_arena_timeout", args.distinctId, {
    match_id: args.matchId,
    lobby_type: args.isAi ? "ai_freeplay" : "pvp",
  });
}

/** The tower collapsed on a placement. */
export function towerArenaCollapse(args: {
  distinctId: string;
  matchId: string;
  maxPlayers: number;
  isAi: boolean;
}) {
  fire("tower_arena_collapse", args.distinctId, {
    match_id: args.matchId,
    player_count: args.maxPlayers,
    lobby_type: args.isAi ? "ai_freeplay" : "pvp",
  });
}

/** A player was eliminated (collapse, resign, or disconnect forfeit). */
export function towerArenaEliminated(args: {
  distinctId: string;
  matchId: string;
  placement: number;
  reason: "collapse" | "resign" | "disconnect";
  maxPlayers: number;
}) {
  fire("tower_arena_eliminated", args.distinctId, {
    match_id: args.matchId,
    placement: args.placement,
    reason: args.reason,
    player_count: args.maxPlayers,
  });
}

/** A match finished; settlement ran (winner-visible placement only). */
export function towerArenaFinished(args: {
  distinctId: string;
  matchId: string;
  maxPlayers: number;
  wager: number;
  isAi: boolean;
}) {
  fire("tower_arena_finished", args.distinctId, {
    match_id: args.matchId,
    player_count: args.maxPlayers,
    wager: args.wager,
    lobby_type: args.isAi ? "ai_freeplay" : "pvp",
  });
}