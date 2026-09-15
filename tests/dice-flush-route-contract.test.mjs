// tests/dice-flush-route-contract.test.mjs
//
// Contract guard for the Dice Flush mutation endpoints.
//
// Regression: POST /api/dice-flush/choose-category returned the spread of
// `settleIfEnded(...)` — which is `{ state, ended, … }` with NO `success`
// field — straight to the client. The page checks
// `if (!res.ok || !d.success)` (see confirmPlay in
// src/app/casino/dice-flush/PageClient.tsx), so `d.success === undefined`
// made every successful "Confirm Play" alert "Failed" even though the
// category had already been banked server-side. Every other mutation route
// (roll / hold / call / ai-turn / create / join / start-ai / resign) does
// return the flag.
//
// These are deliberately static checks: the routes need a live database, so
// this asserts the response CONTRACT each one must satisfy — a success path
// that sets `success: true` and a failure path that sets `success: false`.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Endpoints the game page calls and reads `d.success` (or `d.error`) from. */
const MUTATION_ROUTES = [
  "roll",
  "hold",
  "call",
  "choose-category",
  "ai-turn",
  "auto-bank",
  "create",
  "join",
  "start-ai",
  "resign",
];

function source(name) {
  return readFileSync(
    fileURLToPath(new URL(`../src/app/api/dice-flush/${name}/route.js`, import.meta.url)),
    "utf8",
  );
}

for (const name of MUTATION_ROUTES) {
  test(`${name}: POST reports success: true on the happy path`, () => {
    const src = source(name);
    // `{ success: true, ...result }` and a plain `success: true` both count.
    assert.match(
      src,
      /success:\s*true/,
      `POST /api/dice-flush/${name} must return success: true — the client treats a missing flag as a failure`,
    );
  });

  test(`${name}: POST reports success: false with an error message on failure`, () => {
    const src = source(name);
    assert.match(
      src,
      /success:\s*false[\s\S]{0,80}?error:/,
      `POST /api/dice-flush/${name} must return { success: false, error } on failure`,
    );
  });
}

test("choose-category spreads the settled match state but still sets success", () => {
  const src = source("choose-category");
  assert.match(src, /\.\.\.endedResult/, "the resolved end-of-match state must still be returned");
  // The spread must not be the only thing returned (settleIfEnded has no
  // `success` field — that was the bug).
  assert.match(
    src,
    /\.\.\.endedResult,\s*\n\s*success:\s*true,/,
    "success: true must be set alongside the spread",
  );
});
