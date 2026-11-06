// tests/guest-pvp.test.mjs
//
// Phase 3B (identity), 3C (matchmaking) and the 3E central guard.
//
// What is under test:
//
//   1. IDENTITY — guest ids are a disjoint, well-formed namespace (`guest_…`),
//      never a Clerk id, and the classifier that decides "this match has a
//      guest" reads only the server's seat ids.
//   2. QUEUE — a guest may enqueue ONLY for the closed guest game allowlist, is
//      always `rated: false`, and pairs with another guest or an account. An
//      account request keeps its existing behaviour.
//   3. GUARDS — the shared writers that move ratings, trophies, coins and
//      competitive counters refuse a guest-involved match. Inert for accounts.
//   4. GATES — the queue routes resolve identity from the session only, and
//      account-only surfaces (private rooms) do NOT admit guests.
//
// Run: node --import tsx --test tests/guest-pvp.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { isGuestId } from "../src/lib/guestIdentity.ts";
import { isGuestPvpMatch, isRatedPvpMatch } from "../src/lib/pvp/guestMatch.ts";
import {
  GUEST_PVP_GAME_KEYS,
  findCompatibleQuickQueueCandidate,
  findCompatibleQuickQueuePair,
  isGuestPvpGameKey,
  normalizeQuickQueueRequest,
} from "../src/lib/quickQueue.ts";
import { consumeRateLimit } from "../src/lib/security/rateLimit.ts";

const read = (rel) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");
const code = (rel) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const GUEST_A = "guest_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const GUEST_B = "guest_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const CLERK_USER = "user_2registeredPlayer";

// ── 1. Identity ─────────────────────────────────────────────────────────────

test("guest ids are a disjoint namespace from Clerk ids", () => {
  assert.equal(isGuestId(GUEST_A), true);
  assert.equal(isGuestId(CLERK_USER), false);
  assert.equal(isGuestId("guest"), false, "the prefix alone is not an id");
  assert.equal(isGuestId("guest_"), false);
  assert.equal(isGuestId("user_guest_abc"), false);
  assert.equal(isGuestId(`guest_${"a".repeat(70)}`), false, "over-long ids are refused");
  assert.equal(isGuestId(null), false);
  assert.equal(isGuestId(undefined), false);
});

test("a match is unrated when ANY seat is a guest", () => {
  assert.equal(isGuestPvpMatch([GUEST_A, GUEST_B]), true, "Guest vs Guest");
  assert.equal(isGuestPvpMatch([GUEST_A, CLERK_USER]), true, "Guest vs registered");
  assert.equal(isGuestPvpMatch([CLERK_USER, GUEST_A]), true, "registered vs Guest");
  assert.equal(isGuestPvpMatch([CLERK_USER, "user_2other"]), false, "registered vs registered");
  assert.equal(isGuestPvpMatch([GUEST_A, null]), true, "an empty seat does not hide a guest");
  assert.equal(isGuestPvpMatch([]), false);
  assert.equal(isGuestPvpMatch(null), false);
  assert.equal(isRatedPvpMatch([CLERK_USER, "user_2other"]), true);
  assert.equal(isRatedPvpMatch([CLERK_USER, GUEST_A]), false);
});

// ── 2. Matchmaking ──────────────────────────────────────────────────────────

test("a guest may only queue for the closed guest allowlist", () => {
  assert.deepEqual([...GUEST_PVP_GAME_KEYS], ["dominoes"]);
  assert.equal(isGuestPvpGameKey("dominoes"), true);
  assert.equal(isGuestPvpGameKey("chess"), false);
  assert.equal(isGuestPvpGameKey("battleship"), false);

  // A rated-only game is a rejection, not a silent downgrade.
  assert.throws(
    () => normalizeQuickQueueRequest({ userId: GUEST_A, preferredGames: ["chess"], playerCount: 2 }),
    /guest PvP/,
  );
});

