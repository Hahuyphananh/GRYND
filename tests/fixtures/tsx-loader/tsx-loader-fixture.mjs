// tests/fixtures/tsx-loader/tsx-loader-fixture.mjs
//
// The child-process fixture run by tests/tsx-loader-named-exports.test.mjs.
//
// It is run as `node --import tsx --test <this file>` and does nothing except
// import named bindings from a `.js` and a `.ts` module next to it. It is not
// part of the `npm test` file list; the guard above runs it explicitly, so a
// loader that cannot expose those names fails there with one readable message.
//
// Deliberately imports only local modules — if this file itself needed a loader
// to load, the guard would be reporting the wrong failure.

import { test } from "node:test";
import assert from "node:assert/strict";
import { GREETING_PREFIX, greet } from "./plain-module.js";
import { DEFAULT_LIMIT, clampToList } from "./typed-module.ts";

test("named exports resolve from a local .js module", () => {
  assert.equal(GREETING_PREFIX, "hello ");
  assert.equal(greet("ada"), "hello ada");
});

test("named exports resolve from a local .ts module", () => {
  assert.equal(DEFAULT_LIMIT, 75);
  assert.equal(clampToList(100), 75);
  assert.equal(clampToList(3), 3);
});
