// qa/dominoes-board-harness.jsx
//
// The REAL Dominoes board (src/components/dominoes/DominoMatchView.tsx), mounted
// inside the REAL page chrome (the wrapper classes and header markup of
// src/app/casino/dominoes/[matchId]/PageClient.tsx) against a scripted snapshot.
//
// Why the component and not the whole page: the page's job around the board is
// its chrome, and that is copied verbatim below — the board is what is being
// checked, so stubbing Clerk, the socket, analytics and the two data hooks would
// only add failure modes without adding anything the board's geometry depends on.
//
// Everything the checker needs lives on `window.__dm`:
//   * `mount({ chainLength, selected })` — render a live match
//   * `measure()`                        — the board, felt and hand geometry
//   * `tiles()`                          — every chain tile's rotation, and the
//                                          rotation actually painted on its halves
//   * `hand()` / `sidebar()`             — where the player's own tiles ended up

import React from "react";
import { createRoot } from "react-dom/client";
import DominoMatchView from "../src/components/dominoes/DominoMatchView";

let root = null;

/**
 * A plausible chain: an opening DOUBLE, then tiles joined value-to-value.
 *
 * The board starts on a double, so the first case a player meets is "the double
 * is upright — are the tiles after it flat?" — which is exactly what `length`
 * lets the checker grow.
 */
function chainOf(length) {
  const tiles = [{ id: "4-4", end: "left", left: 4, right: 4, isDouble: true, seat: "player1" }];
  const values = [2, 5, 1, 6, 3, 0, 4, 2, 5, 1, 6, 3, 0, 4, 2, 5, 1, 6, 3, 0, 2, 5, 1, 6, 3];
  let open = 4;
  for (let index = 0; tiles.length < length; index += 1) {
    const low = values[index % values.length];
    tiles.push({
      id: `${Math.max(open, low)}-${Math.min(open, low)}`,
      end: "right",
      left: open,
      right: low,
      isDouble: open === low,
      seat: index % 2 === 0 ? "player2" : "player1",
    });
    open = low;
  }
  return tiles;
}

function snapshot({ chainLength = 7, isViewerTurn = true } = {}) {
  const chain = chainOf(chainLength);
  const last = chain[chain.length - 1];
  return {
    matchId: "qa-match",
    status: "playing",
    version: 12,
    ply: chain.length,
    viewerSeat: "player1",
    opponentSeat: "player2",
    isLive: true,
    isViewerTurn,
    hand: ["3-6", "6-0", "1-2", "0-0", "2-2", "6-6"],
    chain,
    openEnds: { left: 4, right: last.right ?? 3 },
    turn: isViewerTurn ? "player1" : "player2",
    turnDeadlineAt: new Date(Date.now() + 12_000).toISOString(),
    opponentTileCount: 5,
    drawPileCount: 9,
    players: {
      player1: { name: "You" },
      player2: { name: "Opponent" },
    },
    scores: { player1: 14, player2: 9 },
    matchTarget: 50,
    roundNumber: 2,
  };
}

/** The rect of an element, in viewport pixels, or null. */
const rectOf = (element) => {
  if (!element) return null;
  const box = element.getBoundingClientRect();
  return {
    top: Math.round(box.top),
    bottom: Math.round(box.bottom),
    left: Math.round(box.left),
    right: Math.round(box.right),
    width: Math.round(box.width),
    height: Math.round(box.height),
  };
};

/** A CSS `matrix(...)` transform as degrees clockwise. */
const angleOf = (transform) => {
  const matrix = /matrix\(([^)]+)\)/.exec(transform || "");
  if (!matrix) return 0;
  const [a, b] = matrix[1].split(",").map(Number);
  const degrees = Math.round((Math.atan2(b, a) * 180) / Math.PI);
  return (degrees + 360) % 360;
};

