/**
 * Mines Duel / Memory Grid — the desktop board fit.
 *
 * Both boards are SQUARES drawn full-width inside a centred column, so on a
 * desktop they were taller than the space left under the page's chrome and the
 * bottom rows needed a scroll. Each board now opts into a shared hook
 * (`.mines-board-frame` / `.memory-board-frame`) whose desktop rule caps its
 * WIDTH by the viewport height — a width cap on a square is a height cap.
 *
 * The geometry itself is verified in a real browser by
 * `qa/board-fit-check.mjs` (which prints the measured chrome above each board).
 * This test pins the parts that are cheap to regress and expensive to notice:
 *   1. both pages carry the hook, and the boards stay square;
 *   2. the cap lives in a `min-width: 1024px` query (mobile sizing untouched);
 *   3. each cap keeps a floor so a short window can't collapse the board;
 *   4. the creator frame is explicitly exempt (a recording frame is not the
 *      browser viewport, so a `vh` cap there would shrink a recorded clip);
 *   5. the budgets still cover the chrome they were measured against — and the
 *      Mines budget ALSO covers the legend that sits below its board;
 *   6. the Mines board is centred in its column, and its chrome is compacted
 *      into a single desktop row (what freed the height the board now uses).
 *
 * Run:  node --test tests/board-fit-desktop.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");

const mines = read("src/app/casino/mines-pvp/[matchId]/PageClient.tsx");
const memory = read("src/app/casino/memory-grid/[matchId]/PageClient.tsx");
const css = read("src/app/globals.css");
const pkg = JSON.parse(read("package.json"));

// The chrome ABOVE each board, measured in the browser by
// qa/board-fit-check.mjs at 1280×800 and 1440×900 (it reports both). A budget
// below the measured value leaves the board taller than the space under the
// chrome, which is the whole bug being fixed.
//
// Mines went 517px → 391px when its three control blocks (resign / pick-flag /
// emote) were compacted into one desktop row; the board grew 260px → 360px at
// 1280×800 with it. Memory Grid is unchanged.
const MEASURED_CHROME_PX = { mines: 391, memory: 462 };

// The Mines legend sits BELOW its board (Memory Grid has no legend). The
// budget must cover it as well as the chrome above: the old 34rem figure
// covered only the chrome above, so the legend always spilled past the fold
// and the page scrolled even when the board itself fitted.
const LEGEND_BELOW_BOARD_PX = 30;

// ════════════════════════════════════════════════════════════════════
// 1. Both boards opt in, and stay square
// ════════════════════════════════════════════════════════════════════

test("the Mines board opts into the shared desktop sizing hook", () => {
  assert.ok(
    mines.includes("mines-board-frame"),
    "the Mines board element must carry the mines-board-frame hook",
  );
  // The hook must sit on the board wrapper itself (the square that gets
  // capped), not on some ancestor — a cap on the 3xl column would not bind.
  assert.match(
    mines,
    /className="mines-board-frame[^"]*w-full/,
    "the hook must be on the full-width board wrapper",
  );
  // The square is still a square: a 5×5 grid of aspect-square cells.
  assert.ok(
    mines.includes("grid grid-cols-5"),
    "the Mines board keeps its 5-column grid",
  );
  assert.ok(
    mines.includes("aspect-square"),
    "the Mines cells keep their 1:1 aspect ratio",
  );
  assert.ok(
    !mines.includes("max-w-[90vh]"),
    "the Mines board must not keep a stray 90vh cap",
  );
});

test("BOTH Memory Grid board mounts opt into the hook", () => {
  // The grid is rendered twice — once as `mgBoardNode` (the creator phone
  // frame) and once inline in the normal view. Sizing only one of them would
  // leave the other scrolling on desktop.
  // Match the quoted class token only, so the prose in the surrounding
  // comments (which names the hook) doesn't inflate the count.
  const hits = memory.match(/"memory-board-frame/g) ?? [];
  assert.equal(
    hits.length,
    2,
    `both memory grid mounts must carry memory-board-frame (found ${hits.length})`,
  );
  assert.ok(
    memory.includes("aspect-square"),
    "the Memory cells keep their 1:1 aspect ratio",
  );
  assert.ok(
    memory.includes("max-w-lg"),
    "the Memory grid keeps its own column cap for the vertical (mobile) case",
  );
});

// ════════════════════════════════════════════════════════════════════
// 2. Desktop-only, with a floor
// ════════════════════════════════════════════════════════════════════

const desktopQuery = css.slice(css.indexOf("@media (min-width: 1024px) {"));

test("the caps live in the desktop media query, not globally", () => {
  // Mobile keeps the full-width board: the cap must not apply below 1024px.
  //
  // Comments are stripped first: the sizing block's own prose names the hooks,
  // and a mention inside a comment is not a rule that leaked out of the media
  // query. Without this the check fails on documentation, not on CSS.
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const withoutMedia = withoutComments.replace(
    /@media \(min-width: 1024px\) \{[\s\S]*?\n\}/g,
    "",
  );
  assert.ok(
    !withoutMedia.includes(".mines-board-frame") &&
      !withoutMedia.includes(".memory-board-frame"),
    "the board caps must only exist inside a min-width: 1024px query",
  );
});

test("each cap derives from the viewport height and keeps a floor", () => {
  assert.match(
    desktopQuery,
    /\.mines-board-frame \{\s*max-width: max\(260px, calc\(100vh - 27\.5rem\)\);\s*\}/,
    "the Mines cap must be viewport-height derived, with a 260px floor",
  );
  assert.match(
    desktopQuery,
    /\.memory-board-frame \{\s*max-width: max\(260px, calc\(100vh - 32rem\)\);\s*\}/,
    "the Memory cap must be viewport-height derived, with a 260px floor",
  );
});

test("the budgets still cover the chrome measured above each board", () => {
  // 1rem = 16px. A budget smaller than the measured chrome would let the board
  // spill past the fold again; this is the arithmetic behind the numbers.
  const budgetPx = (rem) => rem * 16;
  for (const [game, rem] of [
    ["mines", 27.5],
    ["memory", 32],
  ]) {
    assert.ok(
      budgetPx(rem) >= MEASURED_CHROME_PX[game],
      `${game}: ${rem}rem (${budgetPx(rem)}px) must cover the ${MEASURED_CHROME_PX[game]}px of chrome above the board`,
    );
  }
  // …and the Mines budget must clear the legend below the board too.
  assert.ok(
    budgetPx(27.5) >= MEASURED_CHROME_PX.mines + LEGEND_BELOW_BOARD_PX,
    `mines: 27.5rem (${budgetPx(27.5)}px) must cover both the ${MEASURED_CHROME_PX.mines}px of chrome ABOVE the board and the ${LEGEND_BELOW_BOARD_PX}px legend BELOW it`,
  );
  // The point of the change: the board is materially bigger than it was. Under
  // the old 34rem budget a 1280×800 desktop got 260px (the floor); the compact
  // chrome must keep it well clear of that.
  const boardAt800 = 800 - budgetPx(27.5);
  assert.ok(
    boardAt800 >= 340,
    `a 1280×800 desktop must get a board of at least 340px (27.5rem leaves ${boardAt800}px)`,
  );
  // And the floor must keep the tiles usable rather than collapsing the board.
  assert.ok(
    budgetPx(27.5) + 260 <= 900,
    "a 900px-tall desktop must show the whole Mines board above the fold",
  );
});

// ════════════════════════════════════════════════════════════════════
// 3. Centring + the compacted desktop chrome
// ════════════════════════════════════════════════════════════════════

test("the Mines board is centred in its column, not left-aligned", () => {
  // `w-full` + `max-width` is a left-aligned block, so before `mx-auto` the
  // capped board hugged the left edge of its centred column: a 260px board at
  // x=256 of a column spanning 256..1024, i.e. ~256px off-centre on screen.
  assert.match(
    mines,
    /className="mines-board-frame mx-auto[^"]*w-full/,
    "the Mines board frame must carry mx-auto so the capped square centres itself",
  );
});

test("the three control blocks are one row on desktop", () => {
  // Resign / pick-flag / emote used to be three stacked blocks costing ~138px
  // of the column above the board. That stack was the reason the board could
  // not be made bigger, so it is pinned here.
  assert.ok(
    mines.includes("lg:flex-row lg:items-center lg:justify-center lg:gap-4"),
    "the control row must lay its blocks out horizontally on desktop",
  );
  // Each block keeps its own `mt-3` for the mobile stack and drops it from `lg`
  // up, where the row owns the spacing — otherwise the margins stack inside the
  // row and the compaction is silently undone.
  const dropped = mines.match(/lg:mt-0/g) ?? [];
  assert.ok(
    dropped.length >= 3,
    `all three control blocks must drop their own top margin on desktop (found ${dropped.length})`,
  );
  // The row must not render when it has nothing to put in it (finished /
  // cancelled matches), or it leaves an empty 12px gap behind.
  assert.match(
    mines,
    /resignNode \|\| pickToggleNode \|\| emoteNode \? \(/,
    "the control row must collapse to null when all three blocks are absent",
  );
});

// ════════════════════════════════════════════════════════════════════
// 4. The creator frame is exempt
// ════════════════════════════════════════════════════════════════════

test("the creator frame releases both caps", () => {
  assert.match(
    desktopQuery,
    /\[data-creator-layout\] \.mines-board-frame,\s*\[data-creator-layout\] \.memory-board-frame \{\s*max-width: none;\s*\}/,
    "both caps must be released inside [data-creator-layout] (a recording frame is not the viewport)",
  );
  assert.ok(
    /\[data-creator-layout\] \.chess-board-frame \{\s*max-width: none;\s*\}/.test(css),
    "the pre-existing chess exemption must stay intact",
  );
});

// ════════════════════════════════════════════════════════════════════
// 5. The wiring exists
// ════════════════════════════════════════════════════════════════════

test("the browser check is wired up", () => {
  assert.ok(
    fs.existsSync("qa/board-fit-check.mjs"),
    "qa/board-fit-check.mjs must exist",
  );
  assert.ok(
    fs.existsSync("qa/board-fit-harness.jsx"),
    "qa/board-fit-harness.jsx must exist",
  );
  assert.equal(
    pkg.scripts?.["verify:board-fit"],
    "node qa/board-fit-check.mjs",
    "package.json must expose the browser check",
  );
});
