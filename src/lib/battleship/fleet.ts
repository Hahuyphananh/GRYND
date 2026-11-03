// src/lib/battleship/fleet.ts
//
// Fleet DEALING and fleet SERIALIZATION — the only impure corner of Battleship,
// and even that is injectable: every random choice comes from a `random()`
// callback (`Math.random` by default), so tests seed it and get a byte-identical
// fleet every run.
//
// WHY THIS IS A SEPARATE MODULE FROM ./rules
//
//   The rules engine must be a deterministic function of its inputs — that is
//   what makes "both attacks resolved against the same pre-round state" testable.
//   Placing ships randomly is a different concern with a different failure mode
//   (a placement attempt that does not fit), so it lives here and `./rules`
//   never imports it.
//
// RANDOM PLACEMENT IS BACKTRACKING, NOT RETRY-UNTIL-LUCKY
//
//   Five ships on a 10×10 board always fit, so a rejection loop would *usually*
//   terminate — and occasionally draw a pathological sequence and spin. This is
//   a depth-first search with an injectable shuffle: it tries the ships in the
//   canonical order, tries each legal placement in a random order, and backtracks
//   when a later ship no longer fits. It cannot fail for a legal board and it
//   does not bias the fleet toward the first ship's position the way "place
//   greedily and restart" does.
//
// SERIALIZATION
//
//   A fleet has ONE canonical text form: ships in the fleet table's order, each
//   as `<ship>:<first cell>:<orientation>`, joined by `;`. Example:
//
//     carrier:A1:horizontal;battleship:A3:horizontal;cruiser:A5:horizontal;
//     submarine:A7:horizontal;destroyer:A9:horizontal
//
//   `deserializeFleet` re-validates whatever it parses, so a corrupted or
//   tampered column can never become a playable fleet.

import { ORIENTATIONS, REJECTION, SHIP_KEYS } from "./constants";
import type { Fleet, ShipKey, ShipPlacement } from "./types";
import {
  BattleshipRuleError,
  cellKey,
  formatCoordinate,
  parseCoordinate,
  shipCells,
  validateFleet,
  validateShipPlacement,
} from "./rules";

/** Every legal placement of one ship on an empty board (bounds only). */
export function placementsFor(ship: ShipKey): ShipPlacement[] {
  const placements: ShipPlacement[] = [];
  for (const orientation of ORIENTATIONS) {
    for (let y = 0; y < 10; y += 1) {
      for (let x = 0; x < 10; x += 1) {
        const placement: ShipPlacement = { ship, orientation, x, y };
        if (validateShipPlacement(placement).ok) placements.push(placement);
      }
    }
  }
  return placements;
}

function shuffle<T>(items: T[], random: () => number): void {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const raw = random();
    const bounded = Number.isFinite(raw) ? Math.abs(raw) % 1 : 0;
    const swapWith = Math.floor(bounded * (index + 1));
    const current = items[index];
    items[index] = items[swapWith];
    items[swapWith] = current;
  }
}

/**
 * Deals a legal fleet: five ships, no overlap, every ship its required length.
 *
 * `random` is injectable purely so a test can pin the deal. The search is
 * exhaustive with backtracking, so it always finds a fleet rather than retrying
 * blindly; the throw is a programming-error guard for a board that could not
 * physically hold the fleet, not an expected outcome.
 */
export function generateRandomFleet(random: () => number = Math.random): Fleet {
  const placed: ShipPlacement[] = [];
  const occupied = new Set<string>();

  const placeFrom = (index: number): boolean => {
    if (index >= SHIP_KEYS.length) return true;
    const ship = SHIP_KEYS[index];
    const candidates = placementsFor(ship).filter((placement) =>
      shipCells(placement).every((cell) => !occupied.has(cellKey(cell))),
    );
    shuffle(candidates, random);

    for (const candidate of candidates) {
      const cells = shipCells(candidate);
      for (const cell of cells) occupied.add(cellKey(cell));
      placed.push(candidate);
      if (placeFrom(index + 1)) return true;
      placed.pop();
      for (const cell of cells) occupied.delete(cellKey(cell));
    }
    return false;
  };

  if (!placeFrom(0)) {
    throw new BattleshipRuleError(REJECTION.INVALID_FLEET, "no fleet fits the board");
  }

  return { ships: placed };
}

/**
 * The one canonical text form of a fleet. Throws on an invalid fleet: a fleet
 * that cannot be played must not be stored, and serializing one would hide that.
 */
export function serializeFleet(fleet: Fleet): string {
  const verdict = validateFleet(fleet);
  if (verdict.ok === false) throw new BattleshipRuleError(verdict.code, verdict.message);

  return SHIP_KEYS.map((ship) => {
    const placement = fleet.ships.find((candidate) => candidate.ship === ship) as ShipPlacement;
    return `${ship}:${formatCoordinate({ x: placement.x, y: placement.y })}:${placement.orientation}`;
  }).join(";");
}

/**
 * Parses `serializeFleet`'s output back into a fleet, re-validating it. Returns
 * null for anything unreadable or illegal rather than throwing — this reads a
 * stored column, which may be older or tampered with.
 */
export function deserializeFleet(serialized: unknown): Fleet | null {
  if (typeof serialized !== "string" || serialized.trim() === "") return null;

  const ships: ShipPlacement[] = [];
  for (const part of serialized.split(";")) {
    const [ship, cell, orientation] = part.split(":");
    if (!ship || !cell || !orientation) return null;
    const coordinate = parseCoordinate(cell);
    if (!coordinate) return null;
    ships.push({
      ship: ship as ShipKey,
      orientation: orientation as ShipPlacement["orientation"],
      x: coordinate.x,
      y: coordinate.y,
    });
  }

  const fleet: Fleet = { ships };
  const verdict = validateFleet(fleet);
  return verdict.ok ? fleet : null;
}
