// tests/adsense.test.mjs
//
// Contract tests for the AdSense loader and the consent architecture around it.
//
// AdSense is the one third-party script we deliberately do NOT load everywhere.
// It is scoped to the pages a player browses *between* games — the home page,
// the game hub, the leaderboard, the battlepass and the game lobbies — and it
// must stay off:
//
//   1. every match page (the `[matchId]` / `game/[gameId]` / `table/[tableId]`
//      routes) — an ad next to a wager in progress is an intrusion; and
//   2. the games whose lobby and board are ONE page (Dice Flush and Odds
//      today), where there is no lobby route to scope to that isn't the board.
//
// The page list is asserted as an exact SET against what the app actually
// renders, so a new page that picks the loader up — or a protected page that
// gains it — fails by name.
//
// Four more contracts are pinned here, and all four are silent when broken:
//
//   - the tag is SERVER-RENDERED, because Google's site review reads the served
//     HTML for it and Google's certified CMP is delivered by that same tag;
//   - the tag is CONFIGURATION-DRIVEN (lib/ads.ts) and ENTITLEMENT-GATED: a
//     GRYND PRO member's response contains no ad tag at all, and no publisher
//     or slot id is ever invented in code;
//   - Consent Mode defaults start DENIED, and come first in <head>, because a
//     tag that loads before them reads no consent state;
//   - our own banner is suppressed for the EEA/UK/CH, where Google's CMP has to
//     be the only prompt, and its answer is mirrored back for the rest;
//   - a withdrawal route exists, because GDPR art. 7(3) requires that a choice
//     be as easy to change as it was to make.
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
const ADS_CONFIG = read("src/lib/ads.ts");
const ENTRYPOINT = read("src/lib/adEntitlement.ts");
const LAYOUT = read("src/app/layout.tsx");
const PROXY = read("src/proxy.ts");
const CONSENT_MODE = read("src/components/ConsentModeDefault.tsx");
const SETTINGS_LINK = read("src/components/CookieSettingsLink.tsx");
const REGIONS = read("src/lib/consentRegions.ts");

// The publisher this property is authorised under. It is asserted against
// BOTH the config module and ads.txt, so the two can never disagree.
const CLIENT = "ca-pub-4903728316211815";

/**
 * Every page allowed to render the loader, as a repo-relative POSIX path: the
 * four "main" pages, plus one LOBBY per game that keeps its board on a
 * separate match route.
 */
const ALLOWED = [
  // main pages
  "src/app/page.jsx",
  "src/app/casino/page.jsx",
  "src/app/classement/page.jsx",
  "src/app/battlepass/page.jsx",
  "src/app/profil/page.jsx",
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
  // The publisher id lives in the config module (env-overridable, with the
  // authorised id as the documented fallback) — never inline in the tag.
  assert.ok(
    ADS_CONFIG.includes(`DEFAULT_ADSENSE_PUBLISHER_ID = "${CLIENT}"`),
    "the publisher ID must be the one AdSense issued for this property",
  );
  assert.match(
    ADS_CONFIG,
    /process\.env\.NEXT_PUBLIC_ADSENSE_CLIENT/,
    "the publisher id must come from the environment",
  );
  assert.ok(
    TAG_CODE.includes(
      "src={`https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${client}`}",
    ),
    "the tag must load adsbygoogle.js?client= from pagead2.googlesyndication.com",
  );
  assert.match(TAG_CODE, /crossOrigin="anonymous"/, "the tag must be crossorigin=anonymous");
  assert.match(TAG_CODE, /^\s*async$/m, "the tag must be async");
});

test("a GRYND PRO member receives no ad tag at all", () => {
  // Server-authoritative: the tag is decided from the caller's own subscription
  // row, so a member's HTML contains no ad code and makes no ad request.
  assert.match(TAG_CODE, /isAdFreeViewer\(\)/, "the loader must check entitlement server-side");
  assert.match(
    code(ENTRYPOINT),
    /getMembershipTier\(userId\)/,
    "entitlement must come from the membership record, not a client flag",
  );
  assert.ok(
    !/premium/i.test(TAG_CODE),
    "the loader takes no caller-supplied premium flag",
  );
});