window.__dm = {
  mount(props = {}) {
    const host = document.getElementById("root");
    if (!root) root = createRoot(host);
    root.render(
      <div className="min-h-screen overflow-x-clip bg-gradient-to-br from-[#001628] to-[#03040c] px-3 pb-24 pt-20 text-white sm:px-6 md:pb-8">
        {/* The page's own container (see [matchId]/PageClient.tsx). */}
        <div className="mx-auto w-full max-w-[1500px]">
          {/* The page's own header, verbatim in size and spacing. */}
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h1 className="logo-text flex items-center gap-2 text-2xl font-black uppercase tracking-[0.08em] text-[#7cefff] drop-shadow-[0_0_16px_rgba(0,229,255,0.45)] sm:text-3xl">
                Dominoes
              </h1>
              <p className="mt-1 flex flex-wrap items-center gap-2 text-xs font-semibold uppercase tracking-widest text-white/55">
                <span>Play the classic tile game</span>
                <span className="rounded-full border border-emerald-400/40 bg-emerald-500/15 px-2 py-0.5 text-[10px] font-bold tracking-wider text-emerald-200">
                  Free
                </span>
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full border border-cyan-400/40 bg-cyan-500/10 px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-cyan-200">
                In progress
              </span>
            </div>
          </div>

          <DominoMatchView
            snapshot={snapshot(props)}
            nowMs={Date.now()}
            selected={props.selected ?? null}
            onSelect={() => {}}
            onPlay={() => {}}
            onDraw={() => {}}
            onPass={() => {}}
            onResign={() => {}}
            pending={false}
            notice={null}
          />
        </div>
      </div>,
    );
  },

  measure() {
    const board = document.querySelector(".dominoes-board");
    const layout = document.querySelector(".dominoes-layout");
    const scroller = document.querySelector(".dominoes-chain-scroller");
    const surface = document.querySelector(".dominoes-chain-surface");
    const sidebar = document.querySelector(".dominoes-sidebar");
    const main = document.querySelector(".dominoes-main");
    const hand = document.querySelector(".dominoes-hand");
    const half = document.querySelector(".dominoes-hand .dominoes-tile-half");
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      document: {
        scrollHeight: document.documentElement.scrollHeight,
        clientHeight: document.documentElement.clientHeight,
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      },
      board: rectOf(board),
      layout: rectOf(layout),
      scroller: {
        rect: rectOf(scroller),
        clientWidth: scroller?.clientWidth ?? 0,
        clientHeight: scroller?.clientHeight ?? 0,
        // The felt must NOT need scrolling to find a tile: anything over the
        // client size is a table the player has to go looking for.
        scrollWidth: scroller?.scrollWidth ?? 0,
        scrollHeight: scroller?.scrollHeight ?? 0,
      },
      surface: rectOf(surface),
      surfaceCells: surface
        ? { cols: surface.dataset.cols ?? null, rows: surface.dataset.rows ?? null }
        : null,
      chain: {
        cols: Number(document.querySelector(".dominoes-chain")?.dataset.cols ?? 0),
        rows: Number(document.querySelector(".dominoes-chain")?.dataset.rows ?? 0),
        length: Number(document.querySelector(".dominoes-chain")?.dataset.chainLength ?? 0),
      },
      sidebar: rectOf(sidebar),
      main: rectOf(main),
      hand: rectOf(hand),
      handTileHeight: half ? Math.round(half.getBoundingClientRect().height) : 0,
      cssHalf: parseFloat(getComputedStyle(document.body).getPropertyValue("--dm-half")) || null,
      layoutHeight: layout ? getComputedStyle(layout).height : null,
    };
  },

  /**
   * How much of the screen each part of the board takes, tallest first.
   *
   * The board has to fit ONE screen, so the question is never "is this big?" but
   * "which part is spending the pixels?" — measured, not guessed.
   */
  sections() {
    const named = {
      scoreboard: ".dominoes-scoreboard",
      seat: ".dominoes-seat",
      banner: ".dominoes-banner",
      clock: ".dominoes-clock",
      felt: ".dominoes-chain-scroller",
      pile: ".dominoes-pile",
      hand: ".dominoes-hand",
      actions: ".dominoes-side-panel",
      notice: ".dominoes-notice",
      sound: ".dominoes-sound-button",
      resign: '[data-testid="dominoes-resign"]',
      rules: ".dominoes-rules",
      sidebar: ".dominoes-sidebar",
      main: ".dominoes-main",
      board: ".dominoes-board",
      page: "#root > div",
    };
    const out = {};
    for (const [key, selector] of Object.entries(named)) {
      const element = document.querySelector(selector);
      const box = element?.getBoundingClientRect();
      out[key] = box
        ? {
            height: Math.round(box.height),
            top: Math.round(box.top),
            bottom: Math.round(box.bottom),
          }
        : null;
    }
    out.viewportHeight = window.innerHeight;
    return out;
  },

  /**
   * The last-play badge, and any tile it covers that is not its own.
   *
   * The badge is meant to float in FREE felt beside the end that just moved. In a
   * table that has folded close together it used to land on top of a neighbouring
   * tile and hide its values, so this reports exactly that overlap rather than
   * leaving it to the eye.
   */
  markerOverlaps() {
    const marker = document.querySelector(".dominoes-last-marker");
    if (!marker) return { marker: null, covers: [] };
    const badge = marker.getBoundingClientRect();
    const ownSlot = marker.closest(".dominoes-chain-slot");
    const covers = [];
    for (const tile of document.querySelectorAll(".dominoes-chain-slot .dominoes-tile")) {
      if (ownSlot && ownSlot.contains(tile)) continue;
      const box = tile.getBoundingClientRect();
      const overlapX = Math.min(badge.right, box.right) - Math.max(badge.left, box.left);
      const overlapY = Math.min(badge.bottom, box.bottom) - Math.max(badge.top, box.top);
      if (overlapX > 1 && overlapY > 1) {
        covers.push(`${tile.dataset.tile ?? "?"}(${Math.round(overlapX)}×${Math.round(overlapY)})`);
      }
    }
    return { marker: rectOf(marker), covers };
  },

  /** Every chain tile: the rotation it is placed at, and the one actually painted. */
  tiles() {
    return Array.from(document.querySelectorAll(".dominoes-chain-slot[data-rotation]")).map(
      (slot) => {
        const box = slot.querySelector(".dominoes-chain-tile-box");
        const halves = Array.from(slot.querySelectorAll(".dominoes-tile-half"));
        const placement = Number(slot.dataset.rotation ?? 0);
        return {
          tile: slot.querySelector("[data-tile]")?.dataset.tile ?? null,
          placement,
          isDouble: slot.dataset.double === "true",
          boxAngle: box ? angleOf(getComputedStyle(box).transform) : null,
          halfAngle: halves.length ? angleOf(getComputedStyle(halves[0]).transform) : null,
          // What the reader actually sees: the tile's turn plus the turn put back
          // on the halves. 0 means the values are upright.
          painted: (placement + (halves.length ? angleOf(getComputedStyle(halves[0]).transform) : 0)) % 360,
        };
      },
    );
  },
};
