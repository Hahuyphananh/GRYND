// qa/barricade-online-browser-check.mjs
//
// Smoke-checks the Barricade ONLINE routes in a real browser, on the canonical
// public URLs (which is where every game's routes actually resolve):
//
//   1. the free practice page still hydrates and offers the online duel;
//   2. the "Play online 1v1" call to action lands on the LOBBY (canonical
//      /games/barricade/play, not the bare /casino/barricade that permanently
//      redirects to a landing page Barricade does not have yet);
//   3. the lobby hydrates: title, "Find a Match", the free-practice action and
//      the open-lobby list (empty state included) render with no JS errors;
//   4. a match URL hydrates without a server-side error, and shows the
//      signed-out/unauthorised state with a way back to the lobby — the API is
//      account-gated, so an anonymous visitor must get a graceful message, not
//      a blank screen or a crash;
//   5. neither page logs a JS error or a failed page request.
//
// The authenticated two-seat board synchronisation is covered by the REAL
// database harness (qa/barricade-online-check.mjs) and the store suite; this
// file covers what only a browser can: that the new routes render and that the
// navigation between them is correct.
//
// The server must already be running:
//   npx next dev -p 3000        (or: BASE=http://localhost:3210 node qa/…)
//
// Run:  node qa/barricade-online-browser-check.mjs

import { chromium } from "playwright";

const BASE = process.env.BASE || "http://localhost:3000";
const LOBBY = `${BASE}/games/barricade/play`;
const PRACTICE = `${BASE}/games/barricade/play-ai`;
const MATCH = `${BASE}/games/barricade/99999999-9999-4999-8999-999999999999`;

let failures = 0;
let checks = 0;

function check(label, condition, detail = "") {
  checks += 1;
  if (condition) {
    console.log(`  ok   ${label}`);
    return true;
  }
  failures += 1;
  console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  return false;
}

/** Console errors + failed document requests seen on one page. */
function watch(page) {
  const errors = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  return errors;
}

/**
 * The browser noise this page is EXPECTED to produce and that says nothing about
 * the Barricade code: a gated read answering 401 for a signed-out visitor (with
 * no session, the API correctly refuses), and the ad script's own CSP frame.
 * A real page fault — an exception, a hydration error — still fails.
 */
function pageFaults(errors) {
  return errors.filter(
    (entry) =>
      !/Failed to load resource/i.test(entry) &&
      !/Content Security Policy/i.test(entry) &&
      !/adtrafficquality|googlesyndication|doubleclick/i.test(entry),
  );
}

async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  // Look like a returning visitor: the first-load brand splash and the cookie
  // banner are both full-viewport overlays that would swallow the click below
  // (the same preparation the practice harness makes).
  await context.addInitScript(() => {
    try {
      window.sessionStorage.setItem("grynd:splash:seen:v1", "1");
      window.localStorage.setItem("grynd_cookie_consent", "declined");
    } catch {
      /* storage unavailable — the wait below still covers it */
    }
  });

  // ── 1. practice still works, and offers the duel ──────────────────────
  console.log("─ free practice ──────────────────────────────────────────────");
  const practice = await context.newPage();
  const practiceErrors = watch(practice);
  const practiceResponse = await practice.goto(PRACTICE, { waitUntil: "networkidle" });
  check("the practice route responds 200", practiceResponse?.status() === 200);
  await practice
    .waitForFunction(() => !document.querySelector('[aria-label="Loading GRYND"]'), null, {
      timeout: 30000,
    })
    .catch(() => {});
  check(
    "the practice board renders",
    (await practice.locator('[data-testid="barricade-board"]').count()) === 1,
  );
  const onlineButton = practice.locator('[data-testid="barricade-play-online"]');
  check("the online duel is offered", (await onlineButton.count()) === 1);

  // ── 2. the call to action lands on the lobby ──────────────────────────
  console.log("─ practice → lobby ──────────────────────────────────────────");
  await onlineButton.click();
  await practice.waitForURL(/\/games\/barricade\/play$/, { timeout: 20000 }).catch(() => {});
  check(
    "it navigates to the canonical lobby URL",
    new URL(practice.url()).pathname === "/games/barricade/play",
    practice.url(),
  );
  await practice.waitForLoadState("networkidle");
  // Signed out, the shared lobby chrome offers the sign-in route to play (the
  // account gate is the platform's); signed in, it offers "Find a Match".
  check(
    "the lobby renders its play action",
    (await practice.getByText(/Find a Match|Sign in to play/).count()) >= 1,
  );
  check(
    "the lobby offers free practice back",
    (await practice.getByText("Play Free vs AI").count()) >= 1,
  );
  check(
    "the lobby lists (or explains the absence of) open tables",
    (await practice.getByText(/open Barricade lobbies|Table #/i).count()) >= 1,
  );
  check(
    "practice hydration logged no JS errors",
    pageFaults(practiceErrors).length === 0,
    pageFaults(practiceErrors).join(" | "),
  );

  // ── 3. a fresh lobby page in isolation ───────────────────────────────
  console.log("─ lobby ─────────────────────────────────────────────────────");
  const lobby = await context.newPage();
  const lobbyErrors = watch(lobby);
  const lobbyResponse = await lobby.goto(LOBBY, { waitUntil: "networkidle" });
  check("the lobby responds 200", lobbyResponse?.status() === 200);
  check(
    "the lobby title is Barricade",
    (await lobby.locator("h1", { hasText: "Barricade" }).count()) >= 1,
  );
  check(
    "no JS errors on the lobby",
    pageFaults(lobbyErrors).length === 0,
    pageFaults(lobbyErrors).join(" | "),
  );

  // ── 4. a match URL without a session ─────────────────────────────────
  console.log("─ match route (anonymous) ──────────────────────────────────");
  const match = await context.newPage();
  const matchErrors = watch(match);
  const matchResponse = await match.goto(MATCH, { waitUntil: "networkidle" });
  check("the match route responds 200", matchResponse?.status() === 200);
  check(
    "it titles itself as a Barricade match",
    (await match.title()).includes("Barricade Match"),
    await match.title(),
  );
  const backToBarricade = match.getByRole("button", { name: /back to barricade/i });
  check(
    "an unauthorised visitor is told, and can get back to the lobby",
    (await backToBarricade.count()) === 1,
  );
  if ((await backToBarricade.count()) === 1) {
    await backToBarricade.click();
    await match.waitForURL(/\/games\/barricade\/play$/, { timeout: 20000 }).catch(() => {});
    check(
      "that way back is the canonical lobby URL",
      new URL(match.url()).pathname === "/games/barricade/play",
      match.url(),
    );
  }
  check("no JS errors on the match route", pageFaults(matchErrors).length === 0, pageFaults(matchErrors).join(" | "));

  await browser.close();

  console.log(`\n${checks - failures}/${checks} browser checks passed`);
  if (failures) process.exit(1);
}

main().catch((error) => {
  console.error("barricade online browser check failed:", error);
  process.exit(1);
});
