import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// ── Four-In-A-Row interaction feedback ─────────────────────────────────
// Visual-only affordances: hovering/selecting a playable column marks exactly
// ONE column rail and ONE landing-cell preview (the player's own disc, faded),
// the click marks the column as pending, and the hint yields to the real
// falling disc. These source checks pin the parts a browser check can't see
// across the multiplayer page's server round-trip.

const GAME = fs.readFileSync(
  "src/app/casino/four-in-a-row/game/[gameId]/PageClient.tsx",
  "utf8",
);
const AI = fs.readFileSync(
  "src/app/casino/four-in-a-row/play-ai/PageClient.tsx",
  "utf8",
);
const CSS = fs.readFileSync("src/app/globals.css", "utf8");

const PAGES = [
  ["multiplayer", GAME],
  ["play-ai", AI],
];

for (const [name, src] of PAGES) {
  test(`Four-In-A-Row (${name}) tracks ONE hovered column`, () => {
    assert.match(src, /useState<number \| null>\(null\)/);
    assert.match(src, /setHoverCol/);
    // One delegated handler covers every cell, using the cell's data attribute.
    assert.match(src, /handleBoardPointerOver/);
    assert.match(src, /closest\?\.\(\s*"\[data-cell\]"/);
    assert.match(src, /dataset\.cell/);
    // Hover never survives into the opponent's turn.
    assert.match(src, /if \(!canPlay\) setHoverCol\(null\)/);
  });

  test(`Four-In-A-Row (${name}) draws one column rail + one landing preview`, () => {
    assert.match(src, /data-testid="fiar-column-hint"/);
    assert.match(src, /data-testid="fiar-column-preview"/);
    assert.match(src, /four-in-a-row-column-hint/);
    assert.match(src, /four-in-a-row-preview/);
    // The rail spans the column; the preview is pinned to the landing cell.
    assert.match(src, /gridRowEnd: 7/);
    assert.match(src, /gridRowStart: hintRow \+ 1/);
    // Both are gated on the single hint state, so nothing renders wholesale.
    assert.match(src, /hintVisible &&/);
  });

  test(`Four-In-A-Row (${name}) yields the hint to the falling disc`, () => {
    assert.match(src, /hintCol !== null/);
    assert.match(src, /hintRow >= 0/);
  });

  test(`Four-In-A-Row (${name}) previews the player's own disc`, () => {
    // The preview reuses the real Disc component (no new visual).
    assert.match(src, /<Disc[\s\S]{0,120}four-in-a-row-preview/);
  });
}

test("Four-In-A-Row (multiplayer) marks the clicked column pending immediately", () => {
  // Set before the request leaves, and only cleared for that same column.
  assert.match(GAME, /setPendingCol\(column\)/);
  assert.match(GAME, /setPendingCol\(\(current\) => \(current === column \? null : current\)\)/);
  assert.match(GAME, /pendingCol === hintCol/);
  assert.match(GAME, /four-in-a-row-drop-button--pending/);
});

test("Four-In-A-Row (multiplayer) hints only while the drop is in flight", () => {
  assert.match(GAME, /showFall && fallingDisc!\.col === hintCol/);
});

test("Four-In-A-Row column availability never indexes a missing board", () => {
  assert.match(GAME, /Array\.isArray\(game\?\.board\)/);
});

test("Four-In-A-Row feedback CSS exists and is one-shot (no permanent pulse)", () => {
  assert.match(CSS, /\.four-in-a-row-column-hint\s*\{/);
  assert.match(CSS, /\.four-in-a-row-preview\s*\{/);
  assert.match(CSS, /\.four-in-a-row-preview--pending\s*\{/);
  assert.match(CSS, /@keyframes fourInARowPending/);
  assert.match(CSS, /four-in-a-row-drop-button--hint/);
  assert.match(CSS, /four-in-a-row-drop-button--pending/);
  // One-shot priority cue only — never an infinite/looping feedback animation.
  assert.doesNotMatch(CSS, /fourInARowPending[\s\S]{0,200}infinite/);
  assert.doesNotMatch(CSS, /four-in-a-row-preview[\s\S]{0,200}infinite/);
});
