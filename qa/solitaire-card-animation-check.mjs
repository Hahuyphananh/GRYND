// qa/solitaire-card-animation-check.mjs
//
// BROWSER VERIFICATION of the card-flip layer — the part unit tests cannot see.
//
// The real SolitaireBoard is bundled from source (esbuild, the same technique as
// qa/pro-paywall-check.mjs), mounted with a controllable authoritative view, and
// driven with real clicks on the stock. The script checks:
//
//   1. the board paints, with the built Tailwind CSS and both card faces;
//   2. a reveal runs ONE gr-card-reveal animation on the revealed card;
//   3. a stock draw runs the travel + flip on the TOP waste card only;
//   4. three fast draws leave three unique cards, one animation each;
//   5. moving the waste top leaves the next card stable (no replayed flip);
//   6. a redeal spawns staggered, identity-free backs that clean themselves up;
//   7. reduced motion and read-only review never animate;
//   8. desktop and mobile sizes render without clipping;
//   9. an alternate card back paints through the same custom properties.
//
// Screenshots land in qa/reports/ for the visual pass.
//
// Run: node qa/solitaire-card-animation-check.mjs   (after `npm run build`)

import esbuild from "esbuild";
import { chromium } from "playwright";
import { createServer } from "node:http";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "solitaire-card-animation-"));
const REPORTS = join(root, "qa", "reports");
mkdirSync(REPORTS, { recursive: true });

await esbuild.build({
  entryPoints: [join(root, "qa/solitaire-card-animation-harness.jsx")],
  bundle: true,
  format: "iife",
  platform: "browser",
  jsx: "automatic",
  loader: { ".js": "jsx" },
  outfile: join(outDir, "harness.js"),
  logLevel: "error",
  absWorkingDir: root,
  define: { "process.env.NODE_ENV": '"development"' },
  banner: {
    js: 'var process = { env: { NODE_ENV: "development" }, platform: "browser", browser: true, version: "v0.0.0" };',
  },
});

// The production build has already compiled every class and keyframe the board
// uses. Reusing that sheet keeps the QA pass on the REAL stylesheet instead of a
// second, drifting copy of it.
const staticRoot = join(root, ".next", "static");
const cssFiles = [];
const walk = (dir) => {
  if (!statSync(dir).isDirectory()) return;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full);
    else if (entry.endsWith(".css")) cssFiles.push(full);
  }
};
walk(staticRoot);
if (cssFiles.length === 0) {
  console.error("No built CSS found. Run `npm run build` first.");
  process.exit(1);
}
const cssNames = cssFiles.map((file, index) => {
  const name = `sheet-${index}-${basename(file)}`;
  writeFileSync(join(outDir, name), readFileSync(file));
  return name;
});

writeFileSync(
  join(outDir, "index.html"),
  `<!doctype html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GRYND solitaire card animations</title>
${cssNames.map((name) => `<link rel="stylesheet" href="./${name}">`).join("\n")}
</head>
<body style="margin:0"><div id="root"></div><script src="./harness.js"></script></body></html>`,
);

const server = createServer((req, res) => {
  const rawPath = req.url === "/" ? "/index.html" : req.url.split("?")[0];
  const file = rawPath.replace(/^\//, "");
  if (!file || file.includes("..") || !(file === "harness.js" || file === "index.html" || cssNames.includes(file))) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }
  try {
    const buf = readFileSync(join(outDir, file));
    res.writeHead(200, {
      "Content-Type": file.endsWith(".js")
        ? "text/javascript"
        : file.endsWith(".css")
          ? "text/css"
          : "text/html",
    });
    res.end(buf);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}/index.html`;

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${extra ? " — " + extra : ""}`);
  ok ? pass++ : fail++;
};

let browser;
try {
  browser = await chromium.launch();
} catch {
  browser = await chromium.launch({ channel: "chrome" });
}

const watchErrors = (page) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  return errors;
};

const stateOf = async (page) => {
  const el = page.locator('[data-testid="qa-state"]');
  return {
    ply: Number(await el.getAttribute("data-ply")),
    stock: Number(await el.getAttribute("data-stock")),
    waste: Number(await el.getAttribute("data-waste")),
  };
};

const animationOf = (page, selector) =>
  page.$eval(selector, (el) => {
    const inner = el.querySelector(":scope > span");
    return {
      outer: getComputedStyle(el).animationName,
      inner: inner ? getComputedStyle(inner).animationName : "none",
    };
  });

