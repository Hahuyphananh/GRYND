// src/lib/rooms/store.ts
//
// THE data layer for private rooms and friend challenges: every read and write
// against `private_rooms` / `private_room_members`, and the only place that
// turns a stored row into what an API response is allowed to say.
//
// DIVISION OF LABOUR:
//   * src/lib/rooms/rules.ts  decides (pure, unit-tested authorization rules),
//   * src/lib/rooms/settings.ts decides what settings are legal (pure),
//   * src/lib/rooms/games.ts  creates the real match in the game's own store,
//   * THIS FILE               writes the rows those decisions authorise, and
//                             re-checks every rule inside the transaction that
//                             commits the change where the race matters.
//
// CONCURRENCY (three races, three mechanisms):
//   1. two joins for the last seat  — the room row is locked (`FOR UPDATE`) and
//      the seat count is re-read inside that transaction, so the second joiner
//      sees the first one's membership row.
//   2. two acceptances of a challenge — the claim is a single conditional
//      `UPDATE … WHERE status = 'open' RETURNING`, so exactly one caller wins
//      and mints a match; the loser is answered with the winner's match.
//   3. two duplicate starts — same conditional claim, and the loser either
//      re-reads the finished room (idempotent) or is refused.
//
// IDENTITY: every caller passes the Clerk id it authenticated. Nothing here
// reads an id, a code, a status or a match id from a request body, and nothing
// here trusts one.
//
// EXPIRY AND STALE CLAIMS are swept lazily (`sweepRooms`) before the reads and
// writes that care, so correctness never depends on a cron being alive.

import { and, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import { db } from "../../db";
import {
  friendRelations,
  privateRoomMembers,
  privateRooms,
  users,
} from "../../db/schema";
import {
  CHALLENGE_TTL_MS,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  ROOM_TTL_MS,
  getRoomGame,
} from "./catalog";
import { createPairMatch, type PairMatchResult } from "./games";
import { notifyRoomsChanged } from "./notify";
import {
  CLAIM_STALE_MS,
  acceptedSeats,
  decideCancel,
  decideClaim,
  decideCreateRoom,
  decideInvite,
  decideJoinByCode,
  decideRespond,
  decideStart,
  decideViewRoom,
  memberOf,
  statusAfterFailure,
  type Decision,
  type RoomMemberRecord,
  type RoomRecord,
} from "./rules";
import {
  challengeSettings,
  resolveRoomSettings,
  type RoomSettings,
  type SettingsResult,
} from "./settings";

export type { RoomSettings } from "./settings";

/** The subset of a `private_rooms` row this module works with. */
type RoomRow = typeof privateRooms.$inferSelect;
type MemberRow = typeof privateRoomMembers.$inferSelect;

// The wire shapes live in ./types so the CLIENT can name what it renders
// without importing this module (which owns the database client).
export type { RoomMemberView, RoomRole, RoomView } from "./types";
import type { RoomRole, RoomView } from "./types";

// PLAIN result objects rather than unions: this repo compiles with
// `strict: false`, where narrowing a union on a boolean discriminant does not
// behave as expected (see the note in src/lib/auth/requireAgeVerified.ts).
// Callers test `if (!result.ok)` and read the optional fields.
export interface StoreFailure {
  ok: boolean;
  /** Present when not `ok`. */
  status?: number;
  code?: string;
  message?: string;
}

export interface RoomResult extends StoreFailure {
  /** Present when `ok`. */
  room?: RoomView;
  duplicate?: boolean;
}

export interface RoomListResult extends StoreFailure {
  rooms?: RoomView[];
}

export interface StartResult extends RoomResult {
  matchId?: string;
  matchUrl?: string;
  started?: boolean;
}

// ── Small helpers ───────────────────────────────────────────────────────────

/** Postgres unique-violation, i.e. a room code that was already taken. */
function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  if (code === "23505") return true;
  return /duplicate key value/i.test(String((error as Error | null)?.message ?? ""));
}

/**
 * A shareable room code: `ROOM_CODE_LENGTH` characters from a 32-symbol
 * alphabet (no I/O/0/1, so it survives being read aloud). 32 bytes % 32 has no
 * modulo bias, so the draw is uniform; the database's partial unique index on
 * `code` is what makes a collision impossible rather than unlikely.
 */
export function generateRoomCode(length = ROOM_CODE_LENGTH): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += ROOM_CODE_ALPHABET[bytes[i] % ROOM_CODE_ALPHABET.length];
  }
  return out;
}

