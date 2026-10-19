// src/lib/hex-duel/authority.ts
//
// The SERVER's view of a Hex Duel match: which seat a Clerk id holds, and what
// the recorded action log adds up to.
//
// WHY: a staked match settles on the server's own arithmetic, never on a
// request body (src/lib/games/stakes.js — "a stake must never settle on a
// client's word"). `hex_duel_actions` already holds a server-written row for
// every move the action route accepted, so replaying those rows through the
// shared rulebook (`./rules`) reproduces the board both players saw and yields
// the winner the SERVER believes — the value the end route pays out on.
//
// PURE ON PURPOSE: no db handle, no request, no clock. The route reads the rows
// inside its own transaction and hands them here, so this module is unit-testable
// and cannot accidentally settle against a different query than it replays.

import {
  applyRecordedMove,
  makeInitialCore,
  type CoreState,
  type DuelPlayer,
  type HexDuelMoveType,
} from "./rules";

/** The two seats of a match, exactly as the game row stores them. */
export interface HexDuelSeats {
  player1Id: string | null;
  player2Id: string | null;
}

/** One `hex_duel_actions` row, narrowed to the fields the rulebook reads. */
export interface StoredHexDuelAction {
  userId: string;
  actionType: string;
  sourceKey: string | null;
  targetKey: string | null;
  troopCount: number | null;
}

export interface HexDuelReplay {
  /** The board the recorded moves produce. */
  state: CoreState;
  /** The winner this replay derives, or null while the match is undecided. */
  winner: DuelPlayer | null;
  /** Rows that moved the game forward. */
  applied: number;
  /** Rows that were not a move this rulebook knows (unknown type, no seat). */
  ignored: number;
}

/** Every action type the rulebook can replay. */
export const HEX_DUEL_MOVE_TYPES: readonly HexDuelMoveType[] = [
  "attack",
  "displace",
  "endTurn",
  "skipRound",
];

export function isHexDuelMoveType(value: unknown): value is HexDuelMoveType {
  return (
    typeof value === "string" &&
    (HEX_DUEL_MOVE_TYPES as readonly string[]).includes(value)
  );
}

/** Which seat a Clerk id holds in this match, or null when it holds neither. */
export function hexDuelSeatFor(
  seats: HexDuelSeats,
  clerkId: string | null | undefined,
): DuelPlayer | null {
  if (!clerkId) return null;
  if (seats.player1Id === clerkId) return "player1";
  if (seats.player2Id === clerkId) return "player2";
  return null;
}

/** The other seat of a match — the winner when a seat concedes. */
export function hexDuelOpponentSeat(seat: DuelPlayer): DuelPlayer {
  return seat === "player1" ? "player2" : "player1";
}

/**
 * Replay a match's recorded moves.
 *
 * Rows must be in the order the server accepted them (`hex_duel_actions.id`,
 * which is the same order `messages`/polling clients read). A row whose author
 * holds no seat, or whose type the rulebook does not know, is counted as
 * ignored rather than applied — the replay can never throw on a stray row.
 */
export function replayHexDuel(
  seats: HexDuelSeats,
  rows: StoredHexDuelAction[],
): HexDuelReplay {
  let state = makeInitialCore();
  let applied = 0;
  let ignored = 0;

  for (const row of rows) {
    if (state.winner) {
      // Everything after the deciding move is moot.
      ignored += 1;
      continue;
    }
    const seat = hexDuelSeatFor(seats, row.userId);
    if (!seat || !isHexDuelMoveType(row.actionType)) {
      ignored += 1;
      continue;
    }
    const before = state;
    state = applyRecordedMove(state, seat, {
      type: row.actionType,
      sourceKey: row.sourceKey,
      targetKey: row.targetKey,
      troopCount: row.troopCount,
    });
    if (state === before) {
      // A no-op for the receiver (a missing payload, or the endTurn echo the
      // engine's own applyRemoteAction ignores). Not a move.
      ignored += 1;
    } else {
      applied += 1;
    }
  }

  return { state, winner: state.winner, applied, ignored };
}

/**
 * The winner the server will settle on, or null while the match has none.
 *
 * ORDER MATTERS: the replayed board is the primary source (a capital capture is
 * the only way the game itself ends). The row's `winner` column is the
 * fallback, because a seat can also LOSE the match by conceding — a resign the
 * resigning player's own authenticated client reported, which the server records
 * in that column. A client cannot name itself the winner: it can only report its
 * own loss, and the opponent is then derived here.
 */
export function hexDuelSettledWinner(
  seats: HexDuelSeats,
  rows: StoredHexDuelAction[],
  winnerColumn: string | null | undefined,
): { winner: DuelPlayer | null; source: "capture" | "concede" | "none" } {
  const { winner: captured } = replayHexDuel(seats, rows);
  if (captured) return { winner: captured, source: "capture" };
  if (winnerColumn === "player1" || winnerColumn === "player2") {
    return { winner: winnerColumn, source: "concede" };
  }
  return { winner: null, source: "none" };
}

/** The Clerk id sitting in `seat`, or null when the seat is empty. */
export function hexDuelClerkInSeat(
  seats: HexDuelSeats,
  seat: DuelPlayer,
): string | null {
  return seat === "player1" ? seats.player1Id : seats.player2Id;
}
