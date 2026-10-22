// qa/quest-widget-check.mjs
//
// Drives qa/quest-widget-harness.jsx — the REAL corner quest widget and the REAL
// quest popup with a scripted quest backend — and reports what a player actually
// gets:
//
//   1. the corner widget renders, pinned top-LEFT at desktop width, and names the
//      board the server sent ("1 / 4 done");
//   2. it shows the coins that are claimable right now, from the server's row;
//   3. clicking it opens the popup with every daily and weekly quest;
//   4. each quest shows the SERVER's progress and an accessible bar — a quest
//      that is not complete has no claim button;
//   5. the popup is portalled to `document.body`, so the transformed page
//      wrapper cannot clip or stack it under the navbar;
//   6. claiming posts ONLY the quest id, flips the row to "Claimed" and updates
//      the corner's own state (the shared hook, one claim path);
//   7. a signed-out visitor gets no widget at all;
//   8. at phone width the widget lays out inline instead of floating over the
//      page, with no horizontal overflow;
//   9. nothing raises a React / hydration / runtime error.
//
// Run: npm run verify:quest-widget
//      node qa/quest-widget-check.mjs

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
const outDir = mkdtempSync(join(tmpdir(), "quest-widget-"));

// Clerk is stubbed; every other dependency is the real module. The session
// state is read from the scripted world so the SAME harness can render the
// signed-out page — that is where "no widget, no request" is asserted.
const STUBS = {
  "@clerk/nextjs": `
    const signedIn = () => (window.__questWorld?.signedIn ?? true) !== false;
    const user = { id: "user_1", username: "QuestTester", firstName: "Quest", fullName: "Quest Tester" };
    export const useUser = () => ({ isLoaded: true, isSignedIn: signedIn(), user: signedIn() ? user : null });
    export const useAuth = () => ({ isLoaded: true, isSignedIn: signedIn(), userId: signedIn() ? "user_1" : null });
    export const useClerk = () => ({ signOut() {} });
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
  entryPoints: [join(root, "qa/quest-widget-harness.jsx")],
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
      name: "quest-stubs",
      setup(build) {
        build.onResolve({ filter: /.*/ }, (args) => {
          const key = matchStubKey(args.path, args.resolveDir);
          if (!key) return null;
          return { path: key, namespace: "quest-stub" };
        });
        build.onLoad({ filter: /.*/, namespace: "quest-stub" }, (args) => ({
          contents: STUBS[args.path],
          loader: "jsx",
          resolveDir: root,
        }));
      },
    },
  ],
});

// The app's REAL stylesheet, so `md:fixed` / `fixed inset-0` are the shipping
// rules and the layout assertions mean something.
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
<title>Quest widget check</title>
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

const WIDGET = '[data-testid="quest-widget"]';
const NAV_BADGE = '[data-testid="quest-nav-badge"]';
const OPEN = '[data-testid="quest-widget-open"]';
const DIALOG = '[data-testid="quest-widget-dialog"]';
const OVERLAY = '[data-testid="quest-widget-overlay"]';

const readText = (page, sel) =>
  page.evaluate((selector) => {
    const el = document.querySelector(selector);
    return el ? el.textContent.replace(/\s+/g, " ").trim() : null;
  }, sel);

const countOf = (page, sel) =>
  page.$$eval(sel, (els) => els.length).catch(() => 0);

const browser = await chromium.launch();

async function boot(world, viewport = { width: 1440, height: 1000 }) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e.message)));
  page.on("console", (m) => {
    // The fixture server serves three build artefacts and nothing else, so the
    // browser's automatic asset requests 404. A real API failure would surface
    // as an unhandled rejection instead — the scripted backend answers both
    // quest routes.
    const where = m.location?.()?.url || "";
    const staticAssetNoise =
      /Failed to load resource/.test(m.text()) && !where.includes("/api/");
    if (m.type() === "error" && !staticAssetNoise) {
      consoleErrors.push(`${m.text()} (${where})`);
    }
  });
  await page.addInitScript((value) => {
    window.__questWorld = value;
  }, world);
  await page.goto(origin);
  await page.waitForFunction(
    () => !!document.querySelector('[data-testid="page-host"]'),
    null,
    { timeout: 20000 },
  );
  await page.waitForTimeout(350);
  return { context, page, consoleErrors, pageErrors };
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. The signed-in corner: summary from the server, then the popup and a claim
// ═══════════════════════════════════════════════════════════════════════════
{
  const { context, page, consoleErrors, pageErrors } = await boot({ signedIn: true });

  check("the corner widget renders for a signed-in player", (await countOf(page, WIDGET)) === 1);
  check(
    "the widget is pinned to the top-left, not the daily reward's corner",
    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      // 16px from the left edge and clear of the navbar; the daily reward is the
      // mirror image on the right.
      return (
        style.position === "fixed" &&
        Math.abs(rect.left - 16) < 1 &&
        rect.top >= 96 &&
        rect.right < window.innerWidth / 2
      );
    }, WIDGET),
    await page.evaluate((sel) => {
      const rect = document.querySelector(sel).getBoundingClientRect();
      return `left=${rect.left} top=${rect.top} right=${rect.right}`;
    }, WIDGET),
  );

  const summary = await readText(page, WIDGET);
  check(
    "the widget names the board the server sent",
    /Quests/.test(summary ?? "") && /1 \/ 4 done/.test(summary ?? ""),
    summary?.slice(0, 90) ?? "",
  );
  check(
    "the widget shows the coins claimable right now",
    /50 coins available/.test(summary ?? ""),
    summary?.slice(0, 90) ?? "",
  );
  check(
    "the games hub nav badge flags the claimable quest",
    (await readText(page, NAV_BADGE)) === "1" &&
      /1 quests to claim/.test(
        (await page.evaluate(
          (sel) => document.querySelector(sel)?.getAttribute("aria-label") ?? "",
          NAV_BADGE,
        )) ?? "",
      ),
    `${await readText(page, NAV_BADGE)} / ${await page.evaluate((sel) => document.querySelector(sel)?.getAttribute("aria-label") ?? "", NAV_BADGE)}`,
  );

  await page.click(OPEN);
  await page.waitForSelector(DIALOG, { timeout: 5000 });

  check("clicking the widget opens the quest popup", (await countOf(page, DIALOG)) === 1);
  check(
    "the popup is portalled out of the transformed page wrapper",
    await page.evaluate((sel) => {
      const overlay = document.querySelector(sel);
      return (
        overlay?.parentElement === document.body &&
        Math.abs(overlay.getBoundingClientRect().width - window.innerWidth) < 2
      );
    }, OVERLAY),
  );
  check(
    "every quest is there: daily and weekly, side by side",
    (await countOf(page, '[data-testid="quest-widget-list-daily"] li')) === 2 &&
      (await countOf(page, '[data-testid="quest-widget-list-weekly"] li')) === 2,
    `daily=${await countOf(page, '[data-testid="quest-widget-list-daily"] li')} weekly=${await countOf(page, '[data-testid="quest-widget-list-weekly"] li')}`,
  );
  check(
    "each quest shows the server's progress as text",
    (await readText(page, '[data-testid="quest-widget-progress-12"]')) === "1 / 3" &&
      (await readText(page, '[data-testid="quest-widget-progress-21"]')) === "4 / 15",
    `${await readText(page, '[data-testid="quest-widget-progress-12"]')} / ${await readText(page, '[data-testid="quest-widget-progress-21"]')}`,
  );
  check(
    "the progress bar reports that same ratio",
    await page.evaluate(() => {
      const bar = document.querySelector('[data-testid="quest-widget-progressbar-12"]');
      return Number(bar?.getAttribute("aria-valuenow")) === 33;
    }),
  );
  check(
    "only the complete quest offers a claim",
    (await countOf(page, '[data-testid="quest-widget-claim-12"]')) === 0 &&
      (await countOf(page, '[data-testid="quest-widget-claim-21"]')) === 0 &&
      (await countOf(page, '[data-testid="quest-widget-claim-11"]')) === 1,
  );

  await page.click('[data-testid="quest-widget-claim-11"]');
  await page.waitForTimeout(400);

  const claims = await page.evaluate(() =>
    (window.__questWorld?.requests || []).filter((r) => r.path === "/api/quests/claim"),
  );
  check(
    "claiming posts the quest id and nothing else",
    claims.length === 1 && claims[0].method === "POST" && claims[0].body === '{"questId":11}',
    JSON.stringify(claims),
  );
  check(
    "the claimed quest flips to Claimed in the popup",
    (await countOf(page, '[data-testid="quest-widget-claimed-11"]')) === 1 &&
      (await countOf(page, '[data-testid="quest-widget-claim-11"]')) === 0,
  );
  check(
    "the confirmation reports the amount the server credited",
    /You claimed 50 coins/.test((await readText(page, DIALOG)) ?? ""),
    await readText(page, '[data-testid="quest-widget-claimed-now"]'),
  );

  await page.click('[data-testid="quest-widget-close"]');
  await page.waitForTimeout(400);
  check(
    "claiming clears the nav badge too",
    (await countOf(page, NAV_BADGE)) === 0,
    `badge=${await readText(page, NAV_BADGE)}`,
  );
  const after = await readText(page, WIDGET);
  check(
    "the corner follows the claim — no stale coins, the next quest instead",
    (await countOf(page, DIALOG)) === 0 &&
      !/coins available/.test(after ?? "") &&
      /Next: Warmed up/.test(after ?? ""),
    after?.slice(0, 90) ?? "",
  );
  check(
    "no runtime error surfaced",
    [...consoleErrors, ...pageErrors].length === 0,
    [...consoleErrors, ...pageErrors][0] ?? "",
  );

  await context.close();
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. Signed out: no widget, no request
// ═══════════════════════════════════════════════════════════════════════════
{
  const { context, page, consoleErrors, pageErrors } = await boot({ signedIn: false });
  check(
    "a signed-out visitor gets no corner widget",
    (await page.evaluate(() => !document.querySelector('[data-testid="quest-widget"]'))) === true,
  );
  check(
    "a signed-out visitor gets no nav badge either",
    (await countOf(page, NAV_BADGE)) === 0,
  );
  check(
    "and no quest request is made",
    (await page.evaluate(
      () => (window.__questWorld?.requests || []).filter((r) => r.path.startsWith("/api/quests")).length,
    )) === 0,
  );
  check(
    "the signed-out page raises no runtime error",
    [...consoleErrors, ...pageErrors].length === 0,
    [...consoleErrors, ...pageErrors][0] ?? "",
  );
  await context.close();
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. Phone width: inline, not floating over the page
// ═══════════════════════════════════════════════════════════════════════════
{
  const { context, page, consoleErrors, pageErrors } = await boot(
    { signedIn: true },
    { width: 390, height: 844 },
  );
  check(
    "at phone width the widget lays out inline instead of floating",
    await page.evaluate((sel) => {
      const style = getComputedStyle(document.querySelector(sel));
      return style.position === "static";
    }, WIDGET),
    await page.evaluate((sel) => getComputedStyle(document.querySelector(sel)).position, WIDGET),
  );
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  check("the widget causes no horizontal overflow on a phone", overflow <= 1, `overflow=${overflow}px`);
  check(
    "the phone view raises no runtime error",
    [...consoleErrors, ...pageErrors].length === 0,
    [...consoleErrors, ...pageErrors][0] ?? "",
  );
  await context.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
server.close();
if (fail > 0) process.exitCode = 1;
