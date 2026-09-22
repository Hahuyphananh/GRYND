// Temporary reproduction driver (deleted after the investigation).
//
// Scenario: the player clicks STOP while the round's live target reads 3000ms.
// The server then reports the round as decided, with the local seat recorded
// at 3300ms (300ms after the target) and the bot at 3050ms. We read back every
// surface the player can see, for BOTH seats, so a leaked/swapped/missing value
// shows up as a mismatch rather than as an opinion.

import esbuild from "esbuild";
import { chromium } from "playwright";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "precision-repro-"));

// Same stub set as qa/precision-flow-check.mjs, EXCEPT the scoreboard and the
// round-result panel stay real (those are the surfaces under investigation).
const STUBS = {
  "next/navigation": `
    export const useRouter = () => ({ push(){}, replace(){}, back(){}, refresh(){}, prefetch(){} });
    export const usePathname = () => "/casino/precision/game/ai-test-1";
    export const useSearchParams = () => new URLSearchParams();
    export default {};
  `,
  "next/image": `export default function Img() { return null; }`,
  "next/link": `export default function Link({ children }) { return children ?? null; }`,
  "posthog-js/react": `export const usePostHog = () => null; export default {};`,
  "@clerk/nextjs": `
    export const useUser = () => ({ isLoaded: true, isSignedIn: true, user: { id: "human", username: "You" } });
    export const useAuth = () => ({ isLoaded: true, isSignedIn: true, userId: "human" });
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
    export default {};
  `,
  "components/navigation-bar": `export default function Nav() { return null; }`,
  "components/Footer": `export default function Footer() { return null; }`,
  "components/lobby/MatchWaiting": `import React from "react"; export default function W() { return React.createElement("div", null); }`,
  "components/game/EmotePicker": `export default function EmotePicker() { return null; }`,
  "hooks/useGameEmotes": `export default function useGameEmotes() { return { incomingEmote: null, myEmote: null, sendEmote() {} }; }`,
  "components/creator-mode/CreatorModeHost": `export default function Host({ children }) { return children ?? null; }`,
  "components/creator-mode/CreatorModeLayout": `
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
  "components/precision/PrecisionResultPopup": `export default function Popup() { return null; }`,
  "components/precision/PrecisionReadyRoom": `
    import React from "react";
    export default function ReadyRoom({ onReadyClick }) {
      return React.createElement("button", { "data-testid": "ready", onClick: onReadyClick }, "Ready");
    }
  `,
  "lib/precisionAudio": `export const playRankSound = () => {};`,
};

const stubKeys = Object.keys(STUBS);
const normalized = (v) => v.replace(/\\/g, "/");
const matchStubKey = (specifier, resolveDir) => {
  for (const key of stubKeys) {
    if (specifier === key || specifier.endsWith("/" + key) || specifier.endsWith(key)) return key;
  }
  if (!specifier.startsWith(".")) return null;
  const absolute = normalized(join(resolveDir, specifier));
  for (const key of stubKeys) {
    if (absolute.endsWith("/" + key)) return key;
  }
  return null;
};

await esbuild.build({
  entryPoints: [join(root, "qa/tmp-precision-repro-harness.jsx")],
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
      name: "repro-stubs",
      setup(build) {
        build.onResolve({ filter: /.*/ }, (args) => {
          const key = matchStubKey(args.path, args.resolveDir);
          if (!key) return null;
          return { path: key, namespace: "repro-stub" };
        });
        build.onLoad({ filter: /.*/, namespace: "repro-stub" }, (args) => ({
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
  `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script src="./harness.js"></script></body></html>`,
);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));

await page.goto("file://" + join(outDir, "index.html").replace(/\\/g, "/"));
await page.waitForFunction(() => !!window.__precision?.mount, null, { timeout: 20000 });

const dump = (label) =>
  page.evaluate((l) => {
    const t = (sel) => document.querySelector(sel)?.textContent?.replace(/\s+/g, " ").trim() ?? null;
    const all = (sel) =>
      [...document.querySelectorAll(sel)].map((e) => e.textContent.replace(/\s+/g, " ").trim());
    return {
      label: l,
      rows: all("[data-testid^='precision-round-result-row-']"),
      rankBadges: all("[data-testid^='precision-round-result-rank-']"),
      banner: t("[data-testid='precision-round-result-banner']"),
      panelTarget: t("[data-testid='precision-round-result-target']"),
      lanePills: all("[data-testid^='precision-race-stop-']"),
      laneLanes: all("[data-testid^='precision-race-lane-']"),
      raceCentre: t("[data-testid='precision-race-center']"),
      lastRoundStops: t("[data-testid='precision-last-round-stops']"),
      scoreboard: t("[data-testid='precision-scoreboard']"),
      bodyText: document.body.innerText.replace(/\s+/g, " ").slice(0, 900),
    };
  }, label);

// 1. Ready → arm → active round 1, target 3000, GO 1500ms ago.
await page.evaluate(() => {
  const now = Date.now();
  window.__precision.set(
    window.__precision.baseMatch({
      phase: "arming",
      countdownEndsAt: now,
      armingStartedAt: now - 5000,
    }),
  );
  window.__precision.mount();
});
await page.waitForTimeout(300);
await page.evaluate(() => {
  const now = Date.now();
  window.__precision.set(
    window.__precision.baseMatch({
      phase: "active",
      targetMs: 3000,
      roundGoInstant: now - 1500,
    }),
  );
});
await page.waitForSelector("[data-testid='precision-stop-button']", { timeout: 8000 });
console.log("active:", JSON.stringify(await dump("active"), null, 2));

// 2. Player clicks STOP.
await page.click("[data-testid='precision-stop-button']");
await page.waitForSelector("[data-testid='precision-race-stop-1']", { timeout: 4000 });
const frozen = await dump("after-stop");
console.log(
  "after-stop pills:",
  JSON.stringify(frozen.lanePills),
  "wrote to /api/precision/round-stop?",
  await page.evaluate(() => window.__precision.posts.some((u) => u.includes("round-stop"))),
);

// 3. The server decides the round: the local seat at 3300ms (a 300ms MISS),
//    the bot at 3050ms (a 50ms FAIR). Both stops are byte-identical to what
//    `recordRoundStop` would persist.
const STOP1 = { stopInstant: Date.now() - 500, elapsedMs: 3300, diffMs: 300, userId: "human" };
const STOP2 = { stopInstant: Date.now() - 400, elapsedMs: 3050, diffMs: 50, userId: "AI_BOT" };
await page.evaluate(
  ({ s1, s2 }) => {
    const now = Date.now();
    window.__precision.set(
      window.__precision.baseMatch({
        phase: "arming",
        currentRound: 2,
        score: { seat1: 0, seat2: 1 },
        lastRoundWinnerSeat: 2,
        lastRoundTargetMs: 3000,
        lastRoundStops: { seat1: s1, seat2: s2 },
        roundSequence: 2,
        roundId: "m-ai-test-1-r-2",
        roundNonce: "nonce-2",
        armingStartedAt: now,
        countdownEndsAt: now + 5000,
      }),
    );
  },
  { s1: STOP1, s2: STOP2 },
);
await page.waitForSelector("[data-testid='precision-round-result-panel']", { timeout: 6000 });
console.log("decided:", JSON.stringify(await dump("decided"), null, 2));

// 4. After the reveal dismisses, the arming recap must still show both stops.
await page.waitForTimeout(3400);
console.log("recap:", JSON.stringify(await dump("recap"), null, 2));

await browser.close();
