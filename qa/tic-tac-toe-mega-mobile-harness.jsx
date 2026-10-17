// qa/tic-tac-toe-mega-mobile-harness.jsx
//
// Mounts the REAL MegaBoard inside a faithful copy of the match page's
// width-affecting chrome, so qa/tic-tac-toe-mega-mobile-check.mjs can measure
// the one thing the change is about: on a phone, does the whole NINE-board
// lattice fit the content width with no sideways scroll and no clipped board?
//
// Ultimate Tic-Tac-Toe is a FIXED 3x3 lattice — there are no rounds and no
// expansion to mount — so the harness renders exactly the one state the app
// can ever show: nine empty boards, free choice, the viewer to move.
//
// The chain reproduced here is the SHIPPED one
// (src/app/casino/tic-tac-toe/[matchId]/PageClient.tsx), gutters and all:
//
//   min-h-screen overflow-x-clip … px-3 sm:px-6     ← the page gutter
//     mx-auto max-w-6xl
//       grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]  ← the board column
//         rounded-2xl border … p-3 sm:p-4              ← the board card
//           relative
//             <MegaBoard />                              ← the lattice
//
// `overflow-x-clip` on the page root is the reason the checks measure each
// board's painted box and not just the document: it HIDES horizontal overflow
// instead of scrolling it, so a lattice that outgrew the viewport would be
// silently cut off rather than visibly scrollable.
//
// Fully offline and self-contained: MegaBoard only imports React,
// framer-motion, the board component and the pure `lib/tic-tac-toe` helpers, so
// there is nothing to stub and no network to reach. The document loads from
// file://.
//
// Everything the check needs lives on `window.__ttt`:
//   * `mount()`      — render the lattice
//   * `plays`        — the (boardIndex, cellIndex) addresses handed to `onPlay`
//   * `measure()`    — the lattice, its scroll container and every board

import React from "react";
import { createRoot } from "react-dom/client";

import MegaBoard from "../src/components/tic-tac-toe/MegaBoard";

// A live board: nine empty cells, open to the viewer (the server's snapshot).
const openBoard = () => ({ cells: Array(9).fill(null), control: "active", winningLine: null });
const BOARDS = Array.from({ length: 9 }, openBoard);
// The opening position: no required destination, every board playable.
const ALL_SLOTS = [0, 1, 2, 3, 4, 5, 6, 7, 8];

/** A board claimed by `mark` on its top row, with the server's winning line. */
const wonBoard = (mark) => ({
  cells: [mark, mark, mark, null, null, null, null, null, null],
  control: mark,
  winningLine: [0, 1, 2],
});
/** A full mini-board with no line: the server's "draw" control. */
const drawnBoard = () => ({
  cells: ["X", "O", "X", "X", "O", "O", "O", "X", "X"],
  control: "draw",
  winningLine: null,
});
const withBoards = (patch) => BOARDS.map((board, slot) => patch[slot] ?? board);

/**
 * The states the shipped page can actually show, as prop sets for the real
 * MegaBoard. Each one is a snapshot the server produces, never a client guess.
 */
const SCENARIOS = {
  // Free choice at the opening position.
  opening: {
    boards: BOARDS,
    winningBoards: null,
    lastMove: null,
    nextBoard: null,
    playableBoards: ALL_SLOTS,
    status: "playing",
    viewerCanMove: true,
  },
  // The forced-destination rule: one board, and only that board, is playable.
  required: {
    boards: BOARDS,
    winningBoards: null,
    lastMove: { boardIndex: 0, cellIndex: 4, mark: "X", ply: 1 },
    nextBoard: 4,
    playableBoards: [4],
    status: "playing",
    viewerCanMove: true,
  },
  // The same rule, a different slot: the destination copy must follow the
  // server's slot, never a hardcoded "centre".
  requiredTopLeft: {
    boards: BOARDS,
    winningBoards: null,
    lastMove: { boardIndex: 4, cellIndex: 0, mark: "O", ply: 2 },
    nextBoard: 0,
    playableBoards: [0],
    status: "playing",
    viewerCanMove: true,
  },
  // A resolved destination: the opponent may choose any open board.
  resolved: {
    boards: withBoards({ 4: drawnBoard() }),
    winningBoards: null,
    lastMove: { boardIndex: 3, cellIndex: 4, mark: "X", ply: 12 },
    nextBoard: null,
    playableBoards: [0, 1, 2, 3, 5, 6, 7, 8],
    status: "playing",
    viewerCanMove: true,
  },
  // Ownership: one board each way plus a draw, every mark still drawn.
  claimed: {
    boards: withBoards({ 0: wonBoard("X"), 2: wonBoard("O"), 1: drawnBoard() }),
    winningBoards: null,
    lastMove: { boardIndex: 2, cellIndex: 2, mark: "O", ply: 20 },
    nextBoard: 2,
    playableBoards: [2],
    status: "playing",
    viewerCanMove: false,
  },
  // The terminal result: X claims the diagonal, the match is over.
  finished: {
    boards: withBoards({ 0: wonBoard("X"), 4: wonBoard("X"), 8: wonBoard("X") }),
    winningBoards: [0, 4, 8],
    lastMove: { boardIndex: 8, cellIndex: 2, mark: "X", ply: 33 },
    nextBoard: null,
    playableBoards: [],
    status: "finished",
    viewerCanMove: false,
  },
};

