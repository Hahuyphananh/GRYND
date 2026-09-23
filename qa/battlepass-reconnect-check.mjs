// qa/battlepass-reconnect-check.mjs
//
// Browser check for the /battlepass screen error:
//
//   TypeError: Cannot read properties of null (reading 'prestigeUnlocked')
//
// It mounts the REAL page (qa/battlepass-reconnect-harness.jsx) with the project's
// REAL Tailwind CSS and drives the two windows that produced the crash:
//
//   A. a transient cache-clear — the window after a global
//      `mutate(() => true, undefined, { revalidate: true })` wiped every
//      cached SWR payload. The page used to render its track against a null
//      `pass` and throw into the route error boundary; AsyncState must now
//      hold the skeleton until the refetch lands.
//   B. the reconnect cycle — OfflineBanner revalidates on `online`. It must
//      revalidate IN PLACE (no data argument), so the cached pass stays on
//      screen instead of blanking for the refetch.
//
// Run: node qa/battlepass-reconnect-check.mjs
//
// Fully offline: Clerk, the router, nav/footer/background and i18n are stubbed
// by the esbuild step; SWR, the page and the data-state components are real.
// No auth, no database, no dev server.

import esbuild from "esbuild";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import autoprefixer from "autoprefixer";
import { chromium } from "playwright";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "grynd-bp-reconnect-"));
const REPORTS = join(root, "qa", "reports", "battlepass-reconnect");
mkdirSync(REPORTS, { recursive: true });

// ── Stubs: everything noisy around the page ────────────────────────────────
// Clipboard-context: the real page/state components are NOT stubbed.
const STUBS = {
  "next/link": `
    import React from "react";
    export default function Link({ href, children, ...rest }) {
      return React.createElement("a", { ...rest, href: typeof href === "string" ? href : String(href) }, children);
    }
  `,
  "next/navigation": `
    const noop = () => {};
    export const useRouter = () => ({ push: noop, replace: noop, back: noop, refresh: noop, prefetch: noop });
    export const usePathname = () => "/battlepass";
    export const useSearchParams = () => new URLSearchParams();
    export default { useRouter, usePathname, useSearchParams };
  `,
  "next/image": `import React from "react"; export default function Img() { return null; }`,
  "components/navigation-bar": `export default function Nav() { return null; }`,
  "components/Footer": `export default function Footer() { return null; }`,
  "components/InteractiveCasinoBg": `export default function Bg() { return null; }`,
  "hooks/useTranslation": `
    export function useTranslation() {
      return { t: (key, fallback) => (typeof fallback === "string" ? fallback : key), language: "en" };
    }
  `,
  "lib/animations": `
    const staticMotion = { initial: false, animate: {}, exit: {}, transition: { duration: 0 } };
    export const withReducedMotion = (reduce, variant) => (reduce ? staticMotion : variant);
    export default { withReducedMotion };
  `,
};

const stubKeys = Object.keys(STUBS);
const matchStubKey = (specifier) => {
  for (const key of stubKeys) {
    if (specifier === key || specifier.endsWith("/" + key)) return key;
  }
  return null;
};

await esbuild.build({
  entryPoints: [join(root, "qa/battlepass-reconnect-harness.jsx")],
  bundle: true,
  format: "iife",
  platform: "browser",
  jsx: "automatic",
  outfile: join(outDir, "harness.js"),
  logLevel: "error",
  absWorkingDir: root,
  loader: { ".png": "dataurl", ".svg": "dataurl", ".webp": "dataurl" },
  define: { "process.env.NODE_ENV": '"development"' },
  plugins: [
    {
      name: "bp-stubs",
      setup(build) {
        build.onResolve({ filter: /.*/ }, (args) => {
          const key = matchStubKey(args.path);
          if (!key) return null;
          return { path: key, namespace: "bp-stub" };
        });
        build.onLoad({ filter: /.*/, namespace: "bp-stub" }, (args) => ({
          contents: STUBS[args.path],
          loader: "jsx",
          resolveDir: root,
        }));
      },
    },
  ],
});

// ── The app's REAL stylesheet (shipped Tailwind utilities + globals.css) ───
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
<title>Battlepass reconnect check</title>
<link rel="stylesheet" href="./app.css"></head>
<body><div id="root"></div><script src="./harness.js"></script></body></html>`,
);

// ── Reporting helpers ──────────────────────────────────────────────────────
let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${extra ? " — " + extra : ""}`);
  ok ? pass++ : fail++;
};

const fileUrl = pathToFileURL(join(outDir, "index.html")).href;
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();

const consoleErrors = [];
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e.message)));
page.on("console", (m) => {
  if (m.type() !== "error") return;
  const text = m.text();
  if (/Failed to load resource|net::ERR|URL scheme|favicon/.test(text)) return;
  consoleErrors.push(text);
});

