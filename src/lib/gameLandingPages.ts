// src/lib/gameLandingPages.ts
//
// THE GAME LANDING-PAGE CATALOG — one entry per public `/games/<slug>` page.
//
// ── Why this file exists ───────────────────────────────────────────────────
//
// The public game URL used to be nothing but a rewrite of the authenticated
// game application: `/games/<slug>` invisibly served `/casino/<slug>`'s client
// component, so the only thing a crawler could read was a title and a Play
// button. There was no crawlable text, and a signed-out visitor landed in a
// lobby they could not use.
//
// The architecture now splits the two concerns:
//
//   /games/<slug>        → a PUBLIC, server-rendered landing page (this file)
//   /games/<slug>/play   → the AUTHENTICATED game + lobby, unchanged
//
// Everything a visitor needs to understand the game BEFORE signing in lives
// here, as data, so all 21 pages are rendered by one component
// (src/components/game-landing/GameLanding.tsx). No page duplicates JSX.
//
// ── Where the content comes from (do NOT invent mechanics) ─────────────────
//
// Every rule, number and scoring detail below is transcribed from the game's
// own server-authoritative source, which is the only authority on how it
// plays. The contract for each game is the header comment of its engine /
// constants module — `src/lib/<game>/constants.ts`, `rules.ts`, or the
// equivalent — and several have a "WHAT THIS GAME IS" block stating the
// contract in one place. If a rule changes there, it must change here.
//
// Deliberate exclusions, because they would be FALSE today:
//   * No wagering, staking, pot, rake or payout language anywhere. THIS
//     CATALOGUE COPY is deliberately coin-free: the lobby (and its stake
//     picker, see src/lib/games/stakes.js) states the wager, and a landing
//     page describes the GAME, whose competitive result is still decided on
//     skill and rewarded with a per-game Elo rating and trophies
//     (src/lib/rating.js, src/lib/trophies.js). tests/game-landing-pages.test.mjs
//     enforces the coin-free copy.
//   * No invented reward numbers. The trophy/Elo machinery is described by
//     what it does (moves a per-game ladder), not by a delta that tuning can
//     change out from under this copy.
//
// `leaderboardKey` ties each page to its identity in the existing catalog
// (`GAME_CATALOG` in src/lib/gameTags.js, and the `RATED_GAMES` keys in
// src/lib/rating.js). tests/game-landing-pages.test.mjs asserts that link, so
// a page can never be added for a game that does not exist.

import { CANONICAL_SITE_URL } from "./siteUrl";
import { isGameAvailable } from "./gameAvailability";

/**
 * The canonical origin the public site is served from — www, the host the
 * platform actually serves (the apex 308-redirects to it). Derived from the one
 * place that decides this (src/lib/siteUrl.ts) so a future host change cannot
 * leave the landing pages and the sitemap advertising two different hosts.
 */
export const SITE_ORIGIN = CANONICAL_SITE_URL;

/** One question/answer pair rendered in the landing page FAQ. */
export type GameFaqEntry = {
  q: string;
  a: string;
};

/** A public game landing page. */
export type GameLandingPage = {
  /** The `/games/<slug>` path segment — also the `/casino/<slug>` lobby dir. */
  slug: string;
  /** Short display name, as the lobby and rating boards render it. */
  name: string;
  /** The page H1, e.g. "Speed Typing — Competitive Typing Game". */
  headline: string;
  /** Grouping used for the "Related games" rail and the hub cross-links. */
  category: string;
  /**
   * The game's canonical id in the lobby/leaderboard registries — exactly the
   * `id` of the matching entry in `GAME_CATALOG` (src/lib/gameTags.js), which
   * is itself the lobby's `leaderboardKey`. Two of these games share one id
   * with an alias page (uno/neon-flush), which is why the pair is explicit
   * rather than derived.
   */
  leaderboardKey: string;
  /** Open Graph / Twitter card image. Reuses the game's existing card art. */
  ogImage: string;
  /** Meta description. Doubles as the hub card blurb. */
  shortDescription: string;
  /** Does the lobby offer an unrated practice match against the bot? */
  aiPractice: boolean;
  /**
   * The POST endpoint that starts an unrated practice match, when the game has
   * one that a landing page may call DIRECTLY.
   *
   * Setting it renders the practice button beside the hero's Play CTA, so a
   * visitor can be in a real match against the bot without going through the
   * lobby at all. The route mints a guest seat for a signed-out visitor (each
   * game's own practice entry route does that) and answers with the id of the
   * match it created; the page then navigates to that match's own URL.
   *
   * Deliberately per game rather than derived: the endpoint shape is the game's
   * own contract, and a game whose lobby has practice but no public entry route
   * must not get a button that 404s.
   */
  practiceApi?: string;
  /** Opening explanation: what the game is, and why it is competitive. */
  introduction: string[];
  /** The actual mechanics, in the order a player meets them. */
  howToPlay: string[];
  /** How a match works — the rules the server enforces. */
  rules: string[];
  /** What decides performance / the winner. */
  scoring: string[];
  /** Genuinely useful, game-specific advice. */
  strategy: string[];
  /** Which skill the game tests. */
  competitive: string;
  /** Questions specific to this game. */
  faq: GameFaqEntry[];
  /** Slugs of other public landing pages to link to. */
  related: string[];
};

