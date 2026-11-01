/**
 * HilltopAds banner — integration contract.
 *
 * The provider's tag is a third-party script we do not control, so the promises
 * that keep it harmless are pinned here:
 *
 *   1. the supplied code is preserved (URL, `{}` settings, async, referrer
 *      policy, insertion order) — a "clean" rewrite would change behaviour;
 *   2. configuration validates and fails closed, and each provider switches
 *      independently;
 *   3. the tag loads at most once per session;
 *   4. disabled advertising and GRYND PRO members receive nothing at all;
 *   5. a blocked request fails silently, with no placeholder creative;
 *   6. no gameplay route and no global layout can mount it;
 *   7. nothing here can open a window or navigate.
 *
 * Run: node --import tsx --test tests/hilltop-banner.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join, relative, sep } from "node:path";

import {
  HILLTOP_BANNER_SETTINGS,
  HILLTOP_CONTAINER_ID,
  HILLTOP_PLACEMENT_ROUTES,
  HILLTOP_PLACEMENTS,
  HILLTOP_PROVIDER_SCRIPT_URL,
  HILLTOP_READY_TIMEOUT_MS,
  HILLTOP_RESERVED_HEIGHT_PX,
  HILLTOP_SESSION_KEY,
  HILLTOP_SNIPPET_ATTRIBUTE,
  hilltopBannerAllowed,
  hilltopBannerEnabled,
  hilltopBannerEnabledOnServer,
  hilltopBannerLoadedThisSession,
  hilltopBannerScriptUrl,
  hilltopBannerSnippet,
  hilltopBannerVisibleToViewer,
  hilltopProviderAttested,
  hilltopRouteMatchesPlacement,
  isHilltopPlacement,
  markHilltopBannerLoaded,
  normalizeHilltopScriptUrl,
} from "../src/lib/hilltop/config.ts";
import { adsEnabled } from "../src/lib/ads.ts";

const read = (path) => fs.readFileSync(path, "utf8");
const code = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const CONFIG = read("src/lib/hilltop/config.ts");
const BANNER = read("src/components/ads/HilltopBanner.tsx");
const UNIT = read("src/components/ads/HilltopBannerUnit.tsx");
const ADSENSE_CONFIG = read("src/lib/ads.ts");
const VAST_CONFIG = read("src/lib/vast/config.ts");

const PROVIDER_URL =
  "//juvenilechoice.com/bqXMV.sXdGGwlp0oYEWCcI/HeAmt9/uXZuUklDkMPBTQcD1DOAD/Qb2ZNYDuk/tXNQzzUv4rNRDTY-1/MKwp";

/** Run `fn` with a temporary environment and always restore it. */
function withEnv(vars, fn) {
  const saved = {};
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// ── The supplied provider code ─────────────────────────────────────────────

test("the provider URL is preserved exactly as supplied", () => {
  assert.equal(HILLTOP_PROVIDER_SCRIPT_URL, PROVIDER_URL);
  assert.equal(hilltopBannerScriptUrl(), PROVIDER_URL);
  assert.match(PROVIDER_URL, /^\/\/juvenilechoice\.com\/bqXMV\./);
});

test("the snippet keeps the settings object, async flag, referrer policy and insertion order", () => {
  const snippet = hilltopBannerSnippet(HILLTOP_PROVIDER_SCRIPT_URL);

  // The exact provider lines. A reconstruction that "cleans these up" is a
  // behaviour change, so each one is pinned.
  assert.ok(snippet.includes("(function(uxjuqz){"), "the provider signature is preserved");
  assert.ok(
    snippet.includes("l = d.currentScript || d.scripts[d.scripts.length - 1];"),
    "the loader still resolves the current script exactly as supplied",
  );
  assert.ok(snippet.includes("s.settings = uxjuqz || {};"), "settings are the supplied object");
  assert.ok(snippet.includes(`s.src = "${PROVIDER_URL}";`), "the provider URL is unchanged");
  assert.ok(snippet.includes("s.async = true;"), "asynchronous loading is preserved");
  assert.ok(
    snippet.includes("s.referrerPolicy = 'no-referrer-when-downgrade';"),
    "the referrer policy is preserved",
  );
  assert.ok(snippet.includes("l.parentNode.insertBefore(s, l);"), "insert-before itself, as supplied");
  assert.ok(snippet.trimEnd().endsWith("})({})"), "the empty settings argument is preserved");
  assert.ok(
    !snippet.includes("appendTo"),
    "the settings object stays `{}` — no undocumented options are injected",
  );

  // Nothing from the provider's text is lost in translation: the only line that
  // differs from the supplied source is the URL literal, whose value is equal.
  assert.equal(
    snippet.split("\n").length,
    `(function(uxjuqz){
var d = document,
    s = d.createElement('script'),
    l = d.currentScript || d.scripts[d.scripts.length - 1];
s.settings = uxjuqz || {};
s.src = "";
s.async = true;
s.referrerPolicy = 'no-referrer-when-downgrade';
l.parentNode.insertBefore(s, l);
})({})`.split("\n").length,
    "the snippet has the provider's structure, line for line",
  );
});

test("the settings object is empty and frozen", () => {
  assert.deepEqual({ ...HILLTOP_BANNER_SETTINGS }, {});
  assert.ok(Object.isFrozen(HILLTOP_BANNER_SETTINGS));
});

// ── Configuration ──────────────────────────────────────────────────────────

test("every switch is opt-in: the banner is off unless explicitly enabled", () => {
  withEnv(
    {
      NEXT_PUBLIC_HILLTOP_BANNER_ENABLED: undefined,
      HILLTOP_BANNER_ENABLED: undefined,
      HILLTOP_BANNER_PROVIDER_ATTESTED: undefined,
    },
    () => {
      assert.equal(hilltopBannerEnabled(), false, "build-time default is OFF");
      assert.equal(hilltopBannerEnabledOnServer(), false, "runtime default is OFF");
      assert.equal(hilltopProviderAttested(), false, "no attestation by default");
    },
  );

  // Anything that is not an explicit opt-in leaves it off — including the old
  // "false" wording, zeros, empties and typos.
  for (const value of ["false", "0", "no", "", " ", "TRUEE"]) {
    withEnv({ NEXT_PUBLIC_HILLTOP_BANNER_ENABLED: value }, () => {
      assert.equal(hilltopBannerEnabled(), false, `"${value}" must not enable the banner`);
    });
  }

  withEnv({ NEXT_PUBLIC_HILLTOP_BANNER_ENABLED: "TRUE " }, () => {
    assert.equal(hilltopBannerEnabled(), true, "case/whitespace insensitive");
    assert.equal(hilltopBannerEnabledOnServer(), false, "the runtime switch is untouched");
  });

  withEnv({ HILLTOP_BANNER_ENABLED: "1" }, () => {
    assert.equal(hilltopBannerEnabledOnServer(), true, '"1" is a valid opt-in');
  });

  // Independent of the other two providers: disabling the banner leaves AdSense
  // exactly as it was, and no other provider's flag is read here.
  withEnv({ HILLTOP_BANNER_ENABLED: "false", NEXT_PUBLIC_HILLTOP_BANNER_ENABLED: "false" }, () => {
    assert.equal(adsEnabled(), true, "AdSense is unaffected by the banner switch");
  });
  assert.ok(!/ADSENSE_|POST_MATCH_ADS/.test(code(CONFIG)), "no other provider's flags are read");
});

test("enabling requires the provider attestation, not just a switch", () => {
  assert.match(BANNER, /hilltopProviderAttested\(\)/, "the attestation is part of the gate");

  withEnv(
    {
      NEXT_PUBLIC_HILLTOP_BANNER_ENABLED: "true",
      HILLTOP_BANNER_ENABLED: "true",
      HILLTOP_BANNER_PROVIDER_ATTESTED: undefined,
    },
    () => {
      assert.equal(hilltopProviderAttested(), false, "the switches do NOT imply the attestation");
    },
  );

  withEnv({ HILLTOP_BANNER_PROVIDER_ATTESTED: "TRUE" }, () => {
    assert.equal(hilltopProviderAttested(), true, "an explicit attestation enables the banner");
  });
});

test("the URL override is validated and an invalid one fails closed", () => {
  assert.equal(normalizeHilltopScriptUrl(`https:${PROVIDER_URL}`), `https:${PROVIDER_URL}`);
  assert.equal(normalizeHilltopScriptUrl(PROVIDER_URL), PROVIDER_URL);

  // Refused: other hosts, plain http, credentials, junk.
  assert.equal(normalizeHilltopScriptUrl("https://evil.example/tag.js"), null);
  assert.equal(normalizeHilltopScriptUrl(`http:${PROVIDER_URL}`), null);
  assert.equal(normalizeHilltopScriptUrl(`https://user:pw@${PROVIDER_URL.slice(2)}`), null);
  assert.equal(normalizeHilltopScriptUrl("javascript:alert(1)"), null);
  assert.equal(normalizeHilltopScriptUrl(""), null);
  assert.equal(normalizeHilltopScriptUrl(null), null);
  assert.equal(normalizeHilltopScriptUrl("https://juvenilechoice.com/" + "a".repeat(2100)), null);

  withEnv({ NEXT_PUBLIC_HILLTOP_BANNER_SCRIPT_URL: "https://evil.example/tag.js" }, () => {
    assert.equal(hilltopBannerScriptUrl(), null, "a bad override renders nothing");
  });
  withEnv({ NEXT_PUBLIC_HILLTOP_BANNER_SCRIPT_URL: "" }, () => {
    assert.equal(hilltopBannerScriptUrl(), PROVIDER_URL, "no override means the supplied tag");
  });
});

test("only approved browsing placements are accepted", () => {
  assert.deepEqual([...HILLTOP_PLACEMENTS], ["home", "hub", "leaderboard", "profile"]);
  assert.equal(isHilltopPlacement("hub"), true);
  assert.equal(isHilltopPlacement("game"), false);
  assert.equal(isHilltopPlacement("casino/uno"), false);
  assert.equal(isHilltopPlacement(42), false);
  assert.equal(isHilltopPlacement(undefined), false);
});

// ── Gates: disabled advertising and ad-free users ─────────────────────────

test("disabled advertising renders nothing", () => {
  assert.equal(hilltopBannerAllowed({ enabled: false, configured: true, placement: "hub" }), false);
  assert.equal(hilltopBannerAllowed({ enabled: true, configured: false, placement: "hub" }), false);
  assert.equal(hilltopBannerAllowed({ enabled: true, configured: true, placement: "hub" }), true);
  assert.equal(
    hilltopBannerAllowed({ enabled: true, configured: true, placement: "match" }),
    false,
    "an unapproved placement never renders, even when everything else is on",
  );
});

test("a GRYND PRO member renders nothing, from the server's own answer", () => {
  assert.equal(hilltopBannerVisibleToViewer({ allowed: true, adFree: true }), false);
  assert.equal(hilltopBannerVisibleToViewer({ allowed: true, adFree: false }), true);
  assert.equal(hilltopBannerVisibleToViewer({ allowed: false, adFree: false }), false);

  // The component is a server component and asks the authoritative helper.
  assert.ok(!/"use client"/.test(BANNER), "the gate must stay on the server");
  assert.match(BANNER, /await isAdFreeViewer\(\)/, "entitlement comes from the server helper");
  assert.match(BANNER, /import \{ isAdFreeViewer \} from "\.\.\/\.\.\/lib\/adEntitlement"/);
  assert.ok(
    !/(localStorage|sessionStorage|document\.cookie|premium|isPro)/.test(code(BANNER)),
    "no client-side membership state or prop can influence the gate",
  );
  // The provider code is never written for a member: the unit is only rendered
  // after every gate (including the attestation) passes.
  const unitMount = BANNER.indexOf("<HilltopBannerUnit placement={placement} />");
  assert.ok(unitMount > BANNER.indexOf("isAdFreeViewer"), "the unit is mounted after the gate");
});

// ── Duplicate loading ─────────────────────────────────────────────────────

test("the banner loads once per session", () => {
  const memoryStorage = () => {
    const map = new Map();
    return {
      getItem: (key) => (map.has(key) ? map.get(key) : null),
      setItem: (key, value) => map.set(key, value),
      raw: () => map.get(HILLTOP_SESSION_KEY) ?? null,
    };
  };

  const storage = memoryStorage();
  assert.equal(hilltopBannerLoadedThisSession(storage), false);
  markHilltopBannerLoaded(storage);
  assert.equal(storage.raw(), "1", "the session key is written once");
  assert.equal(hilltopBannerLoadedThisSession(storage), true);

  // A denied store must never throw, and never claim the tag was loaded.
  const denied = {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("denied");
    },
  };
  assert.equal(hilltopBannerLoadedThisSession(denied), false);
  assert.doesNotThrow(() => markHilltopBannerLoaded(denied));
  assert.equal(hilltopBannerLoadedThisSession(null), false);

  // One injection site, guarded by both the DOM sentinel and the session key.
  assert.equal(
    (code(UNIT).match(/document\.createElement\("script"\)/g) ?? []).length,
    1,
    "exactly one script element is ever created by our integration",
  );
  assert.equal(
    (code(UNIT).match(/appendChild\(snippet\)/g) ?? []).length,
    1,
    "exactly one append, not one per render",
  );
  // The sentinel's literal lives in the config module; the unit uses it through
  // the constant, so both are asserted where they actually belong.
  assert.ok(code(CONFIG).includes(HILLTOP_SNIPPET_ATTRIBUTE), "the sentinel is defined once");
  assert.match(code(UNIT), /HILLTOP_SNIPPET_ATTRIBUTE/, "the unit marks its own snippet");
  assert.match(code(UNIT), /hilltopBannerLoadedThisSession\(storage\)/);
  assert.match(code(UNIT), /markHilltopBannerLoaded\(storage\)/);
});

