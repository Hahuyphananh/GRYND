// tests/ai-search-readiness.test.mjs
//
// Contract tests for "can an AI crawler / answer engine read this site?".
//
// The audit that prompted these found three defects, all of them structural
// rather than cosmetic:
//
//   1. NO H1 and almost no text in the raw HTML — every page's content was
//      rendered only after a client mount, so the served HTML was a shell.
//   2. NO review / rating markup — nothing a machine could use to judge
//      whether the platform is well regarded.
//   3. Consequently nothing to quote: an answer engine saw ~40 characters.
//
// Each fix is easy to undo by accident, so the invariants are pinned here:
//
//   • pages must be SERVER-rendered (no mount gate around the providers);
//   • every public page must have exactly one <h1>;
//   • the rating markup must be built from real approved reviews and must
//     disappear when there are none (never a hardcoded score);
//   • turning SSR back on must not reintroduce a hydration mismatch, which is
//     why the locale-dependent date format and the two render-time browser
//     branches are pinned too.
//
// The end-to-end proof (raw HTML text, H1, JSON-LD, and a real browser
// hydration pass over /, /reviews, /games, /faq and /classement) lives in
// qa/ai-search-raw-html.mjs.
//
// Run:  node --import tsx --test tests/ai-search-readiness.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  buildAggregateRating,
  buildAppJsonLd,
  buildReviewNode,
  buildWebsiteJsonLd,
} from "../src/lib/reviewJsonLd.ts";

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(here, "..", p), "utf8");

const squash = (text) => text.replace(/\s+/g, " ").trim();
/** Assertions test CODE, not the prose that explains it. */
const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const has = (haystack, needle, label) =>
  assert.ok(
    squash(haystack).includes(squash(needle)),
    `${label || "expected source"} to contain:\n  ${squash(needle)}`,
  );

const LAYOUT = read("src/app/layout.tsx");
const PROVIDERS = read("src/app/providers.tsx");
const HOME = read("src/app/page.jsx");
const HOME_UI = read("src/app/PageClient.jsx");
const REVIEWS_PAGE = read("src/app/reviews/page.tsx");
const REVIEW_WALL = read("src/components/reviews/ReviewWall.tsx");

// ════════════════════════════════════════════════════════════════════
// 1. Pages are server-rendered (the "very little text in the raw HTML" fix)
// ════════════════════════════════════════════════════════════════════

test("the app shell renders its children on the server", () => {
  const shell = code(PROVIDERS);
  // The regression: `const [mounted, setMounted] = useState(false); …
  // if (!mounted) return null;` — one line that kept EVERY page out of the
  // server-rendered HTML.
  assert.ok(
    !/if\s*\(\s*!\s*mounted\s*\)\s*return\s+null/.test(shell),
    "providers must not gate children behind a client mount",
  );
  assert.ok(
    !/useState\(\s*false\s*\)[\s\S]{0,400}?return null/.test(shell),
    "no render-blocking mount gate anywhere in the provider chain",
  );
  // …and the children are still rendered through the provider chain.
  has(shell, "<AppProviders>{children}</AppProviders>", "Providers must render children");
});

