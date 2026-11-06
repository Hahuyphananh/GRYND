// tests/guest-pvp-rooms.test.mjs
//
// Phase 3D — guest private rooms and challenges.
//
// What is under test:
//   1. ALLOWLIST — a guest room is confined to the same free, guest-eligible
//      games the quick queue uses (dominoes), and to a zero stake.
//   2. CREATION  — a guest may create a shareable room; it may never create a
//      friend challenge, a staked room or a room for another game.
//   3. JOINING   — a guest may join a dominoes room by code, is refused on
//      every other game, and duplicate joins are idempotent.
//   4. ACCESS    — ownership, capacity, expiry and the IDOR rule (a room id is
//      not a permission) hold for guests exactly as for accounts.
//   5. REGRESSION— account rooms keep the Pro gate and their existing behavior.
//   6. WIRING    — the routes take the actor from the verified session and never
//      from the body.
//
// Run: node --import tsx --test tests/guest-pvp-rooms.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  decideCreateRoom,
  decideInvite,
  decideJoinByCode,
  decideStart,
  decideViewRoom,
} from "../src/lib/rooms/rules.ts";
import {
  GUEST_ROOM_GAME_KEYS,
  isGuestRoomGame,
} from "../src/lib/rooms/catalog.ts";
import { GUEST_PVP_GAME_KEYS } from "../src/lib/quickQueue.ts";

const GUEST = `guest_${"a".repeat(32)}`;
const GUEST_B = `guest_${"b".repeat(32)}`;
const USER = "user_2registeredPlayer";
const OTHER_USER = "user_2otherPlayer";

const read = (rel) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");
const code = (rel) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const room = (over = {}) => ({
  id: "11111111-1111-1111-1111-111111111111",
  code: "ABCDEFGHJK",
  kind: "room",
  hostUserId: USER,
  gameKey: "dominoes",
  mode: "pvp",
  settings: { stake: 0 },
  status: "open",
  expiresAt: new Date(Date.now() + 60_000),
  ...over,
});

const member = (userId, role, inviteStatus) => ({ userId, role, inviteStatus });

// ── 1. Allowlist ────────────────────────────────────────────────────────────

test("the guest room allowlist matches the guest queue allowlist", () => {
  assert.deepEqual([...GUEST_ROOM_GAME_KEYS], [...GUEST_PVP_GAME_KEYS]);
  assert.equal(isGuestRoomGame("dominoes"), true);
  assert.equal(isGuestRoomGame("DOMINOES"), true);
  assert.equal(isGuestRoomGame("precision"), false);
  assert.equal(isGuestRoomGame("pool"), false);
  assert.equal(isGuestRoomGame("tower-arena"), false);
  assert.equal(isGuestRoomGame(""), false);
  assert.equal(isGuestRoomGame(null), false);
});

// ── 2. Creation ─────────────────────────────────────────────────────────────

test("a guest may create a free room for a supported guest game", () => {
  const decision = decideCreateRoom({
    kind: "room",
    tier: "guest",
    gameKey: "dominoes",
    stake: 0,
  });
  assert.equal(decision.ok, true);
});

test("a guest cannot create a challenge, a staked room or another game's room", () => {
  assert.equal(
    decideCreateRoom({ kind: "challenge", tier: "guest", gameKey: "dominoes" }).code,
    "guest_challenge_unsupported",
  );
  assert.equal(
    decideCreateRoom({ kind: "room", tier: "guest", gameKey: "dominoes", stake: 50 }).code,
    "guest_free_only",
  );
  assert.equal(
    decideCreateRoom({ kind: "room", tier: "guest", gameKey: "precision", stake: 0 }).code,
    "guest_game_unsupported",
  );
});

test("registered room creation keeps the Pro rule exactly", () => {
  assert.equal(decideCreateRoom({ kind: "room", tier: "pro", gameKey: "precision" }).ok, true);
  assert.equal(
    decideCreateRoom({ kind: "room", tier: "free", gameKey: "precision" }).code,
    "pro_required",
  );
  // A challenge stays free for accounts.
  assert.equal(decideCreateRoom({ kind: "challenge", tier: "free", gameKey: "dominoes" }).ok, true);
});

// ── 3. Joining ──────────────────────────────────────────────────────────────

test("a guest may join a dominoes room by code", () => {
  const decision = decideJoinByCode({
    room: room(),
    members: [member(USER, "host", "accepted")],
    userId: GUEST,
  });
  assert.equal(decision.ok, true);
});

