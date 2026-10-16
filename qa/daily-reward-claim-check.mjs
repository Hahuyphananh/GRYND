// qa/daily-reward-claim-check.mjs
//
// Reported bug: "Claiming tokens doesn't update the token amount in the navbar
// and in the rewards page." This drives the REAL navbar, the REAL daily reward
// card and the REAL CsrfFetchGuard (qa/daily-reward-harness.jsx) against a
// scripted wallet, clicks the claim, and asserts what the browser actually
// paints:
//
//   * the coin number under the trophies in the navbar moves by exactly the
//     amount the server credited;
//   * the success message reports the amount that was actually credited — the
//     advertised amount and the paid amount are the same number;
//   * the reward status flips to "claimed" without a reload;
//   * no React / hydration / runtime errors.
//
// Run: node qa/daily-reward-claim-check.mjs

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
const outDir = mkdtempSync(join(tmpdir(), "daily-reward-"));
const REPORTS = join(root, "qa", "reports");
mkdirSync(REPORTS, { recursive: true });

// The SHIPPED 14-day curve. The harness pins the wire shape; the rendered board
// is whatever the server reports, and this is what the server reports.
const CYCLE = [30, 35, 45, 50, 60, 70, 80, 90, 105, 120, 135, 155, 175, 200];

const STUBS = {
  "@clerk/nextjs": `
    export const useUser = () => ({
      isLoaded: true,
      isSignedIn: true,
      user: { id: "user_1", username: "RewardTester", firstName: "Reward", fullName: "Reward Tester" },
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
  "next/navigation": `
    const router = { push(){}, replace(){}, back(){}, refresh(){}, prefetch(){} };
    export const useRouter = () => router;
    export const usePathname = () => "/rewards";
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
  entryPoints: [join(root, "qa/daily-reward-harness.jsx")],
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
      name: "reward-stubs",
      setup(build) {
        build.onResolve({ filter: /.*/ }, (args) => {
          const key = matchStubKey(args.path, args.resolveDir);
          if (!key) return null;
          return { path: key, namespace: "reward-stub" };
        });
        build.onLoad({ filter: /.*/, namespace: "reward-stub" }, (args) => ({
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
<title>Daily reward claim check</title>
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

const NAV_COINS = '[data-testid="nav-coins"]';
const PROBE = '[data-testid="probe-balance"]';
const CARD_OPEN = '[data-testid="daily-reward-open"]';
const BOARD = '[data-testid="daily-reward-board-dialog"]';
const CLAIM = '[data-testid="daily-reward-claim"]';
const CLAIMED = '[data-testid="daily-reward-claimed"]';
const LOCKED = '[data-testid="daily-reward-locked"]';

// `toLocaleString()` renders thousands with a locale separator that is a narrow
// no-break space in this environment, so the assertions compare DIGITS: strip
// every character that cannot be part of a balance and compare the number.
const digits = (text) => String(text ?? "").replace(/[^0-9.]/g, "");

const readText = (page, sel) =>
  page.evaluate((selector) => {
    const el = document.querySelector(selector);
    return el ? el.textContent.replace(/\s+/g, " ").trim() : null;
  }, sel);

const navCoins = (page) => readText(page, NAV_COINS);
const probeBalance = (page) => readText(page, PROBE);

const cardText = (page) => readText(page, 'section[aria-labelledby="daily-reward-heading"]');
const boardText = (page) => readText(page, BOARD);

async function boot(world) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e.message)));
  page.on("console", (m) => {
    // The fixture server serves the three build artefacts and nothing else, so
    // the browser's automatic asset requests (favicon, the stylesheet's
    // light-theme.css, the logo, the icon sprite) 404. A FAILED API CALL is
    // still reported — the scripted backend answers every /api/ path.
    const where = m.location?.()?.url || "";
    const staticAssetNoise =
      /Failed to load resource/.test(m.text()) && !where.includes("/api/");
    if (m.type() === "error" && !staticAssetNoise) {
      consoleErrors.push(`${m.text()} (${where})`);
    }
  });
  await page.addInitScript((value) => {
    window.__dailyWorld = value;
  }, world);
  await page.goto(origin);
  await page.waitForSelector(NAV_COINS, { timeout: 20000 });
  // The card's status read and the navbar's wallet read settle a tick later.
  await page.waitForTimeout(400);
  return { context, page, consoleErrors, pageErrors };
}

// ── 1. A plain claim: the advertised amount is the paid amount ──────────────
{
  const world = {
    balance: 1000,
    streakDay: 3,
    cycle: CYCLE,
    claimable: true,
    playGateSatisfied: true,
    credited: CYCLE[2],
  };
  const wage = CYCLE[2];
  const { context, page, consoleErrors, pageErrors } = await boot(world);

  const before = await navCoins(page);
  const probeBefore = await probeBalance(page);
  check("the navbar shows the starting balance", digits(before) === "1000", before);
  check("the rewards balance hook shows the starting balance", digits(probeBefore) === "1000", probeBefore);

  const button = await cardText(page);
  check(
    "the card advertises the server's amount",
    new RegExp(`day 3 \\(${wage} coins\\)`).test(button || ""),
    button,
  );
  check("the board is closed until the card is clicked", (await page.$(BOARD)) === null);

  await page.click(CARD_OPEN);
  await page.waitForSelector(BOARD, { timeout: 5000 });
  const opened = await boardText(page);
  check("the board lists every day of the cycle", opened.includes("Day 14"), opened);

  // The card lives inside a transformed wrapper (see the harness), so a board
  // rendered in place would be trapped in that box and could sit under the
  // navbar. Measure the overlay to prove it is portalled and full-viewport.
  const overlay = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="daily-reward-board-overlay"]');
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return {
      top: Math.round(rect.top),
      left: Math.round(rect.left),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      parent: el.parentElement?.tagName,
    };
  });
  check(
    "the board overlay escapes the transformed wrapper and covers the viewport",
    overlay?.parent === "BODY" &&
      overlay.top === 0 &&
      overlay.left === 0 &&
      overlay.width >= 1439 &&
      overlay.height >= 999,
    JSON.stringify(overlay),
  );
  check("the board marks the day the player is on", /Day 3 of 14/.test(opened), opened);
  check(
    "the board shows the last day's amount",
    /Day14200/.test(opened.replace(/\s+/g, "")),
    opened,
  );
  check("the board offers the claim", opened.includes("Claim day 3"));

  await page.click(CLAIM);
  await page.waitForTimeout(600);

  const after = await navCoins(page);
  const probeAfter = await probeBalance(page);
  check(
    "the navbar balance moves after a claim",
    digits(after) === String(1000 + wage),
    `${before} → ${after}`,
  );
  check(
    "the rewards balance card moves after a claim",
    digits(probeAfter) === String(1000 + wage),
    `${probeBefore} → ${probeAfter}`,
  );

  const card = await readText(page, CLAIMED);
  check(
    "the success message reports the credited amount",
    new RegExp(`claimed\\s*${wage} coins`, "i").test(card || ""),
    card,
  );
  check(
    "the claim action is gone once claimed",
    (await page.$(CLAIM)) === null,
    "the claim button must not still be on screen",
  );

  check("no page errors", pageErrors.length === 0, pageErrors.join(" | "));
  check("no console errors", consoleErrors.length === 0, consoleErrors.join(" | "));
  await context.close();
}

