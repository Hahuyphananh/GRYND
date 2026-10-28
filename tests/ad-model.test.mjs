/**
 * GRYND advertising model — contract guard.
 *
 * The model is: FREE accounts may see ads on browsing pages; GRYND PRO accounts
 * see none, anywhere, ever. Two properties make that true and both are easy to
 * break silently, so they are pinned here:
 *
 *   1. ENTITLEMENT IS SERVER-SIDE. `AdSlot` takes no `premium`/`isPro` prop, is
 *      a server component, and asks lib/adEntitlement.ts (Clerk + the caller's
 *      own subscription row). A client boolean can never unlock or hide ads.
 *
 *   2. ADS NEVER REACH GAMEPLAY. No slot — and no ad loader — may exist on a
 *      match/board route, and the placement registry only names non-game
 *      surfaces.
 *
 * Provider-neutrality is pinned too: every identifier (publisher id, each
 * placement's unit id) comes from the environment, no id is ever invented, and
 * pages reference placements by NAME so the provider can be swapped without
 * touching a single page.
 *
 * Run: node --import tsx --test tests/ad-model.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join, relative, sep } from "node:path";

import {
  isMatchHref,
  resolveMatchNavigation,
} from "../src/lib/matchNavigation.ts";
import {
  AD_PLACEMENT_ENV,
  DEFAULT_ADSENSE_PUBLISHER_ID,
  adUnitId,
  adsensePublisherId,
  adsEnabled,
  hasAnyConfiguredAdUnit,
  normalizePublisherId,
} from "../src/lib/ads.ts";

const read = (path) => fs.readFileSync(path, "utf8");
const exists = (path) => fs.existsSync(path);

/** Assertions test CODE, not the prose that explains it. */
const code = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const CONFIG = read("src/lib/ads.ts");
const ENTITLEMENT = read("src/lib/adEntitlement.ts");
const SLOT = read("src/components/AdSlot.tsx");
const UNIT = read("src/components/AdUnit.tsx");
const LOADER = read("src/components/AdSenseScript.tsx");
const PROXY = read("src/proxy.ts");
const MARKER = read("src/components/AdCodeMarker.tsx");
const MATCH_ROUTER = read("src/hooks/useMatchRouter.ts");

/** Every page file under src/app, repo-relative POSIX. */
function allPages(dir = "src/app") {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...allPages(full));
    else if (/^page\.(jsx?|tsx?)$/.test(entry.name))
      found.push(relative(process.cwd(), full).split(sep).join("/"));
  }
  return found.sort();
}

test("the publisher id is environment-driven with a real, authorised fallback", () => {
  // The fallback is the publisher this property is already listed under in
  // public/ads.txt — not an invented placeholder.
  assert.equal(DEFAULT_ADSENSE_PUBLISHER_ID, "ca-pub-4903728316211815");
  assert.equal(normalizePublisherId(DEFAULT_ADSENSE_PUBLISHER_ID), DEFAULT_ADSENSE_PUBLISHER_ID);
  assert.match(CONFIG, /NEXT_PUBLIC_ADSENSE_CLIENT/, "the publisher id must be env-overridable");

  // Malformed / placeholder values are rejected rather than rendered.
  assert.equal(normalizePublisherId("ca-pub-0000000000000000"), null);
  assert.equal(normalizePublisherId("ca-pub-123"), null);
  assert.equal(normalizePublisherId("pub-4903728316211815"), null);
  assert.equal(normalizePublisherId(""), null);
  assert.equal(normalizePublisherId(undefined), null);

  // With no env var set, the authorised publisher is what gets served.
  assert.equal(adsensePublisherId(), DEFAULT_ADSENSE_PUBLISHER_ID);
});

test("no ad-unit id is ever invented — every placement reads its env var", () => {
  for (const [placement, envVar] of Object.entries(AD_PLACEMENT_ENV)) {
    assert.match(envVar, /^NEXT_PUBLIC_ADSENSE_SLOT_[A-Z]+$/, `${placement} env var name`);
    assert.ok(CONFIG.includes(envVar), `${placement} must read ${envVar}`);
  }
  // With no unit ids configured (this checkout has none) NOTHING is renderable.
  for (const placement of Object.keys(AD_PLACEMENT_ENV)) {
    assert.equal(adUnitId(placement), null, `${placement} must resolve to null when unconfigured`);
  }
  assert.equal(hasAnyConfiguredAdUnit(), false);
  // No literal slot id anywhere in the ad code.
  assert.ok(
    !/data-ad-slot="\d/.test(CONFIG + SLOT + UNIT + LOADER),
    "a numeric ad-unit id must never be hardcoded",
  );
});

