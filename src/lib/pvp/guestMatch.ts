// src/lib/pvp/guestMatch.ts
//
// The ONE definition of "this PvP match involves a Guest" (Phase 3B–3E).
//
// It is deliberately pure and dependency-free so the settlement writers, the
// queue and the tests all agree without importing a database. The inputs are
// always the SERVER's own seat ids — taken from the locked match row or from the
// request rows the queue already loaded — never a body, query or header field.
//
// The mandatory rule: if at least one participant is a Guest, the whole match is
// UNRATED for both participants. `isGuestPvpMatch` is how every writer decides
// that before it touches a rating, a trophy, a counter or a wallet.

import { isGuestId } from "../guestIdentity";

/** Stable reason every writer returns when it refuses a Guest match. */
export const GUEST_MATCH_UNRATED_REASON = "guest-unrated";

/** True when one seat id is a verified-guest identity. */
export function isGuestSeat(id: unknown): boolean {
  return isGuestId(id);
}

/**
 * True when ANY seat is a Guest. Empty/null seats are ignored, so an unfinished
 * lobby is not treated as a Guest match by accident.
 */
export function isGuestPvpMatch(seats: readonly unknown[] | null | undefined): boolean {
  if (!Array.isArray(seats)) return false;
  return seats.some((seat) => isGuestId(seat));
}

/** True when the match is rated for everyone (no Guest seat). */
export function isRatedPvpMatch(seats: readonly unknown[] | null | undefined): boolean {
  return !isGuestPvpMatch(seats);
}
