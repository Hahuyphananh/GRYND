/**
 * internal-linking.test.mjs
 *
 * Guards the site's crawlable hierarchy:
 *
 *     /  →  /games  →  /games/<slug>  →  /games/<slug>/play
 *
 * Every public game has a landing page, and the point of this suite is that a
 * search engine (or a visitor with JavaScript disabled) can REACH every one of
 * them by following ordinary anchors — no click handlers, no client state, no
 * buttons standing in for links.
 *
 * The invariants, in the order they are checked below:
 *
 *   1. /games links to EVERY public game landing page. The interactive card
 *      grid is client-filtered, so the guarantee is carried by the A–Z
 *      directory, which is projected from the game catalogue (GAME_INDEX) and
 *      therefore cannot miss a game nobody remembered to add a card for.
 *   2. The card grid links to the canonical landing URL (/games/<slug>), not
 *      to /casino/<slug> — that old href is the same page one 308 redirect
 *      later, and a redirect in the middle of the hierarchy is the thing this
 *      change removed.
 *   3. Each landing page carries breadcrumbs, a link back to /games, related
 *      game links and links to the informational pages its prose makes
 *      relevant.
 *   4. The home page links to the popular games by name.
 *   5. The help/FAQ page links to games by name, in markup that exists before
 *      any accordion is opened.
 *   6. None of those surfaces links into the app namespace (/casino/…) or to a
 *      /play URL except through the landing page's own Play CTA.
 *
 * Run: npm run test:internal-linking
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  GAME_INDEX,
  GAME_LANDING_PAGES,
  GAME_LANDING_SLUGS,
  HELP_FEATURED_SLUGS,
  HOMEPAGE_FEATURED_SLUGS,
  gameIndexFor,
  gameLandingPath,
  gamePlayPath,
} from "../src/lib/gameLandingPages.ts";

const read = (rel) => readFileSync(rel, "utf8");

// CRLF is normalised BEFORE the comment strip, so the `^…$` line regex sees a
// plain \n — most files in this repo are CRLF, and `$` also matches before \r.
const strip = (source) => source.replace(/\r\n/g, "\n");

// LINE comments are removed FIRST, and that order is load-bearing: the hub has a
// `//` line comment mentioning `src/app/casino/*`, and stripping block comments
// first would read that `/*` as an opener and swallow the whole games array.
// (tests/tic-tac-toe-ui-contract.test.mjs carries the same note for the same
// reason.) Comments are stripped so a commented-out href cannot satisfy a check.
function code(source) {
  return strip(source)
    .replace(/^[ \t]*\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

const HUB_CLIENT = read("src/app/casino/PageClient.jsx");
const HUB_PAGE = read("src/app/casino/page.jsx");
const HOME_CLIENT = read("src/app/PageClient.jsx");
const HOME_PAGE = read("src/app/page.jsx");
const FAQ_CLIENT = read("src/app/faq/PageClient.jsx");
const FAQ_PAGE = read("src/app/faq/page.jsx");
const LANDING = read("src/components/game-landing/GameLanding.tsx");
const TAGS = read("src/lib/gameTags.js");

const ALL_SLUGS = new Set(GAME_LANDING_SLUGS);

/**
 * The hub's card array, split into per-card slices.
 *
 * Deliberately NOT split on the `{` that opens a card: that brace is indented
 * by hand, and one card in this file does not sit on a `\n    {` boundary, so an
 * indentation-based split silently merges two games (and “inherits” the other
 * card's `popular: true`). A card's fields all follow its `href`, so the next
 * `href` is the reliable end of the current card.
 */
