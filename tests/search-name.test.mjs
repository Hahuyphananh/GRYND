// tests/search-name.test.mjs
//
// Unit tests for src/lib/searchName.ts — the fold that produces
// `users.search_name`, the key /api/friends/search matches a typed query
// against.
//
// The invariant these tests protect is that BOTH sides use this one function:
// the fold applied when a username is written and the fold applied to the
// typed query. When they drift — a stored name that keeps its accents, a query
// that does not — the account becomes unfindable by its own username, which is
// exactly how "Alexandre Thériault" stopped turning up in friend search.
//
// The accented table below is the same mapping the backfill migration
// (0162_users_search_name.sql) applies with `translate()`, so a key written by
// the app and a key backfilled by SQL agree.

import test from "node:test";
import assert from "node:assert/strict";
import { searchNameFor, SEARCH_NAME_MAX_LENGTH } from "../src/lib/searchName.ts";

test("lowercases the username", () => {
  assert.equal(searchNameFor("StupidGayzz"), "stupidgayzz");
  assert.equal(searchNameFor("ALEXANDRE"), "alexandre");
});

test("removes whitespace entirely, wherever it sits", () => {
  assert.equal(searchNameFor("Alexandre Thériault"), "alexandretheriault");
  assert.equal(searchNameFor("  T Y  "), "ty");
  assert.equal(searchNameFor("GRYND AI 5"), "gryndai5");
  assert.equal(searchNameFor("a\tb\nc"), "abc");
});

test("folds every accent the SQL backfill folds", () => {
  const accented = "àáâãäåçèéêëìíîïñòóôõöùúûüýÿ";
  const plain = "aaaaaaceeeeiiiinooooouuuuyy";
  assert.equal(accented.length, plain.length);
  for (let i = 0; i < accented.length; i += 1) {
    assert.equal(
      searchNameFor(accented[i]),
      plain[i],
      `${accented[i]} should fold to ${plain[i]}`,
    );
  }
  assert.equal(searchNameFor("José  Émile"), "joseemile");
});

test("every spelling of a username folds to the same key", () => {
  // What a player types, and what another player's row stores, must meet.
  const stored = searchNameFor("Alexandre Thériault");
  assert.equal(searchNameFor("theriault"), "theriault");
  assert.ok(stored.includes(searchNameFor("theriault")));
  assert.equal(searchNameFor("alexandre theriault"), stored);
  assert.equal(searchNameFor("ALEXANDRETHERIAULT"), stored);
  assert.equal(searchNameFor("thériault"), searchNameFor("theriault"));
});

test("a rename produces the new key, never the old one", () => {
  const before = searchNameFor("Tour Tester");
  const after = searchNameFor("Tour Master");
  assert.equal(before, "tourtester");
  assert.equal(after, "tourmaster");
  assert.notEqual(before, after);
});

test("caps the key at the column length", () => {
  assert.equal(SEARCH_NAME_MAX_LENGTH, 255);
  assert.equal(searchNameFor("a".repeat(300)).length, 255);
  // Folding never lengthens a name, so a 255-char username stays intact.
  assert.equal(searchNameFor("b".repeat(255)).length, 255);
});

test("tolerates missing or non-string names", () => {
  assert.equal(searchNameFor(null), "");
  assert.equal(searchNameFor(undefined), "");
  assert.equal(searchNameFor(""), "");
  assert.equal(searchNameFor("   "), "");
  assert.equal(searchNameFor(42), "42");
});
