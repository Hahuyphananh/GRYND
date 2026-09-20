// qa/precision-flow-check.mjs
//
// Drives qa/precision-flow-harness.jsx (the REAL Precision match page with
// stubbed sibling components + a scripted server state) through a full round
// and reports what the page actually does:
//
//   1. does the per-round "who won the round" panel appear after both seats
//      have stopped?
//   2. does the next round reset the running timer and show the NEW target?
//   3. does the next round's LIVE phase wrongly re-show the previous round's
//      result (the stale-reveal bug)?
//
// Run: node qa/precision-flow-check.mjs

import esbuild from "esbuild";
import { chromium } from "playwright";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "precision-flow-"));

// ── Stub modules (everything noisy around PageClient) ───────────────────────
const STUBS = {
  "next/navigation": `
    export const useRouter = () => ({ push(){}, replace(){}, back(){}, refresh(){}, prefetch(){} });
    export const usePathname = () => "/casino/precision/game/ai-test-1";
    export const useSearchParams = () => new URLSearchParams();
    export default { useRouter, usePathname, useSearchParams };
  `,
  "next/image": `
    import React from "react";
    export default function Img() { return null; }
  `,
  "next/link": `
    import React from "react";
    export default function Link({ children }) { return children ?? null; }
  `,
  "posthog-js/react": `export const usePostHog = () => null; export default {};`,
  "@clerk/nextjs": `
    export const useUser = () => ({ isLoaded: true, isSignedIn: true, user: { id: "user_1", username: "You" } });
    export const useAuth = () => ({ isLoaded: true, isSignedIn: true, userId: "user_1" });
    export const useClerk = () => ({ signOut() {} });
  `,
  "context/SocketProvider": `
    export const useSocket = () => ({ socket: window.__precision.socket });
    export const SocketProvider = ({ children }) => children;
    export default { useSocket, SocketProvider };
  `,
  "context/LanguageContext": `
    export const useLanguage = () => ({ language: "en", setLanguage() {} });
    export const LanguageProvider = ({ children }) => children;
    export default { useLanguage, LanguageProvider };
  `,
  "components/navigation-bar": `export default function Nav() { return null; }`,
  "components/Footer": `export default function Footer() { return null; }`,
  "components/lobby/MatchWaiting": `
    import React from "react";
    export default function MatchWaiting() { return React.createElement("div", { "data-testid": "waiting" }); }
  `,
  "components/game/EmotePicker": `export default function EmotePicker() { return null; }`,
  "hooks/useGameEmotes": `
    export default function useGameEmotes() {
      return { incomingEmote: null, myEmote: null, sendEmote() {} };
    }
  `,
  "components/creator-mode/CreatorModeHost": `
    import React from "react";
    export default function Host({ children }) { return children ?? null; }
  `,
  "components/creator-mode/CreatorModeLayout": `
    import React from "react";
    export const CreatorView = ({ normal }) => normal ?? null;
    export const CreatorModeShell = ({ children }) => children ?? null;
    export const ShellHeader = ({ children }) => children ?? null;
    export const ShellMain = ({ children }) => children ?? null;
    export const ShellAside = ({ children }) => children ?? null;
    export const useCreatorModeLayout = () => ({ isPortrait: false, orientation: "landscape" });
    export const CreatorResponsiveLayout = ({ children }) => children ?? null;
    export const CreatorModeLayoutProvider = ({ children }) => children ?? null;
  `,
  "components/ReportModal": `export default function ReportModal() { return null; }`,
  "components/precision/PrecisionScoreboard": `
    import React from "react";
    export default function Scoreboard() { return React.createElement("div", { "data-testid": "scoreboard" }); }
  `,
  "components/precision/PrecisionResultPopup": `export default function Popup() { return null; }`,
  "components/precision/PrecisionReadyRoom": `
    import React from "react";
    export default function ReadyRoom({ onReadyClick }) {
      return React.createElement("button", {
        "data-testid": "ready",
        onClick: onReadyClick,
      }, "Ready");
    }
  `,
  // PrecisionRoundResultPanel + PrecisionRocketRace stay REAL so this check
  // also exercises the actual reveal overlay and board that ship.
  "lib/precisionAudio": `export const playRankSound = () => {};`,
};

const stubKeys = Object.keys(STUBS);

// Match a module specifier against the stub list. Specifiers reach us in
// whatever form the importing file used ("../../hooks/x", "./PrecisionScoreboard",
// or the page's long "../../../../../components/..." chain), so a relative
// specifier is first resolved against its importer and then compared by path
// SUFFIX — that is stable across every import style the sources use, and a
// bare package name like "react" can never collide with a stub key.
const normalized = (value) => value.replace(/\\/g, "/");
const matchStubKey = (specifier, resolveDir) => {
  for (const key of stubKeys) {
    if (specifier === key || specifier.endsWith("/" + key) || specifier.endsWith(key)) {
      return key;
    }
  }
  if (!specifier.startsWith(".")) return null;
  const absolute = normalized(join(resolveDir, specifier));
  for (const key of stubKeys) {
    if (absolute.endsWith("/" + key)) return key;
  }
  return null;
};

