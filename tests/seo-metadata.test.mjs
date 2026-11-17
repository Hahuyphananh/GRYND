/**
 * tests/seo-metadata.test.mjs
 *
 * The shared metadata contract (src/lib/seo.ts).
 *
 * Every indexable page used to hand-write its own title, description,
 * canonical, openGraph and twitter object. That duplication produced four
 * different title conventions, pages with a canonical but no og:url, and a
 * leaderboard description advertising games that no longer exist.
 *
 * These tests pin the replacement:
 *
 *   1. the helper's own rules (one suffix, canonical === og:url, complete card);
 *   2. adoption: every page in the public SEO inventory builds its metadata
 *      through pageMetadata() and names its own path;
 *   3. centralisation: no page keeps a local siteName / twitter card, so the
 *      shape cannot drift back page by page.
 *
 * Run: node --import tsx --test tests/seo-metadata.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  DEFAULT_OG_IMAGE,
  SITE_NAME,
  pageMetadata,
  withSiteTitle,
} from "../src/lib/seo.ts";
import { PUBLIC_SEO_PATHS } from "../src/lib/seoPages.ts";

const read = (p) => readFileSync(p, "utf8");

/** Static inventory path → the page file that owns it. */
const STATIC_PAGES = {
  "/": "src/app/page.jsx",
  "/games": "src/app/games/page.tsx",
  "/guides": "src/app/guides/page.tsx",
  "/play": "src/app/play/page.tsx",
  "/play/ai": "src/app/play/ai/page.tsx",
  "/play/ranked": "src/app/play/ranked/page.tsx",
  "/play/daily-puzzle": "src/app/play/daily-puzzle/page.tsx",
  "/play/unlimited-puzzles": "src/app/play/unlimited-puzzles/page.tsx",
  "/solitaire": "src/app/solitaire/page.tsx",
  "/daily": "src/app/daily/page.tsx",
  "/learn": "src/app/learn/page.tsx",
  "/learn/courses": "src/app/learn/courses/page.tsx",
  "/learn/videos": "src/app/learn/videos/page.tsx",
  "/learn/practice": "src/app/learn/practice/page.tsx",
  "/classement": "src/app/classement/page.jsx",
  "/reviews": "src/app/reviews/page.tsx",
  "/upgrade-pro": "src/app/upgrade-pro/page.tsx",
  "/faq": "src/app/faq/page.jsx",
  "/about": "src/app/about/page.tsx",
  "/cookie-policy": "src/app/cookie-policy/page.tsx",
};

test("one title suffix, and no title is branded twice", () => {
  assert.equal(withSiteTitle("Leaderboard"), "Leaderboard | GRYND");
  assert.equal(withSiteTitle("Leaderboard | GRYND"), "Leaderboard | GRYND");
  // The two deliberate voices survive unchanged.
  assert.equal(
    withSiteTitle("GRYND — The competitive home of Solitaire"),
    "GRYND — The competitive home of Solitaire",
  );
  assert.equal(withSiteTitle("Courses — GRYND Academy"), "Courses — GRYND Academy");
  assert.equal(SITE_NAME, "GRYND");
});

