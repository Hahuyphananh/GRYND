// qa/roulette-reveal-check.mjs
//
// Browser check for the roulette RESULT REVEAL lifecycle. Mounts the real
// match page (qa/roulette-reveal-harness.jsx → src/app/casino/roulette/
// [matchId]/PageClient.jsx) with a scripted status endpoint and asserts:
//
//   1. While the wheel is spinning, NOTHING on the screen gives the result
//      away: no highlighted grid tile, the "Last spin" chip is masked, the
//      newest round-history row hides the number AND the call outcome, and the
//      round-result banner is not up.
//   2. At landing the number is revealed everywhere at once — tile highlight,
//      "Last spin" chip, history row — and the banner (settlement UI) follows
//      with the post-round balances.
//   3. The highlight survives the moment of landing and then expires on its
//      OWN short clock (the regression: the old 4000 ms timer ran from spin
//      start, so a 4500 ms spin left the highlight already expired at landing).
//   4. A second round landing on the SAME number still spins and still reveals
//      from scratch (the other regression: `setWinningNumber(repeat)` was a
//      no-op `setState`, so the reveal never re-armed).
//   5. Betting is unchanged: after a full spin + reveal the number grid still
//      stages a bet.
//
// Fidelity: the reveal path (spin effect → canvas animation → reveal → banner →
// point/bet masking) is the production code. Only the page's surroundings are
// stubbed — Clerk, the router, posthog, the socket, the audio helpers and the
// chrome components (nav bar, waiting takeover, result overlay, emote picker,
// creator mode, avatars) — none of which participate in the reveal.
//
// Run: node qa/roulette-reveal-check.mjs

import esbuild from "esbuild";
import { chromium } from "playwright";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// ── 1. Stubs for everything that is NOT the reveal path ────────────────────
// Every stub is a no-op shell. `Passthrough` keeps children mounted so layout
// wrappers can't hide the page.
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

// Modules inside the app that pull in things this check does not care about.
// Matched on the tail of the import path so relative specifiers keep working.
// Every default export is a Passthrough: these components may be wrappers, and
// a stub that swallowed children would hide the very table we assert on.
const APP_STUBS = new Map([
  ["components/navigation-bar", shell(`export default Passthrough;`)],
  ["components/IconAvatar", shell(`export default Passthrough;`)],
  ["components/ReportModal", shell(`export default Passthrough;`)],
  ["components/game/EmotePicker", shell(`export default Passthrough; export const EmoteArtwork = Passthrough;`)],
  // Creator mode wraps the whole game viewport in the real app.
  ["components/creator-mode/CreatorModeHost", shell(`export default Passthrough;`)],
  ["components/creator-mode/CreatorModeLayout", shell(`export const CreatorResponsiveLayout = Passthrough; export default Passthrough;`)],
  ["components/lobby/MatchWaiting", shell(`export default Passthrough;`)],
  ["components/result/PvpResultScreen", shell(`export default Passthrough;`)],
  // The page destructures `{ socket }`; a null socket disables the realtime
  // fanout, leaving the poll as the only trigger (which is what we time).
  ["context/SocketProvider", shell(`export const useSocket = () => ({ socket: null }); export const SocketProvider = Passthrough;`)],
  ["lib/gameAudio", shell(`export const playVictory = () => {}; export const playDefeat = () => {}; export const playTick = () => {}; export const playCardPlace = () => {};`)],
]);

const outDir = mkdtempSync(join(tmpdir(), "roulette-reveal-"));
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
        // Bare specifiers: next/*, @clerk/*, posthog-js/react.
        build.onResolve({ filter: /^next\/|^@clerk\/|^posthog-js\// }, (args) => ({
          path: args.path,
          namespace: "qa-bare",
        }));
        build.onLoad({ filter: /.*/, namespace: "qa-bare" }, (args) => {
          // `resolveDir` lets the stub bodies import "react" themselves.
          const js = (contents) => ({ contents, loader: "js", resolveDir: root });
          if (NEXT_STUBS[args.path]) return js(NEXT_STUBS[args.path]);
          if (args.path.startsWith("@clerk/")) return js(CLERK_STUB);
          if (args.path.startsWith("posthog-js/"))
            return js(shell(`export const usePostHog = () => null; export default {};`));
          return js(shell(`export default Null;`));
        });

        // App modules by path tail.
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

        // Next's static-asset imports (an object with `.src`).
        build.onLoad({ filter: /\.(png|jpe?g|webp|gif|svg)$/ }, () => ({
          contents: `export default { src: "/images/smalllogo.png", width: 612, height: 408 };`,
          loader: "js",
        }));
      },
    },
  ],
});

