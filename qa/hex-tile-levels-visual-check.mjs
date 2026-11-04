// qa/hex-tile-levels-visual-check.mjs
//
// Visual check for Hex Duel's upgrade levels. Mounts the REAL HexTile
// (qa/hex-tile-levels-visual-harness.jsx) with the project's real Tailwind
// stylesheet and checks, in a browser:
//
//   1. level 1 draws no fortification, levels 2/3/4 each draw one;
//   2. the three walls are a different shade each (violet → indigo → gold) and
//      get heavier as the level rises;
//   3. level 3/4 add merlons and towers, level 2 does not;
//   4. the badge still reads L2/L3/L4;
//   5. upgrading a tile plays a short build animation that finishes and clears;
//   6. `prefers-reduced-motion` collapses the build (walls still appear).
//
// Screenshots: qa/reports/hex-tile-levels/ — the full stage at desktop and
// phone widths, plus a close crop of each upgraded tile.
//
// Run: node qa/hex-tile-levels-visual-check.mjs

import esbuild from "esbuild";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import autoprefixer from "autoprefixer";
import { chromium } from "playwright";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = join(root, "qa/reports/hex-tile-levels");
mkdirSync(SHOTS, { recursive: true });
const outDir = mkdtempSync(join(tmpdir(), "grynd-hx-levels-"));

await esbuild.build({
  entryPoints: [join(root, "qa/hex-tile-levels-visual-harness.jsx")],
  bundle: true,
  format: "iife",
  platform: "browser",
  jsx: "automatic",
  outfile: join(outDir, "harness.js"),
  logLevel: "error",
  absWorkingDir: root,
  define: { "process.env.NODE_ENV": '"development"' },
});