// ── Failure handling and cleanup ──────────────────────────────────────────

test("a blocked or unfilled request fails silently, never with fake content", () => {
  assert.equal(typeof HILLTOP_READY_TIMEOUT_MS, "number");
  assert.ok(HILLTOP_READY_TIMEOUT_MS > 0 && HILLTOP_READY_TIMEOUT_MS <= 15_000);
  assert.match(code(UNIT), /new MutationObserver/, "arrival is detected, not assumed");
  assert.match(code(UNIT), /setPhase\("unavailable"\)/, "a failure has an explicit state");
  assert.match(code(UNIT), /window\.clearTimeout\(timer\)/, "the bounded wait is cleared");
  assert.match(code(UNIT), /observer\.disconnect\(\)/, "the observer is released");

  // A frame the document's policy refuses can never paint. It must collapse
  // rather than hold a blank reserved box that the observer would call "filled".
  assert.match(code(UNIT), /securitypolicyviolation/, "a blocked frame is detected");
  assert.match(code(UNIT), /effectiveDirective/, "…by the directive that blocked it");
  assert.match(code(UNIT), /HILLTOP_PROVIDER_HOST/, "…only for the provider's own host");
  assert.match(
    code(UNIT),
    /document\.removeEventListener\("securitypolicyviolation", onViolation\)/,
    "our listener is removed on unmount",
  );

  // No invented creative, no retry loop, no placeholder copy.
  assert.ok(
    !/placeholder|sample\.mp4|fallback.*src=|stock/i.test(code(UNIT)),
    "a failed tag is never replaced with invented video content",
  );
  assert.ok(!/setInterval/.test(code(UNIT)), "no retry loop");
  assert.ok(
    !/<img|<video|<iframe/.test(code(UNIT)),
    "our own code never draws ad-shaped content",
  );
});

