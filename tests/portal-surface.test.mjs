// tests/portal-surface.test.mjs
//
// The portal surface: /play/<gameKey> without site chrome, framable only by the
// portal allowlist, and wired to the CrazyGames SDK v3.
//
//   1. Which paths are the portal surface — and which are not.
//   2. The framing allowlist: exact origins, one wildcard shape, never `*`.
//   3. The SDK bridge: init once, start/stop paired, ads only between sessions.
//   4. The files actually wire it: route, chrome gate, proxy, event dispatch.
//
//   npm run test:portal-surface

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  buildPortalFrameAncestors,
  isPortalPlayPath,
  normalizePortalFrameOrigin,
  parsePortalFrameOrigins,
  applyPortalFramePolicy,
} from "../src/lib/portal/framing.ts";
import {
  AD_COOLDOWN_MS,
  PORTAL_MATCH_FINISHED_EVENT,
  createCrazyGamesBridge,
  isCrazyGamesContext,
} from "../src/lib/portal/crazygames.ts";
import { PORTAL_EXPORT_GAMES } from "../src/lib/portal/catalog.ts";
import {
  PORTAL_HOME_ORIGIN,
  offersPortalHome,
  portalHomeHref,
} from "../src/lib/portal/home.ts";
import { portalAwareHref } from "../src/lib/portal/routes.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), "utf8");

function fakeResponse(initial = {}) {
  const headers = new Map(Object.entries(initial));
  return {
    headers: {
      get: (name) => headers.get(name) ?? null,
      set: (name, value) => headers.set(name, value),
      delete: (name) => headers.delete(name),
    },
    has: (name) => headers.has(name),
    header: (name) => headers.get(name) ?? null,
  };
}

// ── 1. The path space ─────────────────────────────────────────────────────

test("only /play/<exportable game> is the portal surface", () => {
  for (const game of PORTAL_EXPORT_GAMES) {
    assert.equal(isPortalPlayPath(`/play/${game.gameKey}`), true);
    assert.equal(isPortalPlayPath(`/play/${game.gameKey}/`), true);
  }

  for (const other of [
    "/play",
    "/play/",
    "/play/chess", // real game, not exported
    "/play/dominoes/a/b", // too deep: a board id is one segment
    "/play/dominoes/../odds",
    "/casino/dominoes",
    "/games/dominoes",
    "/embed/crazygames/tic-tac-toe",
    "",
    null,
    undefined,
  ]) {
    assert.equal(isPortalPlayPath(other), false, String(other));
  }
});

// ── 2. The framing allowlist ──────────────────────────────────────────────

test("the allowlist accepts portal origins and one wildcard shape", () => {
  assert.equal(normalizePortalFrameOrigin("https://itch.io"), "https://itch.io");
  assert.equal(normalizePortalFrameOrigin("https://html.itch.zone"), "https://html.itch.zone");
  assert.equal(normalizePortalFrameOrigin("https://www.crazygames.com"), "https://www.crazygames.com");
  assert.equal(normalizePortalFrameOrigin("https://*.crazygames.com"), "https://*.crazygames.com");
  assert.equal(normalizePortalFrameOrigin("  HTTPS://ITCH.IO  "), "https://itch.io");
});

test("the allowlist refuses anything that would over-frames us", () => {
  for (const bad of [
    "*",
    "https://*",
    "https://*.com", // a wildcard over a bare TLD
    "https://itch.io/", // a path is not an origin
    "https://itch.io/games",
    "https://itch.io?x=1",
    "https://itch.io#top",
    "https://user:pw@itch.io",
    "https://itch.io:8443", // a port
    "http://itch.io", // not https
    "itch.io", // no scheme
    "https://foo.*.com", // wildcard not leftmost
    "https://*.*.com",
    "https://192.168.0.1",
    "javascript:alert(1)",
    "",
    null,
  ]) {
    assert.equal(normalizePortalFrameOrigin(bad), null, String(bad));
  }
});