test("a guest is refused on a room whose game it cannot play", () => {
  const decision = decideJoinByCode({
    room: room({ gameKey: "precision" }),
    members: [member(USER, "host", "accepted")],
    userId: GUEST,
  });
  assert.equal(decision.code, "guest_game_unsupported");
  assert.equal(decision.status, 403);
});

test("an account may still join any supported room, including a guest-hosted one", () => {
  const decision = decideJoinByCode({
    room: room({ hostUserId: GUEST }),
    members: [member(GUEST, "host", "accepted")],
    userId: USER,
  });
  assert.equal(decision.ok, true);
});

test("a duplicate guest join is idempotent, not a second seat", () => {
  const decision = decideJoinByCode({
    room: room(),
    members: [member(USER, "host", "accepted"), member(GUEST, "guest", "accepted")],
    userId: GUEST,
  });
  assert.equal(decision.alreadyIn, true);
  assert.equal(decision.ok, true);
});

test("a guest cannot join a full, expired, started or challenge room", () => {
  const full = decideJoinByCode({
    room: room(),
    members: [member(USER, "host", "accepted"), member(OTHER_USER, "guest", "accepted")],
    userId: GUEST,
  });
  assert.equal(full.code, "room_full");

  const expired = decideJoinByCode({
    room: room({ expiresAt: new Date(Date.now() - 1_000) }),
    members: [member(USER, "host", "accepted")],
    userId: GUEST,
  });
  assert.equal(expired.code, "room_expired");

  const started = decideJoinByCode({
    room: room({ status: "started" }),
    members: [member(USER, "host", "accepted")],
    userId: GUEST,
  });
  assert.equal(started.code, "room_started");

  const challenge = decideJoinByCode({
    room: room({ kind: "challenge", code: null }),
    members: [member(USER, "host", "accepted")],
    userId: GUEST,
  });
  assert.equal(challenge.code, "challenge_not_joinable");
});

// ── 4. Access ───────────────────────────────────────────────────────────────

test("a guest cannot invite, because it has no friends list", () => {
  const decision = decideInvite({
    room: room({ hostUserId: GUEST }),
    members: [member(GUEST, "host", "accepted")],
    hostUserId: GUEST,
    inviteeUserId: USER,
    isFriend: false,
  });
  assert.equal(decision.code, "guest_cannot_invite");
});

test("a guest host can start once an account holds the second seat", () => {
  const decision = decideStart({
    room: room({ hostUserId: GUEST }),
    members: [member(GUEST, "host", "accepted"), member(USER, "guest", "accepted")],
    userId: GUEST,
  });
  assert.equal(decision.ok, true);
});

test("a room id is not a permission for a guest either", () => {
  const decision = decideViewRoom({
    members: [member(USER, "host", "accepted")],
    userId: GUEST_B,
  });
  assert.equal(decision.code, "not_a_member");
  assert.equal(decision.status, 403);
});

// ── 5. Wiring ───────────────────────────────────────────────────────────────

test("the room routes resolve the actor from the session, never the body", () => {
  const api = code("src/lib/rooms/api.ts");
  assert.match(api, /requirePvpPlayer\(\)/);
  assert.doesNotMatch(api, /body|searchParams/);

  for (const route of [
    "src/app/api/rooms/route.ts",
    "src/app/api/rooms/join/route.ts",
    "src/app/api/rooms/[roomId]/route.ts",
    "src/app/api/rooms/[roomId]/start/route.ts",
    "src/app/api/rooms/[roomId]/respond/route.ts",
    "src/app/api/rooms/[roomId]/invite/route.ts",
    "src/app/api/rooms/challenge/route.ts",
  ]) {
    assert.match(code(route), /requireRoomActor\(/, `${route} must keep the session gate`);
  }

  const create = code("src/app/api/rooms/route.ts");
  assert.match(create, /actor\.isGuest \? "guest" : await getMembershipTier\(userId\)/);

  // The rule receives the SERVER-validated game and stake, so a guest cannot
  // smuggle a different game or a stake through the create body.
  const store = code("src/lib/rooms/store.ts");
  assert.match(store, /decideCreateRoom\(\{[\s\S]*?gameKey,[\s\S]*?stake: requestedStake/);
  assert.match(code("src/app/api/rooms/join/route.ts"), /userId,/);
});

test("account-only room actions name the guest refusal explicitly", () => {
  assert.match(code("src/app/api/rooms/[roomId]/invite/route.ts"), /guest_cannot_invite/);
  assert.match(code("src/app/api/rooms/challenge/route.ts"), /guest_challenge_unsupported/);
});
