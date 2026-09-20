// qa/fiar-trail-check.mjs
//
// Browser check for Four-In-A-Row's falling-disc motion trail (the technique
// transferred from Tower Arena). Mounts the REAL vs-AI page
// (qa/fiar-trail-harness.jsx) and measures the actual animation frame by frame
// in Chromium, asserting:
//
//   1. A drop renders the falling disc + exactly 3 trail ghosts behind it.
//   2. The ghosts are the same DISC visual as the disc (same colour class),
//      not a stand-in.
//   3. The disc falls and lands exactly in its cell.
//   4. The ghosts LAG the disc on the same path, in order (disc furthest
//      along, then trail 1, 2, 3).
//   5. The ghosts stay faded behind the opaque disc, newest → oldest.
//   6. The AI's reply uses the AI colour and the same trail.
//   7. Nothing is left behind once the moves finalize.
//   8. `prefers-reduced-motion` drops the trail entirely.
//   9. The measured fall holds at a very different board size (no hard-coded
//      pixel rows).
//  10. Interaction feedback: hovering a playable column marks EXACTLY ONE
//      column rail + ONE landing-cell preview, in the player's own disc
//      colour, faded; it moves with the pointer and clears on leave.
//
// Run: node qa/fiar-trail-check.mjs

import { chromium } from "playwright";
import { mountAiHarness } from "./fiar-ai-page.mjs";

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${extra ? " — " + extra : ""}`);
  ok ? pass++ : fail++;
};

const { base, close: closeHarness } = await mountAiHarness({
  title: "Four-In-A-Row trail check",
});

// Frame-by-frame sample of the falling disc + its ghosts. Each frame records
// the motion.div's translateY / opacity and the disc colour class inside it.
async function sample(page, durationMs) {
  return page.evaluate(async (ms) => {
    const parseTy = (t) => {
      if (!t || t === "none") return 0;
      const m2 = /^matrix\(([^)]+)\)$/.exec(t);
      if (m2) return parseFloat(m2[1].split(",")[5]) || 0;
      const m3 = /^matrix3d\(([^)]+)\)$/.exec(t);
      if (m3) return parseFloat(m3[1].split(",")[13]) || 0;
      return 0;
    };
    const read = (el) => {
      const cs = getComputedStyle(el);
      const child = el.firstElementChild;
      const color = child
        ? [...child.classList].find((c) => c.includes("disc-blue") || c.includes("disc-purple")) || null
        : null;
      return { ty: parseTy(cs.transform), opacity: parseFloat(cs.opacity), color };
    };
    const frames = [];
    const t0 = performance.now();
    await new Promise((resolve) => {
      const tick = () => {
        const disc = document.querySelector('[data-testid="fiar-drop-disc"]');
        const ghosts = [...document.querySelectorAll('[data-testid="fiar-trail-ghost"]')];
        const cell = document.querySelector('[data-cell="0-0"]');
        frames.push({
          ms: performance.now() - t0,
          disc: disc ? read(disc) : null,
          ghosts: ghosts.map(read),
          cellH: cell ? cell.offsetHeight : 0,
        });
        if (performance.now() - t0 < ms) requestAnimationFrame(tick);
        else resolve();
      };
      requestAnimationFrame(tick);
    });
    return frames;
  }, durationMs);
}

// Split a sampled run into one segment per drop, by the disc's colour.
function dropSegments(frames) {
  const segments = [];
  let current = null;
  for (const frame of frames) {
    if (!frame.disc) {
      current = null;
      continue;
    }
    if (!current || current.color !== frame.disc.color) {
      current = { color: frame.disc.color, frames: [] };
      segments.push(current);
    }
    current.frames.push(frame);
  }
  return segments;
}

const maxAbsTy = (frames) => frames.reduce((a, f) => Math.max(a, -f.disc.ty), 0);
const landedTy = (frames) => frames.reduce((a, f) => Math.min(a, Math.abs(f.disc.ty)), Infinity);
const cellHOf = (frames) => frames.find((f) => f.cellH > 0)?.cellH ?? 0;

const clickDrop = (page, column = 4) =>
  page.click(`button[title="Drop in column ${column}"]`);

// Use Playwright's bundled Chromium when it is installed, otherwise fall back
// to the system Chrome (the repo's other QA checks assume the bundled one).
async function launchBrowser() {
  try {
    return await chromium.launch();
  } catch {
    return await chromium.launch({ channel: "chrome" });
  }
}

try {
  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 900, height: 1000 } });
  page.on("pageerror", (err) => console.log("PAGE ERROR:", err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") console.log("CONSOLE ERROR:", msg.text());
  });
  await page.goto(base, { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.mountPage);

  // ── A human drop + the AI's reply ──────────────────────────────────────
  await page.evaluate(() => window.mountPage());
  await page.waitForSelector('button[title="Drop in column 4"]');
  await clickDrop(page, 4);
  const frames = await sample(page, 1900);

  const segments = dropSegments(frames);
  const human = segments.find((s) => s.color === "four-in-a-row-disc-blue");
  const ai = segments.find((s) => s.color === "four-in-a-row-disc-purple");

  check(
    "a drop renders the falling disc + exactly 3 trail ghosts",
    Boolean(human) && Math.max(...human.frames.map((f) => f.ghosts.length)) === 3,
    `segments=${segments.length} ghosts=${human ? Math.max(...human.frames.map((f) => f.ghosts.length)) : "n/a"}`,
  );

  const ghostColorsMatch = (seg) =>
    seg && seg.frames.some((f) => f.ghosts.length === 3 && f.ghosts.every((g) => g.color === seg.color));
  check(
    "the trail is the disc's own visual (same colour class), not a stand-in",
    ghostColorsMatch(human),
    human ? `disc=${human.color}` : "no human drop",
  );

  const humanCellH = cellHOf((human || { frames: [] }).frames);
  const spawned = human ? maxAbsTy(human.frames) : 0;
  const landed = human ? landedTy(human.frames) : Infinity;
  check(
    "the disc falls (spawns above the board) and lands exactly in its cell",
    human && spawned >= humanCellH * 0.75 && landed < 2,
    `spawn=${spawned.toFixed(1)}px cell=${humanCellH}px landed=${landed.toFixed(2)}px`,
  );

  // At the frame with the widest gap, the ghosts trail in order on the path.
  let widest = null;
  for (const f of human?.frames || []) {
    if (!f.disc || f.ghosts.length < 3) continue;
    const gap = f.disc.ty - f.ghosts[0].ty;
    if (!widest || gap > widest.gap) widest = { gap, f };
  }
  const order = widest
    ? [widest.f.disc.ty, ...widest.f.ghosts.map((g) => g.ty)]
    : [];
  check(
    "the ghosts trail the disc in order (disc furthest, then 1→2→3)",
    order.length === 4 && order[0] > order[1] && order[1] > order[2] && order[2] > order[3],
    widest ? `ty disc=${order[0].toFixed(1)} ghosts=${order.slice(1).map((t) => t.toFixed(1)).join(" → ")}` : "no mid-fall frame",
  );

  const mid = (human?.frames || []).find(
    (f) =>
      f.disc &&
      f.ghosts.length === 3 &&
      f.disc.ty <= -spawned * 0.2 &&
      f.disc.ty >= -spawned * 0.8,
  );
  const midOpacities = mid ? mid.ghosts.map((g) => g.opacity) : [];
  check(
    "the disc stays opaque with the ghosts faded behind it, newest → oldest",
    Boolean(mid) &&
      mid.disc.opacity >= 0.95 &&
      midOpacities.every((o) => o > 0.03 && o < midOpacities[0] + 0.001) &&
      midOpacities[0] > midOpacities[1] &&
      midOpacities[1] > midOpacities[2],
    `disc=${mid?.disc.opacity} ghosts=${JSON.stringify(midOpacities.map((o) => +o.toFixed(3)))}`,
  );

  check(
    "the AI's reply uses the AI colour and the same trail",
    Boolean(ai) && Math.max(...ai.frames.map((f) => f.ghosts.length)) === 3 && ghostColorsMatch(ai),
    ai ? `disc=${ai.color} ghosts=${Math.max(...ai.frames.map((f) => f.ghosts.length))}` : "no AI drop seen",
  );

  // ── Nothing left behind after the moves finalize ───────────────────────
  await page.waitForTimeout(700);
  const leftover = await page.evaluate(() => ({
    ghosts: document.querySelectorAll('[data-testid="fiar-trail-ghost"]').length,
    discs: document.querySelectorAll('[data-testid="fiar-drop-disc"]').length,
  }));
  check(
    "no ghost (or floating disc) is left behind once the moves finish",
    leftover.ghosts === 0 && leftover.discs === 0,
    JSON.stringify(leftover),
  );

  // ── Interaction feedback: hover marks one column + one landing cell ────
  // Park the pointer off the board first — otherwise it is still sitting on
  // the drop button from the previous click and the fresh board mounts
  // already-hovered.
  await page.mouse.move(4, 4);
  await page.evaluate(() => {
    document.documentElement.style.setProperty("--board-width", "560px");
    window.mountPage();
  });
  await page.waitForSelector('button[title="Drop in column 4"]');
  await page.mouse.move(4, 4);
  await page.waitForTimeout(60);

  const idle = await page.evaluate(() => ({
    hints: document.querySelectorAll('[data-testid="fiar-column-hint"]').length,
    previews: document.querySelectorAll('[data-testid="fiar-column-preview"]').length,
  }));
  check(
    "no column is marked before the player interacts",
    idle.hints === 0 && idle.previews === 0,
    JSON.stringify(idle),
  );

  await page.hover('[data-cell="5-3"]');
  await page.waitForSelector('[data-testid="fiar-column-preview"]');
  const hover = await page.evaluate(() => {
    const strip = document.querySelector('[data-testid="fiar-column-hint"]');
    const preview = document.querySelector('[data-testid="fiar-column-preview"]');
    const disc = preview?.querySelector(".four-in-a-row-disc");
    return {
      hints: document.querySelectorAll('[data-testid="fiar-column-hint"]').length,
      previews: document.querySelectorAll('[data-testid="fiar-column-preview"]').length,
      stripColumn: strip?.style.gridColumnStart,
      previewColumn: preview?.style.gridColumnStart,
      previewRow: preview?.style.gridRowStart,
      color: disc
        ? [...disc.classList].find((c) => c.includes("disc-blue") || c.includes("disc-purple"))
        : null,
      opacity: disc ? Number(getComputedStyle(disc).opacity) : null,
    };
  });
  check(
    "hovering a playable column marks exactly one column + one landing cell",
    hover.hints === 1 &&
      hover.previews === 1 &&
      hover.stripColumn === "4" &&
      hover.previewColumn === "4" &&
      hover.previewRow === "6",
    JSON.stringify(hover),
  );
  check(
    "the landing preview is the player's own disc, faded (not a new visual)",
    hover.color === "four-in-a-row-disc-blue" &&
      hover.opacity !== null &&
      hover.opacity > 0 &&
      hover.opacity < 1,
    `color=${hover.color} opacity=${hover.opacity}`,
  );

  await page.hover('[data-cell="5-0"]');
  await page.waitForTimeout(60);
  const moved = await page.evaluate(() => ({
    hints: document.querySelectorAll('[data-testid="fiar-column-hint"]').length,
    stripColumn: document.querySelector('[data-testid="fiar-column-hint"]')?.style.gridColumnStart,
    previewColumn: document.querySelector('[data-testid="fiar-column-preview"]')?.style.gridColumnStart,
  }));
  check(
    "only one column is ever marked, and it follows the pointer",
    moved.hints === 1 && moved.stripColumn === "1" && moved.previewColumn === "1",
    JSON.stringify(moved),
  );

  await page.mouse.move(4, 4);
  await page.waitForTimeout(60);
  const unhovered = await page.evaluate(() => ({
    hints: document.querySelectorAll('[data-testid="fiar-column-hint"]').length,
    previews: document.querySelectorAll('[data-testid="fiar-column-preview"]').length,
  }));
  check(
    "leaving the board clears the hover feedback",
    unhovered.hints === 0 && unhovered.previews === 0,
    JSON.stringify(unhovered),
  );

  // ── Resolution independence: the same measured fall at a tiny size ─────
  await page.evaluate(() => {
    document.documentElement.style.setProperty("--board-width", "300px");
    window.mountPage();
  });
  await page.waitForSelector('button[title="Drop in column 4"]');
  await clickDrop(page, 4);
  const smallFrames = await sample(page, 900);
  const small = dropSegments(smallFrames).find((s) => s.color === "four-in-a-row-disc-blue");
  const smallCellH = cellHOf((small || { frames: [] }).frames);
  check(
    "the trail and exact landing hold at a very different board size",
    Boolean(small) &&
      smallCellH > 0 &&
      smallCellH < humanCellH &&
      Math.max(...small.frames.map((f) => f.ghosts.length)) === 3 &&
      maxAbsTy(small.frames) >= smallCellH * 0.75 &&
      landedTy(small.frames) < 2,
    small
      ? `cell ${smallCellH}px vs ${humanCellH}px, spawn=${maxAbsTy(small.frames).toFixed(1)}px, landed=${landedTy(small.frames).toFixed(2)}px`
      : "no drop measured",
  );

  await page.close();

  // ── Reduced motion: the trail is dropped, the disc still appears ───────
  // A page with the preference set BEFORE load (how a reduced-motion visitor
  // arrives at the game — framer-motion reads it once per mount).
  const rmPage = await browser.newPage({
    viewport: { width: 900, height: 1000 },
    reducedMotion: "reduce",
  });
  await rmPage.goto(base, { waitUntil: "networkidle" });
  await rmPage.waitForFunction(() => window.mountPage);
  await rmPage.evaluate(() => window.mountPage());
  await rmPage.waitForSelector('button[title="Drop in column 4"]');
  await clickDrop(rmPage, 4);
  const rmFrames = await sample(rmPage, 900);
  const rmGhosts = Math.max(0, ...rmFrames.map((f) => f.ghosts.length));
  const rmDiscs = await rmPage.evaluate(
    () => document.querySelectorAll('[data-testid="fiar-drop-disc"]').length,
  );
  check(
    "prefers-reduced-motion: no trail and no fall overlay",
    rmGhosts === 0 && rmDiscs === 0,
    `ghosts=${rmGhosts} overlay discs=${rmDiscs}`,
  );
  const rmLanded = await rmPage.evaluate(() => {
    const cell = document.querySelector('[data-cell="5-3"]');
    return cell
      ? [...cell.classList].some((c) => c.includes("four-in-a-row-disc-blue"))
      : false;
  });
  check(
    "prefers-reduced-motion: the disc is still placed in the correct cell",
    rmLanded === true,
    `cell 5-3 blue=${rmLanded}`,
  );
  await rmPage.close();

  await browser.close();
} finally {
  closeHarness();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
