// src/lib/rooms/rules.ts
//
// THE authorization and lifecycle rules of private rooms and friend
// challenges, as PURE functions.
//
// WHY PURE: every decision below is a security decision — who may create,
// invite, join, read, accept, start or cancel — and a security decision that can
// only be exercised through a live database is a security decision nobody
// tests. These functions take plain records plus a clock and answer allow/deny,
// so the actual authorization rules are unit-tested (tests/private-rooms.test.mjs)
// while src/lib/rooms/store.ts stays a thin, obviously-correct data layer.
//
// WHAT IS NOT HERE: the database, rate limiting, realtime and match creation.
// The store calls these rules before it writes anything, and the routes call the
// store. There is exactly ONE place that decides each rule.
//
// TWO KINDS (see docs/PRIVATE_ROOMS.md §4):
//   * `room`      — a GRYND PRO custom room: Pro-only creation, a shareable
//                   code, several invitees, the host starts it.
//   * `challenge` — a FREE 1v1 challenge to ONE friend: never Pro-gated, no
//                   code, one invitee, server-chosen settings, and it starts the
//                   moment the friend accepts. That structural difference is
//                   what lets a free player challenge a friend without gaining
//                   standalone room-creation privileges.

import {
  CHALLENGE_TTL_MS,
  ROOM_MAX_INVITES,
  ROOM_TTL_MS,
  getRoomGame,
} from "./catalog";

export type RoomKind = "room" | "challenge";

export type RoomStatus =
  | "open"
  | "starting"
  | "started"
  | "declined"
  | "expired"
  | "cancelled"
  | "failed";

export type MemberRole = "host" | "guest";
export type InviteStatus = "invited" | "accepted" | "declined";

/** A `private_rooms` row (or the subset the rules need), plain and DB-free. */
export interface RoomRecord {
  id: string;
  code?: string | null;
  kind: string;
  hostUserId: string;
  gameKey: string;
  mode?: string;
  settings?: { stake?: number } | null;
  status: string;
  matchId?: string | null;
  matchUrl?: string | null;
  createdAt?: Date | string | null;
  expiresAt: Date | string;
  /** Stamped when a start claimed the room; cleared on success / release. */
  claimedAt?: Date | string | null;
  startedAt?: Date | string | null;
  closedAt?: Date | string | null;
}

/** A `private_room_members` row, plain and DB-free. */
export interface RoomMemberRecord {
  userId: string;
  role: string;
  inviteStatus: string;
  name?: string | null;
}

/**
 * The answer every rule gives.
 *
 * A PLAIN object with `ok: boolean`, not a discriminated union: this repo
 * compiles with `strict: false`, where narrowing a union on a boolean
 * discriminant does not behave as expected (the same note carried by
 * src/lib/auth/requireAgeVerified.ts). Callers test `if (!decision.ok)`.
 */
export interface Decision {
  ok: boolean;
  /** HTTP status the route answers with (when not `ok`). */
  status?: number;
  /** Stable machine code — the UI localises on THIS, never on the message. */
  code?: string;
  /** English fallback message; never shown raw to a FR/ES player. */
  message?: string;
  /** `decideInvite`: the invitation already exists (answer idempotently). */
  duplicate?: boolean;
  /** `decideRespond`: the answer was already recorded. */
  already?: "accepted" | "declined";
  /** `decideJoinByCode`: the caller already holds a seat. */
  alreadyIn?: boolean;
}

const ALLOW: Decision = Object.freeze({ ok: true }) as Decision;

function deny(status: number, code: string, message: string): Decision {
  return { ok: false, status, code, message };
}

/** The lifetime a kind of room is created with. */
export function ttlForKind(kind: string): number {
  return kind === "challenge" ? CHALLENGE_TTL_MS : ROOM_TTL_MS;
}

