// qa/battleship-placement-mobile-harness.jsx
//
// Mounts the REAL FleetPlacement inside a copy of the arena page's width chain
// — the same `main.min-h-screen` > `.mx-auto.max-w-6xl.px-3` wrapper
// src/app/casino/battleship/PageClient.tsx renders it in — so
// qa/battleship-placement-mobile-check.mjs measures the shipped phone layout
// instead of a mock of it.
//
// The board, the shelf, the timer and the confirm button are all the real
// components; the only thing this file adds is the measurement hook.

import { createRoot } from "react-dom/client";

import FleetPlacement from "../src/components/games/battleship/FleetPlacement";

function Arena() {
  return (
    <main data-testid="arena" className="min-h-screen bg-[#030817] text-white">
      <div className="mx-auto w-full max-w-6xl px-2 py-3 sm:px-6 sm:py-4">
        <FleetPlacement onFleetConfirmed={() => {}} />
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

window.__bs = {
  mount() {
    createRoot(document.getElementById("root")).render(<Arena />);
  },

  /** Scroll the board strip to its far end, so the last column can be measured. */
  scrollBoardToEnd() {
    const scroller = document.querySelector('[data-testid="placement-board-scroll"]');
    if (scroller) scroller.scrollLeft = scroller.scrollWidth;
  },

  measure() {
    const board = document.querySelector('[data-testid="placement-board"]');
    const card = board?.parentElement ?? null;
    const scroller = document.querySelector('[data-testid="placement-board-scroll"]');
    const aside = document.querySelector('[data-testid="fleet-placement"] aside');
    const cells = [...document.querySelectorAll('[data-testid^="placement-board-cell-"]')];
    const shelf = [...document.querySelectorAll('[data-testid^="placement-ship-"]')];
    const wrapper = document.querySelector('[data-testid="arena"] > div');

    const cellBoxes = cells.map(box);
    const widths = cellBoxes.map((cell) => cell.width);
    const heights = cellBoxes.map((cell) => cell.height);

    return {
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      documentScrollWidth: document.documentElement.scrollWidth,
      documentClientWidth: document.documentElement.clientWidth,
      documentScrollHeight: document.documentElement.scrollHeight,
      gutter: wrapper ? parseFloat(getComputedStyle(wrapper).paddingLeft) : null,
      board: box(board),
      card: box(card),
      scroller: scroller
        ? {
            ...box(scroller),
            scrollWidth: scroller.scrollWidth,
            clientWidth: scroller.clientWidth,
            overflowX: getComputedStyle(scroller).overflowX,
          }
        : null,
      lastCell: box(document.querySelector('[data-testid="placement-board-cell-N1"]')),
      aside: box(aside),
      cells: cells.length,
      cellWidth: Math.min(...widths),
      cellMaxWidth: Math.max(...widths),
      cellHeight: Math.min(...heights),
      labels: cells.length,
      labelFontSize: cells.length
        ? parseFloat(getComputedStyle(cells[0]).fontSize)
        : null,
      // Every shelf row and its controls, so a clipped ship button is visible.
      shelf: shelf.map((button) => ({ testid: button.getAttribute("data-testid"), ...box(button) })),
      shelfOverflow: shelf.filter((button) => {
        const rect = button.getBoundingClientRect();
        return rect.right > window.innerWidth + 1 || rect.left < -1;
      }).length,
      timer: box(document.querySelector('[data-testid="placement-timer"]')),
      rotate: box(document.querySelector('[data-testid="placement-rotate"]')),
      confirm: box(document.querySelector('[data-testid="placement-confirm"]')),
      auto: box(document.querySelector('[data-testid="placement-auto"]')),
    };
  },
};
