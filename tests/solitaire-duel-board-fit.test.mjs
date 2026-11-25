/**
 * solitaire-duel-board-fit.test.mjs
 *
 * The Solitaire Duel board must be visible without scrolling, must use a
 * phone's full width (and height) in normal play, and must fill the display in
 * full screen with the card size derived from the whole viewport.
 *
 * History: `--cw` was sized by width alone (`clamp(34px, 10.4vw, 92px)`). On any
 * desktop wide enough for the clamp to saturate, that pinned every card at 92px
 * and the board became a FIXED height: 7.04 card-widths, i.e. 648px of cards, so
 * at 1280x800 the bottom of the tableau sat below the fold. The fix added a
 * height term. This test pins the arithmetic, because the failure mode is
 * invisible in review: the board still renders, it is just cut off.
 *
 * The width term is no longer a flat `vw` fraction: it is "seven columns in the
 * room the page leaves", which is what lets a phone board fill its screen, and
 * full screen swaps in a viewport-only fit (`FULLSCREEN_CARD_SIZE`).
 *
 * Run:  node --import tsx --test tests/solitaire-duel-board-fit.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const BOARD = read("src/components/solitaire-duel/SolitaireBoard.tsx");

// ── The geometry the component's own constants describe ────────────────────
// Mirrored from SolitaireBoard.tsx; if the card ratio or the fan overlaps
// change there, the height budget below has to be recomputed with them.
const CARD_RATIO = 1.42;
const FACE_UP_OVERLAP = 0.72;
const FACE_DOWN_OVERLAP = 0.86;

/** Visible vertical advance of a fanned card, in card widths. */
const faceUpAdvance = CARD_RATIO - FACE_UP_OVERLAP; // 0.70
const faceDownAdvance = CARD_RATIO - FACE_DOWN_OVERLAP; // 0.56

/** Worst-case column: seven cards, all face-up. */
const tallestColumn = CARD_RATIO + 6 * faceUpAdvance; // 5.62
/** …plus the stock/waste/foundations row above it. */
const BOARD_CW = CARD_RATIO + tallestColumn; // 7.04

/** The chrome above the tableau, as the component declares it (17rem). */
const CHROME_PX = 17 * 16; // 272
/** The board's own footer row (legend + controls), 3rem. */
const FOOTER_PX = 3 * 16; // 48

test("the card size is derived from the viewport height, not the width alone", () => {
  // The height term has to survive in the normal-page clamp …
  assert.match(
    BOARD,
    /const BOARD_CARD_SIZE = [^\n]*100dvh/,
    "the card size must include a viewport-height term",
  );
  assert.match(
    BOARD,
    /"--cw": immersive[\s\S]{0,180}BOARD_CARD_SIZE/,
    "the board must swap fits when it goes full screen",
  );
  // … and the width term must be seven columns of the room the page leaves,
  // not a flat vw fraction that ignores the padding and the column gaps.
  assert.match(
    BOARD,
    /const BOARD_CARD_SIZE = `clamp\(34px, min\(calc\(\(100vw - 4\.5rem\) \/ 7\), calc\(\(100dvh - \$\{CHROME_REM\}\) \/ \$\{BOARD_CW\}\)\), 92px\)`/,
    "the clamp must take the SMALLER of the column-width term and the height term",
  );
});

test("the height budget is derived from the board's own geometry", () => {
  // BOARD_CW must come from the constants, not a magic number — otherwise a
  // change to the fan overlap silently invalidates the budget.
  assert.match(
    BOARD,
    /const BOARD_CW = \(CARD_RATIO \+ \(CARD_RATIO \+ 6 \* FACE_UP_ADVANCE\)\)\.toFixed\(2\)/,
    "BOARD_CW must be derived from CARD_RATIO and the face-up advance",
  );
  assert.match(
    BOARD,
    /const FACE_UP_ADVANCE = CARD_RATIO - 0\.72/,
    "the advance must be CARD_RATIO minus the overlap, not 1 minus it",
  );
  assert.match(BOARD, /const CHROME_REM = "17rem"/, "the chrome budget must be declared");
  assert.match(BOARD, /const FOOTER_REM = "3rem"/, "the board's footer must be budgeted");
});