test("the public pages are server components, not client shells", () => {
  // A "use client" page can still be SSR'd by Next, but the review data has to
  // come from the server; a client-only page cannot fetch it before the HTML
  // is sent.
  assert.ok(
    !/^\s*["']use client["']/m.test(REVIEWS_PAGE),
    "/reviews must stay a server component so the reviews are in the HTML",
  );
  has(REVIEWS_PAGE, "await loadReviews(limit)", "the reviews page must load reviews on the server");
  has(REVIEWS_PAGE, "initialReviews={data?.reviews ?? null}", "…and hand them to the wall");
  has(REVIEWS_PAGE, "initialStats={data?.stats ?? null}", "…along with the stats");
  // A page must never 500 because the reviews table is unavailable.
  has(REVIEWS_PAGE, "catch", "a reviews outage must degrade, not crash the page");
});

test("every audited page has exactly one <h1>", () => {
  const pages = [
    ["src/app/PageClient.jsx", HOME_UI],
    ["src/app/reviews/page.tsx", REVIEWS_PAGE],
  ];
  for (const [label, src] of pages) {
    const count = (src.match(/<motion\.h1\b|<h1\b/g) || []).length;
    assert.equal(count, 1, `${label} must have exactly one <h1> (found ${count})`);
  }
  // The home page's H1 lives in PageClient, which the server renders.
  has(HOME, "<PageClient", "the home page must render the component holding the H1");
});

// ════════════════════════════════════════════════════════════════════
// 2. Star ratings a machine can trust (the schema fix)
// ════════════════════════════════════════════════════════════════════

test("the site identity is in the root layout, on every page", () => {
  has(LAYOUT, 'import { ORGANIZATION_ID, buildWebsiteJsonLd }', "the layout builds the site graph");
  has(LAYOUT, "organizationJsonLd", "…and emits the Organization node");
  has(LAYOUT, "buildWebsiteJsonLd()", "…and the WebSite node");
  assert.equal(
    (LAYOUT.match(/application\/ld\+json/g) || []).length,
    2,
    "exactly two identity blocks in the layout — no duplicated claims",
  );
});

test("the home page carries the rating, built from real reviews", () => {
  has(HOME, 'import { buildAppJsonLd }', "the home page must emit application markup");
  has(HOME, "await getReviewAggregate()", "…from the cached real aggregate");
  has(HOME, "buildAppJsonLd({ stats: reviewStats })", "…never from a literal score");
  // The rating block is conditional: no real reviews means no markup at all.
  assert.match(
    HOME,
    /ratingJsonLd && \(/,
    "the rating markup must be omitted when there is nothing real to report",
  );
});

test("never invent a rating", () => {
  assert.equal(buildAggregateRating(null), null, "no stats → no rating");
  assert.equal(
    buildAggregateRating({ average: "0.0", count: 0, distribution: {} }),
    null,
    "zero reviews → no rating (an AggregateRating with reviewCount 0 is a false claim)",
  );
  assert.equal(
    buildAppJsonLd({ stats: null }),
    null,
    "with no rating there is no application block either",
  );
});

test("the rating repeats the real numbers", () => {
  const stats = {
    average: "4.6",
    count: 12,
    distribution: { 1: 0, 2: 1, 3: 1, 4: 3, 5: 7 },
  };
  const rating = buildAggregateRating(stats);
  assert.deepEqual(rating, {
    "@type": "AggregateRating",
    ratingValue: "4.6",
    reviewCount: 12,
    bestRating: 5,
    worstRating: 1,
  });

  const app = buildAppJsonLd({
    stats,
    reviews: [
      { rating: 5, title: "Great", body: "Best PvP site", createdAt: "2026-08-23T16:07:49.584Z", username: "Kingjoememe" },
    ],
  });
  assert.equal(app["@type"], "SoftwareApplication");
  assert.deepEqual(app.aggregateRating, rating);
  assert.equal(app.review.length, 1, "approved review bodies become Review nodes");
  assert.equal(app.review[0].reviewRating.ratingValue, 5);
  assert.equal(app.review[0].datePublished, "2026-08-23", "dates are ISO, not locale-formatted");
});

test("a review node is only marked up when it says something", () => {
  const app = buildAppJsonLd({
    stats: { average: "5.0", count: 1, distribution: { 5: 1 } },
    reviews: [
      { rating: 5, title: null, body: "   ", createdAt: "2026-08-23T16:07:49.584Z", username: null }, // bare star
    ],
  });
  assert.ok(!app.review, "a rating with no text adds nothing a crawler can quote");
});

test("an out-of-range rating is clamped, never trusted", () => {
  const node = buildReviewNode({
    rating: 99,
    title: "x",
    body: "y",
    createdAt: "2026-08-23T16:07:49.584Z",
    username: "a",
  });
  assert.equal(node.reviewRating.ratingValue, 5);
  assert.equal(node.reviewRating.bestRating, 5);
});

test("the graph is linked by @id, not three unrelated claims", () => {
  const site = buildWebsiteJsonLd();
  assert.equal(site["@type"], "WebSite");
  assert.ok(site.publisher["@id"].endsWith("#organization"), "the site names its publisher by @id");
  const app = buildAppJsonLd({ stats: { average: "5.0", count: 1, distribution: { 5: 1 } } });
  assert.equal(app.publisher["@id"], site.publisher["@id"], "one organization node, referenced twice");
});

// ════════════════════════════════════════════════════════════════════
// 3. Hydration — server-rendered content must survive the client render
// ════════════════════════════════════════════════════════════════════

test("rendered dates are deterministic, not locale-dependent", () => {
  const wall = code(REVIEW_WALL);
  assert.ok(
    !/toLocaleDateString\s*\(\s*\)/.test(wall),
    "a date formatted with the runtime's own locale differs between Node and the browser",
  );
  has(wall, 'new Intl.DateTimeFormat("en-US"', "review dates must pin the locale");
  has(wall, 'timeZone: "UTC"', "…and the timezone");
  // The exact instant stays machine-readable.
  has(wall, "dateTime={r.createdAt}", "the card must expose the raw instant to crawlers");
});

test("the toast tray does not branch on `typeof document` during hydration", () => {
  const toast = code(read("src/components/toast/ToastProvider.jsx"));
  assert.ok(
    !/typeof document !== ["']undefined["']/.test(toast),
    "`typeof document` is TRUE during hydration but the server rendered nothing → mismatch",
  );
  has(toast, "setPortalReady(true)", "the portal must be enabled after mount");
  has(toast, "portalReady &&", "…and gate the render on that flag");
});

test("SVG geometry is identical on both sides of hydration", () => {
  const bg = code(read("src/components/InteractiveCasinoBg.jsx"));
  // Math.sin/cos can differ in the last ULP between Node and the browser, and
  // React treats a differing attribute string as a mismatch.
  assert.match(bg, /const geo = \(n\) => Math\.round\(n \* 1000\) \/ 1000;/, "expected the rounding helper");
  const trigLines = bg
    .split("\n")
    .filter((line) => /Math\.(sin|cos)\(/.test(line) && !/^\s*\/\//.test(line) && !/const geo/.test(line));
  const unrounded = trigLines.filter((line) => !/geo\(/.test(line));
  assert.deepEqual(
    unrounded.map((l) => l.trim()),
    [],
    "every trig-derived coordinate must go through geo()",
  );
  assert.ok(trigLines.length > 0, "sanity: the wireframe still computes coordinates");
});
