/**
 * game-landing-pages.test.mjs
 *
 * Guards the architecture that splits each game's PUBLIC page from its
 * AUTHENTICATED one:
 *
 *   /games/<slug>        a public, server-rendered, indexable landing page
 *   /games/<slug>/play   the existing Clerk-protected lobby (rewritten to
 *                        /casino/<slug>, entirely unchanged)
 *
 * Four things can silently break it, and each has its own section below:
 *
 *   1. CONTENT DRIFT. The 21 pages are rendered from ONE catalog, so a missing
 *      field, a duplicate slug or a stale "stake tokens" claim is a data bug,
 *      not a page bug. The catalog is also checked against the games that
 *      actually exist in src/app/casino, so a page can never be published for
 *      a game that isn't there — or for one that is.
 *   2. ROUTING REGRESSION. The landing page is only reachable because
 *      next.config.js no longer has a blanket `/games/:path*` rewrite. That
 *      exact catch-all was measured to win over the new route and serve the
 *      LOBBY at the landing-page URL, so its absence is asserted, not assumed.
 *   3. INDEXING. The landing page must be indexable and self-canonical; the
 *      lobby must be noindex. Two indexable pages for one game is the bug this
 *      split exists to prevent.
 *   4. AUTH IS NOT WEAKENED. Nothing here may put the landing content behind
 *      Clerk, and nothing may let a signed-out visitor start a match.
 *
 * Run:  npm run test:game-landing
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  GAME_LANDING_BY_SLUG,
  GAME_LANDING_PAGES,
  GAME_LANDING_SLUGS,
  gameLandingPath,
  gamePlayPath,
} from "../src/lib/gameLandingPages.ts";
import { PUBLIC_SEO_PATHS } from "../src/lib/seoPages.ts";
import { GAME_CATALOG } from "../src/lib/gameTags.js";

const read = (rel) => readFileSync(rel, "utf8");

const LOBBY_FILE = (slug) =>
  ["tsx", "jsx", "ts", "js"]
    .map((ext) => `src/app/casino/${slug}/page.${ext}`)
    .find((p) => existsSync(p)) || null;

/** Slugs with a real top-level lobby page (same rule the route tests use). */
function lobbySlugs() {
  return readdirSync("src/app/casino", { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((slug) => LOBBY_FILE(slug) !== null)
    .sort();
}

/** The `/games/<slug>` links the public hub card grid advertises. */
function hubSlugs() {
  const hub = read("src/app/casino/PageClient.jsx");
  return [...hub.matchAll(/href:\s*"\/games\/([a-z0-9-]+)"/g)].map((m) => m[1]).sort();
}

// ── 1. The catalog ────────────────────────────────────────────────────────

test("catalog: slugs are unique, and the index maps agree with the list", () => {
  assert.ok(GAME_LANDING_SLUGS.length >= 21, "expected every game to have a page");
  assert.equal(new Set(GAME_LANDING_SLUGS).size, GAME_LANDING_SLUGS.length, "duplicate slug");
  assert.equal(Object.keys(GAME_LANDING_BY_SLUG).length, GAME_LANDING_PAGES.length);
  for (const slug of GAME_LANDING_SLUGS) {
    assert.equal(GAME_LANDING_BY_SLUG[slug].slug, slug, "index key must match slug");
  }
});

test("catalog: every entry carries the full set of landing-page content", () => {
  for (const game of GAME_LANDING_PAGES) {
    const where = game.slug;
    for (const field of ["name", "headline", "category", "leaderboardKey", "ogImage", "shortDescription", "competitive"]) {
      assert.equal(typeof game[field], "string", `${where}.${field} must be a string`);
      assert.ok(game[field].trim().length > 0, `${where}.${field} must not be empty`);
    }
    // The H1 shape the brief asks for: "<Name> — <qualifier>".
    assert.ok(game.headline.includes("—"), `${where}.headline should be "<Name> — <qualifier>"`);
    assert.ok(
      game.shortDescription.length >= 80 && game.shortDescription.length <= 320,
      `${where}.shortDescription must be a usable meta description (${game.shortDescription.length} chars)`,
    );
    for (const field of ["introduction", "howToPlay", "rules", "scoring", "strategy"]) {
      assert.ok(Array.isArray(game[field]), `${where}.${field} must be an array`);
      assert.ok(game[field].length >= 2, `${where}.${field} needs real content, not one line`);
      // `scoring` is a table of values ("Wrong flag: −10.") rather than prose,
      // so it gets a shorter floor — but every entry must still say something.
      const min = field === "scoring" ? 12 : 20;
      for (const item of game[field]) {
        assert.ok(
          typeof item === "string" && item.trim().length >= min,
          `${where}.${field} has a stub: ${item}`,
        );
      }
    }
    assert.ok(game.faq.length >= 3, `${where} needs at least three FAQs`);
    for (const entry of game.faq) {
      assert.ok(entry.q.trim().endsWith("?"), `${where} FAQ question must be a question: ${entry.q}`);
      assert.ok(entry.a.trim().length > 40, `${where} FAQ answer is too short: ${entry.q}`);
    }
    assert.ok(game.related.length >= 3, `${where} should link to at least three related games`);
    assert.ok(!game.related.includes(game.slug), `${where} links to itself`);
    for (const related of game.related) {
      assert.ok(GAME_LANDING_BY_SLUG[related], `${where} links to unknown slug "${related}"`);
    }
  }
});

test("catalog: copy never claims anything is wagered (stakes are retired)", () => {
  // src/lib/games/stakes.js: STAKES_RETIRED — no match may move tokens, so any
  // sentence that talks about wagering must be the one saying there isn't any.
  //
  // "pot" is deliberately NOT on this list: pot is the billiards verb ("that pot
  // assigns groups", "the 8-ball") and the rules copy legitimately uses it.
  const NEGATED = /\b(no|not|never|nothing|without|cannot|can't|isn't)\b/i;
  const MONEY =
    /\b(?:wager|wagered|wagering|bet|bets|betting|stake|stakes|staked|rake|payout|payouts)\b|\bthe pot\b/i;

  const copy = [];
  for (const game of GAME_LANDING_PAGES) {
    copy.push(
      game.headline,
      game.shortDescription,
      game.competitive,
      ...game.introduction,
      ...game.howToPlay,
      ...game.rules,
      ...game.scoring,
      ...game.strategy,
    );
    for (const entry of game.faq) copy.push(entry.q, entry.a);
  }

  let checked = 0;
  for (const value of copy) {
    for (const sentence of value.split(/(?<=[.!?])\s+/)) {
      if (!MONEY.test(sentence)) continue;
      checked += 1;
      assert.ok(
        NEGATED.test(sentence),
        `a landing page claims something is at stake, but stakes are retired: "${sentence}"`,
      );
    }
  }
  // The checker is only meaningful if it is actually reaching the negations.
  assert.ok(checked > 0, "expected at least one wagering sentence to inspect");
});

test("catalog: every leaderboardKey is a real game id in GAME_CATALOG", () => {
  const ids = new Set(GAME_CATALOG.map((game) => game.id));
  for (const game of GAME_LANDING_PAGES) {
    assert.ok(
      ids.has(game.leaderboardKey),
      `${game.slug}.leaderboardKey="${game.leaderboardKey}" is not a GAME_CATALOG id`,
    );
  }
});

test("catalog: every landing page names a game that actually exists in the app", () => {
  const inApp = new Set(lobbySlugs());
  const orphans = GAME_LANDING_SLUGS.filter((slug) => !inApp.has(slug));
  assert.deepEqual(orphans, [], "a landing page exists for a game with no lobby page");
});

test("catalog: every game the public hub advertises has a landing page", () => {
  const advertised = hubSlugs();
  assert.ok(advertised.length >= 20, `expected the full hub catalogue, got ${advertised.length}`);
  const missing = advertised.filter((slug) => !GAME_LANDING_BY_SLUG[slug]);
  assert.deepEqual(
    missing,
    [],
    "the hub links to a game with no public landing page — a crawler following that card lands on the lobby with nothing to read",
  );
});

test("catalog: the /play URL is derived, never hand-written per page", () => {
  assert.equal(gamePlayPath("chess"), "/games/chess/play");
  assert.equal(gameLandingPath("chess"), "/games/chess");
  assert.notEqual(gamePlayPath("chess"), gameLandingPath("chess"));
});

// ── 2. Routing ────────────────────────────────────────────────────────────

// Whitespace-collapsed views, so an indentation change cannot fail a check that
// is really about what the config SAYS.
const oneLine = (src) => src.replace(/\s+/g, " ");
const NEXT_CONFIG = read("next.config.js");
const CONFIG = oneLine(NEXT_CONFIG);

test("routing: the landing page is a real App Router route", () => {
  assert.ok(
    existsSync("src/app/games/[slug]/page.tsx"),
    "the public landing page must be a real route, not a rewrite target",
  );
  assert.ok(
    existsSync("src/components/game-landing/GameLanding.tsx"),
    "the shared landing component must exist (21 pages must not duplicate JSX)",
  );
});

test("routing: /games/<slug>/play rewrites to the EXISTING /casino/<slug> lobby", () => {
  assert.ok(
    CONFIG.includes('source: "/games/:slug/play", destination: "/casino/:slug"'),
    "the play route must dispatch to the lobby that already exists, unchanged",
  );
});

test("routing: the blanket /games/:path* catch-all is GONE", () => {
  // Left in place it wins over src/app/games/[slug]/page.tsx and serves the
  // LOBBY at the landing-page URL — measured on a real production build, not
  // theoretical.
  // The legacy /casino/* redirect still DESTINES to /games/:path* — only a
  // rewrite with that SOURCE would shadow the landing page.
  assert.ok(
    !CONFIG.includes('source: "/games/:path*"'),
    "a /games/:path* rewrite shadows the landing page; enumerate the sub-path shapes instead",
  );
  // …but the deep app routes must still be reachable.
  assert.ok(
    CONFIG.includes(
      'source: "/games/:slug/:path+", destination: "/casino/:slug/:path+"',
    ),
    "deep game routes (/games/chess/ai, /games/keno-pvp/<id>) must still resolve",
  );
  // …and the hub itself.
  assert.ok(CONFIG.includes('source: "/games", destination: "/casino"'));
});

test("routing: the legacy /casino/* redirects are untouched", () => {
  assert.ok(CONFIG.includes('source: "/casino", destination: "/games"'));
});

// ── 3. Indexing ───────────────────────────────────────────────────────────

test("indexing: every lobby page is noindex and canonical to its play URL", () => {
  for (const slug of GAME_LANDING_SLUGS) {
    const file = LOBBY_FILE(slug);
    assert.ok(file, `${slug} has no lobby page`);
    const src = read(file);
    assert.ok(
      src.includes(`canonical: "/games/${slug}/play"`),
      `${file} must canonicalise to its own play URL`,
    );
    assert.match(
      src,
      /robots:\s*\{\s*index:\s*false,\s*follow:\s*true\s*\}/,
      `${file} must be noindex: the indexable page is /games/${slug}`,
    );
  }
});

test("indexing: the landing route is indexable and self-canonical", () => {
  const src = read("src/app/games/[slug]/page.tsx");
  assert.match(src, /alternates:\s*\{\s*canonical\s*\}/);
  assert.match(src, /gameLandingPath\(slug\)/);
  assert.match(src, /gameLandingUrl\(slug\)/, "og:url must be the landing URL");
  // noindex is only allowed on the (unreachable) unknown-slug fallback.
  assert.match(src, /\.\.\.\(game \? \{\} : \{ robots: \{ index: false, follow: true \} \}\)/);
});

test("indexing: the sitemap lists every landing page and no /play URL", () => {
  // The 21 URLs are GENERATED from GAME_LANDING_PAGES by src/lib/seoPages.ts,
  // so this compares the catalog to the emitted inventory rather than to
  // hand-written strings — a game added to the catalog is in the sitemap by
  // construction, and a game whose page was dropped leaves a URL behind.
  const missing = GAME_LANDING_SLUGS.filter(
    (slug) => !PUBLIC_SEO_PATHS.includes(gameLandingPath(slug)),
  );
  assert.deepEqual(missing, [], "a landing page is missing from the sitemap");

  const listedGames = PUBLIC_SEO_PATHS.filter((path) => path.startsWith("/games/"));
  assert.equal(
    listedGames.length,
    GAME_LANDING_SLUGS.length,
    "the sitemap must list exactly one URL per game landing page",
  );
  assert.doesNotMatch(
    listedGames.join("\n"),
    /\/play$/m,
    "a noindex lobby must not be in the sitemap",
  );

  // The sitemap route itself must stay a projection of the inventory — if this
  // fails, somebody reintroduced a second, hand-maintained list of URLs.
  assert.match(
    read("src/app/sitemap.ts"),
    /PUBLIC_SEO_PAGES/,
    "src/app/sitemap.ts must emit src/lib/seoPages.ts, not its own page list",
  );
});

// ── 4. Auth is not weakened ───────────────────────────────────────────────

const PROXY = read("src/proxy.ts");

test("auth: the landing page is public content with no Clerk dependency", () => {
  for (const file of ["src/app/games/[slug]/page.tsx", "src/components/game-landing/GameLanding.tsx"]) {
    const src = read(file);
    assert.doesNotMatch(src, /@clerk\/nextjs/, `${file} must not gate the public content behind Clerk`);
    assert.doesNotMatch(src, /auth\(\)|currentUser\(\)|requireAgeVerified/, `${file} must not require a session`);
  }
});

test("auth: the Play CTA is the only route into gameplay", () => {
  const component = read("src/components/game-landing/GameLanding.tsx");
  assert.match(component, /const playHref = gamePlayPath\(game\.slug\)/);
  // Both CTAs (hero + closing band) must use it.
  const used = [...component.matchAll(/href=\{playHref\}/g)].length;
  assert.ok(used >= 2, `expected the hero and closing CTAs to use playHref, found ${used}`);
  assert.doesNotMatch(component, /href="\/casino\//, "the landing page must not link into the app namespace");
});

test("auth: the proxy still gates gameplay and still age-checks signed-in players", () => {
  // The three branches that make the signed-out READ safe while keeping PLAY
  // authenticated. If any is refactored away, a guest can start something.
  assert.match(PROXY, /const browsingGameSignedOut = !userId && isGameRoute\(pathname\);/);
  assert.match(PROXY, /if \(!userId && !browsingGameSignedOut\) \{/);
  assert.match(PROXY, /if \(userId && !skipsAgeGate\) \{/);
});

test("auth: an unknown /games/<slug> is a real 404, not a 200 soft 404", () => {
  // notFound() from the page runs after the root loading.tsx Suspense boundary
  // has flushed the shell, so the status is already 200 by then — the guard has
  // to happen in the proxy, before rendering.
  assert.ok(PROXY.includes('import { isGameLandingSlug } from "./lib/gameLandingPages";'));
  assert.ok(
    PROXY.includes("/^\\/games\\/([^/]+)\\/?$/.exec(pathname)"),
    "the guard must match exactly a one-segment /games/<slug> request",
  );
  assert.ok(PROXY.includes("if (unknownGameSlug && !isGameLandingSlug(unknownGameSlug[1]))"));
  assert.ok(PROXY.includes("NextResponse.rewrite(new URL(NOT_FOUND_SENTINEL, req.url))"));
  // …and the not-found page itself can never be indexed, whatever status it is
  // served with.
  assert.match(read("src/app/not-found.tsx"), /robots:\s*\{\s*index:\s*false,\s*follow:\s*true\s*\}/);
});

test("auth: keno is classified like every other game, play URL included", () => {
  // /games/keno/play must not be bounced to /sign-in while the other twenty
  // lobbies are reachable — that inconsistency has regressed before.
  assert.ok(PROXY.includes('"/games/keno(.*)"'), "keno needs a (.*) like the other games");
  assert.ok(PROXY.includes('"/casino/keno(.*)"'));
  for (const slug of GAME_LANDING_SLUGS) {
    assert.ok(
      PROXY.includes(`"/games/${slug}(.*)"`) || PROXY.includes(`"/games/${slug}"`),
      `${slug} is missing from GAME_ROUTE_PATTERNS — a signed-out visitor would be bounced from /games/${slug}/play`,
    );
  }
});
