/**
 * ExoClick banner — integration contract.
 *
 * The provider's loader is third-party code, so the promises that keep it
 * harmless are pinned here:
 *
 *   1. nothing loads until a real zone id AND the provider-generated `<ins>`
 *      class token are configured (never invented);
 *   2. configuration validates and fails closed;
 *   3. the provider is disabled by default and independent of Hilltop/AdSense;
 *   4. the tag is injected once per document, inside a GRYND-owned container;
 *   5. consent, native-app, entitlement and route gates are all enforced;
 *   6. no-fill and script failure collapse quietly, with no placeholder;
 *   7. the document's CSP names the provider's hosts.
 *
 * Run: npm run test:exoclick
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join, relative, sep } from "node:path";
import { mock } from "node:test";

import {
  EXOCLICK_AD_PROVIDER_URL,
  EXOCLICK_PLACEMENT_ROUTES,
  EXOCLICK_PLACEMENTS,
  EXOCLICK_READY_TIMEOUT_MS,
  EXOCLICK_RESERVED_HEIGHTS,
  exoclickBannerAllowed,
  exoclickBannerConfigured,
  exoclickBannerEnabled,
  exoclickBannerEnabledOnServer,
  exoclickBannerScriptUrl,
  exoclickBannerSize,
  exoclickBannerVisibleToViewer,
  exoclickConsentSatisfied,
  exoclickInsClass,
  exoclickRequiresConsent,
  exoclickReservedHeight,
  exoclickRouteMatchesPlacement,
  exoclickZoneId,
  isExoclickPlacement,
  isExoclickProviderHost,
  normalizeExoclickScriptUrl,
  shouldInjectExoclickScript,
} from "../src/lib/exoclick/config.ts";
import { buildFrameSrc } from "../src/lib/security/csp.ts";

const read = (path) => fs.readFileSync(path, "utf8");
/** Assertions test CODE, not the prose that explains it. */
const code = (source) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

const CONFIG = read("src/lib/exoclick/config.ts");
const BANNER = read("src/components/ads/ExoClickBanner.tsx");
const UNIT = read("src/components/ads/ExoClickBannerUnit.tsx");
const CSP = read("src/lib/security/csp.ts");
const PROXY = read("src/proxy.ts");

const MODULE_MOCKING_AVAILABLE = typeof mock?.module === "function";
const SKIP_REASON = MODULE_MOCKING_AVAILABLE
  ? false
  : "module mocking is off — run: npm run test:exoclick";

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

test("the provider is disabled by default and reads only its own flags", async () => {
  await withEnv(
    {
      NEXT_PUBLIC_EXOCLICK_ENABLED: undefined,
      EXOCLICK_ENABLED: undefined,
      NEXT_PUBLIC_EXOCLICK_INS_CLASS: undefined,
      NEXT_PUBLIC_EXOCLICK_ZONE_HOME: undefined,
    },
    () => {
      assert.equal(exoclickBannerEnabled(), false, "build-time default is OFF");
      assert.equal(exoclickBannerEnabledOnServer(), false, "runtime default is OFF");
      assert.equal(exoclickZoneId("home"), null, "no zone id is ever defaulted");
      assert.equal(exoclickInsClass("home"), null, "no class token is ever defaulted");
      assert.equal(
        exoclickBannerConfigured("home"),
        false,
        "unconfigured means nothing renders",
      );
    },
  );

  for (const value of ["false", "0", "no", "", " ", "TRUEE"]) {
    await withEnv({ NEXT_PUBLIC_EXOCLICK_ENABLED: value }, () => {
      assert.equal(exoclickBannerEnabled(), false, `"${value}" must not enable it`);
    });
  }
  await withEnv({ NEXT_PUBLIC_EXOCLICK_ENABLED: "TRUE " }, () => {
    assert.equal(exoclickBannerEnabled(), true, "case/whitespace insensitive");
    assert.equal(exoclickBannerEnabledOnServer(), false, "the server switch is separate");
  });
  await withEnv({ EXOCLICK_ENABLED: "1" }, () => {
    assert.equal(exoclickBannerEnabledOnServer(), true, '"1" is a valid opt-in');
  });

  // Independence: no other provider's values or flags are read here.
  assert.ok(
    !/HILLTOP|ADSENSE|POST_MATCH|Hilltop|AdSense/.test(code(CONFIG)),
    "the ExoClick module must not read another provider's configuration",
  );
});

