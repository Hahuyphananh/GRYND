#!/usr/bin/env node
// qa/chess-ai-responsive-check.mjs
//
// Layout audit for the standalone chess build: boots the BUILT package once and
// re-measures the real DOM at phone, landscape, tablet and desktop viewports.
//
//   node qa/chess-ai-responsive-check.mjs
//   node qa/chess-ai-responsive-check.mjs --dir=dist/packages/.verify-chess-ai
//
// It fails on the things that actually break a mobile game:
//   * horizontal overflow (a page that scrolls sideways)
//   * a board wider than the viewport, or off its left edge
//   * squares too small to tap accurately
//   * touch targets under 40x40 CSS px on touch viewports
//   * seat bars / board / panel overlapping or escaping the viewport
//   * a result card taller than the screen it opens on

import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { sleep, withBrowserPage } from "../standalone/chess-ai/scripts/lib/browser.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const found = argv.find((entry) => entry.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
};

const DIR = resolve(ROOT, option("dir", "dist/portal/chess-ai"));
assert.ok(existsSync(join(DIR, "index.html")), `no built game at ${DIR}`);

/** Minimum comfortable touch target, in CSS px (WCAG 2.5.8 asks for 24; 40 is the platform norm). */
const MIN_TARGET = 40;
/** A square smaller than this is a mis-tap waiting to happen. */
const MIN_SQUARE = 34;

const VIEWPORTS = [
  { name: "small phone 320x568", width: 320, height: 568, mobile: true, dpr: 2 },
  { name: "phone 360x640", width: 360, height: 640, mobile: true, dpr: 3 },
  { name: "phone 390x844", width: 390, height: 844, mobile: true, dpr: 3 },
  { name: "large phone 414x896", width: 414, height: 896, mobile: true, dpr: 3 },
  { name: "phone landscape 844x390", width: 844, height: 390, mobile: true, dpr: 3 },
  { name: "tablet 768x1024", width: 768, height: 1024, mobile: true, dpr: 2 },
  { name: "desktop 1440x900", width: 1440, height: 900, mobile: false, dpr: 1 },
];

const MEASURE = `(() => {
  const rect = (el) => {
    const b = el.getBoundingClientRect();
    return {
      x: +b.x.toFixed(1), y: +b.y.toFixed(1),
      w: +b.width.toFixed(1), h: +b.height.toFixed(1),
      right: +b.right.toFixed(1), bottom: +b.bottom.toFixed(1)
    };
  };
  const q = (selector) => {
    const el = document.querySelector(selector);
    return el ? rect(el) : null;
  };
  const squares = [...document.querySelectorAll("[data-square]")].map(rect);
  const targets = [...document.querySelectorAll("button, a[href]")]
    .filter((el) => {
      const b = el.getBoundingClientRect();
      return b.width > 0 && b.height > 0;
    })
    .map((el) => ({
      kind: el.tagName === "BUTTON" ? "button" : "link",
      label: (el.getAttribute("data-action") || el.textContent || el.getAttribute("href") || "").trim().slice(0, 28),
      ...rect(el)
    }));
  return {
    vw: window.innerWidth,
    vh: window.innerHeight,
    scrollW: document.documentElement.scrollWidth,
    scrollH: document.documentElement.scrollHeight,
    board: q('[data-testid="board"]'),
    topbar: q(".topbar"),
    panel: q(".panel"),
    seatTop: q(".seat.ai"),
    seatBottom: q(".seat.human"),
    status: q(".status"),
    actions: q(".actions"),
    moves: q(".moves"),
    squares: {
      count: squares.length,
      smallest: squares.length ? Math.min(...squares.map((s) => Math.min(s.w, s.h))) : 0,
      left: squares.length ? Math.min(...squares.map((s) => s.x)) : 0,
      right: squares.length ? Math.max(...squares.map((s) => s.right)) : 0
    },
    targets
  };
})()`;

/**
 * Only buttons are held to the touch-target floor. The footer's Licence/Source
 * links are inline text, which WCAG 2.5.8 exempts; padding them to 40px tall
 * would push the footnote apart for no real gain.
 */
const smallTargets = (box) => box.targets.filter((target) => target.kind === "button");

const problems = [];
const report = { dir: DIR, viewports: [], problems };

const fail = (message) => {
  problems.push(message);
  console.log(`  FAIL  ${message}`);
};