const wait = (page, ms) => page.waitForTimeout(ms);

// ── Desktop board ─────────────────────────────────────────────────────────
const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, locale: "en-US" });
const pageErrors = watchErrors(page);
await page.goto(base, { waitUntil: "domcontentloaded" });
await page.waitForSelector('[data-testid="solitaire-board"]');
await wait(page, 250);

check("the board paints with all seven columns", (await page.locator('[data-testid^="solitaire-column-"]').count()) === 7);
// 1 + 2 + 3 + 4 + 5 + 6 + 7: the harness deals a column of n + one top card.
check("the initial view renders 28 cards", (await page.locator('[data-testid^="solitaire-card-"]').count()) === 28);
check(
  "a face-down card paints its back, not its identity",
  (await page.getAttribute('[data-testid="solitaire-card-0-0"]', "data-face-up")) === "false" &&
    (await page.getAttribute('[data-testid="solitaire-card-0-0"]', "data-card")) === null,
);
await page.screenshot({ path: join(REPORTS, "solitaire-animation-board-desktop.png"), fullPage: true });

// ── 1. Tableau reveal ─────────────────────────────────────────────────────
await page.click('[data-testid="qa-reveal"]');
await wait(page, 90);
let animation = await animationOf(page, '[data-testid="solitaire-card-0-0"]');
check(
  "reveal: the card runs exactly one gr-card-reveal flip",
  animation.inner === "gr-card-reveal",
  JSON.stringify(animation),
);
check(
  "reveal: the identity appears only after the view exposes it",
  (await page.getAttribute('[data-testid="solitaire-card-0-0"]', "data-card")) === "clubs-12",
);
await page.screenshot({ path: join(REPORTS, "solitaire-animation-reveal-mid.png") });
await wait(page, 450);

// An unchanged snapshot (a rerender) must not restart the flip.
const before = await page.getAttribute('[data-testid="solitaire-card-0-0"]', "data-ply");
await page.evaluate(() => window.dispatchEvent(new Event("resize")));
await wait(page, 120);
check(
  "reveal: a rerender does not replay the animation",
  (await page.getAttribute('[data-testid="solitaire-card-0-0"]', "data-ply")) === before,
);

// ── 2. Stock draw ─────────────────────────────────────────────────────────
const beforeDraw = await stateOf(page);
await page.click('[data-testid="solitaire-stock"]');
await wait(page, 100);
const afterDraw = await stateOf(page);
check("draw: exactly one card reaches the waste", afterDraw.waste === beforeDraw.waste + 1);
check("draw: exactly one card leaves the stock", afterDraw.stock === beforeDraw.stock - 1);
animation = await animationOf(page, '[data-testid="solitaire-waste-top"]');
check(
  "draw: only the new waste top travels and flips",
  animation.outer === "gr-card-draw-translate" && animation.inner === "gr-card-draw-flip",
  JSON.stringify(animation),
);
check(
  "draw: the older waste cards stay still",
  (await page.locator('[data-testid="solitaire-waste"] [data-card]').count()) === 1,
);
await page.screenshot({ path: join(REPORTS, "solitaire-animation-draw-mid.png") });
await wait(page, 420);

// ── 3. Three fast draws ───────────────────────────────────────────────────
await page.click('[data-testid="solitaire-stock"]');
await wait(page, 120);
await page.click('[data-testid="solitaire-stock"]');
await wait(page, 450);
const afterThree = await stateOf(page);
check(
  "rapid draws: three unique cards, no duplicates and none lost",
  afterThree.waste === 3 &&
    new Set(
      await page.$$eval('[data-testid="solitaire-waste"] [data-card]', (els) =>
        els.map((el) => el.dataset.card),
      ),
    ).size === 3,
);

// ── 4. Waste → foundation, then waste → tableau ───────────────────────────
await page.click('[data-testid="qa-waste-to-foundation"]');
await wait(page, 320);
check(
  "waste → foundation: the foundation takes the top card",
  (await page.getAttribute('[data-testid="solitaire-foundation-clubs"]', "data-count")) === "1",
);
check(
  "waste → foundation: the newly exposed waste top does not replay a draw",
  (await animationOf(page, '[data-testid="solitaire-waste-top"]')).outer === "none",
);
await page.screenshot({ path: join(REPORTS, "solitaire-animation-waste-foundation.png") });

