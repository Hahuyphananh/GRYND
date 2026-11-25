/**
 * solitaire-auto-finish.test.mjs
 *
 * Auto-finish is a RULES decision, not a UI convenience: the remaining cards may
 * only be flown home when the engine can actually play them home, without a
 * stock turn, a waste cycle or any tableau rearrangement. Timing and result
 * safety are pinned alongside it, because the animation must never be able to
 * change what was recorded.
 *
 * Run: node --import tsx --test tests/solitaire-auto-finish.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  AUTO_FINISH_MAX_MS,
  autoFinishPlan,
  canAutoFinish,
} from "../src/lib/solitaire-duel/autoFinish.ts";
import {
  foundationCount,
  initialStateFromDeal,
  viewForState,
} from "../src/lib/solitaire-duel/rules.ts";
import { solvableDealFromSeed } from "../src/lib/solitaire-duel/solvable.ts";
import { flightFrame, flightWindows } from "../src/components/solitaire-duel/measureFinishCards.ts";

const SUITS = ["spades", "hearts", "diamonds", "clubs"];

const runOf = (suit, from, to) =>
  Array.from({ length: to - from + 1 }, (_, index) => ({ suit, rank: from + index }));

/** A synthetic server board, so a position can be built card by card. */
function board({ foundations = {}, tableau = [], stock = [], waste = [] } = {}) {
  const piles = { spades: [], hearts: [], diamonds: [], clubs: [] };
  for (const suit of SUITS) piles[suit] = foundations[suit] ?? [];
  // The engine refuses a board that is not a full seven-column Klondike shape.
  const columns = Array.from({ length: 7 }, (_, index) =>
    (tableau[index] ?? []).map((card) => ({ faceUp: true, card })),
  );
  return {
    variant: "klondike-1",
    variantVersion: 3,
    tableau: columns,
    stock,
    waste,
    foundations: piles,
    ply: 0,
    resetCount: 0,
    peakFoundation: 0,
    completed: false,
    completedAtMs: null,
  };
}

/** Everything except one King, which sits alone on the tableau. */
function oneCardLeft() {
  return board({
    foundations: {
      spades: runOf("spades", 1, 12),
      hearts: runOf("hearts", 1, 13),
      diamonds: runOf("diamonds", 1, 13),
      clubs: runOf("clubs", 1, 13),
    },
    tableau: [[{ suit: "spades", rank: 13 }]],
  });
}

test("a verified finish plays every remaining card to its foundation", () => {
  const state = oneCardLeft();
  assert.equal(canAutoFinish(state), true);
  const plan = autoFinishPlan(state);
  assert.ok(plan);
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0].move.kind, "tableau-to-foundation");
  assert.equal(plan.finalState.completed, true);
  assert.equal(foundationCount(plan.finalState), 52);
});

test("the sequence is legal, ordered, and lands all 52 cards", () => {
  const state = board({
    foundations: {
      spades: runOf("spades", 1, 10),
      hearts: runOf("hearts", 1, 13),
      diamonds: runOf("diamonds", 1, 13),
      clubs: runOf("clubs", 1, 13),
    },
    // Jack, Queen and King are tops of their own columns, so each becomes legal
    // only after the one before it has landed.
    tableau: [
      [{ suit: "spades", rank: 13 }],
      [{ suit: "spades", rank: 12 }],
      [{ suit: "spades", rank: 11 }],
    ],
  });
  const plan = autoFinishPlan(state);
  assert.ok(plan);
  assert.deepEqual(
    plan.steps.map((step) => step.card.rank),
    [11, 12, 13],
  );
  assert.equal(plan.finalState.completed, true);
  assert.equal(foundationCount(plan.finalState), 52);
  // The final board is the board the shared renderer would show, not a second
  // representation.
  assert.equal(viewForState(plan.finalState).completed, true);
});

test("an uncovered board that still needs a tableau move is NOT eligible", () => {
  // Everything is face up and the stock/waste are empty, but the King is buried
  // under a card that cannot go up yet: a player still has a decision to make.
  const state = board({
    foundations: {
      spades: runOf("spades", 1, 10),
      hearts: runOf("hearts", 1, 12),
      diamonds: runOf("diamonds", 1, 13),
      clubs: runOf("clubs", 1, 13),
    },
    tableau: [[{ suit: "spades", rank: 13 }, { suit: "hearts", rank: 13 }]],
  });
  assert.equal(canAutoFinish(state), false);
});

test("a stock or waste that still needs turning blocks auto-finish", () => {
  const base = oneCardLeft();
  assert.equal(canAutoFinish({ ...base, stock: [{ suit: "hearts", rank: 1 }] }), false);
  assert.equal(canAutoFinish({ ...base, stock: [], waste: [{ suit: "hearts", rank: 1 }] }), false);
});

test("a single face-down card blocks auto-finish", () => {
  const state = oneCardLeft();
  state.tableau[0][0].faceUp = false;
  assert.equal(autoFinishPlan(state), null);
});

