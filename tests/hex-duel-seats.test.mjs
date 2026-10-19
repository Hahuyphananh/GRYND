// tests/hex-duel-seats.test.mjs
//
// Hex Duel's viewer -> seat mapping, pinned.
//
// The engine speaks absolute seats; the page renders a local card and an
// opponent card. A guest's cosmetics used to be mapped twice (once in the status
// effect, once in the render), which put the opponent's avatar and name colour on
// the guest's own card. These tests lock the one translation and the render
// wiring that now uses it.
//
// Run: node --import tsx --test tests/hex-duel-seats.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { seatIdentityFrom, viewerSeatsFor } from "../src/lib/hex-duel/seats.ts";

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(here, "..", p), "utf8");
const page = read("src/app/casino/hex-duel/game/[matchId]/PageClient.tsx");

test("viewerSeatsFor: host, guest and spectator each get the right two seats", () => {
  assert.deepEqual(viewerSeatsFor({ isSpectator: false, isPlayer1: true }), {
    local: "player1",
    opponent: "player2",
  });
  assert.deepEqual(viewerSeatsFor({ isSpectator: false, isPlayer1: false }), {
    local: "player2",
    opponent: "player1",
  });
  // A spectator follows seat 1, the same convention as the result view.
  assert.deepEqual(viewerSeatsFor({ isSpectator: true, isPlayer1: false }), {
    local: "player1",
    opponent: "player2",
  });
});

test("seatIdentityFrom reads the ABSOLUTE seat, never a viewer-relative one", () => {
  const game = {
    player1Name: "Host",
    player2Name: "Guest",
    player1IconKey: "host-icon",
    player2IconKey: "guest-icon",
    player1NameColor: "#00ffff",
    player2NameColor: "#ff0000",
    player1ProfileFrame: { id: "host-frame" },
    player2ProfileFrame: { id: "guest-frame" },
  };

  assert.deepEqual(seatIdentityFrom(game, "player1"), {
    name: "Host",
    iconKey: "host-icon",
    nameColor: "#00ffff",
    profileFrame: { id: "host-frame" },
  });
  assert.deepEqual(seatIdentityFrom(game, "player2"), {
    name: "Guest",
    iconKey: "guest-icon",
    nameColor: "#ff0000",
    profileFrame: { id: "guest-frame" },
  });
});

test("seatIdentityFrom tolerates a missing payload and empty strings", () => {
  assert.deepEqual(seatIdentityFrom(null, "player1"), {
    name: null,
    iconKey: null,
    nameColor: null,
    profileFrame: null,
  });
  assert.deepEqual(seatIdentityFrom({ player1Name: "", player2Name: 42 }, "player1"), {
    name: null,
    iconKey: null,
    nameColor: null,
    profileFrame: null,
  });
});

test("the page resolves each side through the shared helper", () => {
  assert.match(page, /import \{ seatIdentityFrom, viewerSeatsFor \}/);
  // Both identity paths (status poll and spectator poll) use the helper.
  assert.equal(
    (page.match(/viewerSeatsFor\(\{ isSpectator, isPlayer1 \}\)/g) ?? []).length,
    2,
    "status and spectator effects must both map seats through viewerSeatsFor",
  );
  assert.match(page, /const local = seatIdentityFrom\([^,]+, seats\.local\)/);
  assert.match(page, /const opponent = seatIdentityFrom\([^,]+, seats\.opponent\)/);
});

test("the render uses the resolved local/opponent identities directly", () => {
  // These used to be remapped by `isPlayer1` a second time, which swapped a
  // guest's avatar, name colour and profile frame with the host's.
  assert.match(page, /const localIconKey = player1IconKey;/);
  assert.match(page, /const localNameColor = player1NameColor;/);
  assert.match(page, /const localProfileFrame = player1ProfileFrame;/);
  assert.match(page, /const oppIconKey = [^;]*opponentIconKey/);
  assert.match(page, /const oppNameColor = [^;]*opponentNameColor/);
  assert.match(page, /const oppProfileFrame = [^;]*opponentProfileFrame/);
  assert.doesNotMatch(
    page,
    /const localIconKey = isSpectator \|\| isPlayer1 \?/,
    "no second isPlayer1 remap on the local card",
  );
});

test("a spectator's local card follows seat 1 for stats and accent colour", () => {
  assert.match(
    page,
    /const localPlayerIsP1 = gameMode !== "multiplayer" \|\| isSpectator \|\| isPlayer1;/,
  );
});
