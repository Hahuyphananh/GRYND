import {
  GAME_LANDING_BY_SLUG,
  SITE_ORIGIN,
  gameLandingPath,
  gameLandingUrl,
  type GameLandingPage,
} from "./gameLandingPages";
import { ORGANIZATION_ID, WEBSITE_ID, type JsonLdNode } from "./reviewJsonLd";

/**
 * Structured data for the PUBLIC game landing pages (/games/<slug>).
 *
 * Three rules this file exists to enforce, matching the ones the review markup
 * already follows (src/lib/reviewJsonLd.ts):
 *
 * 1. ONLY WHAT THE PAGE SHOWS. `name`, `description` and `genre` are read out
 *    of the same catalogue fields the component renders, so the markup cannot
 *    describe a game differently from the page a visitor reads. The breadcrumb
 *    mirrors the visible breadcrumb, and the FAQ questions are the visible
 *    questions. `tests/game-structured-data.test.mjs` pins those links, and
 *    qa/ai-search-raw-html.mjs checks the rendered HTML agrees.
 *
 * 2. NO INVENTED RATINGS, REVIEWS OR PRICES. There is no `aggregateRating`, no
 *    `review` and no `offers` node here, and there is no code path that can add
 *    one: nothing on a game page states a score, a review count or a price, so
 *    claiming any of them would be a false claim about the page. The one real
 *    rating on the site is the player rating of GRYND itself, which lives on
 *    the pages that actually own those reviews.
 *
 * 3. ONE URL PER GAME, THE CANONICAL ONE. Every `url`/`item` is built with
 *    `gameLandingUrl()` → `https://grynd.dedyn.io/games/<slug>`. Nothing here
 *    can point at `/casino/<slug>`, which is the same page one redirect later:
 *    `gameLandingPath`/`gameLandingUrl` are the only path builders the landing
 *    pages have, and a test asserts the app namespace never appears.
 *
 * The page's own identity nodes (Organization, WebSite) are emitted by
 * src/app/layout.tsx on every route, so the game nodes reference them by `@id`
 * — the whole thing reads as one linked graph rather than unrelated claims,
 * and every reference resolves to a node that is on the same page.
 */

const SCHEMA = "https://schema.org";

/**
 * The `@id` of a game's own application node.
 *
 * Same `#app` fragment convention as the site-level node (APP_ID in
 * src/lib/reviewJsonLd.ts), on the game's own canonical URL — so the two are
 * distinct IRIs and neither can be mistaken for the other.
 */
export function gameWebApplicationId(slug: string): string {
  return `${gameLandingUrl(slug)}#app`;
}

function lookup(slug: string): GameLandingPage | null {
  return GAME_LANDING_BY_SLUG[slug] ?? null;
}

/**
 * The game itself, as a `WebApplication` (a browser Playable, not an
 * installable package — schema.org's SoftwareApplication subtype for exactly
 * this case), with `isPartOf` naming the site node.
 *
 * Deliberately carries NO rating, review or offer. `genre` is the visible
 * category badge and `description` is the page's own opening paragraph; both
 * are read from the catalogue the component renders from.
 */
export function buildGameWebApplicationJsonLd(slug: string): JsonLdNode | null {
  const game = lookup(slug);
  if (!game) return null;
  // The first visible paragraph of the page. Falling back to the summary keeps
  // the function total, but a game page always renders an introduction — the
  // catalogue test asserts every entry has one.
  const description = game.introduction[0] ?? game.shortDescription;

  return {
    "@context": SCHEMA,
    "@type": "WebApplication",
    "@id": gameWebApplicationId(slug),
    name: game.name,
    description,
    url: gameLandingUrl(slug),
    applicationCategory: "GameApplication",
    operatingSystem: "Web browser",
    inLanguage: "en",
    // The badge at the top of the page, verbatim.
    genre: game.category,
    isPartOf: { "@id": WEBSITE_ID },
    publisher: { "@id": ORGANIZATION_ID },
  };
}

/**
 * The page's position in the site, mirroring the visible breadcrumb:
 * Home → All games → <game>.
 *
 * The names and the order are exactly what the `<nav aria-label="Breadcrumb">`
 * renders, and the final item's URL is the page's own canonical URL — a
 * breadcrumb that disagreed with the visible trail would be worse than none.
 */
export function buildGameBreadcrumbJsonLd(slug: string): JsonLdNode | null {
  const game = lookup(slug);
  if (!game) return null;

  const trail: { name: string; path: string }[] = [
    { name: "Home", path: "/" },
    { name: "All games", path: "/games" },
    { name: game.name, path: gameLandingPath(slug) },
  ];

  return {
    "@context": SCHEMA,
    "@type": "BreadcrumbList",
    "@id": `${gameLandingUrl(slug)}#breadcrumb`,
    itemListElement: trail.map((step, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: step.name,
      // Absolute URLs on the canonical origin, including the root.
      item: step.path === "/" ? `${SITE_ORIGIN}/` : `${SITE_ORIGIN}${step.path}`,
    })),
  };
}

/**
 * The game's own FAQ — built from the SAME entries the component renders, so
 * the markup cannot claim a question the page does not ask, and the page cannot
 * gain a question the markup omits.
 *
 * Returns null for a game with no FAQ: an empty FAQPage node describes nothing
 * and is exactly the kind of markup that gets distrusted. (This is the
 * "FAQPage only when the FAQ content is actually visible" rule. It is also why
 * /faq gets no FAQPage: its answers live inside an accordion, so a crawler
 * receives only the open one.)
 */
export function buildGameFaqJsonLd(slug: string): JsonLdNode | null {
  const game = lookup(slug);
  if (!game || game.faq.length === 0) return null;

  return {
    "@context": SCHEMA,
    "@type": "FAQPage",
    "@id": `${gameLandingUrl(slug)}#faq`,
    isPartOf: { "@id": WEBSITE_ID },
    mainEntity: game.faq.map((entry) => ({
      "@type": "Question",
      name: entry.q,
      acceptedAnswer: { "@type": "Answer", text: entry.a },
    })),
  };
}

/**
 * Everything a game landing page declares, as independent nodes.
 *
 * An array of nodes rather than one nested document so each block has its own
 * `@id` and `@context`, matching how the root layout emits the site identity —
 * and so a node that has nothing to say (a game without an FAQ) simply does not
 * appear.
 */
export function buildGameStructuredData(slug: string): JsonLdNode[] {
  return [
    buildGameWebApplicationJsonLd(slug),
    buildGameBreadcrumbJsonLd(slug),
    buildGameFaqJsonLd(slug),
  ].filter((node): node is JsonLdNode => Boolean(node));
}
