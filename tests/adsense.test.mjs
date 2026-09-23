// tests/adsense.test.mjs
//
// Contract tests for the Google AdSense loader.
//
// AdSense is the one third-party script we deliberately do NOT load
// everywhere. It is scoped to the pages a player browses *between* games —
// the home page, the game hub, the leaderboard, the battlepass and the game
// lobbies — and it must stay off:
//
//   1. every match page (the `[matchId]` / `game/[gameId]` / `table/[tableId]`
//      routes) — an ad next to a wager in progress is an intrusion; and
//   2. the games whose lobby and board are ONE page (Dice Flush and Odds
//      today), where there is no lobby route to scope to that isn't the board.
//
// Both of those are easy to break by accident, and the failure is silent: an
// extra page just starts showing ads. So the page list below is asserted as an
// exact SET against what the app actually renders — a new page that picks the
// loader up, or a protected page that gains it, fails this test by name.
//
// Like Google Analytics, the loader is CONSENT-GATED, so the second contract
// is the render guard: nothing may be mounted, and no request made, until the
// visitor accepts. The snippet is asserted VERBATIM against Google's, because
// the publisher ID and the `crossorigin` attribute are what make it work.
//
// Run:  node --test tests/adsense.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

/** Assertions test CODE, not the prose that explains it. */
const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "");

const TAG = read("src/components/AdSenseScript.tsx");
const TAG_CODE = code(TAG);
const LAYOUT = read("src/app/layout.tsx");
const PROXY = read("src/proxy.ts");

const CLIENT = "ca-pub-4903728316211815";

/**
 * Every page allowed to render the loader, as a repo-relative POSIX path.
 *
 * The four "main" pages:
 *   /            /games (src/app/casino)   /classement   /battlepass
 *
 * The game LOBBIES — one per game that keeps its board on a separate match
 * route, plus the Hex Duel and Uno multiplayer waiting rooms.
 */
const ALLOWED = [
  // main pages
  "src/app/page.jsx",
  "src/app/casino/page.jsx",
  "src/app/classement/page.jsx",
  "src/app/battlepass/page.jsx",
  // game lobbies (lobby route only — the board lives elsewhere)
  "src/app/casino/blackjack/page.tsx",
  "src/app/casino/chess/page.jsx",
  "src/app/casino/crash-arena/page.jsx",
  "src/app/casino/dots-and-boxes/page.tsx",
  "src/app/casino/four-in-a-row/page.tsx",
  "src/app/casino/hex-duel/multiplayer/page.tsx",
  "src/app/casino/lane-runner/page.jsx",
  "src/app/casino/memory-grid/page.tsx",
  "src/app/casino/mines-pvp/page.tsx",
  "src/app/casino/plinko/page.tsx",
  "src/app/casino/pool-masters/page.tsx",
  "src/app/casino/precision/page.tsx",
  "src/app/casino/roulette/page.jsx",
  "src/app/casino/rps/page.tsx",
  "src/app/casino/tower-arena/page.tsx",
  "src/app/casino/uno/page.jsx",
  "src/app/casino/uno/multiplayer/page.tsx",
];

/** Every route file in src/app (page.*), as repo-relative POSIX paths. */
function allPageFiles() {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/^page\.(jsx?|tsx?)$/.test(entry)) found.push(full);
    }
  };
  walk(join(ROOT, "src/app"));
  return found.map((p) => relative(ROOT, p).split(sep).join("/")).sort();
}

/** The pages that actually render <AdSenseScript />. */
function pagesRenderingTag() {
  return allPageFiles()
    .filter((p) => /<AdSenseScript\s*\/>/.test(read(p)))
    .sort();
}

test("the loader is Google's snippet, for the right publisher", () => {
  assert.ok(
    TAG_CODE.includes(`export const ADSENSE_CLIENT = "${CLIENT}";`),
    "the publisher ID must be the one AdSense issued for this property",
  );
  // Verbatim parts of the snippet: the async loader, the ?client= query and
  // the crossorigin attribute. Dropping crossorigin breaks ad serving on
  // origins that require a CORS-clean request.
  assert.ok(
    TAG_CODE.includes(
      'src={`https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${ADSENSE_CLIENT}`}',
    ),
    "the tag must load adsbygoogle.js?client= from pagead2.googlesyndication.com",
  );
  assert.match(TAG_CODE, /crossOrigin="anonymous"/, "the tag must be crossorigin=anonymous");
  assert.match(TAG_CODE, /^\s*async$/m, "the tag must be async");
});

