// tests/hex-duel-troop-visuals.test.mjs
//
// Hex Duel's presentation layer:
//   • troop dots (one per troop, 10 columns, capped at 100, neutral = none)
//   • the source→destination arrow (geometry + board wiring)
//   • the troop popup's source/destination/remaining/expected summary
//
// The maths is pure (src/lib/hexBoardGeometry.ts), so it is tested directly;
// the component/page wiring is pinned at source level because the real proof
// needs a browser.
//
// Run: node --import tsx --test tests/hex-duel-troop-visuals.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  MAX_TROOP_DOTS,
  TROOP_DOT_COLUMNS,
  arrowGeometry,
  describeAttackPreview,
  troopDotCount,
} from "../src/lib/hexBoardGeometry.ts";

const read = (p) => fs.readFileSync(p, "utf8");

// ── A. Troop dots ────────────────────────────────────────────────────────

test("one dot per troop, capped at 100", () => {
  assert.equal(troopDotCount(0), 0);
  assert.equal(troopDotCount(1), 1);
  assert.equal(troopDotCount(10), 10);
  assert.equal(troopDotCount(100), 100);
  assert.equal(troopDotCount(137), MAX_TROOP_DOTS);
  assert.equal(troopDotCount(-4), 0);
  assert.equal(troopDotCount(Number.NaN), 0);
  assert.equal(troopDotCount(5.9), 5, "fractional counts floor");
});

test("the formation is ten columns wide", () => {
  assert.equal(TROOP_DOT_COLUMNS, 10);
  assert.equal(MAX_TROOP_DOTS, 100);
  // 100 dots in 10 columns is exactly 10 rows — the compact maximum.
  assert.equal(MAX_TROOP_DOTS / TROOP_DOT_COLUMNS, 10);
});

