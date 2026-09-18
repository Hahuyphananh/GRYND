// qa/roulette-canvas-check.mjs
//
// Browser check for the roulette CANVAS itself: backing-store resolution and
// what a resize does to the wheel. Mounts the real match page
// (qa/roulette-reveal-harness.jsx → src/app/casino/roulette/[matchId]/
// PageClient.jsx) with a scripted status endpoint and reads the canvas pixels
// directly, so the assertions are about what is actually painted:
//
//   1. Backing store: the canvas keeps its logical 420 × 420 drawing space but
//      the backing store tracks the device — 420 at DPR 1, CSS-box × DPR at
//      DPR 2, and capped (never more than 2× per axis) on a 3× phone. Never
//      below 420, so no display is softer than the old fixed bitmap.
//   2. No ball before the first spin, ball present after landing, winning ring
//      under the pointer at the top.
//   3. Resize immediately after landing: the wheel stays at its settled angle
//      (pocket signature unchanged), the ball stays visible, and the winning
//      ring stays put. This is the "resize resets the wheel to angle 0 / drops
//      the ball" regression.
//   4. Resize DURING a spin: the wheel is still turning across the resize (two
//      samples a few frames apart differ) and the spin still lands on the
//      server's number.
//   5. Mobile-sized viewport: still sharp — the backing store is at least 2×
//      the CSS box, and still capped.
//
// Fidelity: the page, the canvas, the spin loop and the resize handler are
// production code. Only the page's surroundings are stubbed (auth, router,
// analytics, socket, audio, chrome components) — see the reveal check for the
// stub list.
//
// Run: node qa/roulette-canvas-check.mjs

import esbuild from "esbuild";
import { chromium } from "playwright";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// ── 1. Stubs for everything that is NOT the canvas path ────────────────────
const shell = (extra) => `import { createElement, Fragment } from "react";
const Passthrough = (p) => createElement(Fragment, null, p ? p.children : null);
const Null = () => null;
${extra}`;

const NEXT_STUBS = {
  "next/navigation": shell(`export const useRouter = () => ({ push() {}, replace() {}, back() {}, refresh() {}, prefetch() {} });
export const useParams = () => ({ matchId: "1" });
export const usePathname = () => "/casino/roulette/1";
export const useSearchParams = () => new URLSearchParams();
export const redirect = () => {};
export const notFound = () => {};
export default { useRouter, useParams, usePathname, useSearchParams };`),
  "next/image": shell(`export default Null;`),
  "next/link": shell(`export default Passthrough;`),
  "next/dynamic": shell(`export default () => Null;`),
  "next/font/google": shell(`export const Inter = () => ({ className: "" }); export default {};`),
  "next/font/local": shell(`export default () => ({ className: "" });`),
};

const CLERK_STUB = shell(`export const useUser = () => ({ isLoaded: true, isSignedIn: true, user: { id: "user_1", username: "Tester", fullName: "Tester" } });
export const useAuth = () => ({ isLoaded: true, isSignedIn: true, userId: "user_1" });
export const useClerk = () => ({ signOut() {} });
export const SignedIn = Passthrough;
export const SignedOut = Null;
export const ClerkProvider = Passthrough;
export const RedirectToSignIn = Null;
export default { useUser, useAuth, useClerk };`);

const APP_STUBS = new Map([
  ["components/navigation-bar", shell(`export default Passthrough;`)],
  ["components/IconAvatar", shell(`export default Passthrough;`)],
  ["components/ReportModal", shell(`export default Passthrough;`)],
  ["components/game/EmotePicker", shell(`export default Passthrough; export const EmoteArtwork = Passthrough;`)],
  ["components/creator-mode/CreatorModeHost", shell(`export default Passthrough;`)],
  ["components/creator-mode/CreatorModeLayout", shell(`export const CreatorResponsiveLayout = Passthrough; export default Passthrough;`)],
  ["components/lobby/MatchWaiting", shell(`export default Passthrough;`)],
  ["components/result/PvpResultScreen", shell(`export default Passthrough;`)],
  ["context/SocketProvider", shell(`export const useSocket = () => ({ socket: null }); export const SocketProvider = Passthrough;`)],
  ["lib/gameAudio", shell(`export const playVictory = () => {}; export const playDefeat = () => {}; export const playTick = () => {}; export const playCardPlace = () => {};`)],
]);

