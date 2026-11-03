// src/lib/battleship/combat.ts
//
// PERSISTENCE ↔ ENGINE glue for simultaneous combat — pure, no I/O.
//
// The rules engine (`./rules`) only ever sees a complete `PrivateMatchState`,
// while the database stores a match ROW plus an append-only ATTACK LOG. This
// module converts between the two, and it is the only place that does:
//
//   * `buildMatchState` rebuilds the engine state from the stored logs. A pending
//     attack (result NULL) is NOT part of the state: it is a lock, not yet a
//     shot. Both logs are therefore always the same length, which is exactly the
//     invariant `resolveRound` requires.
//   * `expectedRound` is the round the logs say is open. The store compares it
//     with the row before resolving, so a stale round can never be written.
//   * `fleetDamage` turns the incoming attack log into per-cell damage for the
//     viewer's OWN fleet — the only place a ship's damage is derived, so the
//     board and the fleet panel can never disagree.
//
// NOTHING HERE KNOWS ABOUT THE OPPONENT'S HIDDEN FLEET EXCEPT `fleetDamage`,
// which is only called with the viewer's own fleet and the shots fired at it.

import { MATCH_OUTCOME, SEATS, SHIP_KEYS } from "./constants";
import { fleetDestroyed, formatCoordinate, shipCells, validateMatchState } from "./rules";
import type {
  AttackRecord,
  Fleet,
  MatchOutcome,
  PrivateMatchState,
  Seat,
  ShipKey,
  ShotResult,
} from "./types";

/** One row of `battleship_attacks`. `result` is NULL while an attack is locked. */
export interface PersistedAttack {
  readonly round: number;
  /** `player1` / `player2`; typed loosely because the column is a plain varchar. */
  readonly seat: string;
  readonly coordinate: string;
  readonly result: string | null;
  readonly ship: string | null;
  /** true when the server chose this cell after the 15 s deadline. */
  readonly automatic?: boolean;
}

/** The locked attack of one seat for one round, or null. */
export function attackForRound(
  attacks: readonly PersistedAttack[],
  round: number,
  seat: Seat,
): PersistedAttack | null {
  return attacks.find((attack) => attack.round === round && attack.seat === seat) ?? null;
}

/** Which seats have locked their attack for a round. */
export function roundLocked(
  attacks: readonly PersistedAttack[],
  round: number,
): Record<Seat, boolean> {
  return {
    player1: Boolean(attackForRound(attacks, round, "player1")),
    player2: Boolean(attackForRound(attacks, round, "player2")),
  };
}

/** The resolved attack log of one seat, in round order. */
export function resolvedRecords(
  attacks: readonly PersistedAttack[],
  seat: Seat,
): AttackRecord[] {
  return attacks
    .filter((attack) => attack.seat === seat && attack.result)
    .slice()
    .sort((a, b) => a.round - b.round)
    .map((attack) => ({
      round: attack.round,
      seat,
      coordinate: attack.coordinate,
      result: attack.result as ShotResult,
      ship: (attack.ship as ShipKey | null) ?? null,
    }));
}

/**
 * The round the resolved logs leave open: one past the last resolved round.
 * A locked-but-unresolved round does not move it, because both seats resolve
 * together.
 */
export function expectedRound(attacks: readonly PersistedAttack[]): number {
  const rounds = attacks.filter((attack) => attack.result).map((attack) => attack.round);
  return (rounds.length > 0 ? Math.max(...rounds) : 0) + 1;
}

/**
 * Rebuilds the engine state from persisted fleets and the RESOLVED attack log.
 *
 * The outcome is DERIVED from the boards (never passed in), so a finished match
 * re-reads as finished and a running one cannot claim a result. Returns null
 * when the stored log is not a legal match — the store turns that into a 409
 * rather than guessing.
 */
export function buildMatchState(input: {
  readonly round: number;
  readonly fleets: Record<Seat, Fleet>;
  readonly attacks: readonly PersistedAttack[];
}): PrivateMatchState | null {
  const players = {} as Record<Seat, { seat: Seat; fleet: Fleet; attacks: AttackRecord[] }>;
  for (const seat of SEATS) {
    const records = resolvedRecords(input.attacks, seat);
    // A log must run 1..n with no gaps: a gap would let a round resolve twice.
    if (records.some((record, index) => record.round !== index + 1)) return null;
    players[seat] = { seat, fleet: input.fleets[seat], attacks: records };
  }

  const player1Destroyed = fleetDestroyed(input.fleets.player2, players.player1.attacks);
  const player2Destroyed = fleetDestroyed(input.fleets.player1, players.player2.attacks);

  const outcome: MatchOutcome | null =
    player1Destroyed && player2Destroyed
      ? MATCH_OUTCOME.DRAW
      : player1Destroyed
        ? MATCH_OUTCOME.PLAYER1
        : player2Destroyed
          ? MATCH_OUTCOME.PLAYER2
          : null;

  const winner: Seat | null =
    outcome === MATCH_OUTCOME.PLAYER1
      ? "player1"
      : outcome === MATCH_OUTCOME.PLAYER2
        ? "player2"
        : null;

  const state: PrivateMatchState = {
    status: outcome ? "finished" : "playing",
    round: input.round,
    players,
    outcome,
    winner,
  };

  return validateMatchState(state).ok ? state : null;
}

export interface FleetDamage {
  /** Per-cell damage for every ship of the given fleet. */
  readonly damaged: Record<ShipKey, boolean[]>;
  /** Ships whose every cell has been hit. */
  readonly sunk: ShipKey[];
}

/**
 * Derives the damage of ONE fleet from the shots fired AT it.
 *
 * `incoming` is the opponent's public attack log (the viewer sees these shots on
 * their own board), so this never needs the hidden enemy fleet. It is typed to
 * the two fields both the stored record and the PUBLIC projection carry, so the
 * same function serves the server and the client without either shape leaking
 * into the other.
 */
export interface IncomingShot {
  readonly coordinate: string;
  readonly result: string;
}

export function fleetDamage(fleet: Fleet, incoming: readonly IncomingShot[]): FleetDamage {
  const hits = new Set(
    incoming.filter((attack) => attack.result !== "miss").map((attack) => attack.coordinate),
  );
  const damaged = {} as Record<ShipKey, boolean[]>;
  const sunk: ShipKey[] = [];

  for (const ship of SHIP_KEYS) {
    const placement = fleet.ships.find((candidate) => candidate.ship === ship);
    if (!placement) continue;
    const cells = shipCells(placement).map((cell) => formatCoordinate(cell));
    damaged[ship] = cells.map((cell) => hits.has(cell));
    if (damaged[ship].every(Boolean)) sunk.push(ship);
  }

  return { damaged, sunk };
}

/** The ships a seat DESTROYED with its shot in one resolved round. */
export function sunkBySeat(
  attacks: Readonly<Record<Seat, { readonly result: string; readonly ship: string | null }>>,
): ShipKey[] {
  const sunk: ShipKey[] = [];
  for (const seat of SEATS) {
    const attack = attacks[seat];
    if (attack?.result === "sunk" && attack.ship) sunk.push(attack.ship as ShipKey);
  }
  return sunk;
}
