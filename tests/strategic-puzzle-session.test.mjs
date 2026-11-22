/**
 * THE STRATEGIC PUZZLE SESSION — the player's pure state machine.
 *
 * What this pins:
 *   * every library puzzle opens on a MASKED view: no next stock card, no
 *     face-down identity anywhere in the public board;
 *   * every accepted solution replays move by move through the session and
 *     finishes as `complete`, with the progress meter at its target;
 *   * progress never goes backwards along an accepted line, so the HUD cannot
 *     show a player losing ground on a winning path;
 *   * a legal move that is not part of the plan is `no-progress`, NOT `illegal`
 *     and not a failure — the copy the player sees is "does not advance the
 *     objective";
 *   * restart restores the declared opening exactly;
 *   * every objective line, hint and player-chrome key resolves in EN/FR/ES,
 *     and the player component reuses the shared board.
 *
 * Run: node --import tsx --test tests/strategic-puzzle-session.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { puzzleLibraryPuzzles } from "../src/lib/solitaire-duel/puzzleLibrary.ts";
import {
  applyPuzzleMove,
  createPuzzleSession,
  objectiveProgress,
  puzzleObjectiveLines,
  puzzleSessionProgress,
  puzzleViewFor,
  restartPuzzleSession,
} from "../src/lib/solitaire-duel/puzzleSession.ts";
import { PUZZLE_LIBRARY_TRANSLATIONS } from "../src/lib/puzzleLibraryTranslations.js";
import { PUZZLE_PLAYER_TRANSLATIONS } from "../src/lib/puzzlePlayerTranslations.js";
import { legalMoves } from "../src/lib/solitaire-duel/ai.ts";

const LIBRARY = puzzleLibraryPuzzles();
const PLAYER_SOURCE = fs.readFileSync(
  "src/components/solitaire-duel/StrategicPuzzlePlayer.tsx",
  "utf8",
);

function readPath(source, path) {
  return path.split(".").reduce((node, key) => (node == null ? undefined : node[key]), source);
}

function translationPath(key) {
  return key.replace(/^puzzleLibrary\./, "").replace(/^puzzlePlayer\./, "");
}

function resolveInAllLocales(translations, key, params = {}) {
  for (const locale of ["en", "fr", "es"]) {
    const template = readPath(translations[locale], translationPath(key));
    assert.equal(typeof template, "string", `${locale} is missing ${key}`);
    for (const param of Object.keys(params)) {
      assert.ok(template.includes(`{${param}}`), `${key} does not use {${param}}`);
    }
  }
}

test("every puzzle opens on a masked public view", () => {
  assert.ok(LIBRARY.length >= 8);

  for (const puzzle of LIBRARY) {
    const session = createPuzzleSession(puzzle.spec);
    assert.equal(session.stats.moves, 0);
    assert.equal(session.view.nextStockCard, null, `${puzzle.id} exposes the next stock card`);
    assert.equal(session.view.stockCount, puzzle.spec.startState.stock.length);

    const json = JSON.stringify(session.view);
    assert.equal(json.includes("startState"), false);
    for (const column of puzzle.spec.startState.tableau) {
      for (const pile of column) {
        if (pile.faceUp || !pile.card) continue;
        // The closing brace prevents `"rank":1` matching `"rank":11`.
        assert.equal(
          json.includes(`"suit":"${pile.card.suit}","rank":${pile.card.rank}}`),
          false,
          `${puzzle.id} leaks a face-down identity in its player view`,
        );
      }
    }
  }
});

test("every accepted solution completes through the session", () => {
  for (const puzzle of LIBRARY) {
    for (const path of puzzle.spec.solutions) {
      let session = createPuzzleSession(puzzle.spec);
      // Some objectives are measured from a non-zero opening (a foundation
      // milestone starts with the cards already up), so the invariant is
      // "not yet met", not "zero".
      const opening = puzzleSessionProgress(session);
      assert.ok(opening.current < opening.target, `${puzzle.id} is already solved at the start`);

      let lastStatus = null;
      for (const move of path) {
        const outcome = applyPuzzleMove(session, move);
        assert.notEqual(outcome.status, "illegal", `${puzzle.id} contains an illegal solution move`);
        session = outcome.session;
        lastStatus = outcome.status;
      }

      assert.equal(lastStatus, "complete", `${puzzle.id} did not complete on its accepted line`);
      assert.equal(session.stats.moves, path.length);
      const progress = puzzleSessionProgress(session);
      assert.equal(progress.current, progress.target, `${puzzle.id} progress did not reach target`);
      assert.equal(progress.measurable, true, `${puzzle.id} objective must be measurable`);
    }
  }
});

test("progress never decreases along an accepted line", () => {
  for (const puzzle of LIBRARY) {
    for (const path of puzzle.spec.solutions) {
      let session = createPuzzleSession(puzzle.spec);
      let previous = puzzleSessionProgress(session).current;
      for (const move of path) {
        const outcome = applyPuzzleMove(session, move);
        assert.equal(outcome.status === "illegal", false);
        session = outcome.session;
        const current = puzzleSessionProgress(session).current;
        assert.ok(
          current >= previous,
          `${puzzle.id} progress went backwards (${previous} -> ${current})`,
        );
        previous = current;
      }
    }
  }
});

test("a legal unrelated move is no-progress, not illegal", () => {
  let neutral = 0;

  for (const puzzle of LIBRARY) {
    const session = createPuzzleSession(puzzle.spec);
    for (const move of legalMoves(session.state)) {
      const outcome = applyPuzzleMove(session, move);
      assert.notEqual(outcome.status, "illegal", `${puzzle.id} proposed an illegal legal move`);
      if (outcome.status === "no-progress") neutral += 1;
    }
  }

  assert.ok(neutral > 0, "the library must contain legal moves that do not advance an objective");
});

test("restart restores the declared opening", () => {
  for (const puzzle of LIBRARY) {
    const first = createPuzzleSession(puzzle.spec);
    const move = puzzle.spec.solutions[0][0];
    const after = applyPuzzleMove(first, move).session;
    assert.ok(after.stats.moves > 0);

    const restarted = restartPuzzleSession(after);
    assert.equal(restarted.stats.moves, 0);
    assert.equal(restarted.stats.revealed, 0);
    assert.deepEqual(restarted.state, first.state);
    assert.deepEqual(restarted.view, first.view);
  }
});

test("the masked view helper is what the session actually uses", () => {
  for (const puzzle of LIBRARY) {
    const session = createPuzzleSession(puzzle.spec);
    assert.deepEqual(session.view, puzzleViewFor(puzzle.spec.startState));
  }
});

test("every objective line resolves in all three locales", () => {
  for (const puzzle of LIBRARY) {
    const lines = puzzleObjectiveLines(puzzle.spec.objective);
    assert.ok(lines.length >= 1, `${puzzle.id} has no objective line`);

    for (const line of lines) {
      const destinationParams = line.destination?.params ?? {};
      if (line.destination) {
        resolveInAllLocales(PUZZLE_LIBRARY_TRANSLATIONS, line.destination.key, destinationParams);
      }
      const params = {
        ...(line.params ?? {}),
        ...(line.destination ? { destination: "x" } : {}),
      };
      const translations = line.key.startsWith("puzzlePlayer.")
        ? PUZZLE_PLAYER_TRANSLATIONS
        : PUZZLE_LIBRARY_TRANSLATIONS;
      resolveInAllLocales(translations, line.key, params);
    }
  }
});

test("every hint and completion key resolves in all three locales", () => {
  for (const puzzle of LIBRARY) {
    for (const hint of puzzle.hints) {
      resolveInAllLocales(PUZZLE_LIBRARY_TRANSLATIONS, hint.key, hint.params ?? {});
    }
    for (const key of [
      puzzle.levelKey,
      `categories.${puzzle.category}.name`,
      `categories.${puzzle.category}.description`,
      `concepts.${puzzle.category}`,
      puzzle.explanation.whyKey.replace("puzzleLibrary.", ""),
      puzzle.explanation.alternativeKey.replace("puzzleLibrary.", ""),
      puzzle.explanation.detailKey.replace("puzzleLibrary.", ""),
    ]) {
      resolveInAllLocales(PUZZLE_LIBRARY_TRANSLATIONS, key.replace("puzzleLibrary.", ""));
    }
  }
});

test("the player chrome resolves in all three locales", () => {
  const keys = [
    "eyebrow",
    "heading",
    "intro.title",
    "intro.objective",
    "intro.skill",
    "intro.constraints",
    "intro.par",
    "intro.noMoveLimit",
    "intro.stock",
    "intro.start",
    "intro.position",
    "hud.objective",
    "hud.progress",
    "hud.moves",
    "hud.par",
    "hud.stockCycles",
    "hud.hints",
    "hud.showHint",
    "hud.hintsLeft",
    "hud.hintUsed",
    "hud.noHintsLeft",
    "hud.restart",
    "hud.exit",
    "hud.previous",
    "hud.next",
    "feedback.illegal",
    "feedback.noProgress",
    "feedback.progress",
    "feedback.complete",
    "complete.title",
    "complete.concept",
    "complete.explanation",
    "complete.line",
    "complete.revealed",
    "complete.foundation",
    "complete.cycles",
    "complete.multiple",
    "complete.hintsUsed",
    "complete.noHints",
    "complete.retry",
    "complete.next",
    "complete.exit",
    "states.empty",
    "objectives.openAnyColumn",
  ];

  for (const locale of ["en", "fr", "es"]) {
    for (const key of keys) {
      assert.equal(
        typeof readPath(PUZZLE_PLAYER_TRANSLATIONS[locale], key),
        "string",
        `${locale} is missing puzzlePlayer.${key}`,
      );
    }
  }
});

test("progress measurement is a pure function of the position and counters", () => {
  for (const puzzle of LIBRARY) {
    const session = createPuzzleSession(puzzle.spec);
    const direct = objectiveProgress(puzzle.spec.objective, session.state, {
      revealed: 0,
      signatures: [],
    });
    assert.deepEqual(puzzleSessionProgress(session), direct);
  }
});

test("the player reuses the shared board and never hardcodes the answer", () => {
  assert.match(PLAYER_SOURCE, /import SolitaireBoard from "\.\/SolitaireBoard"/);
  assert.match(PLAYER_SOURCE, /role="progressbar"/);
  assert.match(PLAYER_SOURCE, /aria-live="polite"/);
  assert.match(PLAYER_SOURCE, /useTranslation/);
  assert.match(PLAYER_SOURCE, /puzzles: PlayerPuzzle\[\]/);
  assert.equal(/puzzleLibraryPuzzles/.test(PLAYER_SOURCE), false);
  assert.equal(/puzzleLibraryData/.test(PLAYER_SOURCE), false);
  assert.equal(/Best move:/.test(PLAYER_SOURCE), false);
  assert.equal(/solution\[0\]/.test(PLAYER_SOURCE), false);
});
