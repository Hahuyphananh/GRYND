/**
 * Solitaire-only regression contract.
 *
 * GRYND ships exactly one game: Solitaire Duel (with its ranked, vs-AI,
 * puzzle, solo and daily modes). The other game implementations have been
 * removed from this branch rather than archived.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { GAME_CATALOG } from "../src/lib/gameTags.js";
import { GAME_LANDING_PAGES } from "../src/lib/gameLandingPages.ts";
import { RATED_GAMES } from "../src/lib/rating.js";
import { ROOM_GAMES } from "../src/lib/rooms/catalog.ts";

const REMOVED_GAMES = [
  "barricade",
  "barrier-blitz",
  "battleship",
  "chess",
  "chess-game",
  "dice-flush",
  "dominoes",
  "dots-and-boxes",
  "four-in-a-row",
  "hex-duel",
  "hillstrike",
  "keno",
  "keno-pvp",
  "lane-runner",
  "memory-grid",
  "mines-pvp",
  "mini-golf",
  "neon-flush",
  "odds",
  "pool-masters",
  "precision",
  "rps",
  "speed-typing",
  "sudoku-duel",
  "tic-tac-toe",
  "tower-arena",
  "uno",
];

test("Solitaire Duel is the only game in the catalogue", () => {
  assert.deepEqual(
    GAME_CATALOG.map((game) => game.id),
    ["solitaire-duel"],
  );
});

test("Solitaire Duel is the only rated game", () => {
  assert.deepEqual([...RATED_GAMES], ["solitaire-duel"]);
});

test("the public landing catalogue is Solitaire-only", () => {
  assert.deepEqual(
    GAME_LANDING_PAGES.map((page) => page.slug),
    ["solitaire-duel"],
  );
});

test("private rooms are Solitaire-only", () => {
  assert.deepEqual(
    ROOM_GAMES.map((game) => game.key),
    ["solitaire-duel"],
  );
});

test("the removed games' page trees no longer exist", () => {
  for (const game of REMOVED_GAMES) {
    assert.equal(
      fs.existsSync(`src/app/casino/${game}`),
      false,
      `src/app/casino/${game} must be removed`,
    );
  }
});

test("Solitaire's own modes are intact", () => {
  for (const path of [
    "src/app/casino/solitaire-duel",
    "src/app/solitaire",
    "src/app/play/ai",
    "src/app/play/solo",
    "src/app/play/ranked",
    "src/app/play/daily",
    "src/app/play/daily-puzzle",
    "src/app/play/unlimited-puzzles",
    "src/lib/solitaire-duel/puzzle.ts",
    "src/lib/solitaire-duel/practice.ts",
    "src/lib/solitaire-duel/daily.ts",
  ]) {
    assert.equal(fs.existsSync(path), true, `${path} must exist`);
  }
});