test("the board geometry itself is unchanged", () => {
  // The fit resizes the board; it must not alter the card proportions or the
  // fan, which the interaction model and the visual design both depend on.
  assert.match(BOARD, /const CARD_H = "calc\(var\(--cw\) \* 1\.42\)"/);
  assert.match(BOARD, /const FACE_UP_OVERLAP = "calc\(var\(--cw\) \* -0\.72\)"/);
  assert.match(BOARD, /const FACE_DOWN_OVERLAP = "calc\(var\(--cw\) \* -0\.86\)"/);
});

// ── The arithmetic: the board must fit the viewport it is sized for ────────

/** Resolve the normal-page clamp the way the browser does. */
function cardWidthFor({ vw, vh }) {
  const widthTerm = Math.min((vw - 4.5 * 16) / 7, 92);
  const heightTerm = (vh - CHROME_PX) / BOARD_CW;
  return Math.min(92, Math.max(34, Math.min(widthTerm, heightTerm)));
}

/** Resolve the full-screen clamp the way the browser does (portrait). */
function fullscreenCardWidthFor({ vw, vh }) {
  const widthTerm = Math.min((vw - 3 * 16) / 7, 160);
  const heightTerm = (vh - 4.5 * 16) / BOARD_CW;
  return Math.min(160, Math.max(34, Math.min(widthTerm, heightTerm)));
}

/**
 * Resolve the LANDSCAPE full-screen clamp: seven tableau columns plus the
 * two-card side panel (nine card-widths), and only the tallest column — 5.62
 * card-widths — against the height, with no foundations row above it.
 */
function landscapeCardWidthFor({ vw, vh }) {
  const widthTerm = Math.min((vw - 5.5 * 16) / 9, 160);
  const heightTerm = (vh - 2.5 * 16) / 6;
  return Math.min(160, Math.max(34, Math.min(widthTerm, heightTerm)));
}

test("at 1280x800 the tableau fits above the fold", () => {
  const cw = cardWidthFor({ vw: 1280, vh: 800 });
  const boardHeight = cw * BOARD_CW;
  const usable = 800 - CHROME_PX;
  assert.ok(
    boardHeight <= usable,
    `the board is ${boardHeight.toFixed(0)}px but only ${usable}px is available`,
  );
  // …and the cards shrank rather than the clamp being satisfied by the floor.
  assert.ok(cw < 92, `the cards must shrink below the 92px maximum (got ${cw.toFixed(1)}px)`);
  assert.ok(cw > 60, `the cards must stay comfortably readable (got ${cw.toFixed(1)}px)`);
});

test("the width-only clamp overflowed; the height term is what fixes it", () => {
  // Regression guard with teeth — under the previous sizing the same viewport
  // scrolled, which is the bug this test exists to keep fixed.
  const oldCw = 92;
  const oldBoard = oldCw * BOARD_CW;
  const usable = 800 - CHROME_PX;
  assert.ok(
    oldBoard > usable,
    "the old fixed 92px cards should overflow at 1280x800 — that was the bug",
  );
  assert.ok(
    oldBoard - usable > 100,
    `the old overflow should be substantial (was ${(oldBoard - usable).toFixed(0)}px)`,
  );
});

