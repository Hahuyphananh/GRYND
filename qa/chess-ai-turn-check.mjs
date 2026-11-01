// qa/chess-ai-turn-check.mjs
//
// Drives the REAL vs-AI chess board in a browser against a scripted chess
// backend and proves the bot's turn actually completes — on BOTH paths the page
// can take:
//
//   * SERVER-BACKED (?gameId=…): the human's move is POSTed to
//     /api/chess/move, the bot's turn is requested from /api/chess/ai-move, and
//     the reply lands on the board.
//   * BARE PRACTICE BOARD (no gameId): the local minimax opens for the bot.
//
// Run: node qa/chess-ai-turn-check.mjs

import esbuild from "esbuild";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import autoprefixer from "autoprefixer";
import { chromium } from "playwright";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "chess-ai-turn-"));
const REPORTS = join(root, "qa", "reports");
mkdirSync(REPORTS, { recursive: true });

const GAME_ID = "11111111-1111-4111-8111-111111111111";

const STUBS = {
  "next/navigation": `
    // ?local=1 loads the bare practice board (no game row) the page falls back
    // to when it is opened without a gameId.
    const local = /(?:[?&])local=1/.test(window.location.search);
    const params = new URLSearchParams(
      local
        ? { difficulty: "3", timer: "300", color: "white" }
        : { gameId: "${GAME_ID}", difficulty: "3", timer: "300", color: "white" },
    );
    const router = { push(){}, replace(){}, back(){}, refresh(){}, prefetch(){} };
    export const useRouter = () => router;
    export const usePathname = () => "/casino/chess/ai";
    export const useSearchParams = () => params;
    export default { useRouter, usePathname, useSearchParams };
  `,
  "next/dynamic": `
    import React from "react";
    import { Chessboard } from "react-chessboard";
    // The board is this page's only dynamic import, and it is stubbed below,
    // so the wrapper binds it directly instead of waiting on a chunk.
    export default function dynamic() {
      return function DynamicBoard(props) {
        return React.createElement(Chessboard, props);
      };
    }
  `,
  "posthog-js/react": `export const usePostHog = () => null;`,
  // A stand-in for react-chessboard: 64 clickable squares that report the
  // square and the piece on it, exactly as the real board's onSquareClick does.
  // The page's click-to-move, its persistence POST and its AI turn are what
  // this check is about, and none of them depend on how the board is drawn.
  "react-chessboard": `
    import React from "react";
    import { Chess } from "chess.js";
    export function Chessboard({ position, onSquareClick }) {
      if (typeof window !== "undefined") window.__boardPosition = position;
      const board = new Chess(position).board();
      const squares = [];
      for (let r = 0; r < 8; r++) {
        for (let f = 0; f < 8; f++) {
          const piece = board[r][f];
          squares.push({
            square: "abcdefgh"[f] + (8 - r),
            piece: piece ? piece.color + piece.type.toUpperCase() : "",
          });
        }
      }
      return React.createElement(
        "div",
        { id: "qa-board", style: { display: "grid", gridTemplateColumns: "repeat(8, 32px)" } },
        squares.map(({ square, piece }) =>
          React.createElement("div", {
            key: square,
            "data-square": square,
            "data-piece": piece,
            onClick: () => onSquareClick(square, piece || undefined),
            style: { width: 32, height: 32, background: piece ? "#2a6" : "#222" },
          }),
        ),
      );
    }
    export default Chessboard;
  `,
  "hooks/useMySeatIdentity": `
    export default function useMySeatIdentity() {
      return { name: "QA Player", iconKey: null, profileFrame: null, nameColor: null, isGuest: true };
    }
  `,
  "components/navigation-bar": `export default function NavigationBar() { return null; }`,
  "components/GameSessionHost": `export default function GameSessionHost({ children }) { return children ?? null; }`,
  "components/game/PracticePause": `
    export const PracticePauseChip = () => null;
    export const PracticePauseOverlay = () => null;
  `,
  "components/result/PvpResultScreen": `export default function PvpResultScreen() { return null; }`,
  "components/FrameAvatar": `export default function FrameAvatar() { return null; }`,
  "lib/gameAudio": `
    export const playCardDraw = () => {};
    export const playVictory = () => {};
    export const playDefeat = () => {};
    export const playTick = () => {};
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
  entryPoints: [join(root, "qa/chess-ai-turn-harness.jsx")],
  bundle: true,
  format: "iife",
  platform: "browser",
  jsx: "automatic",
  loader: { ".js": "jsx" },
  outfile: join(outDir, "harness.js"),
  logLevel: "error",
  absWorkingDir: root,
  define: { "process.env.NODE_ENV": '"development"' },
  banner: {
    js: 'var process = { env: { NODE_ENV: "development" }, platform: "browser", browser: true, version: "v0.0.0" };',
  },
  plugins: [
    {
      name: "qa-stubs",
      setup(build) {
        build.onResolve({ filter: /.*/ }, (args) => {
          const key = matchStubKey(args.path, args.resolveDir);
          if (!key) return null;
          return { path: key, namespace: "qa-stub" };
        });
        build.onLoad({ filter: /.*/, namespace: "qa-stub" }, (args) => ({
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
<title>Chess AI turn check</title>
<link rel="stylesheet" href="./app.css"></head>
<body><div id="root"></div><script src="./harness.js"></script></body></html>`,
);

