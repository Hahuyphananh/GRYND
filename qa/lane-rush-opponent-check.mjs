// qa/lane-rush-opponent-check.mjs
//
// Drives qa/lane-rush-opponent-harness.jsx — the REAL Lane Rush race match
// page with a scripted RACE payload — and reports what the page actually
// renders and sends:
//
//   1. the oval board renders with the three route lanes and the 1,000 target;
//   2. the HUD shows the confirmed scores, the round and the planning clock;
//   3. the garage shows the fleet, action points and resources the server sent;
//   4. deploying a car posts the authoritative engine action (carId + route);
//   5. buying posts a `buy` action, never a client score;
//   6. locking in posts `lockIn` and the locked payload renders as locked;
//   7. a confirmed round is replayed from `lastResult` (score + round summary);
//   8. re-delivering the same payload never replays the round or re-sounds it;
//   9. a finished race mounts the shared result screen exactly once;
//  10. a legacy (game_state_version 0) row shows the retired-board notice and
//      never racing controls;
//  11. the portrait viewport renders the board without horizontal overflow;
//  12. no React nesting / hydration / runtime error surfaces anywhere.
//
// It also writes the match-page screenshots used for visual review:
//   qa/reports/lane-rush-race-match.png
//   qa/reports/lane-rush-race-portrait.png
//
// Run: npm run verify:lane-rush-opponent
//      node qa/lane-rush-opponent-check.mjs
//
// Fully offline: Clerk, the socket, the router, analytics, nav/footer, the
// waiting takeover, the practice pause hook and the result screen shell are
// stubbed by the esbuild step; the match payload comes from a stubbed `fetch`,
// so this is a MOCKED race match — no auth, no database, no dev server.

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
const outDir = mkdtempSync(join(tmpdir(), "lane-rush-race-"));
const REPORTS = join(root, "qa", "reports");
mkdirSync(REPORTS, { recursive: true });

