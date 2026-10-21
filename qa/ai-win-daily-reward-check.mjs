// qa/ai-win-daily-reward-check.mjs
//
// End-to-end QA for the daily-reward win gate on a CLIENT-SETTLED practice
// game. It drives the REAL RPS vs AI page and the REAL corner DailyRewardWidget
// in Chromium against a scripted backend:
//
//   1. the widget starts locked ("Win a match to unlock today's reward");
//   2. the check plays a full best-of-7 and wins it (the bot is forced to
//      throw scissors, so rock wins every round);
//   3. the page POSTs /api/practice/win once, the server records today's win,
//      and the widget flips to "Claim day N" WITHOUT a navigation or reload;
//   4. opening the board and pressing Claim credits the reward, and the board
//      reports the credited amount.
//
// It also asserts there were no page-level JS errors and only the one initial
// navigation. The backend is scripted in Node (no database needed): it mirrors
// the real status/claim contract from src/lib/tokens/dailyReward.ts.
//
// Run: npm run verify:ai-win-daily-reward

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
const outDir = mkdtempSync(join(tmpdir(), "ai-win-daily-reward-"));
const REPORTS = join(root, "qa", "reports");
mkdirSync(REPORTS, { recursive: true });

// The SHIPPED 14-day curve. The scripted server pins the wire shape; the
// rendered board is whatever the server reports.
const CYCLE = [30, 35, 45, 50, 60, 70, 80, 90, 105, 120, 135, 155, 175, 200];
const DAY = 3;
const REWARD = CYCLE[DAY - 1];
const TODAY = "2026-10-19";