const server = createServer((req, res) => {
  const rawPath = req.url === "/" ? "/index.html" : req.url.split("?")[0];
  let path;
  try {
    path = decodeURIComponent(rawPath);
  } catch {
    res.writeHead(400);
    res.end("bad request");
    return;
  }
  const requestedFile = path.replace(/^\/+/, "");
  const allowedFiles = new Set(["index.html", "app.css", "harness.js"]);
  if (!allowedFiles.has(requestedFile)) {
    res.writeHead(404);
    res.end("not found");
    return;
  }
  const rootDir = resolve(outDir);
  const filePath = resolve(rootDir, requestedFile);
  if (filePath !== rootDir && !filePath.startsWith(rootDir + sep)) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }
  try {
    const buf = readFileSync(filePath);
    res.writeHead(200, {
      "Content-Type": path.endsWith(".css")
        ? "text/css"
        : path.endsWith(".js")
          ? "text/javascript"
          : "text/html",
    });
    res.end(buf);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}/index.html`;

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${extra ? " — " + extra : ""}`);
  ok ? pass++ : fail++;
};

const browser = await chromium.launch({ channel: "chrome", headless: true });

/** The placement field of a FEN as `{ e4: "P", ... }`. */
function pieces(fen) {
  const map = {};
  const rows = String(fen).split(" ")[0].split("/");
  rows.forEach((row, index) => {
    let file = 0;
    for (const char of row) {
      if (/\d/.test(char)) {
        file += Number(char);
        continue;
      }
      map["abcdefgh"[file] + (8 - index)] = char;
      file += 1;
    }
  });
  return map;
}

/** True when any black piece has left its starting square. */
function blackMoved(placement) {
  const start = {
    a8: "r", b8: "n", c8: "b", d8: "q", e8: "k", f8: "b", g8: "n", h8: "r",
    a7: "p", b7: "p", c7: "p", d7: "p", e7: "p", f7: "p", g7: "p", h7: "p",
  };
  return Object.keys(start).some((square) => placement[square] !== start[square]);
}

/**
 * Opens one board, plays e2e4, and reports what happened.
 *
 * `local` loads the bare practice board (no gameId in the URL); otherwise the
 * page runs its server-authoritative flow against the scripted backend.
 */
