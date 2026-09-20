// tests/hex-duel-turn-layout.test.mjs
//
// Contract tests for Hex Duel's turn-transition layout and its rolling troop
// numbers.
//
// These are SOURCE-level locks on the structures that keep the board still and
// make the numbers animate, because the real proof needs a browser (it is
// qa/hex-duel-turn-check.mjs, which measures per-frame board positions and
// reads the digits off the DOM). What is locked here is the shape that makes
// those measurements hold — the things a later edit could quietly undo:
//
//   * the status bar's End Turn button is MOUNTED for the whole game (it used
//     to unmount for the AI's and the opponent's turn, which collapsed the row
//     and pulled the whole board up the page on every turn end);
//   * the AI control row above the board keeps its items (invisible, not
//     unmounted) after the match's first move — this was the real 48px jump:
//     the row was gated on `p1MoveCount === 0 && p2MoveCount === 0`, so the
//     first move of a game removed it outright;
//   * the multiplayer turn band is one box in both turn states rather than a
//     card that appears and disappears with the turn;
//   * nothing that toggles `invisible` also uses `transition-all`, which
//     transitions `visibility` and leaves a control enabled-but-invisible for
//     ~100ms when it comes back;
//   * the tile troop number is the rolling counter, and that counter is keyed
//     on the value (so a poll/rerender can't replay it) and settles
//     immediately under reduced motion.
//
// Run:  node --import tsx --test tests/hex-duel-turn-layout.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(here, "..", p), "utf8");

const PAGE = read("src/app/casino/hex-duel/PageClient.tsx");
const TILE = read("src/components/HexTile.tsx");
const COUNTER = read("src/components/HexTroopCount.tsx");

/** Whitespace-insensitive source matching (the page is CRLF and re-indented). */
const squash = (text) => text.replace(/\s+/g, " ").trim();
const has = (haystack, needle) =>
  squash(haystack).includes(squash(needle))
    ? true
    : (() => {
        throw new Error(`expected source to contain:\n  ${squash(needle)}`);
      })();

/** Assertions test CODE, not the prose that explains it. */
const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "");

/** A window of source starting at the first occurrence of `marker`. */
const after = (source, marker, len = 1600) => {
  const at = source.indexOf(marker);
  assert.ok(at >= 0, `marker not found: ${marker}`);
  return source.slice(at, at + len);
};

// Bounded to the component/row itself, so an unrelated `transition-all`
// further down the page can't make (or break) these assertions.
const STATUS_BAR = PAGE.slice(PAGE.indexOf("function StatusBar("), PAGE.indexOf("type GameMode ="));
const AI_PANEL = PAGE.slice(
  PAGE.indexOf('data-hex-ai-panel=""'),
  PAGE.indexOf("{desktopContent}"),
);
const TURN_BAND = after(PAGE, 'data-hex-turn-band=""', 2200);
const TROOP_BAR = after(PAGE, "function TroopBar(", 2000);

// ══════════════════════════════════════════════════════════════════════════
//  The status bar's End Turn button
// ══════════════════════════════════════════════════════════════════════════

/** The status bar's End Turn button element (not the turn row above it). */
const endTurnAt = STATUS_BAR.indexOf("onClick={onEndTurn}");
const endTurnOpen = STATUS_BAR.lastIndexOf("<button", endTurnAt);
const END_TURN = STATUS_BAR.slice(endTurnOpen, STATUS_BAR.indexOf("</button>", endTurnOpen));
/** The JSX condition that mounts it — everything back to its opening brace. */
const END_TURN_GATE = STATUS_BAR.slice(STATUS_BAR.lastIndexOf("{", endTurnOpen), endTurnOpen);

test("status bar: the End Turn button is mounted for the whole game", () => {
  // Its render condition must not depend on whose turn it is — that is what
  // used to remove the button (and the row's height) on every turn end.
  assert.ok(END_TURN.length > 0, "found the End Turn button");
  assert.ok(!/isAITurn/.test(END_TURN_GATE), `gate mentions isAITurn: ${END_TURN_GATE}`);
  assert.ok(!/showEndTurn/.test(END_TURN_GATE), `gate mentions showEndTurn: ${END_TURN_GATE}`);
  has(END_TURN_GATE, "!isGameOver");
  has(END_TURN, "disabled={isAITurn || !showEndTurn}");
  has(END_TURN, "tabIndex={isAITurn || !showEndTurn ? -1 : undefined}");
  has(END_TURN, '? "invisible"');
});

test("status bar: the reserved button box is a fixed height either way", () => {
  // Both colour variants must be the same height, or reaching 0 AP would shift
  // the row by the 2px border difference.
  has(END_TURN, "mt-2 h-[34px] px-5");
});

test("status bar: toggling `invisible` never uses transition-all", () => {
  // Scoped to the button itself: the turn dot's own `transition-all` is
  // unrelated (and never hidden).
  assert.ok(END_TURN.includes("invisible"), "the slice is the End Turn button");
  assert.ok(
    !/transition-all/.test(code(END_TURN)),
    "`transition-all` also transitions `visibility`, which flips mid-duration and " +
      "leaves the button focusable while it is invisible",
  );
  has(END_TURN, "transition-[color,background-color,border-color,box-shadow,transform,filter]");
});

// ══════════════════════════════════════════════════════════════════════════
//  The AI control row (the 48px jump)
// ══════════════════════════════════════════════════════════════════════════

