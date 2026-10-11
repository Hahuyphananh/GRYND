// qa/chess-click-to-move-browser-check.mjs
//
// Drives the vs-AI chess board in a real browser to prove the two ways a piece
// can move, on the page a player actually uses (/games/chess/ai is the public
// URL /casino/chess/ai permanently redirects to):
//
//   1. DRAGGING still works — a piece dropped on a square moves there;
//   2. CLICK, CLICK works — the first click picks one of our pieces up and
//      lights up its legal destinations, a click on one of those dots plays the
//      move, and a click anywhere else puts the piece back down;
//   3. the dots are actually PAINTED — a pixel at a destination's centre turns
//      cyan in a screenshot, so "the piece's moves show up" is verified visually
//      and not just as a style attribute;
//   4. the pick follows the position: after the move the dots are gone, and
//      clicking another of our pieces switches the pick;
//   5. no page error is logged along the way.
//
// The board is the same <Chessboard> component the staked PvP page renders, so
// this covers the shared click handler end to end; the PvP page's own server
// contract is pinned by tests/chess-click-to-move.test.mjs.
//
// A promotion can't be reached against a live opponent in a browser run, so the
// click-path promotion picker is covered by that test file instead.
//
// The server must already be running:
//   npx next dev -p 3000        (or: BASE=http://localhost:3210 node qa/…)
//
// Run:  node qa/chess-click-to-move-browser-check.mjs

import { chromium } from "playwright";
import sharp from "sharp";

const BASE = process.env.BASE || "http://localhost:3000";
const URL = `${BASE}/games/chess/ai?color=white&difficulty=1&timer=300`;
const SPLASH_SEEN_KEY = "grynd:splash:seen:v1";

let failures = 0;
let checks = 0;

function check(label, condition, detail = "") {
  checks += 1;
  if (condition) {
    console.log(`  ok   ${label}`);
    return true;
  }
  failures += 1;
  console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  return false;
}

const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
// The splash is a once-per-session brand moment that covers the whole viewport;
// mark it as seen up front (exactly what an in-app navigation does) so the run
// tests the BOARD rather than racing a timed overlay.
await context.addInitScript((key) => {
  try {
    window.sessionStorage.setItem(key, "1");
  } catch {
    // storage unavailable — the splash still clears itself on its own timer
  }
}, SPLASH_SEEN_KEY);
const page = await context.newPage();

const errors = [];
page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
page.on("console", (message) => {
  if (message.type() !== "error") return;
  const text = message.text();
  // An anonymous visitor is expected: the account-gated APIs answer 401 and
  // the browser logs each one. That says nothing about the board.
  if (/Failed to load resource.*\b401\b/.test(text)) return;
  errors.push(`console: ${text}`);
});

/**
 * What the board shows on one square: the piece(s) on it, whether it is drawn
 * as the picked-up square, and the dotted destination style, if any.
 *
 * react-chessboard puts `data-square` on the square element and the page's
 * customSquareStyles on a child of it, so the style is searched for across the
 * square's subtree rather than assumed one level deep.
 */
function squareState(square) {
  return page.$eval(`div[data-square="${square}"]`, (el) => {
    const nodes = [el, ...el.querySelectorAll("*")];
    const style = (node) => node.getAttribute("style") || "";
    const dot = nodes.find((node) => style(node).includes("radial-gradient"));
    // The pick highlight is the only cyan-tinted inline colour on the board.
    const picked = nodes.some((node) => /0,\s*229,\s*255/.test(style(node)));
    return {
      dot: dot ? style(dot) : null,
      picked,
      pieces: [...el.querySelectorAll("[data-piece]")].map((node) =>
        node.getAttribute("data-piece"),
      ),
    };
  });
}

/** Every square currently drawn with a destination dot. */
function dottedSquares() {
  return page.$$eval("div[data-square]", (elements) =>
    elements
      .filter((el) =>
        [el, ...el.querySelectorAll("*")].some((node) =>
          (node.getAttribute("style") || "").includes("radial-gradient"),
        ),
      )
      .map((el) => el.getAttribute("data-square"))
      .sort(),
  );
}

/**
 * The pixel at one viewport point of a fresh screenshot.
 *
 * `box` is a square's bounding box, so the point is taken in the square's own
 * coordinates (`x`/`y` are fractions of its width/height) — the centre by
 * default, which is where an empty destination square paints its dot.
 */
async function pixelAt(box, { x = 0.5, y = 0.5 } = {}) {
  const left = Math.round(box.x + box.width * x);
  const top = Math.round(box.y + box.height * y);
  const shot = await page.screenshot({ fullPage: true });
  const { data, info } = await sharp(shot)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const offset = (top * info.width + left) * info.channels;
  return {
    r: data[offset],
    g: data[offset + 1],
    b: data[offset + 2],
  };
}

