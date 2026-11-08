// standalone/memory-grid/src/seed.ts
//
// The seed a local match derives its round patterns from.
//
// The app derives this on the server from a 32-byte `crypto.randomBytes` seed
// (`src/lib/memory-grid/seeds.js`), which is Node-only and is deliberately NOT
// imported here. A standalone match has no opponent to be fair to and nothing to
// commit to, so it needs exactly one thing: a fresh, unpredictable 32-bit seed
// from the platform's cryptographic RNG.
//
// No fallback to `Math.random()`: a weak seed would be a silent downgrade, and
// every browser that can run this build has `crypto.getRandomValues`. If it is
// missing the game reports a clear error instead of dealing predictable grids.

export function randomSeed(): number {
  const source = globalThis.crypto;
  if (!source || typeof source.getRandomValues !== "function") {
    throw new Error("This build needs a browser with crypto.getRandomValues");
  }
  // `>>> 0` keeps the value in the unsigned 32-bit range everything downstream
  // (`hashSeed`, `generatePattern`) expects.
  return source.getRandomValues(new Uint32Array(1))[0] >>> 0;
}