test("the loader URL is validated, and an invalid override fails closed", () => {
  assert.equal(normalizeExoclickScriptUrl(EXOCLICK_AD_PROVIDER_URL), EXOCLICK_AD_PROVIDER_URL);
  assert.equal(
    normalizeExoclickScriptUrl("//a.magsrv.com/ad-provider.js"),
    "https://a.magsrv.com/ad-provider.js",
    "a protocol-relative dashboard value is upgraded to https",
  );

  for (const bad of [
    "http://a.magsrv.com/ad-provider.js",
    "https://evil.example/ad-provider.js",
    "https://user:pass@a.magsrv.com/ad-provider.js",
    "javascript:alert(1)",
    "not-a-url",
    "",
    null,
    "https://a.magsrv.com/" + "a".repeat(2100),
  ]) {
    assert.equal(normalizeExoclickScriptUrl(bad), null, `${bad} must be refused`);
  }

  assert.equal(
    isExoclickProviderHost("a.magsrv.com") && isExoclickProviderHost("cdn.exoclick.com"),
    true,
  );
  assert.equal(isExoclickProviderHost("magsrv.com.evil.example"), false);
});

test("an override is used only when valid; otherwise nothing is configured", async () => {
  await withEnv({ NEXT_PUBLIC_EXOCLICK_SCRIPT_URL: "https://evil.example/tag.js" }, () => {
    assert.equal(exoclickBannerScriptUrl(), null, "a bad override renders nothing");
  });
  await withEnv({ NEXT_PUBLIC_EXOCLICK_SCRIPT_URL: "" }, () => {
    assert.equal(exoclickBannerScriptUrl(), EXOCLICK_AD_PROVIDER_URL);
  });
});

test("zone ids are numeric and per placement; no id is ever invented", async () => {
  await withEnv({ NEXT_PUBLIC_EXOCLICK_ZONE_HOME: "1234567" }, () => {
    assert.equal(exoclickZoneId("home"), "1234567");
    assert.equal(exoclickZoneId("profile"), null, "another placement cannot borrow it");
  });
  for (const bad of ["", "abc", "12ab", "-1", "  "]) {
    await withEnv({ NEXT_PUBLIC_EXOCLICK_ZONE_HOME: bad }, () => {
      assert.equal(exoclickZoneId("home"), null, `"${bad}" is not a zone id`);
    });
  }
  assert.equal(exoclickZoneId("match"), null);
});

test("the provider-generated <ins> class token is required and validated", async () => {
  for (const good of ["eas6a97888e", "eas6a97888e2", "adsbyexoclick"]) {
    await withEnv({ NEXT_PUBLIC_EXOCLICK_INS_CLASS: good }, () => {
      assert.equal(exoclickInsClass("home"), good);
    });
  }
  for (const bad of ["", "   ", "<script>", "a", "ads by exoclick"]) {
    await withEnv({ NEXT_PUBLIC_EXOCLICK_INS_CLASS: bad }, () => {
      assert.equal(exoclickInsClass("home"), null, `"${bad}" must be refused`);
    });
  }

  // A per-placement token wins over the shared one.
  await withEnv(
    {
      NEXT_PUBLIC_EXOCLICK_INS_CLASS: "sharedclass",
      NEXT_PUBLIC_EXOCLICK_INS_CLASS_PROFILE: "profileclass",
    },
    () => {
      assert.equal(exoclickInsClass("profile"), "profileclass");
      assert.equal(exoclickInsClass("home"), "sharedclass");
    },
  );
});