test("the tag is switched off by configuration, never by fake ids", () => {
  assert.match(TAG_CODE, /adsEnabled\(\)/);
  assert.match(TAG_CODE, /normalizePublisherId\(/, "a malformed publisher id must not emit a tag");
  assert.match(
    code(ADS_CONFIG),
    /NEXT_PUBLIC_ADSENSE_ENABLED/,
    "ads must be switchable off from the environment",
  );
  // No invented ad-unit ids: every placement id is read from its env var.
  assert.ok(
    !/\bdata-ad-slot="\d/.test(ADS_CONFIG + TAG_CODE),
    "no slot id may be hardcoded in source",
  );
});

test("the tag is server-rendered, never gated behind a consent click", () => {
  // This is the load-bearing property. A client-gated tag is absent from the
  // HTML we serve, which breaks two things at once: Google's site review reads
  // that HTML for adsbygoogle.js, and Google's certified CMP is DELIVERED by
  // the tag — so no tag means no consent message in the EEA/UK/CH at all.
  assert.ok(
    !TAG_CODE.includes('"use client"'),
    "the loader must be a server component: the tag has to be in the initial HTML",
  );
  assert.ok(
    !/getCookieConsent|useState|useEffect/.test(TAG_CODE),
    "the loader must not gate on client consent state — Consent Mode governs serving instead",
  );
});

test("Consent Mode defaults deny every signal, before any Google tag", () => {
  for (const signal of ["ad_storage", "ad_user_data", "ad_personalization", "analytics_storage"]) {
    assert.match(
      code(CONSENT_MODE),
      new RegExp(`${signal}: 'denied'`),
      `${signal} must default to denied — nothing may be granted before the visitor answers`,
    );
  }
  // Half a second for a consent source to arrive before tags fire in the
  // denied state; without it a returning visitor who already consented would
  // be measured as anonymous.
  assert.match(code(CONSENT_MODE), /wait_for_update: 500/);
  // Redact ad click identifiers while ad_storage is denied.
  assert.match(code(CONSENT_MODE), /ads_data_redaction/);
  assert.ok(
    !/url_passthrough/.test(code(CONSENT_MODE)),
    "url_passthrough is for Google Ads conversion tracking, which this property does not run",
  );
});

test("the consent default is declared first in the layout's <head>", () => {
  // Declared-first, not served-first: React hoists the ad tag's `async` script
  // above this one in the emitted HTML (verified against the running server),
  // which is precisely what wait_for_update absorbs. That is why the two
  // assertions below belong together — moving the tag or dropping the wait
  // would reopen the gap between them.
  assert.ok(
    LAYOUT.includes('import ConsentModeDefault from "../components/ConsentModeDefault";'),
    "the layout must render the consent default",
  );
  assert.match(
    code(CONSENT_MODE),
    /wait_for_update: 500/,
    "wait_for_update is what covers React hoisting the ad tag ahead of this script",
  );
  const head = LAYOUT.match(/<head>[\s\S]*?<\/head>/);
  assert.ok(head, "the layout must keep an explicit <head>");
  // Strip the opening tag and any JSX comment (the explanatory comment below
  // mentions "<head>" in prose, which would otherwise be matched as a tag),
  // then take the first element actually rendered inside.
  const headInner = head[0]
    .replace(/^<head>/, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
  const firstTag = headInner.match(/<(\w+|ConsentModeDefault)[\s/>]/);
  assert.equal(
    firstTag?.[1],
    "ConsentModeDefault",
    "the consent default must be the first thing in <head>, or a Google tag can load before it",
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
  // tag there would sit on the board itself. Keno, Poker's combined table page
  // and the Neon Flush reskins are excluded the same way.
  const combined = pagesRenderingTag().filter((p) =>
    /dice-flush|odds|keno|poker|neon-flush/.test(p),
  );
  assert.deepEqual(combined, [], "lobby-and-board-in-one games must stay ad-free");
});

test("the ad tag is never global", () => {
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
  // cross-origin iframe, and Google's consent message is served from its own
  // host. Without these the loader downloads and then silently paints nothing.
  const frameSrc = PROXY.match(/frame-src [^;]+;/);
  assert.ok(frameSrc, "the CSP must keep an explicit frame-src directive");
  assert.match(frameSrc[0], /googlesyndication\.com/, "ad frames come from googlesyndication.com");
  assert.match(frameSrc[0], /doubleclick\.net/, "ad frames come from doubleclick.net");
  assert.match(
    frameSrc[0],
    /fundingchoicesmessages\.google\.com/,
    "the consent message is served from fundingchoicesmessages.google.com",
  );
});

test("public/ads.txt authorises this exact publisher as a direct seller", () => {
  // The publisher ID lives in two places — the page source and ads.txt — and
  // only one of them is visible in the browser. Deriving the expected line from
  // the component means a change to ADSENSE_CLIENT can't silently leave ads.txt
  // authorising a different (or no) seller, which AdSense reports as "Earnings
  // at risk" long after the fact.
  const adsTxt = read("public/ads.txt");
  const publisher = CLIENT.replace(/^ca-/, "");
  assert.notEqual(publisher, CLIENT, "the ca- prefix must be stripped for ads.txt");

  // Comments (leading #) are allowed by the IAB spec; the data line is not.
  const dataLines = adsTxt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  assert.ok(dataLines.length > 0, "ads.txt must contain at least one data line");
  assert.ok(
    dataLines.includes(`google.com, ${publisher}, DIRECT, f08c47fec0942fa0`),
    "ads.txt must list our publisher as a DIRECT seller under Google's CA ID",
  );
});

test("EEA, UK and Swiss visitors get Google's CMP instead of our banner", () => {
  // The single prompt rule: Google requires its own certified CMP in these
  // regions, and running ours on top would be two prompts over two consent
  // records that can disagree.
  assert.ok(
    LAYOUT.includes("requiresGoogleCmp(countryFromHeaders(requestHeaders))"),
    "the layout must decide the region on the server from the request headers",
  );
  assert.match(
    LAYOUT,
    /<CookieConsentBanner suppressForCmp=\{requiresCmp\} \/>/,
    "our banner must stand aside where Google's CMP applies",
  );
  assert.match(
    LAYOUT,
    /<CmpConsentBridge enabled=\{requiresCmp\} \/>/,
    "the CMP decision must be mirrored back for the local consent record",
  );

  // Spot-check both ends of the region list.
  for (const country of ["DE", "FR", "ES", "IT", "PL", "SE", "NO", "IS", "LI", "GB", "CH"]) {
    assert.ok(REGIONS.includes(`"${country}"`), `${country} must be treated as an EEA/UK/CH region`);
  }
  assert.ok(
    REGIONS.includes('"x-vercel-ip-country"'),
    "the country must come from the edge header Vercel sets",
  );
});

test("a withdrawal route exists, and it reopens whichever prompt owns the visitor", () => {
  // GDPR art. 7(3): withdrawing must be as easy as consenting. The link has to
  // route to Google's CMP where that is the prompt, and to our banner otherwise.
  assert.match(
    SETTINGS_LINK,
    /callbackQueue\.push\(\{/,
    "Google's docs require every Privacy & messaging call to go through the callback queue",
  );
  assert.match(SETTINGS_LINK, /showRevocationMessage/, "the CMP route is showRevocationMessage()");
  assert.match(SETTINGS_LINK, /CONSENT_DATA_READY/, "the callback queue key must be CONSENT_DATA_READY");
  assert.match(
    SETTINGS_LINK,
    /new Event\(OPEN_CONSENT_BANNER_EVENT\)/,
    "the fallback must reopen our own banner",
  );
  assert.ok(
    read("src/components/Footer.tsx").includes("<CookieSettingsLink"),
    "the footer is where visitors look for it",
  );
  assert.ok(
    read("src/components/CookieConsentBanner.tsx").includes(
      "window.addEventListener(OPEN_CONSENT_BANNER_EVENT, reopen)",
    ),
    "the banner must listen for the reopen request it is sent",
  );
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
