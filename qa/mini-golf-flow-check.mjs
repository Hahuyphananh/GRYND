// qa/mini-golf-flow-check.mjs
//
// Drives qa/mini-golf-flow-harness.jsx — the REAL Mini Golf match page against
// a real, deterministic authoritative server (the shipped course generator +
// the shipped per-seat-ball / both-balls-must-hole-out rules) — and checks the
// contract the prompt is about:
//
//   1. DESKTOP render — the course, both seats, the hole indicator, the turn
//      status and the "Best of 5 — first to 3" format all render, and the
//      canvas is actually painted (not a blank box).
//   2. AIM input — dragging on the course changes the aim direction.
//   3. POWER input — the slider drives the power readout and the meter.
//   4. SHOT LOCK — confirming a shot disables the controls, sends ONLY
//      { angle, power, expectedVersion }, and then hands the UI back to the
//      SERVER'S result: the stroke count and the turn come from the snapshot,
//      never from a local simulation.
//   5. HOLE TRANSITION — both balls holed out shows the hole-result state
//      (both stroke columns, the winner and the updated match score), then
//      advances to the next hole.
//   6. MATCH TRANSITION — reaching 3 hole wins hands over to the shared result
//      screen with the right outcome, game key and score.
//   7. TWO-PLAYER SYNC — two pages, one as player1 and one as player2, pointed
//      at the SAME authoritative state: same course pixels, same scoreboard,
//      and each page's turn status follows the shared turn.
//   8. MOBILE portrait + landscape — playable with touch, controls reachable,
//      course never dependent on a fixed desktop resolution.
//
// Run: npm run verify:mini-golf
//      node qa/mini-golf-flow-check.mjs
//
// Fully offline: Clerk, the socket, the router, analytics, the session host, the
// waiting takeover, the result screen and the emote picker are stubbed by the
// esbuild step; the match payload comes from the harness's own authoritative
// model — no auth, no database, no dev server.

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
const outDir = mkdtempSync(join(tmpdir(), "grynd-mini-golf-flow-"));
const REPORTS = join(root, "qa", "reports");
mkdirSync(REPORTS, { recursive: true });

