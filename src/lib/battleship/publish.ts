// src/lib/battleship/publish.ts
//
// The ONE place a resolved round, a timeout attack or a forfeit is published.
//
// Every function here is called AFTER the transaction committed — by the attack
// route, the snapshot route's lazy recovery, the timeout job and the disconnect
// route — so the same event vocabulary is emitted no matter which path advanced
// the match. A missed push is always recoverable: the client's poll re-reads the
// authoritative snapshot.
//
// What is NOT here: any fleet layout, any pending cell, any opponent coordinate
// before resolution. A timeout notice names the SEAT and the ROUND only; the
// cell becomes public with the round's result.

import type { Seat } from "./types";
import {
  BATTLESHIP_EVENTS,
  broadcastBattleshipEvent,
  broadcastMatchUpdate,
} from "./rooms";
import type { ServerRoundResult } from "./serverStore";

/** Both attacks of a resolved round are published together, never one alone. */
export function publishRoundResult(matchId: string, round: ServerRoundResult): void {
  broadcastMatchUpdate(matchId, {
    phase: round.status === "finished" ? "finished" : "combat",
    round: round.nextRound ?? round.round,
  });

  broadcastBattleshipEvent(matchId, BATTLESHIP_EVENTS.ROUND_RESOLVED, {
    round: round.round,
    attacks: round.attacks,
    destroyed: round.destroyed,
    outcome: round.outcome,
    nextRound: round.nextRound,
  });

  if (round.sunkShips.length > 0) {
    broadcastBattleshipEvent(matchId, BATTLESHIP_EVENTS.SHIP_SUNK, {
      round: round.round,
      ships: round.sunkShips,
    });
  }

  if (round.nextRound !== null) {
    broadcastBattleshipEvent(matchId, BATTLESHIP_EVENTS.ROUND_STARTED, {
      round: round.nextRound,
      roundDeadline: round.roundDeadline,
    });
  } else {
    broadcastBattleshipEvent(matchId, BATTLESHIP_EVENTS.MATCH_FINISHED, {
      round: round.round,
      outcome: round.outcome,
    });
  }
}

/** A deadline produced one or two automatic attacks. No cell is disclosed. */
export function publishTimeoutNotice(matchId: string, round: number, seats: Seat[]): void {
  broadcastMatchUpdate(matchId, { round });
  broadcastBattleshipEvent(matchId, BATTLESHIP_EVENTS.ATTACK_TIMEOUT, { round, seats });
}

export interface ForfeitNotice {
  readonly matchId: string;
  readonly seat: Seat | null;
  readonly reason: "placement_timeout" | "timeout_forfeit" | "abandoned" | "resigned";
  readonly cancelled: boolean;
}

/** A timeout / abandonment ended the match. */
export function publishForfeit(notice: ForfeitNotice): void {
  broadcastMatchUpdate(notice.matchId, {
    phase: notice.cancelled ? "cancelled" : "finished",
    reason: notice.reason,
  });
  broadcastBattleshipEvent(
    notice.matchId,
    notice.cancelled ? BATTLESHIP_EVENTS.MATCH_CANCELLED : BATTLESHIP_EVENTS.MATCH_FINISHED,
    { seat: notice.seat, reason: notice.reason },
  );
}