test("ads are switched by configuration, and off means nothing renders", () => {
  // This checkout has no NEXT_PUBLIC_ADSENSE_ENABLED=false, so ads are on by
  // default; the switch must exist and be read from the environment.
  assert.equal(typeof adsEnabled(), "boolean");
  assert.equal(adsEnabled(), true);
  assert.match(SLOT, /if \(!adsEnabled\(\)\) return null;/);
  assert.match(LOADER, /if \(!adsEnabled\(\)\) return null;/);
});

test("AdSlot cannot be told who the viewer is", () => {
  // The whole client-trust bug class: a `premium` prop (the old AdSlot took
  // one). It must not come back.
  assert.ok(
    !/premium/i.test(code(SLOT)),
    "AdSlot must not accept a premium/entitlement prop",
  );
  assert.ok(!/"use client"/.test(SLOT), "AdSlot must stay a server component");
  assert.match(SLOT, /await isAdFreeViewer\(\)/, "AdSlot must gate on the server check");
  assert.ok(
    /placement: AdPlacement/.test(SLOT),
    "AdSlot's only input is the placement name",
  );
  // No client storage / URL / cookie can influence the decision.
  for (const [name, source] of Object.entries({ SLOT, UNIT, LOADER })) {
    assert.ok(
      !/(localStorage|sessionStorage|document\.cookie)/.test(source),
      `${name} must not read entitlement from the client`,
    );
  }
});

test("the entitlement helper is server-authoritative and memoized per request", () => {
  assert.match(ENTITLEMENT, /import \{ cache \} from "react"/, "one lookup per render, not one per slot");
  assert.match(ENTITLEMENT, /auth\(\)/);
  assert.match(ENTITLEMENT, /getMembershipTier\(userId\)/);
  assert.ok(
    !/"use client"/.test(ENTITLEMENT),
    "entitlement must never be evaluated in the browser",
  );
  // Fails open only in the documented direction (ads may show), so the ad-free
  // entitlement can't leak to signed-out visitors during an outage.
  assert.match(ENTITLEMENT, /return false;/);
});

test("only non-game surfaces are registered placements", () => {
  assert.deepEqual(Object.keys(AD_PLACEMENT_ENV).sort(), [
    "home",
    "hub",
    "leaderboard",
    "profile",
  ]);
});

test("every ad slot or loader sits on a non-game browsing page", () => {
  const pagesWithSlots = allPages().filter((p) => /<AdSlot\s/.test(read(p)));
  assert.deepEqual(pagesWithSlots, [
    "src/app/casino/page.jsx",
    "src/app/classement/page.jsx",
    "src/app/page.jsx",
    "src/app/profil/page.jsx",
  ]);
});

test("no ad capability exists inside gameplay", () => {
  /** A gameplay page may carry NO ad surface at all — not a slot, not either
   * provider's loader (the rule is about gameplay, not about one vendor). */
  const assertAdFree = (page, why) => {
    const source = read(page);
    assert.ok(!/<AdSlot\s/.test(source), `${page} ${why} — no ad slot`);
    assert.ok(!/AdSenseScript/.test(source), `${page} ${why} — no ad loader`);
  };

  // 1. Any per-entity route (`[matchId]`, `game/[gameId]`, `table/[tableId]`,
  //    `[tableAmount]` …) is a match or a match sub-page.
  for (const page of allPages()) {
    if (!/\[[^\]]+\]/.test(page)) continue;
    assertAdFree(page, "is a match route");
  }

  // 2. Structurally, every /casino page BELOW a game's lobby is gameplay too.
  //    The lobby is exactly /casino/<slug>; `/casino/<slug>/ai`,
  //    `/casino/<slug>/play-ai`, `/casino/<slug>/test` and
  //    `/casino/<slug>/<tableAmount>` are STATIC routes, so the dynamic-segment
  //    rule above cannot see them. Classifying by route depth instead of by a
  //    hand-kept list means a new game (or a new practice/AI route for an
  //    existing one) is covered the moment it is added — the matchmaking board
  //    must never sit on the same page as an ad tag.
  const deeperGamePages = allPages().filter((page) => {
    const route = page
      .replace(/^src\/app\//, "")
      .replace(/\/page\.(jsx?|tsx?)$/, "");
    if (!route.startsWith("casino/")) return false;
    // "casino" (the hub) and "casino/<slug>" (a lobby) are browsing surfaces;
    // anything deeper belongs to the game itself.
    return route.split("/").length > 2;
  });
  assert.ok(
    deeperGamePages.length >= 15,
    `expected the gameplay route tree (found ${deeperGamePages.length}) — a route walk that finds nothing proves nothing`,
  );
  for (const page of deeperGamePages) {
    assertAdFree(page, "is a gameplay route (below the lobby)");
  }

  // 3. Games whose lobby and board share the lobby URL are one page, not two:
  //    there is no ad-free place to put a tag, so they carry none at all.
  for (const page of allPages()) {
    if (!/dice-flush|odds|keno|neon-flush/.test(page)) continue;
    assertAdFree(page, "plays on its lobby URL");
  }
});