/**
 * The catalog, in the lobby's featured order (the same order as
 * `GAME_CATALOG` in src/lib/gameTags.js).
 */
export const GAME_LANDING_PAGES: readonly GameLandingPage[] = [  {
    slug: "solitaire-duel",
    name: "Solitaire Duel",
    headline: "Solitaire Duel — Competitive Klondike Race",
    category: "Racing",
    leaderboardKey: "solitaire-duel",
    ogImage: "/images/og-banner.png",
    shortDescription:
      "A rated 1v1 Klondike race. Both players get the exact same server-dealt puzzle and solve it simultaneously — first to put all 52 cards on the foundations wins.",
    aiPractice: true,
    introduction: [
      "Solitaire Duel turns Klondike into a head-to-head race. One deterministic deal is generated on the server and given to both players, who then play it at the same time on their own boards. The first to move all 52 cards onto the foundations wins.",
      "It is competitive because there is nothing random left once the match begins: the deal is identical for both seats, so the only difference between two players is how efficiently they read and sequence it.",
    ],
    howToPlay: [
      "Sign in, open the lobby and press Play to face a live opponent, or take a free practice match against the bot.",
      "Both players receive the exact same Klondike deal and play it simultaneously on their own board.",
      "Draw from the stock, build the tableau downward in alternating colours, and move cards up to the foundations in suit order from Ace.",
      "The first player to move all 52 cards onto the foundations wins immediately.",
      "If neither finishes before the match ends, the greater verified progress wins.",
    ],
    rules: [
      "The variant is Klondike with a single-card draw and unlimited redeals — chosen because it has by far the highest completion rate, so solving the puzzle is the normal ending rather than the exception.",
      "One deterministic deal per match, generated server-side from a committed seed. Both seats get that same deal on their own board.",
      "The server only serves a deal that a deterministic search has proved has a winning line, and that its engine can replay, and that a naive foundation-only strategy fails to solve — so every match is solvable, and never laid out for you.",
      "Foundations build upward per suit, starting at the Ace and ending at the King.",
      "The tableau builds downward in alternating colours, and only a King may be placed on an empty column.",
      "If neither seat finishes, the greater verified progress wins; an exact tie is a draw.",
      "Leaving or going inactive forfeits the match.",
    ],
    scoring: [
      "Putting all 52 cards on the foundations wins the match immediately.",
      "If nobody solves it before the match ends, the seat with the greater verified progress is the winner, and a level race is recorded as a draw.",
      "Progress is derived by the server from its own board state, never from a client's report.",
    ],
    strategy: [
      "Free the face-down cards. The concealed cards in the tableau are the real obstacle, so moves that expose one are worth more than moves that tidy the visible rows.",
      "Send aces and low cards up early. A foundation never blocks a tableau move, so every card you can promote is one less thing that can strand you later.",
      "Only empty a column when you have a King to put in it. An empty column is a resource, and wasting it is one of the most common ways to lose a race you were winning.",
      "Use the unlimited redeals deliberately. With a single-card draw you can cycle the stock as often as you need, so the stock is a resource for ordering your plays rather than a countdown.",
      "Because you both play the identical deal, efficiency beats creativity. The lines that solve this deal are the same for your opponent, so play the one you can execute fastest.",
      "Do not stop to admire the board. There is no score for elegance here — the only currency is cards on the foundations before your opponent gets there.",
    ],
    competitive:
      "Solitaire Duel tests card-reading and sequencing efficiency under a head-to-head clock. Both players face the same puzzle, so it is a straight measure of who can execute it faster.",
    faq: [
      {
        q: "Is the deal really the same for both players?",
        a: "Yes. One deterministic deal is generated server-side from the match seed, and both seats play it on their own board.",
      },
      {
        q: "Is every deal solvable?",
        a: "Yes. A deal is only served when a deterministic search has proved a winning line exists, the engine replays it, and a naive foundation-only strategy fails to solve it — so it is always winnable and never pre-solved.",
      },
      {
        q: "What happens if neither of us finishes?",
        a: "The player with the greater verified progress wins. If the race is exactly level, it is recorded as a draw.",
      },
      {
        q: "Which Klondike variant is it?",
        a: "Single-card draw with unlimited redeals. That variant has the highest completion rate, which keeps the 'first to solve it' win condition as the normal way a match ends.",
      },
      {
        q: "Is it free to play?",
        a: "Yes. Nothing is wagered; ranked results move your Elo and trophies for this game.",
      },
    ],
    related: [],
  },


];;

