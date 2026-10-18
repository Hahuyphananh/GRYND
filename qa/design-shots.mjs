// qa/design-shots.mjs
//
// Renders the four screens prompt 7 touched and writes full-page screenshots
// for design review:
//
//   qa/reports/design-shots/solitaire-lobby-1280.png / -390.png
//   qa/reports/design-shots/solitaire-match-1280.png / -390.png
//   qa/reports/design-shots/keno-lobby-1280.png      / -390.png
//   qa/reports/design-shots/keno-match-1280.png      / -390.png
//
// The REAL pages are mounted through qa/design-shots-harness.tsx; only the
// environment is stubbed (Clerk, socket, router, fetch payloads, audio). The
// navigation bar, footer and shared lobby chrome are the shipped components,
// so the screenshots are the product's own layout at 1280×900 and 390×844.
//
// Run: node qa/design-shots.mjs

import esbuild from "esbuild";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import autoprefixer from "autoprefixer";
import { chromium } from "playwright";
import sharp from "sharp";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "grynd-design-shots-"));
// App-served output: public/ is the one place the running app reads static
// files, so the screenshots live in the product itself (/design-shots/…), not
// in a private QA folder.
const REPORTS = join(root, "public", "design-shots");
mkdirSync(REPORTS, { recursive: true });

