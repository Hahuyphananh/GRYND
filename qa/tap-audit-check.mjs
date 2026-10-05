// qa/tap-audit-check.mjs
//
// A BROWSER-based tap-target audit. Where a static scan can only guess a size
// from Tailwind classes and cannot tell whether a click hits the API, this
// mounts the real components and measures the rendered DOM.
//
// ═══ IT NEVER TOUCHES THE NETWORK — THIS IS DELIBERATE ════════════════════
// The app's pages are `force-dynamic` and the game screens poll, so driving a
// real origin (production OR a local `next dev`, which still reaches Neon) would
// burn Vercel function invocations and database reads just to take a
// measurement. So:
//
//   * the document is a local file:// bundle — there is no origin;
//   * `fetch` / `XMLHttpRequest` / `sendBeacon` / `WebSocket` are recorder
//     stubs in qa/tap-audit-harness.jsx: an attempted call is RECORDED, never
//     sent. That is what makes the network column trustworthy — we observe the
//     request being constructed, and it cannot leave the process;
//   * every outbound route is additionally aborted at the browser level, so
//     even a stray request from a third-party script is blocked.
//
// Consequently this harness can NEVER affect Vercel usage, realtime/polling, or
// the database. Do not "improve" it by pointing it at a live URL.
//
// WHAT IT REPORTS, per tappable element:
//   * measured width × height (CSS px) and whether either axis is < 44
//   * disabled state  — real (`disabled` / `aria-disabled`)
//   * pressed state   — declarative: a `active:` variant or `aria-pressed`
//   * transition      — REAL: computed transition-property/-duration
//   * network         — the stubbed request(s) the click constructed
//
// Run:  node qa/tap-audit-check.mjs                     (report; exits 0)
//       node qa/tap-audit-check.mjs --strict            (exit 1 if anything is < 44)
//       node qa/tap-audit-check.mjs --viewport=1280x800 (measure a desktop)
//
// COVERAGE: the always-on surfaces — app chrome (nav + footer), the shared PvP
// lobby, the waiting takeover, the shared result screen, the shared modals and
// widgets. Game-specific boards carry their own controls and their own harnesses;
// add a MOUNTS entry in qa/tap-audit-harness.jsx to bring one in. The static
// per-file inventory stays in the audit this replaces, since it sees all 109 files —
// this one is what MEASURES.

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
const outDir = mkdtempSync(join(tmpdir(), "grynd-tap-audit-"));
const REPORTS = join(root, "qa", "reports");
mkdirSync(REPORTS, { recursive: true });
const STRICT = process.argv.includes("--strict");
const MIN = 44;
// Tap size is a TOUCH rule, so the phone viewport is the default. Pass
// `--viewport=1280x800` to see how the same elements land on a desktop, where
// a 36px social icon is a mouse target and only the WCAG 2.5.8 24px floor bites.
const viewportArg = (process.argv.find((a) => a.startsWith("--viewport=")) || "").split("=")[1];
const [vw, vh] = (viewportArg || "390x844").split("x").map(Number);
if (!vw || !vh) throw new Error(`--viewport must look like 390x844 (got ${viewportArg})`);
const VIEWPORT = { width: vw, height: vh };

