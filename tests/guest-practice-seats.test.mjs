// tests/guest-practice-seats.test.mjs
//
// Guest PRACTICE support for the games the first guest commit left behind:
// Dice Flush, Hex Duel and UNO.
//
// The shared guest model (see tests/guest-seat-avatars.test.mjs and
// src/lib/auth/guestSession.ts) lets a signed-out visitor be a seat in an
// UNRATED vs-AI practice match. These games needed more than a gate swap:
//
//   * Dice Flush resolves the caller in the route and had NO per-room owner
//     check, so a room read/move was open to any authenticated caller. Opening
//     it to guests required a real SEAT check first.
//   * Hex Duel's vs-AI path funnels through /start-game + /end-game, which
//     were account-gated.
//   * UNO keys `uno_games.user_id` off an INTEGER `users.id`, so a guest
//     (`guest_<uuid>`) could not hold a row at all. Migration 0206 makes the
//     account seat nullable and adds a `guest_id` seat; `src/lib/unoSeat.ts`
//     is the single ownership rule.
//
// These are deliberately static/contract checks plus the pure UNO seat
// helpers: the routes need a live database.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const { unoSeatToken, unoCallerToken, isUnoSeat } = await import(
  "../src/lib/unoSeat.ts"
);

const read = (rel) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");

const GUEST = "guest_0f4e2a1c-0000-4000-8000-000000000000";

// ── UNO seat helpers ────────────────────────────────────────────────────────

test("unoSeatToken prefers a valid guest seat over the account seat", () => {
  assert.equal(unoSeatToken({ userId: 42, guestId: GUEST }), GUEST);
  assert.equal(unoSeatToken({ userId: 42, guestId: null }), "42");
  assert.equal(unoSeatToken({ userId: null, guestId: GUEST }), GUEST);
  // A malformed guest id is never a seat.
  assert.equal(unoSeatToken({ userId: null, guestId: "not-a-guest" }), null);
  assert.equal(unoSeatToken({ userId: 7, guestId: "not-a-guest" }), "7");
});

test("unoCallerToken is the guest id for a guest, String(users.id) otherwise", () => {
  assert.equal(unoCallerToken(true, GUEST, null), GUEST);
  assert.equal(unoCallerToken(false, null, 42), "42");
  assert.equal(unoCallerToken(true, null, null), null);
  assert.equal(unoCallerToken(false, null, null), null);
});

test("isUnoSeat matches only the row's own seat", () => {
  const guestGame = { userId: null, guestId: GUEST };
  assert.equal(isUnoSeat(guestGame, GUEST), true);
  assert.equal(isUnoSeat(guestGame, "guest_other"), false);
  assert.equal(isUnoSeat({ userId: 42, guestId: null }, "42"), true);
  assert.equal(isUnoSeat({ userId: 42, guestId: null }, "43"), false);
  assert.equal(isUnoSeat({ userId: 42, guestId: null }, null), false);
});

test("UNO schema + migration give a guest a seat without an integer users.id", () => {
  const schema = read("src/db/schema.ts");
  const unoBlock = schema.slice(
    schema.indexOf("export const unoGames"),
    schema.indexOf("export const rpsGames"),
  );
  // The account seat became nullable and a guest seat column exists.
  assert.match(unoBlock, /userId: integer\("user_id"\),/);
  assert.doesNotMatch(unoBlock, /userId: integer\("user_id"\)\.notNull\(\)/);
  assert.match(unoBlock, /guestId: varchar\("guest_id", \{ length: 64 \}\)/);

  const migration = read("src/db/migrations/0206_uno_guest_seat.sql");
  assert.match(migration, /ALTER COLUMN "user_id" DROP NOT NULL/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS "guest_id" varchar\(64\)/);
});

