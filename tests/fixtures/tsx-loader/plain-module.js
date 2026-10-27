/**
 * Fixture for tests/tsx-loader-named-exports.test.mjs.
 *
 * This is ESM-authored JavaScript living inside a CommonJS package, which is
 * exactly how `src/lib/*.js` (for example `src/lib/chatMessageList.js`) looks.
 * It deliberately has no `.ts` syntax: the loader under test has to expose these
 * names without needing to transform anything.
 *
 * The basename must not collide with the sibling `typed-module.ts`: the loader
 * prefers a `.ts` file when a `.js` specifier could resolve to either, so two
 * files sharing a basename would test the wrong module.
 */

export const GREETING_PREFIX = "hello ";

export function greet(name) {
  return `${GREETING_PREFIX}${name}`;
}