test("parsing dedupes, and an empty allowlist stays unframable", () => {
  const parsed = parsePortalFrameOrigins(
    "https://itch.io, https://*.crazygames.com,https://itch.io,not-an-origin,",
  );
  assert.deepEqual(parsed, ["https://itch.io", "https://*.crazygames.com"]);

  assert.deepEqual(parsePortalFrameOrigins(""), []);
  assert.deepEqual(parsePortalFrameOrigins(null), []);
  assert.equal(buildPortalFrameAncestors([]), "'self'");
  assert.equal(
    buildPortalFrameAncestors(["https://itch.io", "https://*.crazygames.com"]),
    "https://itch.io https://*.crazygames.com",
  );
});

test("the policy relaxes /play and only /play", () => {
  const env = { GRYND_PORTAL_FRAME_ORIGINS: "https://itch.io,https://*.crazygames.com" };
  const csp =
    "default-src 'self'; frame-ancestors 'self'; base-uri 'self'";

  const portal = fakeResponse({
    "X-Frame-Options": "SAMEORIGIN",
    "Content-Security-Policy": csp,
  });
  applyPortalFramePolicy(portal, "/play/dominoes", env);
  assert.equal(portal.has("X-Frame-Options"), false, "SAMEORIGIN must be gone");
  assert.match(portal.header("Content-Security-Policy"), /frame-ancestors https:\/\/itch\.io https:\/\/\*\.crazygames\.com;/);
  assert.match(portal.header("Content-Security-Policy"), /default-src 'self'/);
  assert.equal(portal.header("X-Grynd-Portal-Frame"), "allowed");

  // A normal game page keeps the strict policy.
  const site = fakeResponse({ "X-Frame-Options": "SAMEORIGIN", "Content-Security-Policy": csp });
  applyPortalFramePolicy(site, "/casino/dominoes", env);
  assert.equal(site.header("X-Frame-Options"), "SAMEORIGIN");
  assert.match(site.header("Content-Security-Policy"), /frame-ancestors 'self'/);

  // No allowlist configured: /play stays unframable.
  const unconfigured = fakeResponse({
    "X-Frame-Options": "SAMEORIGIN",
    "Content-Security-Policy": csp,
  });
  applyPortalFramePolicy(unconfigured, "/play/dominoes", {});
  assert.equal(unconfigured.header("X-Frame-Options"), "SAMEORIGIN");
  assert.match(unconfigured.header("Content-Security-Policy"), /frame-ancestors 'self'/);
  assert.equal(unconfigured.header("X-Grynd-Portal-Frame"), null);

  // An all-invalid allowlist is the same as none.
  const invalid = fakeResponse({ "X-Frame-Options": "SAMEORIGIN" });
  applyPortalFramePolicy(invalid, "/play/odds", { GRYND_PORTAL_FRAME_ORIGINS: "*,http://x" });
  assert.equal(invalid.header("X-Frame-Options"), "SAMEORIGIN");
});

// ── 3. The CrazyGames bridge ──────────────────────────────────────────────

test("a CrazyGames visit is detected from the URL or the parent origin", () => {
  assert.equal(isCrazyGamesContext({ portal: "crazygames" }), true);
  assert.equal(isCrazyGamesContext({ portal: "CRAZYGAMES" }), true);
  assert.equal(isCrazyGamesContext({ referrer: "https://www.crazygames.com/game/x" }), true);
  assert.equal(isCrazyGamesContext({ referrer: "https://crazygames.com/game/x" }), true);
  assert.equal(isCrazyGamesContext({ referrer: "https://evil-crazygames.com/game" }), false);
  assert.equal(isCrazyGamesContext({ referrer: "https://itch.io/game" }), false);
  assert.equal(isCrazyGamesContext({ referrer: "not a url" }), false);
  assert.equal(isCrazyGamesContext({}), false);
});

