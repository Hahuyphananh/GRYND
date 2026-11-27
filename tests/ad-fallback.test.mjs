/**
 * Three-provider ad fallback — integration contract.
 *
 * One opportunity, one provider at a time, first fill wins. Everything here is
 * deterministic: the chain engine is exercised with fake attempts, so each
 * ordering/refusal case is a fact rather than a network coincidence.
 *
 * Run: npm run test:fallback
 */

import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join, relative, sep } from "node:path";

import {
  DEFAULT_AD_ORDER,
  bannerProviderOrder,
  eligibleProviders,
  parseProviderOrder,
  videoProviderOrder,
} from "../src/lib/ads/core/order.ts";
import { runAdChain } from "../src/lib/ads/core/chain.ts";
import {
  bannerOpportunityId,
  claimOpportunity,
  createOpportunityId,
  markMatchAdServed,
  markOpportunityServed,
  resetAdOpportunityState,
  videoOpportunityId,
  wasMatchAdServed,
  wasOpportunityServed,
} from "../src/lib/ads/core/opportunity.ts";
import {
  buildAdEvent,
  outcomeMetric,
} from "../src/lib/ads/core/report.ts";
import {
  bannerRouteMatchesPlacement,
  isBannerPlacement,
} from "../src/lib/ads/core/types.ts";
import {
  bannerChainBudgetMs,
  bannerProviderTimeoutMs,
  videoChainBudgetMs,
} from "../src/lib/ads/banners/limits.ts";
import { eligibleBannerProviders } from "../src/lib/ads/banners/eligibility.ts";
import { bannerSurfaceAllowed } from "../src/lib/ads/banners/gates.ts";
import { resetBannerRuntimeState } from "../src/lib/ads/banners/runtime.ts";
import {
  videoFailureOutcome,
  videoProviderChain,
} from "../src/lib/vast/providers/chain.ts";

const read = (path) => fs.readFileSync(path, "utf8");
const SLOT = read("src/components/ads/BannerSlot.tsx");
const CLIENT = read("src/components/ads/BannerSlotClient.tsx");
const RUNTIME = read("src/lib/ads/banners/runtime.ts");
const PLAYER = read("src/components/ads/PostMatchVideoAd.tsx");
const PROVIDERS = read("src/lib/vast/providers/index.ts");

/** Every page file under src/app, repo-relative POSIX. */
function allPages(dir = "src/app") {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...allPages(full));
    else if (/^page\.(jsx?|tsx?)$/.test(entry.name))
      found.push(relative(process.cwd(), full).split(sep).join("/"));
  }
  return found;
}

afterEach(() => {
  resetAdOpportunityState();
  resetBannerRuntimeState();
});

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

const ALL = ["hilltop", "exoclick", "adcash", "adexchange"];

/** A provider that reports `status`; records every attempt in order. */
function responder(statuses, calls = []) {
  return async (provider) => {
    calls.push(provider);
    return {
      provider,
      status: statuses[provider] ?? "no_fill",
      verifiedImpression: false,
      reason: statuses[provider] === "filled" ? "creative-present" : "test",
    };
  };
}

function opportunity(id = createOpportunityId("banner", "home")) {
  return { id, kind: "banner", placement: "home" };
}

// ── Configuration ─────────────────────────────────────────────────────────

test("provider priority is environment-configured, deduplicated and closed", async () => {
  assert.deepEqual([...DEFAULT_AD_ORDER], ALL);
  assert.deepEqual(parseProviderOrder(undefined), ALL);
  assert.deepEqual(parseProviderOrder(""), ALL);
  assert.deepEqual(parseProviderOrder("adcash, exoclick , hilltop"), [
    "adcash",
    "exoclick",
    "hilltop",
  ]);
  assert.deepEqual(parseProviderOrder("adcash,adcash,invalid,exoclick"), [
    "adcash",
    "exoclick",
  ]);
  assert.deepEqual(parseProviderOrder("invalid"), ALL, "an unusable list falls back");

  await withEnv(
    {
      NEXT_PUBLIC_ADS_BANNER_ORDER: "adcash,exoclick,hilltop",
      NEXT_PUBLIC_ADS_VIDEO_ORDER: "exoclick,adcash",
    },
    () => {
      assert.deepEqual(bannerProviderOrder(), ["adcash", "exoclick", "hilltop"]);
      assert.deepEqual(videoProviderOrder(), ["exoclick", "adcash"]);
    },
  );

  // Eligibility filters the configured priority instead of rewriting it.
  assert.deepEqual(
    eligibleProviders(["adcash", "exoclick", "hilltop"], (id) => id !== "exoclick"),
    ["adcash", "hilltop"],
  );
});