const globals = readFileSync(join(root, "src/app/globals.css"), "utf8").replace(
  /@import url\([^)]*\);\s*/g,
  "",
);
const generated = await postcss([
  tailwindcss(join(root, "tailwind.config.js")),
  autoprefixer(),
]).process(globals, { from: join(root, "src/app/globals.css") });
writeFileSync(join(outDir, "app.css"), generated.css);
writeFileSync(
  join(outDir, "index.html"),
  `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="./app.css"></head>
<body><div id="root"></div><script src="./harness.js"></script></body></html>`,
);

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${extra ? " — " + extra : ""}`);
  ok ? pass++ : fail++;
};

const browser = await chromium
  .launch({ channel: "chrome" })
  .catch(() => chromium.launch());

const errors = [];
const mount = async (width, height, dpr) => {
  const page = await browser.newPage({
    viewport: { width, height },
    deviceScaleFactor: dpr,
    hasTouch: width < 640,
  });
  page.on("pageerror", (error) => errors.push(`pageerror(${width}): ${error.message}`));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    if (/Failed to load resource|fonts\.googleapis|net::ERR/.test(message.text())) return;
    errors.push(`console(${width}): ${message.text()}`);
  });
  await page.goto(pathToFileURL(join(outDir, "index.html")).href);
  await page.waitForFunction(() => !!window.__hxMount, null, { timeout: 20000 });
  await page.evaluate(() => window.__hxMount());
  await page.waitForSelector('[data-tile-key="p1-4"]', { timeout: 15000 });
  await page.waitForTimeout(300);
  return page;
};

const measure = (page) =>
  page.evaluate(() => {
    const read = (key) => {
      const tile = document.querySelector(`[data-tile-key="${key}"]`);
      if (!tile) return null;
      const wall = tile.querySelector("[data-hex-level-walls]");
      const line = wall?.firstElementChild ?? null;
      const style = line ? getComputedStyle(line) : null;
      return {
        key,
        wallLevel: wall?.getAttribute("data-hex-level-walls") ?? null,
        wallCount: wall ? 1 : 0,
        spanCount: wall ? wall.querySelectorAll("span").length : 0,
        borderColor: style?.borderTopColor ?? null,
        borderWidth: style?.borderTopWidth ?? null,
        badge: [...tile.querySelectorAll("span")]
          .map((node) => node.textContent.trim())
          .find((text) => /^L[1-4]$/.test(text)) ?? null,
        text: tile.textContent.replace(/\s+/g, " ").trim(),
        box: tile.getBoundingClientRect().toJSON(),
      };
    };
    return {
      p1: [1, 2, 3, 4].map((level) => read(`p1-${level}`)),
      p2: [2, 3, 4].map((level) => read(`p2-${level}`)),
      built: document.querySelectorAll("[data-hex-wall-built]").length,
      buildAnimations: [...document.querySelectorAll(".hex-wall-build")].map(
        (node) => getComputedStyle(node).animationName,
      ),
      stageWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
    };
  });

const px = (value) => (value == null ? "?" : `${Math.round(value * 10) / 10}px`);
const widthOf = (value) => Number.parseFloat(value ?? "0");

// ── Desktop: the level ladder ───────────────────────────────────────────────
const page = await mount(1280, 900, 1);
const m = await measure(page);

console.log(
  `\n▸ level ladder: ${m.p1.map((t) => `${t.wallLevel ?? "none"} ${t.borderColor ?? ""}/${t.borderWidth ?? ""}`).join(" | ")}`,
);

check("level 1 draws no fortification", m.p1[0].wallCount === 0 && m.p1[0].wallLevel === null);
check(
  "levels 2, 3 and 4 each draw their own wall",
  m.p1.slice(1).every((tile, index) => tile.wallLevel === String(index + 2)),
  m.p1.slice(1).map((tile) => `L${tile.wallLevel}`).join(", "),
);

const colors = m.p1.slice(1).map((tile) => tile.borderColor);
check(
  "each upgrade level has a different shade",
  new Set(colors).size === 3,
  colors.join(", "),
);
check(
  "the wall is violet at 2, indigo at 3 and gold at 4",
  colors[0] === "rgb(167, 139, 250)" &&
    colors[1] === "rgb(129, 140, 248)" &&
    colors[2] === "rgb(250, 204, 21)",
  colors.join(" → "),
);

const widths = m.p1.slice(1).map((tile) => widthOf(tile.borderWidth));
check(
  "the wall gets heavier with every upgrade",
  widths[0] < widths[1] && widths[1] < widths[2],
  widths.map(px).join(" → "),
);

check(
  "level 2 is a plain wall; levels 3 and 4 add merlons and towers",
  m.p1[1].spanCount < m.p1[2].spanCount && m.p1[2].spanCount === m.p1[3].spanCount,
  m.p1.slice(1).map((tile) => `${tile.spanCount} spans`).join(", "),
);

check(
  "the badge still names the level",
  m.p1.slice(1).every((tile, index) => tile.badge === `L${index + 2}`),
  m.p1.slice(1).map((tile) => tile.badge ?? "none").join(", "),
);

check(
  "the same levels draw for the second seat",
  m.p2.every((tile, index) => tile.wallLevel === String(index + 2)),
  m.p2.map((tile) => `L${tile.wallLevel}`).join(", "),
);

check(
  "the level ladder fits without sideways scroll",
  m.stageWidth <= m.viewportWidth + 1,
  `${m.stageWidth}/${m.viewportWidth}`,
);

check("no animation plays on a board that is merely loaded", m.built === 0 && m.buildAnimations.length === 0);

const funding = await page.evaluate(() => {
  const donor = document.querySelector("[data-hex-upgrade-donor]");
  const target = document.querySelector("[data-hex-upgrade-receives]");
  return {
    donor: donor?.getAttribute("data-hex-upgrade-donor") ?? null,
    donorText: donor?.textContent.replace(/\s+/g, "").trim() ?? null,
    receives: target?.getAttribute("data-hex-upgrade-receives") ?? null,
    targetText: target?.textContent.replace(/\s+/g, "").trim() ?? null,
  };
});
check(
  "a neighbour that will pay is labelled with what it gives up",
  funding.donor === "2" && funding.donorText === "−2",
  `${funding.donorText} (${funding.donor})`,
);
check(
  "the tile being upgraded shows what it borrows",
  funding.receives === "2" && funding.targetText === "+2",
  `${funding.targetText} (${funding.receives})`,
);

await page.screenshot({ path: join(SHOTS, "levels-1280.png") });
await page.screenshot({ path: join(SHOTS, "funding-split.png") });
for (const level of [2, 3, 4]) {
  await page
    .locator(`[data-tile-key="p1-${level}"]`)
    .screenshot({ path: join(SHOTS, `level-${level}-tile.png`) });
}

// ── The upgrade build ───────────────────────────────────────────────────────
await page.evaluate(() => window.__hx.setLevel(3));
await page.waitForSelector('[data-tile-key="live"] [data-hex-wall-built="3"]', {
  timeout: 1500,
});
const building = await page.evaluate(() => {
  const wall = document.querySelector('[data-tile-key="live"] [data-hex-level-walls]');
  return {
    animation: wall ? getComputedStyle(wall).animationName : null,
    duration: wall ? getComputedStyle(wall).animationDuration : null,
    flash: document.querySelectorAll('[data-tile-key="live"] .hex-wall-flash').length,
  };
});
check(
  "an upgrade plays a short build animation",
  building.animation?.includes("hexWallBuild"),
  `${building.animation} over ${building.duration}`,
);
check("the build fires one expanding ring", building.flash === 1, `${building.flash} ring(s)`);
await page.screenshot({ path: join(SHOTS, "upgrade-build.png") });

await page.waitForTimeout(900);
const settled = await page.evaluate(() => ({
  built: document.querySelectorAll("[data-hex-wall-built]").length,
  wall: document.querySelector('[data-tile-key="live"] [data-hex-level-walls]')?.getAttribute("data-hex-level-walls"),
}));
check(
  "the build ends and leaves the new wall in place",
  settled.built === 0 && settled.wall === "3",
  `${settled.built} building, wall L${settled.wall}`,
);
await page.close();

// ── Reduced motion ──────────────────────────────────────────────────────────
const calm = await mount(390, 844, 3);
await calm.emulateMedia({ reducedMotion: "reduce" });
await calm.evaluate(() => window.__hx.setLevel(2));
await calm.waitForTimeout(80);
await calm.evaluate(() => window.__hx.setLevel(4));
await calm.waitForSelector('[data-tile-key="live"] [data-hex-level-walls="4"]', { timeout: 1500 });
const reduced = await calm.evaluate(() => {
  const wall = document.querySelector('[data-tile-key="live"] [data-hex-level-walls]');
  return {
    duration: wall ? getComputedStyle(wall).animationDuration : null,
    level: wall?.getAttribute("data-hex-level-walls") ?? null,
  };
});
check(
  "prefers-reduced-motion collapses the build, walls still appear",
  reduced.level === "4" && widthOf(reduced.duration) <= 0.01,
  `L${reduced.level}, ${reduced.duration}`,
);
await calm.screenshot({ path: join(SHOTS, "levels-390.png") });
await calm.close();

check("no console / page errors", errors.length === 0, errors.slice(0, 3).join(" | "));

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
console.log(`screenshots: qa/reports/hex-tile-levels/`);
if (fail > 0) process.exitCode = 1;
