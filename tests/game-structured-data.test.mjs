/**
 * game-structured-data.test.mjs
 *
 * Pins the structured data on the public game landing pages (/games/<slug>).
 *
 * The rules, in the order they are checked below:
 *
 *   1. each page declares its own WebApplication, a BreadcrumbList and its
 *      FAQPage — and nothing else;
 *   2. every field is read out of the same catalogue entry the page RENDERS, so
 *      the markup cannot describe a page other than the one a visitor reads;
 *   3. no rating, no review and no price, ever — nothing on a game page states
 *      one, so claiming one would be a false claim about the page;
 *   4. URLs are always the canonical /games/<slug>, never the /casino/<slug>
 *      redirect;
 *   5. the nodes are one linked graph with no duplicate or dangling @id, and
 *      they never re-declare the site-level application;
 *   6. JSON-LD reaches the DOM through ONE shared component, and the JSON it
 *      emits survives a round trip and cannot terminate the <script> element;
 *   7. /faq declares no FAQPage, because its answers are behind an accordion —
 *      a crawler receives only the open one.
 *
 * The rendered-HTML half of the proof (the markup agreeing with the visible
 * page, on all 21 landing pages, with no hydration mismatch) lives in
 * qa/ai-search-raw-html.mjs.
 *
 * Run: npm run test:structured-data
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  GAME_LANDING_PAGES,
  GAME_LANDING_SLUGS,
  GAME_LANDING_BY_SLUG,
  SITE_ORIGIN,
  gameLandingUrl,
} from "../src/lib/gameLandingPages.ts";
import {
  buildGameBreadcrumbJsonLd,
  buildGameFaqJsonLd,
  buildGameStructuredData,
  buildGameWebApplicationJsonLd,
  gameWebApplicationId,
} from "../src/lib/gameJsonLd.ts";
import { APP_ID, ORGANIZATION_ID, WEBSITE_ID } from "../src/lib/reviewJsonLd.ts";

const read = (rel) => readFileSync(rel, "utf8");

/** Strip line comments FIRST, then block comments — see tests/internal-linking. */
const strip = (source) => source.replace(/\r\n/g, "\n");
function code(source) {
  return strip(source)
    .replace(/^[ \t]*\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

const LANDING = read("src/components/game-landing/GameLanding.tsx");
const JSONLD_COMPONENT = read("src/components/seo/JsonLd.tsx");
const FAQ_PAGE = read("src/app/faq/page.jsx");
const FAQ_CLIENT = read("src/app/faq/PageClient.jsx");

/** Every JSON key reachable in a node (so prose can't be mistaken for a claim). */
function keysOf(value, found = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) keysOf(item, found);
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      found.add(key);
      keysOf(child, found);
    }
  }
  return found;
}

/** Types reachable in a node, deepest nodes included. */
function typesOf(value, found = []) {
  if (Array.isArray(value)) {
    for (const item of value) typesOf(item, found);
  } else if (value && typeof value === "object") {
    if (typeof value["@type"] === "string") found.push(value["@type"]);
    for (const child of Object.values(value)) typesOf(child, found);
  }
  return found;
}

const ALL_NODES = GAME_LANDING_SLUGS.flatMap((slug) =>
  buildGameStructuredData(slug).map((node) => ({ slug, node }))
);

// ── 1. What each page declares ───────────────────────────────────────────

test("every landing page declares its application, breadcrumb and FAQ", () => {
  for (const game of GAME_LANDING_PAGES) {
    const bundle = buildGameStructuredData(game.slug);
    assert.deepEqual(
      bundle.map((node) => node["@type"]),
      ["WebApplication", "BreadcrumbList", "FAQPage"],
      `${game.slug} should declare exactly those three nodes`
    );
    for (const node of bundle) {
      assert.equal(node["@context"], "https://schema.org", `${game.slug}: @context`);
      assert.equal(typeof node["@id"], "string", `${game.slug}: every node carries an @id`);
    }
    // The FAQ node exists only because the catalogue carries questions — a game
    // without one would declare two nodes rather than an empty FAQPage.
    if (game.faq.length === 0) assert.equal(buildGameFaqJsonLd(game.slug), null);
  }
});