const STUBS = {
  "@clerk/nextjs": `
    export const useUser = () => ({
      isLoaded: true,
      isSignedIn: true,
      user: { id: "user_qa", username: "QATester", firstName: "QA", fullName: "QA Tester" },
    });
    export const useAuth = () => ({ isLoaded: true, isSignedIn: true, userId: "user_qa" });
    export const useClerk = () => ({ signOut() {} });
  `,
  "next/navigation": `
    const router = { push(){}, replace(){}, back(){}, refresh(){}, prefetch(){} };
    export const useRouter = () => router;
    export const usePathname = () => "/casino/rps/play-ai";
    export const useSearchParams = () => new URLSearchParams();
    export default { useRouter, usePathname, useSearchParams };
  `,
  "next/link": `
    import React from "react";
    export default function Link({ href, children, ...rest }) {
      return React.createElement("a", { href, ...rest }, children);
    }
  `,
  "next/image": `import React from "react"; export default function Img() { return null; }`,
  "components/navigation-bar": `export default function NavigationBar() { return null; }`,
  "components/Footer": `export default function Footer() { return null; }`,
  "components/GameSessionHost": `
    export default function GameSessionHost({ children }) { return children ?? null; }
  `,
  "lib/gameAudio": `
    export const playVictory = () => {};
    export const playDefeat = () => {};
    export const playTick = () => {};
    export const playGoodReveal = () => {};
    export const playBuzz = () => {};
  `,
  "lib/animations": `
    export const fireConfetti = () => {};
    export const withReducedMotion = (shouldReduce, variant) => (shouldReduce ? {} : variant);
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
  entryPoints: [join(root, "qa/ai-win-daily-reward-harness.jsx")],
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
<title>AI win daily reward check</title>
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

// ── The scripted server ─────────────────────────────────────────────────────
// One mutable world, shared by the browser and every route handler below. It
// mirrors the real contract: a claim is refused until a win is recorded, then
// credits the advertised amount once.
const world = {
  balance: 1000,
  claimed: false,
  won: false,
  practiceReports: 0,
  claims: 0,
  requests: [],
};

function statusBody() {
  return {
    success: true,
    claimable: !world.claimed,
    winGateSatisfied: world.won,
    streakDay: DAY,
    cycleDay: DAY,
    cycleDays: CYCLE.length,
    reward: REWARD,
    today: TODAY,
    cycle: CYCLE,
    balance: world.balance,
  };
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();

const consoleErrors = [];
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e.message)));
page.on("console", (m) => {
  const where = m.location?.()?.url || "";
  const staticAssetNoise =
    /Failed to load resource/.test(m.text()) && !where.includes("/api/");
  if (m.type() === "error" && !staticAssetNoise) {
    consoleErrors.push(`${m.text()} (${where})`);
  }
});

await page.route("**/api/**", async (route) => {
  const request = route.request();
  const path = new URL(request.url()).pathname;
  const method = request.method().toUpperCase();
  world.requests.push(`${method} ${path}`);
  const json = (status, body) =>
    route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(body),
    });

  if (path === "/api/rewards/daily") {
    if (method === "POST") {
      world.claims += 1;
      if (world.claimed) {
        return json(409, { success: false, error: "Already claimed today" });
      }
      if (!world.won) {
        return json(403, {
          success: false,
          error: "Win a match to unlock today's reward",
          winGateSatisfied: false,
        });
      }
      world.claimed = true;
      world.balance += REWARD;
      return json(200, {
        success: true,
        credited: REWARD,
        reward: REWARD,
        balance: world.balance,
        claimedDay: DAY,
        ...statusBody(),
      });
    }
    return json(200, statusBody());
  }

  if (path === "/api/practice/win" && method === "POST") {
    world.practiceReports += 1;
    let game = null;
    try {
      game = JSON.parse(request.postData() || "{}").game;
    } catch {
      // The route under test would reject malformed JSON; the harness only
      // records that a report was attempted.
    }
    if (game !== "rps") {
      return json(400, { success: false, error: "Unknown practice game" });
    }
    world.won = true;
    return json(200, { success: true, stamped: true });
  }

  if (path === "/api/game-plays" && method === "POST") {
    return json(200, { success: true });
  }

  if (path === "/api/get-user-tokens") {
    return json(200, {
      success: true,
      data: {
        balance: world.balance,
        name: "QA Tester",
        selectedIcon: "icon-1",
        nameColor: null,
        equippedCosmetics: {},
      },
    });
  }

  // Progression fetches from the result screen are decoration in this check.
  if (path === "/api/user/stats") {
    return json(200, { success: true, userStats: {} });
  }
  if (path === "/api/leaderboard/my-rank") {
    return json(200, { success: true });
  }

  return json(200, { success: true });
});

// Count only main-frame navigations. A widget refresh must not add one.
const navigations = [];
page.on("framenavigated", (frame) => {
  if (frame === page.mainFrame() && frame.url().startsWith("http")) {
    navigations.push(frame.url());
  }
});

await page.addInitScript(() => {
  try {
    window.sessionStorage.setItem("grynd:splash:seen:v1", "1");
    window.localStorage.setItem("grynd_cookie_consent", "declined");
  } catch {
    /* storage unavailable — the page still loads */
  }
});

await page.goto(origin, { waitUntil: "load", timeout: 30000 });
await page.waitForSelector('[data-testid="daily-reward-widget"]', { timeout: 20000 });
await page.waitForSelector("text=Rock Paper Scissors", { timeout: 20000 });
await page.waitForTimeout(500);

const widgetText = () =>
  page.evaluate(() => {
    const el = document.querySelector('[data-testid="daily-reward-widget"]');
    return el ? el.textContent.replace(/\s+/g, " ").trim() : "";
  });

check(
  "the daily-reward widget starts locked",
  /Win a match to unlock/.test(await widgetText()),
  await widgetText(),
);
check(
  "the RPS vs AI page is mounted",
  (await page.getByRole("heading", { name: /Rock Paper Scissors/i }).count()) > 0,
);

// Force the bot to throw scissors every round: `Math.random()` drives both its
// pattern-read roll and its random pick, and 0.99 is above every read chance.
// Rock therefore beats it four rounds in a row.
await page.evaluate(() => {
  Math.random = () => 0.99;
});

for (let round = 1; round <= 4; round += 1) {
  await page.getByRole("button", { name: /^rock$/i }).click();
  const advance = page.getByRole("button", {
    name: round === 4 ? /see result/i : /next round/i,
  });
  await advance.waitFor({ timeout: 8000 });
  await advance.click();
}

// The winning point reports itself; the result screen is a reveal, not the
// trigger. Wait for the scripted backend to have the win.
const reportDeadline = Date.now() + 5000;
while (!world.won && Date.now() < reportDeadline) {
  await page.waitForTimeout(100);
}

check(
  "the terminal AI win is reported to /api/practice/win",
  world.practiceReports === 1 && world.won === true,
  `reports=${world.practiceReports} won=${world.won}`,
);

// The widget must unlock from the announcement, not from a reload/navigation.
await page.waitForFunction(
  () => {
    const el = document.querySelector('[data-testid="daily-reward-widget"]');
    return el && /Claim day 3/i.test(el.textContent || "");
  },
  null,
  { timeout: 5000 },
).catch(() => {});
check(
  "the widget refreshes to claimable without a page load",
  /Claim day 3/i.test(await widgetText()),
  await widgetText(),
);
check(
  "the unlock needed no navigation",
  navigations.length === 1,
  navigations.join(" -> "),
);

// Dismiss the result overlay (the shared panel's Play Again action) so the
// widget and its portalled board are reachable.
const runItBack = page.getByRole("button", { name: /run it back/i });
if (await runItBack.count()) {
  await runItBack.click();
  await page.waitForTimeout(300);
}

await page.locator('[data-testid="daily-reward-widget-open"]').click();
await page.waitForSelector('[data-testid="daily-reward-board-dialog"]', { timeout: 5000 });
check(
  "the board opens with the earned claim",
  (await page.locator('[data-testid="daily-reward-claim"]').count()) === 1,
);

await page.locator('[data-testid="daily-reward-claim"]').click();
await page.waitForSelector('[data-testid="daily-reward-claimed"]', { timeout: 5000 });
const claimedText = await page
  .locator('[data-testid="daily-reward-claimed"]')
  .textContent();

check(
  "the claim credits exactly the advertised reward",
  world.claims === 1 && world.claimed && world.balance === 1000 + REWARD,
  `claims=${world.claims} balance=${world.balance}`,
);
check(
  "the board reports the credited amount",
  new RegExp(`claimed\\s*${REWARD}\\s*coins`, "i").test(
    String(claimedText || "").replace(/\s+/g, " "),
  ),
  String(claimedText || "").replace(/\s+/g, " ").trim(),
);
check("no page errors", pageErrors.length === 0, pageErrors.join(" | "));
check("no console errors", consoleErrors.length === 0, consoleErrors.join(" | "));

await page.screenshot({ path: join(REPORTS, "ai-win-daily-reward.png"), fullPage: true });
await context.close();
await browser.close();
server.close();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
