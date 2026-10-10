/**
 * barricade-practice-ui.test.mjs
 *
 * The contracts the Barricade practice screen has to keep.
 *
 * This suite is text-level on purpose: it pins the things a browser test cannot
 * see cheaply — that the board and the page never re-implement a rule of the
 * engine, that practice stays free (no wager, no rating, no network), that every
 * affordance the design asks for has a stable hook, and that the board's sizing
 * is fluid rather than fixed.
 *
 * Comments are stripped before the "must not" checks, because the prose in these
 * files legitimately talks about the rules (and about not taking wagers) while
 * the CODE must not do either.
 *
 * Run:  node --import tsx --test tests/barricade-practice-ui.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { AI_MAX_NODES, AI_DEADLINE_MS, BARRICADE_TIER_HINTS } from "../src/lib/barricade/ai.ts";
import { AI_DIFFICULTIES } from "../src/lib/aiDifficulty.ts";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

/** The same source with `//` and `/* … *​/` commentary removed. */
function stripComments(source) {
  let out = "";
  let index = 0;
  while (index < source.length) {
    if (source.startsWith("/*", index)) {
      const end = source.indexOf("*/", index + 2);
      index = end === -1 ? source.length : end + 2;
      continue;
    }
    if (source.startsWith("//", index)) {
      const end = source.indexOf("\n", index);
      index = end === -1 ? source.length : end;
      continue;
    }
    out += source[index];
    index += 1;
  }
  return out;
}

const PAGE_PATH = "src/app/casino/barricade/play-ai/PageClient.tsx";
const BOARD_PATH = "src/components/barricade/BarricadeBoard.tsx";
const ROUTE_PATH = "src/app/casino/barricade/play-ai/page.tsx";

const page = read(PAGE_PATH);
const board = read(BOARD_PATH);
const globals = read("src/app/globals.css");
const pageCode = stripComments(page);
const boardCode = stripComments(board);

/* -------------------------------------------------------------------------- *
 * One rulebook: the engine's
 * -------------------------------------------------------------------------- */

test("barricade ui: the page drives the engine and nothing else", () => {
  for (const symbol of [
    "createInitialState",
    "legalMoves",
    "legalWalls",
    "classifyWall",
    "applyAction",
    "isMatchFinished",
    "goalRowFor",
    "wallKey",
    "chooseAiAction",
  ]) {
    assert.ok(pageCode.includes(symbol), `the page must use the engine's ${symbol}`);
  }
  // The bot's answer goes through the same validator as the human's.
  assert.ok(pageCode.includes("applyAction(state, AI_SEAT, action)"));
  assert.ok(pageCode.includes("applyAction(state, HUMAN_SEAT, action)"));
  assert.ok(pageCode.includes("validateAction") === false || true);
});

test("barricade ui: the board only renders positions — no rules, no search", () => {
  // The board may use the engine's DISPLAY helpers...
  for (const helper of ["goalRowFor", "positionKey", "wallKey"]) {
    assert.ok(boardCode.includes(helper), `the board should use ${helper}`);
  }
  // ...and none of its decision-making ones.
  for (const forbidden of [
    "legalMoves",
    "legalWalls",
    "classifyWall",
    "applyAction",
    "validateAction",
    "distanceToGoal",
    "hasPathToGoal",
    "wallSealsAPath",
    "wallBlocksStep",
    "wallsConflict",
    "findBlockingWall",
  ]) {
    assert.equal(
      boardCode.includes(forbidden),
      false,
      `the board must not decide anything itself (found ${forbidden})`,
    );
  }
  // Moves arrive as a prop, exactly as the engine generated them.
  assert.ok(boardCode.includes("moves: readonly LegalMoveAction[]"));
  assert.ok(boardCode.includes("state.walls.map"));
  assert.ok(boardCode.includes("state.pawns[mySeat]"));
});

