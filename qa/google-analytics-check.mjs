// qa/google-analytics-check.mjs
//
// Drives qa/google-analytics-harness.jsx — the REAL GoogleAnalytics component
// and the real cookie-consent module — in Chromium, with the GA loader
// intercepted so the whole thing runs offline and "did it load?" is
// observable:
//
//   1. no request to googletagmanager.com, and no <script> in the DOM, while
//      the visitor has not accepted (the tag is not in the initial HTML —
//      this is the promise the privacy policy and the banner both make);
//   2. accepting loads the loader exactly once, with the right measurement ID,
//      and runs the snippet's `gtag('js', …)` + `gtag('config', 'G-PFN3BBLC0E')`;
//   3. loading the page already-accepted also works (returning visitor);
//   4. declining sets GA's `ga-disable-<ID>` kill switch, fires one more
//      request no matter how often consent flips, and never double-loads;
//   5. no runtime error surfaces.
//
// Run: npm run verify:google-analytics
//      node qa/google-analytics-check.mjs
//
// Offline: the only external request (gtag.js) is fulfilled locally.

import esbuild from "esbuild";
import { chromium } from "playwright";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "google-analytics-"));
const REPORTS = join(root, "qa", "reports");
mkdirSync(REPORTS, { recursive: true });

const GA_URL = "https://www.googletagmanager.com/gtag/js?id=G-PFN3BBLC0E";

// ── Bundle the real component ──────────────────────────────────────────────
await esbuild.build({
  entryPoints: [join(root, "qa/google-analytics-harness.jsx")],
  bundle: true,
  format: "iife",
  platform: "browser",
  jsx: "automatic",
  outfile: join(outDir, "harness.js"),
  logLevel: "error",
  absWorkingDir: root,
  define: { "process.env.NODE_ENV": '"development"' },
});

writeFileSync(
  join(outDir, "index.html"),
  `<!doctype html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Google Analytics check</title></head>
<body><div id="root"></div><script src="./harness.js"></script></body></html>`,
);

// ── Reporting helpers ──────────────────────────────────────────────────────
let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${extra ? " — " + extra : ""}`);
  ok ? pass++ : fail++;
};

const fileUrl = pathToFileURL(join(outDir, "index.html")).href;
const browser = await chromium.launch();

// The stub loader: proves the request happened and that the snippet ran, with
// no network. It deliberately does NOT consume `dataLayer`, so the queue the
// inline snippet wrote stays readable.
const STUB_GTAG = `
  (window.__ga = window.__ga || { loads: [] }).loads.push(new URL(document.currentScript.src).searchParams.get("id"));
  window.__gtagLibLoaded = true;