test("the reserved area is bounded and the provider's nodes are never deleted by hand", () => {
  assert.equal(HILLTOP_RESERVED_HEIGHT_PX, 250);
  assert.match(code(UNIT), /minHeight: HILLTOP_RESERVED_HEIGHT_PX/, "space is reserved, not shifted");
  assert.match(code(UNIT), /reserved \? "" : "hidden"/, "nothing is reserved after a failure");

  // The reservation starts at the FIRST render (idle), i.e. in the server's own
  // HTML — otherwise the block would appear only after hydration and push the
  // page down.
  assert.match(
    code(UNIT),
    /const reserved = phase !== "unavailable"/,
    "space must be reserved from the first render, not after the ad arrives",
  );

  // The caption belongs to the ad it labels: no bare heading over an empty box
  // when a later page in the session draws nothing.
  assert.match(code(UNIT), /Advertisement/, "the caption is rendered with the ad");
  // The shell may label the region (`aria-label="Advertisement"`, for screen
  // readers) but must not DRAW the visible caption: it would then sit above an
  // empty box on any later page in a session where the tag already loaded.
  assert.ok(
    !/tracking-\[0\.2em\][^>]*>\s*Advertisement/.test(code(BANNER)),
    "the visible caption must live with the ad, not in the server shell",
  );
  assert.match(code(BANNER), /aria-label="Advertisement"/, "the region stays labelled for assistive tech");

  // The container is ours; the provider's nodes live inside it and are removed
  // with it. There is no `remove()` of provider output anywhere.
  assert.ok(!/\.remove\(\)/.test(code(UNIT)), "no node is deleted by hand");
  assert.ok(!/document\.body/.test(code(UNIT)), "nothing is injected at document level");
  assert.match(code(UNIT), /host\.appendChild\(snippet\)/, "injection happens inside our container");
  assert.match(code(UNIT), /HILLTOP_CONTAINER_ID/, "the unit renders the container it owns");
  assert.ok(code(CONFIG).includes(HILLTOP_CONTAINER_ID), "the container id is defined once");
});