test("every common desktop viewport fits, without over-shrinking", () => {
  for (const vh of [760, 800, 870, 900, 1080]) {
    const cw = cardWidthFor({ vw: 1280, vh });
    const boardHeight = cw * BOARD_CW;
    assert.ok(
      boardHeight <= vh - CHROME_PX + 0.5,
      `at 1280x${vh} the board is ${boardHeight.toFixed(0)}px but only ${vh - CHROME_PX}px fits`,
    );
  }
  // A tall screen keeps the full-size cards: the width term must win there, or
  // the change would have shrunk the board on displays that never had a problem.
  assert.equal(cardWidthFor({ vw: 1280, vh: 1080 }), 92);
  assert.equal(cardWidthFor({ vw: 1920, vh: 1080 }), 92);
});

test("a phone now uses its full width, and the felt fills its height", () => {
  // The old flat width term left ~1/8 of a 390px phone unused. The new term is
  // "seven columns in what the page leaves", so the cards grow with the screen.
  for (const [vw, vh] of [
    [390, 844],
    [360, 640],
    [414, 896],
  ]) {
    const cw = cardWidthFor({ vw, vh });
    const oldCw = Math.max(34, Math.min((10.4 / 100) * vw, 92));
    assert.ok(cw >= 34, `a ${vw}x${vh} phone must keep cards at or above the 34px floor`);
    assert.ok(
      cw >= oldCw - 0.01,
      `a ${vw}x${vh} phone must not shrink (was ${oldCw.toFixed(1)}px, now ${cw.toFixed(1)}px)`,
    );
    // Seven cards plus the six 4px gaps still fit the page's 2rem horizontal
    // padding, so no column is ever clipped at the right edge.
    assert.ok(
      7 * cw + 6 * 4 <= vw - 2 * 16 + 0.5,
      `seven ${cw.toFixed(1)}px cards must fit inside a ${vw}px phone`,
    );
  }
  // The felt's floor reaches the bottom of the screen's usable height, rather
  // than stopping at the tableau's own height.
  assert.match(
    BOARD,
    /const BOARD_MIN_HEIGHT = `max\(\$\{MIN_BOARD_HEIGHT\}, calc\(100dvh - \$\{CHROME_REM\} - \$\{FOOTER_REM\}\)\)`/,
    "the normal board must fill the viewport under the page chrome",
  );
});

// ── Full screen ───────────────────────────────────────────────────────────

test("the board has a full-screen toggle that enters and leaves", () => {
  assert.match(
    BOARD,
    /data-testid="solitaire-fullscreen-toggle"/,
    "the toggle must be reachable inside the board (it is the only chrome that survives full screen)",
  );
  assert.match(BOARD, /element\.requestFullscreen\(\{ navigationUI: "hide" \}\)/);
  assert.match(BOARD, /document\.exitFullscreen\(\)/, "the same button must leave full screen");
  assert.match(
    BOARD,
    /orientationApi\(\)\?\.lock\?\.\("landscape"\)/,
    "full screen must ask for landscape on phones",
  );
  assert.match(BOARD, /orientationApi\(\)\?\.unlock\?\.\(\)/, "leaving must release the lock");
  // The iOS fallback: a fixed, viewport-filling layer when the API is refused.
  assert.match(BOARD, /setPseudoFullscreen\(!entered\)/);
  assert.match(BOARD, /fixed inset-0 z-\[100\]/);
});

test("portrait full screen is sized by the whole viewport", () => {
  assert.match(
    BOARD,
    /const FULLSCREEN_CARD_SIZE = `clamp\(34px, min\(calc\(\(100vw - 3rem\) \/ 7\), calc\(\(100dvh - 4\.5rem\) \/ \$\{BOARD_CW\}\)\), 160px\)`/,
  );
  const portrait = { vw: 390, vh: 844 };
  assert.ok(
    fullscreenCardWidthFor(portrait) >= cardWidthFor(portrait),
    "full screen must never shrink the cards on a phone",
  );
});