test("waits are bounded and clamped", async () => {
  assert.ok(bannerChainBudgetMs() >= 2_000 && bannerChainBudgetMs() <= 15_000);
  assert.ok(
    bannerProviderTimeoutMs() >= 1_500 && bannerProviderTimeoutMs() <= 8_000,
  );
  assert.ok(videoChainBudgetMs() >= 2_000 && videoChainBudgetMs() <= 12_000);

  await withEnv(
    {
      NEXT_PUBLIC_ADS_BANNER_BUDGET_MS: "999999",
      NEXT_PUBLIC_ADS_BANNER_PROVIDER_TIMEOUT_MS: "1",
      NEXT_PUBLIC_ADS_VIDEO_BUDGET_MS: "999999",
    },
    () => {
      assert.equal(bannerChainBudgetMs(), 15_000);
      assert.equal(bannerProviderTimeoutMs(), 1_500);
      assert.equal(videoChainBudgetMs(), 12_000);
    },
  );
});

// ── Fill and fallback, in order ───────────────────────────────────────────

test("Hilltop fills first and no later provider is tried", async () => {
  const calls = [];
  const result = await runAdChain({
    opportunity: opportunity("fill-hilltop"),
    order: ALL,
    attempt: responder({ hilltop: "filled" }, calls),
  });

  assert.equal(result.filled, true);
  assert.equal(result.outcome.provider, "hilltop");
  assert.deepEqual(calls, ["hilltop"]);
  assert.deepEqual(result.attempted, ["hilltop"]);
});

test("ExoClick fills first when configured first", async () => {
  const calls = [];
  const result = await runAdChain({
    opportunity: opportunity("exo-first"),
    order: ["exoclick", "hilltop", "adcash"],
    attempt: responder({ exoclick: "filled" }, calls),
  });

  assert.equal(result.outcome.provider, "exoclick");
  assert.deepEqual(calls, ["exoclick"]);
});

test("Adcash fills first when configured first", async () => {
  const calls = [];
  const result = await runAdChain({
    opportunity: opportunity("adcash-first"),
    order: ["adcash", "hilltop", "exoclick"],
    attempt: responder({ adcash: "filled" }, calls),
  });

  assert.equal(result.outcome.provider, "adcash");
  assert.deepEqual(calls, ["adcash"]);
});

test("ExoClick fills after a Hilltop no-fill", async () => {
  const calls = [];
  const result = await runAdChain({
    opportunity: opportunity("fill-exo"),
    order: ALL,
    attempt: responder({ hilltop: "no_fill", exoclick: "filled" }, calls),
  });

  assert.equal(result.filled, true);
  assert.equal(result.outcome.provider, "exoclick");
  assert.deepEqual(calls, ["hilltop", "exoclick"], "sequential, in priority order");
});

test("Adcash fills after Hilltop and ExoClick both no-fill", async () => {
  const calls = [];
  const result = await runAdChain({
    opportunity: opportunity("fill-adcash"),
    order: ALL,
    attempt: responder(
      { hilltop: "no_fill", exoclick: "no_fill", adcash: "filled" },
      calls,
    ),
  });

  assert.equal(result.filled, true);
  assert.equal(result.outcome.provider, "adcash");
  assert.deepEqual(calls, ["hilltop", "exoclick", "adcash"], "the fill ends the chain");
});

test("all providers no-fill yields no ad and no impression", async () => {
  const calls = [];
  const report = [];
  const result = await runAdChain({
    opportunity: opportunity("all-empty"),
    order: ALL,
    attempt: responder({}, calls),
    onOutcome: (outcome) => report.push(outcome.status),
  });

  assert.equal(result.filled, false);
  assert.equal(result.outcome.status, "no_fill");
  assert.deepEqual(calls, ALL);
  assert.ok(report.every((status) => status !== "filled"));
  assert.equal(wasOpportunityServed("all-empty"), false);
});

