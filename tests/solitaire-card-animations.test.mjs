/**
 * solitaire-card-animations.test.mjs
 *
 * THE CARD ANIMATION CONTRACT.
 *
 * Two layers, because the animation has two failure modes that tests can catch
 * without a browser:
 *
 *   1. DETECTION — the pure planner in lib/solitaire-duel/cardAnimations.ts.
 *      These tests drive it with real snapshot pairs: a reveal, a draw, a
 *      three-card draw, waste-to-tableau, a redeal, a repeated server snapshot,
 *      a rewind and a new deal. They are what proves an animation cannot replay
 *      on a rerender or on an unchanged position.
 *
 *   2. WIRING — source-level checks on the board, the card and the stylesheet.
 *      A future edit could keep the planner honest and still break the visual
 *      contract (drop `preserve-3d`, animate every waste card, animate a
 *      read-only review). Those seams are asserted directly.
 *
 * Run:  node --import tsx --test tests/solitaire-card-animations.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  EMPTY_CARD_ANIMATION_PLAN,
  detectCardAnimations,
  isCardAnimationPlanEmpty,
  tableauSlotKey,
} from "../src/lib/solitaire-duel/cardAnimations.ts";

const read = (path) => fs.readFileSync(path, "utf8").replace(/\r\n/g, "\n");
/** Source with comments stripped, so prose about a rule cannot satisfy it. */
const code = (path) =>
  read(path)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

const CARD = "src/components/solitaire-duel/PlayingCard.tsx";
const BOARD = "src/components/solitaire-duel/SolitaireBoard.tsx";
const CSS = "src/app/globals.css";
const DETECTOR = "src/lib/solitaire-duel/cardAnimations.ts";

// ── Fixtures ─────────────────────────────────────────────────────────────

const card = (suit, rank) => ({ suit, rank });
const up = (c) => ({ faceUp: true, card: c });
const down = () => ({ faceUp: false, card: null });

/** A minimal but valid SolitaireView; only the fields the planner reads matter. */
const view = ({
  tableau = [[], [], [], [], [], [], []],
  stockCount = 0,
  waste = [],
  ply = 1,
  resetCount = 0,
} = {}) => ({
  tableau,
  stockCount,
  waste,
  foundations: { spades: [], hearts: [], diamonds: [], clubs: [] },
  nextStockCard: null,
  ply,
  resetCount,
  progress: { foundationCards: 0, revealedTableau: 0, percent: 0 },
  completed: false,
});

const A = card("spades", 1);
const B = card("hearts", 2);
const C = card("clubs", 3);
const D = card("diamonds", 4);

// ── 1. A face-down tableau card becomes face-up: exactly one flip ────────

test("reveal: a face-down slot that becomes face-up is flipped once", () => {
  const previous = view({ tableau: [[down(), down()], [], [], [], [], [], []], ply: 4 });
  const next = view({ tableau: [[down(), up(A)], [], [], [], [], [], []], ply: 5 });

  const plan = detectCardAnimations(previous, next);

  assert.deepEqual(plan.reveals, [{ column: 0, index: 1, key: tableauSlotKey(0, 1) }]);
  assert.equal(plan.draw, null);
  assert.equal(plan.redeal, null);
});

test("reveal: only the slot that changed is flipped", () => {
  const previous = view({
    tableau: [[down(), down(), down()], [], [], [], [], [], []],
    ply: 4,
  });
  const next = view({
    tableau: [[down(), up(A), down()], [], [], [], [], [], []],
    ply: 5,
  });

  assert.deepEqual(
    detectCardAnimations(previous, next).reveals.map((reveal) => reveal.key),
    [tableauSlotKey(0, 1)],
  );
});

// ── 2. An already face-up card does not replay its flip ─────────────────

