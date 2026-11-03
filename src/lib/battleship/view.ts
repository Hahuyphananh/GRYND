// src/lib/battleship/view.ts
//
// Client-safe types and labels for the Battleship screen. Deliberately has NO
// database import and NO opponent-fleet field: it is the shape the API returns,
// nothing more.
//
// A snapshot can carry exactly one fleet — the VIEWER'S OWN (`fleet` and
// `combat.you.fleet`). `combat.opponent` is the engine's public projection
// (board, attack log, destroyed ships) and has no `fleet` property at all.

import type { Fleet, MatchView, Seat } from "./types";

export interface SeatIdentity {
  readonly name?: string | null;
  readonly iconKey?: string | null;
  readonly nameColor?: string | null;
  readonly isGuest?: boolean;
}

export interface SnapshotPending {
  readonly round: number;
  readonly youLocked: boolean;
  readonly opponentLocked: boolean;
  readonly yourCoordinate: string | null;
}

export interface MatchSnapshot {
  readonly matchId: string;
  readonly phase: string;
  readonly round: number;
  readonly seats: { readonly player1Id: string; readonly player2Id: string | null };
  readonly you: {
    readonly seat: Seat;
    readonly ready: boolean;
    readonly timeouts: number;
  };
  readonly opponent: {
    readonly seat: Seat;
    readonly ready: boolean;
    readonly timeouts: number;
    readonly joined: boolean;
  };
  readonly deadlines: { readonly placement: string | null; readonly round: string | null };
  readonly result: string | null;
  /** True for a free practice match against the built-in bot. */
  readonly isAi?: boolean;
  /** The bot's `easy | normal | hard` tier on a practice match, else null. */
  readonly aiDifficulty?: string | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly createdAt: string;
  readonly fleet: { readonly ships: Fleet["ships"] } | null;
  readonly combat: MatchView | null;
  readonly pending: SnapshotPending | null;
  readonly players?: {
    readonly player1: SeatIdentity | null;
    readonly player2: SeatIdentity | null;
  } | null;
}

/** A resolved round, as published by the attack route and its socket event. */
export interface ResolvedRound {
  readonly round: number;
  readonly attacks: Record<Seat, { coordinate: string; result: string; ship: string | null }>;
  readonly destroyed: Record<Seat, boolean>;
  readonly outcome: string | null;
  readonly nextRound: number | null;
  readonly roundDeadline: string | null;
}

/** True when this snapshot is a practice match, however old the payload. */
export function isAiMatch(snapshot: MatchSnapshot | null): boolean {
  return snapshot?.isAi === true;
}

/** The opponent's display name, falling back to a neutral label. */
export function opponentNameFor(snapshot: MatchSnapshot | null): string {
  if (!snapshot) return "Opponent";
  const identity = snapshot.players ? snapshot.players[snapshot.opponent.seat] : null;
  const name = identity?.name;
  return typeof name === "string" && name.trim() !== "" ? name.trim() : "Opponent";
}

/** WIN / LOSS / DRAW from the viewer's seat, or null while the match runs. */
export function seatResultLabel(
  result: string | null | undefined,
  seat: Seat,
): "Victory" | "Defeat" | "Draw" | null {
  if (!result) return null;
  if (result === "draw") return "Draw";
  return result === seat ? "Victory" : "Defeat";
}

/** Whole seconds left until an ISO deadline (never negative). */
export function secondsRemaining(deadline: string | null | undefined, now = Date.now()): number {
  if (!deadline) return 0;
  const at = new Date(deadline).getTime();
  if (!Number.isFinite(at)) return 0;
  return Math.max(0, Math.ceil((at - now) / 1000));
}

/** True when this snapshot is a finished or cancelled match. */
export function isMatchOver(phase: string | null | undefined): boolean {
  return phase === "finished" || phase === "cancelled";
}
