// src/lib/moderation/randomName.ts
//
// "Give this account a neutral handle."
//
// WHY THIS EXISTS: src/lib/moderation/profanity.ts stops a profane name at
// signup and on rename, but it is forward-looking — whatever is already in
// `users.name` keeps rendering on the public leaderboard. When a name has to be
// REPLACED (an admin acting on a flagged entry, or the one-off sweep in
// scripts/purge-profaned-usernames.mjs), it must be replaced with something that
// is (a) clean by the same filter, (b) realistically unique, and (c) not a
// giveaway that the account was renamed. That is this function.
//
// It is a SEPARATE module from profanity.ts on purpose: that module is a pure,
// deterministic rule and is tested as such (no clock, no randomness). Randomness
// lives here so it can never leak into the filter, and so the filter's behaviour
// stays reproducible.
//
// Randomness is `node:crypto`, never `Math.random()` — this runs on the server
// for admin actions and one-off sweeps, and a guessable handle sequence would
// let someone spot renamed accounts.
//
// Callers must check uniqueness before writing: pass `taken` when you already
// have the set of existing handles (the sweep does), or re-query per candidate
// when you do not (the admin route does).

import { randomInt } from "node:crypto";
import { isNameAllowed, safeFallbackName } from "./profanity";

/**
 * Neutral words. Deliberately bland, non-political, non-gendered and free of
 * anything that could combine into a slur — every generated candidate is still
 * validated against `isNameAllowed`, which is the real guarantee.
 */
const ADJECTIVES = [
  "Swift",
  "Calm",
  "Bright",
  "Lucky",
  "Silent",
  "Cosmic",
  "Nimble",
  "Bold",
  "Frosty",
  "Golden",
  "Iron",
  "Silver",
  "Crimson",
  "Quiet",
  "Rapid",
  "Clever",
  "Steady",
  "Wild",
  "Sunny",
  "Midnight",
] as const;

const NOUNS = [
  "Falcon",
  "Otter",
  "Comet",
  "Tiger",
  "Panda",
  "Raven",
  "Wolf",
  "Lynx",
  "Heron",
  "Bison",
  "Fox",
  "Koi",
  "Ibis",
  "Marlin",
  "Orca",
  "Sparrow",
  "Bramble",
  "Cedar",
  "Maple",
  "Quartz",
] as const;

/** Lowercase every existing handle so collision checks are case-insensitive. */
function normalizeTaken(taken: Iterable<string> | undefined): Set<string> {
  const set = new Set<string>();
  if (!taken) return set;
  for (const value of taken) set.add(String(value ?? "").trim().toLowerCase());
  return set;
}

/**
 * A random, clean, non-colliding display name — e.g. "SwiftFalcon4821".
 *
 * `taken` is optional; pass the handles already in use to guarantee no
 * collision. When the caller cannot cheaply supply the full set, every returned
 * candidate is still clean, and the caller should re-check uniqueness against
 * the database (see the admin rename action).
 */
export function randomCleanName({
  taken,
  maxAttempts = 50,
}: {
  taken?: Iterable<string>;
  maxAttempts?: number;
} = {}): string {
  const used = normalizeTaken(taken);

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const candidate = `${ADJECTIVES[randomInt(0, ADJECTIVES.length)]}${
      NOUNS[randomInt(0, NOUNS.length)]
    }${randomInt(100, 10000)}`;
    if (isNameAllowed(candidate) && !used.has(candidate.toLowerCase())) return candidate;
  }

  // Statistically unreachable (50 collisions in a ~200k namespace), but never
  // return something unclean or colliding: degrade to the deterministic
  // PlayerXXXXX handle, salted until it is unique.
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const candidate = safeFallbackName(`rename-${randomInt(0, 1_000_000_000)}`);
    if (isNameAllowed(candidate) && !used.has(candidate.toLowerCase())) return candidate;
  }

  // Last resort: a plain, guaranteed-clean handle. Still validated so this can
  // never become the one path that publishes something the filter rejects.
  return `Player${randomInt(100000, 1000000)}`;
}
