// src/lib/rooms/types.ts
//
// The wire types of a room, shared by the server (src/lib/rooms/store.ts) and
// the room UI.
//
// WHY THEY LIVE HERE: the UI must be able to name what it renders without
// importing the data layer — `store.ts` pulls in the database client and the
// game stores, so a client component importing a type from it drags the whole
// server graph into the browser bundle. This module imports NOTHING, so it is
// safe on both sides.
//
// The server writes these shapes; the client never invents one (a room id, a
// code, a status or a match id sent by a client is never trusted).

export type RoomRole = "host" | "guest";

/** One invited player of a room, as its participants see it. */
export interface RoomMemberView {
  userId: string;
  role: RoomRole;
  /** 'invited' | 'accepted' | 'declined'. */
  inviteStatus: string;
  name: string | null;
  isHost: boolean;
  /** True for the caller's own row. */
  isYou: boolean;
}

/** A room / challenge, as its participants see it. */
export interface RoomView {
  id: string;
  /** Shareable code — null for a challenge (there is nothing to share). */
  code: string | null;
  /** 'room' (PRO custom room) | 'challenge' (free 1v1 friend challenge). */
  kind: string;
  hostUserId: string;
  gameKey: string;
  /** English label; the UI localises it with `rooms.game_<key>`. */
  gameLabel: string | null;
  mode: string;
  settings: { stake: number };
  /** open | starting | started | declined | expired | cancelled | failed */
  status: string;
  matchId: string | null;
  matchUrl: string | null;
  seats: number;
  createdAt: string;
  expiresAt: string;
  startedAt: string | null;
  closedAt: string | null;
  members: RoomMemberView[];
  /** The caller's own role / invitation state (null when not a participant). */
  role: RoomRole | null;
  inviteStatus: string | null;
  isHost: boolean;
  /** True when the host's own start would be accepted right now. */
  canStart: boolean;
  /** Guests who hold a seat. */
  acceptedSeatCount: number;
}

/** A game entry of the room picker (the client-safe catalog). */
export interface RoomGameOption {
  key: string;
  label: string;
  mode: string;
  seats: number;
  /** 0 means the game's rooms are free-play only. */
  maxStake: number;
}
