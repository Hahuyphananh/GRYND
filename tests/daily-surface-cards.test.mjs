/**
 * daily-surface-cards.test.mjs
 *
 * Every public surface with its own page must preview as ITSELF when shared —
 * not as the site's generic banner and not as one of its siblings. That means:
 *
 *   1. an opengraph-image.tsx beside each route (Next wires it into og:image),
 *   2. a distinct kicker and accent per card, so no two previews look alike,
 *   3. `twitter:card = summary_large_image` on each page, and
 *   4. cross-links, so splitting the pages does not hide the others.
 *
 * Covers the three daily surfaces (challenge / daily puzzle / unlimited
 * puzzles), the two Solitaire lobbies (solo, ranked), the six-mode Play hub and
 * the Play vs AI lobby.
 *
 * Run:  node --import tsx --test tests/daily-surface-cards.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (rel) => readFileSync(rel, "utf8");
/** Comments are allowed to explain a claim; only the rendered spec must hold. */
const code = (src) => src.replace(/^\s*\/\/.*$/gm, "");

const CARDS = {
  challenge: "src/app/daily/opengraph-image.tsx",
  dailyPuzzle: "src/app/play/daily-puzzle/opengraph-image.tsx",
  unlimited: "src/app/play/unlimited-puzzles/opengraph-image.tsx",
  solo: "src/app/play/solo/opengraph-image.tsx",
  ranked: "src/app/play/ranked/opengraph-image.tsx",
  hub: "src/app/play/opengraph-image.tsx",
  ai: "src/app/play/ai/opengraph-image.tsx",
};

const PAGES = {
  challenge: "src/app/daily/page.tsx",
  dailyPuzzle: "src/app/play/daily-puzzle/page.tsx",
  unlimited: "src/app/play/unlimited-puzzles/page.tsx",
  solo: "src/app/play/solo/page.tsx",
  ranked: "src/app/play/ranked/page.tsx",
  hub: "src/app/play/page.tsx",
  ai: "src/app/play/ai/page.tsx",
};

const OG_URLS = {
  challenge: "/daily",
  dailyPuzzle: "/play/daily-puzzle",
  unlimited: "/play/unlimited-puzzles",
  solo: "/play/solo",
  ranked: "/play/ranked",
  hub: "/play",
  ai: "/play/ai",
};