async function playOneMove({ label, local }) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  const page = await context.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  page.on("pageerror", (error) => pageErrors.push(String(error.message)));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    // A 404 for the page's own decorative assets (a favicon) says nothing about
    // the board; every API call in this check is scripted in the harness.
    if (/Failed to load resource/.test(message.text())) return;
    consoleErrors.push(message.text());
  });

  console.log(`\n── ${label} ──`);
  await page.goto(local ? `${base}?local=1` : base, { waitUntil: "load" });
  await page.waitForFunction(() => Boolean(window.__qa), null, { timeout: 15000 });
  await page.waitForSelector('[data-square="e2"]', { state: "attached", timeout: 15000 });

  const clickSquare = (square) =>
    page.evaluate((sq) => {
      const el = document.querySelector(`[data-square="${sq}"]`);
      if (!el) throw new Error(`no square ${sq}`);
      el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }, square);

  await clickSquare("e2");
  await page.waitForTimeout(150);
  await clickSquare("e4");

  try {
    // The scripted backend records the bot's move before the page can apply it,
    // so wait for the BOARD to show the human's turn again — that is the state
    // being asserted, not the server's.
    await page.waitForFunction(
      () =>
        window.__qa.moves().length >= 2 &&
        String(window.__boardPosition || "").split(" ")[1] === "w",
      null,
      { timeout: 8000 },
    );
  } catch {
    // Reported by the assertions below.
  }

  const state = await page.evaluate(() => ({
    moves: window.__qa.moves(),
    calls: window.__qa.calls(),
    board: window.__boardPosition,
  }));
  const placement = pieces(state.board || "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
  const turn = String(state.board || "").split(" ")[1];
  const humanPlayed = placement.e4 === "P" && !placement.e2;
  const botReplied = local ? blackMoved(placement) : state.moves.length === 2;
  const count = (name) => state.calls.filter((call) => call === name).length;
  const bodyText = (await page.textContent("body")) || "";

  console.log("calls:", state.calls.join(" | ") || "(none)");
  console.log("moves:", state.moves.join(" ") || "(local board)", "| turn:", turn);

  check(`${label}: the human's move was played`, humanPlayed, `board=${state.board}`);
  check(`${label}: the bot replied`, botReplied, `moves=${state.moves.join(" ")} board=${state.board}`);
  check(`${label}: the board is the human's again`, turn === "w", `turn=${turn}`);
  if (!local) {
    check(`${label}: the human's move was persisted once`, count("POST /api/chess/move") === 1);
    check(`${label}: the bot's turn was requested`, count("POST /api/chess/ai-move") >= 1);
    check(`${label}: no re-request loop`, count("POST /api/chess/ai-move") <= 2, `calls=${count("POST /api/chess/ai-move")}`);
  }
  check(`${label}: no page error`, pageErrors.length === 0, pageErrors.join(" / "));
  check(`${label}: no console error`, consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" / "));

  if (!humanPlayed || !botReplied) {
    console.log("\n--- page text ---\n" + bodyText.replace(/\s+/g, " ").slice(0, 900));
    await page.screenshot({ path: join(REPORTS, `chess-ai-turn-${local ? "local" : "server"}.png`), fullPage: true });
  }

  await context.close();
}

/**
 * Plays e2e4 against a backend whose bot turn FAILS, and reports how the board
 * copes. A failed turn must not be retried forever, and the page must end up
 * telling the player what happened (the "Retry AI move" affordance) instead of
 * spinning "AI is thinking…" indefinitely.
 */
async function probeFailedTurn({ mode, budgetMs }) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(String(error.message)));

  console.log(`\n── failing bot turn (${mode}) ──`);
  await page.goto(`${base}?mode=${mode}`, { waitUntil: "load" });
  await page.waitForSelector('[data-square="e2"]', { state: "attached", timeout: 15000 });

  const clickSquare = (square) =>
    page.evaluate((sq) => {
      const el = document.querySelector(`[data-square="${sq}"]`);
      if (!el) throw new Error(`no square ${sq}`);
      el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }, square);

  await clickSquare("e2");
  await page.waitForTimeout(150);
  await clickSquare("e4");
  await page.waitForTimeout(budgetMs);

  const state = await page.evaluate(() => ({
    calls: window.__qa.calls(),
    text: (document.body.textContent || "").replace(/\s+/g, " "),
  }));
  const attempts = state.calls.filter((call) => call === "POST /api/chess/ai-move").length;
  console.log("ai-move attempts:", attempts);

  check(`${mode}: the failed turn is not retried forever`, attempts <= 4, `attempts=${attempts}`);
  check(
    `${mode}: the player is told, with a retry affordance`,
    /Retry AI move/.test(state.text),
    state.text.slice(0, 200),
  );
  check(
    `${mode}: the board does not claim to be thinking forever`,
    !/AI is thinking/.test(state.text),
    state.text.slice(0, 200),
  );
  check(`${mode}: no page error`, pageErrors.length === 0, pageErrors.join(" / "));

  await context.close();
}

await playOneMove({ label: "server-backed game", local: false });
await playOneMove({ label: "bare practice board", local: true });
await probeFailedTurn({ mode: "error", budgetMs: 6000 });
await probeFailedTurn({ mode: "stall", budgetMs: 6000 });
await probeFailedTurn({ mode: "hang", budgetMs: 25000 });

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