test("a guest request is marked unrated and filtered to supported games", () => {
  const request = normalizeQuickQueueRequest({
    userId: GUEST_A,
    preferredGames: ["dominoes", "chess", "battleship"],
    preferredModes: ["pvp"],
    playerCount: 2,
  });
  assert.equal(request.isGuest, true);
  assert.equal(request.rated, false);
  assert.deepEqual(request.preferredGames, ["dominoes"]);
});

test("a guest with no explicit game selection still gets only guest games", () => {
  const request = normalizeQuickQueueRequest({ userId: GUEST_A, playerCount: 2 });
  assert.deepEqual(request.preferredGames, ["dominoes"]);
  assert.equal(request.rated, false);
});

test("a registered request keeps its full game set and stays rated", () => {
  const request = normalizeQuickQueueRequest({
    userId: CLERK_USER,
    preferredGames: ["chess", "dominoes", "battleship"],
    playerCount: 2,
  });
  assert.equal(request.isGuest, false);
  assert.equal(request.rated, true);
  assert.deepEqual(request.preferredGames, ["chess", "dominoes", "battleship"]);
});

function queued(request, requestId, queuedAt) {
  return { ...request, requestId, queuedAt };
}

test("Guest vs Guest pairs on the supported game", () => {
  const a = normalizeQuickQueueRequest({ userId: GUEST_A, preferredGames: ["dominoes"], playerCount: 2 });
  const b = normalizeQuickQueueRequest({ userId: GUEST_B, preferredGames: ["dominoes"], playerCount: 2 });
  const pair = findCompatibleQuickQueuePair(
    [queued(a, "r1", 1_000), queued(b, "r2", 1_100)],
    2_000,
  );
  assert.ok(pair, "two guests must pair");
  assert.equal(pair.candidate.gameKey, "dominoes");
  assert.equal(pair.source.userId, GUEST_A);
  assert.equal(pair.partner.userId, GUEST_B);
});

test("Guest vs registered pairs, and neither identity is chosen by a client", () => {
  const guest = normalizeQuickQueueRequest({ userId: GUEST_A, preferredGames: ["dominoes"], playerCount: 2 });
  const account = normalizeQuickQueueRequest({ userId: CLERK_USER, preferredGames: ["dominoes"], playerCount: 2 });
  const pair = findCompatibleQuickQueuePair(
    [queued(guest, "r1", 1_000), queued(account, "r2", 1_050)],
    2_000,
  );
  assert.ok(pair);
  assert.equal(pair.candidate.gameKey, "dominoes");
  // The pair is composed from the two ROWS, never from a request-supplied
  // opponent: there is no such field in the normalized request at all.
  assert.deepEqual(
    [pair.source.userId, pair.partner.userId].sort(),
    [GUEST_A, CLERK_USER].sort(),
  );
  assert.equal("opponent" in guest, false);
});

test("matchmaking isolation: a guest can never be paired into a rated-only game", () => {
  const guest = normalizeQuickQueueRequest({ userId: GUEST_A, preferredGames: ["dominoes"], playerCount: 2 });
  // A hand-built candidate offering chess must not match the guest request.
  const chessCandidate = {
    gameKey: "chess",
    mode: "pvp",
    region: null,
    playerCount: 2,
    queuedAt: 1_000,
    available: true,
    userId: CLERK_USER,
  };
  const found = findCompatibleQuickQueueCandidate(guest, [chessCandidate], 2_000);
  assert.equal(found, null);
});

// ── 3. Rate limits ──────────────────────────────────────────────────────────

test("the guest rate limiter admits up to its limit and then refuses", async () => {
  const key = `test:guest-pvp:${Date.now()}:${Math.random()}`;
  const config = { windowMs: 60_000, max: 2 };

  assert.equal((await consumeRateLimit(key, config)).allowed, true);
  assert.equal((await consumeRateLimit(key, config)).allowed, true);
  const blocked = await consumeRateLimit(key, config);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.remaining, 0);
  assert.ok(blocked.resetAt > Date.now());
});