/** Slugs that have a public landing page, in catalog order. */
export const GAME_LANDING_SLUGS: readonly string[] = GAME_LANDING_PAGES.map((g) => g.slug);

/** slug → entry. */
export const GAME_LANDING_BY_SLUG: Readonly<Record<string, GameLandingPage>> = Object.fromEntries(
  GAME_LANDING_PAGES.map((game) => [game.slug, game]),
);

/** The public landing-page path for a slug. */
export function gameLandingPath(slug: string): string {
  return `/games/${slug}`;
}

/**
 * The prefix of a game's match URLs — `/games/<slug>/`.
 *
 * This exists as a SEPARATE string because a server component may not hand a
 * function down to a client component: a function prop is not serialisable
 * across the server/client boundary and React throws on it. The practice button
 * is client-side (it POSTs and follows the id), so it receives this prefix and
 * appends the id itself.
 */
export function gameMatchPathPrefix(slug: string): string {
  return `/games/${slug}/`;
}

/**
 * The path of ONE match of a game — `/games/<slug>/<matchId>`.
 *
 * next.config.js rewrites `/games/:slug/:path+` to `/casino/:slug/:path+`, so
 * this is the same URL a lobby navigates to when it seats a player (and the one
 * a started practice match is followed to). Built here for the same reason the
 * other two paths are: one place decides what a game URL looks like.
 */
export function gameMatchPath(slug: string, matchId: string): string {
  return `${gameMatchPathPrefix(slug)}${matchId}`;
}

/**
 * The AUTHENTICATED gameplay path for a slug.
 *
 * `/games/<slug>/play` is rewritten (next.config.js) to the existing
 * `/casino/<slug>` lobby, so the Play CTA leads into the unchanged Clerk-
 * protected game application: same clients, same matchmaking, same APIs.
 */
export function gamePlayPath(slug: string): string {
  return `/games/${slug}/play`;
}

/** True when a slug has a public landing page. */
export function isGameLandingSlug(slug: unknown): boolean {
  return typeof slug === "string" && Object.hasOwn(GAME_LANDING_BY_SLUG, slug);
}

/** The landing-page URL for a slug, on the canonical origin. */
export function gameLandingUrl(slug: string): string {
  return `${SITE_ORIGIN}${gameLandingPath(slug)}`;
}

/** Resolve a slug's related games to their catalog entries. */
export function relatedGames(slug: string): GameLandingPage[] {
  const game = GAME_LANDING_BY_SLUG[slug];
  if (!game) return [];
  // A related rail must never point at an archived game: the catalogue keeps
  // every entry so it can be reactivated, but public cross-links filter here.
  return game.related
    .map((relatedSlug) => GAME_LANDING_BY_SLUG[relatedSlug])
    .filter((entry): entry is GameLandingPage => Boolean(entry))
    .filter((entry) => isGameAvailable(entry.slug));
}

