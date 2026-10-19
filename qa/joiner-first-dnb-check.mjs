// qa/joiner-first-dnb-check.mjs
//
// Live browser check for the joiner-first rule in Dots & Boxes.
//
// The join route writes a guest-first opening position (see
// tests/joiner-starts.test.mjs). This bundles the REAL match page
// (qa/joiner-first-dnb-harness.jsx) with `/game-state` mocked and proves:
//
//   1. guest + currentTurn "guest" → open edges are interactive (each carries
//      its tap-tooltip) and clicking one posts a draw-edge with the row/column
//      the board reported.
//   2. host + currentTurn "guest" → the same board has no interactive edges.
//
// Run: node qa/joiner-first-dnb-check.mjs

import esbuild from "esbuild";
import { chromium } from "playwright";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "joiner-first-dnb-"));

const STUBS = {
  "next/navigation": `
    export const useParams = () => ({ gameId: "7" });
    export const useRouter = () => ({ push() {}, replace() {}, back() {}, prefetch() {} });
    export default { useParams, useRouter };
  `,
  "context/SocketProvider": `
    export const useSocket = () => ({ socket: window.__dnb.socket });
    export const SocketProvider = ({ children }) => children;
    export default { useSocket, SocketProvider };
  `,
  "components/GameSessionHost": `export default function GameSessionHost({ children }) { return children; }`,
  "components/game/EmotePicker": `
    import React from "react";
    export const EmoteBubble = () => null;
    export default function EmotePicker() { return null; }
  `,
  "components/game/MatchLoading": `export default function MatchLoading() { return null; }`,
  "components/lobby/MatchWaiting": `export default function MatchWaiting() { return null; }`,
  "components/result/PvpResultScreen": `export default function PvpResultScreen() { return null; }`,
  "components/ReportModal": `export default function ReportModal() { return null; }`,
  "components/DotsAndBoxesLegend": `
    import React from "react";
    export const SeatMark = () => null;
    export default function DotsAndBoxesLegend() { return null; }
  `,
  "hooks/useGameEmotes": `
    export const useGameEmotes = () => ({ incomingEmote: null, myEmote: null, sendEmote: () => {} });
    export default () => ({ incomingEmote: null, myEmote: null, sendEmote: () => {} });
  `,
  "hooks/useGamePresence": `export const useGamePresence = () => {}; export default () => {};`,
  "hooks/useTranslation": `export const useTranslation = () => ({ t: (key) => key }); export default () => ({ t: (key) => key });`,
  "lib/dotsAndBoxesAudio": `
    export const playTimerUrgent = () => {};
    export const playTimerExpired = () => {};
  `,
  "lib/animations": `export const gameOverModal = {};`,
  "@tabler/icons-react": `
    export const IconAlertTriangle = () => null;
    export const IconRuler = () => null;
    export const IconFlag = () => null;
    export const IconDoorExit = () => null;
  `,
};

const stubKeys = Object.keys(STUBS);
const normalized = (value) => value.replace(/\\/g, "/");
const matchStubKey = (specifier, resolveDir) => {
  for (const key of stubKeys) {
    if (specifier === key || specifier.endsWith("/" + key)) return key;
  }
  if (!specifier.startsWith(".")) return null;
  const absolute = normalized(join(resolveDir, specifier));
  for (const key of stubKeys) {
    if (absolute.endsWith("/" + key)) return key;
  }
  return null;
};

await esbuild.build({
  entryPoints: [join(root, "qa/joiner-first-dnb-harness.jsx")],
  bundle: true,
  format: "iife",
  platform: "browser",
  jsx: "automatic",
  outfile: join(outDir, "harness.js"),
  logLevel: "error",
  absWorkingDir: root,
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [
    {
      name: "dnb-stubs",
      setup(build) {
        build.onResolve({ filter: /.*/ }, (args) => {
          const key = matchStubKey(args.path, args.resolveDir);
          if (!key) return null;
          return { path: key, namespace: "dnb-stub" };
        });
        build.onLoad({ filter: /.*/, namespace: "dnb-stub" }, (args) => ({
          contents: STUBS[args.path],
          loader: "jsx",
          resolveDir: root,
        }));
        // Next turns a static image import into `{ src, width, height }`.
        build.onLoad({ filter: /\.png$/i }, () => ({
          contents: `export default { src: "/images/smalllogo.png", width: 612, height: 408 };`,
          loader: "js",
        }));
      },
    },
  ],
});

// The board's mark assets are real public files, but the check never needs
// them to load; serve a minimal page with enough CSS for the SVG to be
// measurable and clickable.
writeFileSync(
  join(outDir, "index.html"),
  `<!doctype html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Dots & Boxes joiner-first check</title>
<style>
  body { margin: 0; background: #0b1220; color: #e2e8f0; }
  svg[data-testid="dnb-board"] { width: 640px; height: 640px; display: block; }
</style></head>
<body><div id="root"></div><script src="./harness.js"></script></body></html>`,
);

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${extra ? " — " + extra : ""}`);
  ok ? pass++ : fail++;
};

const interactiveEdges = (page) =>
  page.locator('svg[data-testid="dnb-board"] rect:has(title)').count();

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 1000 } });
const errors = [];
page.on("pageerror", (err) => errors.push(String(err)));

try {
  await page.goto(pathToFileURL(join(outDir, "index.html")).href, { waitUntil: "load" });
  await page.waitForSelector('svg[data-testid="dnb-board"]');

  // ── The guest opens the match ───────────────────────────────────────────
  await page.waitForFunction(
    () => document.querySelectorAll('svg[data-testid="dnb-board"] rect:has(title)').length > 0,
  );
  const guestEdges = await interactiveEdges(page);
  check(
    "guest opening turn: open edges are interactive",
    guestEdges > 0,
    `${guestEdges} tappable edges`,
  );

  const edge = page.locator('svg[data-testid="dnb-board"] rect:has(title)').first();
  // The visible line paints on top of its transparent hit rect, so a real
  // pointer click is intercepted. Dispatch the click the rect's handler owns.
  await edge.dispatchEvent("click");
  await page.waitForFunction(() =>
    window.__dnb.posts.some((p) => p.url.includes("/api/dots-and-boxes/draw-edge")),
  );
  const draw = await page.evaluate(
    () =>
      window.__dnb.posts.find((p) =>
        p.url.includes("/api/dots-and-boxes/draw-edge"),
      )?.body,
  );
  check(
    "guest opening turn: clicking an edge draws it",
    draw?.gameId === 7 &&
      (draw?.type === "h" || draw?.type === "v") &&
      Number.isInteger(draw?.row) &&
      Number.isInteger(draw?.col),
    JSON.stringify(draw ?? null),
  );

  // ── The host sees the same opening turn as the opponent's ──────────────
  await page.evaluate(() => window.mountMatch({ role: "host" }));
  await page.waitForSelector('svg[data-testid="dnb-board"]');
  await page.waitForTimeout(250);
  const hostEdges = await interactiveEdges(page);
  check(
    "host seat: the joiner's opening turn is not interactive",
    hostEdges === 0,
    `${hostEdges} tappable edges`,
  );

  check("no runtime errors", errors.length === 0, errors.join(" | "));
} finally {
  await browser.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
