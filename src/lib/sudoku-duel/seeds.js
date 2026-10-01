// src/lib/sudoku-duel/seeds.js
//
// The provably-fair seed system behind Sudoku Duel's shared puzzle. Mirrors
// `src/lib/solitaire-duel/seeds.js` (which mirrors Memory Grid's):
//
//   * a 32-byte random SERVER seed is generated once per match
//     (crypto.randomBytes — never client-supplied)
//   * its SHA-256 hash is committed to the match row BEFORE play, so the puzzle
//     is fixed and verifiable from the moment the row exists
//   * the puzzle seed is a SHA-256 digest of
//     `${serverSeed}:variant:${variantVersion}` truncated to a 32-bit unsigned
//     int — ONE derivation, so the generator produces the exact same board for
//     both seats and for anyone auditing later. The match id is deliberately NOT
//     an input: the server seed is already unique to the match, so the exact
//     puzzle can be rebuilt from the stored seed ALONE.
//   * the raw server seed is revealed only when the match is terminal, so either
//     player can verify the puzzle they played is the one that was committed
//
// There is deliberately NO per-player seed: BOTH seats solve the puzzle derived
// from this one seed, which is the entire fairness claim of the game.
//
// SERVER-ONLY MODULE: it imports Node's `crypto`, so it must never be imported
// from a client component. The client-safe pieces (`./generator.ts`,
// `./rules.ts`) import nothing from here; they accept an already-derived numeric
// seed.

import crypto from "crypto";

/** Random hex string from a cryptographically-secure PRNG — the match seed. */
export function randomHex(size = 32) {
  return crypto.randomBytes(size).toString("hex");
}

/**
 * SHA-256 hex digest of the server seed — the pre-match commitment.
 *
 * Shown to both clients before they play, so the post-match seed reveal can be
 * verified: if the revealed seed hashes to the committed value, the puzzle that
 * was played is the puzzle that was fixed at match creation.
 */
export function getServerSeedHash(serverSeed) {
  return crypto.createHash("sha256").update(String(serverSeed)).digest("hex");
}

/**
 * Deterministic 32-bit puzzle seed.
 *
 * Both seats generate their board from this one value, and the variant version
 * is part of the digest input, so a future ruleset change can never reinterpret
 * an existing match's stored puzzle as a different board.
 *
 * @param {object} opts
 * @param {string} opts.serverSeed       the match's random server seed
 * @param {number} [opts.variantVersion] the frozen ruleset version
 * @returns {number} unsigned 32-bit int seed for `generatePuzzle`
 */
export function derivePuzzleSeed({ serverSeed, variantVersion = 1 }) {
  const digest = crypto
    .createHash("sha256")
    .update(`${serverSeed}:variant:${variantVersion}`)
    .digest("hex");
  // First 8 hex chars → 32-bit unsigned int. `>>> 0` keeps it non-negative for
  // the generator's `normalizeSeed`, matching the platform's `hashSeed`.
  return parseInt(digest.slice(0, 8), 16) >>> 0;
}

/** The reveal check a client (or a test) runs post-match. */
export function verifyPuzzleSeed({ serverSeed, variantVersion = 1, puzzleSeed }) {
  return derivePuzzleSeed({ serverSeed, variantVersion }) === Number(puzzleSeed);
}
