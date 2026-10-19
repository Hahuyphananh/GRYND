// qa/joiner-first-hex-check.mjs
//
// Live browser check for the joiner-first rule in Hex Duel.
//
// The server writes currentTurn: "player2" when the guest joins (join route +
// quick queue), and the page's local engine now opens on that same seat. This
// bundles the REAL online match page (qa/joiner-first-hex-harness.jsx) with the
// status payload mocked and proves, in Chromium:
//
//   1. guest seat + currentTurn "player2" → the status bar says YOUR TURN and
//      the End Turn button is visible/enabled.
//   2. Clicking it records an endTurn action, and the turn update it posts is
//      player1's — i.e. the guest really owned the opening turn.
//   3. host seat, same currentTurn → the opposite: the host is told it is the
//      opponent's turn and cannot act.
//
// Run: node qa/joiner-first-hex-check.mjs

import esbuild from "esbuild";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import autoprefixer from "autoprefixer";
import { chromium } from "playwright";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "joiner-first-hex-"));

const STUBS = {
  "next/navigation": `
    export const useRouter = () => ({ push(){}, replace(){}, back(){}, refresh(){}, prefetch(){} });
    export const usePathname = () => "/casino/hex-duel/game/42";
    export const useParams = () => ({ matchId: window.__hex.route.matchId });
    export const useSearchParams = () => new URLSearchParams(window.__hex.route.search);
    export default { useRouter, usePathname, useParams, useSearchParams };
  `,
  "next/image": `import React from "react"; export default function Img() { return null; }`,
  "next/link": `import React from "react"; export default function Link({ children }) { return children ?? null; }`,
  "posthog-js/react": `export const usePostHog = () => null; export default {};`,
  "@clerk/nextjs": `
    export const useUser = () => ({ isLoaded: true, isSignedIn: true, user: { id: "guest1", username: "Guest" } });
    export const useAuth = () => ({ isLoaded: true, isSignedIn: true, userId: "guest1" });
    export const useClerk = () => ({ signOut() {} });
  `,
  "context/SocketProvider": `
    export const useSocket = () => ({ socket: window.__hex.socket });
    export const SocketProvider = ({ children }) => children;
    export default { useSocket, SocketProvider };
  `,
  "components/navigation-bar": `export default function Nav() { return null; }`,
  "components/Footer": `export default function Footer() { return null; }`,
  "components/lobby/MatchWaiting": `
    import React from "react";
    export default function MatchWaiting() { return React.createElement("div", { "data-testid": "waiting" }); }
  `,
  "components/lobby/PvpLobby": `
    export const useFirstVisitRules = () => false;
    export const RulesModal = () => null;
    export default { RulesModal, useFirstVisitRules };
  `,
  "components/game/EmotePicker": `
    import React from "react";
    export const EmoteBubble = () => null;
    export default function EmotePicker() { return null; }
  `,
  "components/ReportModal": `export default function ReportModal() { return null; }`,
  "lib/hexAudio": `
    export function useHexAudio() {
      return { enabled: false, setEnabled() {}, playSelect() {}, playMove() {}, playCapture() {},
        playPush() {}, playPowerNode() {}, playTurnSwitch() {}, playVictory() {}, playDefeat() {} };
    }
  `,
  "hooks/useGameEmotes": `
    export const useGameEmotes = () => ({ incomingEmote: null, myEmote: null, sendEmote: () => {} });
    export default () => ({ incomingEmote: null, myEmote: null, sendEmote: () => {} });
  `,
  "hooks/useActiveGamePresence": `export const useActiveGamePresence = () => {}; export default () => {};`,
  "hooks/useRecordPlayedGame": `export const useRecordPlayedGame = () => {}; export default () => {};`,
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
  entryPoints: [join(root, "qa/joiner-first-hex-harness.jsx")],
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
      name: "hex-stubs",
      setup(build) {
        build.onResolve({ filter: /.*/ }, (args) => {
          const key = matchStubKey(args.path, args.resolveDir);
          if (!key) return null;
          return { path: key, namespace: "hex-stub" };
        });
        build.onLoad({ filter: /.*/, namespace: "hex-stub" }, (args) => ({
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
  `<!doctype html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Hex Duel joiner-first check</title>
<link rel="stylesheet" href="./app.css"></head>
<body><div id="root"></div><script src="./harness.js"></script></body></html>`,
);

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${extra ? " — " + extra : ""}`);
  ok ? pass++ : fail++;
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("pageerror", (err) => errors.push(String(err)));

// CSS, not role: the host's button is `visibility: hidden` (out of the a11y
// tree) but must still be present and disabled so the row never collapses.
const endTurnButton = () => page.locator('button:has-text("End Turn")').first();

try {
  await page.goto(pathToFileURL(join(outDir, "index.html")).href, { waitUntil: "load" });

  // ── The guest opens the match ───────────────────────────────────────────
  await page.waitForSelector("[data-hex-board]");
  await page.waitForFunction(() =>
    document.body.textContent.includes("YOUR TURN"),
  );
  check(
    "guest seat: the opening turn is the guest's",
    await endTurnButton().isVisible(),
    "End Turn button is visible",
  );
  check(
    "guest seat: End Turn is enabled",
    (await endTurnButton().isDisabled()) === false,
  );

  const before = await page.evaluate(() => window.__hex.posts.length);
  await endTurnButton().click();
  await page.waitForFunction(
    (count) =>
      window.__hex.posts
        .slice(count)
        .some((p) => p.url.includes("/api/hex-duel/multiplayer/action")),
    before,
  );
  const guestPosts = await page.evaluate(() => window.__hex.posts);
  const endTurnPost = guestPosts.find(
    (p) =>
      p.url.includes("/api/hex-duel/multiplayer/action") &&
      p.body?.actionType === "endTurn",
  );
  check(
    "guest seat: clicking End Turn records the opening endTurn",
    Boolean(endTurnPost),
    JSON.stringify(endTurnPost?.body ?? null),
  );

  // The client only posts a turn update when the LOCAL seat just finished.
  const turnPost = guestPosts.find(
    (p) =>
      p.url.includes("/api/hex-duel/multiplayer/status") &&
      p.body?.turn === "player1",
  );
  check(
    "guest seat: the turn passes to player1 (the host)",
    Boolean(turnPost),
    JSON.stringify(turnPost?.body ?? null),
  );

  // ── The host sees the same opening turn as the opponent's ──────────────
  await page.evaluate(() => window.mountMatch({ amHost: true }));
  await page.waitForSelector("[data-hex-board]");
  await page.waitForFunction(() =>
    document.body.textContent.includes("OPPONENT'S TURN"),
  );
  check(
    "host seat: the joiner's opening turn is not playable",
    await endTurnButton().isDisabled(),
    "End Turn button disabled",
  );

  check("no runtime errors", errors.length === 0, errors.join(" | "));
} finally {
  await browser.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
