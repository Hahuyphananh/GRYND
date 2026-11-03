/**
 * battleship-ui-contract.test.mjs
 *
 * The contracts the Phase 2 Battleship screen has to keep.
 *
 * Text-level where a browser test would be expensive, plus a real render of
 * `ShipVisual` through React's server renderer so a broken component fails here
 * instead of in the arena. What is pinned:
 *
 *   1. VISUALS — the exact palette, block rendering, and the fact that NO image
 *      is ever emitted while the artwork registry is empty (no failed request,
 *      no broken-image icon).
 *   2. HIDDEN INFORMATION — only the player's own fleet is ever passed to a
 *      board; the enemy board is rendered without a ships prop at all.
 *   3. PLACEMENT — 60-second clock, rotate, auto place, reset, confirm, drag and
 *      tap paths, and that all five ships are listed with their cell counts.
 *   4. COMBAT — opponent identity, round, countdown, lock, waiting state, fleet
 *      status and attack history, with no hidden selection revealed.
 *   5. MOBILE / WEBVIEW — fluid board sizing, square touch cells, coordinate
 *      labels and no fixed pixel board width.
 *   6. NO NETWORK — Phase 2 talks to no server at all.
 *
 * Run:  node --import tsx --test tests/battleship-ui-contract.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import * as shipVisualModule from "../src/components/games/battleship/ShipVisual.tsx";
import * as boardModule from "../src/components/games/battleship/BoardGrid.tsx";
import * as placementModule from "../src/components/games/battleship/FleetPlacement.tsx";
import * as battleModule from "../src/components/games/battleship/BattlePreview.tsx";
import {
  SHIP_ARTWORK,
  SHIP_ARTWORK_DIRECTORY,
  SHIP_ARTWORK_FILE_NAMES,
  shipArtworkFor,
} from "../src/components/games/battleship/shipArtwork.ts";

const pick = (mod) => mod?.default?.default ?? mod?.default;
const ShipVisual = pick(shipVisualModule);
const BoardGrid = pick(boardModule);
const FleetPlacement = pick(placementModule);
const BattlePreview = pick(battleModule);

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

/** Source with comments removed, so prose about "no API" cannot fail a check. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const COMPONENTS = "src/components/games/battleship";
const PLACEMENT = read(`${COMPONENTS}/FleetPlacement.tsx`);
const BATTLE = read(`${COMPONENTS}/BattlePreview.tsx`);
const BOARD = read(`${COMPONENTS}/BoardGrid.tsx`);
const VISUAL = read(`${COMPONENTS}/ShipVisual.tsx`);
const FLEET_STATUS = read(`${COMPONENTS}/FleetStatus.tsx`);
const PAGE_CLIENT = read("src/app/casino/battleship/PageClient.tsx");
const PAGE = read("src/app/casino/battleship/page.tsx");
const ALL_UI = [PLACEMENT, BATTLE, BOARD, VISUAL, FLEET_STATUS, PAGE_CLIENT].join("\n");

// ── 1. Visuals and block rendering ────────────────────────────────────────

test("ShipVisual renders one block per cell, in the ship's orientation", () => {
  const carrier = renderToStaticMarkup(React.createElement(ShipVisual, { ship: "carrier" }));
  assert.match(carrier, /data-variant="blocks"/);
  assert.equal((carrier.match(/data-cell=/g) ?? []).length, 5);
  assert.equal((carrier.match(/<img/g) ?? []).length, 0, "no image while the artwork registry is empty");

  const destroyer = renderToStaticMarkup(React.createElement(ShipVisual, { ship: "destroyer" }));
  assert.equal((destroyer.match(/data-cell=/g) ?? []).length, 2);

  const vertical = renderToStaticMarkup(
    React.createElement(ShipVisual, { ship: "cruiser", orientation: "vertical" }),
  );
  assert.match(vertical, /data-orientation="vertical"/);
  assert.match(vertical, /flex-col/);
});

test("damaged ship cells render red, undamaged cells blue", () => {
  const html = renderToStaticMarkup(
    React.createElement(ShipVisual, { ship: "destroyer", damaged: [true, false] }),
  );
  assert.equal((html.match(/data-damaged="true"/g) ?? []).length, 1);
  assert.equal((html.match(/data-damaged="false"/g) ?? []).length, 1);
  assert.match(html, /bg-\[#ef4444\]/, "damage is red");
  assert.match(html, /bg-\[#2f6bff\]/, "an intact hull is blue");
});

test("the artwork registry is empty and asks for no files", () => {
  assert.deepEqual(Object.keys(SHIP_ARTWORK), []);
  for (const ship of Object.keys(SHIP_ARTWORK_FILE_NAMES)) {
    assert.equal(shipArtworkFor(ship), null, `${ship} must fall back to blocks`);
  }
  assert.equal(SHIP_ARTWORK_DIRECTORY, "public/images/battleship/ships");
  assert.deepEqual(SHIP_ARTWORK_FILE_NAMES, {
    carrier: "carrier.png",
    battleship: "battleship.png",
    cruiser: "cruiser.png",
    submarine: "submarine.png",
    destroyer: "destroyer.png",
  });

  // The directory documents the assets but ships no image yet.
  const files = readdirSync(new URL("../public/images/battleship/ships/", import.meta.url));
  assert.deepEqual(files.filter((file) => /\.(png|jpe?g|webp|svg|gif)$/i.test(file)), []);
});

test("ShipVisual only emits an <img> behind the artwork guard", () => {
  assert.match(VISUAL, /const artwork = shipArtworkFor\(ship\);/);
  // Comments are stripped first: the header legitimately mentions <img> in prose.
  const code = stripComments(VISUAL);
  const guard = code.indexOf("if (artwork)");
  const image = code.indexOf("<img");
  assert.ok(guard > -1 && image > guard, "the <img> must live inside the artwork branch");
});

test("the palette is the approved one", () => {
  assert.match(ALL_UI, /bg-\[#030817\]/, "page background");
  assert.match(ALL_UI, /#ffec08/, "GRYND accent");
  assert.match(ALL_UI, /bg-\[#2f6bff\]/, "ship blue");
  assert.match(ALL_UI, /bg-\[#ef4444\]/, "hit red");
  assert.match(BOARD, /miss: "bg-white border-white"/, "miss white");
  assert.match(BOARD, /bg-\[#0a1a3d\]/, "ocean navy");
  assert.match(ALL_UI, /border-\[#ffec08\]|ring-\[#ffec08\]|bg-\[#ffec08\]/, "selection uses GRYND yellow");
});

// ── 2. Hidden information ─────────────────────────────────────────────────

test("only the player's own fleet is ever drawn on a board", () => {
  // FleetPlacement passes its own placements…
  assert.match(PLACEMENT, /ships=\{placement\.ships\.map/);
  // …and the enemy board in the battle view is rendered with NO ships prop.
  const enemyBoard = BATTLE.slice(BATTLE.indexOf('title="Enemy Waters"') - 200, BATTLE.indexOf('testId="enemy-waters"'));
  assert.ok(enemyBoard.length > 0);
  assert.equal(/ships=/.test(enemyBoard), false, "the enemy board must never receive ships");
  assert.match(BATTLE, /title="My Fleet"[\s\S]*?ships=\{ownShips\}/);

  // The enemy fleet panel is concealed to counts, never positions.
  assert.match(BATTLE, /conceal/);
  assert.match(FLEET_STATUS, /conceal \? \(/);
});

test("nothing in the layout reveals an opponent selection before lock", () => {
  assert.match(BATTLE, /onCellClick=\{\(coordinate\) => \{/);
  assert.match(BATTLE, /if \(locked \|\| result\) return;/);
  assert.match(BATTLE, /data-testid="waiting-opponent"/);
  assert.match(BATTLE, /isCellDisabled=\{\(\) => locked \|\| Boolean\(result\) \|\| busy\}/);
});

// ── 3. Placement interface ────────────────────────────────────────────────

test("placement offers every required affordance", () => {
  assert.match(PLACEMENT, /PLACEMENT_SECONDS/);
  assert.match(PLACEMENT, /data-testid="placement-timer"/);
  assert.match(PLACEMENT, /data-testid="placement-rotate"/);
  assert.match(PLACEMENT, /data-testid="placement-auto"/);
  assert.match(PLACEMENT, /data-testid="placement-reset"/);
  assert.match(PLACEMENT, /data-testid="placement-confirm"/);
  assert.match(PLACEMENT, /disabled=\{!complete\}/);
  assert.match(PLACEMENT, /draggable/);
  assert.match(PLACEMENT, /onDragStart=/);
  assert.match(BOARD, /onDrop=/);
  assert.match(BOARD, /onDragOver=/);
  assert.match(PLACEMENT, /onCellClick=/);
  assert.match(PLACEMENT, /window\.addEventListener\("keydown"/, "R rotates");
});

test("all five ships are listed with their required cell counts", () => {
  assert.match(PLACEMENT, /FLEET_SPEC\.map/);
  assert.match(PLACEMENT, /ship\.length\} cells/);
  assert.match(PLACEMENT, /<ShipVisual ship=\{ship\.key\}/);
});

test("placement rejects overlap and out-of-board placements through the model", () => {
  assert.match(PLACEMENT, /placeShip\(placementRef\.current/);
  assert.match(PLACEMENT, /if \(result\.ok === false\) \{/);
  assert.match(PLACEMENT, /setError\(result\.message\)/);
});

test("the clock locks the fleet in when it expires", () => {
  assert.match(PLACEMENT, /if \(secondsLeft > 0 \|\| confirmedRef\.current\) return;/);
  assert.match(PLACEMENT, /autoPlace\(placementRef\.current\)/);
  assert.match(PLACEMENT, /onFleetConfirmed\(fleet\)/);
});

// ── 4. Combat layout ──────────────────────────────────────────────────────

test("the combat screen shows identity, round, clock, boards and history", () => {
  assert.match(BATTLE, /data-testid="opponent-name"/);
  assert.match(BATTLE, /data-testid="opponent-rank"/);
  assert.match(BATTLE, /data-testid="round-number"/);
  assert.match(BATTLE, /data-testid="round-countdown"/);
  assert.match(BATTLE, /title="My Fleet"/);
  assert.match(BATTLE, /title="Enemy Waters"/);
  assert.match(BATTLE, /<FleetStatus/);
  assert.match(BATTLE, /Attack history/);
  assert.match(BATTLE, /data-testid="history-empty"/);
  assert.match(BATTLE, /data-testid="lock-attack"/);
});

test("locking submits the shot and waits instead of resolving locally", () => {
  assert.match(BATTLE, /onAttack\(selected\)/);
  assert.match(BATTLE, /data-testid="attack-locked"/);
  assert.match(BATTLE, /Waiting for opponent/);
  assert.equal(/resolveRound|resolveAttack|applyAttack/.test(BATTLE), false);
  assert.equal(/setLocked/.test(BATTLE), false, "the lock is the server's, not local state");
});

test("the combat screen renders the server's projection and owns its transport", () => {
  assert.match(BATTLE, /view: MatchView/);
  assert.match(BATTLE, /view\.you\.board/);
  assert.match(BATTLE, /view\.opponent\.board/);
  assert.match(PAGE_CLIENT, /\/api\/battleship\/match\//);
  assert.match(PAGE_CLIENT, /\/attack/);
});

// ── 5. Mobile / WebView ───────────────────────────────────────────────────

test("boards are fluid, square and touch-friendly", () => {
  assert.match(BOARD, /aspect-square/);
  assert.match(BOARD, /min-h-7/);
  assert.match(BOARD, /touch-manipulation/);
  assert.match(BOARD, /gridTemplateColumns: "1\.1rem repeat\(10, minmax\(0, 1fr\)\)"/);
  assert.match(BOARD, /COLUMNS\.map/);
  assert.match(BOARD, /ROWS\.map/);
  assert.match(BOARD, /sm:text-\[10px\]/, "labels scale up on wider screens");
  assert.equal(/w-\[\d{3,}px\]/.test(BOARD), false, "no fixed pixel board width");
  assert.match(PAGE_CLIENT, /min-h-screen/);
  assert.match(PAGE_CLIENT, /max-w-5xl/);
  assert.match(PLACEMENT, /lg:grid-cols-\[/, "desktop widens, mobile stacks");
  assert.match(BATTLE, /lg:grid-cols-\[/, "boards stack on mobile");
});

test("every cell is a real button with an accessible coordinate", () => {
  assert.match(BOARD, /<button/);
  assert.match(BOARD, /aria-label=\{mark === BOARD_CELL\.UNKNOWN \? label : `\$\{label\} \$\{mark\}`\}/);
  assert.match(BOARD, /aria-pressed=\{isSelected\}/);
});

// ── 6. No network, and the route exists ───────────────────────────────────

test("only the page owns transport", () => {
  const components = stripComments([PLACEMENT, BATTLE, BOARD, VISUAL, FLEET_STATUS].join("\n"));
  for (const forbidden of [/fetch\(/, /XMLHttpRequest/, /\/api\//, /EventSource/]) {
    assert.equal(forbidden.test(components), false, `a presentation component must not use ${forbidden}`);
  }
  assert.match(stripComments(PAGE_CLIENT), /fetch\(/);
  assert.match(stripComments(PAGE_CLIENT), /battleshipMatchRoom/);
});

test("the game route exists and is not indexable", () => {
  // Phase 7 aligned the lobby with every other game page: noindex (the public
  // page is /games/battleship), follow, and canonical to its own play URL.
  assert.match(PAGE, /robots: \{ index: false, follow: true \}/);
  assert.match(PAGE, /canonical: "\/games\/battleship\/play"/);
  assert.match(PAGE, /<PageClient \/>/);
  assert.match(PAGE_CLIENT, /FleetPlacement/);
  assert.match(PAGE_CLIENT, /BattlePreview/);
});

test("the temporary geometric card illustration is wired into the shared registry", () => {
  const card = read("src/images/battleship-card.svg");
  assert.match(card, /<svg/);
  assert.match(card, /#030817/);
  // Phase 7 registered the game, so the placeholder art is now the card the
  // lobby and the public directory both draw — still geometric, still no ship
  // photography and no external asset.
  const registry = read("src/components/games/gameCardArt.js");
  assert.match(registry, /import battleshipArt from "\.\.\/\.\.\/images\/battleship-card\.svg"/);
  assert.match(registry, /battleship: battleshipArt,/);
});

// ── 7. Real renders ───────────────────────────────────────────────────────

const DEMO_FLEET = {
  ships: [
    { ship: "carrier", orientation: "horizontal", x: 0, y: 0 },
    { ship: "battleship", orientation: "horizontal", x: 0, y: 2 },
    { ship: "cruiser", orientation: "horizontal", x: 0, y: 4 },
    { ship: "submarine", orientation: "horizontal", x: 0, y: 6 },
    { ship: "destroyer", orientation: "horizontal", x: 0, y: 8 },
  ],
};
const EMPTY_GRID = Array.from({ length: 10 }, () => Array.from({ length: 10 }, () => "unknown"));

test("BoardGrid renders 100 labelled square cells and no ship unless given one", () => {
  const bare = renderToStaticMarkup(
    React.createElement(BoardGrid, { title: "Enemy Waters", cells: EMPTY_GRID }),
  );
  assert.equal((bare.match(/<button/g) ?? []).length, 100);
  assert.match(bare, />A</);
  assert.match(bare, />J</);
  assert.match(bare, />10</);
  assert.equal(/board-ship-/.test(bare), false, "an unpassed fleet draws nothing");

  const withShip = renderToStaticMarkup(
    React.createElement(BoardGrid, {
      title: "My Fleet",
      cells: EMPTY_GRID,
      ships: [{ placement: DEMO_FLEET.ships[0] }],
    }),
  );
  assert.match(withShip, /data-testid="board-ship-carrier"/);
  assert.match(withShip, /data-variant="blocks"/);
});

test("the placement screen renders its board, shelf, timer and controls", () => {
  const html = renderToStaticMarkup(
    React.createElement(FleetPlacement, { onFleetConfirmed: () => {} }),
  );
  assert.equal((html.match(/data-testid="placement-board-cell-/g) ?? []).length, 100);
  assert.match(html, /data-testid="placement-timer"/);
  assert.match(html, /data-testid="placement-rotate"/);
  assert.match(html, /data-testid="placement-auto"/);
  assert.match(html, /data-testid="placement-reset"/);
  assert.match(html, /data-testid="placement-confirm"/);
  for (const ship of ["carrier", "battleship", "cruiser", "submarine", "destroyer"]) {
    assert.match(html, new RegExp(`data-testid="placement-ship-${ship}"`));
  }
  assert.equal((html.match(/ship-visual-/g) ?? []).length, 5, "one block strip per ship in the shelf");
});

test("the battle layout renders both live boards, with ships on the player's board only", () => {
  const view = {
    status: "playing",
    round: 1,
    outcome: null,
    winner: null,
    you: {
      seat: "player1",
      fleet: DEMO_FLEET,
      board: EMPTY_GRID,
      attacks: [],
      sunkShips: [],
      enemyShipsRemaining: 5,
    },
    opponent: {
      seat: "player2",
      board: EMPTY_GRID,
      attacks: [],
      sunkShips: [],
      enemyShipsRemaining: 5,
    },
  };
  const html = renderToStaticMarkup(
    React.createElement(BattlePreview, {
      view,
      round: 1,
      roundDeadline: null,
      locked: false,
      lockedCoordinate: null,
      opponentLocked: false,
      busy: false,
      error: null,
      opponentName: "Rival Captain",
      result: null,
      seat: "player1",
      reveal: null,
      onAttack: () => {},
      onLeave: () => {},
    }),
  );
  assert.equal((html.match(/data-testid="my-fleet-cell-/g) ?? []).length, 100);
  assert.equal((html.match(/data-testid="enemy-waters-cell-/g) ?? []).length, 100);
  assert.equal((html.match(/board-ship-/g) ?? []).length, 5, "only the player's five ships are drawn");
  assert.match(html, /data-testid="lock-attack"/);
  assert.match(html, /data-testid="history-empty"/);
  assert.equal(/waiting-opponent/.test(html), false, "nothing waits before an attack is locked");
  assert.match(html, /data-testid="status-enemy"/);
});
