/**
 * SOLITAIRE PUZZLE — the engine contract behind a played move.
 *
 * The rules this file pins:
 *   * a puzzle is a pure function of its seed, so the submit route rebuilds the
 *     exact position the player moved in;
 *   * the public payload never contains the answer or the server's state;
 *   * the answer is a REAL move: applying it reveals exactly one card, and no
 *     other legal move in the position reveals any — so the puzzle has one
 *     defensible solution;
 *   * a move is accepted only by its engine signature (a draw, a stale card and
 *     a made-up kind are all refused), which is what lets the player move cards
 *     by hand instead of picking A/B/C;
 *   * the daily key is the UTC date, and its puzzle is the same for every player;
 *   * a free account gets 5 unlimited puzzles per UTC day, the 6th is denied,
 *     and GRYND PRO is never counted.
 *
 * Run: node --import tsx --test tests/solitaire-puzzle.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildPuzzleForSeed,
  dailyPuzzleDateKey,
  dailyPuzzleKey,
  getDailyPuzzle,
  getUnlimitedPuzzle,
  moveSignature,
  parsePuzzleMove,
  publicPuzzle,
  puzzleSeedFromKey,
  verifyPuzzleMove,
} from "../src/lib/solitaire-duel/puzzle.ts";
import { legalMoves } from "../src/lib/solitaire-duel/ai.ts";
import { applyMove } from "../src/lib/solitaire-duel/rules.ts";
import {
  FREE_PUZZLES_PER_DAY,
  freePuzzleAllowance,
  unlimitedPuzzleAllowance,
  consumePuzzleAllowance,
  readPuzzleAllowance,
} from "../src/lib/solitaire-duel/puzzleAllowance.ts";

const DAY = new Date("2026-11-14T12:00:00Z");

test("the daily key is the UTC calendar date", () => {
  assert.equal(dailyPuzzleDateKey(DAY), "2026-11-14");
  assert.equal(dailyPuzzleDateKey(new Date("2026-11-14T23:59:59Z")), "2026-11-14");
  assert.equal(dailyPuzzleKey("2026-11-14"), "daily:2026-11-14");
});

test("an unlimited key only parses a valid uint32 seed", () => {
  assert.equal(puzzleSeedFromKey("unlimited:123"), 123);
  assert.equal(puzzleSeedFromKey("unlimited:0"), 0);
  assert.equal(puzzleSeedFromKey("unlimited:4294967295"), 4294967295);
  assert.equal(puzzleSeedFromKey("unlimited:4294967296"), null);
  assert.equal(puzzleSeedFromKey("unlimited:abc"), null);
  assert.equal(puzzleSeedFromKey("unlimited:"), null);
  assert.equal(puzzleSeedFromKey("daily:2026-11-14"), null);
});

test("a seeded puzzle is deterministic and ships a playable board", () => {
  // Not every deal has a position that satisfies the puzzle contract, so find
  // a seed that does rather than pinning one that may stop qualifying.
  let seed = -1;
  let first = null;
  for (let candidate = 0; candidate < 40 && !first; candidate += 1) {
    first = buildPuzzleForSeed(candidate);
    if (first) seed = candidate;
  }
  assert.ok(first, "at least one seed in 0..39 must produce a verified puzzle");

  const second = buildPuzzleForSeed(seed);
  assert.ok(second, "rebuilding the same seed must succeed");
  assert.deepEqual(first.board, second.board);
  assert.deepEqual(first.answerBoard, second.answerBoard);
  assert.deepEqual(first.answerReveal, second.answerReveal);
  assert.equal(moveSignature(first.answer), moveSignature(second.answer));

  // A real Klondike board: seven columns, a stock count and a waste.
  assert.equal(first.board.tableau.length, 7);
  assert.ok(first.board.stockCount >= 0);
  assert.ok(Array.isArray(first.board.waste));
});

test("the answer is a legal move that reveals exactly one card", () => {
  const puzzle = getUnlimitedPuzzle(777);
  const applied = applyMove({ state: puzzle.state, move: puzzle.answer });
  assert.equal(applied.ok, true, "the answer must be a move the engine accepts");
  assert.equal(applied.revealed.length, 1, "the answer must turn exactly one card over");
  assert.deepEqual(applied.revealed[0], puzzle.answerReveal.card);
  assert.ok(puzzle.answerReveal.column >= 0 && puzzle.answerReveal.column < 7);

  // The board after the answer is the position the solution is shown from.
  assert.equal(puzzle.answerBoard.ply, puzzle.board.ply + 1);
});

test("no other legal move reveals a card, so the answer is unique", () => {
  const puzzle = getUnlimitedPuzzle(777);
  const answerSignature = moveSignature(puzzle.answer);

  const rivalReveals = legalMoves(puzzle.state).filter((move) => {
    if (moveSignature(move) === answerSignature) return false;
    const applied = applyMove({ state: puzzle.state, move });
    return applied.ok && applied.revealed.length > 0;
  });

  assert.deepEqual(
    rivalReveals,
    [],
    "a position with a second card-revealing move has no single defensible answer",
  );
});

test("only the engine signature of the answer is accepted", () => {
  const puzzle = getUnlimitedPuzzle(777);
  assert.equal(verifyPuzzleMove(puzzle, puzzle.answer), true);

  // Drawing is a real move, and it is not the answer.
  assert.equal(verifyPuzzleMove(puzzle, { kind: "draw" }), false);

  // Garbage, near-misses and non-moves are all refused, never thrown on.
  assert.equal(verifyPuzzleMove(puzzle, null), false);
  assert.equal(verifyPuzzleMove(puzzle, "A"), false);
  assert.equal(verifyPuzzleMove(puzzle, { kind: "teleport" }), false);
  assert.equal(verifyPuzzleMove(puzzle, { kind: "waste-to-tableau", toColumn: 99 }), false);
  assert.equal(verifyPuzzleMove(puzzle, { kind: "tableau-to-tableau", fromColumn: 0 }), false);
  assert.equal(
    verifyPuzzleMove(puzzle, { kind: "waste-to-tableau", toColumn: "0" }),
    false,
  );
});

test("a client move is parsed field by field", () => {
  assert.deepEqual(parsePuzzleMove({ kind: "draw" }), { kind: "draw" });
  assert.deepEqual(parsePuzzleMove({ kind: "waste-to-foundation", suit: "hearts" }), {
    kind: "waste-to-foundation",
    suit: "hearts",
  });
  assert.deepEqual(
    parsePuzzleMove({
      kind: "tableau-to-tableau",
      fromColumn: 2,
      toColumn: 5,
      card: { suit: "clubs", rank: 7 },
    }),
    {
      kind: "tableau-to-tableau",
      fromColumn: 2,
      toColumn: 5,
      card: { suit: "clubs", rank: 7 },
    },
  );

  assert.equal(parsePuzzleMove(null), null);
  assert.equal(parsePuzzleMove({}), null);
  // Extra fields on a draw are harmless — it is still the draw move.
  assert.deepEqual(parsePuzzleMove({ kind: "draw", toColumn: 0 }), { kind: "draw" });
  assert.equal(parsePuzzleMove({ kind: "waste-to-tableau", toColumn: 7 }), null);
  assert.equal(parsePuzzleMove({ kind: "waste-to-foundation", suit: "joker" }), null);
  assert.equal(
    parsePuzzleMove({
      kind: "tableau-to-tableau",
      fromColumn: 0,
      toColumn: 1,
      card: { suit: "clubs", rank: 14 },
    }),
    null,
  );
});

test("the public payload never contains the answer or the server state", () => {
  const puzzle = getDailyPuzzle("2026-11-14");
  const safe = publicPuzzle(puzzle);

  for (const hidden of ["answer", "answerBoard", "answerReveal", "state", "seed"]) {
    assert.equal(hidden in safe, false, `${hidden} must not reach the browser`);
  }
  assert.equal(safe.key, "daily:2026-11-14");
  assert.equal(safe.kind, "daily");
  assert.equal(safe.board.tableau.length, 7);
  // Face-down positions carry no identity, exactly like a duel view.
  const hiddenSlots = safe.board.tableau.flat().filter((slot) => !slot.faceUp);
  assert.ok(hiddenSlots.every((slot) => slot.card === null));
});

test("the daily puzzle is identical for the same date", () => {
  const first = getDailyPuzzle("2026-11-14");
  const second = getDailyPuzzle("2026-11-14");
  assert.deepEqual(first.board, second.board);
  assert.equal(moveSignature(first.answer), moveSignature(second.answer));
  assert.deepEqual(first.answerReveal, second.answerReveal);
});

test("the free allowance is 5 per day and PRO is unlimited", () => {
  assert.equal(FREE_PUZZLES_PER_DAY, 5);

  const fresh = freePuzzleAllowance(0, DAY);
  assert.equal(fresh.remaining, 5);
  assert.equal(fresh.limit, 5);
  assert.equal(fresh.dayKey, "2026-11-14");

  const nearlyDone = freePuzzleAllowance(4, DAY);
  assert.equal(nearlyDone.remaining, 1);

  const pro = unlimitedPuzzleAllowance(DAY);
  assert.equal(pro.unlimited, true);
  assert.equal(pro.limit, null);
  assert.equal(pro.remaining, null);
});

test("the sixth unlimited puzzle is denied and PRO never consumes a slot", async () => {
  const rows = new Map();
  const deps = {
    readUsage: async ({ playerId, dayKey }) => rows.get(`${playerId}:${dayKey}`) ?? 0,
    consumeUsage: async ({ playerId, dayKey, limit = FREE_PUZZLES_PER_DAY }) => {
      const key = `${playerId}:${dayKey}`;
      const used = rows.get(key) ?? 0;
      if (used >= limit) return null;
      rows.set(key, used + 1);
      return used + 1;
    },
  };

  for (let index = 0; index < 5; index += 1) {
    const result = await consumePuzzleAllowance(
      { playerId: "user_1", isPro: false, now: DAY },
      deps,
    );
    assert.equal(result.allowed, true);
    assert.equal(result.allowance.remaining, 4 - index);
  }

  const denied = await consumePuzzleAllowance(
    { playerId: "user_1", isPro: false, now: DAY },
    deps,
  );
  assert.equal(denied.allowed, false);
  assert.equal(denied.allowance.remaining, 0);

  const member = await consumePuzzleAllowance(
    { playerId: "user_1", isPro: true, now: DAY },
    deps,
  );
  assert.equal(member.allowed, true);
  assert.equal(member.allowance.unlimited, true);
  assert.equal(rows.get(`user_1:${dailyPuzzleDateKey(DAY)}`), 5);

  const read = await readPuzzleAllowance(
    { playerId: "user_1", isPro: false, now: DAY },
    deps,
  );
  assert.equal(read.used, 5);
  assert.equal(read.remaining, 0);
});

test("a store failure fails open rather than blocking the puzzle", async () => {
  const failing = {
    readUsage: async () => {
      throw new Error("db down");
    },
    consumeUsage: async () => {
      throw new Error("db down");
    },
  };
  const result = await consumePuzzleAllowance(
    { playerId: "user_2", isPro: false, now: DAY },
    failing,
  );
  assert.equal(result.allowed, true);
  assert.equal(result.allowance.remaining, FREE_PUZZLES_PER_DAY);
});
