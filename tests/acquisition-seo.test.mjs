/**
 * acquisition-seo.test.mjs
 *
 * Phase 6 pins:
 *   * first-touch attribution is parsed from an allowlist, classified into the
 *     channel vocabulary, and NEVER overwritten by a later tagged visit;
 *   * the tracker captures before sign-in, so landing → signup keeps the channel;
 *   * the README describes the actual Solitaire-first product (no retired
 *     multi-game or virtual-token positioning);
 *   * the "move analysis" search intent has a real guide, sitemapped through the
 *     existing inventory;
 *   * share URLs carry gameplay numbers only — never an account or match id.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  ATTRIBUTION_PARAMS,
  attributionProperties,
  classifyChannel,
  mergeFirstTouch,
  parseAttribution,
  readStoredAttribution,
} from "../src/lib/attribution.ts";
import { GUIDES, GUIDE_BY_SLUG } from "../src/lib/guides.ts";
import { PUBLIC_SEO_PATHS } from "../src/lib/seoPages.ts";
import { winShareUrl } from "../src/lib/shareWin.ts";

const read = (path) => fs.readFileSync(path, "utf8").replace(/\r\n/g, "\n");

test("only the six attribution parameters are read", () => {
  assert.deepEqual([...ATTRIBUTION_PARAMS], [
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_term",
    "utm_content",
    "ref",
  ]);
  const parsed = parseAttribution(
    "https://grynd.example/?utm_source=tiktok&utm_medium=social&utm_campaign=launch&email=a@b.c",
  );
  assert.equal(parsed.source, "tiktok");
  assert.equal(parsed.medium, "social");
  assert.equal(parsed.campaign, "launch");
  assert.equal(parsed.term, null);
  assert.equal(parsed.landingPath, "/");
  assert.equal("email" in parsed, false);
});

test("paid and social sources map to the reporting channels", () => {
  const source = (value) => classifyChannel({ source: value });
  assert.equal(source("tiktok"), "tiktok");
  assert.equal(source("instagram"), "instagram");
  assert.equal(source("ig"), "instagram");
  assert.equal(source("youtube"), "youtube");
  assert.equal(source("reddit"), "reddit");
  assert.equal(source("product hunt"), "product_hunt");
  assert.equal(source("x"), "x");
  assert.equal(source("twitter"), "x");
  assert.equal(source("google"), "search");

  assert.equal(
    classifyChannel({ referrer: "https://www.producthunt.com/posts/grynd" }),
    "product_hunt",
  );
  assert.equal(
    classifyChannel({ referrer: "https://www.reddit.com/r/solitaire/" }),
    "reddit",
  );
  assert.equal(
    classifyChannel({ referrer: "https://www.google.com/search?q=solitaire+duel" }),
    "search",
  );
  // An internal navigation is not an acquisition.
  assert.equal(classifyChannel({ referrer: "https://www.grynd.dedyn.io/guides" }), "direct");
  // An unknown external host is a referral, not silently "direct".
  assert.equal(classifyChannel({ referrer: "https://blog.example/post" }), "referral");
  assert.equal(classifyChannel({}), "direct");
});

test("first touch is never overwritten by a later campaign visit", () => {
  const first = {
    ...parseAttribution("https://grynd.example/?utm_source=tiktok&utm_campaign=one"),
    channel: "tiktok",
    capturedAtMs: 1_000,
  };
  const merged = mergeFirstTouch(first, {
    ...parseAttribution("https://grynd.example/?utm_source=reddit&utm_campaign=two"),
    channel: "reddit",
    capturedAtMs: 2_000,
  });
  assert.equal(merged.source, "tiktok");
  assert.equal(merged.campaign, "one");
  assert.equal(merged.channel, "tiktok");
  assert.equal(merged.capturedAtMs, 1_000);
});

test("a bare direct first observation can still be upgraded", () => {
  const direct = mergeFirstTouch(null, { channel: "direct", capturedAtMs: 1 });
  const tagged = mergeFirstTouch(direct, {
    ...parseAttribution("https://grynd.example/?utm_source=youtube"),
    channel: "youtube",
    capturedAtMs: 2,
  });
  assert.equal(tagged.channel, "youtube");
  assert.equal(tagged.source, "youtube");
  // The original observation time is preserved.
  assert.equal(tagged.capturedAtMs, 1);
});

test("stored attribution is validated, not trusted", () => {
  assert.equal(readStoredAttribution(null), null);
  assert.equal(readStoredAttribution("{not json"), null);
  const parsed = readStoredAttribution(
    JSON.stringify({ source: "tiktok", channel: "made-up", landingPath: "/" }),
  );
  assert.equal(parsed.channel, "referral");
  assert.equal(parsed.source, "tiktok");
});

test("registered properties carry no personal data", () => {
  const props = attributionProperties({
    source: "tiktok",
    medium: "social",
    campaign: "launch",
    term: null,
    content: null,
    ref: null,
    channel: "tiktok",
    landingPath: "/play/ranked",
    capturedAtMs: 100,
  });
  assert.equal(props.acquisition_channel, "tiktok");
  assert.equal(props.acquisition_landing_path, "/play/ranked");
  for (const key of Object.keys(props)) {
    assert.doesNotMatch(key, /email|user|account|match|card|deal/i);
  }
});

test("the tracker captures the channel before the sign-in gate", () => {
  const src = read("src/components/FunnelTracker.tsx");
  const captureAt = src.indexOf("captureFirstTouch()");
  const gateAt = src.indexOf("if (!isLoaded || !isSignedIn || !user) return;");
  assert.ok(captureAt > -1, "captureFirstTouch is called");
  assert.ok(gateAt > -1, "the sign-in gate still exists");
  assert.ok(captureAt < gateAt, "capture must happen while signed out");
  assert.match(src, /posthog\.register\(firstTouch\)/);
  assert.match(src, /if \(!posthog\.get_property\("acquisition_channel"\)\)/);
});

test("README describes the Solitaire-first product", () => {
  const readme = read("README.md");
  assert.match(readme, /competitive .*Solitaire/i);
  assert.match(readme, /Ranked/i);
  assert.match(readme, /Daily Challenge/i);
  assert.match(readme, /Game Review/i);
  assert.match(readme, /Recorded opponent/i);
  // Retired positioning must be gone.
  assert.doesNotMatch(readme, /virtual token/i);
  assert.doesNotMatch(readme, /20 Games/i);
  assert.doesNotMatch(readme, /Roulette|Blackjack|Mines|Plinko|UNO/i);
  assert.doesNotMatch(readme, /Wallet & Token Management/i);
});

test("the public machine summary stays single-game too", () => {
  const llms = read("public/llms.txt");
  assert.match(llms, /GRYND ships one game: Solitaire/i);
  assert.doesNotMatch(llms, /virtual token/i);
});

test("the move-analysis intent has one real guide and is in the sitemap", () => {
  const guide = GUIDE_BY_SLUG["solitaire-game-review-explained"];
  assert.ok(guide, "the guide exists");
  assert.match(guide.metaDescription, /Game Review/i);
  assert.ok(GUIDES.filter((entry) => entry.slug === guide.slug).length === 1);
  assert.equal(guide.gameSlugs[0], "solitaire-duel");
  assert.ok(PUBLIC_SEO_PATHS.includes("/guides/solitaire-game-review-explained"));
  // Genuinely useful content, not a thin page.
  assert.ok(guide.sections.length >= 5);
});

test("share URLs carry gameplay numbers only", () => {
  const url = winShareUrl({ game: "duel", mode: "ranked", durationMs: 221_000, moves: 97 });
  const query = new URL(url).searchParams;
  assert.equal(query.get("g"), "duel");
  assert.equal(query.get("m"), "ranked");
  assert.equal(query.get("t"), "221000");
  assert.equal(query.get("mv"), "97");
  for (const key of query.keys()) {
    assert.ok(["g", "m", "t", "mv", "b", "l"].includes(key), `unexpected share key ${key}`);
  }
  assert.doesNotMatch(url, /user_|clerk|email|match/i);
});
