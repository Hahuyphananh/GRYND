// qa/fiar-multiplayer-page.mjs
//
// Shared plumbing for the browser checks that mount the REAL multiplayer
// Four-In-A-Row page (qa/fiar-winline-harness.jsx): the presentation-only
// stubs, the board/harness CSS mirrored from globals.css, and the esbuild +
// static-server helpers. Used by BOTH qa/fiar-winline-check.mjs and
// qa/fiar-turn-check.mjs so the two checks cannot drift apart.

import esbuild from "esbuild";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { AUDIO_STUB } from "./fiar-audio.mjs";

export const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// ── Presentation-only stubs so the page can mount alone ────────────────
export const STUBS = [
  {
    match: /^next\/navigation$/,
    source: `export const useParams = () => ({ gameId: "1" });\nexport const useRouter = () => ({ push() {}, replace() {}, back() {}, prefetch() {} });\nexport const useSearchParams = () => new URLSearchParams();\nexport const usePathname = () => "/";`,
  },
  { match: /context\/SocketProvider$/, source: `export const useSocket = () => ({ socket: null });` },
  {
    match: /components\/game\/EmotePicker$/,
    source: `export default function EmotePicker() { return null; }\nexport const EmoteBubble = () => null;`,
  },
  {
    match: /hooks\/useGameEmotes$/,
    source: `export default function useGameEmotes() { return { incomingEmote: null, myEmote: null, sendEmote() {} }; }`,
  },
  {
    match: /lib\/creator-mode\/audioTap$/,
    source: `export const getSharedAudioContext = () => null;\nexport const getSharedOutputNode = () => null;`,
  },
  // Records which sound cues the page asks for (and how many times) so the
  // audio check can assert on them; the real audio module still runs.
  AUDIO_STUB,
  { match: /hooks\/useGamePresence$/, source: `export default function useGamePresence() { return {}; }` },
  { match: /components\/ReportModal$/, source: `export default function ReportModal() { return null; }` },
  {
    // Mirrors the real component's CONTRACT: its root is a motion element that
    // declares an exit fade. That is what lets the checks verify the page hands
    // it presence context (i.e. keeps it mounted through the exit) instead of
    // removing it instantly.
    match: /components\/lobby\/MatchWaiting$/,
    source: `import { createElement } from "react";\nimport { motion } from "framer-motion";\nexport default function MatchWaiting({ state }) {\n  return createElement(motion.div, {\n    "data-testid": "fiar-match-waiting",\n    "data-state": state,\n    initial: { opacity: 0 },\n    animate: { opacity: 1 },\n    exit: { opacity: 0 },\n    transition: { duration: 0.25 },\n    style: { position: "fixed", inset: 0, background: "#061b3d" },\n  });\n}`,
  },
  {
    // Renders the props the page PASSES (the outcome, the opponent and the
    // "here is how it ended" slot) so the checks can verify the page's result
    // wiring, not merely that a panel mounted. The real component's styling,
    // entrance animation and CTAs are not stubbed in.
    match: /components\/result\/PvpResultScreen$/,
    source: `import { createElement } from "react";\nexport default function PvpResultScreen({ open, outcome, extraContent, opponent }) {\n  if (!open) return null;\n  return createElement(\n    "div",\n    { "data-testid": "fiar-result-overlay", "data-outcome": outcome },\n    createElement("span", { key: "opponent", "data-testid": "fiar-result-opponent" }, (opponent && opponent.name) || ""),\n    extraContent ? createElement("div", { key: "extra", "data-testid": "fiar-result-extra" }, extraContent) : null,\n  );\n}`,
  },
  { match: /components\/IconAvatar$/, source: `export default function IconAvatar() { return null; }` },
  { match: /lib\/animations$/, source: `export const turnBanner = {};` },
  {
    match: /creator-mode\/CreatorModeHost$/,
    source: `export default function CreatorModeHost({ children }) { return children; }`,
  },
  {
    match: /creator-mode\/CreatorModeLayout$/,
    source: `const Null = () => null;\nexport const CreatorModeShell = Null;\nexport const CreatorView = ({ normal }) => normal;\nexport const CreatorPhoneFrame = Null;\nexport const ShellMain = Null;\nexport const ShellHeader = Null;\nexport const ShellAside = Null;\nexport default Null;`,
  },
  {
    match: /^@tabler\/icons-react$/,
    source: `export const IconTarget = () => null;\nexport const IconEye = () => null;\nexport const IconFlag = () => null;`,
  },
];