const probe = () =>
  page.evaluate(() => ({
    boundary: window.__bp.boundaryError,
    track: !!Array.from(document.querySelectorAll("h2")).find((h) =>
      /Level track & rewards/.test(h.textContent || ""),
    ),
    skeleton: !!document.querySelector('[aria-busy="true"]'),
    errorScreen: !!document.querySelector('[data-error-boundary]'),
    calls: window.__bp.calls,
  }));

await page.goto(fileUrl);
await page.waitForFunction(() => !!window.__bpReady, null, { timeout: 20000 });
await page.waitForFunction(
  () =>
    !!Array.from(document.querySelectorAll("h2")).find((h) =>
      /Level track & rewards/.test(h.textContent || ""),
    ),
  null,
  { timeout: 15000 },
);

// ── A. It renders the pass ─────────────────────────────────────────────────
let s = await probe();
check("the battlepass track renders from the fetched pass", s.track, `track=${s.track}`);
check("no error boundary was hit on load", s.boundary === null && !s.errorScreen, `boundary=${s.boundary}`);
await page.screenshot({ path: join(REPORTS, "01-loaded.png") });

// ── B. Transient cache clear — AsyncState must hold, not crash ─────────────
// The old OfflineBanner behaviour wrote `undefined` over every cached payload.
// A slow refetch keeps that window open; the page must show its skeleton.
await page.evaluate(() => {
  window.__bp.mode = "pending";
  window.__bp.forceWipe();
});
await page.waitForTimeout(250);
let wiped = await probe();
check(
  "a wiped cache does NOT crash the route into the error screen",
  wiped.boundary === null && !wiped.errorScreen,
  `boundary=${wiped.boundary}`,
);
check(
  "…the page still renders a valid state (mirrored pass or skeleton), never a null model",
  wiped.track || wiped.skeleton,
  `skeleton=${wiped.skeleton} track=${wiped.track}`,
);
await page.screenshot({ path: join(REPORTS, "02-cache-cleared.png") });

// Recover the refetch.
await page.evaluate(() => {
  window.__bp.mode = "ok";
  window.__bp.revalidate();
});
await page.waitForFunction(
  () =>
    !!Array.from(document.querySelectorAll("h2")).find((h) =>
      /Level track & rewards/.test(h.textContent || ""),
    ),
  null,
  { timeout: 15000 },
);
s = await probe();
check("the track comes back once the refetch lands", s.track && s.boundary === null, `calls=${s.calls}`);

// ── C. Offline keeps the cached pass on screen ─────────────────────────────
await page.evaluate(() => {
  Object.defineProperty(navigator, "onLine", { configurable: true, get: () => false });
  window.__bp.mode = "error";
  window.dispatchEvent(new Event("offline"));
});
await page.waitForTimeout(250);
s = await probe();
check(
  "offline: the cached pass stays rendered (no blank, no crash)",
  s.track && s.boundary === null,
  `track=${s.track} boundary=${s.boundary}`,
);
await page.screenshot({ path: join(REPORTS, "03-offline-cached.png") });

// ── D. Reconnect with a slow refetch — data must NOT be wiped ──────────────
// This is the OfflineBanner fix: revalidate in place. With `pending` fetch, the
// old cache-write behaviour would have blanked the track to the skeleton.
await page.evaluate(() => {
  Object.defineProperty(navigator, "onLine", { configurable: true, get: () => true });
  window.__bp.mode = "pending";
  window.dispatchEvent(new Event("online"));
});
await page.waitForTimeout(300);
s = await probe();
check(
  "reconnect: the cached pass survives the in-flight revalidation",
  s.track && !s.skeleton && s.boundary === null && !s.errorScreen,
  `track=${s.track} skeleton=${s.skeleton} boundary=${s.boundary}`,
);
await page.screenshot({ path: join(REPORTS, "04-reconnected.png") });

// The refetch completes normally afterwards.
await page.evaluate(() => {
  window.__bp.mode = "ok";
  window.__bp.revalidate();
});
await page.waitForTimeout(300);
s = await probe();
check("reconnect: the refreshed pass renders and never hit the error screen", s.track && s.boundary === null, `calls=${s.calls}`);

// ── E. No structural runtime errors anywhere ───────────────────────────────
const structural = [...consoleErrors, ...pageErrors].filter((e) =>
  /Cannot read|Cannot update|is not a function|hydration|Hydration|unique "key"/i.test(e),
);
check(
  "no structural console / page errors in the run",
  structural.length === 0,
  structural.slice(0, 3).join(" | "),
);

await browser.close();
console.log(`\nScreenshots written to qa/reports/battlepass-reconnect/`);
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
