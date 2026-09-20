import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// ── Four-In-A-Row falling disc + trail ─────────────────────────────────
// The falling-piece animation was moved from a single CSS translateY keyframe
// to the Tower Arena technique: the disc falls with framer-motion and leaves
// THREE delayed copies of itself on the same path. These are source-contract
// checks (the motion itself is measured in the browser by the Tower Arena QA
// harness); they pin the parts that are easy to regress: the three faded
// frames, the reduced-motion gate, the disc-only-in-flight rule, the old
// keyframe being gone, and the multiplayer move identity that stops a polled
// or socket-pushed move from animating twice.

const GAME = fs.readFileSync(
  "src/app/casino/four-in-a-row/game/[gameId]/PageClient.tsx",
  "utf8",
);
const AI = fs.readFileSync(
  "src/app/casino/four-in-a-row/play-ai/PageClient.tsx",
  "utf8",
);
const CSS = fs.readFileSync("src/app/globals.css", "utf8");

const TRAIL_OPACITIES = [0.48, 0.28, 0.12];
const PAGES = [
  ["multiplayer", GAME],
  ["play-ai", AI],
];

for (const [name, src] of PAGES) {
  test(`Four-In-A-Row (${name}) defines the three-frame Towers-style trail`, () => {
    const frames = [
      ...src.matchAll(/\{\s*delay:\s*([\d.]+),\s*opacity:\s*([\d.]+)\s*\}/g),
    ].map((m) => ({ delay: Number(m[1]), opacity: Number(m[2]) }));

    assert.equal(frames.length, 3, "exactly three trail frames");
    assert.deepEqual(
      frames.map((f) => f.opacity),
      TRAIL_OPACITIES,
      "the faded-frame opacities match Tower Arena",
    );
    // Each frame starts strictly later than the one in front of it, which is
    // what turns identical motion into a trail.
    assert.ok(
      frames[1].delay > frames[0].delay && frames[2].delay > frames[1].delay,
    );
  });

  test(`Four-In-A-Row (${name}) honours reduced motion and paints the disc over its ghosts`, () => {
    assert.match(src, /useReducedMotion/);
    assert.match(src, /!reduceMotion/);
    const ghost = src.indexOf('data-testid="fiar-trail-ghost"');
    const disc = src.indexOf('data-testid="fiar-drop-disc"');
    assert.ok(
      ghost > -1 && disc > ghost,
      "ghosts render before the disc so the opaque disc paints on top",
    );
  });

  test(`Four-In-A-Row (${name}) only shows the disc falling into the board`, () => {
    // The landing cell keeps its empty slot until the falling disc arrives, so
    // board state never shows the disc sitting in its cell before it lands.
    assert.match(src, /value=\{[^}]*\?\s*0\s*:\s*value\}/);
  });

  test(`Four-In-A-Row (${name}) no longer stacks the old single-disc keyframe`, () => {
    assert.doesNotMatch(
      src,
      /four-in-a-row-ai-fall|four-in-a-row-fall\b|--fiar-drop-distance|--drop-distance/,
    );
  });
}

test("Four-In-A-Row (multiplayer) animates each server move exactly once", () => {
  // Move identity = game + landing cell + discs on the board, so a repeated
  // poll or socket echo of the same state can never replay the fall.
  assert.match(GAME, /lastAnimatedMoveRef/);
  assert.match(GAME, /const moveKey = `\$\{gameId\}-/);
  assert.match(GAME, /if \(lastAnimatedMoveRef\.current !== moveKey\)/);
});

test("Four-In-A-Row (multiplayer) clears the fall with a key-guarded timer", () => {
  // A new drop that replaces one mid-flight is never cleared early, and the
  // timer is cleaned up on unmount.
  assert.match(GAME, /current\.key === key \? null : current/);
});

test("Four-In-A-Row falling CSS keyframes are gone from globals.css", () => {
  assert.doesNotMatch(CSS, /fourInARowDrop|four-in-a-row-fall/);
});
