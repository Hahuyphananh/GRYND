// src/lib/gameDiscovery.ts
//
// The data behind the /games hub's discovery content: the catalogue grouped by
// CATEGORY and by SKILL, so a visitor can choose a game by what it asks of them
// rather than by scrolling a grid.
//
// ── Where the groupings come from (do not invent them here) ───────────────
//
//   * Categories are the `category` field of each public game landing page
//     (src/lib/gameLandingPages.ts). One game, one category, already written.
//   * Skill tags are `GAME_CATALOG[].tags` (src/lib/gameTags.js) — the SAME
//     vocabulary the personalization engine scores on, where every tag is
//     hand-assigned from the game's own shipped description. Reusing it means
//     the hub cannot claim a game is "strategic" when the engine has it tagged
//     otherwise, and a newly tagged game appears here automatically.
//
// `pvp` is deliberately EXCLUDED from the skill groups: every game on GRYND is
// 1v1 (see the note in gameTags.js), so a "1v1 duels" group would list the
// entire catalogue and tell a visitor nothing.
//
// This module is pure data derivation — no JSX — so the hub can render it on
// the server and hand the result down as plain props.

import { GAME_LANDING_BY_SLUG, GAME_LANDING_PAGES } from "./gameLandingPages";
import { GAME_CATALOG } from "./gameTags";

/** One game as a discovery listing needs it. */
export type DiscoveryGame = {
  slug: string;
  name: string;
  shortDescription: string;
};

/** A labelled group of games, with a one-line reason to read it. */
export type DiscoveryGroup = {
  /** Stable key (site-relative slug fragment) — never rendered. */
  key: string;
  /** The H3 a visitor reads. */
  label: string;
  /** One sentence explaining what the group has in common. */
  description: string;
  games: DiscoveryGame[];
};

const toDiscoveryGame = (slug: string): DiscoveryGame | null => {
  const game = GAME_LANDING_BY_SLUG[slug];
  if (!game) return null;
  return { slug: game.slug, name: game.name, shortDescription: game.shortDescription };
};

const sortByName = (a: DiscoveryGame, b: DiscoveryGame) => a.name.localeCompare(b.name);

// ── By category ───────────────────────────────────────────────────────────

/**
 * What each category actually means, in one sentence. Kept here rather than in
 * the catalogue because it describes the GROUP, not any single game — and every
 * sentence is written from the mechanics of the games filed under it.
 */
const CATEGORY_DESCRIPTIONS: Record<string, string> = {
  Deduction:
    "Games where you work out what is safe, or what your opponent is holding, from incomplete information.",
  "Reflex & Recall":
    "Games where a pattern or a stimulus is shown once and what you do with it in the next few seconds decides the round.",
  "Classic Strategy":
    "Turn-based games with a long history: build a position, plan ahead and punish a plan that over-extends.",
  "Card Games":
    "Hand-management duels — what you hold, what you keep and when you spend your best card.",
  "Mind Games": "Games decided by prediction and pattern reading rather than execution.",
  Stacking: "Physics and placement games where structure, balance and risk decide who survives.",
  "Risk & Memory":
    "Games where the board changes as you play and keeping track of it is part of the skill.",
  Physics: "Games with a simulated world — aim, power and timing are the whole control scheme.",
  Racing:
    "Head-to-head races where a lead is worth protecting and a mistake is paid for immediately.",
  Puzzles:
    "Games built on a puzzle both players solve at the same time, with no opponent to interfere.",
  Dice: "Games where the roll is shared and the decision — what to keep and what to re-roll — is yours.",
};

/** Every catalogue game, grouped by its landing-page category, groups A–Z. */
export const CATEGORY_GROUPS: readonly DiscoveryGroup[] = Object.entries(
  GAME_LANDING_PAGES.reduce<Record<string, DiscoveryGame[]>>((groups, game) => {
    const entry = toDiscoveryGame(game.slug);
    if (!entry) return groups;
    (groups[game.category] ??= []).push(entry);
    return groups;
  }, {})
)
  .map(([category, games]) => ({
    key: category.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    label: category,
    description:
      CATEGORY_DESCRIPTIONS[category] ?? `Games grouped under ${category} in the catalogue.`,
    games: [...games].sort(sortByName),
  }))
  .sort((a, b) => a.label.localeCompare(b.label));

// ── By skill ──────────────────────────────────────────────────────────────

/**
 * How each engine tag reads to a player. All six non-`pvp` tags are used, and
 * the label states what the tag means in gameTags.js rather than inventing a
 * new claim about the game.
 */
const SKILL_LABELS: Record<string, { label: string; description: string }> = {
  skill: {
    label: "Decided by ability",
    description:
      "The outcome turns primarily on what the player does — nothing is drawn during play to decide it.",
  },
  strategy: {
    label: "Won by planning",
    description:
      "The match turns on reading the position and the opponent, not on execution alone.",
  },
  fast_paced: {
    label: "Short, fast rounds",
    description:
      "Rounds resolve quickly, so decisions happen under a clock rather than in comfort.",
  },
  casual: {
    label: "Quick to learn",
    description: "Nothing to study before your first match — the rules are readable in a minute.",
  },
  chance: {
    label: "Randomness to manage",
    description:
      "A random input does most of the work, and the skill is in managing a good or bad roll.",
  },
  competitive: {
    label: "Built around the ladder",
    description:
      "Positioned around ranked play: results move a per-game rating and trophy ladder that people climb.",
  },
};

/** The tags that form a discovery group, in the order they are shown. */
const SKILL_ORDER = ["skill", "strategy", "fast_paced", "competitive", "chance", "casual"] as const;

/**
 * Games grouped by engine tag.
 *
 * Resolved through each catalogue entry's `href` — its canonical public game
 * page — so a tagged game always shows up under its own name and a game the
 * catalogue does not list can never appear.
 */
export const SKILL_GROUPS: readonly DiscoveryGroup[] = SKILL_ORDER.map((tag) => {
  const games = GAME_CATALOG.filter((entry: { tags: string[] }) => entry.tags.includes(tag))
    .map((entry: { href: string }) => toDiscoveryGame(entry.href.replace("/games/", "")))
    .filter((game: DiscoveryGame | null): game is DiscoveryGame => game !== null)
    .sort(sortByName);

  const meta = SKILL_LABELS[tag];
  return { key: tag.replace(/_/g, "-"), label: meta.label, description: meta.description, games };
}).filter((group) => group.games.length > 0);
