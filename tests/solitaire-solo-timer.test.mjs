// tests/solitaire-solo-timer.test.mjs
//
// Solo's clock starts on the first card move, not when the deal appears.
//
// The component is a client surface, so the two things that can silently drift
// are pinned directly: the pure elapsed-time helper, and the session wiring that
// decides when `timerStartedAtMs` becomes non-null.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { soloElapsedMs } from "../src/lib/solitaire-duel/soloTimer.ts";

const T0 = 1_700_000_000_000;
const SOLO = "src/components/solitaire-duel/SoloSolitaireGame.tsx";
const read = (path) => fs.readFileSync(path, "utf8");

test("an untouched board has taken no time, however long it sits", () => {
  assert.equal(soloElapsedMs(null, null, T0 + 60_000), 0);
  assert.equal(soloElapsedMs(undefined, null, T0 + 3_600_000), 0);
});

test("elapsed time runs from the first move", () => {
  assert.equal(soloElapsedMs(T0, null, T0 + 1_000), 1_000);
  assert.equal(soloElapsedMs(T0, null, T0 + 65_000), 65_000);
});

test("a finished run freezes at its end instant", () => {
  const endedAt = T0 + 42_000;
  assert.equal(soloElapsedMs(T0, endedAt, endedAt + 10 * 60_000), 42_000);
  // An end before the start is a zero-length run, never a negative one.
  assert.equal(soloElapsedMs(T0, T0 - 5_000, T0), 0);
});

test("solo deals a board with the clock explicitly stopped", () => {
  const solo = read(SOLO);
  assert.match(solo, /timerStartedAtMs: null/, "the dealt solo session must not start the clock");
  assert.match(
    solo,
    /timerStartedAtMs: current\.timerStartedAtMs \?\? movedAt/,
    "the first accepted move stamps the start",
  );
  assert.match(
    solo,
    /timerStartedAtMs: current\.timerStartedAtMs \?\? finishedAt/,
    "an auto-finish also stamps a clock that had not started",
  );
});

test("the inactivity limit waits for the first move too", () => {
  const solo = read(SOLO);
  assert.match(
    solo,
    /if \(session\.timerStartedAtMs == null\) return;/,
    "an untouched board must never forfeit",
  );
  assert.match(solo, /session\.timerStartedAtMs != null &&/, "and the idle countdown stays hidden");
});

test("the stopped clock is persisted, restored and shown as 0:00", () => {
  const solo = read(SOLO);
  assert.match(solo, /timerStartedAtMs: session\.timerStartedAtMs/, "the session store keeps it");
  assert.match(solo, /Number\(saved\.timerStartedAtMs\)/, "resume reads it back");
  assert.match(solo, /"0:00"/, "the HUD shows a zero clock, not a dash");
  assert.match(
    solo,
    /soloElapsedMs\(session\.timerStartedAtMs, session\.endedAtMs, nowMs\)/,
    "the displayed time is the shared helper's value",
  );
});