test("banner sizes resolve to a bounded reserved area", async () => {
  assert.equal(exoclickBannerSize("home"), "300x250");
  assert.equal(exoclickReservedHeight("home"), EXOCLICK_RESERVED_HEIGHTS["300x250"]);

  await withEnv({ NEXT_PUBLIC_EXOCLICK_BANNER_SIZE_HOME: "728x90" }, () => {
    assert.equal(exoclickBannerSize("home"), "728x90");
    assert.equal(exoclickReservedHeight("home"), 90);
  });
  await withEnv({ NEXT_PUBLIC_EXOCLICK_BANNER_SIZE_HOME: "999x999" }, () => {
    assert.equal(exoclickBannerSize("home"), "300x250", "an unknown size cannot widen it");
  });
});

test("configuration requires placement, URL, zone and class together", async () => {
  await withEnv(
    {
      NEXT_PUBLIC_EXOCLICK_INS_CLASS: "eas6a97888e",
      NEXT_PUBLIC_EXOCLICK_ZONE_HOME: "1234567",
      NEXT_PUBLIC_EXOCLICK_SCRIPT_URL: undefined,
    },
    () => {
      assert.equal(exoclickBannerConfigured("home"), true);
      assert.equal(exoclickBannerConfigured("profile"), false, "missing its own zone");
      assert.equal(exoclickBannerConfigured("match"), false);
    },
  );

  await withEnv({ NEXT_PUBLIC_EXOCLICK_INS_CLASS: undefined }, () => {
    assert.equal(exoclickBannerConfigured("home"), false, "no class → nothing");
  });
});

// ── Gates ─────────────────────────────────────────────────────────────────

test("only approved browsing placements are accepted", () => {
  assert.deepEqual([...EXOCLICK_PLACEMENTS], ["home", "hub", "leaderboard", "profile"]);
  assert.equal(isExoclickPlacement("hub"), true);
  assert.equal(isExoclickPlacement("guides"), false);
  assert.equal(isExoclickPlacement("match"), false);
  assert.equal(isExoclickPlacement(42), false);

  assert.equal(
    exoclickBannerAllowed({ enabled: false, configured: true, placement: "home" }),
    false,
  );
  assert.equal(
    exoclickBannerAllowed({ enabled: true, configured: false, placement: "home" }),
    false,
  );
  assert.equal(
    exoclickBannerAllowed({ enabled: true, configured: true, placement: "match" }),
    false,
    "an unapproved placement never renders",
  );
  assert.equal(
    exoclickBannerAllowed({ enabled: true, configured: true, placement: "home" }),
    true,
  );

  assert.equal(exoclickBannerVisibleToViewer({ allowed: true, adFree: true }), false);
  assert.equal(exoclickBannerVisibleToViewer({ allowed: true, adFree: false }), true);
  assert.equal(exoclickBannerVisibleToViewer({ allowed: false, adFree: false }), false);
});

test("consent is required by default and fails closed", async () => {
  assert.equal(exoclickRequiresConsent(), true, "no env means consent is required");
  assert.equal(exoclickConsentSatisfied("accepted"), true);
  assert.equal(exoclickConsentSatisfied("declined"), false);
  assert.equal(exoclickConsentSatisfied(null), false, "undecided is not consent");
  assert.equal(exoclickConsentSatisfied(undefined), false);

  await withEnv({ NEXT_PUBLIC_EXOCLICK_REQUIRES_CONSENT: "false" }, () => {
    assert.equal(exoclickRequiresConsent(), false, "explicit opt-out only");
  });
});

test("the provider script is injected at most once per document", () => {
  assert.equal(shouldInjectExoclickScript(null, "https://a.magsrv.com/ad-provider.js"), true);
  assert.equal(
    shouldInjectExoclickScript("https://a.magsrv.com/ad-provider.js", "https://a.magsrv.com/ad-provider.js"),
    false,
    "an existing loader is reused, never duplicated",
  );
  assert.equal(shouldInjectExoclickScript(null, null), false, "no URL means no injection");
});