test("the loader is a client component on the afterInteractive path", () => {
  assert.ok(TAG.trimStart().startsWith('"use client";'), "must be a client component");
  // afterInteractive keeps the third-party loader off the critical path, so it
  // can never compete with hydration.
  assert.match(TAG_CODE, /strategy="afterInteractive"/, "must not block hydration");
});

test("it stays behind the cookie-consent gate", () => {
  assert.ok(
    TAG_CODE.includes('import { COOKIE_CONSENT_EVENT, getCookieConsent } from "../lib/cookieConsent";'),
    "consent must come from the one shared helper the banner also writes",
  );
  assert.ok(TAG_CODE.includes('getCookieConsent() === "accepted"'), "gate on an explicit accept");
  // The gate has to be a render guard, not just a flag: nothing may be mounted
  // (or fetched) while consent is missing or declined.
  assert.ok(TAG_CODE.includes("if (!accepted) return null;"), "must render nothing without consent");
  // Accepting in the banner must enable ads in the same session, without a
  // reload; another tab's choice syncs through `storage`.
  assert.ok(TAG_CODE.includes("window.addEventListener(COOKIE_CONSENT_EVENT, sync);"));
  assert.ok(TAG_CODE.includes('window.addEventListener("storage", sync);'));
  assert.ok(TAG_CODE.includes("window.removeEventListener(COOKIE_CONSENT_EVENT, sync);"));
  assert.ok(TAG_CODE.includes('window.removeEventListener("storage", sync);'));
  // Consent is read, never re-implemented — the banner stays the single source
  // of truth for the shared key.
  assert.ok(
    !/localStorage|grynd_cookie_consent/.test(TAG_CODE),
    "consent must be read through lib/cookieConsent, never re-implemented",
  );
});

test("the ad tag is rendered on exactly the allowed pages", () => {
  assert.deepEqual(
    pagesRenderingTag(),
    [...ALLOWED].sort(),
    "the set of pages rendering <AdSenseScript /> drifted from the allow-list",
  );
});

test("no match page ever carries the ad tag", () => {
  const offenders = pagesRenderingTag().filter((p) => /\[[^\]]+\]/.test(p));
  assert.deepEqual(
    offenders,
    [],
    "match pages are dynamic ([matchId], game/[gameId], table/[tableId]) and must stay ad-free",
  );
});

test("games whose lobby and board are one page stay ad-free", () => {
  // Dice Flush and Odds are played start-to-finish on their lobby URL, so any
  // tag there would sit on the board itself. Keno (solo), Poker's combined
  // table page and the Neon Flush reskins are excluded the same way.
  const combined = pagesRenderingTag().filter((p) =>
    /dice-flush|odds|keno|poker|neon-flush/.test(p),
  );
  assert.deepEqual(combined, [], "lobby-and-board-in-one games must stay ad-free");
});

test("the ad tag is never global", () => {
  // A single render site in the root layout would put ads on every match page
  // too. Scoping is the whole point of this component.
  assert.ok(
    !/AdSenseScript/.test(LAYOUT),
    "the loader must not be mounted in src/app/layout.tsx — it is per-page by design",
  );
});

test("each allowed page renders the tag exactly once", () => {
  for (const page of ALLOWED) {
    const renders = read(page).match(/<AdSenseScript\s*\/>/g) || [];
    assert.equal(renders.length, 1, `${page} must render <AdSenseScript /> exactly once`);
  }
});

test("the CSP lets AdSense's ad frames through", () => {
  // script-src, img-src and connect-src already allow all of `https:`, so the
  // only directive that needs naming is frame-src — each ad unit renders in a
  // cross-origin iframe. Without these the loader downloads and then silently
  // paints nothing.
  const frameSrc = PROXY.match(/frame-src [^;]+;/);
  assert.ok(frameSrc, "the CSP must keep an explicit frame-src directive");
  assert.match(frameSrc[0], /googlesyndication\.com/, "ad frames come from googlesyndication.com");
  assert.match(frameSrc[0], /doubleclick\.net/, "ad frames come from doubleclick.net");
});

test("the alias routes inherit the tag by rendering, not by importing it", () => {
  // /uno and /games/neon-flush re-export the Uno pages, so they pick the loader
  // up for free. They must keep doing that rather than importing the component
  // directly — a second render site would be untracked by the allow-list.
  for (const alias of [
    "src/app/uno/page.tsx",
    "src/app/uno/multiplayer/page.tsx",
    "src/app/casino/neon-flush/page.tsx",
    "src/app/casino/neon-flush/multiplayer/page.tsx",
  ]) {
    assert.ok(
      !/AdSenseScript/.test(read(alias)),
      `${alias} is an alias and must inherit the tag by rendering the Uno page`,
    );
  }
});