test("the integration is isolated from AdSense and from the VAST pipeline", () => {
  // The banner reads neither provider's modules nor their flags. (The VAST
  // integration is itself a HilltopAds product, so the shared VENDOR name is
  // expected there — what must not appear is any banner surface.)
  assert.ok(!/lib\/ads|AdSlot|AdUnit|adsbygoogle|ADSENSE_/.test(code(CONFIG)));
  assert.ok(!/vast|PostMatchVideoAd|postMatchAd/i.test(code(CONFIG)));
  assert.ok(!/vast|PostMatchVideoAd|postMatchAd/i.test(code(UNIT) + code(BANNER)));

  assert.ok(!/HILLTOP_BANNER|NEXT_PUBLIC_HILLTOP_BANNER|HilltopBanner|hilltopBanner/.test(ADSENSE_CONFIG));
  assert.ok(
    !/HILLTOP_BANNER|NEXT_PUBLIC_HILLTOP_BANNER|HilltopBanner|hilltopBanner/.test(VAST_CONFIG),
    "the VAST config gains no banner surface",
  );
  // …and the VAST pipeline's own switches are not read by the banner.
  assert.ok(!/POST_MATCH_ADS/.test(code(CONFIG)));
});

// ── Placement and page policy ─────────────────────────────────────────────

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

