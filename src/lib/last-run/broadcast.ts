// src/lib/last-run/broadcast.ts
//
// THE PUSHED SNAPSHOT SHAPE — and the one pure function that reads it.
//
// The match's authority is the registry (src/lib/last-run/matchRegistry.ts).
// The HTTP route hands a client a VIEWER-RELATIVE snapshot. The realtime push
// cannot do that: one interval serves both seats, so it sends the SAME match
// addressed by seat, and each client reads its own side out of it with
// `snapshotForSeat` — producing exactly the object the HTTP route would have
// returned. The two paths therefore cannot disagree about the world, and the
// page does not need a second rendering branch.
//
// Client-safe on purpose: no `node:crypto`, no registry, no env, no fetch. The
// only values here are the room/event names, the type and the converter.

import { otherSeat, type Seat } from "./constants";
import type { MatchSnapshot, SnapshotSeat } from "./matchRegistry";

/** Event the realtime server pushes to `last-run:match:<id>`. */
export const LAST_RUN_SNAPSHOT_EVENT = "last-run:snapshot";

/** The Socket.IO room both seats of one match join. */
export function lastRunMatchRoom(matchId: string): string {
  return `last-run:match:${matchId}`;
}

/**
 * A viewer-neutral match snapshot: the same numbers, addressed by SEAT.
 *
 * It carries nothing that is not already in the HTTP snapshot (the two display
 * names, the course, both runners' server-derived state) and nothing a client
 * could use for authority — no input log, no clocks it can set, no result it
 * can fill in.
 */
export type MatchBroadcast = Omit<MatchSnapshot, "you" | "opponent"> & {
  seats: Record<Seat, SnapshotSeat>;
};

function isSeatState(value: unknown): value is SnapshotSeat {
  if (!value || typeof value !== "object") return false;
  const seat = value as Partial<SnapshotSeat>;
  return (
    (seat.seat === "player1" || seat.seat === "player2") &&
    typeof seat.distance === "number" &&
    typeof seat.y === "number" &&
    typeof seat.vy === "number" &&
    typeof seat.ducking === "boolean" &&
    typeof seat.alive === "boolean"
  );
}

/**
 * Is this socket payload a snapshot we can draw?
 *
 * The event arrives over a shared socket, so it is treated as untrusted input:
 * a malformed or foreign frame is dropped instead of being spread into state.
 */
export function isMatchBroadcast(value: unknown): value is MatchBroadcast {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<MatchBroadcast> & { seats?: unknown };
  if (typeof candidate.matchId !== "string") return false;
  if (
    candidate.phase !== "countdown" &&
    candidate.phase !== "racing" &&
    candidate.phase !== "finished"
  ) {
    return false;
  }
  if (
    typeof candidate.serverNow !== "number" ||
    typeof candidate.startsAt !== "number" ||
    typeof candidate.seed !== "number" ||
    typeof candidate.tick !== "number"
  ) {
    return false;
  }
  const seats = candidate.seats as Record<string, unknown> | undefined;
  if (!seats || typeof seats !== "object") return false;
  return isSeatState(seats.player1) && isSeatState(seats.player2);
}

/**
 * Read a pushed broadcast from ONE seat: identical to what
 * `GET /api/last-run/match/:id` returns for that seat.
 */
export function snapshotForSeat(broadcast: MatchBroadcast, seat: Seat): MatchSnapshot {
  const { seats, ...rest } = broadcast;
  return { ...rest, you: seats[seat], opponent: seats[otherSeat(seat)] };
}