/** Uppercase a typed/shared code and drop separators, so `ab-cd ef` works. */
export function normalizeRoomCode(raw: unknown): string {
  const cleaned = String(raw ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  // Only the alphabet's symbols can spell a real code; anything else is a typo
  // and is rejected here rather than looked up (a cheap enumeration guard).
  const valid = cleaned.split("").every((ch) => ROOM_CODE_ALPHABET.includes(ch));
  return valid ? cleaned : "";
}

function toIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** A `private_rooms` row as the rules see it. */
function asRoomRecord(row: RoomRow): RoomRecord {
  return {
    id: row.id,
    code: row.code,
    kind: row.kind,
    hostUserId: row.hostUserId,
    gameKey: row.gameKey,
    mode: row.mode,
    settings: row.settings as unknown as RoomSettings,
    status: row.status,
    matchId: row.matchId,
    matchUrl: row.matchUrl,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    claimedAt: row.claimedAt,
    startedAt: row.startedAt,
    closedAt: row.closedAt,
  };
}

/** A `private_room_members` row as the rules see it. */
function asMemberRecord(row: MemberRow): RoomMemberRecord {
  return {
    userId: row.userId,
    role: row.role,
    inviteStatus: row.inviteStatus,
    name: row.name,
  };
}

/** The settings a room actually runs with (never what a body asked for). */
function settingsOf(row: RoomRow): RoomSettings {
  const raw = row.settings as { stake?: unknown } | null;
  if (row.kind === "challenge") return challengeSettings();
  const resolved = resolveRoomSettings(row.gameKey, raw);
  if (resolved.ok) return resolved.settings;
  // Stored settings are validated on write; if the catalog ever changes under
  // them, a room falls back to free play rather than to an illegal stake.
  return { stake: 0 };
}

function viewOf(
  row: RoomRow,
  memberRows: readonly MemberRow[],
  viewerId: string | null,
): RoomView {
  const game = getRoomGame(row.gameKey);
  const settings = settingsOf(row);
  const memberRecords = memberRows.map(asMemberRecord);
  const mine = memberOf(memberRecords, viewerId);
  const seats = game?.seats ?? 2;
  const accepted = acceptedSeats(memberRecords).length;
  // The seat the HOST does not occupy. Starting needs at least one of them
  // taken, which is the house's whole readiness rule (see decideStart).
  const acceptedGuests = memberRecords.filter(
    (m) => m.role === "guest" && m.inviteStatus === "accepted",
  ).length;

  return {
    id: row.id,
    code: row.code,
    kind: row.kind,
    hostUserId: row.hostUserId,
    gameKey: row.gameKey,
    gameLabel: game?.label ?? null,
    mode: row.mode,
    settings,
    status: row.status,
    matchId: row.matchId,
    matchUrl: row.matchUrl,
    seats,
    createdAt: toIso(row.createdAt) ?? "",
    expiresAt: toIso(row.expiresAt) ?? "",
    startedAt: toIso(row.startedAt),
    closedAt: toIso(row.closedAt),
    members: memberRows.map((m) => ({
      userId: m.userId,
      role: m.role as RoomRole,
      inviteStatus: m.inviteStatus,
      name: m.name,
      isHost: m.role === "host",
      isYou: Boolean(viewerId) && m.userId === viewerId,
    })),
    role: (mine?.role as RoomRole) ?? null,
    inviteStatus: mine?.inviteStatus ?? null,
    isHost: Boolean(viewerId) && row.hostUserId === viewerId,
    canStart:
      row.kind === "room" &&
      row.status === "open" &&
      Boolean(viewerId) &&
      row.hostUserId === viewerId &&
      acceptedGuests >= 1,
    acceptedSeatCount: accepted,
  };
}

function failure(decision: Decision): StoreFailure {
  return {
    ok: false,
    status: decision.status ?? 400,
    code: decision.code ?? "room_denied",
    message: decision.message ?? "This action is not allowed",
  };
}

function notFound(): StoreFailure {
  return { ok: false, status: 404, code: "room_not_found", message: "Room not found" };
}

/** The settings a room is created with, or the reason it cannot be created. */
function settingsForCreate(
  kind: "room" | "challenge",
  gameKey: string,
  rawSettings: unknown,
): SettingsResult {
  if (kind === "challenge") {
    // Server-chosen: a free challenge is always a free match.
    return { ok: true, settings: challengeSettings() };
  }
  return resolveRoomSettings(gameKey, rawSettings);
}

// ── Lazy sweep ──────────────────────────────────────────────────────────────

/**
 * Expire rooms whose time is up, and release claims that were abandoned.
 *
 * Called before the reads and writes that depend on a fresh status, so no cron
 * is required for correctness. Both statements are conditional and indexed
 * (`status, expires_at`), and both are idempotent: a room already `expired` or
 * already released is simply not matched again.
 */
export async function sweepRooms(now: Date = new Date()): Promise<void> {
  try {
    await db
      .update(privateRooms)
      .set({ status: "expired", closedAt: now, claimedAt: null })
      .where(
        and(
          or(eq(privateRooms.status, "open"), eq(privateRooms.status, "starting")),
          lt(privateRooms.expiresAt, now),
        ),
      );

    // A claim older than CLAIM_STALE_MS with no match behind it means the
    // instance creating the match died. Releasing it makes the room startable /
    // joinable again instead of permanently wedged.
    const staleBefore = new Date(now.getTime() - CLAIM_STALE_MS);
    await db
      .update(privateRooms)
      .set({ status: "open", claimedAt: null })
      .where(
        and(
          eq(privateRooms.status, "starting"),
          sql`${privateRooms.matchId} IS NULL`,
          lt(privateRooms.claimedAt, staleBefore),
        ),
      );
  } catch (error) {
    // A failed sweep must never fail the request that triggered it: the rules
    // re-check `expires_at` themselves, so the worst case is a stale label.
    console.warn(
      "[rooms] sweep failed:",
      error instanceof Error ? error.message : error,
    );
  }
}

// ── Reads ───────────────────────────────────────────────────────────────────

async function membersOf(roomId: string): Promise<MemberRow[]> {
  return db
    .select()
    .from(privateRoomMembers)
    .where(eq(privateRoomMembers.roomId, roomId))
    .orderBy(privateRoomMembers.role, privateRoomMembers.invitedAt);
}

async function roomById(roomId: string): Promise<RoomRow | null> {
  if (!isUuid(roomId)) return null;
  const [row] = await db
    .select()
    .from(privateRooms)
    .where(eq(privateRooms.id, roomId))
    .limit(1);
  return row ?? null;
}

/** UUID shape test — an unparseable id is "not found", never a query. */
export function isUuid(value: unknown): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value ?? ""),
  );
}