`;

/** A page whose GA loader is intercepted; `loads` counts what was requested. */
async function newPage(consent) {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  const requests = [];
  // A regex, not a glob: the loader URL carries a query string
  // (`?id=G-PFN3BBLC0E`), which a path glob silently fails to match — the
  // request would then escape to the real network and the check would report
  // "no request" for the wrong reason.
  await page.route(/googletagmanager\.com/, async (route) => {
    requests.push(route.request().url());
    await route.fulfill({ status: 200, contentType: "text/javascript", body: STUB_GTAG });
  });
  if (consent) {
    // A returning visitor: the choice is already stored before the page loads.
    await page.addInitScript(
      (value) => window.localStorage.setItem("grynd_cookie_consent", value),
      consent,
    );
  }
  page.__requests = requests;
  await page.goto(fileUrl);
  await page.waitForFunction(() => Boolean(window.__ga));
  return page;
}

const state = (page) =>
  page.evaluate(() => ({
    consent: window.__ga.consent(),
    scriptTags: window.__ga.scriptTags(),
    loads: window.__ga.loads,
    dataLayer: window.__ga.dataLayer(),
    disabled: window.__ga.disabled(),
    errors: window.__ga.errors,
    libLoaded: Boolean(window.__gtagLibLoaded),
  }));

// ══════════════════════════════════════════════════════════════════════════
//  PHASE 1 — no consent yet: the tag is not there at all
// ══════════════════════════════════════════════════════════════════════════
console.log("\n=== PHASE 1 — an undecided visitor sends nothing to Google ===\n");

const fresh = await newPage();
await fresh.waitForTimeout(400);
const undecided = await state(fresh);
check("no consent is stored yet", undecided.consent === null, String(undecided.consent));
check("no gtag script tag is in the DOM", undecided.scriptTags.length === 0, JSON.stringify(undecided.scriptTags));
check("no request was made to googletagmanager.com", fresh.__requests.length === 0, JSON.stringify(fresh.__requests));
check("the gtag loader never ran", !undecided.libLoaded);
check("no gtag call was queued", undecided.dataLayer.length === 0, JSON.stringify(undecided.dataLayer));

// ══════════════════════════════════════════════════════════════════════════
//  PHASE 2 — accepting loads Google's snippet
// ══════════════════════════════════════════════════════════════════════════
console.log("\n=== PHASE 2 — accepting turns the tag on ===\n");

await fresh.evaluate(() => window.__ga.accept());
await fresh.waitForFunction(() => window.__gtagLibLoaded === true, null, { timeout: 5000 }).catch(() => {});
await fresh.waitForTimeout(250);
const accepted = await state(fresh);

check("the choice is stored", accepted.consent === "accepted", String(accepted.consent));
check("the gtag.js loader was requested exactly once", fresh.__requests.length === 1, JSON.stringify(fresh.__requests));
check(
  "…for the right measurement ID",
  fresh.__requests[0] === GA_URL,
  String(fresh.__requests[0]),
);
check("the loader tag is in the DOM", accepted.scriptTags.length === 1, JSON.stringify(accepted.scriptTags));
check("the loader actually executed", accepted.libLoaded);
check(
  "the snippet ran gtag('js', <date>) then gtag('config', 'G-PFN3BBLC0E')",
  JSON.stringify(accepted.dataLayer) === JSON.stringify([["js", "date"], ["config", "G-PFN3BBLC0E"]]),
  JSON.stringify(accepted.dataLayer),
);
check("GA's kill switch is not set", accepted.disabled === false);
check("no runtime error surfaced", accepted.errors.length === 0, JSON.stringify(accepted.errors));

// ══════════════════════════════════════════════════════════════════════════
//  PHASE 3 — a returning visitor who already accepted
// ══════════════════════════════════════════════════════════════════════════
console.log("\n=== PHASE 3 — a returning visitor who already accepted ===\n");

const returning = await newPage("accepted");
await returning
  .waitForFunction(() => window.__gtagLibLoaded === true, null, { timeout: 5000 })
  .catch(() => {});
await returning.waitForTimeout(250);
const already = await state(returning);
check("the tag loads without any new interaction", already.libLoaded);
check("…exactly once", returning.__requests.length === 1, JSON.stringify(returning.__requests));
check("…and is configured", JSON.stringify(already.dataLayer) === JSON.stringify([["js", "date"], ["config", "G-PFN3BBLC0E"]]), JSON.stringify(already.dataLayer));

// ══════════════════════════════════════════════════════════════════════════
//  PHASE 4 — declining / withdrawing consent
// ══════════════════════════════════════════════════════════════════════════
console.log("\n=== PHASE 4 — declining and changing your mind ===\n");

const decliner = await newPage("declined");
await decliner.waitForTimeout(400);
const declined = await state(decliner);
check("a declined visitor makes no request", decliner.__requests.length === 0, JSON.stringify(decliner.__requests));
check("…and has no gtag tag in the DOM", declined.scriptTags.length === 0, JSON.stringify(declined.scriptTags));
check("…and the kill switch is set anyway", declined.disabled === true);

// Accept, then withdraw in the same session: the loader must not be fetched
// again, and GA must be silenced from that point on.
await decliner.evaluate(() => window.__ga.accept());
await decliner.waitForFunction(() => window.__gtagLibLoaded === true, null, { timeout: 5000 }).catch(() => {});
await decliner.waitForTimeout(200);
const afterAccept = decliner.__requests.length;
await decliner.evaluate(() => window.__ga.decline());
await decliner.waitForTimeout(200);
const withdrawn = await state(decliner);
check("withdrawing consent sets GA's kill switch", withdrawn.disabled === true);
check("…without fetching the loader again", decliner.__requests.length === afterAccept, `${afterAccept} → ${decliner.__requests.length}`);

// Flipping consent repeatedly must not stack loaders.
await decliner.evaluate(() => window.__ga.accept());
await decliner.waitForTimeout(200);
await decliner.evaluate(() => window.__ga.decline());
await decliner.waitForTimeout(200);
const flipped = await state(decliner);
check(
  "flipping consent back and forth never double-loads the loader",
  decliner.__requests.length === 1,
  JSON.stringify(decliner.__requests),
);
check("the kill switch tracks the latest choice", flipped.disabled === true);
check("no runtime error surfaced", flipped.errors.length === 0, JSON.stringify(flipped.errors));

await fresh.screenshot({ path: join(REPORTS, "google-analytics-accepted.png") });
await browser.close();

console.log(`\n${pass} passed / ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