test("a timeout falls through to the next provider", async () => {
  const calls = [];
  const result = await runAdChain({
    opportunity: opportunity("timeout"),
    order: ALL,
    attempt: responder({ hilltop: "timeout", exoclick: "filled" }, calls),
  });

  assert.equal(result.filled, true);
  assert.equal(result.outcome.provider, "exoclick");
  assert.deepEqual(calls, ["hilltop", "exoclick"]);
});

test("a disabled provider is skipped by eligibility, not treated as fill", async () => {
  const order = eligibleProviders(ALL, (id) => id !== "exoclick");
  const calls = [];
  const result = await runAdChain({
    opportunity: opportunity("disabled"),
    order,
    attempt: responder({ hilltop: "no_fill", adcash: "filled" }, calls),
  });

  assert.deepEqual(order, ["hilltop", "adcash", "adexchange"]);
  assert.deepEqual(calls, ["hilltop", "adcash"]);
  assert.equal(result.outcome.provider, "adcash");
});

test("the chain stops when its total budget is exhausted", async () => {
  const calls = [];
  let clock = 0;
  const result = await runAdChain({
    opportunity: opportunity("budget"),
    order: ALL,
    totalBudgetMs: 700,
    now: () => clock,
    attempt: async (provider) => {
      calls.push(provider);
      clock += 300;
      return { provider, status: "timeout", verifiedImpression: false };
    },
  });

  assert.deepEqual(calls, ["hilltop", "exoclick"], "the last provider gets no time");
  assert.equal(result.filled, false);
});

test("an aborted chain stops without trying the next provider", async () => {
  const calls = [];
  const controller = new AbortController();
  const result = await runAdChain({
    opportunity: opportunity("abort"),
    order: ALL,
    signal: controller.signal,
    attempt: async (provider) => {
      calls.push(provider);
      controller.abort();
      return { provider, status: "timeout", verifiedImpression: false };
    },
  });

  assert.deepEqual(calls, ["hilltop"]);
  assert.equal(result.filled, false);
});

// ── Deduplication ─────────────────────────────────────────────────────────

test("one opportunity is claimed once; the same owner may re-enter", () => {
  const id = bannerOpportunityId("home");
  assert.equal(claimOpportunity(id, "owner-a"), true);
  assert.equal(claimOpportunity(id, "owner-b"), false, "a second mount is refused");
  assert.equal(
    claimOpportunity(id, "owner-a"),
    true,
    "React's double-effect re-enters under the same owner",
  );
  assert.equal(bannerOpportunityId("home"), id, "stable for this document");
  assert.notEqual(bannerOpportunityId("profile"), id);
});

test("a served opportunity refuses fallback and a second fill", async () => {
  const id = "video:match-123";
  markOpportunityServed(id);

  const calls = [];
  const result = await runAdChain({
    opportunity: { id, kind: "video", placement: "post-match" },
    order: ALL,
    attempt: responder({ hilltop: "filled" }, calls),
  });

  assert.equal(result.alreadyServed, true);
  assert.deepEqual(calls, [], "no provider may be asked after a serve");
});

test("a filled chain cannot be re-run for the same opportunity", async () => {
  const id = "banner:test:served";
  const first = await runAdChain({
    opportunity: { id, kind: "banner", placement: "home" },
    order: ALL,
    attempt: responder({ hilltop: "filled" }),
  });
  assert.equal(first.filled, true);

  const calls = [];
  const second = await runAdChain({
    opportunity: { id, kind: "banner", placement: "home" },
    order: ALL,
    attempt: responder({ exoclick: "filled" }, calls),
  });

  assert.equal(second.alreadyServed, true);
  assert.deepEqual(calls, []);
});

