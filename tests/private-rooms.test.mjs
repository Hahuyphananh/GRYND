/**
 * private-rooms.test.mjs
 *
 * Private custom rooms (GRYND PRO) and free friend challenges.
 *
 * WHAT IS TESTED FOR REAL:
 *   * the pure authorization rules that every endpoint runs through — who may
 *     create, invite, join, read, accept, start and cancel — exercised directly
 *     against `src/lib/rooms/rules.ts`, including the free-vs-PRO split, the
 *     IDOR rule, expiry, duplicates, full rooms and replayed answers;
 *   * the settings validation that decides whether a room may carry a stake,
 *     against the platform's REAL wager policy (`validateWager`), including
 *     "Pool Masters rooms are free-play only";
 *   * the game catalog (which games rooms support at all).
 *
 * WHAT IS TESTED STRUCTURALLY (source contracts, not a live database):
 *   * the create route resolves membership SERVER-side and never from the body;
 *   * every mutating room route goes through the age/auth gate;
 *   * the concurrency guards are single conditional UPDATEs (a claim that can be
 *     won once), not read-then-write;
 *   * the migration is additive, indexes the code and the duplicate guard, and
 *     is registered in the drizzle journal (the journal guard test also covers
 *     the last point);
 *   * the per-user realtime room is server-derived, not client-claimed.
 *
 * NO DATABASE IS USED: this suite never connects to Postgres, so a green run
 * means the RULES are right, not that a migration was applied to a live
 * database. See docs/PRIVATE_ROOMS.md §5 for what remains unverified.
 *
 * Run:  npm run test:rooms
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  ROOM_GAMES,
  ROOM_GAME_KEYS,
  ROOM_MAX_INVITES,
  ROOM_TTL_MS,
  CHALLENGE_TTL_MS,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  getRoomGame,
  isRoomGame,
} from "../src/lib/rooms/catalog.ts";
import { validateWager, maxStakeFor } from "../src/lib/games/stakes.js";
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
  isExpired,
  isStaleClaim,
  memberOf,
  seatCount,
  statusAfterFailure,
  sweptStatus,
  ttlForKind,
} from "../src/lib/rooms/rules.ts";
import {
  challengeSettings,
  resolveRoomSettings,
} from "../src/lib/rooms/settings.ts";
import { generateRoomCode, isUuid, normalizeRoomCode } from "../src/lib/rooms/store.ts";

const read = (rel) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");

/**
 * The source of ONE exported function, from its declaration to the first line
 * that closes it at column 0. Used by the contracts that must be checked inside
 * a specific function rather than anywhere in the file (the file also contains
 * the public flow).
 */