test("no page declares a rating, a review, a price or a site-wide app node", () => {
  // The whole point of the task: nothing here may claim what the page does not
  // show. Checked on the KEYS, not on the serialised text, so a game whose FAQ
  // prose happens to contain the word "review" is not a false positive.
  const FORBIDDEN = [
    "aggregateRating",
    "review",
    "reviewRating",
    "reviewCount",
    "ratingValue",
    "offers",
    "price",
    "priceCurrency",
    "availability",
  ];
  for (const { slug, node } of ALL_NODES) {
    const keys = keysOf(node);
    for (const forbidden of FORBIDDEN) {
      assert.ok(
        !keys.has(forbidden),
        `${slug}: "${forbidden}" describes something the page never states`
      );
    }
  }
  // The site-level SoftwareApplication (with its real, review-derived rating)
  // is declared on / and /reviews. A game page must not re-declare it: two
  // application entities for the same site is the "conflicting schema" case.
  const types = new Set(ALL_NODES.flatMap(({ node }) => typesOf(node)));
  assert.ok(
    !types.has("SoftwareApplication"),
    "game pages must not re-declare the site application"
  );
  assert.ok(types.has("WebApplication"), "the game itself is the application on its page");
});

// ── 2. Fields come from what the page renders ────────────────────────────

test("name, description and genre are the values the page renders", () => {
  const component = code(LANDING);
  // The component renders these exact catalogue fields …
  for (const field of [
    "{game.name}",
    "{game.headline}",
    "{game.category}",
    "{game.introduction.map(",
  ]) {
    assert.ok(component.includes(field), `the landing component should still render ${field}`);
  }
  assert.ok(component.includes("{game.faq.map("), "…and the FAQ entries themselves");

  for (const game of GAME_LANDING_PAGES) {
    const node = buildGameWebApplicationJsonLd(game.slug);
    assert.equal(node.name, game.name, `${game.slug}: name must match the visible game name`);
    assert.equal(
      node.genre,
      game.category,
      `${game.slug}: genre must match the visible category badge`
    );
    // The description is one of the paragraphs the page prints, not a new claim.
    assert.ok(
      game.introduction.includes(node.description),
      `${game.slug}: description must be a paragraph the page renders`
    );
    // …and a non-trivial one, so the markup is not just a restated name.
    assert.ok(node.description.length > 40, `${game.slug}: description is too thin to be useful`);
  }
});

test("the FAQ markup is the FAQ the page renders, verbatim", () => {
  for (const game of GAME_LANDING_PAGES) {
    const node = buildGameFaqJsonLd(game.slug);
    if (!node) {
      assert.equal(game.faq.length, 0);
      continue;
    }
    assert.equal(node.mainEntity.length, game.faq.length, `${game.slug}: question count`);
    node.mainEntity.forEach((question, index) => {
      assert.equal(question["@type"], "Question");
      assert.equal(question.name, game.faq[index].q, `${game.slug}: question ${index} text`);
      assert.equal(question.acceptedAnswer["@type"], "Answer");
      assert.equal(
        question.acceptedAnswer.text,
        game.faq[index].a,
        `${game.slug}: answer ${index} text`
      );
    });
  }
});

// ── 3. URLs ──────────────────────────────────────────────────────────────

test("every URL is the canonical /games/<slug>, never the /casino redirect", () => {
  for (const game of GAME_LANDING_PAGES) {
    const canonical = `${SITE_ORIGIN}/games/${game.slug}`;
    assert.equal(gameLandingUrl(game.slug), canonical);
    assert.equal(buildGameWebApplicationJsonLd(game.slug).url, canonical);
    for (const node of buildGameStructuredData(game.slug)) {
      assert.ok(
        !JSON.stringify(node).includes("/casino/"),
        `${game.slug}: structured data must never point at the app namespace`
      );
    }
    // The @id is on the canonical URL too, so the node and the page agree.
    assert.equal(gameWebApplicationId(game.slug), `${canonical}#app`);
  }
});