// ── 2. Tiny static server: the bundle + the app's real public assets ──────
const PUBLIC = join(root, "public");
const harnessJs = readFileSync(bundleOut, "utf8");
const pageHtml = `<!doctype html>
<html><head><meta charset="utf-8"><title>Roulette reveal check</title>
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

// Reads every place the winning number can surface on the in-match screen.
const readReveal = (winning) =>
  page.evaluate((win) => {
    const txt = (el) => (el ? el.textContent.replace(/\s+/g, " ").trim() : null);
    const spans = [...document.querySelectorAll("span")];

    // A grid tile owns its number as its FIRST text node (a staged bet chip is
    // appended after), so the label survives a bet badge landing on the tile.
    const ownLabel = (b) =>
      b.firstChild && b.firstChild.nodeType === 3
        ? b.firstChild.textContent.trim()
        : null;
    const highlighted = [...document.querySelectorAll("button")]
      .filter((b) => /ring-3/.test(b.className))
      .map((b) => ownLabel(b) ?? (b.textContent.match(/^\d+/) || [""])[0]);

    const stripLabel = spans.find((s) => txt(s) === "Last spin");
    const stripChip = txt(stripLabel ? stripLabel.nextElementSibling : null);

    const historyTitle = [...document.querySelectorAll("p")].find(
      (p) => txt(p) === "Round history",
    );
    const rows = historyTitle
      ? [...historyTitle.parentElement.querySelectorAll(".space-y-1 > div")]
      : [];

    const banners = [...document.querySelectorAll("div")].filter(
      (d) => txt(d)?.includes("· Spin:") && txt(d).length < 300,
    );

    const status = txt(
      spans.find((s) => /^(Spinning…|Last spin )/.test(txt(s) || "")),
    );

    return {
      spinning: /^Spinning…/.test(status || ""),
      status,
      highlighted,
      stripChip,
      historyRows: rows.length,
      lastRow: txt(rows[rows.length - 1]),
      bannerLine: banners.length ? txt(banners[banners.length - 1]) : null,
      bannerBlock: banners.length ? txt(banners[0]) : null,
      canvasPainted: document.querySelector("canvas")?.width === 420,
      gridTiles: document.querySelectorAll("button").length,
    };
  }, winning);

const pushRound = (payload) => page.evaluate((p) => window.__settleRound(p), payload);

const spinStatus = () =>
  page.waitForFunction(
    () => {
      const s = [...document.querySelectorAll("span")].find(
        (el) => el.textContent.replace(/\s+/g, " ").trim() === "Spinning…",
      );
      return Boolean(s);
    },
    null,
    { timeout: 20000 },
  );

const landing = (timeout = 20000) =>
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
    { timeout },
  );

// The masked history row must not hand over the result. `checkNumber` is off
// for the round whose CALL KEY equals the winning number: the key is the
// player's own input (they already know it), so those digits are legitimately
// on screen — it is the ✓/✗ outcome that would give the answer away.
const maskedRow = (row, number, { checkNumber = true } = {}) =>
  Boolean(row) &&
  row.includes("?") &&
  row.includes("···") &&
  !row.includes("✓") &&
  !row.includes("✗") &&
  (!checkNumber || !row.includes(String(number)));

try {
  const browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1280, height: 1800 } });
  page.on("pageerror", (err) => console.log("PAGE ERROR:", err.message));
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    // `<style jsx>` is Next's styled-jsx syntax and has no transform in this
    // harness, so React warns about the boolean `jsx` attribute. Expected.
    if (/non-boolean attribute/.test(msg.text())) return;
    console.log("CONSOLE ERROR:", msg.text());
  });

  await page.goto(base, { waitUntil: "networkidle" });
  // The status poll is mocked, so the table should appear on the first poll.
  await page.waitForFunction(() => document.querySelectorAll("button").length > 30, null, {
    timeout: 20000,
  });
  const mounted = await readReveal(0);
  check("the real match page mounts with the wheel + number grid", mounted.canvasPainted && mounted.gridTiles > 30, `tiles: ${mounted.gridTiles}`);
  check("nothing is revealed before the first resolution", !mounted.spinning && mounted.highlighted.length === 0 && mounted.bannerLine === null, mounted.status || "");

  // ── Round 1: hidden during the spin, revealed at landing ────────────────
  // The call is deliberately a DIFFERENT number from the winner, so the masked
  // row can be checked for the winning digits while still showing the player's
  // own call key.
  const N1 = 32;
  const CALL1 = 26;
  await pushRound({ number: N1, winner: "player1", call: CALL1 });
  await spinStatus();
  await page.waitForTimeout(1200);

  const spinning1 = await readReveal(N1);
  check("R1 spin: the wheel is actually spinning", spinning1.spinning, spinning1.status || "");
  check("R1 spin: NO grid tile is highlighted", spinning1.highlighted.length === 0, JSON.stringify(spinning1.highlighted));
  check("R1 spin: the 'Last spin' chip is masked", spinning1.stripChip === "?", `chip: ${spinning1.stripChip}`);
  check("R1 spin: the newest history row hides the number", maskedRow(spinning1.lastRow, N1), `row: ${spinning1.lastRow}`);
  check("R1 spin: the row still shows the player's own call key (their input, not the result)", (spinning1.lastRow || "").includes(`call ${CALL1}`), `row: ${spinning1.lastRow}`);
  check("R1 spin: the round-result banner is not up", spinning1.bannerLine === null, `banner: ${spinning1.bannerLine}`);

  // Locked ≠ dead (Step 5). While the wheel turns the betting controls must
  // still be genuinely disabled — the lock logic is untouched — but must NOT be
  // dimmed into looking inactive: a confirmed bet has to read as committed.
  const lockLook = await page.evaluate(() => {
    const own = (b) =>
      b.firstChild && b.firstChild.nodeType === 3
        ? b.firstChild.textContent.trim()
        : null;
    const tiles = [...document.querySelectorAll("button")].filter((b) =>
      /^\d+$/.test(own(b) || ""),
    );
    return {
      total: tiles.length,
      locked: tiles.filter((t) => t.disabled).length,
      dimmed: tiles.filter((t) => /opacity-([0-9]|[1-9][0-9])\b/.test(t.className))
        .length,
    };
  });
  check(
    "R1 spin: the betting controls are still genuinely disabled",
    lockLook.total > 30 && lockLook.locked === lockLook.total,
    `${lockLook.locked}/${lockLook.total} locked`,
  );
  check(
    "R1 spin: locked chips are not dimmed (locked, not inactive)",
    lockLook.dimmed === 0,
    `${lockLook.dimmed} dimmed tiles`,
  );

  await landing();
  await page.waitForTimeout(150);
  const landed1 = await readReveal(N1);
  check("R1 landing: the winning tile is highlighted", landed1.highlighted.includes(String(N1)), JSON.stringify(landed1.highlighted));
  check("R1 landing: the 'Last spin' chip shows the number", landed1.stripChip === String(N1), `chip: ${landed1.stripChip}`);
  check("R1 landing: the history row shows the number + the (missed) call outcome + the winner", landed1.lastRow.includes(String(N1)) && landed1.lastRow.includes("✗") && landed1.lastRow.includes("+you"), `row: ${landed1.lastRow}`);
  check("R1 landing: the banner follows with the result", (landed1.bannerLine || "").includes(`Spin: ${N1}`), `banner: ${landed1.bannerLine}`);
  check("R1 landing: the banner settles the round (post-round balances shown)", (landed1.bannerBlock || "").includes("1010"), `banner: ${landed1.bannerBlock}`);

  await page.waitForTimeout(2500);
  const held = await readReveal(N1);
  check("R1 +2.5 s: the highlight is still up (its clock starts at the reveal, not at spin start)", held.highlighted.includes(String(N1)), JSON.stringify(held.highlighted));

  await page.waitForTimeout(2200);
  const expired = await readReveal(N1);
  check("R1 +4.7 s: the highlight has expired", expired.highlighted.length === 0, JSON.stringify(expired.highlighted));
  check("R1 +4.7 s: the result stays readable in the strip + history", expired.stripChip === String(N1) && expired.lastRow.includes(String(N1)), `chip: ${expired.stripChip} row: ${expired.lastRow}`);
  // The banner's own timer (3 s) plus its exit transition must leave NOTHING
  // behind: AnimatePresence keeps an exiting node mounted for the length of the
  // exit, so a stalled exit would show up here as a ghost banner.
  check("R1 +4.7 s: the round-result banner has fully exited the DOM", expired.bannerLine === null, `banner: ${expired.bannerLine}`);

  // ── Round 2: the SAME number must spin and reveal again ────────────────
  // This time the call is CORRECT, which is the case where a leaked outcome
  // would hand over the number outright ("call 32 ✓" = the winner was 32).
  await pushRound({ number: N1, winner: "player2", call: N1 });
  await spinStatus();
  await page.waitForTimeout(1200);

  const spinning2 = await readReveal(N1);
  check("R2 (same number): the wheel spins again", spinning2.spinning, spinning2.status || "");
  check("R2 (same number): the previous highlight is cleared for the new spin", spinning2.highlighted.length === 0, JSON.stringify(spinning2.highlighted));
  check("R2 (same number): the 'Last spin' chip is masked again", spinning2.stripChip === "?", `chip: ${spinning2.stripChip}`);
  check("R2 (same number): a correct call's ✓ is hidden for the whole spin", maskedRow(spinning2.lastRow, N1, { checkNumber: false }), `row: ${spinning2.lastRow}`);

  await landing();
  await page.waitForTimeout(150);
  const landed2 = await readReveal(N1);
  check("R2 (same number): the same number is highlighted again at landing", landed2.highlighted.includes(String(N1)), JSON.stringify(landed2.highlighted));
  check("R2 (same number): the 'Last spin' chip shows it again", landed2.stripChip === String(N1), `chip: ${landed2.stripChip}`);
  check("R2 (same number): a fresh round banner reveals round 2", (landed2.bannerLine || "").includes("Round 2") && (landed2.bannerLine || "").includes(`Spin: ${N1}`), `banner: ${landed2.bannerLine}`);
  check("R2 (same number): the correct call's ✓ appears at landing", landed2.lastRow.includes("✓"), `row: ${landed2.lastRow}`);

  // ── Betting still works after a full reveal cycle ──────────────────────
  // The tile is located by its OWN label (first text node), so the chip badge
  // that appears after the click cannot change which element we find.
  const staged = await page.evaluate(() => {
    const ownLabel = (b) =>
      b.firstChild && b.firstChild.nodeType === 3
        ? b.firstChild.textContent.trim()
        : null;
    const tile = [...document.querySelectorAll("button")].find(
      (b) => ownLabel(b) === "7",
    );
    if (!tile) return { found: false, disabled: null };
    if (tile.disabled) return { found: true, disabled: true };
    tile.click();
    return { found: true, disabled: false };
  });
  await page.waitForTimeout(300);
  const afterBet = await page.evaluate(() => {
    const ownLabel = (b) =>
      b.firstChild && b.firstChild.nodeType === 3
        ? b.firstChild.textContent.trim()
        : null;
    const tile = [...document.querySelectorAll("button")].find(
      (b) => ownLabel(b) === "7",
    );
    return {
      text: tile?.textContent.replace(/\s+/g, " ").trim(),
      hasChip: Boolean(tile?.querySelector("span.absolute")),
    };
  });
  check("betting is unchanged: a tile click still stages a bet after the reveal", staged.found && !staged.disabled && afterBet.hasChip, `found: ${staged.found} disabled: ${staged.disabled} tile: ${afterBet.text}`);

  // ── Reduced motion ──────────────────────────────────────────────────────
  // globals.css collapses CSS animations under `prefers-reduced-motion`, but a
  // canvas `requestAnimationFrame` spin is invisible to CSS — so the page has to
  // short-circuit it itself. Under the preference the wheel is painted straight
  // into the server's final position and the normal reveal → banner → betting
  // lifecycle still runs, on a ~220 ms beat instead of a ~4.3 s physical spin.
  // `landing(1500)` can only pass if that short-circuit fired: a real spin
  // cannot reach its pocket that fast.
  const rmPage = await browser.newPage({
    viewport: { width: 1280, height: 1800 },
    reducedMotion: "reduce",
  });
  rmPage.on("pageerror", (err) => console.log("RM PAGE ERROR:", err.message));
  rmPage.on("console", (msg) => {
    if (msg.type() !== "error") return;
    if (/non-boolean attribute/.test(msg.text())) return;
    console.log("RM CONSOLE ERROR:", msg.text());
  });
  page = rmPage;

  await page.goto(base, { waitUntil: "networkidle" });
  await page.waitForFunction(() => document.querySelectorAll("button").length > 30, null, {
    timeout: 20000,
  });

  const RM_N = 8;
  await pushRound({ number: RM_N, winner: "player1", call: null });
  await spinStatus(); // the spin opened, exactly as it does with motion allowed
  const rmSpinStart = Date.now();
  let rmLanded = null;
  try {
    await landing(1500);
    rmLanded = await readReveal(RM_N);
  } catch {
    /* reported below */
  }
  const rmElapsed = Date.now() - rmSpinStart;
  check(
    "reduced motion: the wheel reaches the server's pocket without the physical spin",
    Boolean(rmLanded),
    `landed after ${rmElapsed} ms`,
  );
  check(
    "reduced motion: the result is still revealed exactly as usual",
    Boolean(rmLanded) &&
      rmLanded.highlighted.includes(String(RM_N)) &&
      rmLanded.stripChip === String(RM_N),
    rmLanded ? JSON.stringify(rmLanded.highlighted) : "never landed",
  );
  check(
    "reduced motion: the spin still ends (bets are not left locked)",
    Boolean(rmLanded) && !rmLanded.spinning,
    rmLanded?.status || "never landed",
  );

  const rmStaged = await page.evaluate(() => {
    const ownLabel = (b) =>
      b.firstChild && b.firstChild.nodeType === 3
        ? b.firstChild.textContent.trim()
        : null;
    const tile = [...document.querySelectorAll("button")].find(
      (b) => ownLabel(b) === "8",
    );
    if (!tile) return { found: false, disabled: null };
    if (tile.disabled) return { found: true, disabled: true };
    tile.click();
    return { found: true, disabled: false };
  });
  await page.waitForTimeout(300);
  const rmAfterBet = await page.evaluate(() => {
    const ownLabel = (b) =>
      b.firstChild && b.firstChild.nodeType === 3
        ? b.firstChild.textContent.trim()
        : null;
    const tile = [...document.querySelectorAll("button")].find(
      (b) => ownLabel(b) === "8",
    );
    return { hasChip: Boolean(tile?.querySelector("span.absolute")) };
  });
  check(
    "reduced motion: betting is re-opened after the reveal",
    rmStaged.found && !rmStaged.disabled && rmAfterBet.hasChip,
    `found: ${rmStaged.found} disabled: ${rmStaged.disabled} chip: ${rmAfterBet.hasChip}`,
  );

  await browser.close();
} catch (err) {
  // A timeout usually means the page never rendered — show what it did render.
  if (page) {
    const dump = await page
      .evaluate(() => (document.body ? document.body.innerHTML.slice(0, 1200) : "NO BODY"))
      .catch((e) => `EVAL FAILED: ${e.message}`);
    console.log(`PAGE HTML:\n${dump}\n`);
  }
  check("check ran to completion", false, err.message);
} finally {
  server.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
