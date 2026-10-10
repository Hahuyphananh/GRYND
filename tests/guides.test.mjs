/**
 * guides.test.mjs
 *
 * Guards the GRYND guides library (src/lib/guides.ts) and its two routes
 * (/guides and /guides/<slug>).
 *
 * These pages exist to answer Google's "low value content" concern with
 * genuinely useful writing rather than volume, so the invariants below are
 * about exactly that:
 *
 *   1. SUBSTANCE. Every guide has a real title, a unique meta description, a
 *      minimum and a maximum length, and more than a stub of a body. A guide
 *      that shrank to a paragraph fails here rather than shipping.
 *   2. NO REPETITION. No two guides share a section heading, and no paragraph
 *      is reused across guides. That is the mechanical half of "do not repeat
 *      the same paragraphs"; the other half is not testable.
 *   3. NO DANGLING LINKS. Every game a guide names is a real public game page,
 *      and every "read next" slug is a real guide.
 *   4. PUBLIC AND INDEXABLE. /guides/* is in the proxy's public matcher, the
 *      index and every guide are in the sitemap, the guide route owns its own
 *      canonical, 404s unknown slugs at the routing layer, and the index links
 *      every guide with an ordinary anchor.
 *   5. STRUCTURED DATA, HONESTLY. Each guide declares an Article whose author
 *      is the GRYND organisation node — never an invented Person.
 *
 * Run: npm run test:guides
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  GUIDES,
  GUIDE_BY_SLUG,
  GUIDE_INDEX,
  GUIDE_SLUGS,
  GUIDES_INDEX_PATH,
  guidePath,
  guidesForGame,
  relatedGuidesFor,
} from "../src/lib/guides.ts";
import { GAME_LANDING_PAGES, GAME_LANDING_SLUGS } from "../src/lib/gameLandingPages.ts";
import { PUBLIC_SEO_PAGES, PUBLIC_SEO_PATHS } from "../src/lib/seoPages.ts";
import { buildGuideStructuredData } from "../src/lib/guideJsonLd.ts";

const read = (rel) => readFileSync(rel, "utf8");

const GUIDE_INDEX_ROUTE = "src/app/guides/page.tsx";
const GUIDE_DETAIL_ROUTE = "src/app/guides/[slug]/page.tsx";
const GUIDE_COMPONENT = "src/components/guides/GuideArticle.tsx";
const PROXY = "src/middleware.ts";

const ALL_SLUGS = new Set(GAME_LANDING_SLUGS);
const ALL_GUIDES = new Set(GUIDE_SLUGS);

/** Rough word count over everything a reader sees on the page. */
function wordCount(guide) {
  const text = [
    guide.title,
    guide.h1,
    guide.summary,
    ...guide.sections.flatMap((section) => [
      section.heading,
      ...(section.paragraphs ?? []),
      ...(section.bullets ?? []),
    ]),
  ].join(" ");
  return text.split(/\s+/).filter(Boolean).length;
}

// ── 1. Substance ──────────────────────────────────────────────────────────

test("catalog: the library is small by design and every entry is complete", () => {
  // "Start with approximately 10-15 guides, not hundreds." A ceiling is the
  // point of the constraint, so it is asserted rather than left to discipline.
  assert.ok(GUIDES.length >= 10, `expected at least 10 guides, found ${GUIDES.length}`);
  assert.ok(GUIDES.length <= 15, `expected at most 15 guides, found ${GUIDES.length}`);

  for (const guide of GUIDES) {
    for (const field of ["slug", "title", "metaDescription", "h1", "summary"]) {
      assert.equal(typeof guide[field], "string", `${guide.slug}: ${field} must be a string`);
      assert.ok(guide[field].trim().length > 0, `${guide.slug}: ${field} is empty`);
    }
    assert.match(guide.slug, /^[a-z0-9-]+$/, `${guide.slug} is not a URL-safe slug`);
  }
});

