// qa/tic-tac-toe-mega-mobile-harness.jsx
//
// Mounts the REAL MegaBoard inside a faithful copy of the match page's
// width-affecting chrome, so qa/tic-tac-toe-mega-mobile-check.mjs can measure
// the one thing the change is about: on a phone, does the whole 1 / 4 / 9-board
// lattice fit the content width with no sideways scroll and no clipped board?
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
//   * `mount(stage)` — render one round (1 | 2 | 3)
//   * `stage`        — the round currently mounted
//   * `plays`        — the (boardIndex, cellIndex) addresses handed to `onPlay`
//   * `measure()`    — the lattice, its scroll container and every board

import React from "react";
import { createRoot } from "react-dom/client";

import MegaBoard from "../src/components/tic-tac-toe/MegaBoard";
import { stageSlots } from "../src/lib/tic-tac-toe/ui";

// A live board: nine empty cells, open to the viewer (the server's snapshot).
const openBoard = () => ({ cells: Array(9).fill(null), control: "active", winningLine: null });
const BOARDS = Array.from({ length: 9 }, openBoard);

let root = null;

function App({ stage }) {
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
                boards={BOARDS}
                stage={stage}
                slots={stageSlots(stage)}
                winningBoards={null}
                lastMove={null}
                suddenDeath={null}
                viewerSeat="player1"
                viewerCanMove
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
  stage: 1,
  plays: [],

  mount(stage) {
    window.__ttt.stage = stage;
    window.__ttt.plays = [];
    if (!root) root = createRoot(document.getElementById("root"));
    root.render(<App stage={stage} />);
  },

  measure() {
    const lattice = document.querySelector(".mega-lattice");
    const scroller = lattice?.parentElement ?? null;
    const page = document.querySelector('[data-testid="ttt-harness-page"]');
    const cards = [...document.querySelectorAll('[data-testid^="tic-tac-toe-lattice-board-"]')];
    const pageStyle = page ? getComputedStyle(page) : null;

    return {
      stage: window.__ttt.stage,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      documentScrollWidth: document.documentElement.scrollWidth,
      documentClientWidth: document.documentElement.clientWidth,
      bodyScrollWidth: document.body.scrollWidth,
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

window.__ttt.mount(1);

// The audit waits for this once the entrance motion has settled.
requestAnimationFrame(() =>
  requestAnimationFrame(() => {
    setTimeout(() => {
      window.__tttReady = true;
    }, 400);
  }),
);