test("with no SDK every call is a quiet no-op", async () => {
  const bridge = createCrazyGamesBridge(undefined);
  assert.equal(await bridge.init(), false);
  assert.doesNotThrow(() => bridge.gameplayStart());
  assert.doesNotThrow(() => bridge.gameplayStop());
  assert.equal(await bridge.requestAd("midgame"), false);
  assert.deepEqual(bridge.state(), {
    initialised: false,
    playing: false,
    inAd: false,
    lastAdAt: null,
    adsRequested: 0,
  });
});

test("start and stop are paired and idempotent", async () => {
  const calls = [];
  const sdk = {
    init: () => {
      calls.push("init");
    },
    gameplayStart: () => calls.push("start"),
    gameplayStop: () => calls.push("stop"),
  };
  const bridge = createCrazyGamesBridge(sdk);

  assert.equal(await bridge.init(), true);
  assert.equal(await bridge.init(), true); // init is once
  assert.deepEqual(calls, ["init"]);

  bridge.gameplayStart();
  bridge.gameplayStart(); // never twice
  bridge.gameplayStop();
  bridge.gameplayStop(); // never twice
  assert.deepEqual(calls, ["init", "start", "stop"]);
  assert.equal(bridge.state().playing, false);
});

test("an ad is refused during play, back-to-back, and for an unknown kind", async () => {
  const ads = [];
  let clock = 1_000_000;
  const sdk = {
    init: () => {},
    gameplayStart: () => {},
    gameplayStop: () => {},
    ad: { requestAd: (kind) => ads.push(kind) },
  };
  const bridge = createCrazyGamesBridge(sdk, () => clock);
  await bridge.init();

  // Playing: never.
  bridge.gameplayStart();
  assert.equal(await bridge.requestAd("midgame"), false);
  assert.deepEqual(ads, []);

  // Stopped: allowed once.
  bridge.gameplayStop();
  assert.equal(await bridge.requestAd("midgame"), true);
  assert.deepEqual(ads, ["midgame"]);

  // Immediately after: cooldown.
  assert.equal(await bridge.requestAd("midgame"), false);
  clock += AD_COOLDOWN_MS - 1;
  assert.equal(await bridge.requestAd("midgame"), false);
  clock += 2;
  assert.equal(await bridge.requestAd("rewarded"), true);
  assert.deepEqual(ads, ["midgame", "rewarded"]);

  // Only the documented kinds.
  clock += AD_COOLDOWN_MS + 1;
  assert.equal(await bridge.requestAd("banner"), false);

  assert.equal(bridge.state().adsRequested, 2);
});

test("a broken SDK never breaks the game", async () => {
  const sdk = {
    init: () => {
      throw new Error("boom");
    },
    gameplayStart: () => {
      throw new Error("boom");
    },
    gameplayStop: () => {
      throw new Error("boom");
    },
    ad: {
      requestAd: () => {
        throw new Error("boom");
      },
    },
  };
  const bridge = createCrazyGamesBridge(sdk);
  assert.equal(await bridge.init(), false);
  assert.doesNotThrow(() => bridge.gameplayStart());
  assert.doesNotThrow(() => bridge.gameplayStop());
  assert.equal(await bridge.requestAd("midgame"), false);
});

test("an SDK that is present but incomplete is tolerated", async () => {
  // No init: cannot be initialised, and nothing else throws.
  const bridge = createCrazyGamesBridge({ gameplayStart: () => {} });
  assert.equal(await bridge.init(), false);
  assert.doesNotThrow(() => bridge.gameplayStart());
  assert.equal(await bridge.requestAd("midgame"), false);
});

// ── 4. The wiring ─────────────────────────────────────────────────────────

test("the play route is closed to non-exportable keys and never indexed", () => {
  const page = read("src/app/play/[gameKey]/page.tsx");
  assert.match(page, /getPortalExportGame\(gameKey\)/);
  assert.match(page, /if \(!game\) notFound\(\);/);
  assert.match(page, /robots: \{ index: false, follow: false, nocache: true \}/);
  assert.match(page, /<PortalSdkBridge portal=\{portal\} \/>/);
  // No account prompt and no link out of the portal frame.
  assert.doesNotMatch(page, /GuestPostMatchCta|sign-in|sign-up/);
});

