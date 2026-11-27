/**
 * Advertising consent, UX and policy contract.
 *
 * These are the release-readiness promises that are not provider-specific:
 * no advertising request before consent, no intrusive formats, no ads during
 * gameplay, no ads for PRO, no ads in the native shell, and no result-screen
 * dead end when every provider no-fills.
 *
 * Run: npm run test:ad-compliance
 */

import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  hilltopBannerRequiresConsent,
  hilltopConsentSatisfied,
} from "../src/lib/hilltop/config.ts";
import {
  postMatchAdsRequireConsent,
  postMatchConsentSatisfied,
} from "../src/lib/vast/config.ts";
import {
  adcashConsentSatisfied,
  adcashRequiresConsent,
} from "../src/lib/adcash/config.ts";
import {
  exoclickConsentSatisfied,
  exoclickRequiresConsent,
} from "../src/lib/exoclick/config.ts";
import { bannerSurfaceAllowed } from "../src/lib/ads/banners/gates.ts";
import { bannerRouteMatchesPlacement } from "../src/lib/ads/core/types.ts";
import { isNativeShellUserAgent } from "../src/lib/native/shell.ts";

const read = (path) => fs.readFileSync(path, "utf8");
/** Assertions test CODE, not the prose that explains it. */
const code = (source) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

const CLIENT = read("src/components/ads/BannerSlotClient.tsx");
const BANNER = read("src/components/ads/BannerSlot.tsx");
const HILLTOP = read("src/components/ads/HilltopBannerUnit.tsx");
const EXOCLICK = read("src/components/ads/ExoClickBannerUnit.tsx");
const ADCASH = read("src/components/ads/AdcashBannerUnit.tsx");
const PLAYER = read("src/components/ads/PostMatchVideoAd.tsx");
const SLOT = read("src/components/ads/PostMatchAdSlot.tsx");

const AD_COMPONENTS = {
  "BannerSlotClient.tsx": CLIENT,
  "HilltopBannerUnit.tsx": HILLTOP,
  "ExoClickBannerUnit.tsx": EXOCLICK,
  "AdcashBannerUnit.tsx": ADCASH,
  "PostMatchVideoAd.tsx": PLAYER,
  "PostMatchAdSlot.tsx": SLOT,
};