/** A stored timestamp as milliseconds, or null when it is not usable. */
export function toTime(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

/**
 * True when the room is past its expiry. An unparseable `expiresAt` counts as
 * expired: refusing to keep a room nobody can prove is current is the safe
 * reading, and the column is NOT NULL so this only happens on bad data.
 */
export function isExpired(room: RoomRecord, now: Date | number = Date.now()): boolean {
  const expires = toTime(room.expiresAt);
  if (expires === null) return true;
  const at = now instanceof Date ? now.getTime() : now;
  return expires <= at;
}

/** True when the room is still open for invitations / joins. */
export function isOpen(room: RoomRecord): boolean {
  return room.status === "open";
}

/** The status a lazy sweep must write, or null when the row is already right. */
export function sweptStatus(
  room: RoomRecord,
  now: Date | number = Date.now(),
): RoomStatus | null {
  if (room.status !== "open" && room.status !== "starting") return null;
  return isExpired(room, now) ? "expired" : null;
}

/**
 * How long a start may hold the room before it is considered abandoned. The
 * claim and the match creation happen in two steps (the game's own store owns
 * its own transaction), so an instance dying in between is possible — and a
 * room stuck in `starting` forever would be unstartable AND unjoinable.
 */
export const CLAIM_STALE_MS = 2 * 60 * 1000;

/**
 * True when a claim was taken but never resolved (no match was created). The
 * sweep releases it — for a PRO room at least, that just means the host can try
 * again, which is strictly better than a permanently wedged room.
 */
export function isStaleClaim(
  room: RoomRecord,
  now: Date | number = Date.now(),
): boolean {
  if (room.status !== "starting") return false;
  if (room.matchId) return false;
  const at = now instanceof Date ? now.getTime() : now;
  const claimed = toTime(room.claimedAt ?? room.createdAt);
  if (claimed === null) return true;
  return at - claimed > CLAIM_STALE_MS;
}

// ── Creating ────────────────────────────────────────────────────────────────

/**
 * Who may create what.
 *
 * `kind: "room"` is the PRO-only path — the check the requirement calls out
 * ("enforce this on the server at the room-creation endpoint, do not rely on
 * hiding a button"). `kind: "challenge"` is deliberately free: it cannot be
 * turned into a standalone room (no code, one invitee, fixed settings) and it
 * only ever exists because two friends are both present.
 */
export function decideCreateRoom({
  kind,
  tier,
}: {
  kind: string;
  /** The caller's server-resolved membership tier. */
  tier: string;
}): Decision {
  if (kind !== "room" && kind !== "challenge") {
    return deny(400, "invalid_kind", "Unknown room kind");
  }
  if (kind === "challenge") return ALLOW;
  if (tier !== "pro") {
    return deny(403, "pro_required", "GRYND PRO members can create private rooms");
  }
  return ALLOW;
}

// ── Reading ─────────────────────────────────────────────────────────────────

/** The caller's membership row, when they have one. */
export function memberOf(
  members: readonly RoomMemberRecord[],
  userId: string | null | undefined,
): RoomMemberRecord | null {
  if (!userId) return null;
  return members.find((m) => m.userId === userId) ?? null;
}

/** True when the caller is the host or an invited/joined guest. */
export function isParticipant(
  members: readonly RoomMemberRecord[],
  userId: string | null | undefined,
): boolean {
  return memberOf(members, userId) !== null;
}

/**
 * A room's details are visible to its participants ONLY.
 *
 * This is the IDOR rule from the requirement: knowing (or guessing) a room id
 * must not reveal the room, its code, its settings or its invited players to
 * somebody who was never invited. The route answers 403 with `not_a_member`.
 */
export function decideViewRoom({
  members,
  userId,
}: {
  members: readonly RoomMemberRecord[];
  userId: string | null | undefined;
}): Decision {
  if (!userId) return deny(401, "unauthenticated", "Sign in to view this room");
  if (!isParticipant(members, userId)) {
    return deny(403, "not_a_member", "You are not a participant in this room");
  }
  return ALLOW;
}

// ── Inviting ────────────────────────────────────────────────────────────────

/** Guests who accepted and are therefore expected on a seat. */
export function acceptedGuests(members: readonly RoomMemberRecord[]): RoomMemberRecord[] {
  return members.filter((m) => m.role === "guest" && m.inviteStatus === "accepted");
}

/** Guests invited but not yet answered. */
export function pendingGuests(members: readonly RoomMemberRecord[]): RoomMemberRecord[] {
  return members.filter((m) => m.role === "guest" && m.inviteStatus === "invited");
}

/**
 * Whether the host may invite one specific friend.
 *
 * Order matters: existence/authorization first (so an unrelated player learns
 * nothing about the room), then the room's state, then the invitee's
 * relationship and finally the capacity rules. The `duplicate` outcome is not
 * an error — a repeated invite is answered idempotently by the store — but an
 * invitee who already ACCEPTED is refused, because re-inviting must never
 * reset a seat somebody already holds.
 */
export function decideInvite({
  room,
  members,
  hostUserId,
  inviteeUserId,
  isFriend,
  now = Date.now(),
}: {
  room: RoomRecord;
  members: readonly RoomMemberRecord[];
  /** The authenticated caller. */
  hostUserId: string | null | undefined;
  /** The friend being invited. */
  inviteeUserId: string | null | undefined;
  /** Server-resolved friendship between the two accounts. */
  isFriend: boolean;
  now?: Date | number;
}): Decision {
  if (!hostUserId) return deny(401, "unauthenticated", "Sign in to invite a friend");
  if (!inviteeUserId) return deny(400, "missing_invitee", "Choose a friend to invite");
  if (hostUserId !== room.hostUserId) {
    return deny(403, "not_the_host", "Only the room's host can invite players");
  }
  if (inviteeUserId === room.hostUserId) {
    return deny(400, "cannot_invite_self", "You cannot invite yourself");
  }
  if (isExpired(room, now)) {
    return deny(410, "room_expired", "This room has expired");
  }
  if (!isOpen(room)) {
    return deny(409, "room_not_open", "This room is no longer accepting players");
  }
  if (!isFriend) {
    return deny(403, "not_a_friend", "You can only invite players on your friends list");
  }

  const existing = memberOf(members, inviteeUserId);
  if (existing) {
    if (existing.inviteStatus === "accepted") {
      return deny(409, "already_joined", "That player is already in this room");
    }
    // An outstanding invitation is idempotent; a declined one may be re-sent.
    if (existing.inviteStatus === "invited") {
      return { ...ALLOW, duplicate: true };
    }
  } else {
    const guests = members.filter((m) => m.role === "guest").length;
    if (room.kind === "challenge") {
      // A challenge is structurally ONE invitee: it is a direct challenge, not
      // a room, and it never becomes one.
      return deny(409, "challenge_single_invitee", "A challenge goes to one friend");
    }
    if (guests >= ROOM_MAX_INVITES) {
      return deny(409, "room_full", "This room already has the maximum number of invites");
    }
  }

  return ALLOW;
}

// ── Joining by code ─────────────────────────────────────────────────────────

/**
 * Whether an authenticated player may join a room by its code.
 *
 * FREE PLAYERS ARE WELCOME: only CREATION is Pro-gated, so this checks the
 * room's state, not the caller's membership. A `challenge` is refused
 * explicitly (`challenge_not_joinable`) because it has no code to share and
 * exists for exactly one invitee.
 */
export function decideJoinByCode({
  room,
  members,
  userId,
  now = Date.now(),
}: {
  room: RoomRecord;
  members: readonly RoomMemberRecord[];
  userId: string | null | undefined;
  now?: Date | number;
}): Decision {
  if (!userId) return deny(401, "unauthenticated", "Sign in to join this room");
  if (room.kind !== "room") {
    return deny(403, "challenge_not_joinable", "This challenge was not shared with you");
  }
  if (isExpired(room, now)) {
    return deny(410, "room_expired", "This room has expired");
  }
  if (room.status === "cancelled" || room.status === "declined") {
    return deny(409, "room_closed", "This room was closed");
  }
  if (room.status === "started" || room.status === "starting") {
    // Once the match exists only its own players may re-enter it — and only
    // through the match they were sent to, never by re-joining the room.
    if (acceptedSeats(members).some((m) => m.userId === userId)) {
      return { ...ALLOW, alreadyIn: true };
    }
    return deny(409, "room_started", "This room's match already started");
  }
  if (room.status !== "open") {
    return deny(409, "room_not_open", "This room is no longer joinable");
  }

  const existing = memberOf(members, userId);
  if (existing?.role === "host") {
    return { ...ALLOW, alreadyIn: true };
  }
  if (existing?.inviteStatus === "accepted") {
    return { ...ALLOW, alreadyIn: true };
  }

  if (acceptedSeats(members).length >= seatCount(room)) {
    return deny(409, "room_full", "This room is already full");
  }

  return ALLOW;
}

/**
 * The seats a room fills, from the game's own catalog entry. Every supported
 * game is a 2-seat duel today; reading it from the catalog means a game that
 * gains a third seat needs no change here.
 */
export function seatCount(room: RoomRecord): number {
  const seats = getRoomGame(room.gameKey)?.seats;
  return Number.isFinite(seats) && (seats as number) > 0 ? (seats as number) : 2;
}

/** Host + accepted guests: the players who actually hold a seat. */
export function acceptedSeats(members: readonly RoomMemberRecord[]): RoomMemberRecord[] {
  return members.filter(
    (m) => m.role === "host" || (m.role === "guest" && m.inviteStatus === "accepted"),
  );
}

// ── Responding to an invitation / challenge ─────────────────────────────────

/**
 * Whether the caller may answer an invitation (accept or decline).
 *
 * Only the INVITEE can answer, a repeated answer is idempotent rather than an
 * error, and an invitation that can no longer produce a match (expired, or the
 * room already started) is refused. This is the rule that stops a replayed
 * acceptance from being processed twice — the store then re-checks it with an
 * atomic claim, so even two simultaneous acceptances can only mint one match.
 */
export function decideRespond({
  room,
  members,
  userId,
  accepts = true,
  now = Date.now(),
}: {
  room: RoomRecord;
  members: readonly RoomMemberRecord[];
  userId: string | null | undefined;
  /** True when the answer is "accept" (which needs a free seat). */
  accepts?: boolean;
  now?: Date | number;
}): Decision {
  if (!userId) return deny(401, "unauthenticated", "Sign in to answer this invitation");
  const member = memberOf(members, userId);
  if (!member || member.role !== "guest") {
    return deny(403, "not_invited", "This invitation was not addressed to you");
  }
  if (member.inviteStatus === "accepted") {
    return { ...ALLOW, already: "accepted" };
  }
  if (member.inviteStatus === "declined") {
    return { ...ALLOW, already: "declined" };
  }
  if (isExpired(room, now)) {
    return deny(410, "invitation_expired", "This invitation has expired");
  }
  if (room.status === "started") {
    return deny(409, "room_started", "This match already started");
  }
  if (room.status === "cancelled") {
    return deny(409, "room_closed", "This room was closed");
  }
  if (room.status === "declined" && room.kind === "challenge") {
    return deny(409, "already_declined", "This challenge was already declined");
  }
  if (room.status !== "open") {
    return deny(409, "room_not_open", "This invitation is no longer actionable");
  }
  if (accepts && acceptedSeats(members).length >= seatCount(room)) {
    // The seat went to another invited friend. First acceptance wins — the room
    // is a two-seat duel however many friends the host invited.
    return deny(409, "room_full", "This room is already full");
  }
  return ALLOW;
}

// ── Starting, claiming, cancelling ──────────────────────────────────────────

/**
 * Whether the host may start a PRO room now.
 *
 * "Start when its actual player and readiness requirements are met" — for every
 * supported game that means exactly one accepted opponent on the second seat.
 * A `challenge` is never started this way: the FRIEND's acceptance starts it.
 */
export function decideStart({
  room,
  members,
  userId,
  now = Date.now(),
}: {
  room: RoomRecord;
  members: readonly RoomMemberRecord[];
  userId: string | null | undefined;
  now?: Date | number;
}): Decision {
  if (!userId) return deny(401, "unauthenticated", "Sign in to start this room");
  if (userId !== room.hostUserId) {
    return deny(403, "not_the_host", "Only the room's host can start the match");
  }
  if (room.kind !== "room") {
    return deny(409, "challenge_auto_starts", "A challenge starts when your friend accepts");
  }
  if (isExpired(room, now)) {
    return deny(410, "room_expired", "This room has expired");
  }
  if (room.status === "started") {
    return deny(409, "already_started", "This match already started");
  }
  if (room.status !== "open") {
    return deny(409, "room_not_open", "This room cannot be started");
  }
  if (acceptedGuests(members).length < 1) {
    return deny(409, "need_opponent", "Wait for a friend to accept your invitation");
  }
  return ALLOW;
}

/**
 * Whether the room may be claimed for a start RIGHT NOW. This is the front half
 * of the atomic claim: the store repeats the check inside
 * `UPDATE … WHERE status = 'open'`, so the winner of that UPDATE is the only
 * caller that creates a match — a duplicate start or two simultaneous
 * acceptances lose the race and are answered, never both acted on.
 */
export function decideClaim(room: RoomRecord, now: Date | number = Date.now()): Decision {
  if (isExpired(room, now)) {
    return deny(410, "room_expired", "This room has expired");
  }
  if (room.status === "started") {
    return deny(409, "already_started", "This match already started");
  }
  if (room.status !== "open") {
    return deny(409, "room_not_open", "This room cannot be started");
  }
  return ALLOW;
}

/** Whether the caller may cancel / close the room. Host only, while open. */
export function decideCancel({
  room,
  userId,
}: {
  room: RoomRecord;
  userId: string | null | undefined;
}): Decision {
  if (!userId) return deny(401, "unauthenticated", "Sign in to close this room");
  if (userId !== room.hostUserId) {
    return deny(403, "not_the_host", "Only the room's host can close it");
  }
  if (room.status === "started") {
    return deny(409, "already_started", "This room already became a match");
  }
  if (room.status !== "open" && room.status !== "starting") {
    return deny(409, "room_not_open", "This room is already closed");
  }
  return ALLOW;
}

/**
 * The status a room takes after a failed match creation.
 *
 * A PRO room goes back to `open` (the host can fix the stake and retry); a
 * challenge is terminal (`failed`) because the friend already answered and
 * nothing is left to retry. Neither keeps a match that does not exist.
 */
export function statusAfterFailure(kind: string): RoomStatus {
  return kind === "challenge" ? "failed" : "open";
}

/** The status a room takes once its match exists. */
export function statusAfterStart(): RoomStatus {
  return "started";
}

/** True when the status means "nothing more will happen here". */
export function isClosedStatus(status: string): boolean {
  return status !== "open" && status !== "starting";
}