test("the slot is placed above the footer, never over controls", () => {
  // Each page hands its slot to the page client as an `adSlot` prop, and each
  // client renders it immediately before the footer — after every interactive
  // element, which is what keeps ads away from accidental clicks.
  for (const [page, client] of [
    ["src/app/page.jsx", "src/app/PageClient.jsx"],
    ["src/app/casino/page.jsx", "src/app/casino/PageClient.jsx"],
    ["src/app/classement/page.jsx", "src/app/classement/PageClient.jsx"],
    ["src/app/profil/page.jsx", "src/app/profil/PageClient.jsx"],
  ]) {
    assert.match(read(page), /adSlot=\{<AdSlot placement="[a-z]+" \/>\}/, `${page} must pass a slot`);
    const source = read(client);
    assert.match(source, /adSlot = null/, `${client} must accept the slot prop`);
    const index = source.indexOf("{adSlot}");
    const footer = source.indexOf("<Footer />");
    assert.ok(index > -1, `${client} must render {adSlot}`);
    assert.ok(
      footer > -1 && Math.abs(footer - index) < 120,
      `${client} must render {adSlot} immediately before the footer`,
    );
  }
});

test("AdUnit is the only client-side ad code and reserves its space", () => {
  assert.match(UNIT, /"use client"/);
  assert.match(UNIT, /adsbygoogle/, "the unit must use Google's push contract");
  assert.match(UNIT, /minHeight/, "a reserved height prevents layout shift and stray clicks");
  assert.match(UNIT, /data-ad-slot=\{slotId\}/, "the unit id comes from the slot, not a literal");
  assert.match(SLOT, /aria-label="Advertisement"/, "the block must be announced as an ad");
  // The push must be guarded so React's double-effect doesn't double-push.
  assert.match(UNIT, /useRef\(false\)/);
});

test("the ad provider is swappable without touching a page", () => {
  // Pages only ever name a placement; the provider lives in AdSlot/AdUnit and
  // the identifiers live in lib/ads.ts.
  for (const page of allPages().filter((p) => /<AdSlot\s/.test(read(p)))) {
    assert.ok(
      !/adsbygoogle|googlesyndication|data-ad-slot/.test(read(page)),
      `${page} must not know the ad provider`,
    );
  }
  assert.ok(exists("src/lib/ads.ts"), "the provider config module must exist");
});

test("public/ads.txt still authorises the configured publisher", () => {
  const adsTxt = read("public/ads.txt");
  const publisher = DEFAULT_ADSENSE_PUBLISHER_ID.replace(/^ca-/, "");
  assert.ok(
    adsTxt.includes(`google.com, ${publisher}, DIRECT, f08c47fec0942fa0`),
    "ads.txt must list the configured publisher as a DIRECT seller",
  );
});
// ── Ad code must not survive into gameplay ──────────────────────────────────
// The loader's behaviour is DOCUMENT-global (the AdSense loader is what Auto
// Ads hook into), and a Next client-side navigation never
// unloads the document. A match page's own HTML is ad-free — these tests make
// sure nothing a LOBBY loaded follows the player onto the board.