test("canonical and og:url are derived from the same path", () => {
  const m = pageMetadata({
    title: "Solitaire guides",
    description: "Practical Klondike Solitaire guides.",
    path: "/guides",
    image: DEFAULT_OG_IMAGE,
  });

  assert.equal(m.title, "Solitaire guides | GRYND");
  assert.equal(m.description, "Practical Klondike Solitaire guides.");
  assert.equal(m.alternates.canonical, "/guides");
  assert.ok(m.openGraph.url.endsWith("/guides"), "og:url must name the page, not the image");
  assert.equal(m.openGraph.siteName, "GRYND");
  assert.equal(m.openGraph.locale, "en_US");
  assert.equal(m.twitter.card, "summary_large_image");

  // Images are absolute: a social crawler fetches them without a base page.
  assert.match(m.openGraph.images[0].url, /^https:\/\//);
  assert.match(m.twitter.images[0], /^https:\/\//);
});

test("a route with its own opengraph-image is not given a generic one", () => {
  const m = pageMetadata({
    title: "Daily Solitaire Challenge",
    description: "One deal every UTC day.",
    path: "/daily",
  });
  assert.equal(m.openGraph.images, undefined, "no default banner may replace the route's card");
  assert.equal(m.twitter.images, undefined);
  assert.equal(m.twitter.card, "summary_large_image");
});

test("robots and extra head fields pass through only when supplied", () => {
  const normal = pageMetadata({ title: "FAQ", description: "Questions.", path: "/faq" });
  assert.equal(normal.robots, undefined);
  assert.equal(normal.other, undefined);

  const missing = pageMetadata({
    title: "Guide not found",
    description: "Browse every guide.",
    path: "/guides",
    robots: { index: false, follow: true },
  });
  assert.deepEqual(missing.robots, { index: false, follow: true });
});

test("every static page in the SEO inventory uses the helper and names its path", () => {
  for (const [path, file] of Object.entries(STATIC_PAGES)) {
    const src = read(file);
    assert.match(src, /pageMetadata\(\{/, `${file} must build metadata through pageMetadata()`);
    assert.ok(
      src.includes(`path: "${path}"`),
      `${file} must pass its canonical path "${path}" to the helper`,
    );
    // The inventory and the map must not drift apart.
    assert.ok(PUBLIC_SEO_PATHS.includes(path), `${path} must remain a listed SEO page`);
  }
});

test("the dynamic surfaces use the helper with their computed canonical", () => {
  const game = read("src/app/games/[slug]/page.tsx");
  assert.match(game, /pageMetadata\(\{/);
  assert.match(game, /path: canonical/);
  assert.match(game, /image: game \? game\.ogImage : DEFAULT_SOCIAL_IMAGE/);

  const guide = read("src/app/guides/[slug]/page.tsx");
  assert.match(guide, /pageMetadata\(\{/);
  assert.match(guide, /path: canonical/);
  assert.match(guide, /type: "article"/);

  const video = read("src/app/learn/videos/[part]/page.tsx");
  assert.match(video, /pageMetadata\(\{/);
  assert.match(video, /path: "\/learn\/videos\/" \+ video\.id/);
  assert.match(video, /type: "video\.other"/);
});

test("no indexable page keeps a local siteName or twitter card", () => {
  const files = [
    ...Object.values(STATIC_PAGES),
    "src/app/games/[slug]/page.tsx",
    "src/app/guides/[slug]/page.tsx",
    "src/app/learn/videos/[part]/page.tsx",
  ];
  for (const file of files) {
    const src = read(file);
    assert.ok(!src.includes('siteName: "GRYND"'), `${file} must not restate og:site_name`);
    assert.ok(
      !src.includes('card: "summary_large_image"'),
      `${file} must not restate the twitter card`,
    );
    assert.ok(!/openGraph: \{/.test(src), `${file} must not hand-build openGraph`);
  }
});

test("no two indexable pages share a description", () => {
  // Descriptions are page-owned, so they are not in the helper. Read them from
  // the helper calls and confirm each page says something different.
  const seen = new Map();
  const files = [...Object.values(STATIC_PAGES)];
  for (const file of files) {
    const src = read(file);
    const match = src.match(/description:\s*(?:\n\s*)?("(?:[^"\\]|\\.)*"|[A-Z_]+)/);
    assert.ok(match, `${file} must pass a description`);
    const value = match[1];
    // Constants are page-specific by name; compare the literal strings only.
    if (!value.startsWith("[")) {
      assert.ok(!seen.has(value), `${file} duplicates the description in ${seen.get(value)}`);
      seen.set(value, file);
    }
  }
});