function fnBody(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} not found`);
  const end = source.indexOf("\n}\n", start);
  return source.slice(start, end === -1 ? undefined : end);
}

const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);
const HOST = "user_host";
const GUEST = "user_guest";
const STRANGER = "user_stranger";

/** A room row as the rules see it. */
function room(overrides = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    code: "ABCD234567",
    kind: "room",
    hostUserId: HOST,
    gameKey: "precision",
    mode: "pvp",
    settings: { stake: 0 },
    status: "open",
    matchId: null,
    matchUrl: null,
    createdAt: new Date(NOW - 60_000).toISOString(),
    expiresAt: new Date(NOW + ROOM_TTL_MS).toISOString(),
    claimedAt: null,
    startedAt: null,
    closedAt: null,
    ...overrides,
  };
}

function host() {
  return { userId: HOST, role: "host", inviteStatus: "accepted", name: "Host" };
}
function guest(inviteStatus = "accepted") {
  return { userId: GUEST, role: "guest", inviteStatus, name: "Guest" };
}

// ── The catalog: which games may host a room at all ────────────────────────

test("only the games with a seat-this-pair primitive are offered", () => {
  assert.deepEqual([...ROOM_GAME_KEYS].sort(), ["pool", "precision", "tower-arena"]);
  for (const game of ROOM_GAMES) {
    assert.equal(game.seats, 2, `${game.key} must be a two-seat duel`);
    assert.equal(game.mode, "pvp");
  }
});

test("create-or-join games are NOT offered (they cannot seat a named pair)", () => {
  // These games pair the caller with ANY waiting row, so a private room would
  // need a per-game rewrite. The server must refuse them by key.
  const unsupported = [
    "chess",
    "uno",
    "mini-golf",
    "tic-tac-toe",
    "barricade",
    "mines-pvp",
    "speed-typing",
    "sudoku-duel",
    "solitaire-duel",
    "crash-arena",
  ];
  for (const key of unsupported) {
    assert.equal(getRoomGame(key), null, `${key} must not be a room game`);
    assert.equal(isRoomGame(key), false);
  }
  assert.equal(getRoomGame("nonsense"), null);
  assert.equal(getRoomGame(""), null);
  assert.equal(getRoomGame(null), null);
});

test("every offered game's room ceiling comes from the platform wager policy", () => {
  for (const game of ROOM_GAMES) {
    assert.equal(
      game.maxStake,
      game.key === "pool" ? 0 : maxStakeFor(game.key),
      `${game.key} room ceiling must not invent its own bounds`,
    );
  }
  // Pool Masters' join-lobby flow carries no escrow, so a staked room there
  // could never settle a wager.
  assert.equal(getRoomGame("pool").maxStake, 0);
  assert.ok(getRoomGame("precision").maxStake > 0);
  assert.ok(getRoomGame("tower-arena").maxStake > 0);
});

test("a room code is unguessable in practice", () => {
  assert.equal(ROOM_CODE_LENGTH, 10);
  assert.equal(ROOM_CODE_ALPHABET.length, 32);
  // No ambiguous glyphs: a code has to survive being read aloud.
  for (const banned of ["I", "O", "0", "1"]) {
    assert.equal(ROOM_CODE_ALPHABET.includes(banned), false, `alphabet must not contain ${banned}`);
  }
  assert.ok(32 ** ROOM_CODE_LENGTH > 1e14);
});

test("normalizeRoomCode accepts a typed code and rejects the impossible", () => {
  assert.equal(normalizeRoomCode("abcd234567"), "ABCD234567");
  assert.equal(normalizeRoomCode("ABCD-234 567"), "ABCD234567");
  // 'I', 'O', '0' and '1' cannot appear in a real code, so a code containing
  // one is a typo — rejected here instead of hitting the database.
  assert.equal(normalizeRoomCode("IIIIIIIIII"), "");
  assert.equal(normalizeRoomCode("0000000000"), "");
  assert.equal(normalizeRoomCode(""), "");
  assert.equal(normalizeRoomCode(null), "");
});

// ── Settings validation ───────────────────────────────────────────────────

test("an absent stake is free play, and free play is always legal", () => {
  for (const game of ROOM_GAMES) {
    const result = resolveRoomSettings(game.key, {});
    assert.equal(result.ok, true, game.key);
    assert.equal(result.settings.stake, 0);
    assert.equal(resolveRoomSettings(game.key, { stake: 0 }).settings.stake, 0);
    assert.equal(resolveRoomSettings(game.key, null).settings.stake, 0);
  }
});

test("generated codes use the safe alphabet and do not collide in practice", () => {
  const seen = new Set();
  for (let i = 0; i < 5000; i += 1) {
    const code = generateRoomCode();
    assert.equal(code.length, ROOM_CODE_LENGTH);
    for (const ch of code) {
      assert.ok(ROOM_CODE_ALPHABET.includes(ch), `unexpected symbol ${ch} in ${code}`);
    }
    seen.add(code);
  }
  assert.equal(seen.size, 5000, "5000 codes must all be distinct");
});

test("a room id must be a uuid before it reaches a query", () => {
  assert.equal(isUuid("11111111-1111-4111-8111-111111111111"), true);
  assert.equal(isUuid("ABCD234567"), false);
  assert.equal(isUuid("1' OR 1=1"), false);
  assert.equal(isUuid(""), false);
  assert.equal(isUuid(null), false);
});

test("an illegal stake is refused with the wager policy's own bounds", () => {
  const negative = resolveRoomSettings("precision", { stake: -5 });
  assert.equal(negative.ok, false);
  assert.equal(negative.status, 400);

  const fractional = resolveRoomSettings("precision", { stake: 2.5 });
  assert.equal(fractional.ok, false);
  assert.equal(fractional.status, 400);

  const absurd = resolveRoomSettings("precision", { stake: maxStakeFor("precision") + 1 });
  assert.equal(absurd.ok, false);
  assert.equal(absurd.status, 400);
});

test("a staked room is capped by the game's own ceiling", () => {
  const precision = resolveRoomSettings("precision", { stake: maxStakeFor("precision") });
  assert.equal(precision.ok, true);
  assert.equal(precision.settings.stake, maxStakeFor("precision"));

  const tower = resolveRoomSettings("tower-arena", { stake: maxStakeFor("tower-arena") });
  assert.equal(tower.ok, true);

  // The platform's own policy and the room's ceiling agree by construction.
  for (const game of ROOM_GAMES) {
    const over = resolveRoomSettings(game.key, { stake: game.maxStake + 1 });
    assert.equal(over.ok, false, `${game.key} must refuse a stake above its ceiling`);
  }
});

test("Pool Masters rooms are free-play only, refused server-side", () => {
  const staked = resolveRoomSettings("pool", { stake: 10 });
  assert.equal(staked.ok, false);
  assert.equal(staked.status, 400);
  assert.match(String(staked.message), /free-play only/i);
});

test("an unsupported game can never be given settings", () => {
  for (const key of ["chess", "uno", "mini-golf", ""]) {
    const result = resolveRoomSettings(key, { stake: 0 });
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
  }
});

test("the wager policy is the single source of stake legality", () => {
  // A stake the policy accepts must be accepted by the room, and vice versa —
  // for the free range the two must never disagree.
  for (const requested of [0, 1, 5, 50]) {
    assert.equal(validateWager(requested, "precision").ok, true);
    assert.equal(resolveRoomSettings("precision", { stake: requested }).ok, true);
  }
});

test("a challenge's settings are the server's, always free", () => {
  const settings = challengeSettings();
  assert.deepEqual(settings, { stake: 0 });
});

// ── Creating: the PRO gate ────────────────────────────────────────────────

test("only an active PRO member may create a private room", () => {
  const free = decideCreateRoom({ kind: "room", tier: "free" });
  assert.equal(free.ok, false);
  assert.equal(free.status, 403);
  assert.equal(free.code, "pro_required");

  for (const tier of ["pro", "PRO", " pro "]) {
    assert.equal(decideCreateRoom({ kind: "room", tier: tier.trim().toLowerCase() }).ok, true);
  }
  assert.equal(decideCreateRoom({ kind: "room", tier: "pro" }).ok, true);
});

test("an unrecognised tier is treated as not-Pro", () => {
  for (const tier of ["", null, undefined, "premium", "basic"]) {
    assert.equal(decideCreateRoom({ kind: "room", tier }).ok, false);
  }
});

test("a friend challenge is free for everyone", () => {
  for (const tier of ["free", "pro", "", null]) {
    assert.equal(decideCreateRoom({ kind: "challenge", tier }).ok, true, String(tier));
  }
});

test("an unknown room kind is refused", () => {
  assert.equal(decideCreateRoom({ kind: "matchmaking", tier: "pro" }).ok, false);
  assert.equal(decideCreateRoom({ kind: "", tier: "pro" }).ok, false);
});

test("a challenge is shorter-lived than a room, and both expire", () => {
  assert.equal(ttlForKind("challenge"), CHALLENGE_TTL_MS);
  assert.equal(ttlForKind("room"), ROOM_TTL_MS);
  assert.ok(CHALLENGE_TTL_MS < ROOM_TTL_MS);
  assert.ok(CHALLENGE_TTL_MS > 0 && ROOM_TTL_MS > 0);
});

// ── Reading: the IDOR rule ────────────────────────────────────────────────

test("only participants can read a room", () => {
  const members = [host(), guest("invited")];
  assert.equal(decideViewRoom({ members, userId: HOST }).ok, true);
  assert.equal(decideViewRoom({ members, userId: GUEST }).ok, true);

  const stranger = decideViewRoom({ members, userId: STRANGER });
  assert.equal(stranger.ok, false);
  assert.equal(stranger.status, 403);
  assert.equal(stranger.code, "not_a_member");

  const anonymous = decideViewRoom({ members, userId: null });
  assert.equal(anonymous.ok, false);
  assert.equal(anonymous.status, 401);
});

test("knowing a room id grants nothing without a membership row", () => {
  // The requirement's IDOR case: same room, same id, uninvited caller.
  const target = room();
  const members = [host(), guest("accepted")];
  const denied = decideViewRoom({ members, userId: STRANGER });
  assert.equal(denied.ok, false);
  // ...and the insider sees the very same room.
  assert.equal(decideViewRoom({ members, userId: GUEST }).ok, true);
  assert.equal(memberOf(members, STRANGER), null);
  assert.equal(memberOf(members, target.hostUserId).role, "host");
});

// ── Inviting ──────────────────────────────────────────────────────────────

test("only the host may invite, and only friends", () => {
  const members = [host()];
  const notHost = decideInvite({
    room: room(),
    members,
    hostUserId: GUEST,
    inviteeUserId: STRANGER,
    isFriend: true,
    now: NOW,
  });
  assert.equal(notHost.code, "not_the_host");
  assert.equal(notHost.status, 403);

  const notFriend = decideInvite({
    room: room(),
    members,
    hostUserId: HOST,
    inviteeUserId: STRANGER,
    isFriend: false,
    now: NOW,
  });
  assert.equal(notFriend.code, "not_a_friend");
  assert.equal(notFriend.status, 403);

  const self = decideInvite({
    room: room(),
    members,
    hostUserId: HOST,
    inviteeUserId: HOST,
    isFriend: true,
    now: NOW,
  });
  assert.equal(self.code, "cannot_invite_self");

  const challengeSelf = decideInvite({
    room: room({ kind: "challenge" }),
    members,
    hostUserId: HOST,
    inviteeUserId: HOST,
    isFriend: true,
    now: NOW,
  });
  assert.equal(challengeSelf.code, "cannot_invite_self");
  assert.equal(challengeSelf.status, 400);

  const ok = decideInvite({
    room: room(),
    members,
    hostUserId: HOST,
    inviteeUserId: GUEST,
    isFriend: true,
    now: NOW,
  });
  assert.equal(ok.ok, true);
});

test("an invite is refused on an expired or already-closed room", () => {
  const expired = decideInvite({
    room: room({ expiresAt: new Date(NOW - 1).toISOString() }),
    members: [host()],
    hostUserId: HOST,
    inviteeUserId: GUEST,
    isFriend: true,
    now: NOW,
  });
  assert.equal(expired.status, 410);
  assert.equal(expired.code, "room_expired");

  for (const status of ["started", "cancelled", "declined", "expired", "failed", "starting"]) {
    const denied = decideInvite({
      room: room({ status, expiresAt: new Date(NOW + 1000).toISOString() }),
      members: [host()],
      hostUserId: HOST,
      inviteeUserId: GUEST,
      isFriend: true,
      now: NOW,
    });
    assert.equal(denied.ok, false, `status ${status} must not accept an invite`);
  }
});

test("a repeated invite is idempotent and a taken seat is never reset", () => {
  const duplicate = decideInvite({
    room: room(),
    members: [host(), guest("invited")],
    hostUserId: HOST,
    inviteeUserId: GUEST,
    isFriend: true,
    now: NOW,
  });
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.duplicate, true);

  const accepted = decideInvite({
    room: room(),
    members: [host(), guest("accepted")],
    hostUserId: HOST,
    inviteeUserId: GUEST,
    isFriend: true,
    now: NOW,
  });
  assert.equal(accepted.ok, false);
  assert.equal(accepted.code, "already_joined");
  assert.equal(accepted.status, 409);
});

test("a challenge accepts exactly one invitee", () => {
  const second = decideInvite({
    room: room({ kind: "challenge", code: null }),
    members: [host(), guest("invited")],
    hostUserId: HOST,
    inviteeUserId: STRANGER,
    isFriend: true,
    now: NOW,
  });
  assert.equal(second.ok, false);
  assert.equal(second.code, "challenge_single_invitee");
});

test("a room's invite list is bounded", () => {
  const members = [host()];
  for (let i = 0; i < ROOM_MAX_INVITES; i += 1) {
    members.push({ userId: `guest_${i}`, role: "guest", inviteStatus: "invited", name: null });
  }
  const over = decideInvite({
    room: room(),
    members,
    hostUserId: HOST,
    inviteeUserId: STRANGER,
    isFriend: true,
    now: NOW,
  });
  assert.equal(over.ok, false);
  assert.equal(over.code, "room_full");
});

// ── Joining by code ───────────────────────────────────────────────────────

test("a free player with the code may join an open room", () => {
  // No membership tier is even consulted on this path: only creation is PRO.
  const joined = decideJoinByCode({
    room: room(),
    members: [host()],
    userId: STRANGER,
    now: NOW,
  });
  assert.equal(joined.ok, true);
  assert.equal(joined.alreadyIn, undefined);
});

test("a challenge is never joinable, even with its id", () => {
  const denied = decideJoinByCode({
    room: room({ kind: "challenge", code: null }),
    members: [host()],
    userId: STRANGER,
    now: NOW,
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, "challenge_not_joinable");
  assert.equal(denied.status, 403);
});

test("joining is refused when the room is expired, closed, started or full", () => {
  const cases = [
    [{ expiresAt: new Date(NOW - 1).toISOString() }, 410, "room_expired"],
    [{ status: "cancelled" }, 409, "room_closed"],
    [{ status: "declined" }, 409, "room_closed"],
    [{ status: "started" }, 409, "room_started"],
    [{ status: "starting" }, 409, "room_started"],
    [{ status: "failed" }, 409, "room_not_open"],
  ];
  for (const [overrides, status, code] of cases) {
    const denied = decideJoinByCode({
      room: room(overrides),
      members: [host()],
      userId: STRANGER,
      now: NOW,
    });
    assert.equal(denied.ok, false, JSON.stringify(overrides));
    assert.equal(denied.status, status);
    assert.equal(denied.code, code);
  }

  const full = decideJoinByCode({
    room: room(),
    members: [host(), guest("accepted")],
    userId: STRANGER,
    now: NOW,
  });
  assert.equal(full.ok, false);
  assert.equal(full.code, "room_full");
  assert.equal(full.status, 409);
});

test("re-joining is idempotent for someone already on a seat", () => {
  // An ACCEPTED guest already holds the seat: nothing new is created.
  const accepted = decideJoinByCode({
    room: room(),
    members: [host(), guest("accepted")],
    userId: GUEST,
    now: NOW,
  });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.alreadyIn, true);

  const hostAgain = decideJoinByCode({
    room: room(),
    members: [host()],
    userId: HOST,
    now: NOW,
  });
  assert.equal(hostAgain.ok, true);
  assert.equal(hostAgain.alreadyIn, true);

  // An INVITED guest who joins with the code is ACCEPTING: the join records the
  // answer (the store upserts their row to accepted), so it is not a no-op.
  const invited = decideJoinByCode({
    room: room(),
    members: [host(), guest("invited")],
    userId: GUEST,
    now: NOW,
  });
  assert.equal(invited.ok, true);
  assert.equal(invited.alreadyIn, undefined);
  assert.match(
    read("src/lib/rooms/store.ts"),
    /joinRoomByCode[\s\S]*?onConflictDoUpdate\(\{[\s\S]*?inviteStatus: "accepted"/,
    "the join must record an invited guest's acceptance, not leave them invited",
  );
});

test("seats come from the game, so a >2-seat game needs no rule change", () => {
  assert.equal(seatCount(room()), 2);
  assert.equal(seatCount(room({ kind: "challenge" })), 2);
  assert.equal(seatCount(room({ gameKey: "unknown-game" })), 2); // safe default
});

// ── Answering an invitation ───────────────────────────────────────────────

test("only the invited player can answer", () => {
  const stranger = decideRespond({
    room: room(),
    members: [host(), guest("invited")],
    userId: STRANGER,
    now: NOW,
  });
  assert.equal(stranger.ok, false);
  assert.equal(stranger.status, 403);
  assert.equal(stranger.code, "not_invited");

  const hostCannot = decideRespond({
    room: room(),
    members: [host(), guest("invited")],
    userId: HOST,
    now: NOW,
  });
  assert.equal(hostCannot.code, "not_invited");

  assert.equal(
    decideRespond({ room: room(), members: [host(), guest("invited")], userId: GUEST, now: NOW }).ok,
    true,
  );
});

test("a replayed answer is idempotent in both directions", () => {
  const accepted = decideRespond({
    room: room({ status: "started" }),
    members: [host(), guest("accepted")],
    userId: GUEST,
    now: NOW,
  });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.already, "accepted");

  const declined = decideRespond({
    room: room({ status: "declined", kind: "challenge" }),
    members: [host(), guest("declined")],
    userId: GUEST,
    now: NOW,
  });
  assert.equal(declined.ok, true);
  assert.equal(declined.already, "declined");
});

test("an expired invitation can no longer produce a match", () => {
  const expired = decideRespond({
    room: room({ expiresAt: new Date(NOW - 1).toISOString() }),
    members: [host(), guest("invited")],
    userId: GUEST,
    now: NOW,
  });
  assert.equal(expired.status, 410);
  assert.equal(expired.code, "invitation_expired");
});

test("accepting a challenge that was already declined is refused", () => {
  const denied = decideRespond({
    room: room({ kind: "challenge", status: "declined" }),
    members: [host(), guest("invited")],
    userId: GUEST,
    now: NOW,
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, "already_declined");
});

test("the seat is first-come-first-served on a full room", () => {
  const denied = decideRespond({
    room: room(),
    members: [host(), guest("accepted"), { userId: "guest_2", role: "guest", inviteStatus: "invited" }],
    userId: "guest_2",
    now: NOW,
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, "room_full");
  assert.equal(denied.status, 409);

  // Declining is always allowed, even when the room is full.
  const decline = decideRespond({
    room: room(),
    members: [host(), guest("accepted"), { userId: "guest_2", role: "guest", inviteStatus: "invited" }],
    userId: "guest_2",
    accepts: false,
    now: NOW,
  });
  assert.equal(decline.ok, true);
});

// ── Starting ──────────────────────────────────────────────────────────────

test("only the host may start, and only with an opponent on the second seat", () => {
  const notHost = decideStart({
    room: room(),
    members: [host(), guest("accepted")],
    userId: GUEST,
    now: NOW,
  });
  assert.equal(notHost.status, 403);
  assert.equal(notHost.code, "not_the_host");

  const noOpponent = decideStart({
    room: room(),
    members: [host()],
    userId: HOST,
    now: NOW,
  });
  assert.equal(noOpponent.status, 409);
  assert.equal(noOpponent.code, "need_opponent");

  const invitedOnly = decideStart({
    room: room(),
    members: [host(), guest("invited")],
    userId: HOST,
    now: NOW,
  });
  assert.equal(invitedOnly.code, "need_opponent");

  assert.equal(
    decideStart({ room: room(), members: [host(), guest("accepted")], userId: HOST, now: NOW }).ok,
    true,
  );
});

test("a challenge is never started by the host — acceptance starts it", () => {
  const denied = decideStart({
    room: room({ kind: "challenge", code: null }),
    members: [host(), guest("accepted")],
    userId: HOST,
    now: NOW,
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, "challenge_auto_starts");
});

test("an expired or already-started room cannot be started", () => {
  const expired = decideStart({
    room: room({ expiresAt: new Date(NOW - 1).toISOString() }),
    members: [host(), guest("accepted")],
    userId: HOST,
    now: NOW,
  });
  assert.equal(expired.status, 410);

  const started = decideStart({
    room: room({ status: "started" }),
    members: [host(), guest("accepted")],
    userId: HOST,
    now: NOW,
  });
  assert.equal(started.status, 409);
  assert.equal(started.code, "already_started");
});

test("the claim can only be taken from an open, unexpired room", () => {
  assert.equal(decideClaim(room(), NOW).ok, true);
  assert.equal(decideClaim(room({ status: "starting" }), NOW).code, "room_not_open");
  assert.equal(decideClaim(room({ status: "started" }), NOW).code, "already_started");
  assert.equal(decideClaim(room({ status: "cancelled" }), NOW).code, "room_not_open");
  assert.equal(decideClaim(room({ expiresAt: new Date(NOW - 1).toISOString() }), NOW).status, 410);
});

test("a failed match creation releases the room instead of keeping a ghost", () => {
  assert.equal(statusAfterFailure("room"), "open"); // retryable
  assert.equal(statusAfterFailure("challenge"), "failed"); // terminal
});

// ── Cancelling ────────────────────────────────────────────────────────────

test("only the host may close a room, and never a finished one", () => {
  const notHost = decideCancel({ room: room(), userId: GUEST });
  assert.equal(notHost.status, 403);

  assert.equal(decideCancel({ room: room(), userId: HOST }).ok, true);
  assert.equal(decideCancel({ room: room({ status: "starting" }), userId: HOST }).ok, true);
  assert.equal(decideCancel({ room: room({ status: "started" }), userId: HOST }).code, "already_started");
  assert.equal(decideCancel({ room: room({ status: "cancelled" }), userId: HOST }).code, "room_not_open");
  assert.equal(decideCancel({ room: room(), userId: null }).status, 401);
});

// ── Expiry and stale claims ───────────────────────────────────────────────

test("expiry is a fact about the clock, and an unreadable date counts as expired", () => {
  assert.equal(isExpired(room(), NOW), false);
  assert.equal(isExpired(room({ expiresAt: new Date(NOW).toISOString() }), NOW), true);
  assert.equal(isExpired(room({ expiresAt: null }), NOW), true);
  assert.equal(isExpired(room({ expiresAt: "not-a-date" }), NOW), true);
});

test("the lazy sweep only rewrites rooms that are actually stale", () => {
  assert.equal(sweptStatus(room(), NOW), null);
  assert.equal(sweptStatus(room({ expiresAt: new Date(NOW - 1).toISOString() }), NOW), "expired");
  assert.equal(
    sweptStatus(room({ status: "starting", expiresAt: new Date(NOW - 1).toISOString() }), NOW),
    "expired",
  );
  assert.equal(sweptStatus(room({ status: "started" }), NOW), null);
  assert.equal(sweptStatus(room({ status: "declined" }), NOW), null);
});

test("a claim abandoned mid-create is released, not left wedged", () => {
  const claimed = room({
    status: "starting",
    claimedAt: new Date(NOW - 1000).toISOString(),
  });
  assert.equal(isStaleClaim(claimed, NOW), false, "a fresh claim is left alone");
  assert.equal(
    isStaleClaim(
      room({ status: "starting", claimedAt: new Date(NOW - CLAIM_STALE_MS - 1).toISOString() }),
      NOW,
    ),
    true,
  );
  // A room that already has its match is never "stale".
  assert.equal(
    isStaleClaim(
      room({
        status: "starting",
        matchId: "m1",
        claimedAt: new Date(NOW - CLAIM_STALE_MS * 10).toISOString(),
      }),
      NOW,
    ),
    false,
  );
  assert.equal(isStaleClaim(room(), NOW), false);
  // With no claim stamp the creation time is the fallback (a claim cannot
  // predate its row), so an old row with a missing stamp is abandoned...
  assert.equal(
    isStaleClaim(
      room({
        status: "starting",
        claimedAt: null,
        createdAt: new Date(NOW - CLAIM_STALE_MS - 1).toISOString(),
      }),
      NOW,
    ),
    true,
  );
  // ...while a fresh one is simply in flight.
  assert.equal(isStaleClaim(room({ status: "starting", claimedAt: null }), NOW), false);
});

// ── Seat helpers ──────────────────────────────────────────────────────────

test("acceptedSeats counts the host and accepted guests only", () => {
  const seats = acceptedSeats([host(), guest("accepted"), { userId: "g2", role: "guest", inviteStatus: "invited" }, { userId: "g3", role: "guest", inviteStatus: "declined" }]);
  assert.deepEqual(seats.map((m) => m.userId), [HOST, GUEST]);
});

// ── Source contracts: the parts that need a database to be true ───────────

test("room creation resolves membership server-side, never from the body", () => {
  const route = read("src/app/api/rooms/route.ts");
  assert.match(route, /getMembershipTier\(userId\)/, "the create route must resolve the tier itself");
  assert.doesNotMatch(route, /body[^)]*\.tier|tier\s*[:=]\s*parsed\.data\.tier/, "a body must not supply a tier");
  // The Pro rule itself lives in the pure rules module (unit-tested above).
  assert.match(read("src/lib/rooms/rules.ts"), /pro_required/);
  // The free challenge endpoint must NOT gate on membership.
  const challenge = read("src/app/api/rooms/challenge/route.ts");
  assert.match(challenge, /kind: "challenge"/);
  assert.doesNotMatch(challenge, /pro_required|=== "pro"\)\s*\{/);
});

test("every mutating room route goes through the age + auth gate", () => {
  const mutating = [
    "src/app/api/rooms/route.ts",
    "src/app/api/rooms/challenge/route.ts",
    "src/app/api/rooms/join/route.ts",
    "src/app/api/rooms/[roomId]/route.ts",
    "src/app/api/rooms/[roomId]/invite/route.ts",
    "src/app/api/rooms/[roomId]/respond/route.ts",
    "src/app/api/rooms/[roomId]/start/route.ts",
  ];
  for (const file of mutating) {
    const source = read(file);
    assert.match(source, /requireRoomActor\(\)/, `${file} must authenticate + age-verify`);
  }
  // ...and the gate is the platform's existing 18+ check, not a new one.
  assert.match(read("src/lib/rooms/api.ts"), /requireAgeVerifiedUser/);
});

test("no room route takes an identity from the request body", () => {
  const files = [
    "src/app/api/rooms/route.ts",
    "src/app/api/rooms/challenge/route.ts",
    "src/app/api/rooms/join/route.ts",
    "src/app/api/rooms/[roomId]/invite/route.ts",
    "src/app/api/rooms/[roomId]/respond/route.ts",
    "src/app/api/rooms/[roomId]/start/route.ts",
    "src/app/api/rooms/[roomId]/route.ts",
  ];
  for (const file of files) {
    const source = read(file);
    assert.doesNotMatch(source, /userId:\s*String\(parsed\.data/, `${file} must not trust a body identity`);
    assert.doesNotMatch(source, /parsed\.data\.userId/, `${file} must not accept a userId field`);
  }
});

test("the start/accept race is one conditional UPDATE, not read-then-write", () => {
  const store = read("src/lib/rooms/store.ts");
  // The claim: status flips open -> starting only if it is currently open.
  assert.match(store, /\.set\(\{ status: "starting", claimedAt: now \}\)/);
  assert.match(store, /eq\(privateRooms\.status, "open"\)/);
  assert.match(store, /\.returning\(\)/, "a claim must return the row it won");
  // Both callers (host start and challenge accept) share the claim.
  assert.match(store, /decideClaim\(/);
  // The joiner's transaction locks the room row before counting seats.
  assert.match(store, /\.for\("update"\)/);
  // And the duplicate membership is a database constraint, not a check.
  assert.match(store, /onConflictDoUpdate/);
});

test("the migration is additive, and indexes the code and the duplicate guard", () => {
  const sql = read("src/db/migrations/0217_private_rooms.sql");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS "private_rooms"/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS "private_room_members"/);
  // A code is unique across rooms that have one...
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS "private_rooms_code_unique"[\s\S]*?WHERE "code" IS NOT NULL/);
  // ...and one membership row per player per room is the duplicate guard.
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS "private_room_members_room_user_unique"/);
  // Nothing existing is touched.
  assert.doesNotMatch(sql, /ALTER TABLE "(?!private_)/i);
  assert.doesNotMatch(sql, /\bDROP\b/i);
  // The schema mirrors it.
  const schema = read("src/db/schema.ts");
  assert.match(schema, /export const privateRooms = pgTable\(\s*"private_rooms"/);
  assert.match(schema, /export const privateRoomMembers = pgTable\(\s*"private_room_members"/);
});

test("room state is never published to the public realtime channel", () => {
  // Supabase Realtime tables are world-readable with the public key, so an
  // invitation must never live in one: the private tables are not published.
  const published = [];
  for (const file of fs.readdirSync(path.join(process.cwd(), "src/db/migrations"))) {
    if (!file.endsWith(".sql")) continue;
    const sql = read(`src/db/migrations/${file}`);
    if (/ADD TABLE[^;]*private_room/i.test(sql)) published.push(file);
  }
  assert.deepEqual(published, [], "private_rooms must never join a realtime publication");
});

test("the per-user notification room is server-derived, not client-claimed", () => {
  const server = read("realtime-server/server.js");
  // The generic path cannot enter a user room...
  assert.match(server, /if \(String\(roomId\)\.startsWith\(USER_ROOM_PREFIX\)\) return;/);
  // ...only the verified handler can, from the token's subject.
  assert.match(server, /socket\.on\("user:join"/);
  assert.match(server, /socket\.join\(`\$\{USER_ROOM_PREFIX\}\$\{userId\}`\)/);
  assert.match(server, /socket\.data\.userId = verified\.sub/);

  // The Next.js side emits to that room only, and the payload carries a
  // timestamp and nothing else — no room id, code, game or inviter.
  const notify = read("src/lib/rooms/notify.ts");
  assert.match(notify, /room: userRoom\(clerkId\)/);
  assert.match(notify, /export function userRoom\(clerkId: string\): string \{\s*return `user:\$\{clerkId\}`/);
  assert.match(
    notify,
    /const payload = \{ at: new Date\(\)\.toISOString\(\) \};/,
    "the signal must be a bare refetch hint",
  );
  assert.doesNotMatch(notify, /payload: \{[^}]*\}/, "the emitted payload must have no extra fields");
});

test("the room adapters delegate to each game's own store", () => {
  const games = read("src/lib/rooms/games.ts");
  for (const fn of [
    "createPrecisionMatchForPair",
    "createPoolMatchForPair",
    "createTowerArenaMatchForPair",
  ]) {
    assert.match(games, new RegExp(fn), `the ${fn} primitive must be reused`);
  }
  // The games' own stores are touched by those primitives only.
  const pool = read("src/lib/pool/lobbyJoin.ts");
  assert.match(pool, /export async function createPoolMatchForPair/);
  const precision = read("src/lib/precision/matchmaking.ts");
  assert.match(precision, /export async function createPrecisionMatchForPair/);
  const tower = read("src/lib/tower-arena/serverStore.ts");
  assert.match(tower, /export async function createTowerArenaMatchForPair/);
});

test("the public matchmaking flow is untouched by rooms", () => {
  // A private pair is created and claimed inside ONE transaction, so the public
  // waiting-lobby queries can never see it.
  const poolPair = fnBody(read("src/lib/pool/lobbyJoin.ts"), "createPoolMatchForPair");
  assert.match(poolPair, /db\.transaction\(async \(tx\) => \{/);
  assert.match(poolPair, /insert\(poolLobbies\)/);
  assert.match(poolPair, /update\(poolLobbies\)/);
  assert.match(poolPair, /eq\(poolLobbies\.status, "waiting"\)/);

  const precisionPair = fnBody(
    read("src/lib/precision/matchmaking.ts"),
    "createPrecisionMatchForPair",
  );
  assert.match(precisionPair, /db\.transaction\(async \(tx\) => \{/);
  assert.match(precisionPair, /insert\(precisionLobbies\)/);
  assert.match(precisionPair, /eq\(precisionLobbies\.status, "waiting"\)/);

  const towerPair = fnBody(
    read("src/lib/tower-arena/serverStore.ts"),
    "createTowerArenaMatchForPair",
  );
  assert.match(towerPair, /db\.transaction\(async \(tx\) => \{/);
  assert.match(towerPair, /createLobbyTx\(tx/);
  assert.match(towerPair, /joinLobbyTx\(tx/);

  // The public routes still exist with their original behaviour.
  assert.match(read("src/app/api/pool/lobbies/route.ts"), /eq\(poolLobbies\.status, "waiting"\)/);
  assert.match(read("src/app/api/precision/lobbies/route.ts"), /listWaitingLobbies/);
});

test("the Friends tab keeps its tabs and gains a Challenge action", () => {
  const page = read("src/app/profil/PageClient.jsx");
  assert.match(page, /setActiveFriendsTab\("friends"\)/);
  assert.match(page, /setActiveFriendsTab\("invites"\)/);
  assert.match(page, /RoomsPanel friends=\{myFriends\}/);
  assert.match(page, /ChallengeFriendDialog/);
  assert.match(page, /profile\.friends\.challenge/);
  // The friendship APIs the tab already used are still the ones it calls.
  assert.match(page, /"\/api\/friends\/list"/);
  assert.match(page, /"\/api\/friends\/invites"/);
});

test("the realtime signal is an accelerator with a polling backstop", () => {
  const hook = read("src/hooks/useRooms.ts");
  assert.match(hook, /socket\.on\("rooms:changed"/);
  assert.match(hook, /POLL_INTERVAL_MS/);
  assert.match(hook, /visibilityState !== "visible"/);
});

test("the docs record the audit, the supported games and the limits", () => {
  const doc = read("docs/PRIVATE_ROOMS.md");
  for (const game of ["precision", "pool", "tower-arena"]) {
    assert.match(doc, new RegExp(game));
  }
  assert.match(doc, /Unsupported for now/);
  assert.match(doc, /create-or-join/);
});