// ── 4. Gates and guards ─────────────────────────────────────────────────────

test("the queue routes resolve identity from the session, never the body", () => {
  const route = code("src/app/api/quick-queue/route.ts");
  assert.match(route, /requirePvpPlayer\(/);
  assert.doesNotMatch(route, /from "@clerk\/nextjs\/server"/);
  // The session identity is written AFTER the body spread, so it wins.
  assert.match(route, /\.\.\.body,\s*userId: player\.playerId/);
  assert.match(route, /userId: player\.playerId as string/);
  // Cancellation stays scoped by the session identity.
  assert.match(route, /cancelQuickQueueRequest\(player\.playerId as string, requestId\)/);
});

test("the PvP gate uses the signed guest cookie and never trusts a supplied id", () => {
  const gate = code("src/lib/auth/guestPvp.ts");
  assert.match(gate, /resolveGuestId\(\{ create \}\)/);
  assert.match(gate, /requireAgeVerifiedUser\(\)/);
  assert.match(gate, /consumeRateLimit\(/);
  // No request field may become the identity.
  assert.doesNotMatch(gate, /body|searchParams|headers\(\)\.get\(["']x-/);
  assert.doesNotMatch(gate, /guestId\s*=\s*(?:body|params|query)/);
});

test("guest settlement cannot move ratings, trophies, coins or counters", () => {
  for (const [file, signature] of [
    ["src/lib/rating.js", "isGuestPvpMatch([winnerClerkId, loserClerkId])"],
    ["src/lib/trophyStore.js", "isGuestPvpMatch([winnerClerkId, loserClerkId])"],
  ]) {
    const src = code(file);
    assert.match(src, new RegExp(signature.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(src, /reason: "guest-unrated"/);
  }

  const pot = code("src/lib/tokens/pvpPot.ts");
  assert.match(pot, /isGuestSeat\(winnerClerkId\)\) return 0/);

  const counters = code("src/lib/leaderboardCounters.js");
  assert.match(counters, /isGuestSeat\(clerkId\)/);
});

test("the dominoes PvP settlement stops before any account counter or writer", () => {
  // The one guest-enabled PvP game. A guest seat must never reach the W/L
  // counter UPDATEs, and the rated writers sit behind the same guard.
  const src = code("src/lib/dominoes/serverStore.ts");
  const guard = src.indexOf(
    "if (isGuestId(player1) || isGuestId(player2)) return;",
  );
  assert.ok(guard > 0, "the unrated guard must exist");
  assert.ok(
    guard < src.indexOf("gamesWon: sql"),
    "the guard must run before the W/L counters",
  );
  assert.ok(
    guard < src.indexOf('gameKey: "dominoes"'),
    "the guard must run before the rated writers",
  );
});

test("private rooms admit guests only through the PvP session gate", () => {
  // Phase 3D: rooms use the SAME verified-session gate as PvP — Clerk + age
  // for accounts, the signed cookie for guests — never a supplied id.
  const api = code("src/lib/rooms/api.ts");
  assert.match(api, /requirePvpPlayer\(\)/);
  assert.doesNotMatch(api, /requireAgeVerifiedUser\(\)/);
  for (const route of [
    "src/app/api/rooms/join/route.ts",
    "src/app/api/rooms/route.ts",
    "src/app/api/rooms/[roomId]/route.ts",
  ]) {
    assert.match(code(route), /requireRoomActor\(/, `${route} must keep the account gate`);
  }
});

test("the realtime server keeps Clerk and adds only the signed guest cookie", () => {
  // Phase 3F: accounts keep verifyToken; guests are identified by the HMAC
  // cookie, never by a handshake field.
  const server = code("realtime-server/server.js");
  assert.match(server, /verifyToken\(/);
  assert.match(server, /grynd_guest/);
  assert.match(server, /timingSafeEqual/);
  assert.doesNotMatch(server, /handshake\.auth\?\.guest/);
});