/**
 * ── Crawlable link projections ────────────────────────────────────────────
 *
 * The catalogue above is the single source of truth for which public game
 * pages exist. The homepage, the /games hub and the help pages all need to
 * LINK to those pages, and they are all client components — importing the
 * catalogue from a `"use client"` module would ship 1,500 lines of game prose
 * to every visitor's browser to render a few anchors.
 *
 * So the surfaces that render game links take a projection built HERE, on the
 * server, and passed down as props (the same shape Next serialises across the
 * server/client boundary). There are two:
 *
 *   GAME_INDEX  the minimal `{ slug, name }` a plain link list needs — the hub's
 *               A–Z directory and the homepage's popular-games rail.
 *   GAME_CARDS  `{ slug, href, name, shortDescription, leaderboardKey }` for a
 *               surface that renders a CARD per game — the FAQ's games
 *               directory. (The card's ARTWORK is not data here: it is a webpack
 *               import registry, src/components/games/gameCardArt.js, keyed by
 *               the same slug.)
 *
 * Both are derived from the one catalogue, so the links cannot drift from the
 * pages, and a game added to the catalogue shows up in every crawlable list
 * without anyone remembering to add it.
 */

/** The minimal shape a crawlable game link needs. */
export type GameIndexEntry = {
  slug: string;
  name: string;
};

/** Every public game, A–Z by display name. */
/** Every public game that is currently available, A–Z by display name. */
export const GAME_INDEX: readonly GameIndexEntry[] = [...GAME_LANDING_PAGES]
  .filter(({ slug }) => isGameAvailable(slug))
  .map(({ slug, name }) => ({ slug, name }))
  .sort((a, b) => a.name.localeCompare(b.name));

/**
 * Resolve slugs to index entries, A–Z, dropping any unknown slug.
 *
 * Ordering is deliberate: these lists are read by a crawler as much as by a
 * visitor, and a stable order keeps the rendered HTML from churning between
 * deploys (which would look like the links moved).
 */
export function gameIndexFor(slugs: readonly string[]): GameIndexEntry[] {
  return slugs
    .map((slug) => GAME_LANDING_BY_SLUG[slug])
    .filter((entry): entry is GameLandingPage => Boolean(entry))
    .map(({ slug, name }) => ({ slug, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The games the HOME page links to by name.
 *
 * These are the hub catalogue's own `popular: true` entries
 * (src/app/casino/PageClient.jsx) — the site's existing popularity signal, not
 * a second opinion invented here. tests/internal-linking.test.mjs asserts the
 * two stay equal, so this list cannot quietly become a different claim about
 * which games are popular.
 */
export const HOMEPAGE_FEATURED_SLUGS: readonly string[] = [
  "mines-pvp",
  "memory-grid",
  "barrier-blitz",
  "odds",
];

/**
 * A game as a CARD: enough to fill the shared card element
 * (src/components/games/GameCard.jsx) — its name, its blurb, its game id for
 * the leaderboard shortcut, and its route to its OWN public page.
 *
 * EVERY public game is in here — not a curated handful — because the FAQ's games
 * directory renders one card per game; the list is derived from the whole
 * catalogue, so there is no second list to keep in step and a game added to the
 * catalogue appears on the FAQ without anyone remembering to add it.
 *
 * Note what is deliberately NOT here: the artwork. Card art is a webpack import
 * registry (src/components/games/gameCardArt.js) keyed by this `slug`, so the
 * lobby and the FAQ draw the same game with the same image from ONE registry,
 * and this module stays pure data that a plain Node test can import.
 */
export type GameCardEntry = {
  slug: string;
  /** The game's public page — always `/games/<slug>`, never the lobby. */
  href: string;
  name: string;
  shortDescription: string;
  /** The lobby/leaderboard id, for the card's leaderboard shortcut. */
  leaderboardKey: string;
};

/** Every public game as a card, A–Z by display name. */
export const GAME_CARDS: readonly GameCardEntry[] = [...GAME_LANDING_PAGES]
  .filter(({ slug }) => isGameAvailable(slug))
  .map(({ slug, name, shortDescription, leaderboardKey }) => ({
    slug,
    href: gameLandingPath(slug),
    name,
    shortDescription,
    leaderboardKey,
  }))
  .sort((a, b) => a.name.localeCompare(b.name));