test("landscape full screen moves the top row to a side panel and uses the width", () => {
  // The landscape clamp is a different budget: nine card-widths across (seven
  // tableau columns + a two-card panel) and only 5.62 card-widths down.
  assert.match(
    BOARD,
    /const FULLSCREEN_LANDSCAPE_CARD_SIZE = `clamp\(34px, min\(calc\(\(100vw - 5\.5rem\) \/ 9\), calc\(\(100dvh - 2\.5rem\) \/ 6\)\), 160px\)`/,
  );
  // The panel: the top row leaves its above-the-tableau position.
  assert.match(BOARD, /order: 2/);
  assert.match(BOARD, /width: "calc\(var\(--cw\) \* 2 \+ 0\.5rem\)"/);
  assert.match(BOARD, /style=\{landscapeBoard \? \{ order: 1, marginTop: 0, flex: "0 0 auto" \} : undefined\}/);
  // The controls dock in the corner instead of costing the cards a row.
  assert.match(BOARD, /position: "absolute", right: 8, bottom: 8/);

  // 844x390 — a phone on its side, the orientation full screen asks for.
  const phone = { vw: 844, vh: 390 };
  const cw = landscapeCardWidthFor(phone);
  // The panel is the tallest thing: four rows (stock, waste, 2x2 foundations).
  const panelHeight = 4 * CARD_RATIO * cw + 3 * 8;
  assert.ok(
    panelHeight + 16 <= phone.vh,
    `in landscape the side panel is ${panelHeight.toFixed(0)}px and must fit ${phone.vh}px`,
  );
  const contentWidth = 7 * cw + 6 * 8 + 16 + (2 * cw + 8);
  assert.ok(
    contentWidth + 16 <= phone.vw,
    `the tableau plus panel is ${contentWidth.toFixed(0)}px wide and must fit ${phone.vw}px`,
  );
  // The point of the layout: the cards are bigger than the portrait fit and the
  // board uses most of the landscape width instead of a narrow centred strip.
  assert.ok(
    cw > fullscreenCardWidthFor(phone),
    `landscape cards (${cw.toFixed(1)}px) must beat the portrait fit (${fullscreenCardWidthFor(phone).toFixed(1)}px)`,
  );
  assert.ok(
    contentWidth > 0.6 * phone.vw,
    `the board should use most of the width (used ${contentWidth.toFixed(0)}px of ${phone.vw}px)`,
  );
});

test("the drag ghost inherits the board's card sizing, so a gesture cannot fight the fit", () => {
  // A ghost sized by hand (or by a fixed px) would either be the wrong size at
  // the phone clamp or push the board around. It is OUT OF FLOW and sized from
  // the same CARD_W/CARD_H the board uses.
  const at = BOARD.indexOf('data-testid="solitaire-drag-ghost"');
  assert.ok(at > 0, "the drag ghost must exist");
  const ghost = BOARD.slice(at - 500, at + 1200);

  assert.match(ghost, /fixed/, "the ghost must be out of flow");
  assert.match(ghost, /pointer-events-none/, "the ghost must never shadow a drop slot");
  assert.match(ghost, /width: CARD_W/, "the ghost must use the board's card width");
  assert.match(ghost, /height: CARD_H/, "the ghost must use the board's card height");
  // No pixel or rem size of its own: the clamp stays the single source of size.
  assert.doesNotMatch(ghost, /width: \d+(px)?\b/);
  assert.doesNotMatch(ghost, /height: \d+(px)?\b/);

  // …and the cards it renders are the board's own PlayingCard, so a snap is
  // measured from the same geometry rather than a second set of constants.
  assert.match(ghost, /<PlayingCard/);
});

test("the snap measures the live DOM, at whatever size the clamp produced", () => {
  // The ghost lands one fan step below the last card in a column, computed from
  // the measured rect — so the same code is correct at 34px and at 160px.
  assert.match(BOARD, /function landingPoint\(slot: HTMLElement\)/);
  assert.match(BOARD, /getBoundingClientRect\(\)/);
  assert.match(BOARD, /rect\.height - \(faceUp \? 0\.72 : 0\.86\) \* rect\.width/);
});