function hubCards() {
  const src = code(HUB_CLIENT);
  const start = src.indexOf("const games = [");
  assert.ok(start > 0, "the hub's card array must exist");
  const end = src.indexOf("\n  ];", start);
  assert.ok(end > start, "the hub's card array must be readable");
  const block = src.slice(start, end);
  const hrefs = [...block.matchAll(/href: \"([^\"]+)\"/g)];
  return hrefs.map((match, index) =>
    block.slice(match.index, hrefs[index + 1]?.index ?? block.length),
  );
}

/** The `href: "/games/<slug>"` entries of the hub's card array. */
function hubCardSlugs() {
  return [...code(HUB_CLIENT).matchAll(/href:\s*"\/games\/([a-z0-9-]+)"/g)].map(
    (match) => match[1],
  );
}

/** Card hrefs for the games the lobby itself flags `popular: true`. */
function lobbyPopularSlugs() {
  return hubCards()
    .filter((card) => /\bpopular:\s*true\b/.test(card))
    .map((card) => /href: "\/games\/([a-z0-9-]+)"/.exec(card)?.[1])
    .filter(Boolean)
    .sort();
}

// ── 1. /games reaches every public game ──────────────────────────────────

test("the A–Z directory is the whole catalogue, not a hand-kept list", () => {
  // It is derived from GAME_LANDING_PAGES, so this is the derivation, not a
  // second list: adding a game to the catalogue adds it here.
  assert.equal(GAME_INDEX.length, GAME_LANDING_PAGES.length);
  assert.deepEqual(
    [...GAME_INDEX.map((game) => game.slug)].sort(),
    [...GAME_LANDING_SLUGS].sort(),
    "a game in the catalogue is missing from the crawlable index",
  );
  // A–Z, so the rendered order cannot churn between deploys.
  const names = GAME_INDEX.map((game) => game.name);
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)));
});