/**
 * The room a caller asked for, with its members, WITHOUT any authorization —
 * private to this module. Callers must pass the result through
 * `decideViewRoom` (or a rule of their own) before answering.
 */
async function loadRoom(
  roomId: string,
): Promise<{ room: RoomRow; members: MemberRow[] } | null> {
  const room = await roomById(roomId);
  if (!room) return null;
  return { room, members: await membersOf(room.id) };
}

/**
 * GET /api/rooms/[roomId] — the room status, for participants only.
 *
 * A non-participant is refused (403 `not_a_member`) rather than told the room
 * does not exist, and the code / member list / settings are never part of the
 * answer to somebody who was not invited.
 */
export async function getRoomForViewer({
  roomId,
  userId,
}: {
  roomId: string;
  userId: string | null | undefined;
}): Promise<RoomResult> {
  await sweepRooms();
  const loaded = await loadRoom(roomId);
  if (!loaded) return notFound();

  const view = decideViewRoom({
    members: loaded.members.map(asMemberRecord),
    userId,
  });
  if (!view.ok) return failure(view);

  return { ok: true, room: viewOf(loaded.room, loaded.members, userId ?? null) };
}

/**
 * The caller's rooms and invitations: the rooms they host, plus every room they
 * were invited to, inside a recent window.
 *
 * WHY A WINDOW: a declined, expired or failed room has to stay visible for its
 * participants long enough to be seen ("show pending, accepted, declined,
 * expired and failed states"), but an invitation answered weeks ago is noise.
 */
const ROOM_LIST_WINDOW_MS = 24 * 60 * 60 * 1000;