const STUBS = {
  "next/navigation": `
    const record = (href) => { (window.__shots = window.__shots || {}).nav = ((window.__shots && window.__shots.nav) || []).concat([href]); };
    const router = { push: record, replace: record, back(){}, refresh(){}, prefetch(){} };
    export const useRouter = () => router;
    export const usePathname = () => "/casino/keno-pvp/5150";
    export const useParams = () => ({ matchId: "1" });
    export const useSearchParams = () => new URLSearchParams();
    export default { useRouter, usePathname, useParams, useSearchParams };
  `,
  "next/image": `
    import React from "react";
    export default function Img({ src, alt, width, height, className, style }) {
      const url = typeof src === "string" ? src : src?.src;
      return React.createElement("img", { src: url, alt: alt ?? "", width, height, className, style });
    }
  `,
  "next/link": `
    import React from "react";
    export default function Link({ href, children, ...rest }) {
      return React.createElement("a", { href: typeof href === "string" ? href : "#", ...rest }, children);
    }
  `,
  "posthog-js/react": `export const usePostHog = () => null; export default {};`,
  "@clerk/nextjs": `
    const user = { id: "user_1", username: "Tester", imageUrl: null, fullName: "Tester" };
    export const useUser = () => ({ isLoaded: true, isSignedIn: true, user });
    export const useAuth = () => ({ isLoaded: true, isSignedIn: true, userId: "user_1" });
    export const useClerk = () => ({ signOut() {} });
    export const SignOutButton = ({ children }) => children ?? null;
    export const ClerkProvider = ({ children }) => children ?? null;
    export default {};
  `,
  "context/SocketProvider": `
    export const useSocket = () => ({ socket: window.__shots.socket });
    export const SocketProvider = ({ children }) => children;
    export default { useSocket, SocketProvider };
  `,
  "components/lobby/MatchWaiting": `
    import React from "react";
    export default function MatchWaiting() { return React.createElement("div", { "data-testid": "waiting" }); }
  `,
  "components/result/PvpResultScreen": `
    import React from "react";
    export default function PvpResultScreen() { return React.createElement("div", { "data-testid": "pvp-result" }); }
  `,
  "lib/animations": `
    const staticMotion = { initial: false, animate: {}, exit: {}, transition: { duration: 0 } };
    export const withReducedMotion = (reduce, variant) => staticMotion;
    export const fireConfetti = () => Promise.resolve();
    export const celebrateWin = () => Promise.resolve();
    export const fadeIn = staticMotion;
    export const fadeUp = staticMotion;
    export const modalMotion = { backdrop: staticMotion, panel: staticMotion };
    export const stagger = {};
    export const hoverScale = {};
    export const scorePop = {};
    export const buttonPulse = () => ({});
    export default { fireConfetti, withReducedMotion };
  `,
  "lib/gameAudio": `
    const noop = () => {};
    export const playVictory = noop;
    export const playDefeat = noop;
    export const playTick = noop;
    export const playGoodReveal = noop;
    export const playBuzz = noop;
    export const playSelect = noop;
    export const playCrash = noop;
    export const playCardPlace = noop;
    export const playCardDraw = noop;
    export const playTurnSwitch = noop;
    export default { playVictory, playDefeat, playTick };
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
  entryPoints: [join(root, "qa/design-shots-harness.tsx")],
  bundle: true,
  format: "iife",
  platform: "browser",
  jsx: "automatic",
  outfile: join(outDir, "harness.js"),
  logLevel: "error",
  absWorkingDir: root,
  loader: { ".js": "jsx", ".png": "dataurl", ".svg": "dataurl", ".webp": "dataurl", ".jpg": "dataurl" },
  define: { "process.env.NODE_ENV": '"development"' },
  plugins: [
    {
      name: "shots-stubs",
      setup(build) {
        build.onResolve({ filter: /.*/ }, (args) => {
          const key = matchStubKey(args.path, args.resolveDir);
          if (!key) return null;
          return { path: key, namespace: "shots-stub" };
        });
        build.onLoad({ filter: /.*/, namespace: "shots-stub" }, (args) => ({
          contents: STUBS[args.path],
          loader: "jsx",
          resolveDir: root,
        }));
      },
    },
  ],
});

const compiled = await postcss([
  tailwindcss(join(root, "tailwind.config.js")),
  autoprefixer(),
]).process(readFileSync(join(root, "src/app/globals.css"), "utf8"), {
  from: join(root, "src/app/globals.css"),
});
const appCss = compiled.css.replace(/@import\s+url\(["']?https?:\/\/[^)]*\);?/g, "");
writeFileSync(join(outDir, "app.css"), appCss);

writeFileSync(
  join(outDir, "index.html"),
  `<!doctype html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GRYND design shots</title>
<link rel="stylesheet" href="./app.css"></head>
<body><div id="root"></div><script src="./harness.js"></script></body></html>`,
);

const fileUrl = pathToFileURL(join(outDir, "index.html")).href;
const browser = await chromium.launch();

const SCREENS = [
  {
    key: "solitaire-lobby",
    label: "Solitaire Duel lobby",
    ready: async (page) => {
      await page.waitForFunction(() => /Find a Match/.test(document.body.textContent || ""), null, {
        timeout: 20000,
      });
    },
  },
  {
    key: "solitaire-match",
    label: "Solitaire Duel game",
    ready: async (page) => {
      await page.waitForSelector('[data-testid="solitaire-board"] button[data-card]', { timeout: 20000 });
    },
  },
  {
    key: "keno-lobby",
    label: "Keno lobby",
    ready: async (page) => {
      await page.waitForFunction(
        () => /Keno Lobby/.test(document.body.textContent || "") && /Lobby #9001/.test(document.body.textContent || ""),
        null,
        { timeout: 20000 },
      );
    },
  },
  {
    key: "keno-match",
    label: "Keno PvP game",
    ready: async (page) => {
      await page.waitForFunction(
        () =>
          document.querySelectorAll('button[aria-label^="Tile "], button[aria-label^="Live tile "]')
            .length === 40,
        null,
        { timeout: 20000 },
      );
    },
  },
  {
    key: "mines-lobby",
    label: "Mines Duel lobby",
    ready: async (page) => {
      await page.waitForFunction(
        () =>
          /Mines Duel Lobby/.test(document.body.textContent || "") &&
          /Lobby #9101/.test(document.body.textContent || ""),
        null,
        { timeout: 20000 },
      );
    },
  },
  {
    key: "mines-match",
    label: "Mines Duel game",
    ready: async (page) => {
      await page.waitForSelector(".mines-board-frame", { timeout: 20000 });
      await page.waitForFunction(
        () => document.querySelectorAll('.mines-board-frame button[aria-label^="Tile "]').length === 100,
        null,
        { timeout: 20000 },
      );
    },
  },
  {
    key: "memory-lobby",
    label: "Memory Grid lobby",
    ready: async (page) => {
      await page.waitForFunction(
        () =>
          /Memory Grid Lobby/.test(document.body.textContent || "") &&
          /Lobby #9201/.test(document.body.textContent || ""),
        null,
        { timeout: 20000 },
      );
    },
  },
  {
    key: "memory-match",
    label: "Memory Grid game",
    ready: async (page) => {
      await page.waitForSelector(".memory-board-frame", { timeout: 20000 });
      await page.waitForFunction(
        () => document.querySelectorAll(".memory-board-frame button").length === 25,
        null,
        { timeout: 20000 },
      );
    },
  },
];

const VIEWPORTS = [
  { width: 1280, height: 900 },
  { width: 390, height: 844 },
];

for (const screen of SCREENS) {
  for (const viewport of VIEWPORTS) {
    const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e.message)));
    await page.goto(fileUrl);
    await page.waitForFunction(() => !!window.__shots?.mount, null, { timeout: 20000 });
    await page.evaluate((key) => window.__shots.mount(key), screen.key);
    await screen.ready(page);
    // Balance, avatars and the lobby's own list settle a beat after mount.
    await page.waitForTimeout(1200);
    const path = join(REPORTS, `${screen.key}-${viewport.width}.png`);
    await page.screenshot({ path, fullPage: true });
    console.log(
      `${screen.label} @ ${viewport.width}×${viewport.height} → ${path.replace(root + "\\", "").replace(root + "/", "")}`,
    );
    if (errors.length > 0) console.log(`   page errors: ${errors.slice(0, 2).join(" | ")}`);
    await context.close();
  }
}

await browser.close();

// ── Contact sheets (all four games, both viewports) ────────────────────────
const GAMES = [
  ["solitaire", "Solitaire Duel"],
  ["keno", "Keno PvP"],
  ["mines", "Mines Duel"],
  ["memory", "Memory Grid"],
];
const COLUMNS = [
  ["lobby", "Lobby"],
  ["match", "Game"],
];

async function contactSheet(width, scale, file) {
  const cells = [];
  for (const [key, label] of GAMES) {
    for (const [screen, screenLabel] of COLUMNS) {
      const src = join(REPORTS, `${key}-${screen}-${width}.png`);
      const meta = await sharp(src).metadata();
      const w = Math.round((meta.width ?? 0) * scale);
      const h = Math.round((meta.height ?? 0) * scale);
      const img = await sharp(src).resize({ width: w }).png().toBuffer();
      cells.push({ img, w, h, label: `${label} — ${screenLabel} — ${width}px` });
    }
  }
  const pad = 18;
  const labelH = 28;
  const colW = [0, 1].map((c) =>
    Math.max(cells[c].w, cells[c + 2].w, cells[c + 4].w, cells[c + 6].w),
  );
  const rowH = [0, 1, 2, 3].map((r) => Math.max(cells[r * 2].h, cells[r * 2 + 1].h));
  const W = pad * 3 + colW[0] + colW[1];
  const H = pad * 2 + rowH.reduce((sum, h) => sum + h + labelH + pad, 0);
  const composites = [];
  cells.forEach((cell, i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const x = pad + (col === 0 ? 0 : colW[0] + pad);
    const y = pad + rowH.slice(0, row).reduce((sum, h) => sum + h + labelH + pad, 0);
    composites.push({
      input: Buffer.from(
        `<svg width="${cell.w}" height="${labelH}"><text x="0" y="20" font-family="Segoe UI, Arial" font-size="17" font-weight="700" fill="#e8f6ff">${cell.label}</text></svg>`,
      ),
      left: x,
      top: y,
    });
    composites.push({ input: cell.img, left: x, top: y + labelH });
  });
  await sharp({ create: { width: W, height: H, channels: 4, background: "#050b16" } })
    .composite(composites)
    .png()
    .toFile(join(REPORTS, file));
  console.log(`contact sheet → ${file} (${W}×${H})`);
}

await contactSheet(1280, 0.45, "contact-desktop.png");
await contactSheet(390, 0.7, "contact-mobile.png");

console.log("\nScreenshots written to public/design-shots/ (served at /design-shots/)");