// ── Stubs (everything noisy around the match page) ─────────────────────────
const STUBS = {
  "next/navigation": `
    const record = (href) => { (window.__lr = window.__lr || {}).nav = ((window.__lr && window.__lr.nav) || []).concat([href]); };
    export const useRouter = () => ({ push: record, replace: record, back(){}, refresh(){}, prefetch(){} });
    export const usePathname = () => "/casino/lane-runner/4242";
    export const useSearchParams = () => new URLSearchParams();
    export default { useRouter, usePathname, useSearchParams };
  `,
  "next/image": `import React from "react"; export default function Img() { return null; }`,
  "next/link": `
    import React from "react";
    export default function Link({ children, href }) {
      return React.createElement("a", { href }, children);
    }
  `,
  "posthog-js/react": `export const usePostHog = () => null; export default {};`,
  "@clerk/nextjs": `
    export const useUser = () => ({ isLoaded: true, isSignedIn: true, user: { id: "user_1", username: "Tester" } });
    export const useAuth = () => ({ isLoaded: true, isSignedIn: true, userId: "user_1" });
    export const useClerk = () => ({ signOut() {} });
  `,
  // `lib/lane-rush-duel/constants.js` imports node's crypto at module scope.
  crypto: `
    const zeros = (n) => "0".repeat(n);
    const createHash = () => { const h = { update: () => h, digest: (enc) => (enc === "hex" ? zeros(64) : zeros(32)) }; return h; };
    const randomBytes = (n) => ({ toString: () => zeros(n * 2) });
    export default { createHash, randomBytes };
    export { createHash, randomBytes };
  `,
  // The REAL provider hands back the context value (`{ socket, userId }`), never
  // the socket itself. Mirroring that shape is what lets this harness catch a
  // page that binds the whole value: the stub used to return the socket, so
  // `const socket = useSocket()` looked healthy here and only threw in the app.
  "context/SocketProvider": `
    export const useSocket = () => ({ socket: window.__lr?.socket ?? null, userId: "user_1" });
    export const SocketProvider = ({ children }) => children;
    export default { useSocket, SocketProvider };
  `,
  "components/navigation-bar": `export default function Nav() { return null; }`,
  "components/Footer": `export default function Footer() { return null; }`,
  "components/FrameAvatar": `export default function FrameAvatar() { return null; }`,
  "lib/profileCosmetics": `
    export const cosmeticEffectClass = () => "";
    export default { cosmeticEffectClass };
  `,
  "components/GameSessionHost": `
    import React from "react";
    export default function Host({ children }) { return children ?? null; }
  `,
  "components/lobby/MatchWaiting": `
    import React from "react";
    export default function MatchWaiting() { return React.createElement("div", { "data-testid": "waiting" }); }
  `,
  "components/result/PvpResultScreen": `
    import React from "react";
    export default function PvpResultScreen(props) {
      if (!props?.open) return null;
      return React.createElement(
        "div",
        { "data-testid": "result-screen", "data-outcome": props.outcome },
        React.createElement("p", { "data-testid": "result-headline" }, props.headline),
        ...(props.sides || []).map((side, i) =>
          React.createElement("span", { key: i, "data-testid": "result-side" }, \`\${side.name} \${side.score}\`),
        ),
      );
    }
  `,
  "components/game/PracticePause": `
    import React from "react";
    export const PracticePauseChip = () => null;
    export const PracticePauseOverlay = () => null;
  `,
  "hooks/usePracticePause": `
    export const usePracticePause = () => ({
      paused: false,
      busy: false,
      canPause: false,
      toggle: async () => {},
    });
    export default usePracticePause;
  `,
  "hooks/useMatchSync": `export const useMatchSync = () => {}; export default useMatchSync;`,
  "hooks/useDeadlineRead": `export const useDeadlineRead = () => {}; export default useDeadlineRead;`,
  "hooks/useServerClockEstimate": `
    export const useServerClockEstimate = () => () => Date.now();
    export default useServerClockEstimate;
  `,
  "lib/gameAudio": `
    const rec = (name) => {
      const w = (window.__lr = window.__lr || { cues: [] });
      if (!w.cues) w.cues = [];
      w.cues.push(name);
    };
    export const playCardPlace = () => rec("playCardPlace");
    export const playVictory = () => rec("playVictory");
    export const playDefeat = () => rec("playDefeat");
    export const playTick = () => rec("playTick");
    export const playCrash = () => rec("playCrash");
    export const playGoodReveal = () => rec("playGoodReveal");
    export const playOpponentPick = () => rec("playOpponentPick");
    export const playSelect = () => rec("playSelect");
    export const playSafePick = () => rec("playSafePick");
    export const playBank = () => rec("playBank");
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
  entryPoints: [join(root, "qa/lane-rush-opponent-harness.jsx")],
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
      name: "lr-stubs",
      setup(build) {
        build.onResolve({ filter: /.*/ }, (args) => {
          const key = matchStubKey(args.path, args.resolveDir);
          if (!key) return null;
          return { path: key, namespace: "lr-stub" };
        });
        build.onLoad({ filter: /.*/, namespace: "lr-stub" }, (args) => ({
          contents: STUBS[args.path],
          loader: "jsx",
          resolveDir: root,
        }));
      },
    },
  ],
});

// ── The app's REAL stylesheet (shipped Tailwind utilities) ─────────────────
const compiled = await postcss([
  tailwindcss(join(root, "tailwind.config.js")),
  autoprefixer(),
]).process(readFileSync(join(root, "src/app/globals.css"), "utf8"), {
  from: join(root, "src/app/globals.css"),
});
const appCss = compiled.css.replace(/@import\s+url\(["']?https?:\/\/[^)]*\);?/g, "");
writeFileSync(join(outDir, "app.css"), appCss);
console.log(`compiled stylesheet: ${(appCss.length / 1024).toFixed(0)}KB\n`);

writeFileSync(
  join(outDir, "index.html"),
  `<!doctype html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Lane Rush race check</title>
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

// Chromium's default locale can format thousands with U+202F. Normalize the
// whitespace AND the grouping separator so assertions read the same numbers a
// user does, whatever the runner's locale is.
const normalize = (value) =>
  value
    .replace(/\s+/g, " ")
    .replace(/[\u202f\u00a0]/g, " ")
    .replace(/(\d) (?=\d{3}\b)/g, "$1,")
    .trim();
const text = (page, sel) =>
  page.evaluate((s) => document.querySelector(s)?.textContent ?? null, sel).then(
    (value) => (value === null ? null : normalize(value)),
  );
const count = (page, sel) =>
  page.$$eval(sel, (els) => els.length).catch(() => 0);
const bodyText = (page) =>
  page.evaluate(() => document.body.innerText).then((value) => normalize(value));

const bootPage = async (viewport, contextOpts = {}) => {
  const context = await browser.newContext({ viewport, ...contextOpts });
  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e.message)));
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  await page.goto(fileUrl, { waitUntil: "networkidle" });
  await page.waitForFunction(() => !!window.__lr?.mount, null, { timeout: 20000 });
  return { context, page, consoleErrors, pageErrors };
};

