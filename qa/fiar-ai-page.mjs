// qa/fiar-ai-page.mjs
//
// Shared plumbing for the browser checks that mount the REAL vs-AI
// Four-In-A-Row page (qa/fiar-trail-harness.jsx): the presentation-only stubs,
// the board/harness CSS mirrored from globals.css, and the esbuild +
// static-server helpers. Used by BOTH qa/fiar-trail-check.mjs and
// qa/fiar-turn-check.mjs (AI section) so the two checks cannot drift apart.

import esbuild from "esbuild";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { AUDIO_STUB } from "./fiar-audio.mjs";

export const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// ── Stub the presentation-only imports so the board can mount alone ─────
export const AI_STUBS = [
  {
    match: /^next\/navigation$/,
    source: `export const useRouter = () => ({ push() {}, replace() {}, back() {}, prefetch() {} });\nexport const useParams = () => ({});\nexport const useSearchParams = () => new URLSearchParams();\nexport const usePathname = () => "/";`,
  },
  { match: /^posthog-js\/react$/, source: `export const usePostHog = () => null;` },
  { match: /components\/navigation-bar$/, source: `export default function NavigationBar() { return null; }` },
  { match: /components\/IconAvatar$/, source: `export default function IconAvatar() { return null; }` },
  {
    match: /hooks\/useMySeatIdentity$/,
    source: `export default function useMySeatIdentity() { return { name: null, iconKey: null, nameColor: null }; }`,
  },
  {
    match: /creator-mode\/CreatorModeHost$/,
    source: `export default function CreatorModeHost({ children }) { return children; }`,
  },
  { match: /creator-mode\/CreatorResultOverlay$/, source: `export default function CreatorResultOverlay() { return null; }` },
  // Records which sound cues the page asks for (and how many times) so the
  // audio check can assert on them; the real audio module still runs.
  AUDIO_STUB,
  {
    match: /creator-mode\/CreatorModeLayout$/,
    source: `const Null = () => null;\nexport const CreatorModeShell = Null;\nexport const CreatorView = ({ normal }) => normal;\nexport const CreatorPhoneFrame = Null;\nexport const ShellMain = Null;\nexport const ShellHeader = Null;\nexport const ShellAside = Null;\nexport default Null;`,
  },
];

// Only the board geometry + the four-in-a-row rules the checks read (the
// harness does not load the real stylesheet).
export const AI_HARNESS_CSS = `
  * { box-sizing: border-box; }
  body { margin: 0; background: #05070f; }
  #root { width: var(--board-width, 560px); }
  .four-in-a-row-board { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 8px; padding: 12px; }
  .four-in-a-row-disc { aspect-ratio: 1; width: 100%; border-radius: 999px; }
  .four-in-a-row-slot { background: #061b3b; }
  .four-in-a-row-disc-blue { background: rgb(2, 132, 199); }
  .four-in-a-row-disc-purple { background: rgb(147, 51, 234); }
  .four-in-a-row-drop-controls { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 8px; }
  .four-in-a-row-drop-button { height: 32px; }
  /* Interaction-feedback rules mirrored from globals.css. */
  .four-in-a-row-column-hint { border-radius: .9rem; background: rgba(0, 229, 255, .08); border: 1px solid rgba(0, 229, 255, .38); pointer-events: none; }
  .four-in-a-row-preview { opacity: .4; pointer-events: none; }
  .four-in-a-row-preview--pending { opacity: .66; }
  /* Turn / state hierarchy (mirrored from globals.css). The page adds the
     relative utility to each chip; the harness has no Tailwind, so it is
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
  /* Opponent/AI activity cue (mirrored from globals.css). */
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
`;

/**
 * Bundle qa/fiar-trail-harness.jsx with the AI-page stubs and serve it.
 * Returns `{ base, close }` — the page URL and a shutdown function.
 */
export async function mountAiHarness({ title = "Four-In-A-Row vs-AI check" } = {}) {
  const outDir = mkdtempSync(join(tmpdir(), "fiar-ai-"));
  const bundleOut = join(outDir, "harness.js");
  await esbuild.build({
    entryPoints: [join(root, "qa/fiar-trail-harness.jsx")],
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
          for (const stub of AI_STUBS) {
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
<style>${AI_HARNESS_CSS}</style></head>
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
