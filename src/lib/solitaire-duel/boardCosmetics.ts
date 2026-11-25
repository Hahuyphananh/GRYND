// src/lib/solitaire-duel/boardCosmetics.ts
//
// THE BOARD COSMETICS CATALOG — card backs, deck skins, and the streak item
// registry that ties every unlockable (felts included) to a milestone day.
//
// ZERO IMAGE ASSETS. Every design is a CSS `background-image` stack (gradients
// and repeating gradients) plus a border and an emblem glyph, painted through
// the `--sol-card-back-*` custom properties the board sets. That is what makes
// a cosmetic safe to grant: there is no URL to trust, no fetch to fail, and a
// card back costs the browser nothing beyond the paint it already did.
//
// ONE SOURCE OF TRUTH. The server validates ownership against this catalog and
// the picker previews from it, so a key that renders in the drawer is exactly
// the key the board can paint.

import { BOARD_THEMES, type BoardThemeKey } from "./boardThemes";

export type CardBack = {
  key: string;
  label: string;
  blurb: string;
  /** 0 = always owned; otherwise the streak day that unlocks it. */
  streakDay: number;
  /** CSS background-image for the back. */
  background: string;
  /** Border colour of the card. */
  border: string;
  /** Single glyph in the middle of the back. */
  emblem: string;
  /** Optional CSS animation name for a luxury shimmer. */
  animation?: string;
};

export const CARD_BACK_DEFAULT = "card_back_default";
export const DECK_DEFAULT = "deck_default";

export const CARD_BACKS: readonly CardBack[] = [
  {
    key: CARD_BACK_DEFAULT,
    label: "Navy Weave",
    blurb: "The standard GRYND back.",
    streakDay: 0,
    background:
      "linear-gradient(135deg, #1d3a63 0%, #16294a 52%, #0f1d36 100%), repeating-linear-gradient(45deg, rgba(0,229,255,0.16) 0 3px, transparent 3px 6px)",
    border: "rgba(0, 229, 255, 0.28)",
    emblem: "",
  },
  {
    key: "card_back_carbon",
    label: "Carbon",
    blurb: "Dark carbon-fibre diagonals, silver hairline, one monogram.",
    streakDay: 7,
    background:
      "repeating-linear-gradient(45deg, #262b31 0 3px, #1f2328 3px 6px)",
    border: "#9aa4b2",
    emblem: "G",
  },
  {
    key: "card_back_emerald_gold",
    label: "Emerald & Gold",
    blurb: "Tournament emerald under double gold filigree.",
    streakDay: 30,
    background:
      "radial-gradient(circle at 50% 50%, #0f4c3a 0 58%, #0a3427 100%), repeating-linear-gradient(45deg, rgba(197,155,72,0.22) 0 1px, transparent 1px 7px)",
    border: "#c59b48",
    emblem: "♦",
  },
  {
    key: "card_back_centurion",
    label: "Centurion",
    blurb: "Brushed brass lattice over obsidian.",
    streakDay: 100,
    background:
      "repeating-linear-gradient(45deg, #2b2418 0 6px, #c59b48 6px 7px), repeating-linear-gradient(-45deg, rgba(43,36,24,0.9) 0 6px, rgba(197,155,72,0.55) 6px 7px)",
    border: "#e0bd6d",
    emblem: "✶",
  },
  {
    key: "card_back_crimson_monogram",
    label: "Crimson Monogram",
    blurb: "Deep crimson with cream-and-gold interlocking linework.",
    streakDay: 275,
    background:
      "repeating-linear-gradient(90deg, #5c1422 0 5px, #7a1b2c 5px 10px), repeating-linear-gradient(0deg, rgba(232,213,163,0.14) 0 1px, transparent 1px 9px)",
    border: "#e8d5a3",
    emblem: "G",
  },
  {
    key: "card_back_eternal",
    label: "Eternal",
    blurb: "Black-and-gold celestial geometry with a living shimmer.",
    streakDay: 365,
    background:
      "radial-gradient(circle at 28% 26%, rgba(201,162,74,0.35) 0 6%, transparent 12%), radial-gradient(circle at 72% 74%, rgba(201,162,74,0.28) 0 4%, transparent 10%), repeating-linear-gradient(60deg, #0d0d10 0 7px, #191712 7px 8px)",
    border: "#c9a24a",
    emblem: "✦",
    animation: "sol-shimmer 7s ease-in-out infinite",
  },
] as const;

export type DeckSkin = {
  key: string;
  label: string;
  blurb: string;
  streakDay: number;
  /** Gold/foil accent applied to the face cards, or null for the plain deck. */
  accent: string | null;
  /** Glyph the face cards carry in the corner (crown/laurel). */
  crest: string | null;
};

