// qa/solitaire-post-match-ad-check.mjs
//
// REAL-BROWSER CHECK: a finished solo run offers the post-match HilltopAds video.
//
// A solo run ends when the board is cleared. Rather than solve a deal by hand,
// this finishes one EXACTLY the way the app does: it plays a winning line
// through the app's own engine (`solveDealLine` over `dealFromSeed`), stores the
// resulting log as the browser's in-progress session, and opens /solitaire. The
// page replays that log through the same engine, so the board it shows is a
// genuinely solved game and its result panel is a genuine win.
//
// Then it asserts the ad surface, in this order:
//
//   1. the result panel is on screen (the run really ended);
//   2. picking an exit action makes the app request the post-match VAST tag —
//      i.e. the surface was OFFERED (the server gate answered yes, the cadence
//      allowed it, and the provider tag was fetched);
//   3. the exit action still runs once the slot settles, so an ad that never
//      fills can never strand the player on the result screen.
//
// Run against a BUILT server. The ad chain is a once-per-result mount; a dev
// server mounts it twice under React StrictMode, and the second mount is refused
// as a concurrent request (`inFlight` in lib/vast/client.ts), so no creative is
// fetched there. Production semantics are what this check is about:
//
//   npx next build && npx next start -p 3124
//   node --import tsx qa/solitaire-post-match-ad-check.mjs
//
// BASE_URL defaults to http://localhost:3124.

import { chromium } from "playwright";

import { dealFromSeed } from "../src/lib/solitaire-duel/deck.ts";
import { solveDealLine } from "../src/lib/solitaire-duel/solvable.ts";

const BASE = process.env.BASE_URL || "http://localhost:3124";
/** Any seed works — the deal is a plain shuffle and seed 1 is provably solvable. */
const SEED = 1;
const SESSION_KEY = "grynd.solitaire.session.v1";

const results = [];
function check(label, ok, detail = "") {
  results.push({ label, ok: Boolean(ok) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

const moves = (page) =>
  page.evaluate(() => {
    const dt = [...document.querySelectorAll("dt")].find(
      (node) => node.textContent.trim() === "Moves",
    );
    return dt?.nextElementSibling?.textContent.trim() ?? null;
  });

async function dismissOverlays(page) {
  for (const name of ["GOT IT", "Accept", "Decline"]) {
    const button = page.getByRole("button", { name, exact: true });
    if ((await button.count()) > 0 && (await button.first().isVisible().catch(() => false))) {
      await button.first().click({ force: true }).catch(() => {});
      await page.waitForTimeout(250);
    }
  }
}

// ── The finished run, played to the end through the app's own engine ───────
const deal = dealFromSeed(SEED);
const line = solveDealLine(deal);
if (!line || line.length === 0) {
  console.error(`seed ${SEED} is not solvable — this check needs a solved line`);
  process.exit(1);
}
const session = {
  mode: "solo",
  seed: SEED,
  dateKey: null,
  log: line.map((move) => ({ kind: move.kind, move })),
  startedAtMs: Date.now() - 90_000,
  endedAtMs: null,
  won: false,
};

const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(
    ([key, value]) => window.localStorage.setItem(key, value),
    [SESSION_KEY, JSON.stringify(session)],
  );
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));

  // The ad surface is the server's answer; this check is about what the page
  // does with a "yes". The VAST tag itself is stubbed to a no-fill answer, so no
  // third-party creative is fetched and the slot settles immediately.
  await page.route("**/api/ads/post-match", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ enabled: true, adFree: false }),
    }),
  );
  // The slot always asks the server first, so this request is the proof the
  // result screen actually opened the surface (as opposed to short-circuiting
  // it). The VAST tag request is the proof a creative was then sought.
  let surfaceRequests = 0;
  await page.route("**/api/ads/post-match", (route) => {
    surfaceRequests += 1;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ enabled: true, adFree: false }),
    });
  });
  const vastRequests = [];
  const externalHosts = new Set();
  page.on("request", (request) => {
    const url = request.url();
    if (/rude-movie\.com/.test(url)) vastRequests.push(url);
    if (!url.startsWith(BASE) && !url.startsWith("data:") && !url.startsWith("blob:")) {
      try {
        externalHosts.add(new URL(url).host);
      } catch {
        // Ignore an unparsable URL.
      }
    }
  });
  await page.route(/rude-movie\.com/, (route) => {
    vastRequests.push(route.request().url());
    return route.fulfill({ status: 204, body: "" });
  });

  await page.goto(`${BASE}/solitaire`, { waitUntil: "domcontentloaded" });
  await dismissOverlays(page);

  // A stored unfinished session is offered as a resume, so the board only
  // mounts once the player takes it. The stored log is a SOLVED game, so
  // resuming lands straight on the result panel.
  const resume = page.getByRole("button", { name: "Resume" });
  await page
    .waitForFunction(
      () =>
        Boolean(document.querySelector('[data-testid="solitaire-board"]')) ||
        [...document.querySelectorAll("button")].some(
          (node) => node.textContent.trim() === "Resume",
        ),
      null,
      { timeout: 90_000 },
    )
    .catch(() => {});
  if ((await resume.count()) > 0) await resume.first().click();
  await page.waitForSelector('[data-testid="solitaire-board"]', { timeout: 90_000 });
  await page.waitForTimeout(1200);

  const winPanel = page.getByRole("dialog", { name: "Game complete" });
  check(
    "the solo run reached its result panel",
    (await winPanel.count()) > 0 || /cleared the board|Personal best|Solved/i.test(await page.locator("body").innerText()),
  );

  const playAgain = page.getByRole("button", { name: "Play again" });
  check("the result offers an exit action", (await playAgain.count()) > 0);
  if (await playAgain.count()) {
    await playAgain.first().click();
  }

  // The slot answers asynchronously; give the tag request a moment to leave.
  for (let attempt = 0; attempt < 40 && vastRequests.length === 0; attempt += 1) {
    await page.waitForTimeout(250);
  }
  check(
    "the result screen opened the post-match ad surface",
    surfaceRequests > 0,
    `surface requests: ${surfaceRequests}`,
  );
  check(
    "the post-match video surface was offered (VAST tag requested)",
    vastRequests.length > 0,
    vastRequests.length > 0
      ? vastRequests[0].slice(0, 60)
      : surfaceRequests > 1
        ? "the surface was opened more than once — a dev-server StrictMode " +
          "double mount; run this check against `next start`"
        : surfaceRequests > 0
          ? "the surface was opened but the player refused it — check " +
            "NEXT_PUBLIC_POST_MATCH_ADS_ENABLED / NEXT_PUBLIC_HILLTOPS_ENABLED " +
            `(external hosts: ${[...externalHosts].join(", ") || "none"})`
          : "the result screen never opened the surface",
  );

  // No fill ⇒ the slot settles and the parked action runs: a fresh board.
  const dealt = await page
    .waitForFunction(
      () => {
        const dt = [...document.querySelectorAll("dt")].find(
          (node) => node.textContent.trim() === "Moves",
        );
        return dt?.nextElementSibling?.textContent.trim() === "0";
      },
      null,
      { timeout: 20_000 },
    )
    .then(() => true)
    .catch(() => false);
  check("the held exit action still runs when no creative fills", dealt, `moves ${await moves(page)}`);
  check("no uncaught page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
} finally {
  await browser.close();
}

const failed = results.filter((row) => !row.ok);
console.log(`\n${results.length - failed.length}/${results.length} post-match ad checks passed`);
if (failed.length > 0) {
  console.log("Failures:", failed.map((row) => row.label).join(", "));
  process.exitCode = 1;
}
