// src/lib/speed-typing/ui.ts
//
// THE MATCH VIEW'S VERDICT — the one place the client turns the server's settled
// row into what the player is told they got: `win`, `loss`, `draw` — or `null`
// when the row does not say who won.
//
// WHY THIS IS A FUNCTION AND NOT AN INLINE EXPRESSION. Two things must be true
// of a verdict, and the expression this replaces got the second one wrong:
//
//   1. IT MUST BE THE SERVER'S. `result` is written by the store's settlement
//      from the winner SEAT; the client never infers a winner from local typing,
//      from WPM, or from the progress bars. It reads the row.
//   2. IT MUST BE READABLE BY EVERY VIEWER. The verdict is resolved against the
//      seat the SNAPSHOT says the viewer holds (`viewerSeat`) — never against
//      Clerk alone. A signed-out free-play visitor holds no Clerk id at all: the
//      practice gate mints them a `guest_…` identity
//      (src/lib/auth/guestSession.ts), so an id comparison keyed on the Clerk
//      user reported a LOSS to a guest who had just WON — while the arena was
//      still telling them "You finished — the race is yours".
//
// The `winnerId` branch survives only as the fallback for a row that names a
// winner without a result (a legacy row, or another writer's settlement), and it
// compares against the id the SNAPSHOT gives the viewer's seat — the same id the
// store wrote — with Clerk's id as the last resort.
//
// THE RULE ITSELF NOW LIVES IN ONE PLACE — src/lib/results/viewerOutcome.ts —
// and this function is the Speed Typing spelling of it (seat NUMBERS, where the
// other match views speak seat KEYS). Every game's result screen derives its
// verdict from that one function, so "who won" can only ever be answered one
// way: from the server's settled row, read against the server's seat.
//
// Pure: no database, no socket, no React — so the whole verdict is unit-testable
// (tests/speed-typing-outcome.test.mjs).

import { viewerOutcome } from "../results/viewerOutcome";

/** What the player is told they got. `null` = the row does not say. */
export type MatchOutcome = "win" | "loss" | "draw";

/**
 * The viewer's outcome from a settled row.
 *
 * `viewerSeat` is the seat NUMBER (1 | 2) the snapshot reports for the viewer —
 * Speed Typing's DTO speaks seats as numbers (`viewerSeat`), not as seat keys,
 * unlike the other match views' helpers.
 */
export function outcomeFor({
  result,
  winnerId,
  viewerSeat,
  viewerSeatId,
}: {
  /** 'player1' | 'player2' | 'tie', or null while nothing has settled. */
  result?: string | null;
  winnerId?: string | null;
  /** The seat the snapshot says is the viewer's: 1, 2, or null. */
  viewerSeat: 1 | 2 | null;
  /** The id the snapshot gives that seat — a guest id counts, Clerk need not. */
  viewerSeatId?: string | null;
}): MatchOutcome | null {
  // Delegated, not re-implemented: the platform's one verdict rule speaks both
  // seat spellings (`seatKeyOf`), so the numeric seat this DTO carries and the
  // seat keys the other match views carry resolve identically.
  return viewerOutcome({
    result,
    winnerId,
    viewerSeat,
    viewerId: viewerSeatId,
  });
}
