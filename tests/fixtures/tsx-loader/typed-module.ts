/**
 * Fixture for tests/tsx-loader-named-exports.test.mjs.
 *
 * This mirrors the TypeScript modules the test suite imports by name, such as
 * `src/lib/deadlineRead.ts` or `src/lib/quests/definitions.ts`: a `const` and a
 * function exported by name from a module the loader has to transpile first.
 *
 * The basename must not collide with the sibling `plain-module.js`, for the
 * reason given there.
 */

export const DEFAULT_LIMIT = 75;

export function clampToList(value: number, limit: number = DEFAULT_LIMIT): number {
  if (value > limit) return limit;
  return value;
}