const structuralErrors = (errors) =>
  errors.filter((e) =>
    /validateDOMNesting|descendant of|hydration|Hydration|Cannot read|Cannot update|is not a function|unique "key"/i.test(
      e,
    ),
  );

// ═══════════════════════════════════════════════════════════════════════════
// DESKTOP — the oval, the early-planning fleet, a resolved round, the result
// ═══════════════════════════════════════════════════════════════════════════
const { page, consoleErrors, pageErrors } = await bootPage({
  width: 1280,
  height: 1000,
});

await page.evaluate(() => {
  window.__lr.set();
  window.__lr.mount();
});
await page.waitForSelector('[data-testid="lane-runner-phase"]', { timeout: 10000 });
await page.waitForSelector('[data-testid="lane-runner-clock"]', { timeout: 5000 });
await page.waitForTimeout(400);

// 1. The oval board and its three route lanes.
check(
  "the oval race board renders",
  (await count(page, 'svg[role="img"][aria-label^="Oval racetrack"]')) === 1,
);
const hud = await bodyText(page);
check(
  "the 1,000-point target is named",
  /First to 1,000/i.test(hud),
);
check(
  "all three route lanes are described with their risk",
  /safe circuit/i.test(hud) && /sprint lane/i.test(hud) && /risk route/i.test(hud),
  hud.match(/safe circuit.*?risk route/i)?.[0]?.slice(0, 120) ?? "",
);

// 2. HUD scores come from the server payload.
check(
  "the scoreboard shows the confirmed scores",
  (await text(page, '[data-testid="lane-runner-score-player1"]')) === "18" &&
    (await text(page, '[data-testid="lane-runner-score-player2"]')) === "0",
  `${await text(page, '[data-testid="lane-runner-score-player1"]')} / ${await text(page, '[data-testid="lane-runner-score-player2"]')}`,
);
check(
  "the round and phase come from the server",
  (await text(page, '[data-testid="lane-runner-phase"]'))?.startsWith("Round 2") === true,
  await text(page, '[data-testid="lane-runner-phase"]'),
);
check(
  "the planning clock is rendered from the server deadline",
  /^0:4\d$/.test((await text(page, '[data-testid="lane-runner-clock"]')) ?? ""),
  await text(page, '[data-testid="lane-runner-clock"]'),
);

// 3. The garage is the server's fleet + economy, not a client guess.
const fleet = await text(page, '[aria-label="Your fleet"]');
check(
  "the fleet shows the owned/racing counts",
  /3\/8 cars · 0\/4 racing/.test(fleet ?? ""),
  fleet?.slice(0, 80) ?? "",
);
check(
  "action points and resources come from the server",
  /2 of 2 action points/.test(hud) && /2 AP/.test(fleet ?? "") && /4 Scrap/.test(fleet ?? ""),
);

await page.screenshot({
  path: join(REPORTS, "lane-rush-race-match.png"),
  fullPage: true,
});
console.log(`\nscreenshot: ${join(REPORTS, "lane-rush-race-match.png")}`);

// A fresh mount must not replay the already-resolved round.
check(
  "a reconnect paints the confirmed state without replaying a round",
  (await count(page, '[data-testid="lane-runner-last-round"]')) === 1 &&
    (await page.evaluate(() => (window.__lr.cues || []).length)) === 0,
  `cues=${await page.evaluate(() => (window.__lr.cues || []).length)}`,
);

// 4. Deploying a car posts the engine action with the picked route.
await page
  .locator('[aria-label="Your fleet"] button', { hasText: "Safe" })
  .first()
  .click();