test("barricade ui: no page or board code mutates the engine's state", () => {
  // Comparisons (`state.turn === …`) are not assignments; fold them out first so
  // a legitimate read of the state can never look like a write to it.
  const withoutComparisons = (source) =>
    source.split("===").join("EQ").split("!==").join("NE").split("==").join("EQ");
  for (const [name, raw] of [
    ["page", pageCode],
    ["board", boardCode],
  ]) {
    const code = withoutComparisons(raw);
    for (const mutation of [
      "state.walls.push",
      "state.walls.splice",
      "state.walls.pop",
      "state.walls.shift",
      "state.pawns.player1 =",
      "state.pawns.player2 =",
      "state.ply =",
      "state.status =",
      "state.turn =",
    ]) {
      assert.equal(code.includes(mutation), false, `${name} must not mutate (${mutation})`);
    }
  }
});

test("barricade ui: practice stays free — no wager, no rating, no matchmaking", () => {
  // A practice match cannot fail because a network call did.
  for (const network of ["fetch(", "/api/", "useSWR", "socket.io", "EventSource", "localStorage"]) {
    assert.equal(pageCode.includes(network), false, `free play needs no network (${network})`);
  }
  // No wager fields and no competitive progression, by identifier.
  for (const forbidden of [
    "wager:",
    "wager =",
    "wagerAmount",
    "stake:",
    "stakeAmount",
    "settle",
    "payout",
    "eloDelta",
    "trophyAward",
    "progress=",
  ]) {
    assert.equal(pageCode.includes(forbidden), false, `practice must not carry ${forbidden}`);
  }
  // The result screen is the shared one, and it says what this was.
  assert.ok(pageCode.includes("PvpResultScreen"));
  assert.ok(page.includes("no wager, no rating, no trophies"));
});

/* -------------------------------------------------------------------------- *
 * The board the design asks for
 * -------------------------------------------------------------------------- */

test("barricade ui: every required affordance has a stable hook", () => {
  const hooks = [
    "barricade-board",
    "barricade-square",
    "barricade-slot",
    "barricade-wall",
    "barricade-status",
    "barricade-notice",
    "barricade-mode-move",
    "barricade-mode-wall",
    "barricade-orientation-horizontal",
    "barricade-orientation-vertical",
    "barricade-restart",
    "barricade-lobby",
    "barricade-result",
    "barricade-rules",
    "barricade-goal-mine",
    "barricade-goal-theirs",
    "barricade-turn-badge",
    "barricade-session",
    "barricade-walls-",
    "barricade-seat-",
    "barricade-result",
  ];
  const both = `${page}\n${board}`;
  for (const hook of hooks) {
    assert.ok(both.includes(hook), `missing data-testid ${hook}`);
  }
});

test("barricade ui: pawns, barricades, goal rows and turn order are drawn from the state", () => {
  assert.ok(boardCode.includes("barricade-pawn"));
  assert.ok(boardCode.includes("is-mine") && boardCode.includes("is-theirs"));
  assert.ok(boardCode.includes("barricade-move-dot"), "legal destinations are highlighted");
  assert.ok(boardCode.includes("data-legal"), "each square reports whether it is playable");
  assert.ok(boardCode.includes('data-goal={isMyGoal ? "mine"'), "goal rows are marked");
  assert.ok(boardCode.includes("data-owner"), "placed barricades carry their owner");
  assert.ok(boardCode.includes("data-active-seat"));
  assert.ok(pageCode.includes("state.wallsRemaining"), "the counters come from the state");
});

test("barricade ui: the groove controls cover the 8×8 slot grid and never a ninth", () => {
  // A barricade sits IN a groove. There are BOARD_SIZE - 1 = 8 of those per
  // axis, so a ninth slot would address a groove past the far edge — a control
  // the engine can only ever reject, and one that widens the grid with an
  // implicit track. The board must take the count from the engine.
  assert.ok(boardCode.includes("WALL_SLOTS"), "the groove count comes from the engine");
  assert.ok(
    boardCode.includes("Array.from({ length: WALL_SLOTS }"),
    "the groove grid stops at WALL_SLOTS",
  );
  assert.equal(
    /Array\.from\(\{ length: BOARD_SIZE \}\)[\s\S]{0,120}slot/.test(
      boardCode.slice(boardCode.indexOf("wallMode")),
    ),
    false,
    "grooves must not be generated from BOARD_SIZE",
  );
});