export async function listRoomsFor({
  userId,
}: {
  userId: string | null | undefined;
}): Promise<RoomListResult> {
  if (!userId) {
    return { ok: false, status: 401, code: "unauthenticated", message: "Sign in to view your rooms" };
  }
  await sweepRooms();

  const since = new Date(Date.now() - ROOM_LIST_WINDOW_MS);
  // One membership row per (room, user) — the unique index guarantees it — so
  // this join needs no DISTINCT.
  const rows = await db
    .select({ room: privateRooms })
    .from(privateRooms)
    .innerJoin(privateRoomMembers, eq(privateRoomMembers.roomId, privateRooms.id))
    .where(
      and(
        eq(privateRoomMembers.userId, userId),
        sql`${privateRooms.createdAt} > ${since}`,
      ),
    )
    .orderBy(desc(privateRooms.createdAt))
    .limit(50);

  const roomRows = rows.map((r) => r.room);
  if (roomRows.length === 0) return { ok: true, rooms: [] };

  const ids = roomRows.map((r) => r.id);
  const memberRows = await db
    .select()
    .from(privateRoomMembers)
    .where(inArray(privateRoomMembers.roomId, ids));

  const byRoom = new Map<string, MemberRow[]>();
  for (const member of memberRows) {
    const list = byRoom.get(member.roomId);
    if (list) list.push(member);
    else byRoom.set(member.roomId, [member]);
  }

  return {
    ok: true,
    rooms: roomRows.map((row) => viewOf(row, byRoom.get(row.id) ?? [], userId)),
  };
}

// ── Creating ────────────────────────────────────────────────────────────────

/** The display name stored alongside an invitation (never an identity). */
async function nameFor(clerkId: string): Promise<string | null> {
  const [row] = await db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.clerkId, clerkId))
    .limit(1);
  const name = String(row?.name ?? "").replace(/\s+/g, " ").trim();
  return name ? name.slice(0, 40) : null;
}

/**
 * Create a room (`kind: "room"`, PRO only — the caller passes its own
 * server-resolved tier) or a direct challenge (`kind: "challenge"`, free).
 *
 * The host's own membership row is written in the same transaction, with
 * `invite_status = 'accepted'`: the creator is on a seat by definition, so
 * "is this room full?" is answered by the same table as every guest.
 */
export async function createRoom({
  hostUserId,
  gameKey,
  kind,
  tier,
  rawSettings,
}: {
  hostUserId: string;
  gameKey: string;
  kind: "room" | "challenge";
  tier: string;
  rawSettings?: unknown;
}): Promise<RoomResult> {
  const gate = decideCreateRoom({ kind, tier });
  if (!gate.ok) return failure(gate);

  const game = getRoomGame(gameKey);
  if (!game) {
    return { ok: false, status: 400, code: "unknown_game", message: "Unsupported game for a private room" };
  }

  // A challenge's settings are the SERVER's; a room's are validated.
  const settingsResult = settingsForCreate(kind, gameKey, rawSettings);
  if (!settingsResult.ok) {
    return {
      ok: false,
      status: settingsResult.status ?? 400,
      code: "invalid_settings",
      message: settingsResult.message ?? "Invalid room settings",
    };
  }
  const roomSettings = settingsResult.settings as RoomSettings;

  const now = new Date();
  const expiresAt = new Date(now.getTime() + (kind === "challenge" ? CHALLENGE_TTL_MS : ROOM_TTL_MS));
  const hostName = await nameFor(hostUserId);

  // Codes are unique by index, so a collision (astronomically unlikely) is
  // retried rather than reported.
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = kind === "room" ? generateRoomCode() : null;
    try {
      const created = await db.transaction(async (tx) => {
        const [room] = await tx
          .insert(privateRooms)
          .values({
            code,
            kind,
            hostUserId,
            gameKey: game.key,
            mode: game.mode,
            // jsonb column typed as a flat record; the object is the validated
            // settings this module already resolved.
            settings: roomSettings as unknown as Record<string, string | number>,
            status: "open",
            createdAt: now,
            expiresAt,
          })
          .returning();

        await tx.insert(privateRoomMembers).values({
          roomId: room.id,
          userId: hostUserId,
          role: "host",
          inviteStatus: "accepted",
          name: hostName,
          invitedAt: now,
          respondedAt: now,
          joinedAt: now,
        });

        return room;
      });

      const members = await membersOf(created.id);
      return { ok: true, room: viewOf(created, members, hostUserId) };
    } catch (error) {
      lastError = error;
      if (!isUniqueViolation(error)) throw error;
    }
  }

  console.warn("[rooms] could not allocate a room code", lastError);
  return {
    ok: false,
    status: 503,
    code: "code_unavailable",
    message: "Could not create the room right now, please try again",
  };
}