test("an ordinary mid-game deal is never finished for the player", () => {
  for (const seed of [7, 2026, 4242]) {
    const state = initialStateFromDeal(solvableDealFromSeed(seed));
    assert.equal(canAutoFinish(state), false);
  }
  assert.equal(autoFinishPlan(null), null);
});

test("the animation has a hard 5s ceiling and honours reduced motion", () => {
  assert.equal(AUTO_FINISH_MAX_MS, 5_000);
  const source = fs.readFileSync(
    "src/components/solitaire-duel/AutoFinishAnimation.tsx",
    "utf8",
  );
  assert.match(source, /AUTO_FINISH_MAX_MS/);
  assert.match(source, /requestAnimationFrame/);
  assert.match(source, /prefers-reduced-motion: reduce/);
  assert.match(source, /Skip animation/);
  assert.match(source, /RATE: Record<2 \| 5, number> = \{ 2: 1, 5: 2\.5 \}/);
  // The run is driven by one shared timeline, and the deadline wins over it.
  assert.match(source, /now - startedAt >= AUTO_FINISH_MAX_MS/);
  // The animation owns no rules: it never plans moves or records a result.
  assert.doesNotMatch(source, /autoFinishPlan\(|recordResult|applyMove\(/);
});

test("the flight is aimed at the pile as it is on screen, not at a stale snapshot", () => {
  const animation = fs.readFileSync(
    "src/components/solitaire-duel/AutoFinishAnimation.tsx",
    "utf8",
  );
  const measure = fs.readFileSync(
    "src/components/solitaire-duel/measureFinishCards.ts",
    "utf8",
  );
  // The completed board paints under the flight and its collapse can move the
  // page, so the foundations are re-read WHILE the cards fly…
  assert.match(animation, /syncGeometry\(\);/);
  assert.match(animation, /measureFoundationTargets\(\)/);
  assert.match(animation, /targetsRef\.current\[entry\.card\.suit\] \?\? entry\.to/);
  // …and the whole flight is drawn in the board's LIVE frame, so a collapsing
  // tableau or a clamped scroll can never strand the cards above the pile.
  assert.match(animation, /measureBoardOrigin\(\)/);
  assert.match(animation, /flightFrame\(entry, to, boardOriginRef\.current, t\)/);
  assert.match(measure, /export function measureBoardOrigin/);
  assert.match(measure, /export function measureFoundationTargets/);
  assert.match(measure, /flying\.push\(\{ card: step\.card, from, to, board \}\)/);
});

test("the finished board can move under the flight and the cards still land on the pile", () => {
  // A flight measured on the pre-finish board: the Ace of spades sat low in the
  // tableau and the spade foundation sat near the top.
  const entry = {
    card: { suit: "spades", rank: 1 },
    from: { x: 40, y: 700, width: 92, height: 130 },
    to: { x: 300, y: 100, width: 92, height: 130 },
    board: { x: 20, y: 40, height: 620 },
  };
  // The tableau collapsed, the finished board is a shorter page, and the clamped
  // scroll pushed the table 550px DOWN — the old bug: cards stopped 550px high.
  const liveBoard = { x: 20, y: 590 };
  const liveFoundation = { x: 300, y: 650, width: 92, height: 130 };

  const landed = flightFrame(entry, liveFoundation, liveBoard, 1);
  assert.deepEqual(landed, liveFoundation, "the last frame is the pile itself");

  // The source rides the board's movement, so the card does not teleport.
  const departed = flightFrame(entry, liveFoundation, liveBoard, 0);
  assert.deepEqual(
    { x: departed.x, y: departed.y },
    { x: 40, y: 700 + 550 },
    "the card leaves from where the board put it",
  );

  // A frozen snapshot is exactly the reported bug: finishing above the pile.
  const frozen = flightFrame(entry, entry.to, null, 1);
  assert.equal(liveFoundation.y - frozen.y, 550);

  // A resized pile is landed on, not just its top-left corner.
  const resized = flightFrame(entry, { x: 300, y: 650, width: 60, height: 86 }, liveBoard, 1);
  assert.equal(resized.width, 60);
  assert.equal(resized.height, 86);
});

test("cards are queued per foundation, so each suit lands as one tidy stack", () => {
  const card = (suit, rank) => ({
    card: { suit, rank },
    from: { x: 0, y: 0, width: 92, height: 130 },
    to: { x: 0, y: 0, width: 92, height: 130 },
    board: { x: 0, y: 0, height: 600 },
  });
  // The plan's global order interleaves nothing here — the point is that the
  // QUEUES are per suit, and each suit keeps the order the plan plays it in.
  const cards = [
    card("spades", 11),
    card("spades", 12),
    card("spades", 13),
    card("hearts", 12),
    card("hearts", 13),
  ];
  const windows = flightWindows(cards);

  // Both piles start together instead of the table waiting its turn…
  assert.equal(windows[0].start, 0);
  assert.ok(Math.abs(windows[0].end - 0.5) < 1e-9);
  assert.equal(windows[3].start, 0, "the second suit's first card also leaves at once");

  // …each suit's cards leave one after another, in plan order…
  for (const [first, second, third] of [
    [windows[0], windows[1], windows[2]],
    [windows[3], windows[4]],
  ]) {
    assert.ok(first.start < second.start, "a pile's queue is ordered");
    if (third) assert.ok(second.start < third.start);
  }
  // …and the whole flight still fits the one shared timeline, inside the cap.
  for (const window of windows) {
    assert.ok(window.start >= 0 && window.start <= 0.55);
    assert.ok(window.end > window.start && window.end <= 1);
  }
  // The last card of the LONGEST queue is the last to leave.
  assert.equal(windows[2].start, Math.max(...windows.map((w) => w.start)));
});

test("the board holds its pre-finish height until the flight is over", () => {
  const board = fs.readFileSync(
    "src/components/solitaire-duel/SolitaireBoard.tsx",
    "utf8",
  );
  const solo = fs.readFileSync(
    "src/components/solitaire-duel/SoloSolitaireGame.tsx",
    "utf8",
  );
  const duel = fs.readFileSync(
    "src/app/casino/solitaire-duel/[matchId]/PageClient.tsx",
    "utf8",
  );
  const measure = fs.readFileSync(
    "src/components/solitaire-duel/measureFinishCards.ts",
    "utf8",
  );
  // The height is measured with the flight, then held on the board root…
  assert.match(measure, /export function measureBoardHeight/);
  assert.match(measure, /height: measureBoardHeight\(\)/);
  assert.match(board, /holdHeight\?: number/);
  // …and the felt has a full-table floor derived from its own geometry, so the
  // empty tableau cannot collapse it while the flight or the victory panel is up.
  assert.match(board, /const MIN_BOARD_HEIGHT = `calc\(var\(--cw\) \* \$\{BOARD_CW\}\)`/);
  assert.match(board, /minHeight:\s*\n?\s*holdHeight && holdHeight > 0\s*\n?\s*\? `max\(\$\{holdHeight\}px, \$\{MIN_BOARD_HEIGHT\}\)`\s*\n?\s*: MIN_BOARD_HEIGHT/);
  // No maximum: the floor must never stop the board expanding with its content.
  assert.doesNotMatch(board, /maxHeight/);
  // …by BOTH finishes, for as long as the overlay is mounted.
  assert.match(solo, /holdHeight=\{finishing\?\.\[0\]\?\.board\.height\}/);
  assert.match(duel, /holdHeight=\{finishing\?\.\[0\]\?\.board\.height\}/);
});

test("the finish wears the active table theme, but the cards keep their own palette", () => {
  const source = fs.readFileSync(
    "src/components/solitaire-duel/AutoFinishAnimation.tsx",
    "utf8",
  );
  // One shared theme store: the overlay cannot disagree with the board it covers.
  assert.match(source, /useSolitaireBoardTheme/);
  assert.match(source, /const \{ theme \} = useSolitaireBoardTheme\(\)/);
  assert.match(source, /data-solitaire-theme=\{theme\.key\}/);
  assert.match(source, /backgroundImage: theme\.felt/);
  assert.match(source, /theme\.legal\.ink/);
  assert.match(source, /theme\.slot\.activeFill/);
  assert.match(source, /theme\.legend/);
  // The theme paints the furniture, never the card face.
  const card = source.slice(source.indexOf("<PlayingCard"), source.indexOf("</div>", source.indexOf("<PlayingCard")));
  assert.equal(card.includes("--sol-"), false, "PlayingCard must not read a theme variable");
});

test("time stops before the animation and the result is recorded once", () => {
  const source = fs.readFileSync(
    "src/components/solitaire-duel/SoloSolitaireGame.tsx",
    "utf8",
  );
  // The completed board, the frozen clock and the log all come from the plan…
  assert.match(source, /autoFinishPlan\(applied\.state\)/);
  assert.match(source, /endedAtMs: finishedAt/);
  // …the finish is measured against the PRE-finish board…
  assert.match(source, /measureFinishCards\(plan\.steps\)/);
  // …and only then is the cosmetic flight queued.
  assert.match(source, /pendingFinishRef\.current = flying/);
  // The victory panel waits for the animation (or its skip).
  assert.match(source, /session\.won && !finishing/);
  assert.match(source, /<AutoFinishAnimation cards=\{finishing\}/);
  // The earlier moves survive: the log is appended to, never replaced, because
  // the result endpoint replay-verifies the whole game from the deal.
  assert.match(source, /log: \[\s*\.\.\.current\.log,/);
  // Exactly one submission path, guarded by the log-length key.
  assert.match(source, /submittedRef/);
  assert.match(source, /void recordResult\(next\);/);
});