await page.waitForTimeout(250);
const deployPost = await page.evaluate(() => window.__lr.posts.at(-1) || null);
check(
  "deploying posts the authoritative deploy action",
  deployPost?.body?.actions?.length === 1 &&
    deployPost.body.actions[0].type === "deploy" &&
    deployPost.body.actions[0].route === "safe" &&
    typeof deployPost.body.actions[0].carId === "string",
  JSON.stringify(deployPost?.body?.actions?.[0] ?? null),
);
check(
  "the posted plan carries the server round and state version",
  deployPost?.body?.round === 2 && deployPost?.body?.stateVersion === 1,
  `round=${deployPost?.body?.round} v=${deployPost?.body?.stateVersion}`,
);

// 5. Buying is an engine action, never a client-side resource change.
await page.click('[data-testid="lane-runner-buy"]');
await page.waitForTimeout(250);
const buyPost = await page.evaluate(() => window.__lr.posts.at(-1) || null);
check(
  "buying posts a buy action",
  buyPost?.body?.actions?.[0]?.type === "buy",
  JSON.stringify(buyPost?.body?.actions ?? null),
);

// 6. Locking in posts lockIn, and the locked payload renders as locked.
await page.click('[data-testid="lane-runner-lock"]');
await page.waitForTimeout(250);
const lockPost = await page.evaluate(() => window.__lr.posts.at(-1) || null);
check(
  "locking in posts a lockIn action",
  lockPost?.body?.actions?.[0]?.type === "lockIn",
  JSON.stringify(lockPost?.body?.actions ?? null),
);
await page.evaluate(() => {
  window.__lr.pushAction({ type: "lockIn", seat: "player1" }, { locked: true, canAct: false });
});
await page.waitForTimeout(250);
const lockState = await page.evaluate(() => ({
  disabled: document.querySelector('[data-testid="lane-runner-lock"]')?.disabled ?? null,
  label: document.querySelector('[data-testid="lane-runner-lock"]')?.textContent?.replace(/\s+/g, " ").trim() ?? null,
  status: document.querySelector('[role="status"]')?.textContent?.replace(/\s+/g, " ").trim() ?? null,
}));
check(
  "a locked plan disables the lock control",
  lockState.disabled === true && /locked/i.test(lockState.label ?? ""),
  JSON.stringify(lockState),
);

// 7. A newly resolved round is the only thing that replays on the oval.
await page.evaluate(() => {
  window.__lr.pushRound({
    round: 2,
    resolvedAt: new Date().toISOString(),
    cars: [
      {
        seat: "player1",
        carId: "p1-c1",
        tier: 1,
        route: "safe",
        roll: 0.41,
        outcome: "finished",
        points: 12,
        reward: { resource: "scrap", amount: 1 },
      },
      {
        seat: "player2",
        carId: "p2-c2",
        tier: 2,
        route: "risk",
        roll: 0.08,
        outcome: "dnf",
        points: 0,
        reward: null,
      },
    ],
    points: { player1: 12, player2: 0 },
    totals: { player1: 30, player2: 0 },
  });
});
await page.waitForTimeout(1200);
const roundText = await text(page, '[data-testid="lane-runner-last-round"]');
check(
  "the confirmed round is shown, with both seats' points",
  /Round 2 result/.test(roundText ?? "") &&
    /You \+12/.test(roundText ?? "") &&
    /Rival \+0/.test(roundText ?? ""),
  roundText?.slice(0, 120) ?? "",
);
check(
  "the confirmed round moves the scoreboard",
  (await text(page, '[data-testid="lane-runner-score-player1"]')) === "30",
  await text(page, '[data-testid="lane-runner-score-player1"]'),
);
check(
  "a confirmed finished run pays its cue",
  (await page.evaluate(() => (window.__lr.cues || []).includes("playSafePick"))) === true,
  JSON.stringify(await page.evaluate(() => window.__lr.cues || [])),
);

// 8. Re-delivering the same snapshot must not replay or re-sound the round.
const cuesBefore = await page.evaluate(() => (window.__lr.cues || []).length);
await page.evaluate(() => window.__lr.redeliver(3));
await page.waitForTimeout(500);
check(
  "a repeated snapshot never replays the round",
  (await page.evaluate(() => (window.__lr.cues || []).length)) === cuesBefore &&
    (await text(page, '[data-testid="lane-runner-score-player1"]')) === "30",
  `cues ${cuesBefore} -> ${await page.evaluate(() => (window.__lr.cues || []).length)}`,
);