// ── Inviting ────────────────────────────────────────────────────────────────

/** The numeric `users.id` behind a Clerk id, or null when there is no account. */
async function userIdFor(clerkId: string): Promise<number | null> {
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.clerkId, clerkId))
    .limit(1);
  return row ? Number(row.id) : null;
}

/**
 * Server-resolved friendship between two accounts.
 *
 * `friend_relations` is (user_id, friend_id) with numeric user ids, while rooms
 * are keyed by Clerk id, so the two ids are resolved first — and BOTH
 * directions are checked, because a friendship row only has to exist one way
 * for the Friends tab to show it (`/api/friends/list` reads one direction).
 * The invitee's Clerk id can therefore never be used as a permission by itself.
 */
export async function areFriends(
  a: string | null | undefined,
  b: string | null | undefined,
): Promise<boolean> {
  if (!a || !b || a === b) return false;

  const [meId, themId] = await Promise.all([userIdFor(a), userIdFor(b)]);
  if (meId === null || themId === null) return false;

  const [direct] = await db
    .select({ id: friendRelations.id })
    .from(friendRelations)
    .where(and(eq(friendRelations.userId, meId), eq(friendRelations.friendId, themId)))
    .limit(1);
  if (direct) return true;

  const [reverse] = await db
    .select({ id: friendRelations.id })
    .from(friendRelations)
    .where(and(eq(friendRelations.userId, themId), eq(friendRelations.friendId, meId)))
    .limit(1);
  return Boolean(reverse);
}

/**
 * Invite one friend. Host only, friend only, room open and unexpired.
 *
 * `ON CONFLICT DO UPDATE` is what makes a repeated invite idempotent AND
 * re-sends a declined one — but the rule above already refused an invitee who
 * ACCEPTED, so a seat somebody holds can never be reset by re-inviting.
 */
export async function inviteToRoom({
  roomId,
  hostUserId,
  inviteeUserId,
}: {
  roomId: string;
  hostUserId: string;
  inviteeUserId: string;
}): Promise<RoomResult> {
  await sweepRooms();
  const loaded = await loadRoom(roomId);
  if (!loaded) return notFound();

  const isFriend =
    inviteeUserId === hostUserId ? false : await areFriends(hostUserId, inviteeUserId);

  const decision = decideInvite({
    room: asRoomRecord(loaded.room),
    members: loaded.members.map(asMemberRecord),
    hostUserId,
    inviteeUserId,
    isFriend,
  });
  if (!decision.ok) return failure(decision);

  if (decision.duplicate) {
    return { ok: true, room: viewOf(loaded.room, loaded.members, hostUserId), duplicate: true };
  }

  const now = new Date();
  const inviteeName = await nameFor(inviteeUserId);
  await db
    .insert(privateRoomMembers)
    .values({
      roomId: loaded.room.id,
      userId: inviteeUserId,
      role: "guest",
      inviteStatus: "invited",
      name: inviteeName,
      invitedAt: now,
    })
    .onConflictDoUpdate({
      target: [privateRoomMembers.roomId, privateRoomMembers.userId],
      set: {
        inviteStatus: "invited",
        role: "guest",
        name: inviteeName,
        invitedAt: now,
        respondedAt: null,
        joinedAt: null,
      },
      // The unique index is (room_id, user_id); only a guest row may be reset.
      where: eq(privateRoomMembers.role, "guest"),
    });

  await notifyRoomsChanged([inviteeUserId]);

  const members = await membersOf(loaded.room.id);
  return { ok: true, room: viewOf(loaded.room, members, hostUserId) };
}

// ── Responding (accept / decline) ───────────────────────────────────────────

/**
 * Answer an invitation.
 *
 * A DECLINE just marks the guest's row (and closes a declined CHALLENGE, which
 * has nothing left to do). An ACCEPT of a challenge claims the room in the same
 * transaction with a conditional UPDATE, and the match itself is created after
 * that commit by `startClaimedRoom` — so a double click, a replayed request or
 * two simultaneous acceptances can only ever produce ONE match.
 */
