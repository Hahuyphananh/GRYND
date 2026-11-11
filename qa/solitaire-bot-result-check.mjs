// qa/solitaire-bot-result-check.mjs
//
// REAL-BROWSER VISUAL CHECK for the vs-bots result popup.
//
// Builds `qa/solitaire-bot-result-harness.tsx` (the shipped PvpResultScreen with
// the exact props the match page passes for a bot) into a static page, mounts a
// WIN and a LOSS at desktop and mobile widths, screenshots both, and asserts
// the layout the change is about:
//
//   * the bot's portrait is VISIBLE (loaded, non-zero box, correct artwork);
//   * its name and rating label sit BESIDE that portrait, not above the panel;
//   * the bot's ending dialog is present, non-empty and inside the panel;
//   * the result never renders Glitch on a practice result;
//   * neither outcome overflows horizontally, at 900px or 390px.
//
// Screenshots: qa/reports/solitaire-bot-result/{win,loss}-{width}.png
//
// Run: node qa/solitaire-bot-result-check.mjs

import esbuild from "esbuild";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { chromium } from "playwright";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "grynd-bot-result-"));
const REPORTS = join(root, "qa", "reports", "solitaire-bot-result");
mkdirSync(REPORTS, { recursive: true });

// ── Only the environment is stubbed; the result screen and speech are real ──
const STUBS = {
  "next/navigation": `
    const router = { push(){}, replace(){}, back(){}, refresh(){}, prefetch(){} };
    export const useRouter = () => router;
    export const usePathname = () => "/casino/solitaire-duel/practice-preview-1";
    export const useParams = () => ({ matchId: "practice-preview-1" });
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
    export default function Link({ href, children, prefetch, ...rest }) {
      return React.createElement("a", { href: typeof href === "string" ? href : "#", ...rest }, children);
    }
  `,
  "lib/animations": `
    export const withReducedMotion = () => ({ initial: false, animate: {}, exit: {}, transition: { duration: 0 } });
    export const fireConfetti = () => Promise.resolve();
    export default { fireConfetti, withReducedMotion };
  `,
  "lib/practiceWinClient": `export const notifyDailyRewardWin = () => {};`,
  "ads/PostMatchAdSlot": `
    import React from "react";
    export default function PostMatchAdSlot() { return null; }
  `,
  "guest/GuestPostMatchCta": `
    import React from "react";
    export default function GuestPostMatchCta() { return null; }
  `,
  "mascot/GlitchSay": `
    import React from "react";
    export default function GlitchSay(props) {
      return React.createElement("div", { "data-testid": "glitch-say", "data-glitch-event": props.eventId ?? null }, props.message ?? "");
    }
  `,
  "lib/portal/crazygames": `export const PORTAL_MATCH_FINISHED_EVENT = "portal:match-finished";`,
  "lib/portal/framing": `export const isPortalPlayPath = () => false;`,
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
  entryPoints: [join(root, "qa/solitaire-bot-result-harness.tsx")],
  bundle: true,
  format: "iife",
  platform: "browser",
  jsx: "automatic",
  outfile: join(outDir, "harness.js"),
  logLevel: "error",
  absWorkingDir: root,
  loader: {
    ".js": "jsx",
    ".png": "dataurl",
    ".svg": "dataurl",
    ".webp": "dataurl",
    ".jpg": "dataurl",
  },
  define: { "process.env.NODE_ENV": '"development"' },
  plugins: [
    {
      name: "bot-result-stubs",
      setup(build) {
        build.onResolve({ filter: /.*/ }, (args) => {
          const key = matchStubKey(args.path, args.resolveDir);
          if (!key) return null;
          return { path: key, namespace: "bot-result-stub" };
        });
        build.onLoad({ filter: /.*/, namespace: "bot-result-stub" }, (args) => ({
          contents: STUBS[args.path],
          loader: "jsx",
          resolveDir: root,
        }));
      },
    },
  ],
});

