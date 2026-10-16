// qa/barrier-blitz-matchmaking-check.mjs
//
// Reported bug: "When I click on Find a Match and there's no other user joining,
// show the waiting page — do not redirect me directly on the game page."
//
// This drives the REAL Barrier Blitz lobby (qa/barrier-blitz-matchmaking-harness.jsx)
// against a scripted matchmaking backend and asserts what the browser actually
// does, in the three situations the route can answer with:
//
//   1. NOBODY JOINS (`joined: false`) — the waiting takeover must be on screen,
//      the URL must still be the lobby, and the game board must NOT be mounted.
//      Then, when an opponent takes the seat (the per-match read starts
//      reporting `playing`), the page navigates to the match exactly once.
//   2. AN OPEN SEAT IS TAKEN (`joined: true`) — the match is already live, so the
//      page DOES navigate, immediately, with no waiting screen left behind.
//   3. CANCEL — cancelling the owned lobby closes it, ends the wait and never
//      navigates to the game page.
//
// Run: node qa/barrier-blitz-matchmaking-check.mjs

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
const outDir = mkdtempSync(join(tmpdir(), "barrier-blitz-matchmaking-"));

const MATCH_PATH = "/casino/barrier-blitz/11111111-1111-4111-8111-111111111111";

const STUBS = {
  "@clerk/nextjs": `
    export const useUser = () => ({
      isLoaded: true,
      isSignedIn: true,
      user: { id: "user_1", username: "MatchTester", firstName: "Match", fullName: "Match Tester" },
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
  // The router RECORDS instead of navigating: staying on the lobby is what lets
  // the check assert what the page rendered while it waited. `__pushes` is the
  // navigation log the assertions read.
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
    export const usePathname = () => "/games/barrier-blitz/play";
    export const useSearchParams = () => new URLSearchParams();
    export default { useRouter, usePathname, useSearchParams };
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
  // is exactly the path the waiting screen uses when a push is unavailable.
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
  entryPoints: [join(root, "qa/barrier-blitz-matchmaking-harness.jsx")],
  bundle: true,
  format: "iife",
  platform: "browser",
  jsx: "automatic",
  // The shipping components import real art (the waiting screen's logo, the
  // lobby's card art); inline it so the bundle stays self-contained.
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
      name: "matchmaking-stubs",
      setup(build) {
        build.onResolve({ filter: /.*/ }, (args) => {
          const key = matchStubKey(args.path, args.resolveDir);
          if (!key) return null;
          return { path: key, namespace: "matchmaking-stub" };
        });
        build.onLoad({ filter: /.*/, namespace: "matchmaking-stub" }, (args) => ({
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
  compiled.css.replace(/@import\s+url\(["']?https?:\/\/[^)]*\);?/g, "")
);

writeFileSync(
  join(outDir, "index.html"),
  `<!doctype html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Barrier Blitz matchmaking check</title>
<link rel="stylesheet" href="./app.css"></head>
<body><div id="root"></div><script src="./harness.js"></script></body></html>`
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

const FIND = { role: "button", name: /find a match/i };
const WAITING_SUBTITLE = "Your table is open";
const CANCEL_LABEL = "Cancel table";

const pushes = (page) => page.evaluate(() => (window.__pushes || []).slice());
const requests = (page) => page.evaluate(() => (window.__matchmakingWorld?.requests || []).slice());
const boardMounted = (page) =>
  page.evaluate(
    () =>
      document.querySelectorAll('[data-testid="barricade-board"], [data-testid="barricade-match"]')
        .length
  );
const waitingVisible = (page) => page.getByText(WAITING_SUBTITLE).count();

async function boot(world) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e.message)));
  page.on("console", (m) => {
    // The fixture server serves three build artefacts and nothing else, so the
    // browser's own asset requests (favicon, logo, icon sprite) 404 — static
    // noise, never an API failure: the scripted backend answers every /api/ path.
    const where = m.location?.()?.url || "";
    const staticAssetNoise = /Failed to load resource/.test(m.text()) && !where.includes("/api/");
    if (m.type() === "error" && !staticAssetNoise) {
      consoleErrors.push(`${m.text()} (${where})`);
    }
  });
  await page.addInitScript((value) => {
    window.__matchmakingWorld = value;
    window.__pushes = [];
    try {
      // Look like a RETURNING player: the shared chrome auto-opens the "How to
      // Play" modal once per game (keyed by `rulesKey`) and shows the splash and
      // cookie banner on a first visit. All three are full-viewport overlays
      // that would swallow the click; none of them is under test here.
      window.localStorage.setItem("casino-rules-seen:barricade", "1");
      window.localStorage.setItem("grynd_cookie_consent", "declined");
      window.sessionStorage.setItem("grynd:splash:seen:v1", "1");
    } catch {
      /* storage unavailable — the waits below still cover it */
    }
  }, world);
  await page.goto(origin);
  await page.waitForSelector("h1", { timeout: 20000 });
  return { context, page, consoleErrors, pageErrors };
}

// ── 1. Nobody joins: the waiting page, never the game page ──────────────────
{
  const world = { joined: false, matchStatus: "waiting" };
  const { context, page, consoleErrors, pageErrors } = await boot(world);

  check(
    "the lobby offers Find a Match",
    (await page.getByRole(FIND.role, { name: FIND.name }).count()) === 1
  );
  check("no board is mounted before anything is clicked", (await boardMounted(page)) === 0);

  await page.getByRole(FIND.role, { name: FIND.name }).click();
  // The waiting takeover is what must appear; give the route answer a moment.
  await page.waitForTimeout(1200);

  const requestLog = await requests(page);
  check(
    "Find a Match asked the real matchmaking route",
    requestLog.includes("POST /api/barricade/create-or-join"),
    requestLog.filter((entry) => entry.includes("barricade")).join(" | ")
  );
  check(
    "the waiting screen is shown",
    (await waitingVisible(page)) >= 1,
    (await page.locator("body").innerText()).slice(0, 200).replace(/\s+/g, " ")
  );
  check("it did NOT navigate to the game page", (await pushes(page)).length === 0);
  check(
    "no game board was mounted at all",
    (await boardMounted(page)) === 0,
    `mounted: ${await boardMounted(page)}`
  );
  check(
    "the cancel action is offered while waiting",
    (await page.getByRole("button", { name: CANCEL_LABEL }).count()) === 1
  );

  // Now an opponent takes the seat: the per-match read starts reporting
  // `playing`, and the wait must end by navigating to the match — once.
  await page.evaluate(() => {
    window.__matchmakingWorld.matchStatus = "playing";
  });
  await page
    .waitForFunction(() => (window.__pushes || []).length > 0, null, { timeout: 15000 })
    .catch(() => {});
  const afterJoin = await pushes(page);
  check(
    "when an opponent joins, it navigates to the match exactly once",
    afterJoin.length === 1 && afterJoin[0] === MATCH_PATH,
    JSON.stringify(afterJoin)
  );
  check("the waiting takeover goes away once the match starts", (await waitingVisible(page)) === 0);
  check(
    "no JS errors in the no-opponent flow",
    pageErrors.length === 0 && consoleErrors.length === 0,
    [...pageErrors, ...consoleErrors].join(" | ")
  );

  await context.close();
}

// ── 2. An open seat is taken: the match is live, so go straight to it ───────
{
  const world = { joined: true, matchStatus: "playing" };
  const { context, page, pageErrors } = await boot(world);

  await page.getByRole(FIND.role, { name: FIND.name }).click();
  await page
    .waitForFunction(() => (window.__pushes || []).length > 0, null, {
      timeout: 10000,
    })
    .catch(() => {});
  const afterJoin = await pushes(page);
  check(
    "joining an existing table navigates to the match",
    afterJoin.length === 1 && afterJoin[0] === MATCH_PATH,
    JSON.stringify(afterJoin)
  );
  check("an already-live match never shows the waiting screen", (await waitingVisible(page)) === 0);
  check("no JS errors on the join flow", pageErrors.length === 0, pageErrors.join(" | "));

  await context.close();
}

// ── 3. Cancel: the owned lobby closes, and the game page is never reached ───
{
  const world = { joined: false, matchStatus: "waiting" };
  const { context, page, pageErrors } = await boot(world);

  await page.getByRole(FIND.role, { name: FIND.name }).click();
  await page.waitForTimeout(1200);
  check("the wait is up before cancelling", (await waitingVisible(page)) >= 1);

  await page.getByRole("button", { name: CANCEL_LABEL }).click();
  await page.waitForTimeout(900);

  const requestLog = await requests(page);
  check(
    "cancel closed the owned lobby",
    requestLog.some((entry) => /POST \/api\/barricade\/match\/.+\/cancel$/.test(entry)),
    requestLog.filter((entry) => entry.includes("cancel")).join(" | ")
  );
  check("cancelling never navigates to the game page", (await pushes(page)).length === 0);
  check("the waiting screen is dismissed", (await waitingVisible(page)) === 0);
  check("no JS errors on the cancel flow", pageErrors.length === 0, pageErrors.join(" | "));

  await context.close();
}

await browser.close();
server.close();

console.log(`\n${pass}/${pass + fail} matchmaking checks passed`);
if (fail) process.exit(1);
