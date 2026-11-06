// src/lib/battleship/seats.ts
//
// PURE seat / phase authorization for Battleship online.
//
// Every protected operation in the store answers the same three questions, and
// they are answered HERE so they are testable without a database:
//
//   1. WHO IS CALLING?  `seatForUser` maps an AUTHENTICATED user id onto a seat.
//      A user id is only ever taken from the Clerk gate — never from a request
//      body — so a forged player id cannot buy a seat.
//   2. MAY THEY JOIN THIS LOBBY?  `canJoinLobby` refuses the host's own lobby
//      (nobody may play themselves), a lobby that already has two seats, and a
//      lobby that has left the waiting phase.
//   3. MAY THEY ACT ON THIS MATCH?  `requireSeat` is the 403 for a non-player;
//      `canConfirmFleet` adds the phase rules (no placement before an opponent
//      exists, no placement once combat has begun), and `canCancelMatch` keeps
//      cancellation to the host of a still-waiting lobby.
//
// PHASE IS NEVER CLIENT INPUT. Every function here takes the phase the STORE
// read from the row and returns a verdict; nothing accepts a phase, a winner or
// a "ready" flag from a caller.

import { MATCH_PHASE } from "./constants";
import type { Seat } from "./types";

/** The five Battleship match phases. */
export type MatchPhase = (typeof MATCH_PHASE)[keyof typeof MATCH_PHASE];

/** The two seats of a row: `player2Id` is null while the row is an open lobby. */
export interface Seats {
  readonly player1Id: string;
  readonly player2Id: string | null;
}

/** A caller resolved to a seat, or an HTTP-shaped refusal. */
export type Access =
  | { readonly ok: true; readonly seat: Seat }
  | { readonly ok: false; readonly status: number; readonly message: string };

/** Which seat a user holds, or null when they hold none. */
export function seatForUser(seats: Seats, userId: string | null | undefined): Seat | null {
  if (!userId) return null;
  if (userId === seats.player1Id) return "player1";
  if (seats.player2Id && userId === seats.player2Id) return "player2";
  return null;
}

/** True when the user holds either seat. */
export function isParticipant(seats: Seats, userId: string | null | undefined): boolean {
  return seatForUser(seats, userId) !== null;
}

/**
 * Resolves the caller to a seat or refuses with 403. Every read and mutation on
 * a match starts here, which is what makes a cross-match read impossible.
 */
export function requireSeat(seats: Seats, userId: string | null | undefined): Access {
  const seat = seatForUser(seats, userId);
  if (!seat) {
    return { ok: false, status: 403, message: "You are not a player in this match" };
  }
  return { ok: true, seat };
}

/** Why a lobby cannot be joined, or that it can. */
export type JoinVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "self" | "taken" | "not-open";
      readonly status: number;
      readonly message: string;
    };

/**
 * May this user take the open second seat?
 *
 * The self-check is deliberate rather than incidental: the host's own lobby is
 * returned to the host as "your lobby" by the store, and this is what guarantees
 * that a host can never be seated against themselves even if a future caller
 * skips that branch.
 */
export function canJoinLobby(match: Seats & { readonly phase: string }, userId: string): JoinVerdict {
  if (match.phase !== MATCH_PHASE.WAITING) {
    return { ok: false, reason: "not-open", status: 409, message: "Match is no longer available" };
  }
  if (match.player2Id) {
    return { ok: false, reason: "taken", status: 409, message: "Match already has both players" };
  }
  if (match.player1Id === userId) {
    return { ok: false, reason: "self", status: 409, message: "You cannot join your own lobby" };
  }
  return { ok: true };
}

/**
 * The phase a match is in, given which fleets are confirmed. This is the ONLY
 * place the placement → combat transition is decided, and it takes booleans the
 * STORE read from the row — a client cannot send "both fleets are ready".
 */
export function phaseForFleetReadiness(player1Ready: boolean, player2Ready: boolean): MatchPhase {
  return player1Ready && player2Ready ? MATCH_PHASE.COMBAT : MATCH_PHASE.PLACEMENT;
}

export type FleetVerdict =
  | { readonly ok: true; readonly seat: Seat }
  | { readonly ok: false; readonly status: number; readonly message: string };

/**
 * May this user confirm a fleet for this match?
 *
 * Placement is only legal in the PLACEMENT phase, which exists only after the
 * second seat is filled — so an attack can never be attempted (let alone
 * accepted) before BOTH fleets have been validated and the store has moved the
 * match to COMBAT.
 */