// Board geometry + the win-emphasis and turn/state rules mirrored from
// globals.css (the harness does not load the real stylesheet).
export const HARNESS_CSS = `
  * { box-sizing: border-box; }
  body { margin: 0; background: #05070f; }
  #root { width: var(--board-width, 560px); }
  .four-in-a-row-board { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 8px; padding: 12px; position: relative; }
  .four-in-a-row-disc { aspect-ratio: 1; width: 100%; border-radius: 999px; }
  .four-in-a-row-slot { background: #061b3b; }
  .four-in-a-row-disc-blue { background: rgb(2, 132, 199); }
  .four-in-a-row-disc-purple { background: rgb(147, 51, 234); }
  .four-in-a-row-drop-controls { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 8px; }
  .four-in-a-row-win {
    position: relative; z-index: 2;
    outline: 3px solid rgba(255, 228, 121, .95); outline-offset: 2px;
    filter: brightness(1.08);
    animation: fourInARowWin .34s ease-out both;
    animation-delay: calc(var(--win-order, 0) * 90ms);
  }
  @keyframes fourInARowWin { 0% { transform: scale(.88); } 60% { transform: scale(1.1); } 100% { transform: scale(1); } }
  .four-in-a-row-dim { opacity: .5; filter: saturate(.5) brightness(.78); }
  /* Turn / state hierarchy (mirrored from globals.css). The pages add the
     relative utility to each card; the harness has no Tailwind, so it is
     folded into the shared base rule. */
  .four-in-a-row-player { position: relative; transition: box-shadow .2s ease, opacity .2s ease; }
  .four-in-a-row-player--active { box-shadow: 0 0 0 2px rgba(255, 255, 255, .16), 0 0 18px rgba(250, 204, 21, .22); }
  .four-in-a-row-player--idle { opacity: .55; }
  .four-in-a-row-turn-line { margin-bottom: .4rem; font-size: .7rem; font-weight: 800; letter-spacing: .18em; text-transform: uppercase; }
  .four-in-a-row-turn-line--mine { color: rgb(245, 255, 59); }
  .four-in-a-row-turn-line--theirs, .four-in-a-row-turn-line--thinking { color: rgba(255, 255, 255, .45); }
  .four-in-a-row-turn-line--locked { color: rgb(124, 239, 255); }
  .four-in-a-row-drop-controls--locked { opacity: .5; pointer-events: none; transition: opacity .2s ease; }
  @media (prefers-reduced-motion: reduce) {
    .four-in-a-row-player, .four-in-a-row-turn-line, .four-in-a-row-drop-controls--locked { transition: none; }
  }
  /* Opponent activity cue (mirrored from globals.css). */
  .four-in-a-row-opponent-cue {
    position: absolute; inset: 0; border-radius: inherit;
    border: 2px solid var(--cue-color, rgba(125, 211, 252, .7));
    opacity: 0; pointer-events: none;
    animation: fourInARowOpponentCue .5s ease-out both;
  }
  @keyframes fourInARowOpponentCue {
    0% { opacity: .72; transform: scale(1); }
    70% { opacity: .26; transform: scale(1.035); }
    100% { opacity: 0; transform: scale(1.05); }
  }
  @media (prefers-reduced-motion: reduce) {
    .four-in-a-row-opponent-cue { animation: none; opacity: 0; }
  }
  .four-in-a-row-turn-pill {
    border-radius: 999px; border: 1px solid rgba(250, 204, 21, .5);
    background: rgba(3, 19, 43, .92); padding: .3rem .9rem;
    font-size: .7rem; font-weight: 800; letter-spacing: .18em;
    text-transform: uppercase; color: rgb(245, 255, 59);
  }
  @media (prefers-reduced-motion: reduce) {
    .four-in-a-row-win { animation: none; }
    .four-in-a-row-dim { transition: none; }
  }
`;

/**
 * Bundle qa/fiar-winline-harness.jsx with the shared stubs and serve it.
 * Returns `{ base, close }` — the page URL and a shutdown function.
 */
export async function mountHarness({ title = "Four-In-A-Row check" } = {}) {
  const outDir = mkdtempSync(join(tmpdir(), "fiar-mp-"));
  const bundleOut = join(outDir, "harness.js");
  await esbuild.build({
    entryPoints: [join(root, "qa/fiar-winline-harness.jsx")],
    bundle: true,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    outfile: bundleOut,
    logLevel: "error",
    absWorkingDir: root,
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [
      {
        name: "page-stubs",
        setup(build) {
          for (const stub of STUBS) {
            const path = `stub:${stub.match.source}`;
            build.onResolve({ filter: stub.match }, () => ({ path, namespace: "page-stub" }));
            build.onLoad({ filter: new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) }, () => ({
              contents: stub.source,
              loader: "js",
              resolveDir: root,
            }));
          }
        },
      },
    ],
  });
  const harnessJs = readFileSync(bundleOut, "utf8");

  const pageHtml = `<!doctype html>
<html><head><meta charset="utf-8"><title>${title}</title>
<style>${HARNESS_CSS}</style></head>
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
    res.writeHead(404);
    res.end("not found");
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => server.close() };
}