// ── 2. The reported amount and the credited amount disagree ────────────────
// The server's status read says one number and the claim credits another (the
// shipped bug: the streak the card shows is not the streak the claim pays).
// Whatever the server does, the UI must report what was ACTUALLY credited.
{
  const world = {
    balance: 1000,
    streakDay: 14,
    cycle: CYCLE,
    claimable: true,
    playGateSatisfied: true,
    credited: 30, // the claim resets the streak to day 1 and pays day 1
  };
  const { context, page } = await boot(world);

  const advertised = await cardText(page);
  check(
    "the advertised amount comes from the status read",
    /day 14 \(200 coins\)/.test(advertised || ""),
    advertised,
  );

  await page.click(CARD_OPEN);
  await page.waitForSelector(BOARD, { timeout: 5000 });
  await page.click(CLAIM);
  await page.waitForTimeout(600);

  const after = await navCoins(page);
  check(
    "the navbar shows the credited amount, not the advertised one",
    digits(after) === "1030",
    after,
  );
  check(
    "the rewards balance card shows the credited amount",
    digits(await probeBalance(page)) === "1030",
    await probeBalance(page),
  );

  const card = await readText(page, CLAIMED);
  check(
    "the success message reports what was actually credited",
    /claimed\s*30 coins/i.test(card || ""),
    card,
  );
  await context.close();
}

// ── 3. A locked claim never credits ────────────────────────────────────────
{
  const world = {
    balance: 1000,
    streakDay: 2,
    cycle: CYCLE,
    claimable: true,
    playGateSatisfied: false,
    credited: 0,
  };
  const { context, page } = await boot(world);

  const card = await cardText(page);
  check("an unplayed day shows the gate, not a claim button", /Play one game/.test(card || ""), card);

  await page.click(CARD_OPEN);
  await page.waitForSelector(BOARD, { timeout: 5000 });
  check("the board repeats the gate", (await page.$(LOCKED)) !== null);
  check("no claim button while the gate is closed", (await page.$(CLAIM)) === null);

  // Escape closes the board and hands focus back.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  check("Escape closes the board", (await page.$(BOARD)) === null);

  const after = await navCoins(page);
  check("the balance is untouched by a locked day", digits(after) === "1000", after);
  check("the world was never credited", Number(world.credited) === 0, String(world.credited));
  await context.close();
}

await browser.close();
server.close();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