test("play maps exactly the exportable games to their real screens", () => {
  const source = read("src/app/play/[gameKey]/PlayGame.tsx");
  // Every screen is the app's own page component, not a copy.
  const imported = [
    ...source.matchAll(
      /import [A-Za-z][A-Za-z0-9]* from "\.\.\/\.\.\/casino\/([a-z0-9-]+)\/PageClient";/g,
    ),
  ].map((match) => match[1]);
  assert.deepEqual(
    imported.sort(),
    PORTAL_EXPORT_GAMES.map((game) => game.gameKey).sort(),
    "the imported screens must match the catalog exactly",
  );

  // ...and every one of them is reachable through the map.
  for (const gameKey of imported) {
    assert.match(source, new RegExp(`"?${gameKey}"?: [A-Za-z]`), `${gameKey} must be in the map`);
  }
});

test("the chrome gate drops every site surface on the portal path", () => {
  const chrome = read("src/components/SiteChrome.tsx");
  assert.match(chrome, /import \{ isPortalPlayPath \} from "\.\.\/lib\/portal\/framing";/);
  assert.match(chrome, /if \(isPortalPlayPath\(pathname\)\)/);
  // The portal branch is a bare <main>: no padding for a navbar that is absent.
  assert.match(chrome, /<main id="main-content" className="min-h-dvh bg-\[#000d1a\]">/);

  // Everything that is the site, and nothing else, is gated behind it.
  assert.match(chrome, /<SplashScreen \/>/);
  assert.match(chrome, /<GlitchProvider \/>/);
  assert.match(chrome, /<ClerkSafeChatWidget \/>/);
  assert.match(chrome, /<CookieConsentBanner suppressForCmp=\{requiresCmp\} \/>/);
  assert.match(chrome, /<GoogleAnalytics \/>/);

  // The root layout no longer mounts them itself (one gate, not two).
  const layout = read("src/app/layout.tsx");
  assert.match(layout, /<SiteChrome requiresCmp=\{requiresCmp\}>\{children\}<\/SiteChrome>/);
  for (const gone of ["<ChatWidget", "<GlitchProvider />", "<SplashScreen />", "<GoogleAnalytics />"]) {
    assert.equal(layout.includes(gone), false, `${gone} must only be mounted by SiteChrome`);
  }
});

test("the navbar gates itself on the portal path", () => {
  const nav = read("src/components/navigation-bar.jsx");
  assert.match(nav, /isPortalPlayPath/);
  assert.match(nav, /usePathname/);
});