test("the tile draws dots only for owned territories, in the owner's colour", () => {
  const tile = read("src/components/HexTile.tsx");

  assert.match(tile, /const troopDots = isOwned \? troopDotCount\(troops\) : 0;/);
  assert.match(tile, /data-hex-troop-dots=\{troopDots\}/);
  assert.match(tile, /repeat\(\$\{TROOP_DOT_COLUMNS\}, \$\{DOT_SIZE\}\)/);
  assert.match(tile, /Array\.from\(\{ length: troopDots \}/);
  // Existing colour language, unchanged.
  assert.match(tile, /const dotColor = owner === "player2" \? "#ef4444" : "#22d3ee";/);
  // The number, the level badge and the capital marker survive.
  assert.match(tile, /<HexTroopCount/);
  assert.match(tile, /L\{level\}/);
  assert.match(tile, /CAP/);
  // Dots can never intercept a tap, and are not a layout element.
  assert.match(tile, /pointer-events-none absolute inset-x-1 inset-y-1/);
  // Counter stays legible over the formation.
  assert.match(tile, /textShadow: "0 0 6px #020617/);
});

// ── B. Arrow geometry ───────────────────────────────────────────────────

const OPTS = { startInset: 20, endInset: 20, headLength: 10, headWidth: 8, labelOffset: 16 };

test("a horizontal arrow starts and ends at the hex edges, tip at the destination", () => {
  const arrow = arrowGeometry({ x: 0, y: 0 }, { x: 100, y: 0 }, OPTS);
  assert.ok(arrow);
  assert.deepEqual(arrow.start, { x: 20, y: 0 });
  assert.deepEqual(arrow.end, { x: 80, y: 0 });
  assert.equal(arrow.head.split(" ")[0], "80,0");
  assert.equal(arrow.head.split(" ").length, 3);
  assert.equal(arrow.angle, 0);
  // Label sits beside the middle of the line, not on it.
  assert.deepEqual(arrow.label, { x: 50, y: 16 });
});

test("a vertical arrow points down the board", () => {
  const arrow = arrowGeometry({ x: 0, y: 0 }, { x: 0, y: 100 }, OPTS);
  assert.ok(arrow);
  assert.deepEqual(arrow.start, { x: 0, y: 20 });
  assert.deepEqual(arrow.end, { x: 0, y: 80 });
  assert.equal(arrow.head.split(" ")[0], "0,80");
  assert.equal(arrow.label.x, -16);
  assert.equal(arrow.label.y, 50);
});

test("a diagonal arrow follows the hex row offset", () => {
  const arrow = arrowGeometry({ x: 10, y: 30 }, { x: 110, y: 130 }, OPTS);
  assert.ok(arrow);
  // Start and end are inset equally along the diagonal.
  assert.equal(Math.round(arrow.start.x - 10), Math.round(arrow.start.y - 30));
  assert.equal(Math.round(110 - arrow.end.x), Math.round(130 - arrow.end.y));
  assert.ok(arrow.end.x > 10 && arrow.end.y > 30, "points at the destination");
  assert.ok(arrow.label.x < arrow.mid.x, "label offset to one side");
});

test("an arrow is refused when the tiles are the same or too close", () => {
  assert.equal(arrowGeometry({ x: 10, y: 10 }, { x: 10, y: 10 }, OPTS), null);
  assert.equal(
    arrowGeometry({ x: 0, y: 0 }, { x: 40, y: 0 }, OPTS),
    null,
    "20 + 20 inset + 10 head leaves no line",
  );
});

test("the board draws the arrow in the acting colour, dashed for displacement", () => {
  const board = read("src/components/HexBoard.tsx");

  assert.match(board, /export interface ActionArrow \{/);
  assert.match(board, /data-hex-action-arrow=\{actionArrow\.mode\}/);
  assert.match(board, /data-hex-arrow-label=""/);
  assert.match(board, /pointer-events-none absolute inset-0 z-20/);
  assert.match(board, /strokeDasharray=\{actionArrow\.mode === "displace" \? "7 5" : undefined\}/);
  assert.match(board, /stroke=\{actionArrow\.color\}/);
  assert.match(board, /role="img"/);
  // Geometry comes from the real tile centres, measured in board layout pixels.
  assert.match(board, /centerIn\(frame, fromEl\)/);
  assert.match(board, /centerIn\(frame, toEl\)/);
  assert.match(board, /el\.offsetLeft \+ el\.offsetWidth \/ 2/);
  // The chosen destination is ringed, so the arrow's end is visible.
  assert.match(board, /isChosenTarget=\{/);
});

// ── Page wiring: shown while choosing troops, gone once resolved ────────

test("the page shows the arrow only while the troop popup is open", () => {
  const page = read("src/app/casino/hex-duel/game/[matchId]/PageClient.tsx");

  assert.match(
    page,
    /if \(pendingActionPhase !== "inputTroops" \|\| !pendingSource \|\| !pendingTarget\) \{\s*\n\s*return null;/,
  );
  assert.match(page, /if \(selectedAction !== "attack" && selectedAction !== "displace"\) return null;/);
  assert.match(page, /mode: selectedAction,/);
  assert.match(page, /actionArrow=\{\s*\n?\s*isGameOver/);
  assert.match(page, /actionTargetKey=\{/);
  // Clearing / confirming resets the pending state, which removes the arrow.
  assert.match(page, /const handleClearAction = useCallback\(\(\) => \{/);
});

// ── C. Troop popup summary ──────────────────────────────────────────────

test("the popup shows source, destination, remaining and the expectation", () => {
  const popup = read("src/components/HexTroopPopup.tsx");

  assert.match(popup, /sourceKey\?: string;/);
  assert.match(popup, /sourceTroops\?: number;/);
  assert.match(popup, /destinationTroops\?: number;/);
  assert.match(popup, /destinationCapacity\?: number;/);
  assert.match(popup, /expected\?: string \| null;/);
  assert.match(popup, /data-hex-attack-preview=""/);
  assert.match(popup, /Math\.max\(0, sourceTroops - value\)/);
  assert.match(popup, /Sending/);
  assert.match(popup, /expectedConquers \? "#4ade80" : "#fca5a5"/);
});

test("the page feeds the popup the authoritative numbers", () => {
  const page = read("src/app/casino/hex-duel/game/[matchId]/PageClient.tsx");

  assert.match(page, /sourceTroops=\{tileTroops\[/);
  assert.match(page, /destinationTroops=\{/);
  assert.match(page, /destinationCapacity=\{/);
  assert.match(page, /expected=\{selectedAction === "attack" \? attackPreview\?\.text \?\? null : null\}/);
  assert.match(page, /expectedConquers=\{/);
  // The expectation comes from the rulebook's own combat resolver.
  assert.match(page, /resolveAttackOutcome\(/);
});

test("the expected-result text covers conquer, tie and failed attacks", () => {
  const conquer = describeAttackPreview(
    { kind: "conquer", remainingTroops: 4, conqueredCapital: false },
  );
  assert.equal(conquer.conquers, true);
  assert.match(conquer.text, /Conquers/);
  assert.match(conquer.text, /4 survive/);

  const capital = describeAttackPreview(
    { kind: "conquer", remainingTroops: 2, conqueredCapital: true },
  );
  assert.match(capital.text, /capital/);

  const capped = describeAttackPreview(
    { kind: "conquer", remainingTroops: 18, conqueredCapital: false },
    10,
  );
  assert.match(capped.text, /10 survive/, "survivors clamp to the level-1 ceiling");

  const tie = describeAttackPreview({ kind: "tie", tileTroops: 0 });
  assert.equal(tie.conquers, false);
  assert.match(tie.text, /neutral/);

  const failed = describeAttackPreview({
    kind: "failed",
    newDefenderTroops: 3,
    defenderWipedOut: false,
  });
  assert.equal(failed.conquers, false);
  assert.match(failed.text, /defender left with 3/);

  const wiped = describeAttackPreview({
    kind: "failed",
    newDefenderTroops: 0,
    defenderWipedOut: true,
  });
  assert.match(wiped.text, /neutral/);
});
