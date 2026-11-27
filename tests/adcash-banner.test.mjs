/**
 * Adcash display banner — integration contract.
 *
 * The provider's library and zone call are third-party code, so the promises
 * that keep them harmless are pinned here:
 *
 *   1. nothing loads until a real display zone AND the dashboard's library URL
 *      are configured — no default zone, no default library, no invented value;
 *   2. configuration validates and fails closed;
 *   3. the provider is disabled by default and independent of Hilltop/ExoClick/
 *      AdSense;
 *   4. the library loads once per document and `runBanner` runs once per zone;
 *   5. consent, native-app, entitlement and route gates are all enforced;
 *   6. no-fill and library failure collapse quietly, with no placeholder;
 *   7. only the Display format is used — no pop, autotag, interstitial, push,
 *      slider, anti-adblock or navigation;
 *   8. the document's CSP names the provider's hosts.
 *
 * Run: npm run test:adcash
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join, relative, sep } from "node:path";
import { mock } from "node:test";

import {
  ADCASH_LIBRARY_ATTRIBUTE,
  ADCASH_PLACEMENT_ROUTES,
  ADCASH_PLACEMENTS,
  ADCASH_READY_TIMEOUT_MS,
  ADCASH_RESERVED_HEIGHTS,
  adcashBannerAllowed,
  adcashBannerConfigured,
  adcashBannerEnabled,
  adcashBannerEnabledOnServer,
  adcashBannerSize,
  adcashBannerVisibleToViewer,
  adcashConsentSatisfied,
  adcashLibraryUrl,
  adcashRequiresConsent,
  adcashReservedHeight,
  adcashRouteMatchesPlacement,
  adcashRunKey,
  adcashSizeForZone,
  adcashSizeMaxWidth,
  adcashZoneId,
  isAdcashPlacement,
  isAdcashProviderHost,
  normalizeAdcashLibraryUrl,
  shouldRunAdcashZone,
  ADCASH_ZONE_IDS,
  ADCASH_ZONE_SIZES,
} from "../src/lib/adcash/config.ts";
import { buildFrameSrc } from "../src/lib/security/csp.ts";

const read = (path) => fs.readFileSync(path, "utf8");
/** Assertions test CODE, not the prose that explains it. */
const code = (source) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

const CONFIG = read("src/lib/adcash/config.ts");
const BANNER = read("src/components/ads/AdcashBanner.tsx");
const UNIT = read("src/components/ads/AdcashBannerUnit.tsx");
const RUNTIME = read("src/lib/ads/banners/runtime.ts");
const CSP = read("src/lib/security/csp.ts");
const PROXY = read("src/proxy.ts");

const LIBRARY = "https://acscdn.com/script/aclib.js";
const ZONE = "1234567";

const MODULE_MOCKING_AVAILABLE = typeof mock?.module === "function";
const SKIP_REASON = MODULE_MOCKING_AVAILABLE
  ? false
  : "module mocking is off — run: npm run test:adcash";

