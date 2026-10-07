// tests/guest-seat-avatars.test.mjs
//
// Guest seats must render the "G" badge everywhere — not only on the matches
// served by the shared getSeatIdentity / attachSeatIdentity resolver.
//
// The per-game identity enrichment helpers (mines-pvp, memory-grid, keno-pvp,
// precision) look a seat's clerk id up in `users`. A guest owns no account, so
// the lookup found nothing and the helpers fell back to their "missing user"
// stub, which carries no icon key — and <IconAvatar> resolves an unknown/null
// key to the DEFAULT catalog icon. The seat rendered as a normal player with
// the default pfp instead of the guest's "G".
//
// This suite exercises the pure guest helpers and pins the enrichment + client
// wiring that now routes a guest seat through them.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const {
  GUEST_AVATAR_LETTER,
  GUEST_DISPLAY_NAME,
  guestSeatIdentity,
  guestSeatSummary,
  isGuestId,
} = await import("../src/lib/guestIdentity.ts");

const read = (rel) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");

const GUEST = "guest_0f4e2a1c-0000-4000-8000-000000000000";

test("isGuestId accepts only well-formed guest ids", () => {
  assert.equal(isGuestId(GUEST), true);
  assert.equal(isGuestId("user_2abc"), false);
  assert.equal(isGuestId("guest_"), false);
  assert.equal(isGuestId("guest_has space"), false);
  assert.equal(isGuestId(null), false);
  assert.equal(isGuestId(42), false);
});

test("guestSeatIdentity is the shared guest seat shape", () => {
  assert.deepEqual(guestSeatIdentity(), {
    name: GUEST_DISPLAY_NAME,
    iconKey: null,
    nameColor: null,
    profileFrame: null,
    isGuest: true,
  });
  assert.equal(GUEST_AVATAR_LETTER, "G");
});

test("guestSeatSummary is the per-game enrichment shape", () => {
  const seat = guestSeatSummary(GUEST);
  assert.equal(seat.id, GUEST);
  assert.equal(seat.displayName, GUEST_DISPLAY_NAME);
  // null (NOT "default"): the avatar layer draws the guest badge, so the seat
  // must never resolve to the default catalog icon.
  assert.equal(seat.iconKey, null);
  assert.equal(seat.profileFrame, null);
  assert.equal(seat.nameColor, null);
  assert.equal(seat.isGuest, true);
  assert.equal(seat.missing, false);
});

test("per-game enrichment routes a guest seat through the guest summary", () => {
  for (const file of [
    "src/lib/mines-pvp/serverStore.js",
    "src/lib/memory-grid/serverStore.js",
    "src/lib/keno-pvp/serverStore.js",
  ]) {
    const src = read(file);
    assert.match(src, /import \{ guestSeatSummary, isGuestId \}/, `${file} must use the shared helpers`);
    assert.match(
      src,
      /if \(isGuestId\([^)]*\)\) return guestSeatSummary\(/,
      `${file} must resolve a guest id to the guest seat`,
    );
  }
});

test("precision marks a guest seat on the badges it returns", () => {
  const src = read("src/app/api/precision/get-match/route.ts");
  assert.match(src, /import \{ GUEST_DISPLAY_NAME, isGuestId \}/);
  // Guests are never badge-lookup targets (no users row to find)…
  assert.match(src, /!isGuestId\(p\.userId\)/);
  // …and come back as the guest seat.
  assert.match(src, /isGuestId\(p\.userId\)[\s\S]{0,220}isGuest: true/);
});

test("in-board avatars forward the guest flag to the avatar layer", () => {
  // Every place a per-game summary reaches a seat avatar must pass `isGuest`
  // through, or the "G" never renders.
  const cases = [
    ["src/app/casino/mines-pvp/[matchId]/PageClient.tsx", /isGuest=\{Boolean\(mySummary\?\.isGuest\)\}/],
    ["src/app/casino/mines-pvp/[matchId]/PageClient.tsx", /isGuest=\{Boolean\(oppSummary\?\.isGuest\)\}/],
    ["src/app/casino/keno-pvp/[matchId]/PageClient.jsx", /isGuest=\{Boolean\(summary\?\.isGuest\)\}/],
    ["src/components/keno-pvp/KenoWaitingPanel.jsx", /isGuest=\{Boolean\(occupant\.isGuest\)\}/],
    ["src/app/casino/memory-grid/[matchId]/PageClient.tsx", /isGuest=\{oppIsGuest\}/],
    ["src/components/precision/PrecisionScoreboard.tsx", /isGuest=\{Boolean\(seat1Player\?\.isGuest\)\}/],
    ["src/components/precision/PrecisionScoreboard.tsx", /isGuest=\{Boolean\(seat2Player\?\.isGuest\)\}/],
    ["src/components/precision/PrecisionReadyRoom.tsx", /isGuest=\{Boolean\(occupant\.isGuest\)\}/],
  ];
  for (const [file, pattern] of cases) {
    assert.match(read(file), pattern, `${file} must forward isGuest`);
  }
});

test("the avatar layer renders the guest badge from the flag", () => {
  // <IconAvatar isGuest> is what actually draws "G"; the plumbing above is only
  // meaningful while this stays true.
  const icon = read("src/components/IconAvatar.tsx");
  assert.match(icon, /if \(isGuest\)/);
  assert.match(icon, /GUEST_AVATAR_LETTER/);
  // SeatAvatar + FrameAvatar must forward the flag unmodified.
  assert.match(read("src/components/game/SeatAvatar.tsx"), /isGuest=\{isGuest\}/);
  assert.match(read("src/components/FrameAvatar.tsx"), /isGuest=\{isGuest\}/);
});
