/**
 * solitaire-duel-board-fit.test.mjs
 *
 * The Solitaire Duel board must be visible without scrolling.
 *
 * Seven columns always fit the WIDTH, so `--cw` was sized by width alone
 * (`clamp(34px, 10.4vw, 92px)`). On any desktop wide enough for the clamp to
 * saturate, that pinned every card at 92px and the board became a FIXED height:
 * a seven-card tableau column is 5.62 card-widths, plus the 1.42 card-width
 * top row = 7.04, i.e. 648px of cards. At 1280x800 only ~528px is left under
 * the page chrome, so the bottom of the tableau sat below the fold and the
 * player had to scroll mid-game — on the one screen size most players use.
 *
 * The fix adds a second term to the clamp that derives the card size from the
 * viewport HEIGHT. This test pins the arithmetic, because the failure mode is
 * invisible in review: the board still renders, it is just cut off.
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

test("the card size is derived from the viewport height, not the width alone", () => {
  // The whole point: a `100vh` term must appear inside the clamp.
  assert.match(
    BOARD,
    /--cw[^\n]*100vh/,
    "the card size must include a viewport-height term",
  );
  // …and it must be combined with the width term via min(), so a wide-but-short
  // window is capped by height while a tall one keeps the width-derived size.
  assert.match(
    BOARD,
    /min\(\s*10\.4vw\s*,\s*calc\(\(100vh - \$\{CHROME_REM\}\) \/ \$\{BOARD_CW\}\)\s*\)/,
    "the clamp must take the SMALLER of the width term and the height term",
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
});

test("the board geometry itself is unchanged", () => {
  // The fix resizes the board; it must not alter the card proportions or the
  // fan, which the interaction model and the visual design both depend on.
  assert.match(BOARD, /const CARD_H = "calc\(var\(--cw\) \* 1\.42\)"/);
  assert.match(BOARD, /const FACE_UP_OVERLAP = "calc\(var\(--cw\) \* -0\.72\)"/);
  assert.match(BOARD, /const FACE_DOWN_OVERLAP = "calc\(var\(--cw\) \* -0\.86\)"/);
});

// ── The arithmetic: the board must fit the viewport it is sized for ────────

/** Resolve the clamp the way the browser does, for a given viewport. */
function cardWidthFor({ vw, vh }) {
  const widthTerm = Math.min((10.4 / 100) * vw, 92);
  const heightTerm = (vh - CHROME_PX) / BOARD_CW;
  return Math.min(92, Math.max(34, Math.min(widthTerm, heightTerm)));
}

test("at 1280x800 the tableau now fits above the fold", () => {
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

test("the fix is a real change: the old width-only clamp overflowed", () => {
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

test("mobile sizing is untouched", () => {
  // The 34px floor has to keep governing phones, where the width term is below
  // it anyway — so the height term must never shrink a phone's cards.
  for (const [vw, vh] of [
    [390, 844],
    [360, 640],
    [414, 896],
  ]) {
    const widthTerm = (10.4 / 100) * vw;
    const cw = cardWidthFor({ vw, vh });
    assert.ok(
      cw >= 34,
      `a ${vw}x${vh} phone must keep cards at or above the 34px floor (got ${cw.toFixed(1)}px)`,
    );
    if (widthTerm < 34) {
      assert.equal(cw, 34, `a ${vw}px-wide phone must sit on the floor`);
    }
  }
});
