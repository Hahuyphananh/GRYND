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

// ── The VERTICAL chrome the shipped page puts above and below the lattice ───
// Reproduced here for the same reason the width chain is: the lattice's size is
// capped by "the room left under the page chrome", so a harness that omits the
// chrome cannot measure whether the bottom row is still on screen. Every class
// string below is copied from the shipped match page
// (src/app/casino/tic-tac-toe/[matchId]/PageClient.tsx):
//
//   header row (title + subtitle + status chip / Lobby)  … mb-2
//   board card's own padding                             … p-2 sm:p-3
//   board card on desktop                                … lg:grid lg:grid-cols-[300px_minmax(0,1fr)] lg:gap-2
//   seat cards (two, the active one ringed)              … mb-2 … grid grid-cols-2 gap-2 lg:mb-0
//   turn guidance (ONE instruction + progress)           … px-3 py-1.5 lg:mb-0
//   [optional] the transient "X claims the board!" banner … mb-3 … px-3 py-2
//   … the lattice …                                   (rules hidden on desktop)
//   sidebar: controls box (the server subtitle + Forfeit) … p-3
//   [optional] the load-error line                       … mt-2
//
// The two optional rows are the worst case the height reserve has to cover: a
// board that just resolved (the banner shows for BOARD_EVENT_MS) and a failed
// refresh (the error line stays). Both are mountable on their own so the check
// can measure the reserve against them rather than guessing.
// On desktop the card is a two-column grid (seats | guidance), so the seat card
// drops its second line to keep that shared row one line tall.
const SeatCard = ({ mark, name, moves, active }) => (
  <div
    className={`rounded-xl border p-1.5 transition sm:p-2 lg:p-1.5 ${
      active
        ? "border-amber-400/60 bg-amber-500/10 ring-1 ring-amber-300/40"
        : "border-white/10 bg-white/5"
    }`}
  >
    <div className="flex items-center gap-2">
      <span className="relative inline-flex h-6 w-6 shrink-0 rounded-full border border-white/15 bg-white/10" />
      <div className="min-w-0">
        <p className="truncate text-xs font-bold">{name}</p>
        <p className="text-[10px] uppercase tracking-wider text-white/45 lg:hidden">
          {mark} · {moves} moves
        </p>
      </div>
    </div>
  </div>
);