export function canConfirmFleet(input: {
  readonly phase: string;
  readonly seats: Seats;
  readonly userId: string;
}): FleetVerdict {
  const access = requireSeat(input.seats, input.userId);
  if (access.ok === false) return access;

  if (isTerminalPhase(input.phase)) {
    return { ok: false, status: 409, message: "This match is over" };
  }
  if (input.phase === MATCH_PHASE.WAITING) {
    return { ok: false, status: 409, message: "Wait for an opponent before placing your fleet" };
  }
  if (input.phase === MATCH_PHASE.COMBAT) {
    return { ok: false, status: 409, message: "Combat has already begun" };
  }
  if (input.phase !== MATCH_PHASE.PLACEMENT) {
    return { ok: false, status: 409, message: "This match is not accepting fleets" };
  }
  return { ok: true, seat: access.seat };
}

export type CancelVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: number; readonly message: string };

/**
 * May this user lock an attack in the CURRENT round?
 *
 * The match must be in COMBAT — which the store only ever sets after BOTH fleets
 * have been validated — and the seat must not already have a lock for this
 * round. The round number comes from the row, never from the request, so a
 * client cannot pick which round it is attacking into.
 */
export type AttackVerdict =
  | { readonly ok: true; readonly seat: Seat }
  | { readonly ok: false; readonly status: number; readonly message: string; readonly code: string };

export function canSubmitAttack(input: {
  readonly phase: string;
  readonly seats: Seats;
  readonly userId: string;
  readonly round: number;
  readonly locked: Record<Seat, boolean>;
}): AttackVerdict {
  const access = requireSeat(input.seats, input.userId);
  if (access.ok === false) {
    return { ok: false, status: access.status, message: access.message, code: "not_a_player" };
  }
  if (isTerminalPhase(input.phase)) {
    return { ok: false, status: 409, message: "This match is over", code: "match_finished" };
  }
  if (input.phase !== MATCH_PHASE.COMBAT) {
    return { ok: false, status: 409, message: "The match is not in combat", code: "wrong_phase" };
  }
  if (!Number.isInteger(input.round) || input.round < 1) {
    return { ok: false, status: 409, message: "The round is not open", code: "invalid_round" };
  }
  if (input.locked[access.seat]) {
    return {
      ok: false,
      status: 409,
      message: "Your attack is already locked for this round",
      code: "attack_locked",
    };
  }
  return { ok: true, seat: access.seat };
}

/** Only the host may cancel, and only while the lobby is still waiting. */
export function canCancelMatch(input: {
  readonly phase: string;
  readonly seats: Seats;
  readonly userId: string;
}): CancelVerdict {
  const access = requireSeat(input.seats, input.userId);
  if (access.ok === false) return access;
  if (access.seat !== "player1") {
    return { ok: false, status: 403, message: "Only the host can cancel this lobby" };
  }
  if (input.phase !== MATCH_PHASE.WAITING) {
    return { ok: false, status: 409, message: "Only a waiting lobby can be cancelled" };
  }
  return { ok: true };
}

export type ResignVerdict =
  | { readonly ok: true; readonly seat: Seat }
  | { readonly ok: false; readonly status: number; readonly message: string };

/**
 * May this user resign this match?
 *
 * Resignation is a LIVE-MATCH action: a waiting lobby is cancelled through the
 * lobby route, a settled match accepts nothing, and practice is left through
 * the practice UI rather than touching a ranked-looking settlement path. The
 * winner is always derived by the store from the caller's seat.
 */
export function canResign(input: {
  readonly phase: string;
  readonly seats: Seats;
  readonly userId: string;
  readonly isAi?: boolean;
}): ResignVerdict {
  const access = requireSeat(input.seats, input.userId);
  if (access.ok === false) return access;
  if (isTerminalPhase(input.phase)) {
    return { ok: false, status: 409, message: "This match is over" };
  }
  if (input.isAi === true) {
    return { ok: false, status: 409, message: "Practice matches cannot be resigned" };
  }
  if (input.phase === MATCH_PHASE.WAITING) {
    return { ok: false, status: 409, message: "There is no active match to resign" };
  }
  if (input.phase !== MATCH_PHASE.PLACEMENT && input.phase !== MATCH_PHASE.COMBAT) {
    return { ok: false, status: 409, message: "This match cannot be resigned" };
  }
  return { ok: true, seat: access.seat };
}

/** FINISHED and CANCELLED accept nothing further. */
export function isTerminalPhase(phase: string | null | undefined): boolean {
  return phase === MATCH_PHASE.FINISHED || phase === MATCH_PHASE.CANCELLED;
}

/** True when the match is live and both fleets are confirmed (combat is open). */
export function isCombatPhase(phase: string | null | undefined): boolean {
  return phase === MATCH_PHASE.COMBAT;
}