const outDir = mkdtempSync(join(tmpdir(), "roulette-canvas-"));
const bundleOut = join(outDir, "harness.js");
await esbuild.build({
  entryPoints: [join(root, "qa/roulette-reveal-harness.jsx")],
  bundle: true,
  format: "iife",
  platform: "browser",
  jsx: "automatic",
  outfile: bundleOut,
  logLevel: "error",
  absWorkingDir: root,
  define: { "process.env.NODE_ENV": '"development"' },
  plugins: [
    {
      name: "qa-stubs",
      setup(build) {
        build.onResolve({ filter: /^next\/|^@clerk\/|^posthog-js\// }, (args) => ({
          path: args.path,
          namespace: "qa-bare",
        }));
        build.onLoad({ filter: /.*/, namespace: "qa-bare" }, (args) => {
          const js = (contents) => ({ contents, loader: "js", resolveDir: root });
          if (NEXT_STUBS[args.path]) return js(NEXT_STUBS[args.path]);
          if (args.path.startsWith("@clerk/")) return js(CLERK_STUB);
          if (args.path.startsWith("posthog-js/"))
            return js(shell(`export const usePostHog = () => null; export default {};`));
          return js(shell(`export default Null;`));
        });

        for (const tail of APP_STUBS.keys()) {
          const escaped = tail.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          build.onResolve({ filter: new RegExp(`${escaped}$`) }, () => ({
            path: tail,
            namespace: "qa-app",
          }));
        }
        build.onLoad({ filter: /.*/, namespace: "qa-app" }, (args) => ({
          contents: APP_STUBS.get(args.path),
          loader: "js",
          resolveDir: root,
        }));

        build.onLoad({ filter: /\.(png|jpe?g|webp|gif|svg)$/ }, () => ({
          contents: `export default { src: "/images/smalllogo.png", width: 612, height: 408 };`,
          loader: "js",
        }));
      },
    },
  ],
});

// ── 2. Static server for the bundle + real public assets ──────────────────
const PUBLIC = join(root, "public");
const harnessJs = readFileSync(bundleOut, "utf8");
const pageHtml = `<!doctype html>
<html><head><meta charset="utf-8"><title>Roulette canvas check</title>
<style>body{margin:0;background:#0b1220;color:#fff;font-family:sans-serif}</style></head>
<body><div id="root"></div><script src="/harness.js"></script></body></html>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(pageHtml);
    return;
  }
  if (url.pathname === "/harness.js") {
    res.writeHead(200, { "Content-Type": "application/javascript" });
    res.end(harnessJs);
    return;
  }
  if (url.pathname.startsWith("/images/") || url.pathname.startsWith("/icons/")) {
    try {
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      res.end(readFileSync(join(PUBLIC, url.pathname)));
      return;
    } catch {
      /* fall through to 404 */
    }
  }
  res.writeHead(404);
  res.end("not found");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

// ── 3. Assertions ─────────────────────────────────────────────────────────
let pass = 0;
let fail = 0;
let page = null;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${extra ? " — " + extra : ""}`);
  ok ? pass++ : fail++;
};

const LOGICAL = 420;
const POINTER = -Math.PI / 2;
// The ball's rest position in logical canvas coordinates (`BALL_POCKET_RADIUS`
// at the pointer angle): directly under the fixed pointer.
const BALL_XY = [210, 210 - 164];
// The winning ring's centre is the LOOK of the landed pocket (radius 210-30),
// so its stroke sits 14 px further out from the wheel centre.
const RING_XY = [210 + 14, 210 - 180];