const css = await postcss([tailwind()]).process(
  readFileSync(join(root, "src/app/globals.css"), "utf8"),
  { from: join(root, "src/app/globals.css") },
);
writeFileSync(
  join(outDir, "app.css"),
  css.css.replace(/@import\s+url\(["']?https?:\/\/[^)]*\);?/g, ""),
);
writeFileSync(
  join(outDir, "index.html"),
  `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Solitaire bot result</title>
<link rel="stylesheet" href="./app.css"></head>
<body style="margin:0;background:#05070d"><div id="root"></div>
<script src="./harness.js"></script></body></html>`,
);

// The bot portraits and fonts are PUBLIC assets served from `/images/...` at
// runtime, which a file:// page cannot resolve. Serve the built page and the
// real public assets from a throwaway local origin so the artwork loads exactly
// as it does in the app (a broken image here would be a harness artefact, not a
// product layout bug).
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const server = createServer(async (req, res) => {
  const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  for (const candidate of [join(outDir, relative), join(root, "public", relative)]) {
    try {
      const body = await readFile(candidate);
      res.writeHead(200, { "content-type": MIME[extname(candidate)] ?? "application/octet-stream" });
      res.end(body);
      return;
    } catch {
      // try the next root
    }
  }
  res.writeHead(404);
  res.end("not found");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();
const fileUrl = `http://127.0.0.1:${port}/index.html`;

let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

let browser;
try {
  browser = await chromium.launch();
} catch {
  browser = await chromium.launch({ channel: "chrome" });
}

const readLayout = (page) =>
  page.evaluate(() => {
    const portrait = document.querySelector('[data-testid="result-opponent-image"]');
    const panel = document.querySelector('[role="dialog"] > div > div');
    const dialog = document.querySelector('[data-testid="solitaire-bot-result-speech-text"]');
    const name = [...document.querySelectorAll("p")].find((node) =>
      /^(Rookie)$/.test((node.textContent || "").trim()),
    );
    const rating = [...document.querySelectorAll("p")].find((node) =>
      /^200$/.test((node.textContent || "").trim()),
    );
    const rect = (node) => {
      if (!node) return null;
      const box = node.getBoundingClientRect();
      return { x: box.x, y: box.y, right: box.right, bottom: box.bottom, w: box.width, h: box.height };
    };
    const img = portrait instanceof HTMLImageElement ? portrait : null;
    return {
      portrait: rect(portrait),
      portraitLoaded: Boolean(img && img.complete && img.naturalWidth > 0),
      portraitSrc: img?.getAttribute("src") ?? null,
      name: rect(name),
      nameText: name?.textContent?.trim() ?? null,
      rating: rect(rating),
      ratingText: rating?.textContent?.trim() ?? null,
      dialog: rect(dialog),
      dialogText: dialog?.textContent?.trim() ?? null,
      panel: rect(panel),
      glitchCount: document.querySelectorAll('[data-testid="glitch-say"], [data-glitch-event]').length,
      scrollOverflow: document.documentElement.scrollWidth - window.innerWidth,
      panelOverflow: panel ? panel.scrollWidth - panel.clientWidth : null,
    };
  });

for (const outcome of ["win", "loss"]) {
  for (const viewport of [
    { width: 900, height: 1000 },
    { width: 390, height: 844 },
  ]) {
    const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error.message)));

    await page.goto(fileUrl);
    await page.waitForFunction(() => !!window.__botResult?.mount);
    await page.evaluate((value) => window.__botResult.mount(value), outcome);
    await page.waitForSelector('[data-testid="result-opponent-image"]', { timeout: 10000 });
    await page.waitForTimeout(350); // framer-motion lands the panel

    const layout = await readLayout(page);
    const label = `${outcome} @ ${viewport.width}`;
    check(`${label}: portrait is loaded and visible`, layout.portraitLoaded && layout.portrait?.w > 40);
    check(
      `${label}: portrait is the bot's roster artwork`,
      /rookie\.webp/.test(layout.portraitSrc ?? ""),
      layout.portraitSrc ?? "none",
    );
    check(`${label}: the bot's name is shown`, /Rookie/.test(layout.nameText ?? ""), layout.nameText ?? "none");
    check(`${label}: the rating label is shown`, /200/.test(layout.ratingText ?? ""), layout.ratingText ?? "none");
    check(
      `${label}: name and rating sit BESIDE the portrait`,
      Boolean(layout.name && layout.portrait) &&
        layout.name.x >= layout.portrait.right - 1 &&
        layout.name.y < layout.portrait.bottom,
      JSON.stringify({ portrait: layout.portrait, name: layout.name }),
    );
    check(
      `${label}: the bot's ending dialog is shown`,
      Boolean(layout.dialogText && layout.dialogText.length > 3),
      layout.dialogText ?? "none",
    );
    check(
      `${label}: the ending dialog is inside the panel`,
      Boolean(layout.dialog && layout.panel) && layout.dialog.right <= layout.panel.right + 1,
      JSON.stringify({ dialog: layout.dialog, panel: layout.panel }),
    );
    check(`${label}: no Glitch mascot on a practice result`, layout.glitchCount === 0);
    check(`${label}: no horizontal overflow`, layout.scrollOverflow <= 1, `${layout.scrollOverflow}px`);
    check(
      `${label}: the panel content does not overflow`,
      layout.panelOverflow !== null && layout.panelOverflow <= 1,
      `${layout.panelOverflow}px`,
    );
    check(`${label}: no page errors`, errors.length === 0, errors.slice(0, 2).join(" | "));

    const path = join(REPORTS, `${outcome}-${viewport.width}.png`);
    await page.screenshot({ path, fullPage: true });
    console.log(`   screenshot → ${path.replace(root, "").replace(/\\/g, "/")}`);
    await context.close();
  }
}

await browser.close();
server.closeAllConnections?.();
await new Promise((resolve) => server.close(resolve));
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