export async function respondToInvite({
  roomId,
  userId,
  accept,
}: {
  roomId: string;
  userId: string;
  accept: boolean;
}): Promise<RoomResult & { start?: boolean }> {
  await sweepRooms();

  const claimed = await db.transaction(async (tx) => {
    const [room] = await tx
      .select()
      .from(privateRooms)
      .where(eq(privateRooms.id, roomId))
      .for("update")
      .limit(1);
    if (!room) return { missing: true as const };

    const members = await tx
      .select()
      .from(privateRoomMembers)
      .where(eq(privateRoomMembers.roomId, roomId));

    const decision = decideRespond({
      room: asRoomRecord(room),
      members: members.map(asMemberRecord),
      userId,
      accepts: accept,
    });

    if (decision.already === "accepted") {
      // Idempotent: the answer was already recorded. If the match exists, the
      // caller is simply sent back to it; if the claim was never finished, the
      // caller gets another chance to finish it.
      return {
        room,
        members,
        alreadyAccepted: true as const,
        claim: room.status === "open" && room.kind === "challenge",
      };
    }
    if (decision.already === "declined") {
      return { room, members, alreadyDeclined: true as const };
    }
    if (!decision.ok) return { denied: decision };

    const now = new Date();
    await tx
      .update(privateRoomMembers)
      .set({
        inviteStatus: accept ? "accepted" : "declined",
        respondedAt: now,
        joinedAt: accept ? now : null,
      })
      .where(
        and(
          eq(privateRoomMembers.roomId, roomId),
          eq(privateRoomMembers.userId, userId),
          eq(privateRoomMembers.inviteStatus, "invited"),
        ),
      );

    if (!accept && room.kind === "challenge") {
      // A declined challenge is over for everyone.
      const [closed] = await tx
        .update(privateRooms)
        .set({ status: "declined", closedAt: now, claimedAt: null })
        .where(and(eq(privateRooms.id, roomId), eq(privateRooms.status, "open")))
        .returning();
      const rows = await tx
        .select()
        .from(privateRoomMembers)
        .where(eq(privateRoomMembers.roomId, roomId));
      return { room: closed ?? room, members: rows, declined: true as const };
    }

    if (accept && room.kind === "challenge") {
      // The claim: exactly one accept wins it.
      const [claimedRoom] = await tx
        .update(privateRooms)
        .set({ status: "starting", claimedAt: now })
        .where(
          and(
            eq(privateRooms.id, roomId),
            eq(privateRooms.status, "open"),
            sql`${privateRooms.expiresAt} > ${now}`,
          ),
        )
        .returning();
      const rows = await tx
        .select()
        .from(privateRoomMembers)
        .where(eq(privateRoomMembers.roomId, roomId));
      if (!claimedRoom) {
        return { room, members: rows, accepted: true as const, claimLost: true as const };
      }
      return { room: claimedRoom, members: rows, accepted: true as const, claimed: true as const };
    }

    const rows = await tx
      .select()
      .from(privateRoomMembers)
      .where(eq(privateRoomMembers.roomId, roomId));
    return { room, members: rows, accepted: accept };
  });

  if ("missing" in claimed) return notFound();
  if ("denied" in claimed && claimed.denied) return failure(claimed.denied);

  if ("declined" in claimed && claimed.declined) {
    await notifyRoomsChanged([claimed.room.hostUserId]);
    return { ok: true, room: viewOf(claimed.room, claimed.members, userId) };
  }

  if ("claimLost" in claimed && claimed.claimLost) {
    // Somebody (or this same click's twin) claimed it first: answer with the
    // room's real state instead of starting a second match.
    const fresh = await roomById(roomId);
    const rows = fresh ? await membersOf(roomId) : claimed.members;
    return { ok: true, room: viewOf(fresh ?? claimed.room, rows, userId) };
  }

  if ("claimed" in claimed && claimed.claimed) {
    const started = await startClaimedRoom({ roomId, actorUserId: userId });
    if (!started.ok) return started;
    return { ok: true, room: started.room, start: true };
  }

  await notifyRoomsChanged([claimed.room.hostUserId]);
  return { ok: true, room: viewOf(claimed.room, claimed.members, userId) };
}

// ── Joining by code ─────────────────────────────────────────────────────────

/**
 * Join a room by its shared code. Free players are welcome: only CREATION is
 * Pro-gated, and every rule that matters (open, unexpired, not full, not a
 * challenge) is re-checked inside the transaction that locks the room row.
 */