// ── Same offline stub set the sibling harnesses use ───────────────────────
const STUBS = {
  "next/navigation": `
    export const useRouter = () => ({ push(){}, replace(){}, back(){}, refresh(){}, prefetch(){} });
    export const usePathname = () => "/casino";
    export const useSearchParams = () => new URLSearchParams();
    export default { useRouter, usePathname, useSearchParams };
  `,
  "next/image": `import React from "react"; export default function Img({ alt }) { return React.createElement("div", { role: "img", "aria-label": alt || "" }); }`,
  "next/link": `import React from "react"; export default function Link({ children }) { return children ?? null; }`,
  "next/dynamic": `import React from "react"; export default () => () => null;`,
  "posthog-js/react": `export const usePostHog = () => null; export const PostHogProvider = ({ children }) => children; export default {};`,
  "@clerk/nextjs": `
    export const useUser = () => ({ isLoaded: true, isSignedIn: true, user: { id: "user_1", username: "Tester", publicMetadata: {} } });
    export const useAuth = () => ({ isLoaded: true, isSignedIn: true, userId: "user_1" });
    export const useClerk = () => ({ signOut() {} });
    export const SignInButton = ({ children }) => children ?? null;
    export default {};
  `,
  "context/SocketProvider": `
    export const useSocket = () => ({ socket: null });
    export const SocketProvider = ({ children }) => children;
    export default { useSocket, SocketProvider };
  `,
  "lib/animations": `
    const s = { initial: false, animate: {}, exit: {}, transition: { duration: 0 } };
    export const withReducedMotion = (r, v) => (r ? s : v);
    export const fireConfetti = () => Promise.resolve();
    export const celebrateWin = () => Promise.resolve();
    export const fadeIn = s; export const fadeUp = s;
    export const modalMotion = { backdrop: s, panel: s };
    export const stagger = {}; export const hoverScale = {}; export const scorePop = {};
    export const buttonPulse = () => ({});
    export default { fireConfetti, withReducedMotion };
  `,
  "lib/gameAudio": `
    const noop = () => {};
    export const playVictory = noop; export const playDefeat = noop; export const playTick = noop;
    export const playGoodReveal = noop; export const playBuzz = noop; export const playSelect = noop;
    export const playCrash = noop; export const playGlassBreak = noop;
    export default { playVictory, playDefeat, playTick };
  `,
};

const stubKeys = Object.keys(STUBS);
const normalized = (v) => v.replace(/\\/g, "/");
const matchStubKey = (specifier, resolveDir) => {
  for (const key of stubKeys) if (specifier === key || specifier.endsWith("/" + key)) return key;
  if (!specifier.startsWith(".")) return null;
  const abs = normalized(join(resolveDir, specifier));
  for (const key of stubKeys) if (abs.endsWith("/" + key)) return key;
  return null;
};

await esbuild.build({
  entryPoints: [join(root, "qa/tap-audit-harness.jsx")],
  bundle: true,
  format: "iife",
  platform: "browser",
  jsx: "automatic",
  outfile: join(outDir, "harness.js"),
  logLevel: "error",
  absWorkingDir: root,
  // The app ships JSX inside `.js` files (LanguageContext, several hooks) and a
  // browser has no `process` — Next shims it, so the bundle needs the same.
  loader: { ".js": "jsx", ".mjs": "jsx", ".png": "dataurl", ".svg": "dataurl", ".jpg": "dataurl" },
  define: { "process.env.NODE_ENV": '"development"' },
  banner: {
    js: 'var process = { env: { NODE_ENV: "development" }, platform: "browser", browser: true, version: "v0.0.0" };',
  },
  plugins: [
    {
      name: "tap-stubs",
      setup(build) {
        build.onResolve({ filter: /.*/ }, (args) => {
          const key = matchStubKey(args.path, args.resolveDir);
          if (!key) return null;
          return { path: key, namespace: "tap-stub" };
        });
        build.onLoad({ filter: /.*/, namespace: "tap-stub" }, (args) => ({
          contents: STUBS[args.path],
          loader: "jsx",
          resolveDir: root,
        }));
      },
    },
  ],
});

// ── The app's real stylesheet, so the measured sizes are the shipped ones ──
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
  `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>tap audit</title><link rel="stylesheet" href="./app.css"></head>
<body><div id="root"></div><script src="./harness.js"></script></body></html>`,
);

const SELECTOR = [
  "button",
  "a[href]",
  '[role="button"]',
  '[role="switch"]',
  '[role="tab"]',
  'input[type="button"]',
  'input[type="submit"]',
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: VIEWPORT });
const page = await context.newPage();