test("the AI control row survives the match's first move", () => {
  // It must be gated on the match existing, not on no move having happened.
  has(PAGE, '{showGame && (\n            <div data-hex-ai-panel=""');
  assert.ok(
    !/showGame && p1MoveCount === 0 && p2MoveCount === 0 && \(/.test(PAGE),
    "the AI control row must not be unmounted once a move exists",
  );
  has(PAGE, "const aiControlsLocked = p1MoveCount > 0 || p2MoveCount > 0;");
});

test("the locked AI controls keep their boxes (invisible, not unmounted)", () => {
  has(AI_PANEL, "disabled={aiControlsLocked}");
  // The difficulty group keeps its width, so the row cannot drop a line.
  has(AI_PANEL, 'flex items-center gap-1.5 ${aiControlsLocked ? "invisible" : ""}');
  // The "AI analyzing..." read-out is always in the row and only hidden — it
  // used to appear and push the row onto a second line on phones.
  has(AI_PANEL, '${aiAnalyzing ? "" : "invisible"}');
  // The controls that go invisible must not transition `visibility` (it flips
  // mid-transition, leaving them enabled-but-invisible when they come back).
  has(AI_PANEL, "duration-200 transition-[color,background-color,border-color,box-shadow,transform] border");
  has(
    AI_PANEL,
    "duration-200 transition-[color,background-color,border-color,box-shadow,transform] border capitalize",
  );
});

test("the sound toggle stays available for the whole match", () => {
  // The row always has at least this item, so its box exists throughout.
  has(AI_PANEL, "onClick={() => audio.setEnabled(!audio.enabled)}");
});

// ══════════════════════════════════════════════════════════════════════════
//  The multiplayer turn band
// ══════════════════════════════════════════════════════════════════════════

test("the multiplayer turn band does not come and go with the turn", () => {
  const condition = PAGE.slice(
    PAGE.lastIndexOf("{", PAGE.indexOf('data-hex-turn-band=""')),
    PAGE.indexOf('data-hex-turn-band=""'),
  );
  assert.ok(
    /gameMode === "multiplayer" && !isGameOver/.test(squash(condition)),
    "the band must be mounted for the whole multiplayer match",
  );
  assert.ok(
    !/isLocalTurn|opponentReady/.test(condition),
    "the band's mount condition must not depend on whose turn it is",
  );
  assert.ok(TURN_BAND.length > 0);
});

test("both turn states render the same band, differing only in text and hue", () => {
  // One card element with conditional TEXT — not two different cards.
  has(TURN_BAND, 'isLocalTurn ? "border-cyan-400/20" : "border-red-500/20"');
  has(TURN_BAND, 'isLocalTurn ? "Your move" : "Waiting for opponent..."');
  // A one-line hint and a two-line one must occupy the same height.
  has(TURN_BAND, 'className="mt-1.5 min-h-[14px] text-[10px] text-slate-500"');
});

// ══════════════════════════════════════════════════════════════════════════
//  The rolling troop numbers
// ══════════════════════════════════════════════════════════════════════════

test("the tile troop number is the rolling counter", () => {
  has(TILE, 'import HexTroopCount from "./HexTroopCount";');
  has(TILE, "<HexTroopCount");
  has(TILE, "value={troops}");
  assert.ok(
    !/\{troops\}\s*<\/span>/.test(TILE),
    "the tile must not render a raw {troops} digit any more",
  );
});

test("the player card's troop total uses the same counter", () => {
  has(PAGE, 'import HexTroopCount from "../../../components/HexTroopCount";');
  has(TROOP_BAR, "<HexTroopCount");
  has(TROOP_BAR, "value={troops}");
});

test("the counter rolls, keyed on the value", () => {
  // Keyed on `value` (not on a render), with a guard that swallows a re-run at
  // a value it has already handled: that is what makes a poll, a socket
  // re-delivery or a rerender unable to replay the roll.
  has(COUNTER, "}, [value]);");
  has(COUNTER, "if (seenRef.current === value) return;");
  has(COUNTER, "if (from === value) return;");
  // A mid-flight change continues from what is on screen rather than snapping.
  has(COUNTER, "const from = renderedRef.current;");
});

test("the counter settles immediately under reduced motion", () => {
  has(COUNTER, "prefers-reduced-motion: reduce");
  has(COUNTER, "if (prefersReducedMotion()) {");
  const branch = after(COUNTER, "if (prefersReducedMotion()) {", 200);
  has(branch, "renderedRef.current = value;");
  has(branch, "setDisplay(value);");
});

test("the counter does not animate on mount, and cleans up its frame", () => {
  has(COUNTER, "useState(value)");
  has(COUNTER, "useRef(value)");
  has(COUNTER, "cancelAnimationFrame(frameRef.current)");
});

test("the counter carries the direction in its movement", () => {
  // Up = lift + grow, down = dip + shrink; the sign of the movement is the
  // information when a count changes by one and there is no value in between.
  has(COUNTER, "translateY(${(-direction * 2 * emphasis).toFixed(2)}px)");
  has(COUNTER, "scale(${(1 + direction * 0.14 * emphasis).toFixed(3)})");
  has(COUNTER, "brightness(${(1 + direction * 0.35 * emphasis).toFixed(3)})");
  // Tabular figures so the digits don't shuffle sideways while they roll.
  has(COUNTER, "inline-block tabular-nums");
  // A QA anchor, like `data-tile-key` / `data-hex-board`.
  has(COUNTER, "data-troop-count={value}");
});

test("no gameplay, scoring or server module was touched for this polish", () => {
  const engine = read("src/lib/hexDuelEngine.ts");
  assert.ok(!/HexTroopCount|data-troop-count/.test(engine), "the engine stays presentational-free");
  const ai = read("src/lib/hexDuelAI.ts");
  assert.ok(!/HexTroopCount|data-troop-count/.test(ai));
});