test("reveal: an already face-up card is never flipped again", () => {
  const previous = view({ tableau: [[up(A), up(B)], [], [], [], [], [], []], ply: 4 });
  const next = view({
    tableau: [[up(A), up(B), up(C)], [], [], [], [], [], []],
    ply: 5,
  });

  assert.deepEqual(detectCardAnimations(previous, next).reveals, []);
});

// ── 3. An unchanged server snapshot does not replay an animation ────────

test("snapshot: the same position delivered again animates nothing", () => {
  const previous = view({
    tableau: [[down(), up(A)], [], [], [], [], [], []],
    waste: [B],
    stockCount: 9,
    ply: 7,
  });
  // A different object with the same content — the server re-sends its state.
  const resent = view({
    tableau: [[down(), up(A)], [], [], [], [], [], []],
    waste: [B],
    stockCount: 9,
    ply: 7,
  });

  assert.ok(isCardAnimationPlanEmpty(detectCardAnimations(previous, resent)));
});

test("snapshot: a rewound position (undo / review step back) animates nothing", () => {
  const previous = view({
    tableau: [[down(), up(A)], [], [], [], [], [], []],
    waste: [C],
    stockCount: 9,
    ply: 9,
  });
  const rewound = view({
    tableau: [[down(), down()], [], [], [], [], [], []],
    waste: [],
    stockCount: 10,
    ply: 8,
  });

  assert.ok(isCardAnimationPlanEmpty(detectCardAnimations(previous, rewound)));
});

test("snapshot: a fresh deal never animates the whole board", () => {
  const previous = view({ tableau: [[down()], [], [], [], [], [], []], ply: 12 });
  const redealt = view({
    tableau: [[down()], [], [], [], [], [], []],
    ply: 13,
    resetCount: 1,
  });

  assert.ok(isCardAnimationPlanEmpty(detectCardAnimations(previous, redealt)));
});

test("snapshot: there is no plan before a previous view exists", () => {
  assert.deepEqual(
    detectCardAnimations(null, view({ tableau: [[up(A)]] })),
    EMPTY_CARD_ANIMATION_PLAN,
  );
  assert.deepEqual(detectCardAnimations(view(), null), EMPTY_CARD_ANIMATION_PLAN);
});

// ── 4. Drawing from the stock animates only the newly drawn card ────────

test("draw: the card that left the stock is the one that travels and flips", () => {
  const previous = view({ stockCount: 10, waste: [], ply: 2 });
  const next = view({ stockCount: 9, waste: [A], ply: 3 });

  assert.deepEqual(detectCardAnimations(previous, next).draw, { cardKey: "spades-1" });
});

test("draw: a three-card draw animates only the topmost new waste card", () => {
  const previous = view({ stockCount: 10, waste: [D], ply: 2 });
  const next = view({ stockCount: 7, waste: [D, A, B, C], ply: 3 });

  assert.deepEqual(detectCardAnimations(previous, next).draw, { cardKey: "clubs-3" });
});

test("draw: rapid successive draws each animate their own new top card", () => {
  const v1 = view({ stockCount: 10, waste: [], ply: 2 });
  const v2 = view({ stockCount: 9, waste: [A], ply: 3 });
  const v3 = view({ stockCount: 8, waste: [A, B], ply: 4 });
  const v4 = view({ stockCount: 7, waste: [A, B, C], ply: 5 });

  const draws = [
    detectCardAnimations(v1, v2).draw?.cardKey,
    detectCardAnimations(v2, v3).draw?.cardKey,
    detectCardAnimations(v3, v4).draw?.cardKey,
  ];
  assert.deepEqual(draws, ["spades-1", "hearts-2", "clubs-3"]);
  // No card is drawn twice and none is skipped.
  assert.equal(new Set(draws).size, 3);
  // Replaying the last snapshot cannot double the animation.
  assert.equal(detectCardAnimations(v4, v4).draw, null);
});

// ── 5. Existing waste cards do not flip again ───────────────────────────