test("catalog: slugs, titles and meta descriptions are unique", () => {
  const by = (field) => GUIDES.map((guide) => guide[field]);
  for (const field of ["slug", "title", "h1", "metaDescription"]) {
    const values = by(field);
    assert.equal(new Set(values).size, values.length, `two guides share a ${field}`);
  }
});

test("catalog: every meta description is a real description, not a template", () => {
  const TEMPLATE = /\{\{|lorem|TODO|placeholder/i;
  for (const guide of GUIDES) {
    const length = guide.metaDescription.trim().length;
    assert.ok(length >= 80, `${guide.slug}: meta description is only ${length} chars`);
    assert.ok(length <= 320, `${guide.slug}: meta description is ${length} chars (too long)`);
    assert.doesNotMatch(
      guide.metaDescription,
      TEMPLATE,
      `${guide.slug}: template placeholder text`
    );
  }
});

test("catalog: every guide teaches something substantial", () => {
  for (const guide of GUIDES) {
    assert.ok(guide.sections.length >= 4, `${guide.slug}: only ${guide.sections.length} sections`);
    for (const section of guide.sections) {
      assert.ok(section.heading?.trim(), `${guide.slug}: a section has no heading`);
      const hasBody = (section.paragraphs?.length ?? 0) + (section.bullets?.length ?? 0) > 0;
      assert.ok(hasBody, `${guide.slug} / "${section.heading}": section has no content`);
      for (const paragraph of section.paragraphs ?? []) {
        assert.ok(paragraph.trim().length >= 80, `${guide.slug}: a paragraph is a stub`);
      }
    }
    const words = wordCount(guide);
    assert.ok(words >= 500, `${guide.slug}: only ${words} words — too thin to be useful`);
    assert.ok(words <= 1400, `${guide.slug}: ${words} words — longer than this guide needs`);
  }
});

// ── 2. No repetition ──────────────────────────────────────────────────────

test("no repetition: section headings are unique across the whole library", () => {
  const seen = new Map();
  for (const guide of GUIDES) {
    for (const section of guide.sections) {
      const key = section.heading.trim().toLowerCase();
      assert.equal(
        seen.has(key),
        false,
        `"${section.heading}" is used by both ${seen.get(key)} and ${guide.slug}`
      );
      seen.set(key, guide.slug);
    }
  }
});

test("no repetition: no paragraph is reused between guides", () => {
  const seen = new Map();
  for (const guide of GUIDES) {
    for (const section of guide.sections) {
      for (const paragraph of section.paragraphs ?? []) {
        const key = paragraph.trim().toLowerCase();
        assert.equal(
          seen.has(key),
          false,
          `a paragraph from ${seen.get(key)} is copied into ${guide.slug}`
        );
        seen.set(key, guide.slug);
      }
    }
  }
});

// ── 3. Links ──────────────────────────────────────────────────────────────

test("links: every game a guide names is a real public game page", () => {
  for (const guide of GUIDES) {
    assert.ok(guide.gameSlugs.length > 0, `${guide.slug} links no games`);
    assert.equal(
      new Set(guide.gameSlugs).size,
      guide.gameSlugs.length,
      `${guide.slug} lists the same game twice`
    );
    for (const slug of guide.gameSlugs) {
      assert.ok(ALL_SLUGS.has(slug), `${guide.slug} links unknown game "${slug}"`);
    }
  }
});

test('links: every "read next" slug is a real guide', () => {
  for (const guide of GUIDES) {
    assert.ok(guide.relatedGuides.length > 0, `${guide.slug} suggests nothing to read next`);
    for (const slug of guide.relatedGuides) {
      assert.ok(ALL_GUIDES.has(slug), `${guide.slug} points at unknown guide "${slug}"`);
      assert.notEqual(slug, guide.slug, `${guide.slug} lists itself under read next`);
    }
    assert.equal(relatedGuidesFor(guide.slug).length, guide.relatedGuides.length);
  }
});

test("links: the library covers a broad slice of the catalogue", () => {
  const covered = new Set(GUIDES.flatMap((guide) => guide.gameSlugs));
  assert.ok(
    covered.size >= 15,
    `the guides name only ${covered.size} games — they should span the catalogue`
  );
  for (const slug of covered) {
    assert.ok(ALL_SLUGS.has(slug), `guide coverage names an unknown game: ${slug}`);
  }
  // guidesForGame is the reverse lookup the game landing pages render, and it
  // must agree with the catalogue rather than being a second list.
  for (const game of GAME_LANDING_PAGES) {
    const expected = GUIDES.filter((guide) => guide.gameSlugs.includes(game.slug)).map(
      (guide) => guide.slug
    );
    assert.deepEqual(
      guidesForGame(game.slug).map((guide) => guide.slug),
      expected,
      `guidesForGame disagrees with the catalogue for ${game.slug}`
    );
  }
  assert.deepEqual(guidesForGame("no-such-game"), []);
});

test("links: the index entry projection mirrors the catalogue", () => {
  assert.equal(GUIDE_INDEX.length, GUIDES.length);
  assert.deepEqual(
    GUIDE_INDEX.map((guide) => guide.slug),
    GUIDES.map((guide) => guide.slug)
  );
  for (const entry of GUIDE_INDEX) {
    assert.equal(entry.title, GUIDE_BY_SLUG[entry.slug].title);
    assert.equal(entry.metaDescription, GUIDE_BY_SLUG[entry.slug].metaDescription);
    assert.equal(guidePath(entry.slug), `/guides/${entry.slug}`);
  }
});

// ── 4. Public and indexable ───────────────────────────────────────────────

test("public: the proxy matches the whole guide namespace without a session", () => {
  const src = read(PROXY);
  assert.match(src, /"\/guides\(\.\*\)"/, "the proxy must treat /guides/* as a public route");
  // …and an unknown slug is a real 404 declared before rendering, not a soft
  // 404 the page cannot prevent (the root layout streams and commits a 200).
  assert.match(src, /isGuideSlug\(unknownGuideSlug\[1\]\)/, "unknown guide slugs must 404");
  assert.match(src, /import \{ isGuideSlug \} from "\.\/lib\/guides"/);
});

test("indexable: the sitemap lists the index and every guide", () => {
  assert.ok(PUBLIC_SEO_PATHS.includes(GUIDES_INDEX_PATH), "/guides must be in the sitemap");
  for (const slug of GUIDE_SLUGS) {
    assert.ok(
      PUBLIC_SEO_PATHS.includes(guidePath(slug)),
      `${guidePath(slug)} is not in the sitemap`
    );
  }
  const guideEntries = PUBLIC_SEO_PAGES.filter((page) => page.group === "guides");
  assert.equal(guideEntries.length, GUIDES.length + 1);
  for (const page of guideEntries) {
    assert.ok(page.priority > 0 && page.priority <= 1, `${page.path} has no valid priority`);
    assert.ok(page.changeFrequency, `${page.path} has no changeFrequency`);
  }
});

test("indexable: the detail route owns its canonical and 404s unknown slugs", () => {
  const src = read(GUIDE_DETAIL_ROUTE);
  assert.match(src, /export const dynamicParams = false/, "unknown slugs must 404 at the router");
  assert.match(src, /GUIDE_SLUGS\.map/, "static params must come from the guide catalogue");
  assert.match(src, /alternates: \{ canonical \}/, "each guide must declare its own canonical");
  assert.match(
    src,
    /const canonical = guide \? guidePath\(slug\) : "\/guides"/,
    "canonical must be the guide path"
  );
  // A single return, so scripts/audit-social-metadata.mjs can resolve the block.
  const generateMetadata = src.slice(
    src.indexOf("export async function generateMetadata"),
    src.indexOf("export default async function")
  );
  assert.equal(
    [...generateMetadata.matchAll(/return \{/g)].length,
    1,
    "generateMetadata must contain exactly one return"
  );
  // Open Graph must be complete (a page-local openGraph drops every field it
  // does not re-declare).
  // A key may be written as a shorthand property (`title,`) or as a pair
  // (`title: value`) — both satisfy "the openGraph block re-declares it".
  for (const field of ["title", "description", "url", "siteName", "locale", "type"]) {
    assert.match(
      generateMetadata,
      new RegExp(`(^|[\\s{])${field}[,:]`, "m"),
      `openGraph is missing ${field}`
    );
  }
});

test("indexable: the index links every guide with a plain anchor", () => {
  const src = read(GUIDE_INDEX_ROUTE);
  assert.match(src, /export const metadata: Metadata/, "the index must declare metadata");
  assert.match(src, /alternates: \{ canonical: "\/guides" \}/);
  assert.match(src, /GUIDE_INDEX\.map\(/, "the index must render the catalogue, not a hand list");
  assert.match(src, /href=\{guidePath\(guide\.slug\)\}/);
  assert.match(src, /\{guide\.title\}/);
  assert.doesNotMatch(src, /onClick=/, "a click handler is not a link");
  assert.doesNotMatch(src, /"use client"/, "the index must be server-rendered");
});

test("indexable: the article component renders the whole guide on the server", () => {
  const src = read(GUIDE_COMPONENT);
  assert.doesNotMatch(src, /"use client"/, "the article must be a server component");
  assert.match(src, /guide\.sections\.map\(/, "every section must be rendered");
  assert.match(src, /guide\.summary/);
  assert.match(src, /aria-label="Breadcrumb"/);
  assert.match(src, /href=\{gameLandingPath\(game\.slug\)\}/, "guides must link their games");
  assert.match(src, /href=\{guidePath\(entry\.slug\)\}/, "guides must link the next reads");
  assert.doesNotMatch(src, /href="\/casino\//, "guides must not link the app namespace");
});

test("indexable: the game pages link back to the guides that name them", () => {
  const src = read("src/components/game-landing/GameLanding.tsx");
  assert.match(src, /guidesForGame\(game\.slug\)/, "game pages must resolve their guides");
  assert.match(src, /href=\{guidePath\(entry\.slug\)\}/, "game pages must link the guides");
  // Only the guides that name this game, and never an unbounded list.
  assert.match(src, /\.slice\(0, 3\)/);
});

// ── 5. Structured data ────────────────────────────────────────────────────

test("structured data: an Article per guide, authored by the organisation", () => {
  for (const slug of GUIDE_SLUGS) {
    const nodes = buildGuideStructuredData(slug);
    assert.equal(nodes.length, 2, `${slug} should declare an Article and a breadcrumb`);

    const article = nodes.find((node) => node["@type"] === "Article");
    const breadcrumb = nodes.find((node) => node["@type"] === "BreadcrumbList");
    assert.ok(article, `${slug} has no Article node`);
    assert.ok(breadcrumb, `${slug} has no BreadcrumbList node`);

    assert.equal(article["@context"], "https://schema.org");
    assert.match(article["@id"], new RegExp(`${guidePath(slug)}#article$`));
    assert.equal(article["@id"].includes("#article"), true);
    // Author and publisher must be the ORGANISATION, never an invented person.
    assert.equal(article.author["@id"].includes("#organization"), true);
    assert.equal(
      "name" in article.author,
      false,
      `${slug} invents an author name — that is exactly what this suite forbids`
    );
    assert.equal(article.publisher["@id"].includes("#organization"), true);
    assert.equal(article.description, GUIDE_BY_SLUG[slug].metaDescription);

    assert.equal(breadcrumb.itemListElement.length, 3);
    assert.deepEqual(
      breadcrumb.itemListElement.map((item) => item.position),
      [1, 2, 3]
    );
  }
  assert.deepEqual(buildGuideStructuredData("not-a-guide"), []);
});