// Belt-and-braces: nothing leaves the process, even from a stray script.
//
// Chromium pauses each request BEFORE a connection is opened, so an aborted
// route is not "attempted traffic" — it is traffic that never happened. That
// makes `blocked` a record of intent, not of usage; the audit's real proof of
// containment is `completed`, which counts responses that actually arrived from
// a non-file origin. That count must be zero.
const blocked = [];
const completed = [];
await page.route("**", (route) => {
  const url = route.request().url();
  if (url.startsWith("file:") || url.startsWith("data:")) return route.continue();
  blocked.push(url);
  return route.abort();
});
page.on("response", (res) => {
  const url = res.url();
  if (!url.startsWith("file:") && !url.startsWith("data:")) completed.push(`${res.status()} ${url}`);
});

const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e.message)));

await page.goto(pathToFileURL(join(outDir, "index.html")).href);
await page.waitForFunction(() => window.__tapReady === true, null, { timeout: 30000 });
await page.waitForTimeout(500);

// ── Measure ───────────────────────────────────────────────────────────────
const measured = await page.evaluate((SEL) => {
  // ONE snapshot, shared with the click pass below. Re-querying between the two
  // would mis-align them the moment a click opens a modal (which adds elements).
  const els = Array.from(document.querySelectorAll(SEL));
  window.__tapEls = els;
  return els.map((el, i) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const cls = el.getAttribute("class") || "";
    const txt = (el.getAttribute("aria-label") || el.innerText || el.textContent || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 34);
    return {
      i,
      screen: el.closest("[data-screen]")?.getAttribute("data-screen") || "?",
      tag: el.tagName.toLowerCase(),
      label: txt,
      w: Math.round(r.width),
      h: Math.round(r.height),
      disabled: el.disabled === true || el.getAttribute("aria-disabled") === "true",
      pressed: /(^|[\s:])active:/.test(cls) || el.hasAttribute("aria-pressed"),
      transition: cs.transitionProperty !== "none" && parseFloat(cs.transitionDuration) > 0,
      href: el.getAttribute("href") || null,
    };
  });
}, SELECTOR);

// ── Network per element (stubbed; recorded, never sent) ───────────────────
const nets = await page.evaluate(() => {
  const els = window.__tapEls || [];
  const out = [];
  for (const el of els) {
    const isLink = el.tagName === "A" && el.getAttribute("href");
    if (isLink) {
      // Clicking would unload the file:// document; an anchor's "request" is
      // its navigation, which we record without performing.
      out.push(`navigation ${el.getAttribute("href")}`);
      continue;
    }
    const before = window.__tap.calls.length;
    try {
      el.click();
    } catch {
      /* a handler that throws is captured by the pageerror listener */
    }
    const added = window.__tap.calls.slice(before).map((c) => `${c.method} ${c.url}`);
    out.push(added.length ? added.join(" ; ") : "");
  }
  return out;
});

if (nets.length !== measured.length) {
  throw new Error(`element snapshot drifted: measured ${measured.length}, clicked ${nets.length}`);
}

// The recorders must be ours, not the browser's — otherwise a click could have
// reached a real origin that `page.route` only aborts for a different reason.
const recorders = await page.evaluate(() => window.__tap?.installed || null);
const recordersInstalled = Boolean(recorders?.fetch && recorders?.websocket);

const rows = measured.map((m, idx) => ({
  ...m,
  net: nets[idx] || "",
  under44: m.w < MIN || m.h < MIN,
}));

const failures = await page.evaluate(() => window.__tap.failed || []);
const recordedCalls = await page.evaluate(() => window.__tap.calls.length);
await context.close();
await browser.close();