test("/games renders the whole catalogue as real links", () => {
  const src = code(HUB_CLIENT);
  const page = code(HUB_PAGE);

  // The directory is fed from the catalogue on the server …
  assert.match(page, /import \{[^}]*\bGAME_INDEX\b[^}]*\} from "\.\.\/\.\.\/lib\/gameLandingPages"/);
  assert.match(page, /const gameIndex = GAME_INDEX\.map\(/);
  // (the prop list also carries a JSX ad slot, so the match cannot stop at `>`)
  assert.match(page, /<PageClient[\s\S]{0,200}?gameIndex=\{gameIndex\}/);

  // … and rendered as anchors on that prop, one per entry, pointing at the
  // landing page. `${game.slug}` is what makes it total: the template cannot
  // name a game the catalogue does not have, and cannot omit one it does.
  const nav = src.slice(src.indexOf('id="all-games-index-heading"'));
  assert.ok(nav.length > 0, "the A–Z directory heading must exist");
  const block = nav.slice(0, nav.indexOf("</nav>"));
  assert.match(block, /\{gameIndex\.map\(\(game\) => \(/);
  assert.match(block, /<Link\s+href=\{`\/games\/\$\{game\.slug\}`\}/);
  assert.match(block, /\{game\.name\}/);
  // It is inside a <nav>, so it reads as navigation rather than content.
  assert.match(src, /<nav\s+aria-labelledby="all-games-index-heading"/);

  // The directory is what covers the alias page too — the one game the card
  // grid does not have a card for.
  const cards = new Set(hubCardSlugs());
  const uncovered = [...ALL_SLUGS].filter((slug) => !cards.has(slug));
  assert.deepEqual(
    uncovered.sort(),
    ["uno"],
    "the card grid is expected to be one card short of the catalogue (the " +
      "uno/neon-flush alias pair share a game); anything else means the " +
      "directory is now load-bearing for games nobody noticed",
  );
  assert.ok(
    GAME_INDEX.some((game) => game.slug === "uno"),
    "the alias page must be in the A–Z directory",
  );
});

// ── 2. The hub links the landing pages, not the redirect ─────────────────

test("every hub card links to the canonical /games/<slug> landing URL", () => {
  const cards = hubCardSlugs();
  assert.equal(
    new Set(cards).size,
    cards.length,
    "two cards point at the same game page",
  );
  for (const slug of cards) {
    assert.ok(ALL_SLUGS.has(slug), `hub card links a game with no landing page: ${slug}`);
  }
  // The old namespace must be gone from the card array: /casino/<slug> is the
  // same page one redirect later, and a redirect between /games and the
  // landing page is exactly what this hierarchy removes.
  const cardBlock = code(HUB_CLIENT).slice(
    code(HUB_CLIENT).indexOf("const games = ["),
    code(HUB_CLIENT).indexOf("\n  ];", code(HUB_CLIENT).indexOf("const games = [")),
  );
  assert.doesNotMatch(
    cardBlock,
    /href:\s*"\/casino\//,
    "a hub card still links the /casino/<slug> redirect instead of the landing page",
  );
  // …and the anchors are real: `href={game.href}` on a Next <Link>.
  assert.match(
    code(HUB_CLIENT),
    /<Link[\s\S]{0,180}href=\{game\.href\}/,
    "the hub card must be a <Link> with the game's href",
  );
});

test("the tag catalogue links the same URLs as the hub", () => {
  // GAME_CATALOG is the shared registry the recommendation engine renders links
  // from, and tests/game-recommendations.test.mjs asserts it mirrors the hub
  // card for card. Both sides therefore have to agree on WHICH URL a game link
  // is, or one of the two surfaces sends people into a redirect.
  const hrefs = [...code(TAGS).matchAll(/href:\s*"(https?:[^"]*|\/[^"]+)"/g)].map(
    (match) => match[1],
  );
  const appNamespace = hrefs.filter((href) => href.startsWith("/casino/"));
  assert.deepEqual(
    appNamespace,
    [],
    "the tag catalogue still points at the /casino/<slug> redirect",
  );
  for (const href of hrefs) {
    assert.match(href, /^\/games\/[a-z0-9-]+$/, `unexpected catalogue href: ${href}`);
    assert.ok(ALL_SLUGS.has(href.replace("/games/", "")), `no landing page for ${href}`);
  }
});

// ── 3. The landing page ──────────────────────────────────────────────────

test("a landing page carries breadcrumbs, a hub link and related games", () => {
  const src = code(LANDING);
  // Breadcrumb: Home > All games > this game, all real links.
  assert.match(src, /aria-label="Breadcrumb"/);
  assert.match(src, /<Link href="\/" className=[^>]*>\s*Home\s*<\/Link>/);
  assert.match(src, /<Link\s+href="\/games"/);
  assert.match(src, /aria-current="page"/);
  // A second, explicit way back to the hub.
  assert.match(src, /Browse all games/);
  // Related games, resolved through the catalogue path helper.
  assert.match(src, /href=\{gameLandingPath\(entry\.slug\)\}/);
  // Exactly one way into gameplay, and it is the rewritten play URL.
  assert.match(src, /const playHref = gamePlayPath\(game\.slug\);/);
  assert.equal(
    [...src.matchAll(/href=\{playHref\}/g)].length,
    2,
    "the hero and the closing CTA are the only routes into gameplay",
  );
});

test("a landing page links the informational pages its prose makes relevant", () => {
  const src = code(LANDING);
  for (const href of ["/faq", "/fair-play", "/classement"]) {
    assert.match(
      src,
      new RegExp(`href="${href}"`),
      `the landing page should link ${href}`,
    );
  }
  // A small, contextual set — not a link farm.
  const infoLinks = [...src.matchAll(/href="(\/[a-z0-9-]+)"/g)].map((match) => match[1]);
  assert.ok(
    infoLinks.length <= 6,
    `expected a handful of informational links, found ${infoLinks.length}`,
  );
  // And it must not link into the app namespace at all.
  assert.doesNotMatch(src, /href="\/casino\//);
  assert.doesNotMatch(src, /href=\{game\.href\}/);
});

test("gamePlayPath is the only public path into gameplay", () => {
  for (const slug of GAME_LANDING_SLUGS) {
    assert.equal(gameLandingPath(slug), `/games/${slug}`);
    assert.equal(gamePlayPath(slug), `/games/${slug}/play`);
  }
});

// ── 4. The home page ─────────────────────────────────────────────────────

test("the home page links the popular games by name", () => {
  const page = code(HOME_PAGE);
  const client = code(HOME_CLIENT);

  assert.match(page, /import \{[\s\S]{0,120}HOMEPAGE_FEATURED_SLUGS/);
  assert.match(page, /const popularGames = gameIndexFor\(HOMEPAGE_FEATURED_SLUGS\);/);
  assert.match(page, /<PageClient[\s\S]{0,200}?popularGames=\{popularGames\}/);

  const nav = client.slice(client.indexOf('aria-labelledby="home-popular-games"'));
  assert.ok(nav.length > 0, "the home page popular-games nav must exist");
  const block = nav.slice(0, nav.indexOf("</nav>"));
  assert.match(block, /popularGames\.map\(\(game\) => \(/);
  assert.match(block, /href=\{`\/games\/\$\{game\.slug\}`\}/);
});

test("the featured lists name real games and stay in sync with the lobby", () => {
  // Every curated slug resolves — a typo would silently render nothing.
  assert.equal(gameIndexFor(HOMEPAGE_FEATURED_SLUGS).length, HOMEPAGE_FEATURED_SLUGS.length);
  assert.equal(gameIndexFor(HELP_FEATURED_SLUGS).length, HELP_FEATURED_SLUGS.length);
  for (const slug of [...HOMEPAGE_FEATURED_SLUGS, ...HELP_FEATURED_SLUGS]) {
    assert.ok(ALL_SLUGS.has(slug), `${slug} has no landing page`);
  }

  // "Most popular" is the lobby's own `popular: true` signal — not a second
  // opinion invented for the home page. If the lobby changes its mind, this
  // fails rather than quietly claiming something else is most popular.
  const popular = lobbyPopularSlugs();
  assert.ok(popular.length > 0, "the lobby must flag its popular games");
  assert.deepEqual(
    [...HOMEPAGE_FEATURED_SLUGS].sort(),
    popular,
    "HOMEPAGE_FEATURED_SLUGS must be exactly the lobby's popular games",
  );
});

// ── 5. The help/FAQ page ─────────────────────────────────────────────────

test("the FAQ links games in markup that exists before any click", () => {
  const page = code(FAQ_PAGE);
  const client = code(FAQ_CLIENT);

  assert.match(page, /import \{ HELP_FEATURED_SLUGS, gameIndexFor \}/);
  assert.match(page, /const helpGames = gameIndexFor\(HELP_FEATURED_SLUGS\);/);
  assert.match(page, /<PageClient helpGames=\{helpGames\} \/>/);

  assert.match(client, /export default function FaqPage\(\{ helpGames = \[\] \}\)/);
  const section = client.slice(client.indexOf('id="faq-games-heading"'));
  assert.ok(section.length > 0, "the FAQ games section must exist");
  const block = section.slice(0, section.indexOf("</ul>"));
  assert.match(block, /helpGames\.map\(\(game\) => \(/);
  assert.match(block, /href=\{`\/games\/\$\{game\.slug\}`\}/);
  // Plus the hub itself and the fairness policy the answers keep referring to.
  assert.match(section, /href="\/games"/);
  assert.match(section, /href="\/fair-play"/);
});

test("the FAQ's game section is not inside the accordion", () => {
  const client = code(FAQ_CLIENT);
  const block = client.slice(
    client.indexOf('id="faq-games-heading"'),
    client.indexOf("Still have questions?"),
  );
  // An accordion answer is only in the HTML once its item is open; a game link
  // rendered that way is invisible to a crawler and to a visitor who has not
  // clicked. The section must be outside every `{open && …}` branch.
  assert.doesNotMatch(block, /\{open\s*&&/, "the games section must not be accordion content");
  assert.match(client, /\{helpGames\.length > 0 && \(/, "the section renders off its own list");
});

// ── 6. No JavaScript-only navigation ─────────────────────────────────────

test("the new game links are anchors, not click handlers", () => {
  // Each surface renders a link element with an href. A span/div/button with an
  // onClick would pass a visual review and fail a crawler, so the shape is
  // asserted directly.
  const surfaces = [
    ["hub A–Z directory", HUB_CLIENT, 'id="all-games-index-heading"', "</nav>"],
    ["home popular games", HOME_CLIENT, 'aria-labelledby="home-popular-games"', "</nav>"],
    // The FAQ is a server component now (native <details> accordion), so the
    // games block closes on a plain </section> rather than a motion wrapper.
    ["FAQ games", FAQ_CLIENT, 'id="faq-games-heading"', "</section>"],
  ];
  for (const [label, source, anchor, close] of surfaces) {
    const src = code(source);
    const start = src.indexOf(anchor);
    assert.ok(start > 0, `${label}: anchor not found`);
    const end = src.indexOf(close, start);
    assert.ok(end > start, `${label}: the link block must be a closed container`);
    const block = src.slice(start, end);
    assert.match(block, /<Link/, `${label}: game links must be <Link> components`);
    assert.doesNotMatch(
      block,
      /onClick=/,
      `${label}: a click handler is not a link`,
    );
    assert.doesNotMatch(
      block,
      /router\.push/,
      `${label}: client-side navigation is not a crawlable link`,
    );
  }
});