// Reads the canvas the way the eye does: a 16-point colour signature around the
// pockets, plus the two landmark pixels the landed state lives on.
const readCanvas = () =>
  page.evaluate(
    ({ ballXy, ringXy, logical }) => {
      const canvas = document.querySelector("canvas");
      const ctx = canvas.getContext("2d");
      const scale = canvas.width / logical;
      const at = (x, y) => {
        const d = ctx.getImageData(
          Math.round(x * scale),
          Math.round(y * scale),
          1,
          1,
        ).data;
        return [d[0], d[1], d[2], d[3]];
      };
      const signature = [];
      for (let i = 0; i < 16; i += 1) {
        const a = (i / 16) * Math.PI * 2;
        signature.push(
          at(210 + Math.cos(a) * 120, 210 + Math.sin(a) * 120).join(","),
        );
      }
      const ball = at(ballXy[0], ballXy[1]);
      const ring = at(ringXy[0], ringXy[1]);
      const isBright = (px) => px[3] > 200 && px[0] > 190 && px[1] > 190;
      const isGold = (px) =>
        px[3] > 200 && px[0] > 170 && px[1] > 170 && px[2] < 150;
      return {
        backing: canvas.width,
        cssWidth: canvas.clientWidth,
        signature,
        ball: isBright(ball),
        winningRing: isGold(ring),
        ballPx: ball.join(","),
      };
    },
    { ballXy: BALL_XY, ringXy: RING_XY, logical: LOGICAL },
  );

const pushRound = (payload) => page.evaluate((p) => window.__settleRound(p), payload);

const spinStatus = () =>
  page.waitForFunction(
    () =>
      [...document.querySelectorAll("span")].some(
        (el) => el.textContent.replace(/\s+/g, " ").trim() === "Spinning…",
      ),
    null,
    { timeout: 20000 },
  );

const landing = () =>
  page.waitForFunction(
    () => {
      const spinning = [...document.querySelectorAll("span")].some(
        (el) => el.textContent.replace(/\s+/g, " ").trim() === "Spinning…",
      );
      const lit = [...document.querySelectorAll("button")].some((b) =>
        /ring-3/.test(b.className),
      );
      return !spinning && lit;
    },
    null,
    { timeout: 20000 },
  );

const mountPage = async (url, options = {}) => {
  const p = await browser.newPage({
    viewport: { width: 1280, height: 1800 },
    ...options,
  });
  p.on("pageerror", (err) => console.log("PAGE ERROR:", err.message));
  p.on("console", (msg) => {
    if (msg.type() !== "error") return;
    if (/non-boolean attribute/.test(msg.text())) return;
    console.log("CONSOLE ERROR:", msg.text());
  });
  await p.goto(url, { waitUntil: "networkidle" });
  await p.waitForFunction(
    () => document.querySelectorAll("button").length > 30,
    null,
    { timeout: 20000 },
  );
  // The resolution pass runs from an effect (plus a ResizeObserver), so give
  // the first layout a beat before reading the backing store.
  await p.waitForTimeout(200);
  return p;
};

const countSame = (a, b) => a.filter((v, i) => v === b[i]).length;

// The page's own layout keeps the wheel at its 420 px maximum even on a narrow
// viewport, so the canvas BOX is shrunk directly to exercise the resize path.
// This is the same class of event the real page sees on a phone (the canvas'
// CSS box changes, the ResizeObserver fires, the backing store is re-derived) —
// the assertions below are about the wheel surviving it, not about the box.
const resizeCanvasBox = async (maxPx) => {
  await page.evaluate((px) => {
    let style = document.getElementById("qa-canvas-box");
    if (!style) {
      style = document.createElement("style");
      style.id = "qa-canvas-box";
      document.head.appendChild(style);
    }
    style.textContent = `canvas { max-width: ${px}px !important; max-height: ${px}px !important; }`;
  }, maxPx);
  // ResizeObserver callback + re-sync + repaint.
  await page.waitForTimeout(250);
};

