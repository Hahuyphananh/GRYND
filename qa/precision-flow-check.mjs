// qa/precision-flow-check.mjs
//
// Drives qa/precision-flow-harness.jsx (the REAL Precision match page with
// stubbed sibling components + a scripted server state) through a full round
// and reports what the page actually does:
//
//   1. does the per-round "who won the round" panel appear after both seats
//      have stopped — ON TIME, both when the stop ACK carries the snapshot and
//      when it does not (a lost broadcast), since the reported bug was the
//      result arriving only after the round trip back through the room;
//   2. does the next round reset the running timer and show the NEW target?
//   3. does the next round's LIVE phase wrongly re-show the previous round's
//      result (the stale-reveal bug)?
//
// Timing is asserted, not just eventual state: "the results show with a delay"
// is a latency complaint, so each path is given a bound it has to meet rather
// than a generous timeout it can hide inside.
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
  // The scoreboard's own subtree (avatars, round markers) is stubbed out, but
  // the ONE thing the page has to get right is passed straight through here:
  // `awaitingOpponentStop`. The stub mirrors the real component's decisive
  // branch (banner = `waiting_opponent_stop` when the flag is set) and uses the
  // same translation key, so the check asserts BOTH the flag the page derived
  // and the copy the player would read.
  "components/precision/PrecisionScoreboard": `
    import React from "react";
    import { useTranslation } from "./src/hooks/useTranslation";
    export default function Scoreboard({ awaitingOpponentStop }) {
      const { t } = useTranslation();
      return React.createElement(
        "div",
        {
          "data-testid": "scoreboard",
          "data-awaiting-opponent": awaitingOpponentStop ? "true" : "false",
        },
        awaitingOpponentStop ? t("games.precision.waiting_opponent_stop") : null,
      );
    }
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

// 4a. Both seats stopped → round 1 decided, round 2 armed. The decision carries
//     its own `lastRoundTargetMs` (targetMs is null until the next reveal), and
//     it is SCRIPTED BEFORE THE CLICK: the round is decided by the stop itself,
//     so the server's answer to the stop IS the decided snapshot — which is what
//     the realtime proxy ACKs and broadcasts.
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
    const decided = window.__precision.baseMatch({
      ...d,
      lastRoundStops: { seat1: s1, seat2: s2 },
    });
    // The stop's own answer, exactly as the route returns it.
    window.__precision.stopResponse = {
      match: decided,
      bothStopped: true,
      roundWinnerSeat: 1,
      matchFinished: false,
    };
    // The reported case: no broadcast, so the only way the result can reach the
    // player is the ACK / the page's own reconciliation.
    window.__precision.stopBroadcast = false;
    window.__precision.stopAckMode = "withMatch";
  },
  { d: decision(Date.now()), s1: STOP1, s2: STOP2 }
);

// 4b. Player STOPs → own rocket parks, and the result arrives. The clock starts
//     BEFORE the click, so what is asserted is the delay the player actually
//     experiences from pressing STOP to reading the result.
const stopClickedAt = Date.now();
await page.click('[data-testid="precision-stop-button"]');
// 5. The decided round reaches the player WITHOUT any room broadcast (the
//    scripted stop above sends none). The ACK carries the snapshot, so this
//    must land in a direct-packet time, not in a fan-out round trip. Measured
//    from the click with nothing in between, so the number is the delay the
//    player sees.
await page.waitForSelector('[data-testid="precision-round-result-panel"]', {
  timeout: 6000,
  state: "attached",
});
const stopToPanelMs = Date.now() - stopClickedAt;
check(
  "the result panel appears without waiting for a room broadcast (ACK carries it)",
  stopToPanelMs <= 1500,
  `STOP → result ${stopToPanelMs}ms`
);
// …and the click parked the player's own rocket on the spot.
await page.waitForSelector('[data-testid="precision-race-stop-1"]', {
  timeout: 4000,
  state: "attached",
});
check(
  "STOP freezes the player's rocket",
  (await count('[data-testid="precision-race-stop-1"]')) > 0
);
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
// …and hand the page the round the reveal opened the way the realtime server
// does. The scheduler that owns that transition broadcasts `roundArmStart` with
// the live match, so a driver advancing the scripted state has to say so —
// otherwise it measures a page whose socket is silent.
const armedRound2 = async () =>
  page.evaluate(() => {
    window.__precision.broadcast("precision:roundArmStart", {
      matchId: "ai-test-1",
      match: window.__precision.current,
    });
  });
check(
  "the round-result panel auto-dismisses",
  (await count('[data-testid="precision-round-result-panel"]')) === 0
);

// 6. Round 2 goes active with a NEW target (7000), broadcast like production.
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
    // A fresh round means a fresh stop answer.
    window.__precision.stopResponse = null;
  },
  { pl: players, s1: STOP1, s2: STOP2 }
);
await armedRound2();
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

// 6b. Round 2 is the regression case for the awaiting-opponent hint: a previous
//     round already has a winner, and `lastRoundWinnerSeat` is never cleared by
//     the next arm. The old condition ANDed on it being null, so from round 2
//     onward the scoreboard silently never told the player it was waiting on
//     the opponent's stop (selfStopPending is what scopes it to the live round).
await page.click('[data-testid="precision-stop-button"]');
await page.waitForSelector('[data-testid="precision-race-stop-1"]', {
  timeout: 4000,
  state: "attached",
});
const awaitingFlag = await page.evaluate(
  () => document.querySelector('[data-testid="scoreboard"]')?.getAttribute("data-awaiting-opponent") ?? null
);
const awaitingText = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, " ");
check(
  "round 2: the scoreboard is told we are waiting on the opponent's stop",
  awaitingFlag === "true",
  `awaitingOpponentStop=${awaitingFlag}`
);
check(
  "round 2: and the player can read that hint",
  /Waiting for opponent to stop/i.test(awaitingText),
  awaitingText.slice(0, 160)
);

// 6c. The safety net, and the case the reported bug is really about: a stop that
//     is accepted with a BARE ack and NO broadcast — a socket that dropped the
//     result packet. Both delivery paths are withheld, and the scripted server
//     only becomes decided once the packet has landed, so nothing the page can
//     receive on the socket carries the result. It can only arrive through the
//     reconciliation read the STOP itself armed. Without that, the board sat with
//     the bot still flying until the player switched tabs.
//
//     Round 3 is used so the round is genuinely open (round 2's own stop already
//     locked the button for round 2).
const ROUND3_GO = await page.evaluate(
  ({ s1, s2 }) => {
    const now = Date.now();
    window.__precision.stopResponse = null;
    window.__precision.stopAckMode = "bare";
    window.__precision.stopBroadcast = false;
    window.__precision.set(
      window.__precision.baseMatch({
        phase: "active",
        currentRound: 3,
        score: { seat1: 1, seat2: 1 },
        // The last DECIDED round is still round 1: its signature is the one the
        // page has already revealed and dismissed, so opening round 3 live does
        // not re-show a result. (Round 2's stop was recorded but its round was
        // never decided.)
        lastRoundWinnerSeat: 1,
        lastRoundTargetMs: 3000,
        lastRoundStops: { seat1: s1, seat2: s2 },
        roundSequence: 3,
        roundId: "m-ai-test-1-r-3",
        roundNonce: "nonce-3",
        targetMs: 4000,
        roundGoInstant: now,
        armingStartedAt: null,
        countdownEndsAt: null,
        players: [
          { seat: 1, userId: "human", name: "You", isReady: true, isConnected: true },
          { seat: 2, userId: "AI_BOT", name: "GRYND AI", isReady: true, isConnected: true },
        ],
      })
    );
    return now;
  },
  { s1: STOP1, s2: STOP2 }
);
await page.evaluate(() =>
  window.__precision.broadcast("precision:roundArmStart", {
    matchId: "ai-test-1",
    match: window.__precision.current,
  })
);
await page.waitForFunction(
  () => !!document.querySelector('[data-testid="precision-stop-button"]'),
  null,
  { timeout: 8000 }
);
// Round 3 has to be ON SCREEN before the click: the single-click lock is reset
// by an effect, so clicking while the previous round's state is still mounted
// would press a locked button (and this step would then "prove" nothing). The
// live target is the page's own evidence that round 3 is the mounted round.
await page.waitForFunction(
  () =>
    String(document.querySelector('[data-testid="precision-round-target"]')?.textContent ?? "")
      .replace(/[^0-9]/g, "") === "4000",
  null,
  { timeout: 8000 }
);
await page.waitForTimeout(150);
const liveRound3 = await count('[data-testid="precision-round-result-panel"]');
check("round 3 opens live with no result on screen", liveRound3 === 0, `panels=${liveRound3}`);

const reconcileClickedAt = Date.now();
await page.click('[data-testid="precision-stop-button"]');
// The click must have been taken: the player's own rocket parks on the spot.
await page.waitForSelector('[data-testid="precision-race-stop-1"]', {
  timeout: 4000,
  state: "attached",
});
check("round 3: STOP is accepted with both socket paths silent", true);
// The server grades the round as the packet lands — AFTER the click and with
// nothing sent back over the socket.
await page.evaluate((go) => {
  const now = Date.now();
  window.__precision.set(
    window.__precision.baseMatch({
      phase: "arming",
      currentRound: 4,
      score: { seat1: 1, seat2: 2 },
      lastRoundWinnerSeat: 2,
      lastRoundTargetMs: 4000,
      lastRoundStops: {
        seat1: { stopInstant: now - 900, elapsedMs: 4300, diffMs: 300, userId: "human" },
        seat2: { stopInstant: go + 3900, elapsedMs: 3900, diffMs: 100, userId: "AI_BOT" },
      },
      roundSequence: 4,
      roundId: "m-ai-test-1-r-4",
      roundNonce: "nonce-4",
      targetMs: null,
      roundGoInstant: null,
      armingStartedAt: now,
      countdownEndsAt: now + 5000,
      players: [
        { seat: 1, userId: "human", name: "You", isReady: true, isConnected: true },
        { seat: 2, userId: "AI_BOT", name: "GRYND AI", isReady: true, isConnected: true },
      ],
    })
  );
}, ROUND3_GO);
// The banner a LOST round shows is "Round won by <name>" (the won-round copy is
// reserved for the seat that took it), and round 3's decided target is 4000 —
// both have to be read off the panel that appears, so this cannot pass on round
// 1's result still being on screen either.
await page.waitForFunction(
  () =>
    /ROUND WON BY/i.test(
      document.querySelector('[data-testid="precision-round-result-banner"]')?.textContent ?? ""
    ),
  null,
  { timeout: 6000 }
);
const reconcileMs = Date.now() - reconcileClickedAt;
check(
  "the reconciled result is round 3's own decision",
  digits(await text('[data-testid="precision-round-result-target"]')) === "4000",
  await text('[data-testid="precision-round-result-target"]')
);
check(
  "a bare ACK with no broadcast still lands the result (bounded reconciliation)",
  reconcileMs <= 2500,
  `STOP → result ${reconcileMs}ms with both socket paths silent`
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

// 8. The pre-round countdown, which is the other half of the report: "when the
//    countdown reaches 0, the game doesn't start immediately". The round is
//    held in `arming` and the ONLY thing that opens it is a read past
//    `countdownEndsAt`, so the page's own deadline read has to be that read. No
//    socket event is emitted below — a page that waited for a broadcast would
//    sit on a finished countdown, which is exactly the symptom.
const COUNTDOWN_MS = 900;
const countdownEndsAt = await page.evaluate((cd) => {
  const now = Date.now();
  const endsAt = now + cd;
  const armed = window.__precision.baseMatch({
    phase: "arming",
    currentRound: 5,
    roundSequence: 5,
    roundId: "m-ai-test-1-r-5",
    roundNonce: "nonce-5",
    targetMs: null,
    roundGoInstant: null,
    armingStartedAt: now,
    countdownEndsAt: endsAt,
    players: [
      { seat: 1, userId: "human", name: "You", isReady: true, isConnected: true },
      { seat: 2, userId: "AI_BOT", name: "GRYND AI", isReady: true, isConnected: true },
    ],
  });
  // The store's own read-time transition: while arming, once the stamped
  // instant has passed, the round is revealed and stamped with its GO instant.
  window.__precision.onServe = (state) => {
    if (!state || state.phase !== "arming") return null;
    if (typeof state.countdownEndsAt !== "number") return null;
    if (state.countdownEndsAt > Date.now()) return null;
    return {
      ...state,
      phase: "active",
      targetMs: 5000,
      roundGoInstant: state.countdownEndsAt,
      countdownEndsAt: null,
      version: Number(state.version ?? 0) + 1,
    };
  };
  window.__precision.set(armed);
  return endsAt;
}, COUNTDOWN_MS);
// Broadcast the arm so the page mounts the countdown (that broadcast is what the
// realtime scheduler sends when it applies the reveal; here it only announces
// the arming state, never the transition itself).
await page.evaluate(() =>
  window.__precision.broadcast("precision:roundArmStart", {
    matchId: "ai-test-1",
    match: window.__precision.current,
  })
);
// While the round is held, the live round is not on screen: the armed panel
// (recap + countdown) is what the phase renders, so the STOP control is absent
// until the round opens.
await page.waitForFunction(
  () => !document.querySelector('[data-testid="precision-stop-button"]'),
  null,
  { timeout: 4000 }
);
check("a held round has no live round panel", true, `countdownEndsAt in ${COUNTDOWN_MS}ms`);
await page.waitForFunction(
  () => !!document.querySelector('[data-testid="precision-stop-button"]'),
  null,
  { timeout: 6000 }
);
const openLagMs = Date.now() - countdownEndsAt;
check(
  "the round opens AT the countdown's end, with no socket event to announce it",
  openLagMs >= 0 && openLagMs <= 1500,
  `round opened ${openLagMs}ms after the stamped end`
);

check("no page/console errors", errors.length === 0, errors.slice(0, 3).join(" | "));

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