export async function joinRoomByCode({
  code,
  userId,
}: {
  code: string;
  userId: string;
}): Promise<RoomResult> {
  await sweepRooms();
  const normalized = normalizeRoomCode(code);
  if (normalized.length !== ROOM_CODE_LENGTH) {
    return { ok: false, status: 404, code: "room_not_found", message: "No room matches that code" };
  }

  const [found] = await db
    .select()
    .from(privateRooms)
    .where(eq(privateRooms.code, normalized))
    .limit(1);
  if (!found) {
    return { ok: false, status: 404, code: "room_not_found", message: "No room matches that code" };
  }

  const joined = await db.transaction(async (tx) => {
    const [room] = await tx
      .select()
      .from(privateRooms)
      .where(eq(privateRooms.id, found.id))
      .for("update")
      .limit(1);
    if (!room) return { missing: true as const };

    const members = await tx
      .select()
      .from(privateRoomMembers)
      .where(eq(privateRoomMembers.roomId, room.id));

    const decision = decideJoinByCode({
      room: asRoomRecord(room),
      members: members.map(asMemberRecord),
      userId,
    });
    if (!decision.ok) return { denied: decision };
    if (decision.alreadyIn) {
      return { room, members, alreadyIn: true as const };
    }

    const now = new Date();
    const name = await nameFor(userId);
    await tx
      .insert(privateRoomMembers)
      .values({
        roomId: room.id,
        userId,
        role: "guest",
        inviteStatus: "accepted",
        name,
        invitedAt: now,
        respondedAt: now,
        joinedAt: now,
      })
      .onConflictDoUpdate({
        target: [privateRoomMembers.roomId, privateRoomMembers.userId],
        set: {
          inviteStatus: "accepted",
          role: "guest",
          name,
          respondedAt: now,
          joinedAt: now,
        },
      });

    const rows = await tx
      .select()
      .from(privateRoomMembers)
      .where(eq(privateRoomMembers.roomId, room.id));
    return { room, members: rows, joined: true as const };
  });

  if ("missing" in joined) return notFound();
  if ("denied" in joined && joined.denied) return failure(joined.denied);

  if ("joined" in joined && joined.joined) {
    await notifyRoomsChanged([joined.room.hostUserId]);
  }
  return { ok: true, room: viewOf(joined.room, joined.members, userId) };
}

// ── Starting ────────────────────────────────────────────────────────────────

/**
 * Finish a claimed start: create the real match in the game's own store, then
 * record where it is.
 *
 * The two steps are separate on purpose — the claim is ours, the match is the
 * GAME's, and it owns its own transaction. A failure releases the room
 * (`statusAfterFailure`) and clears the claim rather than leaving a room that
 * advertises a match nobody can be sent to.
 */
async function startClaimedRoom({
  roomId,
  actorUserId,
}: {
  roomId: string;
  actorUserId: string;
}): Promise<StartResult> {
  const room = await roomById(roomId);
  if (!room) return notFound();
  if (!room.matchId && room.status !== "starting") {
    // Not claimed (any more) — report the room's real state.
    const members = await membersOf(room.id);
    return { ok: true, room: viewOf(room, members, actorUserId), matchId: "", matchUrl: "", started: false };
  }
  if (room.matchId && room.matchUrl) {
    const members = await membersOf(room.id);
    return {
      ok: true,
      room: viewOf(room, members, actorUserId),
      matchId: room.matchId,
      matchUrl: room.matchUrl,
      started: true,
    };
  }

  const members = await membersOf(room.id);
  const host = members.find((m) => m.role === "host");
  const opponent =
    members.find((m) => m.role === "guest" && m.inviteStatus === "accepted") ?? null;

  if (!host || !opponent) {
    await releaseRoom(room, actorUserId);
    return {
      ok: false,
      status: 409,
      code: "need_opponent",
      message: "This room has no opponent on its second seat",
    };
  }

  const result: PairMatchResult = await createPairMatch({
    gameKey: room.gameKey,
    hostUserId: host.userId,
    hostName: host.name,
    opponentUserId: opponent.userId,
    opponentName: opponent.name,
    settings: settingsOf(room),
  });

  if (!result.ok) {
    await releaseRoom(room, actorUserId);
    return {
      ok: false,
      status: result.status,
      code: "match_creation_failed",
      message: result.message,
    };
  }

  const now = new Date();
  const [started] = await db
    .update(privateRooms)
    .set({
      status: "started",
      matchId: result.matchId,
      matchUrl: result.matchUrl,
      startedAt: now,
      claimedAt: null,
    })
    .where(eq(privateRooms.id, room.id))
    .returning();
  const fresh = started ?? room;

  await notifyRoomsChanged([host.userId, opponent.userId]);

  const rows = await membersOf(room.id);
  return {
    ok: true,
    room: viewOf(fresh, rows, actorUserId),
    matchId: result.matchId,
    matchUrl: result.matchUrl,
    started: true,
  };
}