test("UNO practice routes authorise by seat and accept guests", () => {
  const practiceRoutes = [
    "src/app/api/uno/initialize-vs-ai/route.js",
    "src/app/api/uno/ai-turn/route.js",
    "src/app/api/uno/check-game/route.js",
    "src/app/api/uno/draw-card/route.js",
    "src/app/api/uno/play-card/route.js",
    "src/app/api/uno/resign/route.js",
    "src/app/api/uno/determine-winner/route.js",
  ];
  for (const file of practiceRoutes) {
    const src = read(file);
    assert.match(
      src,
      /requirePracticePlayer/,
      `${file} must accept a guest practice player`,
    );
    assert.doesNotMatch(
      src,
      /requireAgeVerifiedUser/,
      `${file} must not keep the account-only age gate`,
    );
  }
  // The ownership rule lives in the shared helper, not copy-pasted per route.
  for (const file of practiceRoutes.slice(1)) {
    assert.match(
      read(file),
      /isUnoSeat\(/,
      `${file} must check the caller holds the game's seat`,
    );
  }
  // Matchmaking stays account-gated.
  for (const file of [
    "src/app/api/uno/join-online/route.js",
    "src/app/api/uno/available-games/route.js",
    "src/app/api/uno/cancel-waiting/route.js",
  ]) {
    const src = read(file);
    // Matchmaking / lobby routes stay account-gated (either the full age gate
    // or the plain signed-in check).
    assert.ok(
      /requireAgeVerifiedUser|await auth\(\)/.test(src),
      `${file} must stay account-gated`,
    );
    assert.doesNotMatch(src, /requirePracticePlayer/, `${file} must not accept guests`);
  }
});

// ── Dice Flush ──────────────────────────────────────────────────────────────

test("Dice Flush practice routes accept guests and enforce a per-room seat", () => {
  const roomRoutes = [
    "roll",
    "hold",
    "call",
    "choose-category",
    "auto-bank",
    "ai-turn",
    "resign",
    "state",
    "history",
    "totals",
  ];
  for (const name of roomRoutes) {
    const src = read(`src/app/api/dice-flush/${name}/route.js`);
    assert.match(
      src,
      /requirePracticePlayer/,
      `dice-flush/${name} must accept a guest practice player`,
    );
    assert.doesNotMatch(
      src,
      /requireAgeVerifiedUser/,
      `dice-flush/${name} must not keep the account-only age gate`,
    );
  }

  const lib = read("src/app/api/dice-flush/_lib.js");
  assert.match(lib, /export function isRoomSeat\(/);
  assert.match(lib, /export function assertRoomSeat\(/);
  // A guest seat name resolves without a `users` row.
  assert.match(lib, /if \(isGuestId\(userId\)\) return GUEST_DISPLAY_NAME;/);

  // The entry route mints the guest cookie.
  assert.match(
    read("src/app/api/dice-flush/start-ai/route.js"),
    /requirePracticePlayer\(\{ create: true \}\)/,
  );

  // Every room-scoped route calls the seat check.
  for (const name of [
    "roll",
    "hold",
    "call",
    "choose-category",
    "auto-bank",
    "ai-turn",
    "resign",
    "history",
    "totals",
  ]) {
    assert.match(
      read(`src/app/api/dice-flush/${name}/route.js`),
      /assertRoomSeat\(/,
      `dice-flush/${name} must check the caller's seat`,
    );
  }

  // The state read resolves the seat inside its own transaction and reports
  // the viewer's seat id back to the client.
  const state = read("src/app/api/dice-flush/state/route.js");
  assert.match(state, /isRoomSeat\(room\.gameState, viewerId\)/);
  assert.match(state, /viewerId,/);
  // A guest seat is decorated as a guest (letter badge), never the default pfp.
  assert.match(state, /isGuestId\(p\.userId\)[\s\S]{0,160}isGuest: true/);
});

test("Dice Flush client identifies its seat from the server, not just Clerk", () => {
  const src = read("src/app/casino/dice-flush/PageClient.tsx");
  // The viewer seat id comes from the server response so a guest (no Clerk id)
  // can still tell which seat is its own.
  assert.match(src, /const \[viewerId, setViewerId\] = useState<string \| null>\(null\)/);
  assert.match(src, /const viewerSeatId = viewerId \?\? user\?\.id;/);
  assert.match(src, /p\.userId === viewerSeatId/);
  assert.match(src, /if \(d\.viewerId\) setViewerId\(d\.viewerId\)/);
  // The in-board avatar forwards the guest flag.
  assert.match(src, /isGuest=\{Boolean\(opponent\?\.isGuest\)\}/);
  assert.match(src, /isGuest\?: boolean;/);
});

// ── Hex Duel ────────────────────────────────────────────────────────────────

test("Hex Duel vs-AI start/end accept guests; multiplayer stays account-gated", () => {
  const start = read("src/app/api/hex-duel/start-game/route.ts");
  assert.match(start, /requirePracticePlayer\(\{ create: true \}\)/);
  // The PvP branch keeps the account + age gate.
  assert.match(start, /requireAgeVerifiedUser/);

  const end = read("src/app/api/hex-duel/end-game/route.ts");
  assert.match(end, /requirePracticePlayer/);
  assert.doesNotMatch(end, /requireAgeVerifiedUser/);
  // A pure for-fun match carries no AI-session proof.
  assert.match(end, /if \(isAiGame === true && isFunMode !== true\)/);

  for (const file of [
    "src/app/api/hex-duel/multiplayer/create/route.ts",
    "src/app/api/hex-duel/multiplayer/join/route.ts",
    "src/app/api/hex-duel/multiplayer/action/route.ts",
    "src/app/api/hex-duel/multiplayer/end/route.ts",
  ]) {
    assert.match(read(file), /requireAgeVerifiedUser/, `${file} must stay account-gated`);
  }
});