let root = null;

function App({ scenario }) {
  const props = SCENARIOS[scenario] ?? SCENARIOS.opening;
  return (
    <div
      data-testid="ttt-harness-page"
      className="min-h-screen overflow-x-clip bg-gradient-to-b from-[#0d1226] via-[#080d1c] to-[#04060f] px-3 pb-24 pt-20 text-white sm:px-6 md:pb-8"
    >
      <div className="mx-auto max-w-6xl">
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="rounded-2xl border border-amber-500/20 bg-black/40 p-3 shadow-[0_0_30px_rgba(251,191,36,0.10)] sm:p-4">
            <div className="relative">
              <MegaBoard
                boards={props.boards}
                winningBoards={props.winningBoards}
                lastMove={props.lastMove}
                nextBoard={props.nextBoard}
                playableBoards={props.playableBoards}
                status={props.status}
                viewerSeat="player1"
                viewerCanMove={props.viewerCanMove}
                busy={false}
                pending={null}
                focusedBoard={null}
                highlightSlot={null}
                onPlay={(boardIndex, cellIndex) => {
                  window.__ttt.plays.push([boardIndex, cellIndex]);
                }}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The element's LAYOUT box, walked up the `offsetParent` chain.
 *
 * Deliberately not `getBoundingClientRect`: the lattice mounts through
 * framer-motion's `scale` spring, and a mid-flight transform would report a
 * shrunken box that hides a real overflow. Every box below is therefore in the
 * same untransformed page coordinate space and directly comparable.
 */
const layoutBox = (el) => {
  let x = 0;
  let y = 0;
  let node = el;
  while (node instanceof HTMLElement) {
    x += node.offsetLeft;
    y += node.offsetTop;
    node = node.offsetParent;
  }
  return {
    left: x,
    top: y,
    width: el.offsetWidth,
    height: el.offsetHeight,
    right: x + el.offsetWidth,
    bottom: y + el.offsetHeight,
  };
};

const box = (el) => (el ? layoutBox(el) : null);

window.__ttt = {
  plays: [],

  scenario: "opening",

  mount(scenario = "opening") {
    window.__ttt.plays = [];
    window.__ttt.scenario = scenario;
    if (!root) root = createRoot(document.getElementById("root"));
    root.render(<App scenario={scenario} />);
  },

  measure() {
    const lattice = document.querySelector(".mega-lattice");
    const scroller = lattice?.parentElement ?? null;
    const page = document.querySelector('[data-testid="ttt-harness-page"]');
    const cards = [...document.querySelectorAll('[data-testid^="tic-tac-toe-lattice-board-"]')];
    const pageStyle = page ? getComputedStyle(page) : null;
    const destination = document.querySelector('[data-testid="lattice-destination"]');

    return {
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      documentScrollWidth: document.documentElement.scrollWidth,
      documentClientWidth: document.documentElement.clientWidth,
      bodyScrollWidth: document.body.scrollWidth,
      destination: destination
        ? {
            text: destination.textContent?.trim() ?? "",
            required: destination.getAttribute("data-required"),
            freeChoice: destination.getAttribute("data-free-choice"),
          }
        : null,
      page: page
        ? {
            ...layoutBox(page),
            scrollWidth: page.scrollWidth,
            clientWidth: page.clientWidth,
            paddingLeft: pageStyle.paddingLeft,
            paddingRight: pageStyle.paddingRight,
            overflowX: pageStyle.overflowX,
          }
        : null,
      lattice: lattice
        ? {
            ...layoutBox(lattice),
            cols: lattice.getAttribute("data-cols"),
            minWidth: getComputedStyle(lattice).minWidth,
            scrollWidth: lattice.scrollWidth,
            clientWidth: lattice.clientWidth,
          }
        : null,
      scroller: scroller
        ? {
            ...layoutBox(scroller),
            overflowX: getComputedStyle(scroller).overflowX,
            scrollWidth: scroller.scrollWidth,
            clientWidth: scroller.clientWidth,
          }
        : null,
      boards: cards.map((card) => {
        const cell = card.querySelector('[data-testid^="tic-tac-toe-cell-"]');
        // The card's header row: "Board {n}" then the control badge — the two
        // things whose intrinsic width used to refuse to shrink.
        const headerSpans = card.firstElementChild?.querySelectorAll("span") ?? [];
        const label = headerSpans[0] ?? null;
        const badge = headerSpans[1] ?? null;
        return {
          slot: Number((card.getAttribute("data-testid") ?? "").split("-").pop()),
          ...layoutBox(card),
          cellWidth: cell ? cell.offsetWidth : 0,
          cellHeight: cell ? cell.offsetHeight : 0,
          playableCells: card.querySelectorAll('[data-playable="true"]').length,
          label: box(label),
          badge: box(badge),
        };
      }),
    };
  },
};

window.__ttt.mount();

// The audit waits for this once the entrance motion has settled.
requestAnimationFrame(() =>
  requestAnimationFrame(() => {
    setTimeout(() => {
      window.__tttReady = true;
    }, 400);
  }),
);