test("a served match survives a refresh in the same tab", () => {
  const store = new Map();
  globalThis.window = {
    sessionStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
    },
  };

  try {
    assert.equal(wasMatchAdServed("match-1"), false);
    markMatchAdServed("match-1");
    assert.equal(wasMatchAdServed("match-1"), true);
    assert.equal(wasMatchAdServed("match-2"), false);
    assert.equal(videoOpportunityId("match-1"), "video:match-1");
  } finally {
    delete globalThis.window;
  }
});

// ── Entitlement, native and gameplay gates ────────────────────────────────

test("the banner slot is server-gated on membership and native shell", () => {
  assert.match(SLOT, /const native = await isNativeShellDocument\(\);/);
  assert.match(SLOT, /await isAdFreeViewer\(\)/);
  assert.match(SLOT, /bannerSurfaceAllowed\(/);
  assert.match(SLOT, /eligibleBannerProviders\(placement\)/);
  assert.doesNotMatch(SLOT, /"use client"/, "the authoritative gates stay on the server");
});

test("ad-free, native and misplaced surfaces render no banner", () => {
  const base = {
    native: false,
    placement: "home",
    providers: ["hilltop"],
    adFree: false,
  };

  assert.equal(bannerSurfaceAllowed(base), true);
  assert.equal(bannerSurfaceAllowed({ ...base, adFree: true }), false, "GRYND PRO");
  assert.equal(bannerSurfaceAllowed({ ...base, native: true }), false, "native shell");
  assert.equal(bannerSurfaceAllowed({ ...base, placement: "match" }), false);
  assert.equal(bannerSurfaceAllowed({ ...base, providers: [] }), false, "nothing configured");
});

test("the client refuses a gameplay URL even if it were mounted there", () => {
  assert.match(CLIENT, /isMatchHref\(/);
  assert.match(CLIENT, /bannerRouteMatchesPlacement\(/);
  assert.equal(bannerRouteMatchesPlacement("/casino/solitaire-duel/abc", "home"), false);
  assert.equal(bannerRouteMatchesPlacement("/play/ai", "home"), false);
  assert.equal(bannerRouteMatchesPlacement("/", "home"), true);
  assert.equal(isBannerPlacement("match"), false);
});

test("no gameplay page carries the unified slot", () => {
  const offenders = allPages().filter((page) => {
    if (!/<BannerSlot\b/.test(read(page))) return false;
    const route = page
      .replace(/^src\/app\//, "")
      .replace(/\/page\.(jsx?|tsx?)$/, "");
    return (
      /\[[^\]]+\]/.test(route) ||
      (route.startsWith("casino/") && route.split("/").length > 2) ||
      route.startsWith("play/")
    );
  });
  assert.deepEqual(offenders, []);
});

test("banner eligibility is server-side and never invents a provider", async () => {
  await withEnv(
    {
      HILLTOP_BANNER_ENABLED: undefined,
      NEXT_PUBLIC_HILLTOP_BANNER_ENABLED: undefined,
      HILLTOP_BANNER_PROVIDER_ATTESTED: undefined,
      EXOCLICK_ENABLED: undefined,
      NEXT_PUBLIC_EXOCLICK_ENABLED: undefined,
      ADCASH_ENABLED: undefined,
      NEXT_PUBLIC_ADCASH_ENABLED: undefined,
      NEXT_PUBLIC_EXOCLICK_ZONE_HOME: undefined,
      NEXT_PUBLIC_ADCASH_ZONE_HOME: undefined,
      NEXT_PUBLIC_ADCASH_LIBRARY_URL: undefined,
    },
    () => {
      // Only the account-configured Adcash banner is eligible by default:
      // Hilltop still waits for its written attestation, ExoClick for a zone,
      // and Ad Exchange is video-only.
      assert.deepEqual(eligibleBannerProviders("home"), ["adcash"]);
      assert.deepEqual(eligibleBannerProviders("not-a-placement"), []);
    },
  );
});

// ── Video chain ───────────────────────────────────────────────────────────

test("video failure reasons map to distinct fallback outcomes", () => {
  assert.equal(videoFailureOutcome("hilltop", "no-ad").status, "no_fill");
  assert.equal(videoFailureOutcome("hilltop", "timeout").status, "timeout");
  assert.equal(videoFailureOutcome("hilltop", "network-error").status, "network_error");
  assert.equal(videoFailureOutcome("hilltop", "malformed").status, "invalid_response");
  assert.equal(videoFailureOutcome("hilltop", "wrapper-unsupported").status, "invalid_response");
  assert.equal(videoFailureOutcome("hilltop", "disabled").status, "provider_disabled");
  assert.equal(videoFailureOutcome("hilltop", "aborted").status, "blocked");
  for (const reason of ["no-ad", "timeout", "malformed", "disabled"]) {
    assert.equal(videoFailureOutcome("hilltop", reason).verifiedImpression, false);
  }
});

test("the video chain follows configuration and omits disabled providers", async () => {
  const clean = {
    NEXT_PUBLIC_POST_MATCH_ADS_ENABLED: undefined,
    NEXT_PUBLIC_HILLTOPS_ENABLED: undefined,
    NEXT_PUBLIC_HILLTOPS_VAST_URL: undefined,
    NEXT_PUBLIC_EXOCLICK_VAST_ENABLED: undefined,
    NEXT_PUBLIC_EXOCLICK_VAST_TAG: undefined,
    NEXT_PUBLIC_ADCASH_VAST_ENABLED: undefined,
    NEXT_PUBLIC_ADCASH_VAST_TAG: undefined,
    NEXT_PUBLIC_ADEXCHANGE_VAST_ENABLED: undefined,
    NEXT_PUBLIC_ADEXCHANGE_VAST_TAG: undefined,
    NEXT_PUBLIC_ADS_VIDEO_ORDER: undefined,
  };

  await withEnv(clean, () => {
    // Hilltop's approved tag and the account's Ad Exchange tag are both built
    // in, so both are eligible by default; ExoClick and Adcash wait for a
    // dashboard tag.
    assert.deepEqual(
      videoProviderChain(),
      ["hilltop", "adexchange"],
      "the built-in tags are the only defaults",
    );
  });

  await withEnv(
    {
      ...clean,
      NEXT_PUBLIC_ADS_VIDEO_ORDER: "adcash,exoclick,hilltop",
      NEXT_PUBLIC_EXOCLICK_VAST_ENABLED: "true",
      NEXT_PUBLIC_EXOCLICK_VAST_TAG: "https://video.example/exo.xml",
      NEXT_PUBLIC_ADCASH_VAST_ENABLED: "true",
      NEXT_PUBLIC_ADCASH_VAST_TAG: "https://video.example/adcash.xml",
    },
    () => {
      assert.deepEqual(videoProviderChain(), ["adcash", "exoclick", "hilltop"]);
    },
  );

  await withEnv(
    { ...clean, NEXT_PUBLIC_POST_MATCH_ADS_ENABLED: "false" },
    () => {
      assert.deepEqual(videoProviderChain(), [], "the master switch disables all");
    },
  );

  // Hilltop's own switch removes only Hilltop. It must not disable the surface
  // for the other two providers.
  await withEnv(
    {
      ...clean,
      NEXT_PUBLIC_HILLTOPS_ENABLED: "false",
      NEXT_PUBLIC_EXOCLICK_VAST_ENABLED: "true",
      NEXT_PUBLIC_EXOCLICK_VAST_TAG: "https://video.example/exo.xml",
    },
    () => {
      assert.deepEqual(videoProviderChain(), ["exoclick", "adexchange"]);
    },
  );
});

test("the player uses the sequential chain and keeps its old guard rails", () => {
  assert.match(PLAYER, /videoProviderChain\(/);
  assert.match(PLAYER, /runAdChain\(/);
  assert.match(PLAYER, /requestVideoAd\(/);
  assert.match(PLAYER, /markMatchAdServed\(matchId\)/);
  assert.match(PLAYER, /wasMatchAdServed\(matchId\)/);
  assert.match(PLAYER, /export const SKIP_AFTER_SECONDS = 15;/);
  assert.match(PLAYER, /matchEnded/);
  assert.match(PLAYER, /impressionSentRef/);
  assert.match(PLAYER, /if \(!active \|\| !matchEnded \|\| !offerAllowed\) return;/);
  assert.ok(!/postMatchVastUrl\(\)/.test(PLAYER), "no hard-coded single tag");
  assert.ok(!/window\.open\(|location\.assign\(|location\.replace\(/.test(PLAYER));
});

// ── Banner chain contract ─────────────────────────────────────────────────

test("the banner slot runs one provider at a time in one container", () => {
  assert.match(CLIENT, /runAdChain\(/);
  assert.match(CLIENT, /loadBannerProvider\(provider/);
  assert.match(CLIENT, /host\.replaceChildren\(\)/);
  assert.match(CLIENT, /document\.createElement\("div"\)/, "each attempt gets its own container");
  assert.match(CLIENT, /attemptHost\.style\.display = "none"/, "a failed attempt is hidden, not reused");
  assert.match(CLIENT, /id=\{`grynd-ad-banner-\$\{placement\}`\}/);
  assert.doesNotMatch(CLIENT, /Promise\.all/, "providers are never started together");
  assert.doesNotMatch(CLIENT, /window\.open|location\.assign|location\.replace/);
  assert.match(CLIENT, /finishedRef/);
  assert.match(CLIENT, /claimOpportunity\(id, ownerRef\.current\)/);
});

test("each provider exposes its own fill detection, never a script load", () => {
  assert.match(RUNTIME, /function loadHilltop/);
  assert.match(RUNTIME, /function loadExoclick/);
  assert.match(RUNTIME, /function loadAdcash/);
  assert.match(RUNTIME, /creative-present/);
  assert.match(RUNTIME, /watchForFill/);
  assert.match(RUNTIME, /runBanner/);
  assert.ok(!/verifiedImpression: true/.test(RUNTIME), "banners never claim an impression");
  const runtimeCode = RUNTIME.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/runPop|runAutoTag|onclick|popunder/i.test(runtimeCode));
  assert.match(PROVIDERS, /requestVideoAd/);
});

// ── Reporting ─────────────────────────────────────────────────────────────

test("metrics are provider-level, verified only when observed, and revenue-free", () => {
  assert.equal(outcomeMetric("filled"), "ad_fill");
  assert.equal(outcomeMetric("no_fill"), "ad_no_fill");
  assert.equal(outcomeMetric("timeout"), "ad_timeout");
  assert.equal(outcomeMetric("blocked"), "ad_blocked");
  assert.equal(outcomeMetric("network_error"), "ad_error");
  assert.equal(outcomeMetric("invalid_response"), "ad_error");
  assert.equal(outcomeMetric("provider_disabled"), "ad_error");

  const payload = buildAdEvent({
    metric: "ad_impression",
    kind: "video",
    provider: "exoclick",
    placement: "post-match",
    opportunityId: "video:match-secret",
    status: "filled",
    reason: "inline-ad",
    latencyMs: 123.4,
    verifiedImpression: true,
  });

  assert.equal(payload.event, "ad_impression");
  assert.deepEqual(Object.keys(payload.properties).sort(), [
    "ad_kind",
    "latency_ms",
    "placement",
    "provider",
    "reason",
    "status",
    "verified_impression",
  ]);
  assert.equal(payload.properties.verified_impression, true);
  assert.equal(payload.properties.latency_ms, 123);

  const serialized = JSON.stringify(payload);
  assert.ok(!serialized.includes("match-secret"), "no match id or opportunity id");
  assert.ok(!serialized.includes("https://"), "no tag, zone or creative URL");
  assert.ok(!/revenue|ecpm|estimated/i.test(serialized), "revenue is never fabricated");

  const bannerFill = buildAdEvent({
    metric: "ad_fill",
    kind: "banner",
    provider: "adcash",
    placement: "home",
    opportunityId: "banner:home:x",
  });
  assert.equal(bannerFill.properties.verified_impression, false);
});

test("the player reports a verified impression only from playback", () => {
  const play = PLAYER.slice(PLAYER.indexOf("const handlePlay"));
  assert.match(play, /metric: "ad_impression"/);
  assert.match(play, /verifiedImpression: true/);
  const impressionAt = play.indexOf('metric: "ad_impression"');
  assert.ok(
    impressionAt > -1 && impressionAt < play.indexOf("const handleEnded"),
    "the impression is tied to the play handler",
  );
});