const withEnv = (vars, fn) => {
  const previous = new Map();
  for (const [key, value] of Object.entries(vars)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

afterEach(() => {
  delete process.env.NEXT_PUBLIC_HILLTOP_BANNER_REQUIRES_CONSENT;
  delete process.env.NEXT_PUBLIC_POST_MATCH_ADS_REQUIRES_CONSENT;
});

test("all three banner providers are consent-gated by default", () => {
  withEnv(
    {
      NEXT_PUBLIC_HILLTOP_BANNER_REQUIRES_CONSENT: undefined,
      NEXT_PUBLIC_EXOCLICK_REQUIRES_CONSENT: undefined,
      NEXT_PUBLIC_ADCASH_REQUIRES_CONSENT: undefined,
    },
    () => {
      assert.equal(hilltopBannerRequiresConsent(), true);
      assert.equal(exoclickRequiresConsent(), true);
      assert.equal(adcashRequiresConsent(), true);
    },
  );

  for (const satisfied of [
    hilltopConsentSatisfied,
    exoclickConsentSatisfied,
    adcashConsentSatisfied,
  ]) {
    assert.equal(satisfied(null), false);
    assert.equal(satisfied(undefined), false);
    assert.equal(satisfied("declined"), false);
    assert.equal(satisfied("accepted"), true);
  }
});

test("the Hilltop banner does not inject before consent", () => {
  const source = code(CLIENT);
  assert.match(source, /hilltopBannerRequiresConsent/);
  assert.match(source, /hilltopConsentSatisfied/);
  assert.match(source, /allowed\.length === 0/);
  assert.match(source, /if \(allowed\.length === 0\) return null;/);

  const unit = code(HILLTOP);
  assert.match(unit, /if \(!consentReady \|\| !consentOk\)/);
  assert.match(unit, /window\.addEventListener\(COOKIE_CONSENT_EVENT, apply\)/);
});

test("the post-match video requests nothing until consent resolves", () => {
  const source = code(PLAYER);
  assert.match(source, /postMatchAdsRequireConsent\(\)/);
  assert.match(source, /postMatchConsentSatisfied\(consent\)/);
  assert.match(source, /if \(!consentReady\) return;/);

  const consentGuard = source.indexOf("if (!consentReady) return;");
  const cadence = source.indexOf("observeCompletedMatch(matchId)");
  assert.ok(consentGuard >= 0, "the consent-ready guard is present");
  assert.ok(cadence > consentGuard, "the cadence is not advanced before consent resolves");

  assert.match(source, /const active =\s*enabled && !adFree && postMatchAdsEnabled\(\) && consentSatisfied/);
});

test("a provider exemption is explicit, never the default", () => {
  withEnv({ NEXT_PUBLIC_HILLTOP_BANNER_REQUIRES_CONSENT: "false" }, () => {
    assert.equal(hilltopBannerRequiresConsent(), false);
  });
  withEnv({ NEXT_PUBLIC_POST_MATCH_ADS_REQUIRES_CONSENT: "false" }, () => {
    assert.equal(postMatchAdsRequireConsent(), false);
  });

  assert.equal(postMatchAdsRequireConsent(), true);
  assert.equal(hilltopBannerRequiresConsent(), true);
});

test("no ad surface is mounted on gameplay, for PRO, or in the native shell", () => {
  assert.equal(bannerSurfaceAllowed({ native: true, placement: "home", providers: ["hilltop"], adFree: false }), false);
  assert.equal(bannerSurfaceAllowed({ native: false, placement: "home", providers: [], adFree: false }), false);
  assert.equal(bannerSurfaceAllowed({ native: false, placement: "home", providers: ["hilltop"], adFree: true }), false);
  assert.equal(bannerSurfaceAllowed({ native: false, placement: "match", providers: ["hilltop"], adFree: false }), false);
  assert.equal(bannerSurfaceAllowed({ native: false, placement: "home", providers: ["hilltop"], adFree: false }), true);

  for (const route of ["/", "/games", "/casino", "/classement", "/profil"]) {
    assert.ok(
      ["home", "hub", "leaderboard", "profile"].some((placement) =>
        bannerRouteMatchesPlacement(route, placement),
      ),
      `${route} is an approved browsing route`,
    );
  }
  for (const route of ["/games/solitaire-duel/play", "/match/123", "/profil/123", "/games/solitaire-duel"]) {
    assert.equal(
      ["home", "hub", "leaderboard", "profile"].some((placement) =>
        bannerRouteMatchesPlacement(route, placement),
      ),
      false,
      `${route} is gameplay, not a banner surface`,
    );
  }

  assert.equal(isNativeShellUserAgent("Mozilla/5.0 GRYNDApp/1.0"), true);
  assert.equal(isNativeShellUserAgent("Mozilla/5.0 Chrome/120"), false);

  assert.match(code(BANNER), /isNativeShellDocument\(\)/);
  assert.match(code(BANNER), /isAdFreeViewer\(\)/);
  assert.match(code(CLIENT), /isMatchHref\(/);
  assert.match(code(PLAYER), /matchEnded/);
});

test("no provider component can open a popup, navigate, push or float", () => {
  const forbidden = [
    /window\.open\s*\(/,
    /location\.(assign|replace)\s*\(/,
    /document\.location\s*=/,
    /requestFullscreen\s*\(/,
    /webkitRequestFullscreen\s*\(/,
    /Notification\s*\(/,
    /pushManager/,
    /serviceWorker\.register/,
    /allowfullscreen/i,
    /window\.focus\s*\(/,
  ];

  for (const [name, source] of Object.entries(AD_COMPONENTS)) {
    const body = code(source);
    for (const pattern of forbidden) {
      assert.doesNotMatch(body, pattern, `${name} contains ${pattern}`);
    }
  }

  // Banner surfaces must not be fixed/floating overlays. The post-match player
  // is intentionally a full-page overlay AFTER the match, so it is exempt.
  for (const name of [
    "BannerSlotClient.tsx",
    "HilltopBannerUnit.tsx",
    "ExoClickBannerUnit.tsx",
    "AdcashBannerUnit.tsx",
  ]) {
    assert.doesNotMatch(code(AD_COMPONENTS[name]), /fixed|sticky/, `${name} is not an overlay`);
  }
});

test("the post-match skip and dismissal behaviour is preserved", () => {
  const source = code(PLAYER);
  assert.match(source, /SKIP_AFTER_SECONDS = 15/);
  assert.match(source, /markPostMatchAdDismissed\(matchId\)/);
  assert.match(source, /onClick=\{dismiss\}/);
  assert.match(source, /onEnded=\{handleEnded\}/);
});

test("a total no-fill never strands the result screen", () => {
  const player = code(PLAYER);
  assert.match(player, /removeNow/);
  assert.match(player, /onNoOfferRef\.current\?\.\(\)/);
  assert.match(player, /if \(!result\.filled \|\| !ad\) \{\s*removeNow\(\);/);
  assert.doesNotMatch(player, /role="dialog"[\s\S]*?phase !== "ready"/);

  const slot = code(SLOT);
  assert.match(slot, /onNoOffer=\{\(\) => settle\(false\)\}/);
  assert.match(slot, /onDismiss=\{\(\) => settle\(true\)\}/);
});