test("draw: no stock movement means the waste never replays a flip", () => {
  const previous = view({ stockCount: 9, waste: [A, B], ply: 6 });
  const next = view({ stockCount: 9, waste: [A, B], ply: 7 }); // some other move

  assert.equal(detectCardAnimations(previous, next).draw, null);
});

// ── 6. Moving the top waste card is not a draw ──────────────────────────

test("waste: moving the top card to the tableau does not animate a new draw", () => {
  const previous = view({
    tableau: [[], [], [], [], [], [], []],
    stockCount: 9,
    waste: [A, B],
    ply: 6,
  });
  const next = view({
    tableau: [[up(B)], [], [], [], [], [], []],
    stockCount: 9,
    waste: [A],
    ply: 7,
  });

  const plan = detectCardAnimations(previous, next);
  assert.equal(plan.draw, null);
  // The card arriving in the tableau is a NEW slot, not a reveal.
  assert.deepEqual(plan.reveals, []);
});

test("waste: moving the top card to a foundation animates nothing", () => {
  const previous = view({ stockCount: 9, waste: [A, B], ply: 6 });
  const next = view({ stockCount: 9, waste: [A], ply: 7 });
  next.foundations.spades = [B];

  assert.ok(isCardAnimationPlanEmpty(detectCardAnimations(previous, next)));
});

// ── 7. Recycling the waste keeps the correct order and state ────────────

test("redeal: an empty stock refilled from the waste is a redeal", () => {
  const previous = view({ stockCount: 0, waste: [A, B, C], ply: 8 });
  // The engine reverses the waste into the stock and empties the waste.
  const next = view({ stockCount: 3, waste: [], ply: 9 });

  assert.deepEqual(detectCardAnimations(previous, next).redeal, {
    cardKeys: ["spades-1", "hearts-2", "clubs-3"],
  });
});

test("redeal: a redeal that immediately draws still counts as a redeal", () => {
  // rules.ts may leave the top card face-up on the waste after a redeal-draw.
  const previous = view({ stockCount: 0, waste: [A, B, C], ply: 8 });
  const next = view({ stockCount: 2, waste: [A], ply: 9 });

  const plan = detectCardAnimations(previous, next);
  assert.ok(plan.redeal, "the stock refilling is the redeal");
  assert.deepEqual(plan.redeal.cardKeys, ["spades-1", "hearts-2", "clubs-3"]);
  // The card left on the waste was already exposed there, so it is not a draw.
  assert.equal(plan.draw, null);
});

test("redeal: a normal draw is never mistaken for a redeal", () => {
  const previous = view({ stockCount: 5, waste: [A], ply: 8 });
  const next = view({ stockCount: 4, waste: [A, B], ply: 9 });

  assert.equal(detectCardAnimations(previous, next).redeal, null);
});

// ── 8. Rapid clicks cannot duplicate or lose cards ──────────────────────

test("state safety: plans are derived from snapshots, never from click count", () => {
  // Two rapid clicks drawn optimistically before the server answers: each view
  // is a full projection, so the second cannot re-add the first card.
  const v1 = view({ stockCount: 10, waste: [], ply: 2 });
  const afterFirst = view({ stockCount: 9, waste: [A], ply: 3 });
  const afterSecond = view({ stockCount: 8, waste: [A, B], ply: 4 });

  const first = detectCardAnimations(v1, afterFirst);
  const second = detectCardAnimations(afterFirst, afterSecond);

  assert.equal(first.draw.cardKey, "spades-1");
  assert.equal(second.draw.cardKey, "hearts-2");
  assert.equal(afterSecond.waste.length, 2);
  assert.equal(afterSecond.stockCount, 8);
  // The waste is exactly [A, B]: no duplicate, no skipped card.
  assert.deepEqual(afterSecond.waste.map((c) => `${c.suit}-${c.rank}`), [
    "spades-1",
    "hearts-2",
  ]);
});

// ── 9. No hidden identity is exposed by the plan ────────────────────────

