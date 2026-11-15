// tests/solitaire-offline-unlimited.test.mjs
//
// OFFLINE: solo solitaire and the unlimited puzzle stay playable with no
// network, and neither one stores progress while offline.
//
//   * the puzzle builder and answer check are browser-safe (no Node crypto),
//     and an offline position is deterministic for its seed;
//   * an offline key can never be replayed against the server;
//   * the puzzle card verifies locally and returns before the POST;
//   * solo routes every session/result write through one online-only guard.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  buildOfflinePuzzle,
  puzzleSeedFromKey,
  verifyPuzzleChoice,
} from "../src/lib/solitaire-duel/puzzleCore.ts";

test("an offline unlimited puzzle is built, checked and unsubmittable", () => {
  const puzzle = buildOfflinePuzzle(777);

  assert.equal(puzzle.kind, "unlimited");
  assert.equal(puzzle.dateKey, null);
  assert.equal(puzzle.choices.length, 3);
  assert.deepEqual(puzzle.choices.map((choice) => choice.label), ["A", "B", "C"]);
  assert.ok(puzzle.choices.some((choice) => choice.label === puzzle.answer));

  assert.equal(verifyPuzzleChoice(puzzle, puzzle.answer), true);
  for (const choice of puzzle.choices) {
    if (choice.label === puzzle.answer) continue;
    assert.equal(verifyPuzzleChoice(puzzle, choice.label), false);
  }

  // A server submit rebuilds an `unlimited:<uint32>` key. The offline key is
  // deliberately not one, so an offline answer can never be recorded later.
  assert.match(puzzle.key, /^unlimited:offline:/);
  assert.equal(puzzleSeedFromKey(puzzle.key), null);
});

test("the offline builder is deterministic for a seed", () => {
  const first = buildOfflinePuzzle(777);
  const second = buildOfflinePuzzle(777);
  assert.deepEqual(first.position, second.position);
  assert.deepEqual(first.choices, second.choices);
  assert.equal(first.answer, second.answer);
});

test("the browser-safe puzzle core imports no Node-only modules", () => {
  const source = fs.readFileSync("src/lib/solitaire-duel/puzzleCore.ts", "utf8");
  // Strip comments: the header deliberately names the server-only modules.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");

  for (const forbidden of ['from "crypto"', "node:crypto", "seeds.js", "require("]) {
    assert.equal(
      code.includes(forbidden),
      false,
      `puzzleCore.ts must not use ${forbidden}`,
    );
  }
});

test("the puzzle card builds locally and never posts while offline", () => {
  const card = fs.readFileSync("src/components/solitaire-duel/SolitairePuzzle.tsx", "utf8");

  assert.match(card, /buildOfflinePuzzle\(randomPuzzleSeed\(\)\)/);
  assert.match(card, /navigator\.onLine === false/);
  assert.match(card, /if \(offline\)/);

  // The offline branch verifies in place and returns BEFORE the submit fetch.
  const branch = card.indexOf("if (offline)");
  const submit = card.indexOf('fetch("/api/solitaire/puzzle",');
  assert.ok(branch >= 0 && submit > branch);
  assert.match(card.slice(branch, submit), /verifyPuzzleChoice/);

  // An offline answer is not persisted on the device either.
  assert.doesNotMatch(card, /localStorage|sessionStorage/);
});

test("solo routes every write through the online-only guard", () => {
  const solo = fs.readFileSync("src/components/solitaire-duel/SoloSolitaireGame.tsx", "utf8");

  assert.match(solo, /const persistSession = useCallback/);
  assert.match(solo, /if \(!onlineRef\.current\) return;/);
  assert.match(solo, /setSavedResult\("offline"\)/);
  assert.match(solo, /savedResult === "offline"/);
  // Nothing queues a write for later: the offline result path returns before
  // the POST and before any local record append.
  const guard = solo.indexOf('setSavedResult("offline")');
  const post = solo.indexOf("await fetch(endpoint");
  assert.ok(guard >= 0 && post > guard);
});