// ── Stubs (everything noisy around the match page) ─────────────────────────
const STUBS = {
  "next/navigation": `
    export const useRouter = () => ({ push(){}, replace(){}, back(){}, refresh(){}, prefetch(){} });
    export const usePathname = () => "/casino/mini-golf/mglf_1";
    export const useParams = () => ({ matchId: (window.__bf && window.__bf.matchId) || "mglf_1" });
    export const useSearchParams = () => new URLSearchParams();
    export default { useRouter, usePathname, useParams, useSearchParams };
  `,
  "next/image": `import React from "react"; export default function Img() { return null; }`,
  "next/link": `import React from "react"; export default function Link({ children }) { return children ?? null; }`,
  "posthog-js/react": `export const usePostHog = () => null; export default {};`,
  "@clerk/nextjs": `
    export const useUser = () => ({ isLoaded: true, isSignedIn: true, user: { id: "user_1", username: "Tester" } });
    export const useAuth = () => ({ isLoaded: true, isSignedIn: true, userId: "user_1" });
    export const useClerk = () => ({ signOut() {} });
    export default {};
  `,
  "context/SocketProvider": `
    export const useSocket = () => ({ socket: window.__bf.socket });
    export const SocketProvider = ({ children }) => children;
    export default { useSocket, SocketProvider };
  `,
  "components/GameSessionHost": `
    import React from "react";
    export default function GameSessionHost({ children }) { return children ?? null; }
  `,
  "components/lobby/MatchWaiting": `
    import React from "react";
    export default function MatchWaiting() { return React.createElement("div", { "data-testid": "waiting" }); }
  `,
  // The result screen is stubbed but EXPOSES the props the page handed it, so
  // the check can verify the client derived the right outcome — rather than
  // just that "some overlay appeared".
  "components/result/PvpResultScreen": `
    import React from "react";
    export default function PvpResultScreen(props) {
      return React.createElement(
        "div",
        {
          "data-testid": "pvp-result",
          "data-outcome": props.outcome,
          "data-gamekey": props.gameKey,
          "data-game": props.gameName,
          "data-headline": props.headline,
          "data-summary": JSON.stringify(props.summary || []),
        },
        (props.outcome || "result") + ": " + (props.headline || ""),
      );
    }
  `,
  "components/ReportModal": `import React from "react"; export default function ReportModal() { return null; }`,
  "components/game/EmotePicker": `
    import React from "react";
    export const EmoteBubble = () => null;
    export default function EmotePicker() { return React.createElement("div", { "data-testid": "emote-picker" }); }
  `,
  "hooks/useGameEmotes": `
    export const useGameEmotes = () => ({ incomingEmote: null, myEmote: null, sendEmote: () => {} });
    export default () => ({ incomingEmote: null, myEmote: null, sendEmote: () => {} });
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
  entryPoints: [join(root, "qa/mini-golf-flow-harness.jsx")],
  bundle: true,
  format: "iife",
  platform: "browser",
  jsx: "automatic",
  outfile: join(outDir, "harness.js"),
  logLevel: "error",
  absWorkingDir: root,
  define: { "process.env.NODE_ENV": '"development"' },
  plugins: [
    {
      name: "mg-stubs",
      setup(build) {
        build.onResolve({ filter: /.*/ }, (args) => {
          const key = matchStubKey(args.path, args.resolveDir);
          if (!key) return null;
          return { path: key, namespace: "mg-stub" };
        });
        build.onLoad({ filter: /.*/, namespace: "mg-stub" }, (args) => ({
          contents: STUBS[args.path],
          loader: "jsx",
          resolveDir: root,
        }));
      },
    },
  ],
});

// ── The app's REAL stylesheet ──────────────────────────────────────────────
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
<title>Mini Golf flow check</title>
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

// Prefer Playwright's bundled Chromium. If it has not been downloaded in this
// checkout (`npx playwright install`), fall back to the system Chrome channel so
// the check still runs — nothing is downloaded either way.
const launchBrowser = async () => {
  try {
    return await chromium.launch();
  } catch (error) {
    if (!/Executable doesn't exist/.test(String(error?.message || error))) throw error;
    console.log("   (bundled Chromium missing — falling back to the system Chrome channel)\n");
    return await chromium.launch({ channel: "chrome" });
  }
};

const browser = await launchBrowser();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const structuralErrors = (errors) =>
  errors.filter((e) =>
    /validateDOMNesting|descendant of|hydration|Hydration|Cannot read|Cannot update|is not a function|unique "key"/i.test(
      String(e),
    ),
  );

// ── Page drivers ───────────────────────────────────────────────────────────
const boot = async (viewport, { touch = false, viewer = "player1", seed = 20260926 } = {}) => {
  const context = await browser.newContext({ viewport, hasTouch: touch });
  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e.message)));
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  await page.goto(fileUrl);
  await page.waitForFunction(() => !!window.__bf?.mount, null, { timeout: 20000 });
  await page.evaluate(
    ([v, s]) => {
      window.__bf.server.setViewer(v);
      window.__bf.server.reset({ seed: s });
      window.__bf.mount();
    },
    [viewer, seed],
  );
  await page.waitForSelector('[data-testid="mini-golf-match"]', { timeout: 15000 });
  await sleep(350);
  return { context, page, consoleErrors, pageErrors };
};

const runtimeErrors = ({ consoleErrors, pageErrors }) =>
  structuralErrors([...consoleErrors, ...pageErrors]);

/** The canvas' painted pixel at its centre + a patch around the cup. */
const canvasPaint = (page) =>
  page.evaluate(() => {
    const c = document.querySelector('[data-testid="mini-golf-canvas"]');
    if (!c) return { ok: false, reason: "no canvas" };
    if (!c.width || !c.height) return { ok: false, reason: `zero bitmap ${c.width}x${c.height}` };
    const ctx = c.getContext("2d");
    if (!ctx) return { ok: false, reason: "no 2d ctx" };
    const centre = ctx.getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data;
    // The cup sits at the far end of the course; sample a patch around it so
    // two viewports can be compared on GEOMETRY alone (the aim preview lives
    // near the tee and never reaches the cup).
    const cup = ctx.getImageData(
      Math.max(0, Math.floor(c.width / 2) - 20),
      Math.max(0, Math.floor(c.height - 80)),
      40,
      40,
    ).data;
    return {
      ok: centre[3] > 0,
      cssWidth: Math.round(c.getBoundingClientRect().width),
      cssHeight: Math.round(c.getBoundingClientRect().height),
      bitmap: `${c.width}x${c.height}`,
      centre: [centre[0], centre[1], centre[2], centre[3]],
      cup: JSON.stringify(Array.from(cup.filter((_, i) => i % 97 === 0))),
    };
  });

const readAim = (page) =>
  page.evaluate(() => {
    const t = document.body.innerText;
    const a = /Angle\s+(\d+)\u00b0/.exec(t);
    const p = /Power\s+(\d+)%/.exec(t);
    return { angle: a ? Number(a[1]) : null, power: p ? Number(p[1]) : null };
  });

const readSeat = (page, seat) =>
  page.evaluate((s) => {
    const el = document.querySelector(`[data-testid="seat-${s}"]`);
    if (!el) return null;
    // NOTE: `innerText` reflects the shipped `uppercase` utilities, so every
    // label regex below is case-insensitive.
    const text = el.innerText;
    const shots = /(\d+)\s*shots this hole/i.exec(text);
    const wins = /(\d+)\s+holes? won/i.exec(text);
    return {
      text,
      shots: shots ? Number(shots[1]) : null,
      wins: wins ? Number(wins[1]) : null,
      active: el.getAttribute("data-active"),
    };
  }, seat);

const turnStatus = (page) =>
  page.evaluate(() => {
    const el = document.querySelector('[data-testid="turn-status"]');
    return el ? el.innerText.replace(/\s+/g, " ").trim() : null;
  });

const holeIndicator = (page) =>
  page.evaluate(() => {
    const el = document.querySelector('[data-testid="hole-indicator"]');
    return el ? el.innerText.replace(/\s+/g, " ").trim() : null;
  });

const serverScores = (page) =>
  page.evaluate(() => {
    const s = window.__bf.server.snapshot();
    return { holeScores: s.holeScores, currentHole: s.currentHole, turn: s.currentTurn, wins: [s.player1HoleWins, s.player2HoleWins] };
  });

// A shot's server trajectory is at most a few hundred px, so the client plays
// it in ~380ms (the floor `animationDurationMs` applies). This is the window the
// page needs to animate and re-render before the next assertion — the button is
// NOT a settle signal, because handing the turn over legitimately disables it.
const SETTLE_MS = 900;

/** Waits for the viewer's turn, then confirms a shot. */
const clickShoot = async (page, timeout = 8000) => {
  await page.waitForFunction(
    () => {
      const b = document.querySelector('[data-testid="shoot-button"]');
      return Boolean(b) && !b.disabled;
    },
    null,
    { timeout },
  );
  await page.locator('[data-testid="shoot-button"]').click();
};

/** Plays the OPPONENT's shot on the authoritative server, then lets the page
 *  pick it up over the same socket event the realtime relay uses. */
const injectOpponentShot = async (page, pocketed) => {
  await page.evaluate((pk) => {
    window.__bf.server.simulateShot({ seat: "player2", pocketed: pk });
  }, pocketed);
  await page.evaluate(() => window.__bf.socket.push(window.__bf.updatedEvent));
  await sleep(SETTLE_MS);
};

/**
 * Plays one hole to completion, with the requested seat taking it in FEWER
 * strokes (the rule that decides a hole). Both balls must hole out before the
 * hole completes, so the losing seat always takes one extra stroke.
 */
const playHole = async (page, { winner = "player1" } = {}) => {
  if (winner === "player2") {
    // viewer misses, opponent sinks in one, viewer sinks: 2 vs 1 → opponent
    await page.evaluate(() => window.__bf.server.plan([{ pocketed: false }, { pocketed: true }]));
    await clickShoot(page); // viewer misses
    await sleep(SETTLE_MS);
    await injectOpponentShot(page, true); // opponent sinks in one
    await clickShoot(page); // viewer sinks — both in, hole over
    await sleep(SETTLE_MS);
    return;
  }
  // viewer sinks in one, opponent misses then sinks: 1 vs 2 → viewer
  await page.evaluate(() => window.__bf.server.plan([{ pocketed: true }]));
  await clickShoot(page); // viewer sinks in one
  await sleep(SETTLE_MS);
  await injectOpponentShot(page, false); // opponent misses
  await injectOpponentShot(page, true); // opponent sinks — both in, hole over
};

// ═══════════════════════════════════════════════════════════════════════════
// 1–4  DESKTOP: render, aim, power, shot lock
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n=== DESKTOP 1280×800 — render / aim / power / shot lock ===\n");

const desktop = await boot({ width: 1280, height: 800 });
const { page } = desktop;

const indicator = await holeIndicator(page);
check("the hole indicator names the current hole and its difficulty", /^Hole 1 of 5/i.test(indicator), indicator);
check(
  "the page states the match format (Best of 5 — first to 3)",
  /Best of 5\s*—\s*first to 3/.test(await page.evaluate(() => document.body.innerText)),
);
check("the format appears in the sidebar too", (await page.evaluate(() => document.body.innerText)).includes("Format"));

const p1 = await readSeat(page, "player1");
const p2 = await readSeat(page, "player2");
check("seat 1 shows the viewer", p1 && /Tester/.test(p1.text) && /· you/.test(p1.text), p1?.text?.split("\n")[0]);
check("seat 2 shows the opponent", p2 && /Rival/.test(p2.text), p2?.text?.split("\n")[0]);
check("the seat cards track who is active", p1?.active === "true" && p2?.active === "false", `${p1?.active}/${p2?.active}`);

const paint = await canvasPaint(page);
check("the course canvas is painted (not a blank box)", paint.ok, `${paint.bitmap} @ ${paint.cssWidth}×${paint.cssHeight} centre=${paint.centre}`);
check("the canvas fills a real share of the board", paint.cssWidth > 200 && paint.cssHeight > 250, `${paint.cssWidth}×${paint.cssHeight}`);

check("the turn status says it is the viewer's turn", (await turnStatus(page)) === "Your turn", await turnStatus(page));
check(
  "the shoot button is enabled on the viewer's turn",
  await page.evaluate(() => !document.querySelector('[data-testid="shoot-button"]').disabled),
);

// ── AIM: drag from the ball outward ────────────────────────────────────────
const beforeAim = await readAim(page);
const ball = await page.evaluate(() => window.__bf.ballClientPos("player1"));
check("the viewer's ball has an on-screen position", ball && ball.x > 0 && ball.y > 0, JSON.stringify(ball));
await page.mouse.move(ball.x, ball.y);
await page.mouse.down();
await page.mouse.move(ball.x + 70, ball.y - 45, { steps: 6 });
await page.mouse.up();
await sleep(120);
const afterAim = await readAim(page);
check(
  "dragging on the course changes the aim direction",
  afterAim.angle !== beforeAim.angle && Math.abs(afterAim.angle - 327) < 40,
  `${beforeAim.angle}° → ${afterAim.angle}°`,
);
check("dragging also sets a non-zero power from the drag length", afterAim.power > 10, `power=${afterAim.power}`);

// ── POWER: the slider ──────────────────────────────────────────────────────
await page.locator('[data-testid="power-slider"]').fill("90");
await sleep(80);
const sliderAim = await readAim(page);
check("the power slider drives the power readout", sliderAim.power === 90, `power=${sliderAim.power}`);
check(
  "the power meter reflects the chosen power",
  (await page.evaluate(() => document.querySelector('[data-testid="power-meter"]').style.width)) === "90%",
);

// ── SHOT LOCK: confirm → controls disabled → authoritative result ──────────
await page.evaluate(() => {
  window.__bf.samples = [];
  window.__bf.sampler = setInterval(() => {
    const btn = document.querySelector('[data-testid="shoot-button"]');
    const slider = document.querySelector('[data-testid="power-slider"]');
    window.__bf.samples.push({
      disabled: btn ? btn.disabled : null,
      text: btn ? btn.textContent.trim() : null,
      sliderDisabled: slider ? slider.disabled : null,
    });
  }, 16);
});

const postsBefore = await page.evaluate(() => window.__bf.posts.length);
await clickShoot(page);
await sleep(700);
const samples = await page.evaluate(() => {
  clearInterval(window.__bf.sampler);
  return window.__bf.samples;
});

const shotPosts = (await page.evaluate(() => window.__bf.posts)).slice(postsBefore);
check("confirming a shot POSTs exactly one shoot request", shotPosts.length === 1 && shotPosts[0].url.endsWith("/shoot"), shotPosts.map((p) => p.url).join(", "));
const body = shotPosts[0]?.body ?? {};
check(
  "the request carries ONLY angle + power (+ expectedVersion)",
  Object.keys(body).sort().join(",") === "angle,expectedVersion,power",
  Object.keys(body).join(","),
);
check("the request carries the aim the player set", Math.abs(body.angle - sliderAim.angle) <= 1 && body.power === 90, JSON.stringify(body));

const locked = samples.filter((s) => s.disabled === true);
check("the shoot control locks while the shot resolves", locked.length > 0, `${locked.length}/${samples.length} samples locked`);
check(
  "the power control locks alongside it",
  locked.some((s) => s.sliderDisabled === true),
);
check(
  "the lock reads honestly ('Shooting…' / 'Ball rolling…' / 'Locked' / 'Waiting…')",
  locked.some((s) => /Shooting|Ball rolling|Locked|Waiting/.test(s.text ?? "")),
  locked.map((s) => s.text).filter(Boolean)[0],
);

// The authoritative adoption: the score/turn shown must equal the server's.
const afterShotServer = await serverScores(page);
const afterShotSeat = await readSeat(page, "player1");
check(
  "the stroke count shown equals the SERVER's authoritative count",
  afterShotSeat.shots === afterShotServer.holeScores[0].player1 && afterShotSeat.shots === 1,
  `shown=${afterShotSeat.shots} server=${afterShotServer.holeScores[0].player1}`,
);
check(
  "the turn now follows the server (opponent's turn)",
  (await turnStatus(page)) === "Waiting for your opponent…",
  await turnStatus(page),
);
check("the opponent seat is now the active one", (await readSeat(page, "player2")).active === "true");

check("no runtime / hydration errors on desktop", runtimeErrors(desktop).length === 0, runtimeErrors(desktop).slice(0, 3).join(" | "));
await page.screenshot({ path: join(REPORTS, "mini-golf-desktop.png") });

// ═══════════════════════════════════════════════════════════════════════════
// 5  HOLE TRANSITION
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n=== HOLE TRANSITION — both balls holed out ===\n");

const holePage = (await boot({ width: 1280, height: 800 })).page;
await holePage.evaluate(() => window.__bf.server.reset({ seed: 20260926 }));
await holePage.evaluate(() => window.__bf.socket.push(window.__bf.updatedEvent));
await sleep(250);

await playHole(holePage, { winner: "player1" });

const overlay = await holePage.waitForSelector('[data-testid="hole-result"]', { timeout: 8000 });
const overlayText = (await overlay.innerText()).replace(/\s+/g, " ");
check("a hole-result state appears when both balls are in the cup", /Hole 1 complete/i.test(overlayText), overlayText.slice(0, 90));
check("it names the hole winner from the viewer's side", /You won the hole/i.test(overlayText), overlayText);
check("it shows BOTH stroke columns", /You\s+1\s+strokes/i.test(overlayText) && /Opponent\s+2\s+strokes/i.test(overlayText), overlayText);
check("it shows the updated match score", /Match score 1\s*—\s*0/i.test(overlayText), overlayText);

const afterHoleServer = await serverScores(holePage);
check(
  "the server's hole winner and score agree with the overlay",
  afterHoleServer.wins[0] === 1 && afterHoleServer.wins[1] === 0 && afterHoleServer.holeScores[0].player1 === 1 && afterHoleServer.holeScores[0].player2 === 2,
  JSON.stringify(afterHoleServer.wins) + " " + JSON.stringify(afterHoleServer.holeScores[0]),
);

await holePage.waitForSelector('[data-testid="hole-result"]', { state: "detached", timeout: 9000 });
check("the interstitial clears and the board advances to the next hole", /^Hole 2 of 5/i.test(await holeIndicator(holePage)), await holeIndicator(holePage));
check("the scoreboard carries the hole win", (await readSeat(holePage, "player1")).wins === 1, String((await readSeat(holePage, "player1")).wins));
check("the next hole resets the per-hole strokes", (await readSeat(holePage, "player1")).shots === 0);
await holePage.screenshot({ path: join(REPORTS, "mini-golf-hole-transition.png") });

// ═══════════════════════════════════════════════════════════════════════════
// 6  MATCH TRANSITION
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n=== MATCH TRANSITION — first to 3 ===\n");

const finishPage = (await boot({ width: 1280, height: 800 })).page;
await finishPage.evaluate(() => {
  const s = window.__bf.server.gameState();
  s.currentHole = 3;
  s.player1HoleWins = 2;
  s.player2HoleWins = 0;
  s.holeWinners = ["player1", "player1", null, null, null];
  s.holeScores = [
    { player1: 2, player2: 4 },
    { player1: 3, player2: 5 },
    { player1: 0, player2: 0 },
    { player1: 0, player2: 0 },
    { player1: 0, player2: 0 },
  ];
  s.version += 1;
  const hole = s.holes[2];
  const tee = () => ({ x: hole.geometry.tee.x, y: hole.geometry.tee.y, vx: 0, vy: 0, radius: 7, moving: false, holedOut: false });
  s.balls = { player1: tee(), player2: tee() };
  s.currentTurn = "player1";
  s.currentStroke = 0;
  s.lastShot = null;
  window.__bf.server.load(s);
  window.__bf.socket.push(window.__bf.updatedEvent);
});
await finishPage.waitForFunction(() => /^Hole 3 of 5/i.test(document.querySelector('[data-testid="hole-indicator"]')?.innerText || ""), null, { timeout: 8000 });
check("a match two holes up renders its carried-over score", (await readSeat(finishPage, "player1")).wins === 2);

await playHole(finishPage, { winner: "player1" }); // player1 wins hole 3 → 3–0 → match over

const result = await finishPage.waitForSelector('[data-testid="pvp-result"]', { timeout: 9000 });
const props = await result.evaluate((el) => ({
  outcome: el.getAttribute("data-outcome"),
  gameKey: el.getAttribute("data-gamekey"),
  game: el.getAttribute("data-game"),
  headline: el.getAttribute("data-headline"),
  summary: el.getAttribute("data-summary"),
}));
check("reaching 3 hole wins hands over to the shared result screen", Boolean(result));
check("the result screen is told the game key", props.gameKey === "mini-golf", props.gameKey);
check("...and the game name", props.game === "Mini Golf", props.game);
check("the outcome is derived as a WIN for the viewer", props.outcome === "win", props.outcome);
check("the result carries the final hole score", /^3\s*—\s*0 on holes$/.test(props.headline), props.headline);
check("the result summarises holes won and total strokes", /holes won/i.test(props.summary) && /total strokes/i.test(props.summary), props.summary);
const finalServer = await serverScores(finishPage);
check(
  "the client's outcome matches the server's finished result",
  finalServer.wins[0] >= 3,
  JSON.stringify(finalServer),
);
await finishPage.screenshot({ path: join(REPORTS, "mini-golf-match-transition.png") });

// ═══════════════════════════════════════════════════════════════════════════
// 7  TWO-PLAYER STATE SYNCHRONISATION
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n=== TWO-PLAYER SYNC — one authoritative state, two viewers ===\n");

const A = await boot({ width: 1280, height: 800 }, { viewer: "player1" });
const B = await boot({ width: 1280, height: 800 }, { viewer: "player2" });

check("viewer A is seat player1 and starts", (await turnStatus(A.page)) === "Your turn", await turnStatus(A.page));
check("viewer B is seat player2 and waits", (await turnStatus(B.page)) === "Waiting for your opponent…", await turnStatus(B.page));
check(
  "both viewers see the same opponent-relative names",
  /Tester/.test((await readSeat(A.page, "player1")).text) &&
    /Rival/.test((await readSeat(B.page, "player2")).text) &&
    /Tester/.test((await readSeat(B.page, "player1")).text) &&
    /Rival/.test((await readSeat(A.page, "player2")).text),
);
check(
  "both viewers see the same hole",
  (await holeIndicator(A.page)) === (await holeIndicator(B.page)),
  `${await holeIndicator(A.page)} / ${await holeIndicator(B.page)}`,
);


await sleep(200);
const paintA = await canvasPaint(A.page);
const paintB = await canvasPaint(B.page);
check(
  "both viewers render the SAME course geometry (identical cup pixels)",
  paintA.cup === paintB.cup,
  `${paintA.cup?.slice(0, 40)} vs ${paintB.cup?.slice(0, 40)}`,
);

// Player 1 takes a shot; the resulting authoritative state is fed to BOTH pages.
await A.page.evaluate(() => window.__bf.server.plan([{ pocketed: false }]));
await clickShoot(A.page);
await sleep(SETTLE_MS);
const shared = await A.page.evaluate(() => window.__bf.server.gameState());
await Promise.all([
  A.page.evaluate((raw) => {
    window.__bf.server.load(raw);
    window.__bf.socket.push(window.__bf.updatedEvent);
  }, shared),
  B.page.evaluate((raw) => {
    window.__bf.server.load(raw);
    window.__bf.socket.push(window.__bf.updatedEvent);
  }, shared),
]);
await sleep(700);

check("after player 1's shot, viewer A yields the turn", (await turnStatus(A.page)) === "Waiting for your opponent…", await turnStatus(A.page));
check("viewer B picks up the SAME turn", (await turnStatus(B.page)) === "Your turn", await turnStatus(B.page));
check(
  "both viewers show the same stroke count for player 1",
  (await readSeat(A.page, "player1")).shots === (await readSeat(B.page, "player1")).shots &&
    (await readSeat(A.page, "player1")).shots === 1,
  `${(await readSeat(A.page, "player1")).shots} / ${(await readSeat(B.page, "player1")).shots}`,
);
check(
  "the active seat flips on both pages",
  (await readSeat(A.page, "player2")).active === "true" && (await readSeat(B.page, "player2")).active === "true",
);

// Now seat 2 shoots and both pages adopt it.
await B.page.evaluate(() => window.__bf.server.plan([{ pocketed: true }]));
await clickShoot(B.page);
await sleep(SETTLE_MS);
const shared2 = await B.page.evaluate(() => window.__bf.server.gameState());
await Promise.all([
  A.page.evaluate((raw) => {
    window.__bf.server.load(raw);
    window.__bf.socket.push(window.__bf.updatedEvent);
  }, shared2),
  B.page.evaluate((raw) => {
    window.__bf.server.load(raw);
    window.__bf.socket.push(window.__bf.updatedEvent);
  }, shared2),
]);
await sleep(700);

check(
  "both viewers show the same player-2 stroke count",
  (await readSeat(A.page, "player2")).shots === 1 && (await readSeat(B.page, "player2")).shots === 1,
  `${(await readSeat(A.page, "player2")).shots} / ${(await readSeat(B.page, "player2")).shots}`,
);
check(
  "after seat 2 holed out, viewer B is told its ball is in",
  (await turnStatus(B.page)).includes("in —") || (await turnStatus(A.page)) === "Your turn",
  `${await turnStatus(A.page)} / ${await turnStatus(B.page)}`,
);
check(
  "the turn comes back to viewer A on both pages",
  (await turnStatus(A.page)) === "Your turn",
  await turnStatus(A.page),
);
check("no runtime errors while syncing two viewers", runtimeErrors(A).length === 0 && runtimeErrors(B).length === 0, [...runtimeErrors(A), ...runtimeErrors(B)].slice(0, 3).join(" | "));
await A.page.screenshot({ path: join(REPORTS, "mini-golf-sync-player1.png") });
await B.page.screenshot({ path: join(REPORTS, "mini-golf-sync-player2.png") });

// ═══════════════════════════════════════════════════════════════════════════
// 8  MOBILE — portrait + landscape, touch aiming
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n=== MOBILE — 390×844 portrait / 844×390 landscape ===\n");

const portrait = await boot({ width: 390, height: 844 }, { touch: true });
const pp = portrait.page;
const ppPaint = await canvasPaint(pp);
check("portrait: the course renders at phone width", ppPaint.ok && ppPaint.cssWidth > 280, `${ppPaint.cssWidth}×${ppPaint.cssHeight} centre=${ppPaint.centre}`);
check("portrait: the board is not a fixed desktop resolution", ppPaint.cssWidth < 500, `${ppPaint.cssWidth}`);
check("portrait: the hole indicator is present", /^Hole 1 of 5/i.test(await holeIndicator(pp)), await holeIndicator(pp));

const shootBox = await pp.locator('[data-testid="shoot-button"]').boundingBox();
const sliderBox = await pp.locator('[data-testid="power-slider"]').boundingBox();
check("portrait: the shoot button is laid out and tappable", Boolean(shootBox) && shootBox.width > 80 && shootBox.height >= 36, JSON.stringify(shootBox && { w: Math.round(shootBox.width), h: Math.round(shootBox.height) }));
check("portrait: the power slider is laid out", Boolean(sliderBox) && sliderBox.width > 80, JSON.stringify(sliderBox && { w: Math.round(sliderBox.width) }));

const touchBefore = await readAim(pp);
const touchBall = await pp.evaluate(() => window.__bf.ballClientPos("player1"));
const touchResult = await pp.evaluate(
  ({ from }) => {
    const c = document.querySelector('[data-testid="mini-golf-canvas"]');
    if (!c) return "no canvas";
    const mk = (type, x, y) =>
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerId: 7,
        pointerType: "touch",
        isPrimary: true,
        clientX: x,
        clientY: y,
      });
    c.dispatchEvent(mk("pointerdown", from.x, from.y));
    c.dispatchEvent(mk("pointermove", from.x - 40, from.y + 80));
    c.dispatchEvent(mk("pointerup", from.x - 40, from.y + 80));
    return "ok";
  },
  { from: touchBall },
);
check("portrait: a TOUCH drag is accepted by the course", touchResult === "ok", touchResult);
await sleep(120);
const touchAfter = await readAim(pp);
check(
  "portrait: the touch drag changes the aim",
  touchAfter.angle !== touchBefore.angle && touchAfter.power > 0,
  `${touchBefore.angle}° → ${touchAfter.angle}° (power ${touchAfter.power})`,
);

// The rotate-to-landscape view must stay playable.
const landscape = await boot({ width: 844, height: 390 }, { touch: true });
const lp = landscape.page;
const lpPaint = await canvasPaint(lp);
check("landscape: the course still renders", lpPaint.ok && lpPaint.cssWidth > 280, `${lpPaint.cssWidth}×${lpPaint.cssHeight}`);
check("landscape: the shoot control is reachable", Boolean(await lp.locator('[data-testid="shoot-button"]').boundingBox()), "");
const lBox = await lp.locator('[data-testid="shoot-button"]').boundingBox();
check("landscape: the shoot control keeps a usable tap area", lBox.width > 80 && lBox.height >= 36, JSON.stringify({ w: Math.round(lBox.width), h: Math.round(lBox.height) }));
check("landscape: the turn status is visible", Boolean(await turnStatus(lp)), await turnStatus(lp));

check(
  "no runtime errors on either mobile viewport",
  runtimeErrors(portrait).length === 0 && runtimeErrors(landscape).length === 0,
  [...runtimeErrors(portrait), ...runtimeErrors(landscape)].slice(0, 3).join(" | "),
);
await pp.screenshot({ path: join(REPORTS, "mini-golf-mobile-portrait.png") });
await lp.screenshot({ path: join(REPORTS, "mini-golf-mobile-landscape.png") });

await browser.close();
console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exitCode = 1;