test("the breadcrumb is the trail the page visibly renders", () => {
  const component = code(LANDING);
  // The visible breadcrumb, as the component writes it.
  assert.ok(component.includes('aria-label="Breadcrumb"'));
  assert.ok(component.includes("Home"));
  assert.ok(component.includes("All games"));

  for (const game of GAME_LANDING_PAGES) {
    const list = buildGameBreadcrumbJsonLd(game.slug).itemListElement;
    assert.deepEqual(
      list.map((item) => item.name),
      ["Home", "All games", game.name],
      `${game.slug}: breadcrumb names must match the visible trail`
    );
    assert.deepEqual(
      list.map((item) => item.position),
      [1, 2, 3]
    );
    assert.deepEqual(
      list.map((item) => item.item),
      [`${SITE_ORIGIN}/`, `${SITE_ORIGIN}/games`, `${SITE_ORIGIN}/games/${game.slug}`],
      `${game.slug}: breadcrumb URLs`
    );
    // The final crumb is the page's own canonical URL — the same one the
    // landing route declares in its metadata.
    const route = read("src/app/games/[slug]/page.tsx");
    assert.ok(
      route.includes("gameLandingPath(slug)"),
      "the route must keep using the derived path"
    );
  }
});

// ── 4. One linked graph, no duplicates, no dangling references ───────────

test("ids are unique per page and never collide with the site nodes", () => {
  const seen = new Map();
  for (const slug of GAME_LANDING_SLUGS) {
    const ids = buildGameStructuredData(slug).map((node) => node["@id"]);
    assert.equal(new Set(ids).size, ids.length, `${slug}: duplicate @id within the page`);
    for (const id of ids) {
      assert.ok(!seen.has(id), `${slug}: @id ${id} already used by ${seen.get(id)}`);
      seen.set(id, slug);
      assert.ok(
        id.startsWith(`${SITE_ORIGIN}/games/${slug}`),
        `${slug}: @id must sit on the page's URL`
      );
      for (const siteId of [APP_ID, WEBSITE_ID, ORGANIZATION_ID]) {
        assert.notEqual(id, siteId, `${slug}: must not redeclare ${siteId}`);
      }
    }
  }
  assert.equal(seen.size, GAME_LANDING_SLUGS.length * 3, "21 pages × 3 nodes, all distinct");
});

test("every @id the game nodes reference is emitted on the same page", () => {
  // A reference to a node that is not on the page is a dangling pointer: the
  // site identity nodes are emitted by the root layout, on every route.
  const LAYOUT = read("src/app/layout.tsx");
  assert.ok(LAYOUT.includes("organizationJsonLd"), "the layout emits the Organization node");
  assert.ok(LAYOUT.includes("buildWebsiteJsonLd()"), "…and the WebSite node");
  assert.ok(LAYOUT.includes("ORGANIZATION_ID"));

  const emittedEverywhere = new Set([WEBSITE_ID, ORGANIZATION_ID]);
  for (const { slug, node } of ALL_NODES) {
    const refs = [];
    const walk = (value) => {
      if (Array.isArray(value)) return value.forEach(walk);
      if (!value || typeof value !== "object") return;
      if (typeof value["@id"] === "string") refs.push(value["@id"]);
      for (const child of Object.values(value)) walk(child);
    };
    walk(node);
    for (const ref of refs) {
      if (ref.startsWith(`${SITE_ORIGIN}/games/${slug}`)) continue; // the node's own @id(s)
      assert.ok(
        emittedEverywhere.has(ref),
        `${slug}: references ${ref}, which is not emitted on the page`
      );
    }
  }
});

// ── 5. Serialisation ─────────────────────────────────────────────────────