/** Run `fn` with a temporary environment and always restore it. */
async function withEnv(vars, fn) {
  const saved = {};
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

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

// ── Configuration ─────────────────────────────────────────────────────────

test("the banner is on by default with the account library and Display zones", async () => {
  await withEnv(
    {
      NEXT_PUBLIC_ADCASH_ENABLED: undefined,
      ADCASH_ENABLED: undefined,
      NEXT_PUBLIC_ADCASH_LIBRARY_URL: undefined,
      NEXT_PUBLIC_ADCASH_ZONE_HOME: undefined,
    },
    () => {
      assert.equal(adcashBannerEnabled(), true, "the account is configured");
      assert.equal(adcashBannerEnabledOnServer(), true);
      assert.equal(adcashLibraryUrl(), LIBRARY, "the issued library is built in");
      assert.ok(
        ADCASH_ZONE_IDS.includes(adcashZoneId("home")),
        "the zone comes from the issued Display zones",
      );
      assert.equal(adcashBannerConfigured("home"), true);
    },
  );

  // Both switches are KILL switches: an explicit false turns it off.
  for (const value of ["false", "0", "off", "no"]) {
    await withEnv({ NEXT_PUBLIC_ADCASH_ENABLED: value }, () => {
      assert.equal(adcashBannerEnabled(), false, `"${value}" must switch it off`);
    });
  }
  await withEnv({ ADCASH_ENABLED: "false" }, () => {
    assert.equal(adcashBannerEnabledOnServer(), false, "the server kill switch is separate");
  });
  await withEnv({ NEXT_PUBLIC_ADCASH_ENABLED: "TRUE " }, () => {
    assert.equal(adcashBannerEnabled(), true, "case/whitespace insensitive");
  });

  // Independence: no other provider's values or flags are read here.
  assert.ok(
    !/HILLTOP|EXOCLICK|ADSENSE|POST_MATCH|Hilltop|ExoClick|AdSense/.test(code(CONFIG)),
    "the Adcash module must not read another provider's configuration",
  );
});

test("the library URL is validated; the issued library is the default", async () => {
  assert.equal(normalizeAdcashLibraryUrl(LIBRARY), LIBRARY);
  assert.equal(
    normalizeAdcashLibraryUrl("//acscdn.com/script/aclib.js"),
    "https://acscdn.com/script/aclib.js",
    "a protocol-relative dashboard value is upgraded to https",
  );
  assert.equal(normalizeAdcashLibraryUrl("https://cdn.adcash.com/lib.js"), "https://cdn.adcash.com/lib.js");

  for (const bad of [
    "http://acscdn.com/script/aclib.js",
    "https://evil.example/aclib.js",
    "https://user:pass@acscdn.com/script/aclib.js",
    "javascript:alert(1)",
    "not-a-url",
    "",
    null,
    "https://acscdn.com/" + "a".repeat(2100),
  ]) {
    assert.equal(normalizeAdcashLibraryUrl(bad), null, `${bad} must be refused`);
  }

  assert.equal(isAdcashProviderHost("acscdn.com"), true);
  assert.equal(isAdcashProviderHost("adserver.adcash.com"), true);
  assert.equal(isAdcashProviderHost("adcash.com.evil.example"), false);

  await withEnv({ NEXT_PUBLIC_ADCASH_LIBRARY_URL: undefined }, () => {
    assert.equal(adcashLibraryUrl(), LIBRARY, "unset uses the issued library");
  });
  await withEnv({ NEXT_PUBLIC_ADCASH_LIBRARY_URL: "https://evil.example/aclib.js" }, () => {
    assert.equal(adcashLibraryUrl(), null, "an explicit invalid override fails closed");
  });
});

test("zone ids are numeric Display zones from the issued pool", async () => {
  await withEnv({ NEXT_PUBLIC_ADCASH_ZONE_HOME: ZONE }, () => {
    assert.equal(adcashZoneId("home"), ZONE, "an explicit override wins");
    assert.ok(ADCASH_ZONE_IDS.includes(adcashZoneId("profile")), "other pages use the pool");
  });
  for (const bad of ["abc", "12ab", "-1", "  zt2ub7mrao "]) {
    await withEnv({ NEXT_PUBLIC_ADCASH_ZONE_HOME: bad }, () => {
      assert.equal(adcashZoneId("home"), null, `"${bad}" is not a Display zone`);
    });
  }
  assert.equal(adcashZoneId("match"), null);

  // The pool is rotated by opportunity, so both zones are actually used.
  const seen = new Set();
  for (let index = 0; index < 16; index += 1) {
    seen.add(adcashZoneId("home", `banner:home:doc-${index}`));
  }
  assert.deepEqual([...seen].sort(), [...ADCASH_ZONE_IDS].sort());
});

test("banner sizes resolve to a bounded reserved area", async () => {
  assert.equal(adcashBannerSize("home"), "300x250");
  assert.equal(adcashReservedHeight("home"), ADCASH_RESERVED_HEIGHTS["300x250"]);

  await withEnv({ NEXT_PUBLIC_ADCASH_BANNER_SIZE_HOME: "728x90" }, () => {
    assert.equal(adcashBannerSize("home"), "728x90");
    assert.equal(adcashReservedHeight("home"), 90);
  });
  await withEnv({ NEXT_PUBLIC_ADCASH_BANNER_SIZE_HOME: "999x999" }, () => {
    assert.equal(adcashBannerSize("home"), "300x250", "an unknown size cannot widen it");
  });
});

test("configuration requires the placement, the zone and the library together", async () => {
  await withEnv(
    {
      NEXT_PUBLIC_ADCASH_LIBRARY_URL: LIBRARY,
      NEXT_PUBLIC_ADCASH_ZONE_HOME: ZONE,
    },
    () => {
      assert.equal(adcashBannerConfigured("home"), true);
      assert.equal(adcashBannerConfigured("profile"), true, "the built-in pool covers it");
      assert.equal(adcashBannerConfigured("match"), false);
    },
  );

  await withEnv({ NEXT_PUBLIC_ADCASH_ZONE_HOME: "zt2ub7mrao" }, () => {
    assert.equal(adcashBannerConfigured("home"), false, "an Autotag zone is refused");
  });

  await withEnv(
    { NEXT_PUBLIC_ADCASH_LIBRARY_URL: "https://evil.example/aclib.js" },
    () => {
      assert.equal(adcashBannerConfigured("home"), false, "an unapproved host → nothing");
    },
  );
});

// ── Gates ─────────────────────────────────────────────────────────────────

test("only approved browsing placements are accepted", () => {
  assert.deepEqual([...ADCASH_PLACEMENTS], ["home", "hub", "leaderboard", "profile"]);
  assert.equal(isAdcashPlacement("hub"), true);
  assert.equal(isAdcashPlacement("guides"), false);
  assert.equal(isAdcashPlacement("match"), false);
  assert.equal(isAdcashPlacement(42), false);

  assert.equal(adcashBannerAllowed({ enabled: false, configured: true, placement: "home" }), false);
  assert.equal(adcashBannerAllowed({ enabled: true, configured: false, placement: "home" }), false);
  assert.equal(
    adcashBannerAllowed({ enabled: true, configured: true, placement: "match" }),
    false,
    "an unapproved placement never renders",
  );
  assert.equal(adcashBannerAllowed({ enabled: true, configured: true, placement: "home" }), true);

  assert.equal(adcashBannerVisibleToViewer({ allowed: true, adFree: true }), false);
  assert.equal(adcashBannerVisibleToViewer({ allowed: true, adFree: false }), true);
  assert.equal(adcashBannerVisibleToViewer({ allowed: false, adFree: false }), false);
});

test("consent is required by default and fails closed", async () => {
  assert.equal(adcashRequiresConsent(), true, "no env means consent is required");
  assert.equal(adcashConsentSatisfied("accepted"), true);
  assert.equal(adcashConsentSatisfied("declined"), false);
  assert.equal(adcashConsentSatisfied(null), false, "undecided is not consent");
  assert.equal(adcashConsentSatisfied(undefined), false);

  await withEnv({ NEXT_PUBLIC_ADCASH_REQUIRES_CONSENT: "false" }, () => {
    assert.equal(adcashRequiresConsent(), false, "explicit opt-out only");
  });
});

test("a zone is executed at most once per document", () => {
  const executed = new Set();
  const key = adcashRunKey("home", ZONE);

  assert.equal(key, `home:${ZONE}`);
  assert.equal(shouldRunAdcashZone(executed, key), true);
  executed.add(key);
  assert.equal(shouldRunAdcashZone(executed, key), false, "a remount must not rerun it");
  assert.equal(
    shouldRunAdcashZone(executed, adcashRunKey("leaderboard", ZONE)),
    true,
    "another placement has its own zone execution",
  );
});

// ── Source contracts ──────────────────────────────────────────────────────

test("the client unit loads one library and executes one display zone call", () => {
  const source = code(UNIT);

  assert.equal(
    (source.match(/document\.createElement\("script"\)/g) ?? []).length,
    1,
    "exactly one library element is ever created",
  );
  assert.equal(
    (source.match(/document\.head\.appendChild\(script\)/g) ?? []).length,
    1,
    "the library is appended once, not once per render",
  );
  assert.equal(
    (source.match(/\.runBanner\(/g) ?? []).length,
    1,
    "exactly one zone execution call",
  );
  assert.match(source, /renderIn: `#\$\{adcashContainerId\(placement\)\}`/, "renderIn targets our container");
  assert.match(source, /zoneId: zone/);
  assert.match(source, /shouldRunAdcashZone\(executedZones, key\)/);
  assert.match(source, /ADCASH_LIBRARY_ATTRIBUTE/, "the library is marked through the constant");
  assert.ok(
    code(CONFIG).includes(ADCASH_LIBRARY_ATTRIBUTE),
    "the attribute literal exists in exactly one module",
  );
  assert.match(source, /data-grynd-adcash-zone=\{placement\}/, "the container is marked as ours");
  assert.match(source, /if \(existing\)/, "an existing library is reused");

  // Display only: no other Adcash format, no anti-adblock, no navigation.
  for (const forbidden of [
    "runPop",
    "runAutoTag",
    "runInterstitial",
    "runInPagePush",
    "runPush",
    "runVideoSlider",
    "antiAdblock",
    "anti-adblock",
    "document.body",
    "window.open",
    "location.assign",
    "location.replace",
    "location.href",
    'target="_blank"',
    "dangerouslySetInnerHTML",
    "eval(",
    "new Function",
    "position:fixed",
    "position:absolute",
    "position:sticky",
    "z-index",
  ]) {
    assert.ok(!source.includes(forbidden), `${forbidden} must never appear`);
  }

  // Route, consent, failure and cleanup handling.
  assert.match(source, /adcashRouteMatchesPlacement\(window\.location\.pathname, placement\)/);
  assert.match(source, /isMatchHref\(/);
  assert.match(source, /adcashConsentSatisfied\(consent\)/);
  assert.match(source, /COOKIE_CONSENT_EVENT/);
  assert.match(source, /new MutationObserver/);
  assert.match(source, /addEventListener\("error", fail/);
  assert.match(source, /securitypolicyviolation/);
  assert.match(source, /ADCASH_READY_TIMEOUT_MS/);
  assert.match(source, /setPhase\("unavailable"\)/);
  assert.match(source, /window\.clearTimeout\(timer\)/);
  assert.match(source, /observer\?\.disconnect\(\)/);
  assert.ok(!/setInterval/.test(source), "no retry loop");
  assert.ok(
    !/placeholder|sample\.mp4|stock/i.test(source),
    "a failed zone is never replaced with invented content",
  );
  assert.ok(ADCASH_READY_TIMEOUT_MS > 0 && ADCASH_READY_TIMEOUT_MS <= 15_000);
});

// ── Component gates ───────────────────────────────────────────────────────

test(
  "the server component gates on configuration, placement, membership and the native app",
  { skip: SKIP_REASON },
  async (t) => {
    const world = { adFree: false, native: false };

    t.mock.module("../src/lib/adEntitlement.ts", {
      namedExports: { isAdFreeViewer: async () => world.adFree },
    });
    t.mock.module("../src/lib/native/shellServer.ts", {
      namedExports: { isNativeShellDocument: async () => world.native },
    });

    const { default: AdcashBanner } = await import(
      "../src/components/ads/AdcashBanner.tsx"
    );

    const configured = {
      NEXT_PUBLIC_ADCASH_ENABLED: "true",
      ADCASH_ENABLED: "true",
      NEXT_PUBLIC_ADCASH_LIBRARY_URL: LIBRARY,
      NEXT_PUBLIC_ADCASH_ZONE_HOME: ZONE,
      NEXT_PUBLIC_ADCASH_ZONE_PROFILE: "7654321",
    };

    // 1. Configured + free viewer + web → the container and the unit.
    await withEnv({ ...configured }, async () => {
      const banner = await AdcashBanner({ placement: "home" });
      assert.ok(banner, "a configured banner must render");
      assert.equal(banner.props["data-adcash-placement"], "home");
      assert.equal(banner.props["aria-label"], "Advertisement");
      assert.equal(banner.props.children.props.placement, "home");

      // Every approved placement is covered by the built-in Display zone pool.
      assert.ok(
        await AdcashBanner({ placement: "leaderboard" }),
        "the issued zone pool covers the other browsing pages",
      );

      // An unapproved placement cannot be forced in.
      assert.equal(await AdcashBanner({ placement: "match" }), null);

      // 2. GRYND PRO member → nothing at all.
      world.adFree = true;
      assert.equal(await AdcashBanner({ placement: "home" }), null);
      world.adFree = false;

      // 3. Native app → nothing, before configuration is considered.
      world.native = true;
      assert.equal(await AdcashBanner({ placement: "home" }), null);
      world.native = false;
    });

    // 4. Either kill switch set to false → nothing.
    await withEnv({ ...configured, ADCASH_ENABLED: "false" }, async () => {
      assert.equal(await AdcashBanner({ placement: "home" }), null);
    });
    await withEnv({ ...configured, NEXT_PUBLIC_ADCASH_ENABLED: "false" }, async () => {
      assert.equal(await AdcashBanner({ placement: "home" }), null);
    });

    // 5. An explicit invalid zone fails closed (it is not silently replaced by
    // one of the built-in Display zones).
    await withEnv({ ...configured, NEXT_PUBLIC_ADCASH_ZONE_HOME: "zt2ub7mrao" }, async () => {
      assert.equal(await AdcashBanner({ placement: "home" }), null);
    });

    // 6. No library override → the account's issued library is used.
    await withEnv({ ...configured, NEXT_PUBLIC_ADCASH_LIBRARY_URL: undefined }, async () => {
      assert.ok(await AdcashBanner({ placement: "home" }));
    });

    // 7. Malformed library URL → nothing.
    await withEnv({ ...configured, NEXT_PUBLIC_ADCASH_LIBRARY_URL: "https://evil.example/aclib.js" }, async () => {
      assert.equal(await AdcashBanner({ placement: "home" }), null);
    });

    // The gate is server-side: no client flag, cookie or prop can enable it.
    assert.ok(!/"use client"/.test(BANNER), "the gate must stay on the server");
    assert.match(code(BANNER), /await isAdFreeViewer\(\)/);
    assert.ok(
      !/localStorage|sessionStorage|document\.cookie|premium|isPro/.test(code(BANNER)),
      "no client-side membership state can influence the gate",
    );
    assert.ok(
      code(BANNER).indexOf("isNativeShellDocument()") <
        code(BANNER).indexOf("adcashBannerAllowed("),
      "the native gate must come before configuration",
    );
  },
);

// ── Placement and route policy ────────────────────────────────────────────

test("the route guard admits only the approved browsing routes", () => {
  assert.deepEqual(
    Object.entries(ADCASH_PLACEMENT_ROUTES).map(([placement, routes]) => [
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

  assert.equal(adcashRouteMatchesPlacement("/", "home"), true);
  assert.equal(adcashRouteMatchesPlacement("/profil/", "profile"), true);
  assert.equal(adcashRouteMatchesPlacement("/classement?tab=weekly", "leaderboard"), true);
  assert.equal(adcashRouteMatchesPlacement("/", "profile"), false);

  for (const never of [
    "/casino/solitaire-duel",
    "/casino/solitaire-duel/play-ai",
    "/games/solitaire-duel/play",
    "/casino/solitaire-duel/abc-match",
    "/profil/clerk_123",
    "/settings",
    "/solitaire",
  ]) {
    for (const placement of ADCASH_PLACEMENTS) {
      assert.equal(
        adcashRouteMatchesPlacement(never, placement),
        false,
        `${never} must never serve the ${placement} banner`,
      );
    }
  }
});

test("the provider now runs inside the unified slot, never as a second mount", () => {
  const direct = allPages().filter((page) => /<AdcashBanner\b/.test(read(page)));
  assert.deepEqual(direct, [], "pages mount BannerSlot, not an individual provider");

  const placements = {
    "src/app/page.jsx": "home",
    "src/app/classement/page.jsx": "leaderboard",
    "src/app/profil/page.jsx": "profile",
  };

  for (const [page, placement] of Object.entries(placements)) {
    const source = read(page);
    assert.equal(
      (source.match(/<BannerSlot\b/g) ?? []).length,
      1,
      `${page} must mount exactly one unified banner slot`,
    );
    assert.match(source, new RegExp(`<BannerSlot placement="${placement}" />`));
    assert.match(source, /bannerSlot=\{<BannerSlot placement="[a-z]+" \/>\}/);
  }

  for (const [page, client] of [
    ["src/app/page.jsx", "src/app/PageClient.jsx"],
    ["src/app/classement/page.jsx", "src/app/classement/PageClient.jsx"],
    ["src/app/profil/page.jsx", "src/app/profil/PageClient.jsx"],
  ]) {
    const source = read(client);
    assert.match(source, /bannerSlot = null/, `${client} must accept the slot`);
    assert.equal(
      (source.match(/\{bannerSlot\}/g) ?? []).length,
      1,
      `${client} must render the slot exactly once`,
    );
    assert.match(read(page), /bannerSlot=/);
  }

  const offenders = allPages().filter((page) => {
    if (!/<BannerSlot\b/.test(read(page))) return false;
    const route = page
      .replace(/^src\/app\//, "")
      .replace(/\/page\.(jsx?|tsx?)$/, "");
    const isDynamic = /\[[^\]]+\]/.test(route);
    const isGameplayDepth = route.startsWith("casino/") && route.split("/").length > 2;
    return isDynamic || isGameplayDepth || route.startsWith("play/");
  });
  assert.deepEqual(offenders, [], "no gameplay route may mount the banner");
  assert.ok(!/BannerSlot/.test(read("src/app/layout.tsx")), "never in the layout");
});

// ── CSP ───────────────────────────────────────────────────────────────────

test("the CSP names the Adcash library and creative hosts exactly", () => {
  assert.ok(CSP.includes('"https://acscdn.com"'), "the library host is named");
  assert.ok(CSP.includes('"https://adcash.com"'), "the canonical creative host is named");
  assert.ok(
    !CSP.includes("https://*.acscdn.com") && !CSP.includes("https://*.adcash.com"),
    "no provider wildcard: an unconfirmed CDN is an operator allowlist entry",
  );

  const frameSrc = buildFrameSrc({ env: {} });
  const hosts = frameSrc
    .replace(/^frame-src\s+/, "")
    .trim()
    .split(/\s+/);
  assert.ok(hosts.includes("https://acscdn.com"), "the library frame host is named");
  assert.ok(hosts.includes("https://adcash.com"), "the creative host is named");
  assert.ok(!hosts.includes("https://*.adcash.com"), "no provider wildcard");
  assert.ok(!hosts.includes("https:"), "frame-src stays an allow-list");
});

// ── Independence from the other providers ─────────────────────────────────

test("the integration does not touch HilltopAds, ExoClick or AdSense behaviour", () => {
  for (const file of [
    "src/lib/hilltop/config.ts",
    "src/components/ads/HilltopBanner.tsx",
    "src/components/ads/HilltopBannerUnit.tsx",
    "src/lib/exoclick/config.ts",
    "src/components/ads/ExoClickBanner.tsx",
    "src/components/ads/ExoClickBannerUnit.tsx",
    "src/lib/vast/config.ts",
  ]) {
    assert.ok(!/adcash/i.test(read(file)), `${file} must not learn about Adcash`);
  }

  assert.ok(!/HILLTOP|EXOCLICK|ADSENSE|POST_MATCH|Hilltop|ExoClick|AdSense/.test(code(CONFIG)));
  assert.ok(!/adsbygoogle|googlesyndication|magsrv/i.test(code(UNIT) + code(BANNER)));
});

// ── The reserved box follows the zone it landed on ────────────────────────

test("each issued Display zone reserves its real creative size", () => {
  // Measured from the zones themselves on 2026-11-27 (`banner.php?r=<zone>`
  // answered width/height): 12500178 is 300x250, 12500186 is 728x90. The pool
  // rotates between them, so one hard-coded per-placement size would clip one.
  assert.equal(ADCASH_ZONE_SIZES["12500178"], "300x250");
  assert.equal(ADCASH_ZONE_SIZES["12500186"], "728x90");

  assert.equal(adcashSizeForZone("12500178"), "300x250");
  assert.equal(adcashSizeForZone(" 12500186 "), "728x90");
  assert.equal(adcashSizeForZone("99999999"), null);
  assert.equal(adcashSizeForZone(null), null);

  assert.equal(adcashSizeMaxWidth("300x250"), 300);
  assert.equal(adcashSizeMaxWidth("728x90"), 728);
  assert.equal(ADCASH_RESERVED_HEIGHTS["300x250"], 250);
  assert.equal(ADCASH_RESERVED_HEIGHTS["728x90"], 90);
});

test("the banner container uses the selected zone's size, not the default", () => {
  assert.match(code(UNIT), /adcashSizeForZone\(zone\)/);
  assert.match(code(UNIT), /maxWidth: adcashSizeMaxWidth\(bannerSize\)/);
  assert.match(code(UNIT), /minHeight: ADCASH_RESERVED_HEIGHTS\[bannerSize\]/);
  // The hard-coded placement width/height must be gone from the style block.
  assert.ok(!/maxWidth: adcashContainerMaxWidth\(placement\)/.test(code(UNIT)));
  assert.ok(!/minHeight: adcashReservedHeight\(placement\)/.test(code(UNIT)));
});

test("the Adcash attempt deadline covers its two-stage loader", () => {
  // Real browser run on 2026-11-27: aclib.js -> banner.js -> banner.php -> the
  // creative image took ~5 s, so the generic 3.5 s attempt deadline cleared the
  // container before the fill. The loader must keep at least 6 s, still clamped
  // to the remaining chain budget.
  assert.match(code(RUNTIME), /ADCASH_MIN_ATTEMPT_MS = 6_000/);
  assert.match(code(RUNTIME), /adcashAttemptTimeoutMs\(context\.budgetMs\)/);
});
