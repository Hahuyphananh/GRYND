/**
 * reviews-moderation.test.mjs
 *
 * Placeholder reviews must never reach the public pages.
 *
 * The incident: a hand-seeded review (title "Test review", body "Test") was
 * approved and left live on /reviews, credited to a "Verified player". A
 * moderation queue cannot catch that — the row was approved on purpose — so the
 * public READ path refuses placeholder content outright, and a migration deletes
 * the rows it finds.
 *
 * The dangerous failure mode here is the opposite one: hiding a REAL review.
 * That is why the rule is "BOTH fields are empty-or-placeholder" and why the
 * false-positive cases below are asserted explicitly.
 *
 * Run:  node --import tsx --test tests/reviews-moderation.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  PLACEHOLDER_REVIEW_VALUES,
  isPlaceholderReview,
  isPlaceholderReviewField,
  normalizeReviewField,
} from "../src/lib/reviews.ts";

// ── The incident ─────────────────────────────────────────────────────────

test("the seeded test review is recognised as a placeholder, however it is spelled", () => {
  const variants = [
    { title: "Test review", body: "Test" },
    { title: "Test", body: "Test" },
    { title: "TEST REVIEW", body: "  test  " },
    { title: "test-review", body: "testing" },
    { title: "Testing", body: "Testing" },
    { title: "Test test", body: "asdf" },
    { title: "foo", body: "bar" },
    { title: "Placeholder", body: "Lorem ipsum" },
    { title: "Sample", body: "Sample" },
    { title: "aaa", body: "bbb" },
  ];
  for (const review of variants) {
    assert.equal(
      isPlaceholderReview(review),
      true,
      `${JSON.stringify(review)} must not be publishable`,
    );
  }
});

test("a review with no content in either field is a placeholder", () => {
  assert.equal(isPlaceholderReview({ title: "", body: "" }), true);
  assert.equal(isPlaceholderReview({ title: null, body: null }), true);
  assert.equal(isPlaceholderReview({ title: "Test review", body: null }), true);
  assert.equal(isPlaceholderReview({ title: undefined, body: "test" }), true);
  assert.equal(isPlaceholderReview({}), true);
});

// ── The false-positive guard ─────────────────────────────────────────────

test("real reviews are never hidden, even when one field looks like a test", () => {
  const publishable = [
    // Real prose that merely CONTAINS a placeholder word.
    { title: "A real test of skill", body: "Every match comes down to the last move." },
    { title: "Great", body: "I test my openings here every evening and it shows." },
    { title: null, body: "Loving the chess ladder and the solitaire duel." },
    { title: "Solid", body: null },
    { title: "Testing my limits", body: "The elo system keeps me coming back." },
    { title: "5 stars", body: "Fast, fair and genuinely fun." },
    // One field placeholder, the other real → still publishable.
    { title: "test", body: "Honestly the best PvP lobby I have used." },
    { title: "Highly recommend", body: "sample" },
  ];
  for (const review of publishable) {
    assert.equal(
      isPlaceholderReview(review),
      false,
      `${JSON.stringify(review)} must stay publishable`,
    );
  }
});

test("normalization folds punctuation, case and spacing before matching", () => {
  assert.equal(normalizeReviewField("Test review"), "testreview");
  assert.equal(normalizeReviewField("  TEST  "), "test");
  assert.equal(normalizeReviewField("Test-review!"), "testreview");
  assert.equal(normalizeReviewField(null), "");
  assert.equal(normalizeReviewField(undefined), "");
  assert.equal(normalizeReviewField("Real review"), "realreview");
  assert.equal(isPlaceholderReviewField("test!!!"), true);
  assert.equal(isPlaceholderReviewField("tests"), false);
});

test("the placeholder token list is safe to inline into SQL", () => {
  assert.ok(PLACEHOLDER_REVIEW_VALUES.length > 0);
  for (const value of PLACEHOLDER_REVIEW_VALUES) {
    assert.match(
      value,
      /^[a-z0-9]+$/,
      `${value} must be lowercase alphanumeric (it is inlined, not parameterised)`,
    );
  }
  // No duplicates — a duplicated token would silently inflate the SQL list.
  assert.equal(new Set(PLACEHOLDER_REVIEW_VALUES).size, PLACEHOLDER_REVIEW_VALUES.length);
});

// ── Code and database must agree ─────────────────────────────────────────

test("the public read path filters placeholders in BOTH queries", async () => {
  const source = readFileSync(new URL("../src/lib/reviews.ts", import.meta.url), "utf8");

  // getApprovedReviews (the wall) and getReviewStats (the aggregate + JSON-LD)
  // must use the same predicate, or the page would advertise a score the wall
  // cannot show.
  const filtered = source.match(/\.where\(PUBLISHABLE\)/g) ?? [];
  assert.equal(filtered.length, 2, "both public queries must go through PUBLISHABLE");

  // The unfiltered form must be gone, or one surface would leak the row back.
  assert.equal(
    source.includes('where(eq(productReviews.status, "approved"))'),
    false,
    "a query still filters on status alone",
  );
});

test("the cleanup migration mirrors the code's token list exactly", () => {
  const migration = readFileSync(
    new URL("../src/db/migrations/0194_purge_placeholder_reviews.sql", import.meta.url),
    "utf8",
  );

  // Only approved rows are eligible, and only when both fields are placeholders.
  assert.match(migration, /status = 'approved'/);
  assert.equal((migration.match(/regexp_replace\(lower\(coalesce\(title, ''\)/g) ?? []).length, 1);
  assert.equal((migration.match(/regexp_replace\(lower\(coalesce\(body, ''\)/g) ?? []).length, 1);

  const lists = [...migration.matchAll(/IN \(([^)]*)\)/g)].map((match) => match[1]);
  assert.equal(lists.length, 2, "expected one token list for the title and one for the body");

  const expected = [...PLACEHOLDER_REVIEW_VALUES].sort();
  for (const list of lists) {
    const tokens = [...list.matchAll(/'([^']+)'/g)].map((match) => match[1]).sort();
    assert.deepEqual(
      tokens,
      expected,
      "the migration and PLACEHOLDER_REVIEW_VALUES have drifted apart",
    );
  }
});
