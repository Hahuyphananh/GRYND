// src/lib/results/viewerOutcome.ts
//
// THE ONE WIN/LOSS/DRAW DERIVATION FOR EVERY GAME'S RESULT SCREEN.
//
// A result screen may only ever say what the SERVER's settled row says, read
// from the seat the SERVER says the viewer holds. It must never be decided from
// Clerk's `user.id`:
//
//   * a signed-out free-play visitor has no Clerk id at all — the practice gate
//     mints them a `guest_…` identity (src/lib/auth/guestSession.ts) — so
//     `winnerId === user.id` is false for them whatever the row says, and the
//     screen reports a loss to a player who just won;
//   * a client whose Clerk session has not hydrated has `user === null` for a
//     moment, which is the same false loss for that moment;
//   * the id is simply the wrong fact to read. `result` is written by the store's
//     settlement FROM THE WINNER SEAT, so comparing it to the viewer's seat is
//     the same statement the server already committed, with nothing to infer.
//
// The id comparison survives only as the fallback for a row that names a winner
// without a result string — and it compares against the id the SERVER gave the
// viewer's seat (`viewerId`, which a caller should pass as the server's own
// value, falling back to Clerk only when the server gave none), never against
// Clerk alone.
//
// Pure: no database, no socket, no React. Every game's screen can call it, and
// tests/seat-based-outcome.test.mjs drives it and guards the call sites.

/** What a player is told they got. `null` = the row does not say. */
export type ViewerOutcome = "win" | "loss" | "draw";

/**
 * A seat, in any of the spellings the platform's payloads use: the seat KEY
 * ("player1" | "player2"), the seat NUMBER (1 | 2), or absent.
 */
export type SeatLike = "player1" | "player2" | 1 | 2 | null | undefined;

/** The seat key a payload's spelling names, or null when it names none. */
export function seatKeyOf(seat: SeatLike): "player1" | "player2" | null {
  if (seat === "player1" || seat === 1) return "player1";
  if (seat === "player2" || seat === 2) return "player2";
  return null;
}

/**
 * The viewer's outcome from a settled row.
 *
 * Precedence, in order:
 *   1. a tie is a draw, for both seats — a row that also names a winner is
 *      still a tie, because a tie has no winner;
 *   2. the settled `result`, read against the VIEWER'S SEAT (no ids needed, so
 *      this works for a guest, a signed-in player, and a page whose Clerk
 *      session has not loaded);
 *   3. a row that names a winner without a result: the server's seat id for the
 *      viewer, or nothing.
 */
export function viewerOutcome({
  result,
  winnerId,
  viewerSeat,
  viewerId,
}: {
  /** 'player1' | 'player2' | 'tie' (or 'draw'), or null while nothing settled. */
  result?: string | null;
  winnerId?: string | null;
  /** The seat the SERVER says is the viewer's, in any supported spelling. */
  viewerSeat?: SeatLike;
  /** The id the SERVER gave the viewer's seat — a guest id counts. */
  viewerId?: string | null;
}): ViewerOutcome | null {
  if (result === "tie" || result === "draw") return "draw";

  if (result === "player1" || result === "player2") {
    const seat = seatKeyOf(viewerSeat);
    if (!seat) return null;
    return result === seat ? "win" : "loss";
  }

  if (winnerId && viewerId) return winnerId === viewerId ? "win" : "loss";
  return null;
}