test("every carded surface ships its own Open Graph image", () => {
  for (const [surface, file] of Object.entries(CARDS)) {
    const src = read(file);
    assert.match(src, /surfaceCardResponse\(/, `${surface} must use the shared card builder`);
    assert.match(src, /export const size/, `${surface} must declare its size`);
    assert.match(src, /export const contentType = "image\/png"/, `${surface} must be a PNG`);
    assert.match(src, /export const alt/, `${surface} needs alt text`);
  }

  // One builder, so the family looks consistent; one spec each, so every card
  // says something different.
  const builder = read("src/lib/surfaceCardImage.tsx");
  assert.match(builder, /export const SURFACE_CARD_SIZE = \{ width: 1200, height: 630 \}/);
  assert.match(builder, /from "next\/og"/);

  const kickers = Object.values(CARDS).map((file) => read(file).match(/kicker: "([^"]+)"/)?.[1]);
  const accents = Object.values(CARDS).map((file) => read(file).match(/accent: "([^"]+)"/)?.[1]);
  const titles = Object.values(CARDS).map((file) => read(file).match(/title: "([^"]+)"/)?.[1]);
  assert.ok(kickers.every(Boolean) && accents.every(Boolean) && titles.every(Boolean));
  assert.equal(new Set(kickers).size, kickers.length, "no two cards may share a kicker");
  assert.equal(new Set(accents).size, accents.length, "no two cards may share an accent");
  assert.equal(new Set(titles).size, titles.length, "no two cards may share a headline");

  // Each card must name its own surface, not a sibling's.
  assert.match(read(CARDS.challenge), /"DAILY CHALLENGE"/);
  assert.match(read(CARDS.dailyPuzzle), /"DAILY PUZZLE"/);
  assert.match(read(CARDS.unlimited), /"UNLIMITED PUZZLES"/);
  assert.match(read(CARDS.solo), /"SOLO"/);
  assert.match(read(CARDS.ranked), /"RANKED"/);
  assert.match(read(CARDS.hub), /"PLAY"/);
  assert.match(read(CARDS.ai), /"PLAY VS AI"/);

  // The hub is a menu, so its card enumerates the modes instead of describing
  // one; and it must not be mistaken for the AI lobby it links to.
  const hub = code(read(CARDS.hub));
  for (const mode of ["Solo", "Daily Challenge", "Play vs AI", "Ranked", "Daily Puzzle", "Unlimited Puzzles"]) {
    assert.ok(hub.includes(mode), `the hub card must name ${mode}`);
  }
  assert.match(hub, /Six ways to play/);

  const ai = code(read(CARDS.ai));
  assert.match(ai, /Unrated/);
  assert.match(ai, /Rookie/);
  assert.match(ai, /Perfect/);
  assert.doesNotMatch(ai, /Elo on the line|one shared deal/i);
});

test("each page asks for the large social card and names its own URL", () => {
  for (const [surface, file] of Object.entries(PAGES)) {
    const src = read(file);
    assert.match(src, /card: "summary_large_image"/, `${surface} needs a large twitter card`);
    assert.match(src, /openGraph: \{/, `${surface} needs openGraph metadata`);
    assert.match(src, /alternates: \{ canonical:/, `${surface} needs a canonical URL`);
    assert.match(
      src,
      new RegExp(`url: "${OG_URLS[surface].replace(/\//g, "\\/")}"`),
      `${surface} must give openGraph its own URL`,
    );
  }
});

test("the lobbies do not borrow the rated/unrated claim of the other", () => {
  const solo = code(read(CARDS.solo));
  const ranked = code(read(CARDS.ranked));

  // Solo is the unrated surface: undo, personal statistics, no Elo movement.
  assert.match(solo, /Unrated/);
  assert.match(solo, /Never touches ranked Elo/);
  assert.doesNotMatch(solo, /Rated 1v1|Elo on the line/);

  // Ranked moves a rating and is humans-only — bots live at /play/ai.
  assert.match(ranked, /Elo on the line/);
  assert.match(ranked, /Humans only/);
  assert.doesNotMatch(ranked, /Unrated|Undo any move/);

  // And neither may advertise an opponent the lobby cannot produce: the ranked
  // card ships no mention of bots, because that shortcut lives at /play/ai.
  assert.doesNotMatch(ranked, /\bbots?\b|\bAI\b/);
});

test("the Play hub links the daily puzzle and unlimited puzzle cards", () => {
  // The hub is how a visitor reaches those two pages — and therefore their own
  // social cards. Both cards go to the LOBBY, not straight into a game, because
  // the lobby is where the attempt rule and the free allowance are stated.
  const hub = read("src/components/play/PlayHub.tsx");
  const hrefs = [...hub.matchAll(/href: "([^"]+)"/g)].map((m) => m[1]);
  assert.ok(hrefs.includes("/play/daily-puzzle"), "/play/daily-puzzle must be a hub card");
  assert.ok(hrefs.includes("/play/unlimited-puzzles"), "/play/unlimited-puzzles must be a hub card");
  assert.ok(hrefs.includes("/play/solo") && hrefs.includes("/play/ranked"));
  assert.ok(hrefs.includes("/play/ai") && hrefs.includes("/play/daily"));
  assert.ok(hrefs.every((href) => href.startsWith("/play/")), "a hub card must never skip its lobby");

  // Both puzzle lobbies exist and carry their own metadata, so the hub's links
  // land on a real indexable page rather than a redirect.
  for (const file of ["src/app/play/daily-puzzle/page.tsx", "src/app/play/unlimited-puzzles/page.tsx"]) {
    assert.match(read(file), /alternates: \{ canonical:/);
    assert.match(read(file), /openGraph: \{/);
  }
});

test("the separated puzzles link to each other and to the challenge", () => {
  const daily = read("src/app/play/daily-puzzle/play/page.tsx");
  assert.match(daily, /href="\/play\/unlimited-puzzles\/play"/);
  assert.match(daily, /href="\/daily"/);
  assert.match(daily, /data-testid="daily-puzzle-cross-link"/);

  const unlimited = read("src/app/play/unlimited-puzzles/play/page.tsx");
  assert.match(unlimited, /href="\/play\/daily-puzzle\/play"/);
  assert.match(unlimited, /href="\/daily"/);
  assert.match(unlimited, /data-testid="unlimited-puzzles-cross-link"/);

  // The challenge page links back to both puzzles (added when the surfaces were
  // split), so discovery is not one-directional.
  const challenge = read("src/app/daily/PageClient.tsx");
  assert.match(challenge, /href="\/play\/daily-puzzle\/play"/);
  assert.match(challenge, /href="\/play\/unlimited-puzzles\/play"/);
});
