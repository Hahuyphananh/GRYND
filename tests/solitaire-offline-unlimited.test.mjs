// tests/solitaire-offline-unlimited.test.mjs
//
// OFFLINE: solo solitaire and the unlimited puzzle stay playable with no
// network, and neither one stores progress while offline.
//
//   * the puzzle builder and move check are browser-safe (no Node crypto),
//     and an offline position is deterministic for its seed;
//   * an offline key can never be replayed against the server;
//   * the puzzle card verifies the PLAYED MOVE locally and returns before the
//     POST, so a board played by hand works with no network at all;
//   * solo routes every session/result write through one online-only guard.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  buildOfflinePuzzle,
  moveSignature,
  puzzleSeedFromKey,
  verifyPuzzleMove,
} from "../src/lib/solitaire-duel/puzzleCore.ts";

test("an offline unlimited puzzle is built, judged and unsubmittable", () => {
  const puzzle = buildOfflinePuzzle(777);

  assert.equal(puzzle.kind, "unlimited");
  assert.equal(puzzle.dateKey, null);
  assert.equal(puzzle.board.tableau.length, 7);
  assert.ok(Array.isArray(puzzle.board.waste));

  assert.equal(verifyPuzzleMove(puzzle, puzzle.answer), true);
  // Drawing is a real move the board can send, and it may be the unique best
  // move; the verifier accepts exactly the recorded answer, whatever it is.
  assert.equal(
    verifyPuzzleMove(puzzle, { kind: "draw" }),
    moveSignature(puzzle.answer) === moveSignature({ kind: "draw" }),
  );
  assert.equal(verifyPuzzleMove(puzzle, { kind: "teleport" }), false);

  // A server submit rebuilds an `unlimited:<uint32>` key. The offline key is
  // deliberately not one, so an offline move can never be recorded later.
  assert.match(puzzle.key, /^unlimited:offline:/);
  assert.equal(puzzleSeedFromKey(puzzle.key), null);
});

test("the offline builder is deterministic for a seed", () => {
  const first = buildOfflinePuzzle(777);
  const second = buildOfflinePuzzle(777);
  assert.deepEqual(first.board, second.board);
  assert.deepEqual(first.answerBoard, second.answerBoard);
  assert.deepEqual(first.answerReveal, second.answerReveal);
  assert.equal(moveSignature(first.answer), moveSignature(second.answer));
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

  // The offline branch judges the PLAYED MOVE in place and returns BEFORE the
  // submit fetch.
  const branch = card.indexOf("if (offline)");
  const submit = card.indexOf('fetch("/api/solitaire/puzzle",');
  assert.ok(branch >= 0 && submit > branch);
  assert.match(card.slice(branch, submit), /verifyPuzzleMove/);

  // An offline move is not persisted on the device either.
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