test("only a match URL is classified as gameplay", () => {
  const browsing = [
    "",
    "/",
    "/games",
    "/casino",
    "/profil",
    "/classement",
    "/games/chess",
    "/games/chess/play",
    "/games/chess/play?auto=1",
    "/casino/chess",
    "/casino/chess/",
  ];
  for (const href of browsing) {
    assert.equal(isMatchHref(href), false, `${href} is a browsing/lobby URL`);
  }

  const gameplay = [
    "/casino/chess/ai",
    "/casino/chess/ai?gameId=1&difficulty=2",
    "/casino/chess/100",
    "/casino/four-in-a-row/game/abc",
    "/casino/four-in-a-row/play-ai",
    "/casino/precision/test",
    "/casino/hex-duel/history",
    "/casino/keno-pvp/abc",
    "/games/chess/ai",
    "/games/chess/play-ai",
    "/games/four-in-a-row/game/abc",
  ];
  for (const href of gameplay) {
    assert.equal(isMatchHref(href), true, `${href} is gameplay`);
  }
});

test("a match is a document navigation only while the document has ad code", () => {
  assert.equal(resolveMatchNavigation("/casino/chess/ai", true), "document");
  assert.equal(resolveMatchNavigation("/casino/chess/ai", false), "client");
  // Ad code in the document must never turn a lobby into a full reload.
  assert.equal(resolveMatchNavigation("/casino/chess", true), "client");
  assert.equal(resolveMatchNavigation("/games/chess/play", true), "client");
});

test("the ad loader flags the document, so the flag cannot drift from the tag", () => {
  assert.match(
    LOADER,
    /import AdCodeMarker from "\.\/AdCodeMarker";/,
    "AdSenseScript must render the marker — a tag without the flag would ride into a match",
  );
  assert.match(LOADER, /<AdCodeMarker \/>/, "AdSenseScript must actually render it");
  assert.match(MARKER, /"use client"/);
  assert.match(MARKER, /markAdCodeLoaded\(\)/);
});

test("every lobby enters a match through the ad-aware router", () => {
  // Every game's lobby client (a PageClient directly under src/app/casino/
  // <game>) — found from the tree, so a new game is covered automatically.
  const lobbyClients = fs
    .readdirSync("src/app/casino", { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) =>
      ["PageClient.tsx", "PageClient.jsx"].map((name) =>
        join("src/app/casino", entry.name, name).split(sep).join("/"),
      ),
    )
    .filter(exists)
    .sort();
  assert.ok(lobbyClients.length >= 20, `expected every casino lobby client (found ${lobbyClients.length})`);

  for (const file of lobbyClients) {
    const source = read(file);
    assert.ok(
      !/import \{[^}]*\buseRouter\b[^}]*\} from "next\/navigation"/.test(source),
      `${file} must use useMatchRouter — next/navigation's router would keep the lobby's ad code alive over the board`,
    );
    if (/router\.(push|replace)\(/.test(source)) {
      assert.match(
        source,
        /import \{ useMatchRouter \} from "\.\.\/\.\.\/\.\.\/hooks\/useMatchRouter";/,
        `${file} navigates, so it must import the match router`,
      );
      assert.match(source, /const router = useMatchRouter\(\);/);
    }
  }

  // The shared lobby chrome's Quick Queue can land a player straight in a
  // match from the lobby it is mounted on.
  const quickQueue = read("src/components/lobby/PlatformQuickQueue.jsx");
  assert.match(
    quickQueue,
    /import \{ useMatchRouter \} from "\.\.\/\.\.\/hooks\/useMatchRouter";/,
  );
  assert.match(quickQueue, /const router = useMatchRouter\(\);/);
  assert.match(quickQueue, /router\.push\(route\)/);
});

test("the match router leaves the document only for a match", () => {
  const source = code(MATCH_ROUTER);
  assert.match(source, /resolveMatchNavigation\(href, hasAdCodeLoaded\(\)\)/);
  assert.match(source, /window\.location\.assign\(href\)/);
  assert.match(source, /window\.location\.replace\(href\)/);
  // …and everything else stays a client-side navigation.
  assert.match(source, /router\.push\(href, options\)/);
  assert.match(source, /router\.replace\(href, options\)/);
  assert.ok(
    !/localStorage|sessionStorage|document\.cookie/.test(source),
    "the decision is about this document's ad code, not stored client state",
  );
});

