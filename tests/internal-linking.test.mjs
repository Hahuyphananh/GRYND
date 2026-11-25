/**
 * internal-linking.test.mjs
 *
 * Guards the site's crawlable hierarchy for a one-game platform:
 *
 *     /  →  /games  →  /games/solitaire-duel  →  /games/solitaire-duel/play
 *
 * The hub is the part this suite exists for. It used to be a next.config.js
 * rewrite to /casino, and /casino redirects to /games/solitaire-duel — so the
 * URL the sitemap lists at priority 0.9 answered with a 200 shell, a generic
 * layout title, `noindex` and a soft redirect. /games is now a real App Router
 * page, and these assertions keep it that way:
 *
 *   1. /games is a server-rendered page with its own canonical metadata, not a
 *      rewrite, a redirect or a client-only shell.
 *   2. It links EVERY available game landing page from GAME_INDEX, so a
 *      crawler (or a visitor without JavaScript) can reach them all with
 *      ordinary anchors.
 *   3. The landing page carries breadcrumbs, a hub link, gameplay CTAs and the
 *      informational pages its prose makes relevant.
 *   4. The home page and the FAQ link the real pages, not the app namespace.
 *   5. Nothing public links `/casino/*` — that is a redirect, not a destination.
 *
 * Run: npm run test:internal-linking
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  GAME_CARDS,
  GAME_INDEX,
  GAME_LANDING_SLUGS,
  HOMEPAGE_FEATURED_SLUGS,
  gameIndexFor,
  gameLandingPath,
  gamePlayPath,
} from "../src/lib/gameLandingPages.ts";
import { isGameAvailable } from "../src/lib/gameAvailability.js";

const read = (rel) => readFileSync(rel, "utf8");

// CRLF is normalised BEFORE comments are stripped — most files in this repo
// are CRLF. Stripping comments keeps a commented-out href from satisfying a
// check.
const strip = (source) => source.replace(/\r\n/g, "\n");
function code(source) {
  return strip(source)
    .replace(/^[ \t]*\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

const HUB = read("src/app/games/page.tsx");
const HOME_CLIENT = read("src/app/PageClient.jsx");
const HOME_PAGE = read("src/app/page.jsx");
const FAQ_CLIENT = read("src/app/faq/PageClient.jsx");
const FAQ_PAGE = read("src/app/faq/page.jsx");
const CLASSEMENT_CLIENT = read("src/app/classement/PageClient.jsx");
const LANDING = read("src/components/game-landing/GameLanding.tsx");

const AVAILABLE = GAME_LANDING_SLUGS.filter((slug) => isGameAvailable(slug));

// ── 1. The hub is a real page ─────────────────────────────────────────────

test("the hub is a real, server-rendered page — not a rewrite", () => {
  const src = code(HUB);
  assert.doesNotMatch(src, /"use client"/, "the hub must render on the server");
  assert.doesNotMatch(src, /\bredirect\(/, "the hub must not redirect");
  assert.doesNotMatch(src, /robots:/, "the hub must not be noindex");
  assert.match(src, /export const metadata/, "the hub must own its metadata");
  assert.match(src, /path: "\/games"/, "the hub must be canonical to /games");

  // And no config rewrite may shadow the page.
  const config = read("next.config.js");
  const rewrites = config.slice(
    config.indexOf("async rewrites()"),
    config.indexOf("async redirects()"),
  );
  assert.doesNotMatch(
    rewrites,
    /source:\s*"\/games"/,
    "/games is rewritten in next.config.js — the real page would never be reached",
  );
});

test("/games links every available game landing page", () => {
  const src = code(HUB);
  assert.match(src, /GAME_INDEX\.map\(/, "the directory must come from the catalogue");
  assert.match(src, /href=\{gameLandingPath\(game\.slug\)\}/, "each entry must be a real link");
  assert.match(src, /\{game\.name\}/, "each link must name the game");
  assert.doesNotMatch(src, /href="\/casino\//, "the hub must not link the app namespace");
});

test("the hub directory is the catalogue, not a hand-kept list", () => {
  assert.equal(GAME_INDEX.length, AVAILABLE.length);
  assert.deepEqual(
    [...GAME_INDEX.map((game) => game.slug)].sort(),
    [...AVAILABLE].sort(),
    "an available game is missing from the hub directory",
  );
  // A–Z, so the rendered order cannot churn between deploys.
  const names = GAME_INDEX.map((game) => game.name);
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)));
});

// ── 2. Canonical game paths ───────────────────────────────────────────────

test("gamePlayPath is the only public path into gameplay", () => {
  for (const slug of GAME_LANDING_SLUGS) {
    assert.equal(gameLandingPath(slug), `/games/${slug}`);
    assert.equal(gamePlayPath(slug), `/games/${slug}/play`);
  }
});

// ── 3. The landing page ───────────────────────────────────────────────────

test("a landing page carries breadcrumbs, a hub link and gameplay CTAs", () => {
  const src = code(LANDING);
  assert.match(src, /aria-label="Breadcrumb"/);
  assert.match(src, /<Link href="\/" className=[^>]*>\s*Home\s*<\/Link>/);
  assert.match(src, /<Link\s+href="\/games"/);
  assert.match(src, /aria-current="page"/);
  assert.match(src, /Browse all games/);
  assert.match(src, /href=\{gameLandingPath\(entry\.slug\)\}/);
  // Two links into gameplay, both the rewritten play URL (the hero and the
  // closing CTA). The practice entry is a POST, not an href.
  assert.match(src, /const playHref = gamePlayPath\(game\.slug\);/);
  assert.equal(
    [...src.matchAll(/href=\{playHref\}/g)].length,
    2,
    "the hero and the closing CTA are the only linked routes into gameplay",
  );
  assert.doesNotMatch(src, /href=\{gameMatchPath/);
});

test("a landing page links the informational pages its prose makes relevant", () => {
  const src = code(LANDING);
  for (const href of ["/faq", "/fair-play", "/classement"]) {
    assert.match(src, new RegExp(`href="${href}"`), `the landing page should link ${href}`);
  }
  const infoLinks = [...src.matchAll(/href="(\/[a-z0-9-]+)"/g)].map((match) => match[1]);
  assert.ok(infoLinks.length <= 6, `expected a handful of informational links, found ${infoLinks.length}`);
  assert.doesNotMatch(src, /href="\/casino\//);
});

// ── 4. The home page ─────────────────────────────────────────────────────

test("the home page leads with Solitaire and links its real pages", () => {
  const page = code(HOME_PAGE);
  const client = code(HOME_CLIENT);

  assert.doesNotMatch(page, /HOMEPAGE_FEATURED_SLUGS/);
  assert.match(page, /The competitive home of Solitaire/);
  assert.match(client, /href="\/games\/solitaire-duel"/);
  assert.match(client, /href="\/classement"/);
});

test("the featured list names real, available games", () => {
  assert.ok(HOMEPAGE_FEATURED_SLUGS.length > 0, "the home page features nothing");
  assert.equal(gameIndexFor(HOMEPAGE_FEATURED_SLUGS).length, HOMEPAGE_FEATURED_SLUGS.length);
  for (const slug of HOMEPAGE_FEATURED_SLUGS) {
    assert.ok(GAME_LANDING_SLUGS.includes(slug), `${slug} has no landing page`);
    assert.ok(isGameAvailable(slug), `${slug} is not an available game`);
  }
});

// ── 5. The help/FAQ page ─────────────────────────────────────────────────

test("the FAQ links every game's public page, in markup that exists before any click", () => {
  const page = code(FAQ_PAGE);
  const client = code(FAQ_CLIENT);

  assert.match(page, /import \{ GAME_CARDS \} from "\.\.\/\.\.\/lib\/gameLandingPages"/);
  assert.match(page, /<PageClient gameCards=\{GAME_CARDS\} \/>/);

  assert.match(client, /export default function FaqPage\(\{ gameCards = \[\] \}\)/);
  const section = client.slice(client.indexOf('id="faq-games-heading"'));
  assert.ok(section.length > 0, "the FAQ games section must exist");
  const block = section.slice(0, section.indexOf("</section>"));
  assert.match(block, /gameCards\.map\(\(card\) => \(/);
  assert.match(block, /<Link/);
  assert.match(block, /href=\{card\.href\}/);
  assert.doesNotMatch(block, /onClick=/, "a click handler is not a link");
});

test("the FAQ directory is the whole available catalogue", () => {
  assert.equal(GAME_CARDS.length, AVAILABLE.length);
  assert.deepEqual(
    [...GAME_CARDS.map((card) => card.slug)].sort(),
    [...AVAILABLE].sort(),
    "an available game has no card on the FAQ",
  );
  for (const card of GAME_CARDS) {
    assert.equal(card.href, `/games/${card.slug}`);
    assert.equal(gameLandingPath(card.slug), card.href);
    assert.notEqual(card.href, gamePlayPath(card.slug));
    assert.ok(card.shortDescription.trim().length > 80, `${card.slug} has no usable card blurb`);
  }
});

// ── 6. No JavaScript-only navigation into the app namespace ──────────────

test("no public surface links the /casino app namespace", () => {
  const surfaces = [
    ["hub", HUB],
    ["landing", LANDING],
    ["home", HOME_CLIENT],
    ["faq", FAQ_CLIENT],
    ["leaderboard", CLASSEMENT_CLIENT],
  ];
  for (const [label, source] of surfaces) {
    assert.doesNotMatch(
      code(source),
      /href=\{?["']\/casino\//,
      `${label} links the /casino redirect instead of the canonical URL`,
    );
  }
});
