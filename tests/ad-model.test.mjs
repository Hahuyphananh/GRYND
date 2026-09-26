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
    "battlepass",
    "home",
    "hub",
    "leaderboard",
    "profile",
  ]);
});

test("every ad slot or loader sits on a non-game browsing page", () => {
  const pagesWithSlots = allPages().filter((p) => /<AdSlot\s/.test(read(p)));
  assert.deepEqual(pagesWithSlots, [
    "src/app/battlepass/page.jsx",
    "src/app/casino/page.jsx",
    "src/app/classement/page.jsx",
    "src/app/page.jsx",
    "src/app/profil/page.jsx",
  ]);
});

test("no ad capability exists inside gameplay", () => {
  // Match/board routes are dynamic routes; nothing there may carry a slot or
  // even the loader.
  for (const page of allPages()) {
    if (!/\[[^\]]+\]/.test(page)) continue;
    const source = read(page);
    assert.ok(!/<AdSlot\s/.test(source), `${page} is a match route and must have no ad slot`);
    assert.ok(!/AdSenseScript/.test(source), `${page} is a match route and must have no ad loader`);
  }

  // Games whose lobby and board share one route stay entirely ad-free.
  for (const page of allPages()) {
    if (!/dice-flush|odds|keno|neon-flush/.test(page)) continue;
    const source = read(page);
    assert.ok(!/<AdSlot\s/.test(source), `${page} plays on its lobby URL — no ad slot`);
    assert.ok(!/AdSenseScript/.test(source), `${page} plays on its lobby URL — no ad loader`);
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
    ["src/app/battlepass/page.jsx", "src/app/battlepass/PageClient.jsx"],
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