await withBrowserPage(DIR, async ({ base, page }) => {
  await page.send("Network.setBlockedURLs", { urls: ["https://*", "wss://*"] });
  await page.send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 3,
    mobile: true,
  });
  await page.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });

  await page.navigate(`${base}/index.html`);
  await page.until("the board", "document.querySelector('[data-testid=\"board\"]') !== null", 20_000);
  await page.until(
    "the engine to boot",
    "window.__CHESS_STATE__ && window.__CHESS_STATE__.engineReady === true",
    40_000
  );
  console.log("engine booted; measuring viewports\n");

  for (const viewport of VIEWPORTS) {
    await page.send("Emulation.setDeviceMetricsOverride", {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: viewport.dpr,
      mobile: viewport.mobile,
    });
    await page.send(
      "Emulation.setTouchEmulationEnabled",
      viewport.mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false }
    );
    await sleep(400);

    const box = await page.evaluate(MEASURE);
    report.viewports.push({ viewport: viewport.name, ...box });
    console.log(`${viewport.name}  board ${box.board?.w}x${box.board?.h}  squares ${box.squares.smallest}px  scrollW ${box.scrollW}/${box.vw}`);

    if (!box.board) {
      fail(`${viewport.name}: no board rendered`);
      continue;
    }
    if (box.scrollW > box.vw + 1) {
      fail(`${viewport.name}: horizontal overflow (scrollWidth ${box.scrollW} > viewport ${box.vw})`);
    }
    if (box.board.x < -0.5 || box.board.right > box.vw + 0.5) {
      fail(`${viewport.name}: board escapes the viewport (${box.board.x}..${box.board.right} of ${box.vw})`);
    }
    if (box.board.w < 240) {
      fail(`${viewport.name}: board is only ${box.board.w}px wide`);
    }
    if (box.squares.count !== 64) {
      fail(`${viewport.name}: expected 64 squares, found ${box.squares.count}`);
    }
    if (box.squares.smallest < MIN_SQUARE) {
      fail(`${viewport.name}: squares are ${box.squares.smallest}px (min ${MIN_SQUARE})`);
    }
    if (box.seatTop && box.seatTop.bottom > box.board.y + 1) {
      fail(`${viewport.name}: the top seat bar overlaps the board`);
    }
    if (box.seatBottom && box.board.bottom > box.seatBottom.y + 1) {
      fail(`${viewport.name}: the bottom seat bar overlaps the board`);
    }
    if (box.topbar && (box.topbar.x < -0.5 || box.topbar.right > box.vw + 0.5)) {
      fail(`${viewport.name}: header escapes the viewport`);
    }

    if (viewport.mobile) {
      const small = smallTargets(box).filter((t) => t.w < MIN_TARGET || t.h < MIN_TARGET);
      for (const target of small) {
        fail(
          `${viewport.name}: touch target "${target.label}" is ${target.w}x${target.h} (min ${MIN_TARGET})`
        );
      }
    }
  }

  // ── the result screen on the smallest phone ─────────────────────────────
  await page.send("Emulation.setDeviceMetricsOverride", {
    width: 320,
    height: 568,
    deviceScaleFactor: 2,
    mobile: true,
  });
  await sleep(300);
  await page.evaluate(`(() => {
    const button = document.querySelector('[data-action="resign"]');
    if (button) button.click();
    return true;
  })()`);
  await page.until(
    "the result overlay",
    "document.querySelector('[data-testid=\"result\"]') !== null",
    5_000
  );
  await sleep(250);

  const result = await page.evaluate(`(() => {
    const rect = (el) => {
      const b = el.getBoundingClientRect();
      return { x: +b.x.toFixed(1), y: +b.y.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1), bottom: +b.bottom.toFixed(1), right: +b.right.toFixed(1) };
    };
    const card = document.querySelector('[data-testid="result"] .card');
    const buttons = [...document.querySelectorAll('[data-testid="result"] button')].map((el) => ({
      kind: "button",
      label: (el.getAttribute("data-action") || el.textContent || "").trim().slice(0, 24),
      ...rect(el)
    }));
    return { vw: window.innerWidth, vh: window.innerHeight, card: card ? rect(card) : null, buttons };
  })()`);
  report.resultOverlay = result;

  if (!result.card) {
    fail("small phone: the result card did not render");
  } else {
    if (result.card.h > result.vh) {
      fail(`small phone: the result card is ${result.card.h}px tall on a ${result.vh}px screen`);
    }
    if (result.card.y < -0.5 || result.card.bottom > result.vh + 0.5) {
      fail("small phone: the result card is clipped by the viewport");
    }
    if (result.card.x < -0.5 || result.card.right > result.vw + 0.5) {
      fail("small phone: the result card is wider than the screen");
    }
  }
  for (const button of result.buttons.filter((entry) => entry.kind === "button")) {
    if (button.h < MIN_TARGET) {
      fail(`small phone: result button "${button.label}" is ${button.h}px tall (min ${MIN_TARGET})`);
    }
  }
});

mkdirSync(join(ROOT, "dist/qa"), { recursive: true });
writeFileSync(
  join(ROOT, "dist/qa/chess-ai-responsive.json"),
  JSON.stringify({ ...report, problems }, null, 2)
);

console.log("\nChess AI — responsive layout audit");
console.log("-".repeat(70));
if (problems.length === 0) {
  console.log(`PASS  ${VIEWPORTS.length} viewports fit, no overflow, tappable targets`);
} else {
  console.log(`FAILED — ${problems.length} problem(s)`);
}
console.log("report        dist/qa/chess-ai-responsive.json\n");

process.exit(problems.length === 0 ? 0 : 1);