let browser = null;
try {
  browser = await chromium.launch();

  // ── A. Backing store: DPR 1 vs DPR 2, and the mobile cap ────────────────
  page = await mountPage(base, { deviceScaleFactor: 1 });
  const dpr1 = await readCanvas();
  check(
    "DPR 1: the backing store stays at the logical 420 px",
    dpr1.backing === 420,
    `backing ${dpr1.backing}, css ${dpr1.cssWidth}`,
  );
  check(
    "DPR 1: the CSS box drives the size (fluid layout, 420 max)",
    dpr1.cssWidth > 0 && dpr1.cssWidth <= 420,
    `css ${dpr1.cssWidth}`,
  );

  const dpr2Page = await mountPage(base, { deviceScaleFactor: 2 });
  page = dpr2Page;
  const dpr2 = await readCanvas();
  check(
    "DPR 2: the wheel renders at the device resolution, not 420",
    dpr2.backing === Math.min(dpr2.cssWidth * 2, 840) && dpr2.backing > 420,
    `backing ${dpr2.backing}, css ${dpr2.cssWidth}`,
  );

  const mobilePage = await mountPage(base, {
    deviceScaleFactor: 3,
    viewport: { width: 390, height: 844 },
  });
  page = mobilePage;
  const mobile = await readCanvas();
  check(
    "mobile DPR 3: the backing store is capped (no 3× fill rate)",
    mobile.backing === 840,
    `backing ${mobile.backing}, css ${mobile.cssWidth}`,
  );
  check(
    "mobile DPR 3: still >= 2 device px per CSS px (sharper than the old 420)",
    mobile.backing >= mobile.cssWidth * 2 && mobile.backing > 420,
    `backing ${mobile.backing}, css ${mobile.cssWidth}`,
  );
  // A narrower canvas costs proportionally fewer pixels: the backing store
  // tracks the element and only rises to the cap when the box is big enough to
  // need it (330 CSS px × 3 would be 990, i.e. the cap is what keeps it at
  // 840 — this checks the other half, where the box is the binding constraint).
  await resizeCanvasBox(260);
  const mobileSmall = await readCanvas();
  check(
    "mobile: the backing store scales down with the CSS box (fill-rate win)",
    mobileSmall.backing === 780 && mobileSmall.backing < mobile.backing,
    `backing ${mobile.backing} → ${mobileSmall.backing}, css ${mobileSmall.cssWidth}`,
  );
  await mobilePage.close();

  // ── B. Nothing on the wheel before the first spin ──────────────────────
  page = dpr2Page;
  const before = await readCanvas();
  check(
    "no ball and no winning ring before the first spin",
    !before.ball && !before.winningRing,
    `ball ${before.ballPx}`,
  );

  // ── C. Land a round, then resize immediately after landing ─────────────
  await pushRound({ number: 32, winner: "player1", call: 26 });
  await spinStatus();
  await landing();
  await page.waitForTimeout(150);
  const landed = await readCanvas();
  check(
    "after landing: the ball is drawn in the pocket under the pointer",
    landed.ball,
    `ball ${landed.ballPx}`,
  );
  check(
    "after landing: the winning ring is drawn under the pointer",
    landed.winningRing,
    `ring ${landed.winningRing}`,
  );

  // Shrink the canvas box (and the viewport with it) — this is the resize path.
  await resizeCanvasBox(300);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(250);
  const afterResize = await readCanvas();
  check(
    "resize after landing: the backing store re-syncs to the new CSS box",
    afterResize.backing === Math.min(afterResize.cssWidth * 2, 840) &&
      afterResize.backing !== landed.backing,
    `backing ${landed.backing} → ${afterResize.backing}, css ${afterResize.cssWidth}`,
  );
  check(
    "resize after landing: the wheel keeps its settled angle",
    countSame(afterResize.signature, landed.signature) >= 14,
    `${countSame(afterResize.signature, landed.signature)}/16 pocket samples unchanged`,
  );
  check(
    "resize after landing: the ball is still in the pocket",
    afterResize.ball,
    `ball ${afterResize.ballPx}`,
  );
  check(
    "resize after landing: the winning ring is still under the pointer",
    afterResize.winningRing,
    `ring ${afterResize.winningRing}`,
  );

  // ── D. Resize DURING a spin ─────────────────────────────────────────────
  await resizeCanvasBox(420);
  await page.setViewportSize({ width: 1280, height: 1800 });
  await page.waitForTimeout(250);
  await pushRound({ number: 11, winner: "player2", call: null });
  await spinStatus();
  await page.waitForTimeout(700);

  const spin1 = await readCanvas();
  await page.waitForTimeout(200);
  const spin2 = await readCanvas();
  check(
    "mid-spin: the wheel is animating across frames",
    countSame(spin1.signature, spin2.signature) < 16,
    `${countSame(spin1.signature, spin2.signature)}/16 samples identical`,
  );

  // Resize in the middle of the spin: the loop must keep running.
  await resizeCanvasBox(340);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(250);
  const spin3 = await readCanvas();
  await page.waitForTimeout(200);
  const spin4 = await readCanvas();
  check(
    "resize during a spin: the wheel keeps turning afterwards",
    countSame(spin3.signature, spin4.signature) < 16,
    `${countSame(spin3.signature, spin4.signature)}/16 samples identical`,
  );
  check(
    "resize during a spin: the backing store followed the new CSS box",
    spin3.backing === Math.min(spin3.cssWidth * 2, 840) &&
      spin3.backing !== spin2.backing,
    `backing ${spin2.backing} → ${spin3.backing}, css ${spin3.cssWidth}`,
  );

  // ...and the spin still lands on the server's number.
  await landing();
  await page.waitForTimeout(150);
  const spinLanded = await page.evaluate(() => ({
    highlighted: [...document.querySelectorAll("button")]
      .filter((b) => /ring-3/.test(b.className))
      .map((b) => (b.textContent.match(/^\d+/) || [""])[0]),
  }));
  check(
    "resize during a spin: the spin still lands on the server's pocket",
    spinLanded.highlighted.includes("11"),
    JSON.stringify(spinLanded.highlighted),
  );
  const afterSpinResize = await readCanvas();
  check(
    "resize during a spin: the landed ball and ring are painted",
    afterSpinResize.ball && afterSpinResize.winningRing,
    `ball ${afterSpinResize.ballPx}, ring ${afterSpinResize.winningRing}`,
  );

  // Growing it back is the same path in reverse.
  await resizeCanvasBox(420);
  await page.setViewportSize({ width: 1280, height: 1800 });
  const grown = await readCanvas();
  check(
    "resize back to full size: ball, ring and angle all survive",
    grown.ball &&
      grown.winningRing &&
      countSame(grown.signature, afterSpinResize.signature) >= 14,
    `backing ${grown.backing}, ${countSame(grown.signature, afterSpinResize.signature)}/16 samples unchanged`,
  );

  // ── E. Reduced motion + resize ─────────────────────────────────────────
  // The reduced-motion result path paints the wheel straight into the server's
  // final position; a resize has to preserve that pose exactly like a spun one.
  page = await mountPage(base, { deviceScaleFactor: 2, reducedMotion: "reduce" });
  await pushRound({ number: 5, winner: "player1", call: null });
  await landing();
  await page.waitForTimeout(150);
  const rmLanded = await readCanvas();
  check(
    "reduced motion: the final position is painted with its ball and ring",
    rmLanded.ball && rmLanded.winningRing,
    `ball ${rmLanded.ballPx}, ring ${rmLanded.winningRing}`,
  );
  await resizeCanvasBox(300);
  const rmResized = await readCanvas();
  check(
    "reduced motion: resize keeps the result pose and the backing store in sync",
    rmResized.ball &&
      rmResized.winningRing &&
      rmResized.backing === Math.min(rmResized.cssWidth * 2, 840) &&
      rmResized.backing !== rmLanded.backing &&
      countSame(rmResized.signature, rmLanded.signature) >= 14,
    `backing ${rmLanded.backing} → ${rmResized.backing}, ${countSame(rmResized.signature, rmLanded.signature)}/16 samples unchanged`,
  );

  await browser.close();
} catch (err) {
  if (page) {
    const dump = await page
      .evaluate(() => (document.body ? document.body.innerHTML.slice(0, 800) : "NO BODY"))
      .catch((e) => `EVAL FAILED: ${e.message}`);
    console.log(`PAGE HTML:\n${dump}\n`);
  }
  check("check ran to completion", false, err.message);
} finally {
  server.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