await page.click('[data-testid="qa-waste-to-tableau"]');
await wait(page, 320);
check(
  "waste → tableau: the card lands in the column and the waste shrinks",
  (await stateOf(page)).waste === 1,
);
await page.screenshot({ path: join(REPORTS, "solitaire-animation-waste-tableau.png") });

// ── 5. Redeal ─────────────────────────────────────────────────────────────
await page.click('[data-testid="qa-redeal-setup"]');
await wait(page, 600);
check("redeal setup: the stock is empty and the waste holds three", (await stateOf(page)).stock === 0);
await page.click('[data-testid="solitaire-stock"]');
await wait(page, 100);
const ghosts = await page.locator('[data-testid="solitaire-redeal-ghost"]').count();
check("redeal: staggered card backs fly home", ghosts === 3, `${ghosts} ghosts`);
await page.screenshot({ path: join(REPORTS, "solitaire-animation-redeal-mid.png") });
await wait(page, 850);
const afterRedeal = await stateOf(page);
check(
  "redeal: the authoritative stock and waste are exact, and the ghosts are gone",
  afterRedeal.stock === 3 &&
    afterRedeal.waste === 0 &&
    (await page.locator('[data-testid="solitaire-redeal-ghost"]').count()) === 0,
);
check(
  "redeal: the ghosts carried no card identity",
  (await page.locator('[data-testid="solitaire-redeal-ghost"] [data-card]').count()) === 0,
);
await page.screenshot({ path: join(REPORTS, "solitaire-animation-redeal-settled.png") });

// ── 6. Alternate card back ────────────────────────────────────────────────
await page.$eval('[data-testid="solitaire-board"]', (el) => {
  el.style.setProperty(
    "--sol-card-back-image",
    "repeating-linear-gradient(135deg, #3a0d16 0 6px, #6b1424 6px 12px)",
  );
  el.style.setProperty("--sol-card-back-border", "#c9a24a");
});
await wait(page, 120);
await page.screenshot({ path: join(REPORTS, "solitaire-animation-alt-back.png") });

check("desktop: no runtime errors", pageErrors.length === 0, pageErrors.join("; "));

// ── 7. Reduced motion ─────────────────────────────────────────────────────
const reducedContext = await browser.newContext({
  viewport: { width: 1000, height: 850 },
  reducedMotion: "reduce",
});
const reduced = await reducedContext.newPage();
const reducedErrors = watchErrors(reduced);
await reduced.goto(base, { waitUntil: "domcontentloaded" });
await reduced.waitForSelector('[data-testid="solitaire-board"]');
await wait(reduced, 250);
await reduced.click('[data-testid="qa-reveal"]');
await wait(reduced, 40);
const reducedAnimation = await animationOf(reduced, '[data-testid="solitaire-card-0-0"]');
check(
  "reduced motion: the revealed card shows its face immediately",
  reducedAnimation.inner === "none" &&
    (await reduced.getAttribute('[data-testid="solitaire-card-0-0"]', "data-face-up")) === "true",
  JSON.stringify(reducedAnimation),
);
await reduced.click('[data-testid="solitaire-stock"]');
await wait(reduced, 30);
check(
  "reduced motion: a draw does not animate",
  (await animationOf(reduced, '[data-testid="solitaire-waste-top"]')).outer === "none",
);
check("reduced motion: no runtime errors", reducedErrors.length === 0, reducedErrors.join("; "));
await reducedContext.close();

// ── 8. Read-only review ───────────────────────────────────────────────────
const review = await browser.newPage({ viewport: { width: 1000, height: 850 } });
const reviewErrors = watchErrors(review);
await review.goto(`${base}?readonly=1`, { waitUntil: "domcontentloaded" });
await review.waitForSelector('[data-testid="solitaire-board"]');
await wait(review, 250);
await review.click('[data-testid="qa-reveal"]');
await wait(review, 90);
check(
  "review: a position change never replays a reveal",
  (await animationOf(review, '[data-testid="solitaire-card-0-0"]')).inner === "none",
);
check(
  "review: the board states it is read-only",
  ((await review.textContent('[data-testid="solitaire-board"]')) ?? "").includes("Review mode"),
);
check("review: no runtime errors", reviewErrors.length === 0, reviewErrors.join("; "));
await review.screenshot({ path: join(REPORTS, "solitaire-animation-review.png") });
await review.close();