test("the proxy makes /play public and applies the portal policy", () => {
  const proxy = read("src/proxy.ts");
  assert.match(proxy, /"\/play\(\.\*\)",/);
  assert.match(proxy, /import \{ applyPortalFramePolicy \} from "\.\/lib\/portal\/framing";/);
  // Applied on the normal path AND on the no-Clerk fallback, so the surface
  // behaves the same in local dev as in production.
  const applications = proxy.match(/applyPortalFramePolicy\(/g) ?? [];
  assert.ok(applications.length >= 2, `expected both branches, got ${applications.length}`);
  assert.match(proxy, /GRYND_PORTAL_FRAME_ORIGINS/);
});

test("both end-of-match surfaces announce that play stopped", () => {
  const screen = read("src/components/result/PvpResultScreen.jsx");
  assert.match(screen, /import \{ PORTAL_MATCH_FINISHED_EVENT \} from "\.\.\/\.\.\/lib\/portal\/crazygames";/);
  assert.match(screen, /window\.dispatchEvent\(\s*new CustomEvent\(PORTAL_MATCH_FINISHED_EVENT/);

  const battle = read("src/components/games/battleship/BattlePreview.tsx");
  assert.match(battle, /import \{ PORTAL_MATCH_FINISHED_EVENT \} from "\.\.\/\.\.\/\.\.\/lib\/portal\/crazygames";/);
  assert.match(battle, /new CustomEvent\(PORTAL_MATCH_FINISHED_EVENT, \{ detail: \{ gameKey: "battleship" \} \}\)/);

  // Same event name on both sides.
  assert.match(
    read("src/lib/portal/crazygames.ts"),
    new RegExp(`PORTAL_MATCH_FINISHED_EVENT = "${PORTAL_MATCH_FINISHED_EVENT}"`),
  );
});

test("the bridge loads the SDK only on a portal visit, and never blocks play", () => {
  const bridge = read("src/components/portal/PortalSdkBridge.tsx");
  assert.match(bridge, /if \(!isCrazyGamesContext\(\{ portal, referrer: document\.referrer \}\)\) return;/);
  assert.match(bridge, /sdk\.crazygames\.com\/crazygames-sdk-v3\.js/);
  assert.match(bridge, /bridge\.gameplayStop\(\);/);
  // No postMessage call to any parent, and no wildcard target origin.
  assert.doesNotMatch(bridge, /\.postMessage\(/);
  assert.doesNotMatch(bridge, /"\*"/);
});

// ── 4a. The board stays on the framable path ─────────────────────────────

test("the framing rule accepts the portal board, and only its two shapes", () => {
  assert.equal(isPortalPlayPath("/play/dominoes/abc-123"), true);
  assert.equal(isPortalPlayPath("/play/odds/ai"), true);
  assert.equal(isPortalPlayPath("/play/tic-tac-toe/9f2c"), true);

  for (const bad of [
    "/play/tic-tac-toe/../x",
    "/play/tic-tac-toe/.",
    "/play/tic-tac-toe/a/b",
    "/play/chess/abc",
    "/play/dominoes/" + "a".repeat(65),
  ]) {
    assert.equal(isPortalPlayPath(bad), false, bad);
  }
});

test("navigation rewrites this game's lobby and board, and nothing else", () => {
  assert.equal(portalAwareHref("/casino/dominoes", "/play/dominoes"), "/play/dominoes");
  assert.equal(
    portalAwareHref("/casino/dominoes/abc?x=1", "/play/dominoes"),
    "/play/dominoes/abc?x=1",
  );
  assert.equal(portalAwareHref("/games/dominoes", "/play/dominoes/abc"), "/play/dominoes");
  // Odds' board is one segment deeper than every other game's.
  assert.equal(portalAwareHref("/casino/odds/game/ai", "/play/odds"), "/play/odds/ai");
  assert.equal(portalAwareHref("/casino/odds/game/42", "/play/odds/123"), "/play/odds/42");

  // Another game, a site page, an external URL and a normal app path are all
  // left alone.
  assert.equal(
    portalAwareHref("/casino/odds/game/42", "/play/dominoes"),
    "/casino/odds/game/42",
  );
  assert.equal(portalAwareHref("/rewards", "/play/dominoes"), "/rewards");
  assert.equal(portalAwareHref("https://example.com", "/play/odds"), "https://example.com");
  assert.equal(portalAwareHref("/casino/dominoes", "/casino/dominoes"), "/casino/dominoes");
  assert.equal(portalAwareHref("/casino/dominoes", "/play/chess"), "/casino/dominoes");
});

test("every match screen navigates through the portal-aware router", () => {
  const hook = read("src/hooks/useMatchRouter.ts");
  assert.match(hook, /import \{ portalAwareHref \} from "\.\.\/lib\/portal\/routes";/);
  assert.match(hook, /const target = portalAwareHref\(href, pathname\);/);

  for (const file of [
    "src/app/casino/tic-tac-toe/[matchId]/PageClient.tsx",
    "src/app/casino/dominoes/[matchId]/PageClient.tsx",
    "src/app/casino/odds/game/[matchId]/PageClient.tsx",
    "src/app/casino/solitaire-duel/[matchId]/PageClient.tsx",
  ]) {
    const source = read(file);
    assert.match(source, /useMatchRouter/, `${file} must use the portal-aware router`);
  }
});

test("the board route mirrors every game that has one", () => {
  const page = read("src/app/play/[gameKey]/[matchId]/page.tsx");
  assert.match(page, /hasPortalMatchRoute\(game\.gameKey\)/);
  assert.match(page, /portalPlayRoute\(`\/play\/\$\{gameKey\}\/\$\{matchId\}`\)/);
  assert.match(page, /<PlayMatch gameKey=\{game\.gameKey\} \/>/);
  // The board is where a portal visitor finishes, so the home button is here too.
  assert.match(page, /<PortalHomeButton portal=\{portal\} \/>/);

  const map = read("src/app/play/[gameKey]/[matchId]/PlayMatch.tsx");
  for (const gameKey of ["tic-tac-toe", "dominoes", "odds", "solitaire-duel"]) {
    assert.match(map, new RegExp(`"?${gameKey}"?: [A-Za-z]`), `${gameKey} board must be mapped`);
  }
  // Battleship plays inside its lobby page: no board route, no mapping (the
  // file says so in prose, so this checks the MAP, not the comment).
  assert.doesNotMatch(map, /"?battleship"?: [A-Za-z]/);
  // No GRYND advertising inside a portal frame.
  assert.match(map, /postMatchAdsEnabled=\{false\}/);
});

test("a portal result screen shows no account CTA and no GRYND ad", () => {
  const screen = read("src/components/result/PvpResultScreen.jsx");
  assert.match(screen, /import \{ isPortalPlayPath \} from "\.\.\/\.\.\/lib\/portal\/framing";/);
  assert.match(screen, /const portalSurface = isPortalPlayPath\(usePathname\(\)\);/);
  assert.match(screen, /\{!compact && !portalSurface && guestGameKey \? \(/);
  assert.match(screen, /\{!compact && !portalSurface && adOpen && !postMatchAd && \(/);
  assert.match(screen, /if \(portalSurface\) \{\s*setNavigating\(true\);/);
});

// ── 5a. The practice-only lobby ──────────────────────────────────────────

test("the shared lobby hides every online surface in practice-only mode", () => {
  const lobby = read("src/components/lobby/PvpLobby.jsx");

  assert.match(lobby, /import \{ isPortalPlayPath \} from "\.\.\/\.\.\/lib\/portal\/framing";/);
  assert.match(lobby, /practiceOnly = undefined,/);
  assert.match(
    lobby,
    /practiceOnly === undefined \? isPortalPlayPath\(pathname\) : Boolean\(practiceOnly\)/,
  );

  // Online matchmaking is gone: the Play button, the stake picker and the
  // open-lobby board are all conditional on NOT being in practice mode.
  assert.match(lobby, /\{!practiceMode && \(\s*<button[\s\S]{0,700}?onClick=\{handlePlay\}/);
  assert.match(lobby, /\{\/\* The stake picker is an online-money control[\s\S]{0,400}?\{wager && !practiceMode && \(/);
  assert.match(lobby, /\{!practiceMode && \(\s*<section className="mt-12 lg:mt-16">/);
  assert.match(lobby, /\{quickQueue && !practiceMode && \(/);
  // No outbound link into the site from a portal frame.
  assert.match(lobby, /\{!practiceMode && \(\s*<Link\s+href="\/games"/);
  // The page chrome goes too: the footer links across the whole site.
  assert.match(lobby, /\{!practiceMode && <Footer \/>\}/);

  // The panel describes practice, not a staked duel.
  assert.match(lobby, /\["Opponent", "The bot"\]/);
  assert.match(lobby, /Practice · unrated/);
});

test("every exportable game keeps a practice action in the lobby", () => {
  for (const [gameKey, file] of Object.entries({
    "tic-tac-toe": "src/app/casino/tic-tac-toe/PageClient.tsx",
    dominoes: "src/app/casino/dominoes/PageClient.tsx",
    battleship: "src/app/casino/battleship/PageClient.tsx",
    odds: "src/app/casino/odds/PageClient.tsx",
    "solitaire-duel": "src/app/casino/solitaire-duel/PageClient.tsx",
  })) {
    const source = read(file);
    assert.ok(
      /vsAi=\{\{/.test(source) || /extraActions=\{/.test(source),
      `${gameKey} would have no way to start a match once online play is hidden`,
    );
  }
});

test("the iframe harness frames the Poki surface with no configuration", () => {
  const html = read("public/portal-frame-harness.html");

  assert.match(html, /<iframe[\s\S]{0,300}?id="frame"/);
  // Defaults: dominoes, on poki, from the app's own origin.
  assert.match(html, /params\.get\("game"\) \|\| "dominoes"/);
  assert.match(html, /params\.get\("portal"\) \|\| "poki"/);
  assert.match(html, /params\.get\("origin"\) \|\| location\.origin/);
  assert.match(
    html,
    /"\/play\/" \+ encodeURIComponent\(game\) \+ "\?portal=" \+ encodeURIComponent\(portal\)/,
  );
  // Same-origin framing is allowed with no env var; the page pulls no script
  // and hard-codes no frame URL.
  assert.doesNotMatch(html, /<iframe[^>]+src=/);
  assert.doesNotMatch(html, /<script[^>]+src=/);
});

// ── 5. The post-match home button ─────────────────────────────────────────

test("the home button points at grynd.dedyn.io, for Poki only", () => {
  assert.equal(PORTAL_HOME_ORIGIN, "https://grynd.dedyn.io");
  assert.equal(offersPortalHome("poki"), true);
  assert.equal(offersPortalHome("POKI"), true);

  for (const other of ["itch", "crazygames", "y8", "", null, undefined]) {
    assert.equal(offersPortalHome(other), false, String(other));
    assert.equal(portalHomeHref(other), null, String(other));
  }

  const href = new URL(portalHomeHref("poki"));
  assert.equal(href.origin, "https://grynd.dedyn.io");
  assert.equal(href.pathname, "/");
  assert.equal(href.searchParams.get("utm_source"), "poki");
  assert.equal(href.searchParams.get("utm_medium"), "portal");
  // Campaign labels only: no guest id, match id, token or session in the URL.
  assert.deepEqual([...href.searchParams.keys()].sort(), ["utm_medium", "utm_source"]);
});

test("the home button waits for a finished match and only opens the site", () => {
  const button = read("src/components/portal/PortalHomeButton.tsx");

  // Only after the match-finished beat both end cards already announce.
  assert.match(button, /PORTAL_MATCH_FINISHED_EVENT/);
  assert.match(button, /if \(!offered \|\| !href \|\| !finished \|\| dismissed\) return null;/);

  // A plain link: new tab, no opener, no referrer.
  assert.match(button, /target="_blank"/);
  assert.match(button, /rel="noopener noreferrer"/);
  // Never navigate the portal's own page (the header comment explains why;
  // this pins the absence of such a CALL), and no second copy of the URL.
  assert.doesNotMatch(
    button,
    /window\.top\.location\s*=|window\.location\.(?:href\s*=|assign\(|replace\()|location\.href\s*=/,
  );
  assert.doesNotMatch(button, /grynd\.dedyn\.io/);

  // Mounted by the portal page, for whatever portal the URL names.
  const page = read("src/app/play/[gameKey]/page.tsx");
  assert.match(page, /<PortalHomeButton portal=\{portal\} \/>/);

  // Copy exists in every locale the app ships.
  const translations = read("src/lib/appTextTranslations.js");
  const blocks = translations.match(/portal: \{\s*home: \{/g) ?? [];
  assert.ok(blocks.length >= 3, `expected en/fr/es copy, found ${blocks.length}`);
  for (const cta of ["Play on GRYND", "Jouer sur GRYND", "Jugar en GRYND"]) {
    assert.ok(translations.includes(cta), `missing copy: ${cta}`);
  }
});
