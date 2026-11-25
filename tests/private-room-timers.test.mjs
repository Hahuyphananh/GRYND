/**
 * tests/private-room-timers.test.mjs
 *
 * The PRO room's custom open-for timer.
 *
 * The timer is a ROOM lifecycle setting: it decides how long the host's room
 * stays joinable before the existing lazy expiry sweep closes it. It is not a
 * match clock — no game store accepts one yet — so this suite pins exactly that
 * boundary instead of pretending a game clock exists.
 *
 * TESTED FOR REAL: the pure settings validation (defaults, allowed options,
 * refused values, challenge behaviour) and the store's use of the chosen timer.
 * STRUCTURALLY: the create route allowlists the field and the dialog offers only
 * the catalog's options.
 *
 * Run: node --import tsx --test tests/private-room-timers.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  ROOM_DEFAULT_TIMER_SECONDS,
  ROOM_TIMER_OPTIONS,
  ROOM_TTL_MS,
} from "../src/lib/rooms/catalog.ts";
import {
  challengeSettings,
  resolveRoomSettings,
} from "../src/lib/rooms/settings.ts";

const read = (rel) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");

test("the catalog offers a bounded set of room lifetimes", () => {
  assert.deepEqual([...ROOM_TIMER_OPTIONS], [900, 1800, 3600, 7200]);
  assert.equal(ROOM_DEFAULT_TIMER_SECONDS, 7200);
  assert.equal(ROOM_DEFAULT_TIMER_SECONDS * 1000, ROOM_TTL_MS);
  assert.ok(ROOM_TIMER_OPTIONS.every((seconds) => Number.isInteger(seconds) && seconds > 0));
  assert.equal(new Set(ROOM_TIMER_OPTIONS).size, ROOM_TIMER_OPTIONS.length);
});

test("an absent timer defaults to the full room lifetime", () => {
  for (const raw of [{}, null, { stake: 0 }]) {
    const result = resolveRoomSettings("solitaire-duel", raw);
    assert.equal(result.ok, true);
    assert.equal(result.settings.timerSeconds, ROOM_DEFAULT_TIMER_SECONDS);
  }
});

test("every offered timer is accepted, and nothing else is", () => {
  for (const seconds of ROOM_TIMER_OPTIONS) {
    const result = resolveRoomSettings("precision", { timerSeconds: seconds });
    assert.equal(result.ok, true, `${seconds}s must be accepted`);
    assert.equal(result.settings.timerSeconds, seconds);
  }

  for (const bad of [0, 60, 1000, 3601, 7300, -1800, 900.5, "1800"]) {
    const result = resolveRoomSettings("precision", { timerSeconds: bad });
    assert.equal(result.ok, false, `${String(bad)} must be refused`);
    assert.equal(result.status, 400);
    assert.match(String(result.message), /timer/i);
  }
});

test("a free friend challenge always uses the server's default lifetime", () => {
  const settings = challengeSettings();
  assert.equal(settings.stake, 0);
  assert.equal(settings.timerSeconds, ROOM_DEFAULT_TIMER_SECONDS);
});

test("the room store uses the chosen timer for the room's expiry", () => {
  const source = read("src/lib/rooms/store.ts");
  assert.match(source, /roomSettings\.timerSeconds \* 1000/);
  // A challenge keeps its own fixed invitation TTL.
  assert.match(source, /kind === "challenge" \? CHALLENGE_TTL_MS/);
  // Stored settings that no longer validate fall back to the default timer too.
  assert.match(source, /timerSeconds: ROOM_DEFAULT_TIMER_SECONDS/);
});

test("the create route allowlists the timer and passes it to validation", () => {
  const source = read("src/app/api/rooms/route.ts");
  assert.match(source, /timerSeconds: \{ type: "number", integer: true/);
  assert.match(source, /stake: parsed\.data\.stake \?\? 0,\s+timerSeconds: parsed\.data\.timerSeconds \?\? ROOM_DEFAULT_TIMER_SECONDS,/);
  // PRO gating stays server-resolved.
  assert.match(source, /await getMembershipTier\(userId\)/);
});

test("the dialog offers only catalog timers and sends the chosen one", () => {
  const source = read("src/components/rooms/RoomGameDialog.tsx");
  assert.match(source, /ROOM_TIMER_OPTIONS\.map/);
  assert.match(source, /onConfirm\(/);
  assert.match(source, /timerSeconds/);
  // A challenge cannot choose a room lifetime.
  assert.match(source, /mode === "challenge" \? ROOM_DEFAULT_TIMER_SECONDS : timerSeconds/);
});