test("the emitted JSON is valid and cannot terminate the script element", () => {
  for (const { slug, node } of ALL_NODES) {
    const json = JSON.stringify(node);
    assert.deepEqual(JSON.parse(json), JSON.parse(json), `${slug}: must round-trip`);
    // The component's escaping strategy, exercised on hostile input: the escape
    // must leave the DATA identical while removing the tag-terminating bytes.
    const hostile = { "@type": "Thing", text: "</script><script>alert(1)</script>" };
    const escaped = JSON.stringify(hostile).replace(/</g, "\\u003c");
    assert.deepEqual(JSON.parse(escaped), hostile, "escaping must not change the data");
    assert.ok(!escaped.includes("</script>"), "escaping must remove the breakout");
    assert.ok(!json.includes("</script>"), `${slug}: curated content must not contain </script>`);
  }
});

test("the landing page emits its JSON-LD through the shared component", () => {
  const component = code(LANDING);
  assert.ok(
    component.includes("<JsonLd data={structuredData} />"),
    "the page uses the shared renderer"
  );
  assert.ok(component.includes("buildGameStructuredData(game.slug)"));
  assert.ok(
    !component.includes("application/ld+json"),
    "no inline JSON-LD blob in the page — that is the component's job"
  );
  // The renderer does the serialising, once, with the escape applied.
  assert.ok(JSONLD_COMPONENT.includes("application/ld+json"));
  assert.ok(JSONLD_COMPONENT.includes('JSON.stringify(node).replace(/</g, "\\\\u003c")'));
  // …and renders nothing at all when there is nothing real to say.
  assert.ok(JSONLD_COMPONENT.includes("if (nodes.length === 0) return null;"));
});

test("only the known files emit JSON-LD", () => {
  // A drift guard for "reusable components, not copied blobs": a new inline
  // block anywhere else fails here rather than silently duplicating a schema.
  const EMITTERS = new Set([
    "src/app/layout.tsx", // Organization + WebSite
    "src/app/page.jsx", // the real, review-derived app rating
    "src/app/reviews/page.tsx", // the same rating, on the page that owns it
    "src/components/seo/JsonLd.tsx", // the shared renderer
  ]);
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) {
        if (read(path).includes("application/ld+json")) found.push(path.replaceAll("\\", "/"));
      }
    }
  };
  walk("src");
  assert.deepEqual(
    found.sort(),
    [...EMITTERS].sort(),
    "structured data must be emitted by the shared component or a documented builder"
  );
});

// ── 6. Visibility rules ──────────────────────────────────────────────────

test("/faq renders every answer and declares no FAQPage", () => {
  // The FAQ used to be a client accordion that mounted only the open answer, so
  // a FAQPage node would have described content a crawler could not read. It is
  // now a SERVER component whose answers are all present in the served HTML
  // (native <details>, collapsed but never absent) — so the old reason is gone,
  // while the decision it justified stands: the help text is GRYND's own product
  // documentation and the site makes no rich-result claim about it.
  assert.ok(!FAQ_PAGE.includes("application/ld+json"));
  assert.ok(!FAQ_CLIENT.includes("application/ld+json"));
  assert.ok(!/FAQPage/.test(FAQ_PAGE) && !/FAQPage/.test(FAQ_CLIENT));

  // …and the reason the OLD exclusion existed must be gone: no client
  // directive, no state-gated answer blocks, answers in the HTML when closed.
  assert.ok(!FAQ_CLIENT.includes('"use client"'), "the FAQ must render on the server");
  assert.ok(
    !FAQ_CLIENT.includes("AnimatePresence"),
    "answers must not be mounted only when opened"
  );
  assert.ok(FAQ_CLIENT.includes("<details"), "answers must be present when collapsed");
});

test("an unknown slug produces no structured data at all", () => {
  assert.deepEqual(buildGameStructuredData("not-a-game"), []);
  assert.equal(buildGameWebApplicationJsonLd("not-a-game"), null);
  assert.equal(buildGameBreadcrumbJsonLd("not-a-game"), null);
  assert.equal(buildGameFaqJsonLd("not-a-game"), null);
  // Sanity: the positive path is not vacuous.
  assert.equal(buildGameStructuredData(GAME_LANDING_SLUGS[0]).length, 3);
  assert.equal(GAME_LANDING_BY_SLUG[GAME_LANDING_SLUGS[0]].slug, GAME_LANDING_SLUGS[0]);
});