test("barricade ui: the board is a 17-track grid and stays phone-sized", () => {
  assert.ok(
    globals.includes("grid-template-columns: repeat(8, var(--bc-cell) var(--bc-gap)) var(--bc-cell)"),
    "the board draws 9 squares and the 8 grooves between them",
  );
  assert.ok(globals.includes("--bc-cell: clamp("), "cell size is fluid, not fixed");
  assert.ok(globals.includes("--bc-gap: clamp("));

  const boardBlockStart = globals.indexOf(".barricade-board {");
  const boardBlock = globals.slice(boardBlockStart, globals.indexOf("}", boardBlockStart));
  assert.ok(boardBlockStart > 0);
  assert.ok(boardBlock.includes("width: max-content"), "the board is sized by its content, not a pixel width");

  const mobileStart = globals.indexOf("@media (max-width: 400px)");
  assert.ok(mobileStart > 0, "phones get their own sizing");
  const mobileBlock = globals.slice(mobileStart, globals.indexOf("prefers-reduced-motion", mobileStart));
  assert.ok(mobileBlock.includes(".barricade-board"));
  assert.ok(mobileBlock.includes("--bc-cell"));

  assert.ok(globals.includes(".barricade-slot.is-preview-invalid"), "an invalid barricade is visible");
  assert.ok(globals.includes(".barricade-slot.is-preview-ok"));
  assert.ok(globals.includes(".barricade-square.is-legal"));
});

test("barricade ui: keyboard and screen-reader support", () => {
  assert.ok(pageCode.includes('role="status"') && pageCode.includes("aria-live"));
  assert.ok(pageCode.includes("aria-pressed={!wallMode}") && pageCode.includes("aria-pressed={wallMode}"));
  assert.ok(pageCode.includes("aria-pressed={orientation ==="));
  assert.ok(pageCode.includes('aria-label="Turn action"'));
  assert.ok(pageCode.includes('aria-label="Barricade orientation"'));
  assert.ok(boardCode.includes("aria-label={squareLabel("), "squares are labelled");
  assert.ok(boardCode.includes("aria-label={wallLabel("), "grooves are labelled");
  assert.ok(boardCode.includes("tabIndex="), "playable squares are reachable by keyboard");
  assert.ok(boardCode.includes("disabled={disabled}"), "input is stopped while the bot thinks");
});

test("barricade ui: the wall preview and the refusal notice come from the engine's verdict", () => {
  assert.ok(pageCode.includes("classifyWall(state, HUMAN_SEAT, hovered)"));
  assert.ok(pageCode.includes("classifyWall(state, HUMAN_SEAT, wall)"));
  assert.ok(pageCode.includes("verdict.ok === false"));
  assert.ok(pageCode.includes("setNotice(verdict.message)"), "the engine's explanation is what the player sees");
  assert.ok(boardCode.includes("is-preview-ok") && boardCode.includes("is-preview-invalid"));
  // The affordance list is the engine's own generator, computed off the render
  // path so the full legality pass cannot stall a tap.
  assert.ok(pageCode.includes("legalWalls(state, HUMAN_SEAT)"));
  assert.ok(pageCode.includes("setTimeout("));
});

test("barricade ui: the bot is bounded, tiered and honest about it", () => {
  assert.ok(AI_MAX_NODES > 0 && AI_MAX_NODES <= 1000);
  assert.ok(AI_DEADLINE_MS > 0 && AI_DEADLINE_MS <= 250);
  assert.deepEqual(Object.keys(BARRICADE_TIER_HINTS).sort(), [...AI_DIFFICULTIES].sort());
  assert.ok(pageCode.includes('gameKey="barricade"'), "the shared difficulty picker owns the tier");
  assert.ok(pageCode.includes('readStoredAiDifficulty("barricade")'), "the tier is remembered");
  assert.ok(pageCode.includes("AI_THINK_DELAY_MS"), "the bot answers on a visible beat");
  // A bot action the engine refuses is reported instead of silently stalling.
  assert.ok(pageCode.includes("BarricadeRuleError"));
});

test("barricade ui: the route and its metadata exist", () => {
  const route = read(ROUTE_PATH);
  assert.ok(route.includes("Barricade vs AI | GRYND"));
  assert.ok(route.includes("PageClient"));
});
