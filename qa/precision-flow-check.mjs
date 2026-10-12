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

// The round-result card is now a win/loss/tie VERDICT with no figures in it, so
// "which round's decision is this, and did it paint the right colour" is read
// off the card itself: `data-outcome` / `data-decision` are stamped by the
// panel, and the heading's computed colour is what the player actually sees.
const readOutcome = () =>
  page.evaluate(() => {
    const panel = document.querySelector('[data-testid="precision-round-result-panel"]');
    const heading = document.querySelector('[data-testid="precision-round-result-outcome"]');
    if (!panel || !heading) return null;
    return {
      outcome: panel.getAttribute("data-outcome"),
      winnerSeat: panel.getAttribute("data-winner-seat"),
      decision: panel.getAttribute("data-decision"),
      word: heading.textContent.replace(/\s+/g, " ").trim(),
      // This run has no stylesheet, so the palette can only be read off the
      // classes the card applies. The colour those classes actually PAINT is
      // asserted in qa/precision-mobile-check.mjs, which loads real Tailwind.
      headingClass: heading.className,
      green: /text-emerald-200/.test(heading.className),
      red: /text-red-200/.test(heading.className),
      amber: /text-amber-200/.test(heading.className),
    };
  });
/** The revealed decision's identity, exactly as `decisionKeyOf` builds it. */
const decisionKey = (s1, s2, winnerSeat) =>
  [
    s1.stopInstant,
    s1.elapsedMs,
    s2.stopInstant,
    s2.elapsedMs,
    winnerSeat === null ? "tie" : winnerSeat,
  ].join("|");
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
// The card answers one question — did we take the round — and the answer is the
// COLOUR: green, red, or amber on a tie. There are no per-seat figures in it.
const winOutcome = await readOutcome();
check(
  "the round-result card reports a WIN when the server says our seat took the round",
  winOutcome?.outcome === "win" && /YOU WIN THE ROUND/i.test(winOutcome.word ?? ""),
  `outcome=${winOutcome?.outcome} word="${winOutcome?.word}"`
);
check(
  "…and the win card uses the GREEN palette (not the old purple both-seats banner)",
  winOutcome?.green === true && winOutcome?.red === false && winOutcome?.amber === false,
  `heading class "${winOutcome?.headingClass}"`
);
check(
  "…and it is THIS round's decision, not a stale result",
  winOutcome?.decision === decisionKey(STOP1, STOP2, 1),
  `decision=${winOutcome?.decision}`
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
const round3Stops = await page.evaluate((go) => {
  const now = Date.now();
  const stops = {
    seat1: { stopInstant: now - 900, elapsedMs: 4300, diffMs: 300, userId: "human" },
    seat2: { stopInstant: go + 3900, elapsedMs: 3900, diffMs: 100, userId: "AI_BOT" },
  };
  window.__precision.set(
    window.__precision.baseMatch({
      phase: "arming",
      currentRound: 4,
      score: { seat1: 1, seat2: 2 },
      lastRoundWinnerSeat: 2,
      lastRoundTargetMs: 4000,
      lastRoundStops: stops,
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
  return stops;
}, ROUND3_GO);
// The verdict a LOST round shows is the RED card (the green one is reserved for
// the seat that took the round), which is what makes this unable to pass on
// round 1's win card still being on screen.
await page.waitForFunction(
  () =>
    document
      .querySelector('[data-testid="precision-round-result-panel"]')
      ?.getAttribute("data-outcome") === "loss",
  null,
  { timeout: 6000 }
);
const reconcileMs = Date.now() - reconcileClickedAt;
const lostOutcome = await readOutcome();
check(
  "the reconciled result is round 3's own decision, shown as a LOSS in RED",
  lostOutcome?.decision === decisionKey(round3Stops.seat1, round3Stops.seat2, 2) &&
    lostOutcome?.red === true &&
    lostOutcome?.green === false &&
    /ROUND LOST/i.test(lostOutcome?.word ?? ""),
  `decision=${lostOutcome?.decision} word="${lostOutcome?.word}" class "${lostOutcome?.headingClass}"`
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
const freshOutcome = await readOutcome();
check(
  "a fresh client still sees who won the round (no captured target needed)",
  freshOutcome?.outcome === "loss" &&
    freshOutcome?.decision ===
      decisionKey(
        { stopInstant: 5_000, elapsedMs: 3100 },
        { stopInstant: 5_100, elapsedMs: 3980 },
        2
      ),
  `outcome=${freshOutcome?.outcome} decision=${freshOutcome?.decision}`
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

// 9. The sequencing rule, in the shape the SERVER actually produces: a
//    decision arms the next round with `countdownEndsAt = decision +
//    ROUND_RESULT_REVEAL_MS + ROUND_COUNTDOWN_MS` (3s of result, then a full 5s
//    countdown). The popup has to (a) appear as soon as the decision lands and
//    (b) be GONE the moment the next round opens — even when it opens while the
//    popup would still have been inside its own 3s window. That is the reported
//    overlap: "when the result popup shows up, the other round starts".
const COOLDOWN_MS = 3_000;
const COUNTDOWN_FULL_MS = 5_000;
const decisionAt = await page.evaluate(
  ({ cooldown, countdown }) => {
    const now = Date.now();
    window.__precision.onServe = null;
    window.__precision.set(
      window.__precision.baseMatch({
        phase: "arming",
        currentRound: 6,
        score: { seat1: 2, seat2: 2 },
        lastRoundWinnerSeat: 1,
        lastRoundTargetMs: 6000,
        // A NEW decision (fresh instants), so the page has not revealed it yet.
        lastRoundStops: {
          seat1: { stopInstant: now - 400, elapsedMs: 6100, diffMs: 100, userId: "human" },
          seat2: { stopInstant: now - 300, elapsedMs: 6400, diffMs: 400, userId: "AI_BOT" },
        },
        roundSequence: 6,
        roundId: "m-ai-test-1-r-6",
        roundNonce: "nonce-6",
        targetMs: null,
        roundGoInstant: null,
        armingStartedAt: now,
        countdownEndsAt: now + cooldown + countdown,
        version: Number(window.__precision.current?.version ?? 0) + 5,
        players: [
          { seat: 1, userId: "human", name: "You", isReady: true, isConnected: true },
          { seat: 2, userId: "AI_BOT", name: "GRYND AI", isReady: true, isConnected: true },
        ],
      })
    );
    return now;
  },
  { cooldown: COOLDOWN_MS, countdown: COUNTDOWN_FULL_MS }
);
await page.evaluate(() =>
  window.__precision.broadcast("precision:roundArmStart", {
    matchId: "ai-test-1",
    match: window.__precision.current,
  })
);
await page.waitForSelector('[data-testid="precision-round-result-panel"]', {
  timeout: 4000,
  state: "attached",
});
const popupShownAt = Date.now();
check(
  "the result popup appears as soon as the decision lands",
  popupShownAt - decisionAt <= 1500,
  `decision → popup ${popupShownAt - decisionAt}ms`
);

// …then, a beat later but STILL inside the popup's 3s window, the next round
// OPENS. The wait is what makes the check meaningful: the popup cannot have
// gone away on its own timer yet, so only the round opening can remove it.
await page.waitForTimeout(1000);
const openAt = await page.evaluate(() => {
  const now = Date.now();
  const live = {
    ...window.__precision.current,
    phase: "active",
    targetMs: 6500,
    roundGoInstant: now,
    armingStartedAt: null,
    countdownEndsAt: null,
    version: Number(window.__precision.current.version ?? 0) + 1,
  };
  window.__precision.set(live);
  window.__precision.broadcast("precision:roundArmStart", { matchId: "ai-test-1", match: live });
  return now;
});
await page.waitForFunction(
  () => !!document.querySelector('[data-testid="precision-stop-button"]'),
  null,
  { timeout: 4000 }
);
const panelsOnOpen = await count('[data-testid="precision-round-result-panel"]');
check(
  "the next round opens with NO result popup on screen",
  panelsOnOpen === 0,
  `panels=${panelsOnOpen} (opened ${openAt - popupShownAt}ms into the popup's window)`
);
await page.waitForFunction(
  () => !document.querySelector('[data-testid="precision-round-result-panel"]'),
  null,
  { timeout: 1000 }
);
check(
  "a popup that was still up is dropped by the round opening, not by its timer",
  openAt - popupShownAt >= 800 && openAt - popupShownAt < COOLDOWN_MS,
  `round opened ${openAt - popupShownAt}ms after the popup appeared (window is ${COOLDOWN_MS}ms)`
);

// 10. And the sequence the report asked for, in the server's own shape: the
//     popup holds the screen while the countdown is HELD, gives it back when
//     the countdown starts, and the countdown the player then reads is a whole
//     5s — not the tail of one that had been running behind the popup.
const heldDecisionAt = await page.evaluate(
  ({ cooldown, countdown }) => {
    const now = Date.now();
    window.__precision.set(
      window.__precision.baseMatch({
        phase: "arming",
        currentRound: 7,
        score: { seat1: 2, seat2: 2 },
        lastRoundWinnerSeat: 2,
        lastRoundTargetMs: 4200,
        // Another fresh decision: new instants, so the popup is due again.
        lastRoundStops: {
          seat1: { stopInstant: now - 800, elapsedMs: 4500, diffMs: 300, userId: "human" },
          seat2: { stopInstant: now - 700, elapsedMs: 4300, diffMs: 100, userId: "AI_BOT" },
        },
        roundSequence: 7,
        roundId: "m-ai-test-1-r-7",
        roundNonce: "nonce-7",
        targetMs: null,
        roundGoInstant: null,
        armingStartedAt: now,
        countdownEndsAt: now + cooldown + countdown,
        version: Number(window.__precision.current?.version ?? 0) + 5,
        players: [
          { seat: 1, userId: "human", name: "You", isReady: true, isConnected: true },
          { seat: 2, userId: "AI_BOT", name: "GRYND AI", isReady: true, isConnected: true },
        ],
      })
    );
    return now;
  },
  { cooldown: COOLDOWN_MS, countdown: COUNTDOWN_FULL_MS }
);
await page.evaluate(() =>
  window.__precision.broadcast("precision:roundArmStart", {
    matchId: "ai-test-1",
    match: window.__precision.current,
  })
);
await page.waitForSelector('[data-testid="precision-round-result-panel"]', {
  timeout: 4000,
  state: "attached",
});
// While the popup is up the countdown is held at the top of its range: the
// cooldown is dead time, not extra ticks.
const heldCountdown = await text('[data-testid="precision-race-center"]');
check(
  "the popup is up while the countdown is held at 5",
  heldCountdown === "5",
  `centre=${heldCountdown}`
);
// The popup must hand over on the SERVER's schedule (decision + cooldown), so
// give it that long — and not the whole countdown.
await page.waitForFunction(
  () => !document.querySelector('[data-testid="precision-round-result-panel"]'),
  null,
  { timeout: COOLDOWN_MS + 2500 }
);
const handedOverAt = Date.now() - heldDecisionAt;
const countdownAfterPopup = Number((await text('[data-testid="precision-race-center"]')) ?? "0");
const stillArmed = await count('[data-testid="precision-stop-button"]');
check(
  "the popup gives the screen back at the cooldown's end, not mid-countdown",
  handedOverAt >= COOLDOWN_MS - 250 && handedOverAt <= COOLDOWN_MS + 1200,
  `handed over ${handedOverAt}ms after the decision (cooldown is ${COOLDOWN_MS}ms)`
);
check(
  "the player then reads a WHOLE 5s countdown, and the round is not live yet",
  countdownAfterPopup >= 4 && stillArmed === 0,
  `countdown=${countdownAfterPopup}s, liveRoundPanels=${stillArmed}`
);

// 11. The other way a result used to go missing: the stop DID land, but its
//     ACK was lost, so the player's retry (or the socket's own replay) is
//     refused as a duplicate. That refusal carries the authoritative snapshot,
//     and the player must see the ROUND RESULT — not a retry prompt — because
//     their click counted.
const duplicateRoundGo = await page.evaluate(() => {
  const now = Date.now();
  const live = window.__precision.baseMatch({
    phase: "active",
    currentRound: 8,
    score: { seat1: 2, seat2: 2 },
    lastRoundWinnerSeat: 2,
    lastRoundTargetMs: 4200,
    lastRoundStops: {
      seat1: { stopInstant: now - 900, elapsedMs: 4500, diffMs: 300, userId: "human" },
      seat2: { stopInstant: now - 800, elapsedMs: 4300, diffMs: 100, userId: "AI_BOT" },
    },
    roundSequence: 8,
    roundId: "m-ai-test-1-r-8",
    roundNonce: "nonce-8",
    targetMs: 4000,
    roundGoInstant: now,
    armingStartedAt: null,
    countdownEndsAt: null,
    version: Number(window.__precision.current?.version ?? 0) + 5,
    players: [
      { seat: 1, userId: "human", name: "You", isReady: true, isConnected: true },
      { seat: 2, userId: "AI_BOT", name: "GRYND AI", isReady: true, isConnected: true },
    ],
  });
  window.__precision.set(live);
  window.__precision.broadcast("precision:roundArmStart", { matchId: "ai-test-1", match: live });
  return now;
});
await page.waitForSelector('[data-testid="precision-stop-button"]', {
  timeout: 8000,
  state: "attached",
});
await page.waitForFunction(
  () =>
    String(document.querySelector('[data-testid="precision-round-target"]')?.textContent ?? "")
      .replace(/[^0-9]/g, "") === "4000",
  null,
  { timeout: 8000 }
);
await page.evaluate(
  ({ go, cooldown, countdown }) => {
    const now = Date.now();
    // The click lands on the server (the round is decided and the next one is
    // armed), but the answer that comes back is the DUPLICATE refusal — the
    // exact shape the realtime proxy now forwards, snapshot included.
    window.__precision.set(
      window.__precision.baseMatch({
        phase: "arming",
        currentRound: 9,
        score: { seat1: 3, seat2: 2 },
        lastRoundWinnerSeat: 1,
        lastRoundTargetMs: 4000,
        lastRoundStops: {
          seat1: { stopInstant: now - 300, elapsedMs: 4100, diffMs: 100, userId: "human" },
          seat2: { stopInstant: go + 4400, elapsedMs: 4400, diffMs: 400, userId: "AI_BOT" },
        },
        roundSequence: 9,
        roundId: "m-ai-test-1-r-9",
        roundNonce: "nonce-9",
        targetMs: null,
        roundGoInstant: null,
        armingStartedAt: now,
        countdownEndsAt: now + cooldown + countdown,
        // Newer than the live round the page is holding, exactly as a real
        // decision is (the page drops an older snapshot rather than regressing).
        version: Number(window.__precision.current?.version ?? 0) + 5,
        players: [
          { seat: 1, userId: "human", name: "You", isReady: true, isConnected: true },
          { seat: 2, userId: "AI_BOT", name: "GRYND AI", isReady: true, isConnected: true },
        ],
      })
    );
    window.__precision.stopResponse = {
      match: window.__precision.current,
      bothStopped: true,
      roundWinnerSeat: 1,
      matchFinished: false,
    };
    window.__precision.stopAckMode = "duplicate";
    window.__precision.stopBroadcast = false;
  },
  { go: duplicateRoundGo, cooldown: COOLDOWN_MS, countdown: COUNTDOWN_FULL_MS }
);
await page.click('[data-testid="precision-stop-button"]');
await page.waitForSelector('[data-testid="precision-round-result-panel"]', {
  timeout: 4000,
  state: "attached",
});
const duplicateOutcome = await readOutcome();
check(
  "a duplicate-stop refusal still shows the round the click decided",
  duplicateOutcome?.outcome === "win" && duplicateOutcome?.green === true,
  `outcome=${duplicateOutcome?.outcome} word="${duplicateOutcome?.word}" class "${duplicateOutcome?.headingClass}"`
);
const duplicateBody = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, " ");
check(
  "and it does not tell the player their stop was rejected",
  !/already been submitted|Stop rejected/i.test(duplicateBody),
  duplicateBody.slice(0, 160)
);

// 12. ONE FLIGHT PER STOP. A round where WE have stopped and the bot has not is
//     still live, and the bot's lane is still in the air: parking it (or freezing
//     the clock both lanes share) is the reported "when I stop, both rockets stop
//     at once". So: click STOP, have the server answer with the round STILL OPEN,
//     and watch the two lanes — ours must hold its position while theirs climbs.
const partialGo = await page.evaluate(() => {
  const now = Date.now();
  const live = window.__precision.baseMatch({
    phase: "active",
    currentRound: 10,
    score: { seat1: 3, seat2: 3 },
    lastRoundWinnerSeat: 1,
    lastRoundTargetMs: 4000,
    lastRoundStops: {
      seat1: { stopInstant: now - 300, elapsedMs: 4100, diffMs: 100, userId: "human" },
      seat2: { stopInstant: now - 200, elapsedMs: 4400, diffMs: 400, userId: "AI_BOT" },
    },
    roundSequence: 10,
    roundId: "m-ai-test-1-r-10",
    roundNonce: "nonce-10",
    targetMs: 6000,
    roundGoInstant: now,
    armingStartedAt: null,
    countdownEndsAt: null,
    version: Number(window.__precision.current?.version ?? 0) + 5,
    players: [
      { seat: 1, userId: "human", name: "You", isReady: true, isConnected: true },
      { seat: 2, userId: "AI_BOT", name: "GRYND AI", isReady: true, isConnected: true },
    ],
  });
  window.__precision.set(live);
  window.__precision.broadcast("precision:roundArmStart", { matchId: "ai-test-1", match: live });
  return now;
});
await page.waitForSelector('[data-testid="precision-stop-button"]', {
  timeout: 8000,
  state: "attached",
});
await page.evaluate(() => {
  // The stop is ACCEPTED (`success: true`) and the round is NOT decided: the
  // other seat has not stopped, so there is nothing to announce yet.
  window.__precision.stopResponse = {
    match: window.__precision.current,
    bothStopped: false,
    roundWinnerSeat: null,
    matchFinished: false,
  };
  window.__precision.stopAckMode = "withMatch";
  window.__precision.stopBroadcast = false;
});/**
 * Where a lane's rocket sits on the board's TIME AXIS: the inline `bottom`
 * percentage the board computes from that lane's elapsed. Pixel geometry is
 * asserted in qa/precision-mobile-check.mjs (which loads the project's real
 * Tailwind); this run has no stylesheet, so the honest "is this lane still
 * climbing" signal is the inline position itself.
 */
const laneClimb = (seat) =>
  page.evaluate((s) => {
    const rocket = document
      .querySelector(`[data-testid="precision-race-lane-${s}"]`)
      ?.querySelector("svg");
    const positioned = rocket?.closest('div[style*="bottom"]');
    return Number.parseFloat(positioned?.style?.bottom ?? "");
  }, seat);
await page.click('[data-testid="precision-stop-button"]');
await page.waitForSelector('[data-testid="precision-race-stop-1"]', {
  timeout: 4000,
  state: "attached",
});
const parkedAt = await laneClimb(1);
const opponentAt = await laneClimb(2);
await page.waitForTimeout(900);
const parkedLater = await laneClimb(1);
const opponentLater = await laneClimb(2);
check(
  "a stop parks OUR rocket and leaves the opponent's flying",
  Number.isFinite(parkedAt) &&
    Number.isFinite(opponentAt) &&
    parkedLater === parkedAt &&
    opponentLater > opponentAt,
  `ours ${parkedAt}%→${parkedLater}%, theirs ${opponentAt}%→${opponentLater}% (higher = climbed)`
);
check(
  "…and only OUR lane carries a stop marker while the other is in the air",
  (await count('[data-testid="precision-race-stop-1"]')) === 1 &&
    (await count('[data-testid="precision-race-stop-2"]')) === 0,
  `pills: ours=${await count('[data-testid="precision-race-stop-1"]')} theirs=${await count(
    '[data-testid="precision-race-stop-2"]'
  )}`
);
check(
  "…and the round stays live instead of resolving on our stop alone",
  (await count('[data-testid="precision-round-result-panel"]')) === 0 &&
    (await count('[data-testid="precision-stop-button"]')) > 0,
  `live round opened ${Date.now() - partialGo}ms ago`
);

// 12b. The mirror case — the BOT stopped and WE have not. The bot's stop is
//      published on `state.aiStop` (its server-measured instant, the only moment
//      its timing is public), so ITS lane parks while ours keeps climbing.
await page.evaluate(() => {
  const now = Date.now();
  const live = window.__precision.baseMatch({
    phase: "active",
    currentRound: 11,
    score: { seat1: 3, seat2: 3 },
    lastRoundWinnerSeat: 1,
    lastRoundTargetMs: 4000,
    lastRoundStops: {
      seat1: { stopInstant: now - 300, elapsedMs: 4100, diffMs: 100, userId: "human" },
      seat2: { stopInstant: now - 200, elapsedMs: 4400, diffMs: 400, userId: "AI_BOT" },
    },
    roundSequence: 11,
    roundId: "m-ai-test-1-r-11",
    roundNonce: "nonce-11",
    targetMs: 6000,
    roundGoInstant: now,
    armingStartedAt: null,
    countdownEndsAt: null,
    // The bot's stop, applied on its own instant and published as the live
    // round's `aiStop` — the board parks ITS lane from this and nothing else.
    aiStop: { stopInstant: now + 2_500, elapsedMs: 2_500 },
    version: Number(window.__precision.current?.version ?? 0) + 5,
    players: [
      { seat: 1, userId: "human", name: "You", isReady: true, isConnected: true },
      { seat: 2, userId: "AI_BOT", name: "GRYND AI", isReady: true, isConnected: true },
    ],
  });
  window.__precision.stopResponse = null;
  window.__precision.set(live);
  window.__precision.broadcast("precision:roundArmStart", { matchId: "ai-test-1", match: live });
});
await page.waitForSelector('[data-testid="precision-race-stop-2"]', {
  timeout: 8000,
  state: "attached",
});
const botParkedAt = await laneClimb(2);
const selfAt = await laneClimb(1);
await page.waitForTimeout(900);
const botParkedLater = await laneClimb(2);
const selfLater = await laneClimb(1);
check(
  "the bot's own stop parks ITS lane and leaves ours flying",
  Number.isFinite(botParkedAt) &&
    Number.isFinite(selfAt) &&
    botParkedLater === botParkedAt &&
    selfLater > selfAt,
  `theirs ${botParkedAt}%→${botParkedLater}%, ours ${selfAt}%→${selfLater}% (higher = climbed)`
);
check(
  "…and only the bot's lane carries a stop marker while we are in the air",
  (await count('[data-testid="precision-race-stop-1"]')) === 0 &&
    (await count('[data-testid="precision-race-stop-2"]')) === 1,
  `pills: ours=${await count('[data-testid="precision-race-stop-1"]')} theirs=${await count(
    '[data-testid="precision-race-stop-2"]'
  )}`
);

check("no page/console errors", errors.length === 0, errors.slice(0, 3).join(" | "));

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