// ── Report ────────────────────────────────────────────────────────────────
const esc = (v) => String(v ?? "").replace(/\|/g, "\\|");
console.log(`\nTappable elements measured: ${rows.length}   (viewport ${VIEWPORT.width}×${VIEWPORT.height}, min ${MIN}px)`);
console.log(`Mount failures (component skipped): ${failures.length ? failures.map((f) => f.id).join(", ") : "none"}`);
const hosts = [...new Set(blocked.map((u) => { try { return new URL(u).host; } catch { return u; } }))];
console.log(
  `Network containment: ${recordedCalls} call(s) recorded by the stubs, ` +
    `${blocked.length} browser request(s) aborted pre-connection` +
    (hosts.length ? ` [${hosts.join(", ")}]` : "") +
    `, ${completed.length} response(s) actually completed`,
);
console.log("pressed = an `active:` variant or aria-pressed; disabled = a real `disabled`/`aria-disabled`;");
console.log("transition = a computed transition-property/-duration. 'missing' lists what the element lacks.\n");

console.log("file:line | screen | element | missing | network | size");
console.log("-".repeat(80));
for (const r of rows) {
  const missing = [
    r.pressed ? "" : "pressed",
    r.disabled ? "" : "disabled",
    r.transition ? "" : "transition",
  ].filter(Boolean);
  console.log(
    `${r.screen} | ${r.tag}${r.href ? `[href=${String(r.href).slice(0, 20)}]` : ""} "${esc(r.label)}" | ` +
      `${missing.length ? missing.join("+") : "-"} | ${r.net || "-"} | ` +
      `${r.w}×${r.h}${r.under44 ? "  <<< UNDER 44" : ""}`,
  );
}

const under = rows.filter((r) => r.under44);
const underNet = under.filter((r) => r.net);
console.log(`\nUNDER 44×44: ${under.length} of ${rows.length}`);
console.log(`  of those firing a network request: ${underNet.length}`);
for (const r of underNet) console.log(`   • ${r.screen} "${esc(r.label)}" ${r.w}×${r.h} → ${r.net}`);

// Machine-readable + markdown, beside the other QA reports.
writeFileSync(
  join(REPORTS, "tap-audit.json"),
  JSON.stringify(
    {
      min: MIN,
      containment: { recorders: recordersInstalled, abortedPreConnection: blocked, completedResponses: completed },
      failures,
      rows,
    },
    null,
    2,
  ),
);
writeFileSync(
  join(REPORTS, "tap-audit.md"),
  [
    "# Tap-target audit (rendered)",
    "",
    `Viewport ${VIEWPORT.width}×${VIEWPORT.height} · threshold ${MIN}px · ${rows.length} elements · ${under.length} under ${MIN}`,
    "",
    "| screen | element | missing | network | size | under 44 |",
    "|---|---|---|---|---|---|",
    ...rows.map(
      (r) =>
        `| ${esc(r.screen)} | ${esc(r.tag)} ${esc(r.label)} | ` +
        `${[r.pressed ? "" : "pressed", r.disabled ? "" : "disabled", r.transition ? "" : "transition"].filter(Boolean).join("+") || "-"} | ` +
        `${esc(r.net) || "-"} | ${r.w}×${r.h} | ${r.under44 ? "**yes**" : "no"} |`,
    ),
    "",
  ].join("\n"),
);

if (failures.length) {
  console.log("\nSkipped components (needed a provider we did not stub):");
  for (const f of failures) console.log(`   • ${f.id}: ${f.error}\n     at ${f.stack}`);
}

if (pageErrors.length) {
  console.log("\nPage errors:");
  for (const e of pageErrors.slice(0, 5)) console.log(`   • ${e}`);
}

// The whole point of running this offline. A single completed non-file response
// means a real origin was reached and the constraint is broken.
if (!recordersInstalled || completed.length > 0) {
  console.log(`\nNETWORK LEAK: recorders=${recordersInstalled} completed=${JSON.stringify(completed.slice(0, 5))}`);
  process.exitCode = 1;
} else {
  console.log("\nNo network egress: recorder stubs held and no non-file response completed.");
}

console.log(`\nReports: qa/reports/tap-audit.json, qa/reports/tap-audit.md`);
if (STRICT && under.length) {
  console.log(`\nSTRICT: ${under.length} target(s) below ${MIN}px`);
  process.exitCode = 1;
}
