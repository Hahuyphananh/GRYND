// qa/battleship-combat-visual-harness.jsx
//
// Mounts the REAL BattlePreview inside the arena page's width chain, with a
// server-shaped MatchView for a 14×10 board and the six-ship fleet. The two
// boards are the player's own fleet and the enemy waters; the enemy board is
// rendered without a `ships` prop, exactly as the live screen does it.
//
// Only the mascot and the translation hook are stubbed (they pull in providers
// this page does not mount); every layout number the check asserts comes from
// the real components and the real Tailwind stylesheet.

import { createRoot } from "react-dom/client";

import BattlePreview from "../src/components/games/battleship/BattlePreview";

const COLUMNS = 14;
const ROWS = 10;
const UNKNOWN = "unknown";

/** An all-unknown board, `board[y][x]`. */
const blankBoard = () =>
  Array.from({ length: ROWS }, () => Array.from({ length: COLUMNS }, () => UNKNOWN));

/** A board with the resolved shots painted in. */
function boardWithShots(shots) {
  const board = blankBoard();
  for (const { x, y, result } of shots) board[y][x] = result;
  return board;
}

const FLEET = {
  ships: [
    { ship: "carrier", orientation: "horizontal", x: 0, y: 0 },
    { ship: "battleship", orientation: "horizontal", x: 6, y: 1 },
    { ship: "cruiser", orientation: "vertical", x: 9, y: 3 },
    { ship: "submarine", orientation: "horizontal", x: 0, y: 4 },
    { ship: "frigate", orientation: "vertical", x: 12, y: 6 },
    { ship: "destroyer", orientation: "horizontal", x: 4, y: 7 },
  ],
};

// The opponent's shots into MY waters: two hits on the carrier, a miss, a hit on
// the battleship. `fleetDamage` turns these into the red hull cells.
const INCOMING = [
  { round: 1, coordinate: "A1", result: "hit", ship: null },
  { round: 2, coordinate: "B1", result: "hit", ship: null },
  { round: 3, coordinate: "F2", result: "miss", ship: null },
  { round: 4, coordinate: "G2", result: "hit", ship: null },
];

// MY shots into enemy waters, with one sunk two-cell destroyer at M1/N1.
const OUTGOING = [
  { round: 1, coordinate: "C3", result: "hit", ship: null },
  { round: 2, coordinate: "D3", result: "miss", ship: null },
  { round: 3, coordinate: "N1", result: "sunk", ship: "destroyer" },
  { round: 4, coordinate: "M10", result: "miss", ship: null },
];

const VIEW = {
  status: "playing",
  round: 5,
  outcome: null,
  winner: null,
  you: {
    seat: "player1",
    fleet: FLEET,
    board: boardWithShots([
      { x: 2, y: 2, result: "hit" },
      { x: 3, y: 3, result: "miss" },
      { x: 12, y: 0, result: "sunk" },
      { x: 13, y: 0, result: "sunk" },
      { x: 12, y: 9, result: "miss" },
    ]),
    attacks: OUTGOING,
    sunkShips: ["destroyer"],
    enemyShipsRemaining: 5,
  },
  opponent: {
    seat: "player2",
    board: boardWithShots([
      { x: 0, y: 0, result: "hit" },
      { x: 1, y: 0, result: "hit" },
      { x: 5, y: 1, result: "miss" },
      { x: 6, y: 1, result: "hit" },
    ]),
    attacks: INCOMING,
    sunkShips: [],
    enemyShipsRemaining: 6,
  },
};

function Arena() {
  return (
    <main data-testid="arena" className="min-h-screen bg-[#030817] text-white">
      <div className="mx-auto w-full max-w-6xl px-3 py-5 sm:px-6 sm:py-8">
        <BattlePreview
          view={VIEW}
          round={5}
          roundDeadline={null}
          locked={false}
          lockedCoordinate={null}
          opponentLocked
          busy={false}
          error={null}
          opponentName="Rival Captain"
          result={null}
          seat="player1"
          reveal={null}
          onAttack={() => {}}
          onLeave={() => {}}
        />
      </div>
    </main>
  );
}

/** A DOM rect as plain numbers (null when the element is absent). */
function box(element) {
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  return {
    left: rect.left,
    right: rect.right,
    top: rect.top,
    bottom: rect.bottom,
    width: rect.width,
    height: rect.height,
  };
}

window.__bsc = {
  mount() {
    createRoot(document.getElementById("root")).render(<Arena />);
  },

  scrollBoardToEnd(testId) {
    const scroller = document.querySelector(`[data-testid="${testId}-scroll"]`);
    if (scroller) scroller.scrollLeft = scroller.scrollWidth;
  },

  measure() {
    const strip = (testId) => {
      const scroller = document.querySelector(`[data-testid="${testId}-scroll"]`);
      if (!scroller) return null;
      return {
        ...box(scroller),
        scrollWidth: scroller.scrollWidth,
        clientWidth: scroller.clientWidth,
        overflowX: getComputedStyle(scroller).overflowX,
      };
    };
    const cells = [...document.querySelectorAll('[data-testid^="enemy-waters-cell-"]')];
    const cellBoxes = cells.map(box);
    const myFleetCard = document.querySelector('[data-testid="my-fleet"]')?.closest("div");
    const enemyCard = document.querySelector('[data-testid="enemy-waters"]')?.closest("div");
    const ships = document.querySelectorAll('[data-testid^="board-ship-"]');

    return {
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      documentScrollWidth: document.documentElement.scrollWidth,
      documentClientWidth: document.documentElement.clientWidth,
      myFleet: strip("my-fleet"),
      enemy: strip("enemy-waters"),
      cards: { myFleet: box(myFleetCard), enemy: box(enemyCard) },
      enemyCells: cells.length,
      cellWidth: Math.min(...cellBoxes.map((cell) => cell.width)),
      cellHeight: Math.min(...cellBoxes.map((cell) => cell.height)),
      ownShipSprites: ships.length,
      locked: box(document.querySelector('[data-testid="lock-attack"]')),
      history: box(document.querySelector('[data-testid="history-empty"]')),
      statusOwn: box(document.querySelector('[data-testid="status-own"]')),
      statusEnemy: box(document.querySelector('[data-testid="status-enemy"]')),
      lastCell: box(document.querySelector('[data-testid="enemy-waters-cell-N1"]')),
      rowLabel: box(document.querySelector('[data-testid="enemy-waters-row-1"]')),
    };
  },
};