test("no gameplay route and no global layout mounts the banner", () => {
  const offenders = allPages().filter((page) => {
    if (!/HilltopBanner/.test(read(page))) return false;
    const route = page
      .replace(/^src\/app\//, "")
      .replace(/\/page\.(jsx?|tsx?)$/, "");
    const isDynamic = /\[[^\]]+\]/.test(route);
    // Anything below /casino/<slug> belongs to a game, not a lobby.
    const isGameplayDepth = route.startsWith("casino/") && route.split("/").length > 2;
    // Games that play on their lobby URL have no ad-free place of their own.
    const isOnePageGame = /dice-flush|odds|keno|neon-flush/.test(route);
    return isDynamic || isGameplayDepth || isOnePageGame;
  });

  assert.deepEqual(offenders, [], "the banner must never be mounted on gameplay");

  // Not global, and not inside the app shell.
  assert.ok(!/HilltopBanner/.test(read("src/app/layout.tsx")), "never in the global layout");
});

test("the component itself refuses a gameplay URL at runtime", () => {
  assert.match(code(UNIT), /import \{ isMatchHref \}/, "the shared URL classifier is reused");
  assert.match(code(UNIT), /isMatchHref\(/, "the runtime guard calls it");
  assert.match(code(UNIT), /window\.location\.pathname/, "…on the URL actually being viewed");
});

// ── The approved placements, exactly ──────────────────────────────────────

/**
 * The phase-1 allow-list. Adding a page here is a deliberate product decision,
 * so the set is pinned in both directions: a page that mounts the banner
 * without being approved fails, and an approved page that stops mounting it
 * fails too (a silent regression looks identical to a decision).
 */
const APPROVED_PLACEMENTS = {
  "src/app/casino/page.jsx": "hub",
  "src/app/classement/page.jsx": "leaderboard",
  "src/app/page.jsx": "home",
  "src/app/profil/page.jsx": "profile",
};

test("the banner is mounted on exactly the four approved pages", () => {
  const mounting = allPages()
    .filter((page) => /<HilltopBanner\b/.test(read(page)))
    .sort();

  assert.deepEqual(
    mounting,
    Object.keys(APPROVED_PLACEMENTS).sort(),
    "only the home page, the games hub, the leaderboard and the profile may carry it",
  );

  for (const [page, placement] of Object.entries(APPROVED_PLACEMENTS)) {
    const source = read(page);
    assert.equal(
      (source.match(/<HilltopBanner\b/g) ?? []).length,
      1,
      `${page} must mount exactly one banner — no per-card or repeated blocks`,
    );
    assert.match(
      source,
      new RegExp(`<HilltopBanner placement="${placement}" />`),
      `${page} must name its own placement, not another surface's`,
    );
    assert.match(source, /import HilltopBanner from /, `${page} must import the component`);
  }
});

test("each approved page hands the banner to its client, which renders it once", () => {
  const CLIENTS = {
    "src/app/page.jsx": "src/app/PageClient.jsx",
    "src/app/casino/page.jsx": "src/app/casino/PageClient.jsx",
    "src/app/classement/page.jsx": "src/app/classement/PageClient.jsx",
    "src/app/profil/page.jsx": "src/app/profil/PageClient.jsx",
  };

  for (const [page, client] of Object.entries(CLIENTS)) {
    assert.match(
      read(page),
      /hilltopSlot=\{<HilltopBanner placement="[a-z]+" \/>\}/,
      `${page} must pass the banner down as a server-rendered slot`,
    );

    const source = read(client);
    assert.match(source, /hilltopSlot = null/, `${client} must accept the slot`);
    assert.equal(
      (source.match(/\{hilltopSlot\}/g) ?? []).length,
      1,
      `${client} must render the slot exactly once`,
    );

    // Density: the banner is never stacked against the page's AdSense slot.
    const bannerAt = source.indexOf("{hilltopSlot}");
    const adsenseAt = source.indexOf("{adSlot}");
    assert.ok(bannerAt > -1 && adsenseAt > -1, `${client} must render both providers`);
    assert.ok(
      bannerAt < adsenseAt,
      `${client} must keep the banner away from the footer slot, not beside it`,
    );
  }
});

test("no approved placement sits above a game board or a match", () => {
  // The placement NAMES are the only thing a page may say, and none of them is
  // a gameplay surface. This is the cheap check that the registry itself can
  // never be extended into gameplay by accident.
  for (const placement of HILLTOP_PLACEMENTS) {
    assert.ok(
      ["home", "hub", "leaderboard", "profile"].includes(placement),
      `${placement} must be a browsing surface`,
    );
  }
  assert.equal(HILLTOP_PLACEMENTS.length, 4, "phase 1 is four placements, not more");
});

// ── No popups, no redirects ───────────────────────────────────────────────

test("nothing in the integration can open a window or navigate", () => {
  const combined = code(CONFIG) + code(UNIT) + code(BANNER);
  for (const forbidden of [
    "window.open",
    "location.assign",
    "location.replace",
    "location.href",
    "target=\"_blank\"",
    "<a ",
    "document.write",
    "dangerouslySetInnerHTML",
    "eval(",
    "new Function",
  ]) {
    assert.ok(
      !combined.includes(forbidden),
      `${forbidden} must never appear in the banner integration`,
    );
  }
});

// ── Safeguards that keep the banner off every playable surface ────────────

test("the route guard admits exactly the four approved routes", () => {
  assert.deepEqual(
    Object.entries(HILLTOP_PLACEMENT_ROUTES).map(([placement, routes]) => [
      placement,
      [...routes],
    ]),
    [
      ["home", ["/"]],
      ["hub", ["/games", "/casino"]],
      ["leaderboard", ["/classement"]],
      ["profile", ["/profil"]],
    ],
  );

  assert.equal(hilltopRouteMatchesPlacement("/", "home"), true);
  assert.equal(hilltopRouteMatchesPlacement("/games", "hub"), true);
  assert.equal(hilltopRouteMatchesPlacement("/casino", "hub"), true);
  assert.equal(hilltopRouteMatchesPlacement("/classement", "leaderboard"), true);
  assert.equal(hilltopRouteMatchesPlacement("/profil", "profile"), true);
  assert.equal(hilltopRouteMatchesPlacement("/profil/", "profile"), true, "a trailing slash is tolerated");
  assert.equal(
    hilltopRouteMatchesPlacement("/classement?tab=weekly", "leaderboard"),
    true,
    "a query string is ignored",
  );
});

test("a lobby, a board, a match and an alias are all refused", () => {
  const never = [
    "/casino/uno",
    "/casino/chess",
    "/casino/uno/game/abc",
    "/casino/chess/ai",
    "/casino/chess/100",
    "/casino/four-in-a-row/play-ai",
    "/games/chess",
    "/games/chess/play",
    "/games/chess/ai",
    "/profil/clerk_123",
    "/rooms/join",
    "/settings",
  ];

  for (const pathname of never) {
    for (const placement of HILLTOP_PLACEMENTS) {
      assert.equal(
        hilltopRouteMatchesPlacement(pathname, placement),
        false,
        `${pathname} must never serve the ${placement} banner`,
      );
    }
  }

  // A page may serve only its OWN placement — no borrowing another surface's.
  assert.equal(hilltopRouteMatchesPlacement("/games", "home"), false);
  assert.equal(hilltopRouteMatchesPlacement("/", "hub"), false);
  assert.equal(hilltopRouteMatchesPlacement("/classement", "profile"), false);
  assert.equal(hilltopRouteMatchesPlacement("/profil", "leaderboard"), false);
  assert.equal(hilltopRouteMatchesPlacement(undefined, "home"), false);
  assert.equal(hilltopRouteMatchesPlacement("/", "match"), false);
});

test("the document's CSP allows the provider's creative frame", () => {
  const frameSrc = read("src/proxy.ts").match(/frame-src [^;]+;/);
  assert.ok(frameSrc, "an explicit frame-src directive must stay");
  assert.ok(
    frameSrc[0].includes("https://juvenilechoice.com"),
    "the creative's host must be named, or a switched-on banner can never paint",
  );
  // A bare `https:` token would wildcard the directive. (`https://host` also
  // starts with "https:", so this compares whole tokens, not a substring.)
  const hosts = frameSrc[0]
    .replace(/^frame-src\s+/, "")
    .replace(/;\s*$/, "")
    .trim()
    .split(/\s+/);
  assert.ok(
    !hosts.includes("https:"),
    "frame-src must stay a per-host allow-list, never a wildcard",
  );
});

test("the browser half enforces the route against the pathname it is on", () => {
  assert.match(code(UNIT), /hilltopRouteMatchesPlacement\(window\.location\.pathname, placement\)/);
  assert.match(code(UNIT), /placement: HilltopPlacement/, "the placement is required, not optional");
  assert.match(code(BANNER), /<HilltopBannerUnit placement=\{placement\} \/>/, "it is passed down");
});

test("no game lobby mounts the banner, even though a lobby may carry AdSense", () => {
  const lobbyPages = allPages().filter((page) =>
    /^src\/app\/casino\/[^/]+\/page\.(jsx?|tsx?)$/.test(page),
  );
  assert.ok(
    lobbyPages.length >= 15,
    `expected the game lobby tree (found ${lobbyPages.length}) — a walk that finds nothing proves nothing`,
  );

  const offenders = lobbyPages.filter((page) => /<HilltopBanner\b/.test(read(page)));
  assert.deepEqual(offenders, [], "a game lobby must never load the banner");
});

test("the integration cannot touch input, steal focus or overlay the page", () => {
  const combined = code(CONFIG) + code(UNIT) + code(BANNER);

  for (const forbidden of [
    "position:fixed",
    "position:absolute",
    "position:sticky",
    "inset:0",
    "z-index",
    "tabIndex",
    "autoFocus",
    "pointerEvents",
    'addEventListener("key',
    'addEventListener("mouse',
    'addEventListener("touch',
    'addEventListener("pointer',
    'addEventListener("wheel',
    "preventDefault",
    "stopPropagation",
  ]) {
    assert.ok(
      !combined.includes(forbidden),
      `${forbidden} must not appear — the banner is in-flow and completely passive`,
    );
  }

  // The one document-level listener is the CSP guard, and it is released again.
  const listeners = [...code(UNIT).matchAll(/document\.addEventListener\("([a-z]+)"/g)].map(
    (match) => match[1],
  );
  assert.deepEqual(listeners, ["securitypolicyviolation"], "no input listener is ever installed");
  assert.match(code(UNIT), /removeEventListener\("securitypolicyviolation", onViolation\)/);

  // Ordinary in-flow block: no positioning utility on our own wrapper.
  assert.ok(
    !/\b(fixed|absolute|sticky)\b/.test(code(UNIT) + code(BANNER)),
    "no positioning utility class on the wrapper",
  );
});

test("no fake frequency control: the tag simply is not loaded twice", () => {
  // The provider's settings object accepts `scriptSrc`, `ads` and `appendTo`
  // ONLY, and its build has no impression cap or cooldown. There is nothing to
  // configure, so nothing here invents a knob that would only hide a running ad.
  for (const invented of [
    "maxPerDay",
    "impressionsPerDay",
    "frequencyCap",
    "cooldownMinutes",
    "adsPerPage",
  ]) {
    assert.ok(
      !code(CONFIG).includes(invented),
      `${invented} is not a provider setting and must not be invented`,
    );
  }

  // The lever we DO own is structural: the second visit injects nothing.
  assert.match(
    code(UNIT),
    /if \(!alreadyInHost && hilltopBannerLoadedThisSession\(storage\)\) \{\s*setPhase\("already"\)/,
  );
  assert.equal(
    (code(UNIT).match(/createElement\("script"\)/g) ?? []).length,
    1,
    "one injection site, reached only when the session key is unset",
  );
  assert.match(code(UNIT), /if \(phase === "already"\) return null;/, "nothing is hidden — nothing is drawn");
});

test("an ad failure can never block rendering or navigation", () => {
  // Browser: the provider script is appended, never awaited, and there is no
  // load event our render path waits on.
  assert.match(code(CONFIG), /s\.async = true;/, "the provider script stays async");
  assert.ok(!/\bawait\b/.test(code(UNIT)), "the browser half never awaits the ad");
  assert.ok(!/addEventListener\("load"/.test(code(UNIT)), "no render path waits for a load event");

  // Server: an entitlement failure renders NO banner instead of failing the page.
  assert.match(
    code(BANNER),
    /let adFree: boolean;\s*try \{\s*adFree = await isAdFreeViewer\(\);\s*\} catch \{\s*return null;\s*\}/,
    "a thrown entitlement lookup must not take the page down",
  );
});