/** Undo a claim whose match could not be created. Never leaves a ghost match. */
async function releaseRoom(room: RoomRow, actorUserId: string): Promise<void> {
  const now = new Date();
  const nextStatus = statusAfterFailure(room.kind);
  await db
    .update(privateRooms)
    .set({
      status: nextStatus,
      claimedAt: null,
      closedAt: nextStatus === "open" ? null : now,
    })
    .where(eq(privateRooms.id, room.id));

  if (nextStatus !== "open") {
    await notifyRoomsChanged([room.hostUserId, actorUserId]);
  }
}

/**
 * The host starts a PRO room.
 *
 * Authorization is `decideStart` (host only, one accepted opponent, room open);
 * the claim is the same single conditional UPDATE a challenge acceptance uses,
 * so a double click — or two devices — can only mint one match. The loser is
 * answered with the room's real state, which is the match if the winner is
 * already done.
 */
export async function startRoom({
  roomId,
  userId,
}: {
  roomId: string;
  userId: string;
}): Promise<StartResult> {
  await sweepRooms();
  const loaded = await loadRoom(roomId);
  if (!loaded) return notFound();

  const decision = decideStart({
    room: asRoomRecord(loaded.room),
    members: loaded.members.map(asMemberRecord),
    userId,
  });
  if (!decision.ok) {
    // A start that lost a race to itself is not an error: the room already is
    // the match, so send the caller to it.
    if (decision.code === "already_started" && loaded.room.matchId && loaded.room.matchUrl) {
      return {
        ok: true,
        room: viewOf(loaded.room, loaded.members, userId),
        matchId: loaded.room.matchId,
        matchUrl: loaded.room.matchUrl,
        started: true,
      };
    }
    return failure(decision);
  }

  const claim = decideClaim(asRoomRecord(loaded.room));
  if (!claim.ok) return failure(claim);

  const now = new Date();
  const [claimed] = await db
    .update(privateRooms)
    .set({ status: "starting", claimedAt: now })
    .where(
      and(
        eq(privateRooms.id, roomId),
        eq(privateRooms.status, "open"),
        sql`${privateRooms.expiresAt} > ${now}`,
      ),
    )
    .returning();

  if (!claimed) {
    // Another start (or the sweep) got there first.
    const fresh = await roomById(roomId);
    if (!fresh) return notFound();
    if (fresh.matchId && fresh.matchUrl) {
      const rows = await membersOf(roomId);
      return {
        ok: true,
        room: viewOf(fresh, rows, userId),
        matchId: fresh.matchId,
        matchUrl: fresh.matchUrl,
        started: true,
      };
    }
    return {
      ok: false,
      status: 409,
      code: "start_in_progress",
      message: "This room is already being started",
    };
  }

  return startClaimedRoom({ roomId, actorUserId: userId });
}

// ── Closing ─────────────────────────────────────────────────────────────────

/**
 * The host closes a room. Conditional on the room still being open, so a cancel
 * that races a successful start cannot erase a match that already exists.
 */
export async function cancelRoom({
  roomId,
  userId,
}: {
  roomId: string;
  userId: string;
}): Promise<RoomResult> {
  await sweepRooms();
  const loaded = await loadRoom(roomId);
  if (!loaded) return notFound();

  const decision = decideCancel({
    room: asRoomRecord(loaded.room),
    userId,
  });
  if (!decision.ok) return failure(decision);

  const now = new Date();
  const [closed] = await db
    .update(privateRooms)
    .set({ status: "cancelled", closedAt: now, claimedAt: null })
    .where(
      and(
        eq(privateRooms.id, roomId),
        or(eq(privateRooms.status, "open"), eq(privateRooms.status, "starting")),
      ),
    )
    .returning();

  if (!closed) {
    const fresh = await roomById(roomId);
    if (!fresh) return notFound();
    if (fresh.matchId) {
      return {
        ok: false,
        status: 409,
        code: "already_started",
        message: "This room already became a match",
      };
    }
    return { ok: true, room: viewOf(fresh, await membersOf(roomId), userId) };
  }

  const rows = await membersOf(roomId);
  await notifyRoomsChanged(rows.map((m) => m.userId));
  return { ok: true, room: viewOf(closed, rows, userId) };
}


