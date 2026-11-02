// qa/chat-emote-check.mjs
//
// Browser check for the chat-side emote picker and the unread badge.
//
// Run: node qa/chat-emote-check.mjs
//
// It bundles qa/chat-emote-harness.jsx with esbuild (same offline stub pattern
// as qa/tap-audit-check.mjs), compiles the app's real stylesheet with Tailwind
// so the geometry is the shipped one, and drives installed Chrome over file://.
// Emote artwork is fulfilled from public/emotes, so the images that are checked
// for naturalWidth are the real shipped assets.
//
// What it proves:
//   * the launcher badge appears top-right, counts, dedupes and clears on open;
//   * the picker renders inside the chat and its animated assets load;
//   * the full set expands INSIDE the panel (no clipping, no overflow);
//   * picking sends through the mounted match's channel, once per cooldown.

import esbuild from "esbuild";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import autoprefixer from "autoprefixer";
import { chromium } from "playwright";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "grynd-chat-emote-"));
const REPORTS = join(root, "qa", "reports");
mkdirSync(REPORTS, { recursive: true });

const STUBS = {
  "next/navigation": `
    export const useRouter = () => ({ push(){}, replace(){}, back(){}, refresh(){}, prefetch(){} });
    export const usePathname = () => "/casino/dominoes/abc123";
    export const useSearchParams = () => new URLSearchParams();
    export default { useRouter, usePathname, useSearchParams };
  `,
  "next/link": `
    import React from "react";
    export default function Link({ children }) { return React.createElement("span", null, children); }
  `,
  "next/image": `
    import React from "react";
    export default function Img({ alt }) { return React.createElement("div", { role: "img", "aria-label": alt || "" }); }
  `,
  "@clerk/nextjs": `
    export const useUser = () => ({ isLoaded: true, isSignedIn: true, user: { id: "user_1", username: "Tester", fullName: "Tap Tester", publicMetadata: {} } });
    export const useAuth = () => ({ isLoaded: true, isSignedIn: true, userId: "user_1" });
    export default {};
  `,
  "context/SocketProvider": `
    const handlers = {};
    const sent = [];
    const socket = {
      id: "sock_1",
      connected: true,
      on(event, fn) { (handlers[event] = handlers[event] || []).push(fn); return socket; },
      off(event, fn) { handlers[event] = (handlers[event] || []).filter((f) => f !== fn); return socket; },
      emit(event, payload) { sent.push({ event, payload }); return socket; },
      fire(event, payload) { for (const fn of handlers[event] || []) fn(payload); },
    };
    if (typeof window !== "undefined") { window.__socket = socket; window.__socketSent = sent; }
    export const useSocket = () => ({ socket, ready: true });
    export const SocketProvider = ({ children }) => children;
    export default { useSocket, SocketProvider };
  `,
  "lib/realtime": `
    export const subscribeToChatMessages = () => () => {};
    export default { subscribeToChatMessages };
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
  entryPoints: [join(root, "qa/chat-emote-harness.jsx")],
  bundle: true,
  format: "iife",
  platform: "browser",
  jsx: "automatic",
  outfile: join(outDir, "harness.js"),
  logLevel: "error",
  absWorkingDir: root,
  loader: { ".js": "jsx", ".mjs": "jsx", ".png": "dataurl", ".svg": "dataurl", ".jpg": "dataurl" },
  define: { "process.env.NODE_ENV": '"development"' },
  banner: {
    js: 'var process = { env: { NODE_ENV: "development" }, platform: "browser", browser: true, version: "v0.0.0" };',
  },
  plugins: [
    {
      name: "chat-stubs",
      setup(build) {
        build.onResolve({ filter: /.*/ }, (args) => {
          const key = matchStubKey(args.path, args.resolveDir);
          return key ? { path: key, namespace: "chat-stub" } : null;
        });
        build.onLoad({ filter: /.*/, namespace: "chat-stub" }, (args) => ({
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
writeFileSync(
  join(outDir, "app.css"),
  compiled.css.replace(/@import\s+url\(["']?https?:\/\/[^)]*\);?/g, ""),
);

writeFileSync(
  join(outDir, "index.html"),
  `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>chat emotes</title><link rel="stylesheet" href="./app.css"></head>
<body><div id="root"></div><script src="./harness.js"></script></body></html>`,
);

// ══════════════════════════════════════════════════════════════════════════

const failures = [];
const checks = [];
const check = (name, ok, detail = "") => {
  checks.push({ name, ok, detail });
  if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
};

async function runViewport(width, height) {
  const browser = await chromium.launch({ channel: "chrome" });
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  const pageErrors = [];

  // Offline by construction: abort everything except file:// / data:, then
  // serve the real emote artwork from public/ (registered last so it wins).
  await page.route("**", (route) => {
    const url = route.request().url();
    if (url.startsWith("file:") || url.startsWith("data:")) return route.continue();
    return route.abort();
  });
  await page.route("**/emotes/*.webp", (route) => {
    const name = route.request().url().split("/").pop();
    const file = join(root, "public", "emotes", name);
    if (!existsSync(file)) return route.fulfill({ status: 404, body: "" });
    return route.fulfill({
      status: 200,
      contentType: "image/webp",
      body: readFileSync(file),
    });
  });

  page.on("pageerror", (e) => pageErrors.push(String(e.message)));

  const boxOf = async (selector) =>
    page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom };
    }, selector);

  const fire = (id, content) =>
    page.evaluate(
      ({ id, content }) => {
        window.__socket.fire("chat:updated", {
          roomType: "game",
          roomId: "/casino/dominoes/abc123",
          message: {
            id,
            roomType: "game",
            roomId: "/casino/dominoes/abc123",
            content,
            displayName: "Rival",
            createdAt: new Date().toISOString(),
          },
        });
      },
      { id, content },
    );

  await page.goto(pathToFileURL(join(outDir, "index.html")).href);
  await page.waitForFunction(() => window.__chatReady === true, null, { timeout: 30000 });
  await page.waitForTimeout(300);

  const tag = `${width}x${height}`;

  // ── Badge ────────────────────────────────────────────────────────────────
  check(`${tag}: no badge before any message`, (await page.$("[data-chat-unread]")) === null);

  await fire("msg-1", "hello");
  await page.waitForSelector("[data-chat-unread]");
  check(
    `${tag}: first message shows "1"`,
    (await page.textContent("[data-chat-unread]"))?.trim() === "1",
    await page.textContent("[data-chat-unread]"),
  );

  const launcher = await boxOf("[data-chat-toggle]");
  const badge = await boxOf("[data-chat-unread]");
  check(
    `${tag}: badge sits in the top-right corner of the launcher`,
    badge && launcher && badge.x + badge.w >= launcher.right - 4 && badge.y <= launcher.y + launcher.h / 2,
    JSON.stringify({ launcher, badge }),
  );

  // The same row delivered twice (socket broadcast + Supabase safety net) must
  // only count once.
  await fire("msg-1", "hello");
  await page.waitForTimeout(150);
  check(
    `${tag}: the same message id is not counted twice`,
    (await page.textContent("[data-chat-unread]"))?.trim() === "1",
    await page.textContent("[data-chat-unread]"),
  );

  await fire("msg-2", "again");
  await page.waitForTimeout(150);
  check(
    `${tag}: a second message counts up`,
    (await page.textContent("[data-chat-unread]"))?.trim() === "2",
    await page.textContent("[data-chat-unread]"),
  );

  const label = await page.$eval("[data-chat-toggle]", (el) => el.getAttribute("aria-label"));
  check(`${tag}: the launcher announces the unread count`, /2 unread messages/.test(label || ""), label);

  // ── Open the panel ───────────────────────────────────────────────────────
  await page.click("[data-chat-toggle]");
  await page.waitForSelector("[data-chat-panel]");
  await page.waitForSelector("[data-chat-emotes]");
  await page.waitForTimeout(400);

  check(
    `${tag}: opening clears the badge`,
    (await page.$("[data-chat-unread]")) === null,
  );

  const panel = await boxOf("[data-chat-panel]");
  check(
    `${tag}: the panel fits the viewport`,
    panel && panel.y >= 0 && panel.bottom <= height + 1,
    JSON.stringify(panel),
  );

  // ── The tray ─────────────────────────────────────────────────────────────
  const slots = await page.$$("[data-emote-slot]");
  check(`${tag}: quick emote slots render inside the chat`, slots.length >= 3, `slots=${slots.length}`);
  check(
    `${tag}: the tray is the picker (all-emotes trigger present)`,
    (await page.$("[data-chat-emotes] [aria-label='All emotes']")) !== null,
  );

  const art = await page.evaluate(() =>
    Array.from(document.querySelectorAll("[data-chat-emotes] img")).map((img) => ({
      src: img.getAttribute("src"),
      naturalWidth: img.naturalWidth,
      display: getComputedStyle(img).display,
      animation: getComputedStyle(img).animationName,
      playState: getComputedStyle(img).animationPlayState,
    })),
  );
  check(`${tag}: emote artwork renders`, art.length > 0, `images=${art.length}`);
  check(
    `${tag}: every emote asset actually loads`,
    art.length > 0 && art.every((a) => a.naturalWidth > 0 && a.display !== "none"),
    JSON.stringify(art.filter((a) => a.naturalWidth === 0)),
  );
  check(
    `${tag}: nothing in the UI pauses or replaces the animated asset`,
    art.every((a) => a.playState !== "paused" && a.animation === "none"),
    JSON.stringify(art.map((a) => [a.animation, a.playState])),
  );

  // The shipped asset is an animated WebP (ANIM chunk), not a still frame.
  const animated = art.length > 0 && readFileSync(join(root, "public", "emotes", art[0].src.split("/").pop())).includes("ANIM");
  check(`${tag}: the shipped emote file is animated`, animated, art[0]?.src);

  // ── The full set opens inside the panel ──────────────────────────────────
  await page.click("[data-chat-emotes] [aria-label='All emotes']");
  await page.waitForSelector("[data-emote-wheel]");
  await page.waitForTimeout(350);

  // The panel takes its full height while the grid is open, so re-measure.
  const panelOpen = await boxOf("[data-chat-panel]");
  const wheel = await boxOf("[data-emote-wheel]");
  check(
    `${tag}: the full set opens inside the chat panel`,
    wheel && panelOpen && wheel.y >= panelOpen.y - 1 && wheel.bottom <= panelOpen.bottom + 1 && wheel.x >= panelOpen.x - 1 && wheel.right <= panelOpen.right + 1,
    JSON.stringify({ panelOpen, wheel }),
  );

  const messagesBox = await boxOf("[data-chat-panel] [aria-label='Chat messages']");
  check(
    `${tag}: the message list keeps real space while picking`,
    messagesBox && messagesBox.h >= 100,
    JSON.stringify(messagesBox),
  );

  const overflow = await page.evaluate(() => {
    const panelEl = document.querySelector("[data-chat-panel]");
    const wheelEl = document.querySelector("[data-emote-wheel]");
    return {
      panelX: panelEl.scrollWidth - panelEl.clientWidth,
      wheelX: wheelEl.scrollWidth - wheelEl.clientWidth,
    };
  });
  check(
    `${tag}: the panel does not scroll sideways`,
    overflow.panelX <= 1 && overflow.wheelX <= 1,
    JSON.stringify(overflow),
  );

  // The composer must survive the grid opening: it is the thing a clipped
  // panel eats first.
  const composer = await boxOf("[data-chat-panel] form");
  check(
    `${tag}: the composer stays inside the panel with the full set open`,
    composer && panelOpen && composer.bottom <= panelOpen.bottom + 1 && composer.y >= panelOpen.y,
    JSON.stringify({ composer, panelBottom: panelOpen?.bottom }),
  );

  await page.screenshot({ path: join(REPORTS, `chat-emotes-${tag}.png`) });

  // ── Sending ──────────────────────────────────────────────────────────────
  await page.click("[data-emote-choice='laugh']");
  await page.waitForTimeout(150);
  const sends = await page.evaluate(() => window.__chatQA.sends);
  check(`${tag}: picking an emote sends through the match channel`, sends.length === 1, JSON.stringify(sends));
  check(
    `${tag}: the send carries the catalog key, not free text`,
    sends.length === 1 && sends[0].key === "laugh" && sends[0].kind === "animated",
    JSON.stringify(sends[0]),
  );

  await page.click("[data-chat-emotes] [aria-label='All emotes']");
  await page.waitForTimeout(100);
  const secondChoice = await page.$("[data-emote-choice='fire']");
  if (secondChoice) await secondChoice.click();
  await page.waitForTimeout(150);
  const afterSecond = await page.evaluate(() => window.__chatQA.sends.length);
  check(`${tag}: the cooldown swallows a second tap`, afterSecond === 1, `sends=${afterSecond}`);

  // Close and reopen: no badge, but the tray is still there.
  await page.click("[data-chat-toggle]");
  await page.waitForTimeout(200);
  check(`${tag}: closing with nothing new shows no badge`, (await page.$("[data-chat-unread]")) === null);
  await page.click("[data-chat-toggle]");
  await page.waitForSelector("[data-chat-emotes]");

  check(`${tag}: no page errors`, pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));

  await context.close();
  await browser.close();
}

await runViewport(390, 844);
await runViewport(1440, 900);

// ── Report ────────────────────────────────────────────────────────────────
for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.ok || !c.detail ? "" : `\n        ${c.detail}`}`);
console.log(`\n${checks.filter((c) => c.ok).length}/${checks.length} checks passed`);
console.log(`Screenshots: qa/reports/chat-emotes-390x844.png, chat-emotes-1440x900.png`);

if (failures.length) {
  console.log(`\n${failures.length} failing check(s)`);
  process.exitCode = 1;
}
