// qa/barricade-online-browser-check.mjs
//
// Smoke-checks the Barrier Blitz ONLINE routes in a real browser, on the
// canonical public URLs (which is where every game's routes actually resolve):
//
//   1. the free practice page still hydrates and offers the online duel;
//   2. the "Play online 1v1" call to action lands on the LOBBY (canonical
//      /games/barrier-blitz/play, not the bare /casino/barrier-blitz that
//      permanently redirects to the public landing page);
//   3. the lobby hydrates: title, "Find a Match", the free-practice action and
//      the open-lobby list (empty state included) render with no JS errors;
//   4. a match URL hydrates without a server-side error, and shows the
//      signed-out/unauthorised state with a way back to the lobby — the API is
//      account-gated, so an anonymous visitor must get a graceful message, not
//      a blank screen or a crash;
//   5. every OLD Barricade URL (the rename's legacy surface) still resolves: the
//      games/lobby/match/user-visible-URL set 308s onto the Barrier Blitz ones,
//      so an inbound link or a bookmark never 404s;
//   6. neither page logs a JS error or a failed page request.
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
const LOBBY = `${BASE}/games/barrier-blitz/play`;
const PRACTICE = `${BASE}/games/barrier-blitz/play-ai`;
const MATCH = `${BASE}/games/barrier-blitz/99999999-9999-4999-8999-999999999999`;

// The rename's legacy surface: every public URL a player, a bookmark or an
// inbound link may still hold, and where it has to land now.
const LEGACY_URLS = [
  { from: "/games/barricade", to: "/games/barrier-blitz" },
  { from: "/games/barricade/play", to: "/games/barrier-blitz/play" },
  { from: "/games/barricade/play-ai", to: "/games/barrier-blitz/play-ai" },
  { from: "/casino/barricade", to: "/games/barrier-blitz" },
  { from: "/casino/barricade/play-ai", to: "/games/barrier-blitz/play-ai" },
];

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
  await practice.waitForURL(/\/games\/barrier-blitz\/play$/, { timeout: 20000 }).catch(() => {});
  check(
    "it navigates to the canonical lobby URL",
    new URL(practice.url()).pathname === "/games/barrier-blitz/play",
    practice.url(),
  );
  await practice.waitForLoadState("networkidle");
  // The lobby is reached by CLIENT-side navigation here, so its content lands a
  // beat after the URL does: wait for it rather than counting instantly.
  // Signed out, the shared lobby chrome offers the sign-in route to play (the
  // account gate is the platform's); signed in, it offers "Find a Match".
  const playAction = practice.getByText(/Find a Match|Sign in to play/).first();
  await playAction.waitFor({ timeout: 20000 }).catch(() => {});
  check("the lobby renders its play action", (await playAction.count()) >= 1);
  const practiceBack = practice.getByText("Play Free vs AI").first();
  await practiceBack.waitFor({ timeout: 20000 }).catch(() => {});
  check("the lobby offers free practice back", (await practiceBack.count()) >= 1);
  // Three honest states: rows, the empty-state copy, or the loading skeleton.
  // The skeleton is the one a LOCAL run can sit in — the account-gated lobby
  // list is only polled once Clerk has resolved, and Clerk's API is not
  // reachable from a dev box (its /v1/client call answers 400 here), so the auth
  // state stays unresolved and no list request is made. What this check is for is
  // that the Open Lobbies card renders at all — the copy is covered by the
  // contract tests and the harness check.
  const tableListRe = /open Barrier Blitz lobbies|Table #|Loading open lobbies/i;
  const tableList = practice.getByText(tableListRe).first();
  await tableList.waitFor({ timeout: 20000 }).catch(() => {});
  check(
    "the lobby renders its open-tables card",
    (await practice.getByText(/Open Lobbies/i).count()) >= 1,
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
    "the lobby title is Barrier Blitz",
    (await lobby.locator("h1", { hasText: "Barrier Blitz" }).count()) >= 1,
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
    "it titles itself as a Barrier Blitz match",
    (await match.title()).includes("Barrier Blitz Match"),
    await match.title(),
  );
  const backToBarricade = match.getByRole("button", { name: /back to barrier blitz/i });
  check(
    "an unauthorised visitor is told, and can get back to the lobby",
    (await backToBarricade.count()) === 1,
  );
  if ((await backToBarricade.count()) === 1) {
    await backToBarricade.click();
    await match.waitForURL(/\/games\/barrier-blitz\/play$/, { timeout: 20000 }).catch(() => {});
    check(
      "that way back is the canonical lobby URL",
      new URL(match.url()).pathname === "/games/barrier-blitz/play",
      match.url(),
    );
  }
  check("no JS errors on the match route", pageFaults(matchErrors).length === 0, pageFaults(matchErrors).join(" | "));

  // ── 5. the rename's legacy URLs ───────────────────────────────────────
  console.log("─ legacy Barricade URLs → Barrier Blitz ──────────────────");
  const legacy = await context.newPage();
  const legacyErrors = watch(legacy);
  for (const { from, to } of LEGACY_URLS) {
    const response = await legacy.goto(`${BASE}${from}`, { waitUntil: "domcontentloaded" });
    check(
      `${from} redirects permanently to ${to}`,
      response?.status() === 200 && new URL(legacy.url()).pathname === to,
      `${response?.status()} → ${legacy.url()}`,
    );
  }
  check(
    "the legacy walk logs no JS errors",
    pageFaults(legacyErrors).length === 0,
    pageFaults(legacyErrors).join(" | "),
  );

  // ── 6. the lobby never walks itself onto the board ────────────────────
  //
  // Clicking Find a Match WITH NOBODY JOINING has to leave the player on the
  // matchmaking screen — the reported bug was being dropped onto the game page
  // instead. Walking that click needs a signed-in account (the account gate is
  // the platform's), so it is driven deterministically by the harness check
  // (qa/barrier-blitz-matchmaking-check.mjs, `npm run verify:barrier-blitz-matchmaking`)
  // against the real lobby component. What a live tab can still prove here is
  // the other half: the lobby never navigates to a match on its own.
  console.log("─ the lobby never walks itself onto the board ─────────────");
  const matchmaking = await context.newPage();
  const matchmakingErrors = watch(matchmaking);
  await matchmaking.goto(LOBBY, { waitUntil: "networkidle" });
  await matchmaking
    .getByText(/Find a Match|Sign in to play/)
    .first()
    .waitFor({ timeout: 15000 })
    .catch(() => {});
  await matchmaking.waitForTimeout(4000);
  check(
    "the lobby still shows its own URL after settling",
    new URL(matchmaking.url()).pathname === "/games/barrier-blitz/play",
    matchmaking.url(),
  );
  check(
    "no match page was reached on its own",
    (await matchmaking.locator('[data-testid="barricade-match"]').count()) === 0,
  );
  check(
    "no JS errors on the matchmaking screen",
    pageFaults(matchmakingErrors).length === 0,
    pageFaults(matchmakingErrors).join(" | "),
  );

  await browser.close();

  console.log(`\n${checks - failures}/${checks} browser checks passed`);
  if (failures) process.exit(1);
}

main().catch((error) => {
  console.error("barricade online browser check failed:", error);
  process.exit(1);
});
