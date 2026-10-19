// qa/hex-duel-lobby-check.mjs
//
// Drives the REAL Hex Duel lobby (qa/hex-duel-lobby-harness.jsx) against a
// scripted backend and asserts the split the request asked for actually exists
// in the browser:
//
//   1. The lobby renders its own chrome — title, stake picker, Create PvP,
//      Play vs AI, the open-table list and the live-games card. No board, and
//      no create-game popup.
//   2. CREATE PvP calls /api/hex-duel/multiplayer/create and navigates to the
//      MATCH route, `/casino/hex-duel/game/<id>?host=1` — never to the lobby
//      URL the game used to play on.
//   3. PLAY VS AI calls /api/hex-duel/start-game (free, `isAiGame`) and
//      navigates to `/casino/hex-duel/game/ai?difficulty=…&session=…`.
//   4. JOIN on a listed table calls /api/hex-duel/multiplayer/join with that
//      table's id and navigates to `/casino/hex-duel/game/<id>?host=0`.
//   5. Nothing throws.
//
// Run: node qa/hex-duel-lobby-check.mjs

import esbuild from "esbuild";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import autoprefixer from "autoprefixer";
import { chromium } from "playwright";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "hex-duel-lobby-"));

const STUBS = {
  "@clerk/nextjs": `
    export const useUser = () => ({
      isLoaded: true,
      isSignedIn: true,
      user: { id: "user_1", username: "LobbyTester", firstName: "Lobby", fullName: "Lobby Tester" },
    });
    export const useAuth = () => ({ isLoaded: true, isSignedIn: true, userId: "user_1" });
    export const useClerk = () => ({ signOut() {} });
  `,
  "components/SignOutButton": `
    import React from "react";
    export const SignOutButton = ({ children }) => children ?? null;
    export default SignOutButton;
  `,
  "components/AddFundsModal": `export default function M() { return null; }`,
  "components/BattlepassClaimBadge": `export default function B() { return null; }`,
  // The router RECORDS instead of navigating: the check asserts the destination
  // the lobby asked for, which is the whole point of the split.
  "next/navigation": `
    const record = (href) => {
      if (typeof window !== "undefined" && Array.isArray(window.__pushes)) {
        window.__pushes.push(String(href));
      }
    };
    const router = {
      push: record,
      replace: record,
      back() {},
      forward() {},
      refresh() {},
      prefetch() {},
    };
    export const useRouter = () => router;
    export const usePathname = () => "/casino/hex-duel";
    export const useParams = () => ({});
    export const useSearchParams = () => new URLSearchParams();
    export default { useRouter, usePathname, useParams, useSearchParams };
  `,
  "next/image": `import React from "react"; export default function Img() { return null; }`,
  "next/link": `
    import React from "react";
    export default function Link({ href, children, ...rest }) {
      return React.createElement("a", { href, ...rest }, children);
    }
  `,
  "posthog-js/react": `
    export const usePostHog = () => null;
    export const PostHogProvider = ({ children }) => children;
  `,
  // No socket in the harness: the lobby falls back to its polling cadence, which
  // is exactly the path a player on a flaky connection uses.
  "context/SocketProvider": `
    export const useSocket = () => ({ socket: null, connected: false, status: "disconnected" });
    export const SocketProvider = ({ children }) => children;
    export default { useSocket, SocketProvider };
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
  entryPoints: [join(root, "qa/hex-duel-lobby-harness.jsx")],
  bundle: true,
  format: "iife",
  platform: "browser",
  jsx: "automatic",
  loader: {
    ".js": "jsx",
    ".png": "dataurl",
    ".jpg": "dataurl",
    ".svg": "dataurl",
    ".webp": "dataurl",
  },
  outfile: join(outDir, "harness.js"),
  logLevel: "error",
  absWorkingDir: root,
  define: { "process.env.NODE_ENV": '"development"' },
  banner: {
    js: 'var process = { env: { NODE_ENV: "development" }, platform: "browser", browser: true, version: "v0.0.0" };',
  },
  plugins: [
    {
      name: "hex-lobby-stubs",
      setup(build) {
        build.onResolve({ filter: /.*/ }, (args) => {
          const key = matchStubKey(args.path, args.resolveDir);
          if (!key) return null;
          return { path: key, namespace: "hex-lobby-stub" };
        });
        build.onLoad({ filter: /.*/, namespace: "hex-lobby-stub" }, (args) => ({
          contents: STUBS[args.path],
          loader: "jsx",
          resolveDir: root,
        }));
      },
    },
  ],
});

// Real Tailwind CSS, so a layout that only exists because of a class is measured
// as it ships rather than as bare HTML.
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
<title>Hex Duel lobby check</title>
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
const origin = `http://127.0.0.1:${server.address().port}/index.html`;

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${extra ? " — " + extra : ""}`);
  ok ? pass++ : fail++;
};

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e.message)));
page.on("console", (m) => {
  const where = m.location?.()?.url || "";
  const staticAssetNoise = /Failed to load resource/.test(m.text()) && !where.includes("/api/");
  if (m.type() === "error" && !staticAssetNoise) {
    pageErrors.push(`${m.text()} (${where})`);
  }
});

await page.addInitScript(() => {
  window.__pushes = [];
  try {
    // Look like a RETURNING player: the shared chrome auto-opens the "How to
    // Play" modal once per game (keyed by `rulesKey`), and the splash / cookie
    // banner cover the page on a first visit. All three are overlays that would
    // swallow the clicks; none of them is under test here.
    window.localStorage.setItem("casino-rules-seen:hex-duel", "1");
    window.localStorage.setItem("grynd_cookie_consent", "declined");
    window.sessionStorage.setItem("grynd:splash:seen:v1", "1");
  } catch {
    /* storage unavailable — the waits below still cover it */
  }
});

await page.goto(origin);
await page.waitForSelector("h1", { timeout: 20000 });
await page.waitForTimeout(600); // first /available answer + a paint

const pushes = () => page.evaluate(() => (window.__pushes || []).slice());
const requests = () => page.evaluate(() => (window.__world?.requests || []).slice());
const bodies = () =>
  page.evaluate(() => ({
    create: window.__world?.lastCreateBody ?? null,
    join: window.__world?.lastJoinBody ?? null,
    ai: window.__world?.lastAiBody ?? null,
  }));
// `innerText` applies CSS `text-transform`, and the lobby headings are
// uppercase — so compare lowercased rather than pinning a casing the markup
// does not itself carry.
const bodyText = async () => (await page.locator("body").innerText()).toLowerCase();

// ── 1. The lobby itself ────────────────────────────────────────────────────
check(
  "the lobby is Hex Duel's own page, not the match page",
  (await page.getByRole("heading", { level: 1 }).innerText()).includes("Hex Duel"),
);
check(
  "no board is mounted on the lobby",
  (await page.locator("[data-hex-board]").count()) === 0,
);
check(
  "Create PvP is a lobby action",
  (await page.getByRole("button", { name: /create pvp game/i }).count()) === 1,
);
check(
  "Play vs AI is a lobby action",
  (await page.getByRole("button", { name: /play vs ai/i }).count()) === 1,
);
check(
  "the stake picker is on the lobby",
  (await page.getByText(/stake per seat/i).count()) >= 1,
);
const lobbyText = await bodyText();
check(
  "an open table from /available is listed with its host and stake",
  lobbyText.includes("rival") && lobbyText.includes("10 coins"),
);
check(
  "a live match from /available is listed as spectatable",
  lobbyText.includes("live games") &&
    (await page.getByRole("button", { name: /^spectate$/i }).count()) === 1,
);
check(
  "the AI difficulty picker is on the lobby",
  lobbyText.includes("ai difficulty"),
);
check(
  "the lobby reads the open-table list on mount",
  (await requests()).includes("GET /api/hex-duel/multiplayer/available"),
);

// ── 2. Create PvP → the match route ────────────────────────────────────────
await page.getByRole("button", { name: /create pvp game/i }).click();
await page.waitForTimeout(700);
const createBody = (await bodies()).create;
check(
  "Create PvP opened a table through the create route",
  (await requests()).includes("POST /api/hex-duel/multiplayer/create"),
);
check(
  "…at the stake the picker showed",
  Number(createBody?.wager) >= 1,
  JSON.stringify(createBody),
);
check(
  "…and navigated to the MATCH route, flagged as the host",
  (await pushes()).includes("/casino/hex-duel/game/4242?host=1"),
  JSON.stringify(await pushes()),
);
check(
  "…never to the old lobby-with-gameId URL",
  !(await pushes()).some((href) => /casino\/hex-duel\?gameId=/.test(href)),
);

// ── 3. Play vs AI → free practice route ────────────────────────────────────
await page.getByRole("button", { name: /play vs ai/i }).click();
await page.waitForTimeout(700);
const aiBody = (await bodies()).ai;
check(
  "Play vs AI minted a practice session through start-game",
  (await requests()).includes("POST /api/hex-duel/start-game"),
);
check(
  "…as a free AI match (no stake)",
  aiBody?.isAiGame === true && Number(aiBody?.wager) === 0,
  JSON.stringify(aiBody),
);
const aiPush = (await pushes()).find((href) => href.includes("/game/ai"));
check(
  "…and navigated to /game/ai with the tier and the session token",
  Boolean(aiPush) && aiPush.includes("difficulty=normal") && aiPush.includes("session=session-abc"),
  String(aiPush),
);

// ── 4. Join a listed table → the guest seat ────────────────────────────────
await page.getByRole("button", { name: /^join$/i }).click();
await page.waitForTimeout(700);
const joinBody = (await bodies()).join;
check(
  "Join took the seat through the join route",
  (await requests()).includes("POST /api/hex-duel/multiplayer/join"),
);
check(
  "…naming the table that was clicked",
  Number(joinBody?.gameId) === 99,
  JSON.stringify(joinBody),
);
check(
  "…and navigated to that match as the guest",
  (await pushes()).includes("/casino/hex-duel/game/99?host=0"),
  JSON.stringify(await pushes()),
);

// ── 5. Spectate a live match ───────────────────────────────────────────────
await page.getByRole("button", { name: /^spectate$/i }).click();
await page.waitForTimeout(400);
check(
  "Spectate opens the match in spectator mode",
  (await pushes()).includes("/casino/hex-duel/game/77?spectator=1"),
  JSON.stringify(await pushes()),
);

check("nothing threw while the lobby was used", pageErrors.length === 0, JSON.stringify(pageErrors));

await page.screenshot({ path: join(root, "qa/reports/hex-duel-lobby.png"), fullPage: true });

console.log(`\n${pass} passed / ${fail} failed`);
await browser.close();
server.close();
process.exit(fail === 0 ? 0 : 1);
