// src/lib/physics2d/deterministic.ts
//
// Canonical deterministic primitives shared by GRYND's authoritative
// simulations.
//
// Pure functions only: no Math.random(), no Date/clock, no I/O, no global
// state. The same input always produces the same output in every runtime
// (Node server, browser, test runner), which is what makes a shot replayable
// from its seed alone.
//
// These are the exact algorithms already shipped in
// `src/lib/plinko-pvp/physics.js` (Mulberry32 + the cyrb53-derived
// `hashSeed`). They are reimplemented here — rather than imported — so the
// live Plinko physics module is left completely untouched while new games can
// share one implementation. A future consolidation can point Plinko at this
// module without changing behaviour, because the bit-level output is
// identical.
//
// The Mini Golf simulator itself does NOT use randomness (a shot is fully
// determined by course + start position + angle + power). These primitives
// exist for deterministic *course generation* from a match seed, and for any
// future seeded jitter a game may want.

/**
 * Mulberry32 — a tiny, fast, deterministic 32-bit PRNG.
 *
 * Same seed → same sequence, every time. Returns a function producing
 * floats in [0, 1).
 *
 * @param seed Any integer. Coerced to an unsigned 32-bit value, so a signed
 *   int32 (which JS bitwise ops can produce) is accepted safely.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function rand(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Cheap hash of an arbitrary string to a 32-bit unsigned integer.
 *
 * Uses a cyrb53-style mix (a 53-bit variant of FNV) truncated to 32 bits.
 * Useful for deriving a huge, collision-resistant seed from human-readable
 * keys, e.g. `hashSeed("mini-golf:course:" + matchSeed + ":" + version)`.
 *
 * The final `>>> 0` is load-bearing: JS `^` returns a *signed* 32-bit number,
 * so without it the result could be negative and trip downstream range
 * validation. The bit pattern is preserved, so PRNG sequences are unchanged.
 */
export function hashSeed(input: unknown): number {
  const str = String(input);
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return ((h2 >>> 0) ^ (h1 >>> 0)) >>> 0;
}