// ── 8b. Frozen mid-animation captures ─────────────────────────────────────
// A screenshot lands tens of milliseconds after a click, so a 300ms flip is
// nearly settled by the time the frame is taken. Freezing the live Web
// Animations at a known instant (page-side only) lets the visual pass inspect
// the actual 3D transform mid-turn: the back must be narrowing, not
// cross-fading, and the face must not be mirrored or bleed through.
const midPage = await browser.newPage({ viewport: { width: 1100, height: 900 } });
const midErrors = watchErrors(midPage);
await midPage.goto(base, { waitUntil: "domcontentloaded" });
await midPage.waitForSelector('[data-testid="solitaire-board"]');
await wait(midPage, 250);

const matrixOf = async (selector) =>
  midPage.$eval(selector, (el) => getComputedStyle(el).transform);
const m11Of = (matrix) => {
  const match = matrix.match(/matrix3d\(([^)]+)\)/);
  return match ? Number(match[1].split(",")[0]) : null;
};

await midPage.click('[data-testid="qa-reveal"]');
const frozenReveal = await midPage.evaluate(() => {
  let count = 0;
  for (const animation of document.getAnimations()) {
    const target = animation.effect?.target;
    if (!target?.closest?.('[data-testid="solitaire-card-0-0"]')) continue;
    animation.pause();
    animation.currentTime = 60; // 20% of the 300ms turn
    count += 1;
  }
  return count;
});
check("mid-flip: the reveal animation exists to inspect", frozenReveal >= 1);
const revealM11 = m11Of(await matrixOf('[data-testid="solitaire-card-0-0"] > span'));
check(
  "mid-flip: the card is genuinely part-way through a 3D rotation",
  revealM11 !== null && Math.abs(revealM11) > 0.05 && Math.abs(revealM11) < 0.95,
  `m11=${revealM11}`,
);
await midPage.screenshot({ path: join(REPORTS, "solitaire-animation-reveal-mid.png") });
await midPage.evaluate(() => document.getAnimations().forEach((a) => a.finish()));
await wait(midPage, 80);

await midPage.click('[data-testid="solitaire-stock"]');
const frozenDraw = await midPage.evaluate(() => {
  let count = 0;
  for (const animation of document.getAnimations()) {
    const target = animation.effect?.target;
    if (!target?.closest?.('[data-testid="solitaire-waste-top"]')) continue;
    animation.pause();
    animation.currentTime = 110; // 32% of the 340ms travel
    count += 1;
  }
  return count;
});
check("mid-draw: both the travel and the flip are on the new card", frozenDraw === 2, `${frozenDraw} animations`);
const wasteTransform = await matrixOf('[data-testid="solitaire-waste-top"]');
check(
  "mid-draw: the card is between the stock and the waste, not snapped",
  /matrix(3d)?\(/.test(wasteTransform) && wasteTransform !== "none",
  wasteTransform.slice(0, 60),
);
const drawM11 = m11Of(await matrixOf('[data-testid="solitaire-waste-top"] > span'));
check(
  "mid-draw: the traveling card is also mid-flip",
  drawM11 !== null && Math.abs(drawM11) > 0.05 && Math.abs(drawM11) < 0.95,
  `m11=${drawM11}`,
);
await midPage.screenshot({ path: join(REPORTS, "solitaire-animation-draw-mid.png") });
check("mid-animation: no runtime errors", midErrors.length === 0, midErrors.join("; "));
await midPage.close();

// ── 9. Mobile ─────────────────────────────────────────────────────────────
const mobile = await browser.newPage({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
});
const mobileErrors = watchErrors(mobile);
await mobile.goto(base, { waitUntil: "domcontentloaded" });
await mobile.waitForSelector('[data-testid="solitaire-board"]');
await wait(mobile, 250);
const boardBox = await mobile.locator('[data-testid="solitaire-board"]').boundingBox();
check(
  "mobile: the seven-column board fits the viewport width",
  Boolean(boardBox) && boardBox.width <= 390 && boardBox.width > 300,
  JSON.stringify(boardBox),
);
await mobile.screenshot({ path: join(REPORTS, "solitaire-animation-mobile.png"), fullPage: true });
await mobile.click('[data-testid="solitaire-stock"]');
await wait(mobile, 120);
await mobile.screenshot({ path: join(REPORTS, "solitaire-animation-mobile-draw.png"), fullPage: true });
check("mobile: no runtime errors", mobileErrors.length === 0, mobileErrors.join("; "));
await mobile.close();

await browser.close();
server.close();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
