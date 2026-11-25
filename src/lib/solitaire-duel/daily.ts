// src/lib/solitaire-duel/daily.ts
//
// THE DAILY CHALLENGE DEAL — server-only.
//
// One UTC calendar date maps to exactly one deal, for every player, forever:
//
//     date (YYYY-MM-DD) → deriveDealSeed → solvableDealFromSeed → deal
//
// The derivation is a SHA-256 of the date through the SAME seed function the
// ranked matchmaker uses (`seeds.js`), so the mapping is fixed and reproducible.
// Nothing the client sends is an input: a refresh, a new tab, a cleared cache or
// a different account cannot change today's deal. The raw deal is public to
// players (they must play it), but it cannot be rerolled — the only entity that
// decides the deal is the server, from its own clock.
//
// `solvableDealFromSeed` is used (rather than a plain shuffle) so a daily
// challenge is always winnable. The derivation is deterministic, so the search
// lands on the same deal for everyone; results are cached per date because the
// search is the expensive part and the answer can never change.
//
// SERVER-ONLY MODULE: it is imported by route handlers and tests, never by a
// client component.

import { deriveDealSeed } from "./seeds.js";
import { solvableDealFromSeed } from "./solvable";
import { VARIANT_VERSION } from "./constants";
import type { SolitaireDeal } from "./types";

const cache = new Map<string, SolitaireDeal>();
const MAX_CACHED_DATES = 32;

/** The deterministic 32-bit deal seed for a UTC date. */
export function dailyDealSeed(dateKey: string): number {
  return deriveDealSeed({
    serverSeed: `grynd-daily-challenge:${String(dateKey)}`,
    variantVersion: VARIANT_VERSION,
  });
}

/** The deal every player receives on `dateKey`. */
export function dailyDealFor(dateKey: string): SolitaireDeal {
  const key = String(dateKey);
  const cached = cache.get(key);
  if (cached) return cached;
  const deal = solvableDealFromSeed(dailyDealSeed(key));
  cache.set(key, deal);
  if (cache.size > MAX_CACHED_DATES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return deal;
}