test("link-based match entries also leave an ad-carrying document", () => {
  // A private room's "Open the match" is a <Link> on the profile — a client
  // navigation that would otherwise keep the profile's ad code alive.
  const guard = code(read("src/components/MatchEntryGuard.tsx"));
  assert.match(guard, /"use client"/);
  assert.match(guard, /isMatchHref\(/, "the guard must use the same URL classifier");
  assert.match(guard, /hasAdCodeLoaded\(\)/, "…and only act in an ad-carrying document");
  assert.match(
    guard,
    /addEventListener\("click", onClick, true\)/,
    "the guard must run in the capture phase, before Next's <Link> handler",
  );
  assert.match(guard, /event\.preventDefault\(\)/);
  assert.match(guard, /window\.location\.assign\(anchor\.href\)/);
  assert.match(
    read("src/app/layout.tsx"),
    /<MatchEntryGuard \/>/,
    "the guard must be mounted once, globally",
  );
});

// ── Monetag was removed, and stays removed ─────────────────────────────────
// The second ad provider's intrusive formats (popunder, vignette, in-page push)
// were removed deliberately: they hurt retention. Nothing here may come back
// accidentally — a leftover import, a re-added CSP host or a renamed loader
// file would reintroduce the tag without anyone deciding to.
//
// `CHANGELOG.md` is exempt on purpose: it is a historical record of what was
// shipped, not an instruction or a live reference.

const MONETAG_PATTERN = /monetag|quge5|295730|1203148[1-4]|sw1\.js/i;

const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  ".git",
  ".open-next",
  ".vercel",
  "coverage",
  ".cache_ggshield",
]);
const TEXT_FILE = /\.(js|jsx|ts|tsx|mjs|cjs|json|md|txt|css|scss|html|ya?ml)$/i;

/** Every text file we ship, repo-relative POSIX. Dotfiles (env) are excluded. */
function shippedTextFiles(dir = ".", out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) shippedTextFiles(full, out);
    } else if (TEXT_FILE.test(entry.name)) {
      out.push(relative(process.cwd(), full).split(sep).join("/"));
    }
  }
  return out;
}

test("no Monetag file is shipped any more", () => {
  for (const path of [
    "src/components/MonetagScript.tsx",
    "public/sw1.js",
    "qa/monetag-browser-check.mjs",
    "docs/MONETAG.md",
    "docs/monetag-support-request.md",
  ]) {
    assert.ok(!exists(path), `${path} must stay deleted`);
  }
});

test("nothing in the source tree, config, tests or docs references Monetag", () => {
  const offenders = shippedTextFiles()
    // This file names the provider on purpose — it is the removal guard.
    .filter((file) => file !== "tests/ad-model.test.mjs")
    // Historical record, not a live reference.
    .filter((file) => file !== "CHANGELOG.md")
    .filter((file) => MONETAG_PATTERN.test(read(file)));

  assert.deepEqual(
    offenders,
    [],
    "a Monetag domain, zone id, worker filename or loader reference came back",
  );
});

test("the ad config exposes no Monetag surface", () => {
  assert.ok(!/monetag/i.test(code(CONFIG)), "lib/ads.ts must not export provider values");

  // The zone was configuration, so no deploy can switch the provider back on.
  // Only the files that DECIDE configuration are scanned here — the app source,
  // the deploy tooling and the env template — so this guard does not count its
  // own search pattern as a hit.
  const configFiles = [
    ...shippedTextFiles("src"),
    ...shippedTextFiles("deploy"),
    ...shippedTextFiles("scripts"),
    "next.config.js",
    ".env.example",
  ].filter((file) => file !== ".env.example" || exists(".env.example"));

  const offenders = configFiles.filter(
    (file) => exists(file) && /NEXT_PUBLIC_MONETAG/i.test(read(file)),
  );
  assert.deepEqual(offenders, [], "no Monetag environment variable may be read by the app");
});

test("the CSP allows no Monetag frame host, and keeps the AdSense ones", () => {
  const frameSrc = PROXY.match(/frame-src [^;]+;/);
  assert.ok(frameSrc, "the CSP must keep an explicit frame-src directive");
  assert.ok(
    !MONETAG_PATTERN.test(frameSrc[0]),
    "no removed provider host may linger in frame-src",
  );
  assert.ok(
    frameSrc[0].includes("https://*.googlesyndication.com"),
    "the AdSense ad frames must still be allowed",
  );
});

test("the PWA keeps the root service worker and no second worker is served", () => {
  // next-pwa owns /sw.js; the removal must not have touched it.
  assert.ok(exists("public/sw.js"), "the generated Workbox service worker is preserved");
  const conf = read("next.config.js");
  assert.match(conf, /register: true/, "next-pwa must still register its worker");
  assert.ok(!/sw1\.js/.test(conf), "no removed-provider worker route may be served");
});