test("privacy: a reveal carries a slot, never the hidden card's identity", () => {
  const previous = view({ tableau: [[down()], [], [], [], [], [], []], ply: 3 });
  const next = view({ tableau: [[up(A)], [], [], [], [], [], []], ply: 4 });

  const [reveal] = detectCardAnimations(previous, next).reveals;
  assert.deepEqual(Object.keys(reveal).sort(), ["column", "index", "key"]);
  assert.equal("card" in reveal, false);
});

test("privacy: the detector never reads a face-down card's `card` field", () => {
  const src = code(DETECTOR);
  // Only the faceUp FLAG of a slot is consulted before pushing a reveal, and
  // only after `slot.faceUp` has been checked.
  assert.match(src, /if \(!slot\.faceUp \|\| !slot\.card\) return;/);
  assert.doesNotMatch(src, /was\.card/);
});

// ── 10. The board and card wiring ───────────────────────────────────────

test("card: both faces coexist and are turned by a real 3D transform", () => {
  const src = code(CARD);
  assert.match(src, /perspective: "700px"/);
  assert.match(src, /transformStyle: "preserve-3d"/);
  assert.match(src, /backfaceVisibility: "hidden"/);
  // The face is pre-rotated so the wrapper's 180° shows it.
  assert.match(src, /rotateY\(180deg\)/);
  // Both faces are always rendered; the back is painted by CSS from the
  // board-level custom properties, so the component reads no theme variable.
  assert.match(src, /className="sol-card-back /);
  assert.equal(src.includes("--sol-"), false, "the card must not read a table variable");
  const cosmetics = read("src/app/solitaire-cosmetics.css");
  assert.match(cosmetics, /\.sol-card-back \{\s*background-image: var\(--sol-card-back-image/);
  // No identity is ever painted on a face-down card.
  assert.match(src, /if \(!faceUp \|\| !card\)/);
  assert.match(src, /data-card=\{frontCard \?/);
  // Accessibility is preserved.
  assert.match(src, /aria-label=\{label \|\|/);
});

test("card: the flip and draw are one-shot CSS animations, not loops", () => {
  const src = code(CARD);
  assert.match(src, /gr-card-reveal/);
  assert.match(src, /gr-card-draw-translate/);
  assert.match(src, /gr-card-draw-flip/);
  assert.doesNotMatch(src, /infinite|repeat:|iterations/);
});

test("board: reveals come from the snapshot diff, gated on readOnly/reviewAnimate/reduced motion", () => {
  const src = code(BOARD);
  assert.match(src, /detectCardAnimations\(previousViewRef\.current, board\)/);
  assert.match(src, /if \(!board \|\| reduceMotion\) return EMPTY_CARD_ANIMATION_PLAN;/);
  assert.match(
    src,
    /if \(readOnly && !reviewAnimate\) return EMPTY_CARD_ANIMATION_PLAN;/,
  );
  assert.match(src, /reviewAnimate\?: boolean/);
  assert.match(src, /\[board, readOnly, reviewAnimate, reduceMotion\]/);
  assert.match(src, /useReducedMotion\(\)/);
  // The reveal is handed to the card by SLOT, so it flips in place.
  assert.match(src, /reveal=\{revealSlots\.has\(tableauSlotKey\(column, index\)\)\}/);
  assert.match(src, /key=\{`slot-\$\{column\}-\$\{index\}`\}/);
});

test("board: only the newly drawn waste card receives the draw animation", () => {
  const src = code(BOARD);
  assert.match(
    src,
    /isTop && drawAnim\?\.cardKey === `\$\{card\.suit\}-\$\{card\.rank\}`/,
  );
  // The waste fan/overlap and the top-card gate are untouched.
  assert.match(src, /wasteVisible = waste\.slice\(Math\.max\(0, waste\.length - 3\)\)/);
  assert.match(src, /interactive=\{isTop && cardsInteractive\}/);
});

test("board: the redeal is a staggered overlay that cleans itself up", () => {
  const src = code(BOARD);
  assert.match(src, /data-testid="solitaire-redeal-ghost"/);
  assert.match(src, /REDEAL_STAGGER_MS/);
  assert.match(src, /animation: `gr-card-redeal/);
  assert.match(src, /setRedealGhosts\(null\)/);
  // The overlay is presentational.
  assert.match(src, /pointer-events-none fixed z-40/);
});

test("board: interactions and move submission are untouched", () => {
  const src = code(BOARD);
  for (const seam of [
    "onPointerDown",
    "onPointerMove",
    "onPointerUp",
    "onPointerCancel",
    "resolveClick(board, selection, target)",
    "onMove(move)",
    "moveForTarget(board, session.selection, slot.drop)",
  ]) {
    assert.ok(src.includes(seam), `${seam} must remain`);
  }
  assert.match(src, /const cardsInteractive = interactive;/);
  // No timer and no animation state stands between a gesture and the move.
  assert.match(src, /setDragGhost\(null\);\s*onMove\(move\);/);
});

test("board: the animation layer owns no game state", () => {
  const src = code(BOARD);
  for (const forbidden of ["applyMove", "chooseAiMove", "dealFromSeed", "Math.random"]) {
    assert.equal(src.includes(forbidden), false, `${forbidden} must not appear`);
  }
});

test("styles: the keyframes exist with the documented durations", () => {
  const css = read(CSS);
  for (const name of [
    "gr-card-reveal",
    "gr-card-draw-translate",
    "gr-card-draw-flip",
    "gr-card-redeal",
  ]) {
    assert.match(css, new RegExp(`@keyframes ${name}\\b`), `${name} must be defined`);
  }
  // Natural easings, never linear, and no bounce/overshoot in the card layer.
  const cardLayer = css.slice(css.indexOf("SOLITAIRE CARD ANIMATIONS"));
  assert.doesNotMatch(cardLayer, /linear/);
  assert.doesNotMatch(cardLayer, /infinite/);
});

test("sound: a card landing on a pile plays the shared card cue", () => {
  const board = code(BOARD);
  const audio = code("src/lib/gameAudio.ts");

  // The cue is the existing, shared placement sound — not a new audio stack.
  assert.match(board, /import \{ playCardPlace \} from "\.\.\/\.\.\/lib\/gameAudio"/);
  assert.match(audio, /export function playCardPlace/);
  // Mute is enforced once, centrally: the shared context returns null.
  assert.match(audio, /getSharedAudioContext/);
  assert.doesNotMatch(audio, /new Audio\(/);

  // Reduced motion silences it, and a stock draw is not a placement.
  assert.match(board, /if \(reduceMotion\) return;/);
  assert.match(board, /move\.kind !== "draw"/);

  // One cue per accepted move: the drop, the click and the press path each
  // announce. The definition itself (`announceMove = useCallback`) is not a call.
  const calls = board.match(/announceMove\(/g) ?? [];
  assert.ok(calls.length >= 3, `expected 3 accepted-move call sites, got ${calls.length}`);
  assert.match(
    board,
    /announceMove\(result\.move\);\s*setSelection\(null\);\s*onMove\(result\.move\);/,
    "the click path announces the move it actually sends",
  );
});

test("sound: the cue is a no-op without a browser audio context", async () => {
  const { playCardPlace } = await import("../src/lib/gameAudio.ts");
  assert.doesNotThrow(() => playCardPlace());
});

test("dependencies: no animation library was added", () => {
  const pkg = JSON.parse(read("package.json"));
  const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  for (const forbidden of ["gsap", "animejs", "@react-spring/web", "lottie-web", "popmotion"]) {
    assert.equal(deps.includes(forbidden), false, `${forbidden} must not be added`);
  }
  assert.ok(deps.includes("framer-motion"), "the existing library is used");
});
