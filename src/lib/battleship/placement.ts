// src/lib/battleship/placement.ts
//
// The PURE ship-placement model behind the placement screen: which ships are
// down, where, and whether the fleet may be confirmed.
//
// It is deliberately separate from both the rules engine and the React screen:
//
//   * `./rules` validates a COMPLETE fleet (five ships, no overlap, in bounds)
//     for the match. Placement has a different question — "may this ONE ship go
//     here, on top of the four already down?" — and it has to answer it on every
//     tap, so it lives here as a small, testable model instead of component
//     state arithmetic.
//   * the screen only renders this state and dispatches intents. Every rejection
//     (overlap, out of bounds, wrong ship) is a value, not an exception, so the
//     UI can print the reason next to the board.
//
// REPOSITIONING IS A REPLACEMENT. A ship can be moved by placing it again — the
// model drops the ship's previous placement first, so "tap the ship, tap the new
// cell" and a desktop drag both end up as one `placeShip` call.

import { ORIENTATIONS, PLACEMENT_SECONDS, REJECTION, SHIP_KEYS } from "./constants";
import { cellKey, formatCoordinate, shipCells, validateFleet, validateShipPlacement } from "./rules";
import { generateRandomFleet } from "./fleet";
import type { Fleet, Orientation, RejectionCode, ShipKey, ShipPlacement } from "./types";

/** Re-exported so the placement screen imports its clock from the model. */
export { PLACEMENT_SECONDS };

/** The fleet being built: zero to five placements, no duplicates. */
export interface PlacementState {
  readonly ships: readonly ShipPlacement[];
}

export type PlacementResult =
  | { readonly ok: true; readonly state: PlacementState }
  | { readonly ok: false; readonly code: RejectionCode; readonly message: string };

/** A fresh, empty fleet. */
export function emptyPlacement(): PlacementState {
  return { ships: [] };
}

/** Canonical fleet order, so the shelf and the serialization never disagree. */
function canonicalOrder(ships: readonly ShipPlacement[]): ShipPlacement[] {
  return [...ships].sort((a, b) => SHIP_KEYS.indexOf(a.ship) - SHIP_KEYS.indexOf(b.ship));
}

/** Is this ship already on the board? */
export function isPlaced(state: PlacementState, ship: ShipKey): boolean {
  return state.ships.some((placement) => placement.ship === ship);
}

/** The current placement of a ship, or null. */
export function placementOf(state: PlacementState, ship: ShipKey): ShipPlacement | null {
  return state.ships.find((placement) => placement.ship === ship) ?? null;
}

/**
 * Places (or MOVES) one ship. The ship's previous placement is dropped first, so
 * the same call covers "place it" and "reposition it".
 *
 * Ships may touch, including diagonally; only a shared cell is refused.
 */
export function placeShip(state: PlacementState, placement: ShipPlacement): PlacementResult {
  const verdict = validateShipPlacement(placement);
  if (verdict.ok === false) {
    return { ok: false, code: verdict.code, message: verdict.message };
  }

  const others = state.ships.filter((candidate) => candidate.ship !== placement.ship);
  const occupied = new Set(others.flatMap((candidate) => shipCells(candidate).map(cellKey)));
  const clash = verdict.cells.find((cell) => occupied.has(cellKey(cell)));
  if (clash) {
    return {
      ok: false,
      code: REJECTION.OVERLAP,
      message: `The ${placement.ship} cannot overlap another ship at ${formatCoordinate(clash)}.`,
    };
  }

  return { ok: true, state: { ships: canonicalOrder([...others, placement]) } };
}

/** Lifts a ship back onto the shelf. */
export function removeShip(state: PlacementState, ship: ShipKey): PlacementState {
  return { ships: state.ships.filter((placement) => placement.ship !== ship) };
}

/** The next orientation — the rotate control and the R key both use this. */
export function rotate(orientation: Orientation): Orientation {
  return orientation === ORIENTATIONS[0] ? ORIENTATIONS[1] : ORIENTATIONS[0];
}

/**
 * Deals a complete fleet, replacing whatever was on the board. Filling only the
 * MISSING ships would have to solve a packing problem around the player's own
 * placements; a fresh deal is what "Auto place" means to a player, and it is
 * always legal.
 */
export function autoPlace(state: PlacementState = emptyPlacement(), random: () => number = Math.random): PlacementState {
  const fleet = generateRandomFleet(random);
  return { ships: canonicalOrder(fleet.ships) };
}

/** True when all five ships are down and the fleet validates. */
export function placementComplete(state: PlacementState): boolean {
  return validateFleet(state).ok;
}

/** The finished fleet, or null while it is still incomplete/illegal. */
export function toFleet(state: PlacementState): Fleet | null {
  const verdict = validateFleet(state);
  return verdict.ok ? { ships: canonicalOrder(state.ships) } : null;
}

/** Confirms the fleet, or explains why it cannot be confirmed yet. */
export function confirmPlacement(
  state: PlacementState,
): { readonly ok: true; readonly fleet: Fleet } | { readonly ok: false; readonly code: RejectionCode; readonly message: string } {
  const fleet = toFleet(state);
  if (fleet) return { ok: true, fleet };

  const verdict = validateFleet(state);
  if (verdict.ok === false) {
    return { ok: false, code: verdict.code, message: verdict.message };
  }
  return { ok: false, code: REJECTION.INVALID_FLEET, message: "the fleet is not complete" };
}