/** Cyan-ish enough to be one of the board's pick highlights. */
const isCyan = (pixel) => pixel.g > 150 && pixel.b > 150 && pixel.r < 130;

const boxOf = (square) => page.locator(`div[data-square="${square}"]`).boundingBox();

try {
  await page.goto(URL, { waitUntil: "domcontentloaded" });
  // The board is lazy-loaded; the a2 pawn is the start position's proof it is up.
  await page.waitForSelector('div[data-square="e2"] [data-piece="wP"]', {
    timeout: 30000,
  });
  // Get the cookie bar out of the way — it sits over the bottom of the page.
  await page
    .getByRole("button", { name: "Decline" })
    .click({ timeout: 5000 })
    .catch(() => {});

  // ── 1. Nothing is highlighted before a pick ──
  check(
    "the board opens on the start position",
    (await squareState("e2")).pieces.includes("wP"),
  );
  check("no destination is dotted before a pick", (await dottedSquares()).length === 0);

  // ── 2. The first click picks a piece up ──
  await page.click('div[data-square="e2"]');
  await page.waitForTimeout(120);
  const picked = await squareState("e2");
  check("clicking e2 picks the pawn up", picked.picked, JSON.stringify(picked));
  check("the picked pawn stays on its square", picked.pieces.includes("wP"));
  check(
    "its legal destinations light up",
    (await dottedSquares()).join(",") === "e3,e4",
    (await dottedSquares()).join(","),
  );
  // …and the highlight is really on screen, not just an attribute: the picked
  // square's corner goes cyan, and the empty e4 square's centre gets the dot.
  const pickedCorner = await pixelAt(await boxOf("e2"), { x: 0.12, y: 0.12 });
  check(
    "the pick is painted on the selected square",
    isCyan(pickedCorner),
    JSON.stringify(pickedCorner),
  );
  const e4Pixel = await pixelAt(await boxOf("e4"));
  check(
    "a destination dot is painted on the empty e4 square",
    isCyan(e4Pixel),
    JSON.stringify(e4Pixel),
  );

  // ── 3. A click off the dots puts the piece back down ──
  await page.click('div[data-square="d5"]');
  await page.waitForTimeout(120);
  check(
    "a click off the dots deselects",
    (await dottedSquares()).length === 0 && !(await squareState("e2")).picked,
  );

  // ── 4. The second click plays the move ──
  await page.click('div[data-square="e2"]');
  await page.waitForTimeout(120);
  await page.click('div[data-square="e4"]');
  await page.waitForTimeout(600);
  const e4 = await squareState("e4");
  const e2 = await squareState("e2");
  check("click, click moves the pawn to e4", e4.pieces.includes("wP"), JSON.stringify(e4.pieces));
  check("the pawn left e2", e2.pieces.length === 0, JSON.stringify(e2.pieces));
  check("the dots are cleared after the move", (await dottedSquares()).length === 0);

  // ── 5. Dragging still works ──
  await page.waitForTimeout(1200); // let the AI answer, so it is our move
  await page.dragAndDrop('div[data-square="d2"]', 'div[data-square="d4"]');
  // Read the drop straight away: the board renders the new position as soon as
  // the drop is accepted, while the AI's reply only lands ~200ms later (Beginner
  // will happily recapture on d4, which would hide the proof if we waited).
  await page.waitForTimeout(60);
  const d4 = await squareState("d4");
  const d2 = await squareState("d2");
  check("drag still moves a piece (d2 → d4)", d4.pieces.includes("wP"), JSON.stringify(d4.pieces));
  check("the dragged pawn left d2", d2.pieces.length === 0, JSON.stringify(d2.pieces));

  // ── 6. Picking another of our pieces switches the pick ──
  await page.waitForTimeout(1200);
  await page.click('div[data-square="g1"]');
  await page.waitForTimeout(120);
  // The e2 pawn has pushed to e4 by now, so the knight has its third home
  // square back too.
  check(
    "a knight can be picked too",
    (await dottedSquares()).join(",") === "e2,f3,h3",
    (await dottedSquares()).join(","),
  );
  // f3/h3 are DARK squares, so a cyan dot there is unmistakable — this is the
  // strongest read of "the piece's possible moves show up".
  const f3Pixel = await pixelAt(await boxOf("f3"));
  check(
    "the knight's destination dot is painted on a dark square",
    isCyan(f3Pixel),
    JSON.stringify(f3Pixel),
  );
  await page.click('div[data-square="c2"]');
  await page.waitForTimeout(120);
  check(
    "clicking another of our pieces switches the pick",
    (await squareState("c2")).picked && !(await squareState("g1")).picked,
  );

  check("no page error was logged", errors.length === 0, errors.slice(0, 3).join(" | "));
} finally {
  await browser.close();
}

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
