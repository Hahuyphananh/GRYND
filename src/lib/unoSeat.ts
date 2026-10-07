// src/lib/unoSeat.ts
//
// Seat identity for a UNO game row.
//
// THE PROBLEM: `uno_games.user_id` is an INTEGER foreign key to `users.id`, so
// a signed-out visitor — whose identity is `guest_<uuid>` — cannot hold a row.
// That left UNO's free vs-AI practice mode account-gated while every other
// practice mode accepted guests.
//
// THE FIX (migration 0206): `uno_games.user_id` became NULLABLE and a second,
// nullable `guest_id` text column was added. A PRACTICE game is owned by
// exactly one of the two seats:
//
//   * an ACCOUNT game  → `user_id` set, `guest_id` NULL
//   * a GUEST game    → `guest_id` set, `user_id` NULL
//
// Online (PvP) games stay account-only: matchmaking keeps the age gate, so a
// guest can never appear in one. That means the caller's seat token is simply
// the guest id for a guest and `String(users.id)` for a signed-in account, and
// every practice route authorises through `isUnoSeat` — one rule, one place.

import { isGuestId } from "./guestIdentity";

/** The minimal UNO row shape needed to resolve its seat. */
export type UnoSeatGame = {
  userId: number | null;
  guestId?: string | null;
};

/**
 * The single authoritative owner token for a UNO row, or null when the row has
 * no seat at all (which should not happen).
 *
 * A guest game returns the `guest_<uuid>`; an account game returns the
 * stringified `users.id`. `guestId` is checked first and validated with
 * `isGuestId`, so a malformed value can never be mistaken for a seat.
 */
export function unoSeatToken(game: UnoSeatGame | null | undefined): string | null {
  if (game && typeof game.guestId === "string" && isGuestId(game.guestId)) {
    return game.guestId;
  }
  if (game && game.userId !== null && game.userId !== undefined) {
    return String(game.userId);
  }
  return null;
}

/**
 * The caller's seat token for a UNO row: the guest id for a guest, or
 * `String(users.id)` for a signed-in account. `accountId` is the caller's
 * `users.id` (null for a guest, which never needs one).
 */
export function unoCallerToken(
  isGuest: boolean,
  guestId: string | null,
  accountId: number | null,
): string | null {
  if (isGuest) return guestId && isGuestId(guestId) ? guestId : null;
  return accountId !== null && accountId !== undefined ? String(accountId) : null;
}

/** True when the caller holds the (single) seat of this game. */
export function isUnoSeat(
  game: UnoSeatGame | null | undefined,
  callerToken: string | null,
): boolean {
  if (!callerToken) return false;
  const owner = unoSeatToken(game);
  return owner !== null && owner === callerToken;
}