test("the client unit injects once, inside its own container, and cleans up", () => {
  const source = code(UNIT);

  assert.equal(
    (source.match(/document\.createElement\("script"\)/g) ?? []).length,
    1,
    "exactly one loader element is ever created",
  );
  assert.equal(
    (source.match(/document\.createElement\("ins"\)/g) ?? []).length,
    1,
    "exactly one <ins> element is ever created",
  );
  assert.equal(
    (source.match(/document\.head\.appendChild\(script\)/g) ?? []).length,
    1,
    "the loader is appended once, not once per render",
  );
  assert.match(source, /shouldInjectExoclickScript\(/);
  assert.match(source, /host\.appendChild\(ins\)/, "the <ins> lives in our container");
  assert.match(source, /setAttribute\("data-zoneid", zone\)/);
  assert.match(source, /ins\.className = insClass/);
  assert.match(source, /AdProvider\.push\(\{ serve: \{\} \}\)/, "the documented serve call");

  // No DOM-level injection, no overlay, no navigation.
  for (const forbidden of [
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

  // Route, consent and failure handling.
  assert.match(source, /exoclickRouteMatchesPlacement\(window\.location\.pathname, placement\)/);
  assert.match(source, /isMatchHref\(/);
  assert.match(source, /exoclickConsentSatisfied\(consent\)/);
  assert.match(source, /COOKIE_CONSENT_EVENT/);
  assert.match(source, /new MutationObserver/);
  assert.match(source, /script\.addEventListener\("error", fail/);
  assert.match(source, /securitypolicyviolation/);
  assert.match(source, /EXOCLICK_READY_TIMEOUT_MS/);
  assert.match(source, /setPhase\("unavailable"\)/);
  assert.match(source, /window\.clearTimeout\(timer\)/);
  assert.match(source, /observer\?\.disconnect\(\)/);
  assert.ok(!/setInterval/.test(source), "no retry loop");
  assert.ok(
    !/placeholder|sample\.mp4|stock/i.test(source),
    "a failed tag is never replaced with invented content",
  );
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

    const { default: ExoClickBanner } = await import(
      "../src/components/ads/ExoClickBanner.tsx"
    );

    const configured = {
      NEXT_PUBLIC_EXOCLICK_ENABLED: "true",
      EXOCLICK_ENABLED: "true",
      NEXT_PUBLIC_EXOCLICK_INS_CLASS: "eas6a97888e",
      NEXT_PUBLIC_EXOCLICK_ZONE_HOME: "1234567",
      NEXT_PUBLIC_EXOCLICK_ZONE_PROFILE: "7654321",
    };

    // 1. Configured + free viewer + web → the container and the unit.
    await withEnv({ ...configured }, async () => {
      const banner = await ExoClickBanner({ placement: "home" });
      assert.ok(banner, "a configured banner must render");
      assert.equal(banner.props["data-exoclick-placement"], "home");
      assert.equal(banner.props["aria-label"], "Advertisement");
      assert.equal(banner.props.children.props.placement, "home");

      // 3. Unconfigured placement → nothing, even when other placements are set.
      assert.equal(
        await ExoClickBanner({ placement: "leaderboard" }),
        null,
        "a placement without its own zone renders nothing",
      );

      // An unapproved placement cannot be forced in.
      assert.equal(await ExoClickBanner({ placement: "match" }), null);

      // 2. GRYND PRO member → nothing at all.
      world.adFree = true;
      assert.equal(await ExoClickBanner({ placement: "home" }), null);
      world.adFree = false;

      // 4. Native app → nothing, before configuration is even considered.
      world.native = true;
      assert.equal(await ExoClickBanner({ placement: "home" }), null);
      world.native = false;
    });

    // 2b. Disabled provider → nothing.
    await withEnv({ ...configured, EXOCLICK_ENABLED: undefined }, async () => {
      assert.equal(await ExoClickBanner({ placement: "home" }), null);
    });
    await withEnv({ ...configured, NEXT_PUBLIC_EXOCLICK_ENABLED: undefined }, async () => {
      assert.equal(await ExoClickBanner({ placement: "home" }), null);
    });

    // 2c. Missing zone → nothing.
    await withEnv({ ...configured, NEXT_PUBLIC_EXOCLICK_ZONE_HOME: undefined }, async () => {
      assert.equal(await ExoClickBanner({ placement: "home" }), null);
    });

    // 2d. Missing provider class token → nothing.
    await withEnv({ ...configured, NEXT_PUBLIC_EXOCLICK_INS_CLASS: undefined }, async () => {
      assert.equal(await ExoClickBanner({ placement: "home" }), null);
    });

    // 2e. Malformed loader override → nothing.
    await withEnv({ ...configured, NEXT_PUBLIC_EXOCLICK_SCRIPT_URL: "https://evil.example/x.js" }, async () => {
      assert.equal(await ExoClickBanner({ placement: "home" }), null);
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
        code(BANNER).indexOf("exoclickBannerAllowed("),
      "the native gate must come before configuration",
    );
  },
);

// ── Placement and route policy ────────────────────────────────────────────

test("the route guard admits only the approved browsing routes", () => {
  assert.deepEqual(
    Object.entries(EXOCLICK_PLACEMENT_ROUTES).map(([placement, routes]) => [
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

  assert.equal(exoclickRouteMatchesPlacement("/", "home"), true);
  assert.equal(exoclickRouteMatchesPlacement("/profil/", "profile"), true);
  assert.equal(exoclickRouteMatchesPlacement("/classement?tab=weekly", "leaderboard"), true);
  assert.equal(exoclickRouteMatchesPlacement("/", "profile"), false);

  for (const never of [
    "/casino/solitaire-duel",
    "/casino/solitaire-duel/play-ai",
    "/games/solitaire-duel/play",
    "/casino/solitaire-duel/abc-match",
    "/profil/clerk_123",
    "/settings",
    "/solitaire",
  ]) {
    for (const placement of EXOCLICK_PLACEMENTS) {
      assert.equal(
        exoclickRouteMatchesPlacement(never, placement),
        false,
        `${never} must never serve the ${placement} banner`,
      );
    }
  }
});

test("the provider now runs inside the unified slot, never as a second mount", () => {
  // ExoClick is part of the banner chain. A page that also mounted its own
  // ExoClickBanner would compete for the same space and could double-fill.
  const direct = allPages().filter((page) => /<ExoClickBanner\b/.test(read(page)));
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

test("the CSP names the provider's exact loader host, with no wildcard", () => {
  assert.ok(CSP.includes('"https://a.magsrv.com"'), "the loader host is named");
  assert.ok(
    !CSP.includes("https://*.magsrv.com"),
    "no provider wildcard: an unconfirmed creative host is an operator allowlist entry",
  );

  const frameSrc = buildFrameSrc({ env: {} });
  const hosts = frameSrc
    .replace(/^frame-src\s+/, "")
    .trim()
    .split(/\s+/);
  assert.ok(hosts.includes("https://a.magsrv.com"), "the banner frame host is named");
  assert.ok(!hosts.includes("https://*.magsrv.com"), "no provider wildcard");
  assert.ok(!hosts.includes("https:"), "frame-src stays an allow-list");
});

// ── Independence from the other providers ─────────────────────────────────

test("the integration does not touch HilltopAds or AdSense behaviour", () => {
  for (const file of [
    "src/lib/hilltop/config.ts",
    "src/components/ads/HilltopBanner.tsx",
    "src/components/ads/HilltopBannerUnit.tsx",
    "src/lib/vast/config.ts",
  ]) {
    assert.ok(
      !/exoclick/i.test(read(file)),
      `${file} must not learn about ExoClick`,
    );
  }

  assert.ok(!/HILLTOP|ADSENSE|Hilltop|AdSense/.test(code(CONFIG)));
  assert.ok(!/adsbygoogle|googlesyndication/.test(code(UNIT) + code(BANNER)));
});
