// qa/pro-paywall-check.mjs
//
// CLICK-THROUGH of the GRYND PRO trial timeline — the real component, in a real
// browser, driven the way a member drives it.
//
// Why this exists: the contract suite proves the paywall is wired to a real
// Stripe trial, but it cannot prove that the three slides actually change when
// clicked, or that picking "1 day before" reaches the state that is sent to
// checkout. This does exactly that:
//
//   1. try it free   → slide 1 is open first,
//   2. pick a reminder → slide 2 opens, three choices, clicking one updates the
//                       paywall's own state (echoed by the harness),
//   3. charge date   → slide 3 shows a date and repeats the chosen reminder,
//   4. Back / Next move between slides and the reminder survives,
//   5. "no reminder" is a real choice and slide 3 says no email will be sent.
//
// The component is bundled from source with esbuild (the same technique as
// qa/pro-stats-check.mjs) and only the translation hook is stubbed: copy
// correctness is already covered by the translation-key tests, so the stub
// returns the key and the assertions can check WHICH branch rendered.
//
// Run: npm run verify:paywall

import esbuild from "esbuild";
import { chromium } from "playwright";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "pro-paywall-"));
const REPORTS = join(root, "qa", "reports");
mkdirSync(REPORTS, { recursive: true });

// ── The one stub: a deterministic translation hook ─────────────────────────
const STUB_KEY = "hooks/useTranslation";
const STUBS = {
  [STUB_KEY]: `
    // Keep the key AND the interpolated params in the text, so assertions can
    // verify both which branch rendered and the real values it was given
    // (e.g. the computed charge date), without depending on locale copy.
    export function useTranslation() {
      return {
        t: (key, params) =>
          [key, ...Object.values(params ?? {})].join(" "),
        language: "en",
        setLanguage: () => {},
      };
    }
    export default useTranslation;
  `,
};

const normalized = (value) => value.replace(/\\/g, "/");
const stubFor = (specifier, resolveDir) => {
  if (specifier.startsWith(".")) {
    const absolute = normalized(join(resolveDir, specifier));
    if (absolute.endsWith("/" + STUB_KEY)) return STUB_KEY;
    return null;
  }
  return specifier === STUB_KEY || specifier.endsWith("/" + STUB_KEY)
    ? STUB_KEY
    : null;
};

await esbuild.build({
  entryPoints: [join(root, "qa/pro-paywall-harness.jsx")],
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
      name: "pro-paywall-stubs",
      setup(build) {
        build.onResolve({ filter: /.*/ }, (args) => {
          const key = stubFor(args.path, args.resolveDir);
          if (!key) return null;
          return { path: key, namespace: "pro-paywall-stub" };
        });
        build.onLoad({ filter: /.*/, namespace: "pro-paywall-stub" }, (args) => ({
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
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GRYND PRO paywall click-through</title></head>
<body><div id="root"></div><script src="./harness.js"></script></body></html>`,
);

const server = createServer((req, res) => {
  const rawPath = req.url === "/" ? "/index.html" : req.url.split("?")[0];
  const allowed = new Map([
    ["/index.html", "index.html"],
    ["/harness.js", "harness.js"],
  ]);
  const safeFile = allowed.get(rawPath);
  if (!safeFile) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }
  try {
    const buf = readFileSync(join(outDir, safeFile));
    res.writeHead(200, {
      "Content-Type": rawPath.endsWith(".js") ? "text/javascript" : "text/html",
    });
    res.end(buf);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}/index.html`;

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${extra ? " — " + extra : ""}`);
  ok ? pass++ : fail++;
};

// Prefer Playwright's bundled browser; fall back to the system Chrome install.
let browser;
try {
  browser = await chromium.launch();
} catch {
  browser = await chromium.launch({ channel: "chrome" });
}

const page = await browser.newPage({ viewport: { width: 900, height: 900 }, locale: "en-US" });
const pageErrors = [];
page.on("pageerror", (error) => pageErrors.push(String(error)));

await page.goto(base, { waitUntil: "domcontentloaded" });
await page.waitForSelector('[data-testid="pro-trial-timeline"]', { timeout: 10_000 });

const attr = (selector, name) => page.getAttribute(selector, name);
const visible = (selector) => page.locator(selector).isVisible();
const text = async (selector) => (await page.textContent(selector)) ?? "";

// ── Slide 1: try it free ───────────────────────────────────────────────────
check(
  "the offer shows three trial slides",
  (await page.locator('[data-testid^="pro-trial-step-"]').count()) === 3,
);
check("slide 1 (try it free) opens first", await visible('[data-testid="pro-trial-panel-free"]'));
check(
  "slide 1 is announced as the active step",
  (await attr('[data-testid="pro-trial-step-free"]', "aria-pressed")) === "true",
);

// ── Slide 2: pick a reminder ───────────────────────────────────────────────
await page.click('[data-testid="pro-trial-step-reminder"]');
check("slide 2 (pick a reminder) opens on click", await visible('[data-testid="pro-trial-panel-reminder"]'));
check(
  "three reminder choices are offered",
  (await page.locator('[data-testid^="pro-trial-reminder-"]').count()) === 3,
);

await page.click('[data-testid="pro-trial-reminder-1"]');
check(
  "clicking 1-day-before reaches the paywall state",
  (await attr('[data-testid="paywall-harness-reminder"]', "data-reminder")) === "1",
);
check(
  "the chosen reminder is checked",
  (await attr('[data-testid="pro-trial-reminder-1"]', "aria-checked")) === "true",
);
check(
  "the other reminders are unchecked",
  (await attr('[data-testid="pro-trial-reminder-3"]', "aria-checked")) === "false",
);

// ── Slide 3: the charge date ───────────────────────────────────────────────
await page.click('[data-testid="pro-trial-step-charge"]');
const chargeText = await text('[data-testid="pro-trial-panel-charge"]');
check("slide 3 shows a charge date", /\d/.test(chargeText), chargeText.trim().slice(0, 90));
check(
  "slide 3 repeats the chosen reminder",
  chargeText.includes("pro.trial.charge_reminder"),
);

// ── Back / Next keep the choice ────────────────────────────────────────────
await page.click('[data-testid="pro-trial-back"]');
check("Back returns to the reminder slide", await visible('[data-testid="pro-trial-panel-reminder"]'));
check(
  "the reminder survives navigation",
  (await attr('[data-testid="pro-trial-reminder-1"]', "aria-checked")) === "true",
);
await page.click('[data-testid="pro-trial-next"]');
check("Next advances to the charge slide", await visible('[data-testid="pro-trial-panel-charge"]'));

// ── "No reminder" is a real, honoured choice ───────────────────────────────
await page.click('[data-testid="pro-trial-step-reminder"]');
await page.click('[data-testid="pro-trial-reminder-0"]');
check(
  "a member can choose no reminder",
  (await attr('[data-testid="paywall-harness-reminder"]', "data-reminder")) === "0",
);
await page.click('[data-testid="pro-trial-step-charge"]');
check(
  "the charge slide says no reminder will be sent",
  (await text('[data-testid="pro-trial-panel-charge"]')).includes(
    "pro.trial.charge_no_reminder",
  ),
);

check("no runtime errors", pageErrors.length === 0, pageErrors.join("; "));

await page.screenshot({ path: join(REPORTS, "pro-paywall-trial.png"), fullPage: true });
await browser.close();
server.close();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