await esbuild.build({
  entryPoints: [join(root, "qa/precision-flow-harness.jsx")],
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
      name: "flow-stubs",
      setup(build) {
        build.onResolve({ filter: /.*/ }, (args) => {
          const key = matchStubKey(args.path, args.resolveDir);
          if (!key) return null;
          return { path: key, namespace: "flow-stub" };
        });
        build.onLoad({ filter: /.*/, namespace: "flow-stub" }, (args) => ({
          contents: STUBS[args.path],
          loader: "jsx",
          resolveDir: root,
        }));
      },
    },
  ],
});

writeFileSync(
  join(outDir, "index.html"),
  `<!doctype html>
<html><head><meta charset="utf-8"></head>
<body><div id="root"></div><script src="./harness.js"></script></body></html>`
);

// ── Drive the page ──────────────────────────────────────────────────────────
let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${extra ? " — " + extra : ""}`);
  ok ? pass++ : fail++;
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e.message)));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});

await page.goto("file://" + join(outDir, "index.html").replace(/\\/g, "/"));
await page.waitForFunction(() => !!window.__precision?.mount, null, { timeout: 20000 });

// 1. Ready-up.
await page.evaluate(() => {
  window.__precision.set(window.__precision.baseMatch({ phase: "ready_up" }));
  window.__precision.mount();
});
await page.waitForSelector('[data-testid="ready"]', { timeout: 5000, state: "attached" });
check("ready_up renders the ready room", true);

// 2. Click Ready → the server arms round 1.
const readyResponse = await page.evaluate(() => {
  const now = Date.now();
  const armed = window.__precision.baseMatch({
    phase: "arming",
    roundSequence: 1,
    roundId: "m-ai-test-1-r-1",
    roundNonce: "nonce-1",
    armingStartedAt: now,
    countdownEndsAt: now + 1000,
    players: [
      { seat: 1, userId: "human", name: "You", isReady: true, isConnected: true },
      { seat: 2, userId: "AI_BOT", name: "GRYND AI", isReady: true, isConnected: true },
    ],
  });
  window.__precision.setReadyResponse(armed);
  return armed;
});
await page.click('[data-testid="ready"]');
check("Ready arms the first round", !!readyResponse);

// Small DOM helpers — the REAL components are mounted, so we read the page's
// own test ids and their text.
const text = (sel) =>
  page.evaluate(
    (s) => document.querySelector(s)?.textContent?.replace(/\s+/g, " ").trim() ?? null,
    sel
  );
const count = (sel) => page.$$eval(sel, (els) => els.length);
const digits = (v) => String(v ?? "").replace(/[^0-9]/g, "");
const players = [
  { seat: 1, userId: "human", name: "You", isReady: true, isConnected: true },
  { seat: 2, userId: "AI_BOT", name: "GRYND AI", isReady: true, isConnected: true },
];

// 3. Round 1 goes active with target 3000.
await page.evaluate((pl) => {
  const now = Date.now();
  window.__precision.set(
    window.__precision.baseMatch({
      phase: "active",
      roundSequence: 1,
      roundId: "m-ai-test-1-r-1",
      roundNonce: "nonce-1",
      targetMs: 3000,
      roundGoInstant: now - 200,
      players: pl,
    })
  );
}, players);
await page.waitForSelector('[data-testid="precision-stop-button"]', {
  timeout: 8000,
  state: "attached",
});
const activeTarget = await text('[data-testid="precision-round-target"]');
check("round 1 shows the live target", digits(activeTarget) === "3000", `target=${activeTarget}`);

// 4. Player STOPs → own rocket parks.
await page.click('[data-testid="precision-stop-button"]');
await page.waitForSelector('[data-testid="precision-race-stop-1"]', {
  timeout: 4000,
  state: "attached",
});
check(
  "STOP freezes the player's rocket",
  (await count('[data-testid="precision-race-stop-1"]')) > 0
);

// 5. Both seats stopped → round 1 decided, round 2 armed. The decision carries
//    its own `lastRoundTargetMs` (targetMs is null until the next reveal).
// The decided round's telemetry is IMMUTABLE once stamped: it must be byte-for-
// byte identical on the decision snapshot and on the armed/live states that
// follow it, which is exactly what lets the page recognise "same decision".
const STOP1 = { stopInstant: Date.now() - 1000, elapsedMs: 3100, diffMs: 100, userId: "human" };
const STOP2 = { stopInstant: Date.now() - 900, elapsedMs: 3300, diffMs: 300, userId: "AI_BOT" };
const decision = (now) => ({
  phase: "arming",
  currentRound: 2,
  score: { seat1: 1, seat2: 0 },
  lastRoundWinnerSeat: 1,
  lastRoundTargetMs: 3000,
  lastRoundStops: { seat1: STOP1, seat2: STOP2 },
  roundSequence: 2,
  roundId: "m-ai-test-1-r-2",
  roundNonce: "nonce-2",
  armingStartedAt: now,
  countdownEndsAt: now + 5000,
  players,
});
await page.evaluate(
  ({ d, s1, s2 }) => {
    window.__precision.set(
      window.__precision.baseMatch({ ...d, lastRoundStops: { seat1: s1, seat2: s2 } })
    );
  },
  { d: decision(Date.now()), s1: STOP1, s2: STOP2 }
);
await page.waitForSelector('[data-testid="precision-round-result-panel"]', {
  timeout: 6000,
  state: "attached",
});
const revealTarget = await text('[data-testid="precision-round-result-target"]');
check(
  "the round-result panel appears after both seats stop",
  digits(revealTarget) === "3000",
  `panel target=${revealTarget}`
);
check(
  "the round-result panel names the round winner",
  /YOU WIN THE ROUND|ROUND WON BY/i.test(
    (await text('[data-testid="precision-round-result-banner"]')) ?? ""
  ),
  await text('[data-testid="precision-round-result-banner"]')
);

// Let the 3s reveal window lapse before the next round opens.
await page.waitForTimeout(3400);
check(
  "the round-result panel auto-dismisses",
  (await count('[data-testid="precision-round-result-panel"]')) === 0
);

// 6. Round 2 goes active with a NEW target (7000).
await page.evaluate(
  ({ pl, s1, s2 }) => {
    const now = Date.now();
    window.__precision.set(
      window.__precision.baseMatch({
        phase: "active",
        currentRound: 2,
        score: { seat1: 1, seat2: 0 },
        lastRoundWinnerSeat: 1,
        lastRoundTargetMs: 3000,
        lastRoundStops: { seat1: s1, seat2: s2 },
        roundSequence: 2,
        roundId: "m-ai-test-1-r-2",
        roundNonce: "nonce-2",
        targetMs: 7000,
        roundGoInstant: now,
        players: pl,
      })
    );
  },
  { pl: players, s1: STOP1, s2: STOP2 }
);
await page.waitForSelector('[data-testid="precision-stop-button"]', {
  timeout: 8000,
  state: "attached",
});
await page.waitForTimeout(300);
const round2 = {
  target: await text('[data-testid="precision-round-target"]'),
  centre: await text('[data-testid="precision-race-center"]'),
  reveals: await count('[data-testid="precision-round-result-panel"]'),
  myStopPill: await count('[data-testid="precision-race-stop-1"]'),
};
check("round 2 shows the NEW target", digits(round2.target) === "7000", `target=${round2.target}`);
check(
  "round 2's timer restarts from the new GO instant",
  parseFloat(round2.centre) < 1.5,
  `centre=${round2.centre}`
);
check(
  "round 2's player rocket is unfrozen (not parked at round 1's stop)",
  round2.myStopPill === 0,
  `stop pills=${round2.myStopPill}`
);
check(
  "the live round does NOT re-show the previous round's result (stale reveal)",
  round2.reveals === 0,
  `panels=${round2.reveals}`
);

// 7. A client that never saw the live round (fresh mount / reload straight into
//    a decided round) must STILL get the reveal — `targetMs` is already null.
await page.evaluate(() => window.__precision.unmount());
await page.evaluate((pl) => {
  window.__precision.set(
    window.__precision.baseMatch({
      phase: "arming",
      currentRound: 2,
      score: { seat1: 1, seat2: 0 },
      lastRoundWinnerSeat: 2,
      lastRoundTargetMs: 4200,
      lastRoundStops: {
        seat1: { stopInstant: 5_000, elapsedMs: 3100, diffMs: 1100, userId: "human" },
        seat2: { stopInstant: 5_100, elapsedMs: 3980, diffMs: 220, userId: "AI_BOT" },
      },
      roundSequence: 3,
      roundId: "m-ai-test-1-r-3",
      roundNonce: "nonce-3",
      armingStartedAt: Date.now(),
      countdownEndsAt: Date.now() + 5000,
      players: pl,
    })
  );
  window.__precision.mount();
}, players);
await page.waitForSelector('[data-testid="precision-round-result-panel"]', {
  timeout: 6000,
  state: "attached",
});
check(
  "a fresh client still sees who won the round (no captured target needed)",
  digits(await text('[data-testid="precision-round-result-target"]')) === "4200",
  await text('[data-testid="precision-round-result-target"]')
);

check("no page/console errors", errors.length === 0, errors.slice(0, 3).join(" | "));

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