// 9. The finish mounts the shared result screen exactly once.
await page.evaluate(() => {
  window.__lr.current = window.__lr.match({
    ...window.__lr.current,
    status: "finished",
    lifecycle: "finished",
    phase: "finished",
    myPoints: 1012,
    oppPoints: 120,
    result: "player1",
    winnerId: "user_1",
    canAct: false,
    endedAt: new Date().toISOString(),
  });
  window.__lr.socket.push(window.__lr.updatedEvent);
});
await page.waitForTimeout(600);
check(
  "finishing mounts the shared result screen once",
  (await count(page, '[data-testid="result-screen"]')) === 1,
  `count=${await count(page, '[data-testid="result-screen"]')}`,
);
check(
  "the result screen reports the server's verdict and scores",
  /You reached 1,012 points/.test(await text(page, '[data-testid="result-headline"]')) &&
    /1012|1,012/.test(await bodyText(page)),
  await text(page, '[data-testid="result-headline"]'),
);
await page.screenshot({
  path: join(REPORTS, "lane-rush-race-result.png"),
  fullPage: true,
});
console.log(`screenshot: ${join(REPORTS, "lane-rush-race-result.png")}`);

check(
  "no React nesting / hydration / runtime error surfaced",
  structuralErrors([...consoleErrors, ...pageErrors]).length === 0,
  structuralErrors([...consoleErrors, ...pageErrors])[0] ?? "",
);

// ═══════════════════════════════════════════════════════════════════════════
// LEGACY — a preserved bridge row renders the notice, never racing controls
// ═══════════════════════════════════════════════════════════════════════════
{
  const { context, page: lpage, consoleErrors: lc, pageErrors: lp } = await bootPage({
    width: 1280,
    height: 1000,
  });
  await lpage.evaluate(() => {
    window.__lr.set({ mode: "duel", gameStateVersion: 0, lifecycle: "planning" });
    window.__lr.mount();
  });
  await lpage.waitForSelector("text=This match used the retired bridge board", {
    timeout: 10000,
  });
  check(
    "a legacy row shows the retired-board notice",
    /Start a new race/.test(await bodyText(lpage)),
  );
  check(
    "a legacy row never renders racing controls",
    (await count(lpage, '[aria-label="Your fleet"]')) === 0 &&
      (await count(lpage, '[data-testid="lane-runner-lock"]')) === 0,
  );
  check(
    "the legacy view raises no runtime error",
    structuralErrors([...lc, ...lp]).length === 0,
    structuralErrors([...lc, ...lp])[0] ?? "",
  );
  await context.close();
}

// ═══════════════════════════════════════════════════════════════════════════
// PORTRAIT — the creator-mode frame, no horizontal overflow
// ═══════════════════════════════════════════════════════════════════════════
{
  const { context, page: ppage, consoleErrors: pc, pageErrors: pp } = await bootPage(
    { width: 390, height: 844 },
    { deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  );
  await ppage.evaluate(() => {
    window.__lr.set();
    window.__lr.mount();
  });
  await ppage.waitForSelector('[data-testid="lane-runner-phase"]', { timeout: 10000 });
  await ppage.waitForTimeout(500);
  const overflow = await ppage.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  check("the portrait board has no horizontal overflow", overflow <= 1, `overflow=${overflow}px`);
  check(
    "the oval board still renders at phone width",
    (await count(ppage, 'svg[role="img"][aria-label^="Oval racetrack"]')) === 1,
  );
  await ppage.screenshot({
    path: join(REPORTS, "lane-rush-race-portrait.png"),
    fullPage: true,
  });
  console.log(`screenshot: ${join(REPORTS, "lane-rush-race-portrait.png")}`);
  check(
    "the portrait view raises no runtime error",
    structuralErrors([...pc, ...pp]).length === 0,
    structuralErrors([...pc, ...pp])[0] ?? "",
  );
  await context.close();
}

// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
if (fail > 0) process.exitCode = 1;