function App({ scenario, banner = false, loadError = false, destinationRow = false }) {
  const props = SCENARIOS[scenario] ?? SCENARIOS.opening;
  return (
    <div
      data-testid="ttt-harness-page"
      className="min-h-screen overflow-x-clip bg-gradient-to-b from-[#0d1226] via-[#080d1c] to-[#04060f] px-3 pb-24 pt-20 text-white sm:px-6 md:pb-8 lg:flex lg:h-[100svh] lg:flex-col lg:overflow-y-auto lg:pb-4"
    >
      <div className="mx-auto w-full max-w-6xl lg:flex lg:min-h-0 lg:flex-1 lg:flex-col">
        <div
          data-testid="ttt-harness-header"
          className="mb-2 flex flex-wrap items-center justify-between gap-2 lg:shrink-0"
        >
          <div>
            <h1 className="flex items-center gap-2 text-xl font-extrabold tracking-wide text-transparent bg-clip-text bg-gradient-to-r from-amber-200 via-amber-300 to-yellow-200 sm:text-2xl">
              <span aria-hidden="true" className="inline-block h-6 w-6 shrink-0 rounded bg-amber-400/60" />
              Ultimate Tic-Tac-Toe
            </h1>
            <p className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] font-semibold uppercase tracking-widest text-amber-200/70">
              <span>Nine mini-boards · three in a line claims one</span>
              <span className="rounded-full border border-emerald-400/40 bg-emerald-500/15 px-2 py-0.5 text-[10px] font-bold tracking-wider text-emerald-200">
                10 coins · rated 1v1
              </span>
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className="rounded-full border border-amber-400/40 bg-amber-500/10 px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-amber-200">
              Playing
            </span>
            <button
              type="button"
              className="rounded-lg border border-white/15 bg-white/10 px-3 py-1.5 text-xs font-semibold"
            >
              Lobby
            </button>
          </div>
        </div>

        <div className="grid gap-4 lg:min-h-0 lg:flex-1 lg:grid-rows-[minmax(0,1fr)] lg:grid-cols-[minmax(0,1fr)_320px]">
          <div
            data-testid="ttt-harness-card"
            className="rounded-2xl border border-amber-500/20 bg-black/40 p-2 shadow-[0_0_30px_rgba(251,191,36,0.10)] sm:p-3 lg:grid lg:grid-cols-[300px_minmax(0,1fr)] lg:content-start lg:gap-2"
          >
            <div data-testid="ttt-harness-seats" className="mb-2 grid grid-cols-2 gap-2 lg:mb-0">
              <SeatCard mark="X" name="You" moves={4} active />
              <SeatCard mark="O" name="Opponent" moves={3} active={false} />
            </div>

            <div
              data-testid="ttt-harness-turn"
              className="mb-2 flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-xl border border-amber-400/50 bg-amber-500/10 px-3 py-1.5 lg:mb-0"
            >
              <span className="inline-flex min-w-0 items-center gap-2">
                <span aria-hidden="true" className="inline-block h-2.5 w-2.5 shrink-0 rounded-full animate-pulse bg-amber-400" />
                <span className="truncate text-sm font-bold text-amber-100">
                  Play any board — X to move
                </span>
              </span>
              <span className="text-[11px] tabular-nums text-white/40">7 of 81 cells</span>
            </div>

            {banner && (
              <div
                data-testid="ttt-harness-banner"
                className="mb-3 rounded-xl border border-emerald-400/50 bg-emerald-500/15 px-3 py-2 text-center text-sm font-bold text-emerald-100 lg:fixed lg:inset-x-0 lg:top-20 lg:z-[60] lg:mx-auto lg:mb-0 lg:col-span-2 lg:max-w-md"
              >
                X claims the top-left board!
              </div>
            )}

            <div className="relative lg:col-span-2">
              <MegaBoard
                boards={props.boards}
                winningBoards={props.winningBoards}
                lastMove={props.lastMove}
                nextBoard={props.nextBoard}
                playableBoards={props.playableBoards}
                status={props.status}
                destinationRow={destinationRow}
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

          {/* The controls live in the sidebar on the shipped page, not under the
              lattice — mirrored here so the card height the checks measure is
              the shipped card height. */}
          <aside className="space-y-3 lg:min-h-0 lg:overflow-y-auto lg:pr-1">
            <div
              data-testid="ttt-harness-controls"
              className="rounded-xl border border-white/10 bg-white/5 p-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-[11px] leading-relaxed text-white/45">
                  The cell you play sends your opponent to that same board. Every
                  click is checked by the server.
                </p>
                <button
                  type="button"
                  className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-2.5 text-sm font-bold text-red-300"
                >
                  Forfeit
                </button>
              </div>
              {loadError && (
                <p className="mt-2 rounded-lg border border-amber-400/30 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-200">
                  Could not refresh the match.
                </p>
              )}
            </div>
          </aside>
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

  mount(scenario = "opening", { banner = false, loadError = false, destinationRow = false } = {}) {
    window.__ttt.plays = [];
    window.__ttt.scenario = scenario;
    if (!root) root = createRoot(document.getElementById("root"));
    root.render(
      <App scenario={scenario} banner={banner} loadError={loadError} destinationRow={destinationRow} />,
    );
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
      documentScrollHeight: document.documentElement.scrollHeight,
      documentClientHeight: document.documentElement.clientHeight,
      bodyScrollWidth: document.body.scrollWidth,
      card: box(document.querySelector('[data-testid="ttt-harness-card"]')),
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
      // The measured chrome: what sits above the lattice, what sits below it,
      // and the lattice's own top edge — the three numbers the height reserve
      // is trying to budget for.
      chrome: (() => {
        const pick = (sel) => box(document.querySelector(sel));
        const header = pick('[data-testid="ttt-harness-header"]');
        const seats = pick('[data-testid="ttt-harness-seats"]');
        const turn = pick('[data-testid="ttt-harness-turn"]');
        const banner = pick('[data-testid="ttt-harness-banner"]');
        const controls = pick('[data-testid="ttt-harness-controls"]');
        return {
          // Everything from the top of the page down to the lattice's first px.
          aboveLattice: lattice ? layoutBox(lattice).top : null,
          header: header ? header.height : 0,
          seats: seats ? seats.height : 0,
          turn: turn ? turn.height : 0,
          banner: banner ? banner.height : 0,
          belowLattice: controls
            ? controls.height + Math.max(0, layoutBox(controls).top - (lattice ? layoutBox(lattice).bottom : 0))
            : 0,
          pagePaddingTop: pageStyle ? pageStyle.paddingTop : null,
          pagePaddingBottom: pageStyle ? pageStyle.paddingBottom : null,
        };
      })(),
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