export const DECK_SKINS: readonly DeckSkin[] = [
  {
    key: DECK_DEFAULT,
    label: "Standard Deck",
    blurb: "Clean white faces with the traditional pips.",
    streakDay: 0,
    accent: null,
    crest: null,
  },
  {
    key: "deck_grandmaster",
    label: "Grandmaster",
    blurb: "Gold-foil face cards with crown and laurel detail.",
    streakDay: 180,
    accent: "#c9a24a",
    crest: "♛",
  },
] as const;

/** Leaderboard/profile items the streak unlocks (not board surfaces). */
export type ProfileStreakItem = {
  id: string;
  label: string;
  streakDay: number;
  kind: string;
  blurb?: string;
};

export const PROFILE_STREAK_ITEMS = Object.freeze([
  { id: "badge_flame_14", label: "Amber Flame Badge", streakDay: 14, kind: "badge" },
  { id: "glow_streak_ember", label: "Ember Profile Glow", streakDay: 14, kind: "profile_glow" },
  { id: "username_streak_emerald", label: "Emerald Name Glow", streakDay: 30, kind: "username_effect" },
  { id: "glow_streak_frost", label: "Frost Profile Glow", streakDay: 60, kind: "profile_glow" },
  { id: "title_centurion", label: "CENTURION", streakDay: 100, kind: "title" },
  { id: "username_streak_centurion", label: "Centurion Name Flare", streakDay: 100, kind: "username_effect" },
  { id: "badge_flame_blue", label: "Electric Flame Badge", streakDay: 180, kind: "badge" },
  { id: "glow_streak_electric", label: "Electric Profile Glow", streakDay: 180, kind: "profile_glow" },
  { id: "username_streak_crimson", label: "Crimson Name Signature", streakDay: 275, kind: "username_effect" },
  { id: "glow_streak_eternal", label: "Eternal Profile Corona", streakDay: 365, kind: "profile_glow" },
  { id: "frame_eternal", label: "Eternal Frame", streakDay: 365, kind: "frame" },
  { id: "badge_365_plus", label: "[ 365+ ]", streakDay: 365, kind: "badge" },
]) as readonly ProfileStreakItem[];

const PROFILE_STREAK_ITEM_MAP = new Map(
  PROFILE_STREAK_ITEMS.map((item) => [item.id, item]),
);

/** Resolve a streak profile reward by id (null for board items). */
export function profileStreakItem(id: unknown): ProfileStreakItem | null {
  return typeof id === "string" ? PROFILE_STREAK_ITEM_MAP.get(id) ?? null : null;
}

const CARD_BACK_MAP = new Map(CARD_BACKS.map((item) => [item.key, item]));
const DECK_MAP = new Map(DECK_SKINS.map((item) => [item.key, item]));
const FELT_ITEMS = BOARD_THEMES.filter(
  (theme) => typeof theme.streakDay === "number" && theme.streakDay > 0,
);

/** A board item: what the drawer arms and the equip route accepts. */
export type BoardItem = {
  id: string;
  kind: "felt" | "card_back" | "deck_skin";
  label: string;
  blurb: string;
  streakDay: number;
};

export const BOARD_ITEMS: readonly BoardItem[] = [
  ...BOARD_THEMES.map((theme) => ({
    id: theme.key,
    kind: "felt" as const,
    label: theme.label,
    blurb: theme.blurb,
    streakDay: theme.streakDay ?? 0,
  })),
  ...CARD_BACKS.map((back) => ({
    id: back.key,
    kind: "card_back" as const,
    label: back.label,
    blurb: back.blurb,
    streakDay: back.streakDay,
  })),
  ...DECK_SKINS.map((deck) => ({
    id: deck.key,
    kind: "deck_skin" as const,
    label: deck.label,
    blurb: deck.blurb,
    streakDay: deck.streakDay,
  })),
];

const BOARD_ITEM_MAP = new Map(BOARD_ITEMS.map((item) => [item.id, item]));

export function boardItem(id: unknown): BoardItem | null {
  return typeof id === "string" ? BOARD_ITEM_MAP.get(id) ?? null : null;
}

/** True for an item that is always owned (streak day 0). */
export function isDefaultItem(id: string): boolean {
  return (BOARD_ITEM_MAP.get(id)?.streakDay ?? 0) === 0;
}

export function cardBackFor(value: unknown): CardBack {
  return CARD_BACK_MAP.get(typeof value === "string" ? value : "") ?? CARD_BACK_MAP.get(CARD_BACK_DEFAULT)!;
}

export function deckSkinFor(value: unknown): DeckSkin {
  return DECK_MAP.get(typeof value === "string" ? value : "") ?? DECK_MAP.get(DECK_DEFAULT)!;
}

/** The streak day an item needs, or 0 for an always-owned item. */
export function boardItemStreakDay(id: string): number {
  const item = BOARD_ITEM_MAP.get(id);
  if (item) return item.streakDay;
  const felt = FELT_ITEMS.find((theme) => theme.key === id);
  return felt?.streakDay ?? 0;
}

export function isBoardItemId(value: unknown): boolean {
  return typeof value === "string" && BOARD_ITEM_MAP.has(value);
}

export type { BoardThemeKey };
