"use client";

// src/components/solitaire-duel/SolitaireBoard.tsx
//
// The Solitaire Duel board: stock, waste, four foundations and seven tableau
// columns, rendered from the SERVER's projected view.
//
// ── WHAT THIS COMPONENT DOES AND DOES NOT DO ─────────────────────────────
//
// It renders `view` exactly as received. It never generates a card, never
// shuffles, never deals, never reveals a face-down identity, and never computes
// progress or a winner. A face-down slot in the view is `{ faceUp: false,
// card: null }`, so a card THIS component cannot see is a card it cannot draw.
//
// Interaction is CLICK TO SELECT / CLICK TO PLACE (rather than drag-and-drop):
// it is the more reliable model across pointer, touch and keyboard, and it keeps
// rapid play fast — pick a run, then hit a highlighted target. The whole model
// lives in the pure, unit-tested `lib/solitaire-duel/interactions.ts`, which
// builds each candidate move and checks it with the SAME rule authority the
// server uses, so a highlighted target is never a rejected move.
//
// A move is only ever PROPOSED here (`onMove`); the parent sends it and renders
// the server's answer. Nothing about this board is authoritative.

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";

import PlayingCard, { cardLabel, suitGlyph } from "./PlayingCard";
import { SUITS, TABLEAU_COLUMNS } from "../../lib/solitaire-duel/constants";
import {
  canDraw,
  dropTargetsFor,
  resolveClick,
  type BoardSelection,
  type BoardTarget,
} from "../../lib/solitaire-duel/interactions";
import type { SolitaireMove, SolitaireView } from "../../lib/solitaire-duel/types";

/** Card geometry, in card widths, so every size scales from one variable. */
const CARD_W = "var(--cw)";
const CARD_H = "calc(var(--cw) * 1.42)";
/** Visible slice of a fanned card. Bigger overlap = shorter column. */
const FACE_UP_OVERLAP = "calc(var(--cw) * -0.72)";
const FACE_DOWN_OVERLAP = "calc(var(--cw) * -0.86)";

// ── Height budget, so the tableau fits without scrolling ──────────────────
//
// `--cw` used to be `clamp(34px, 10.4vw, 92px)`, i.e. sized by the WIDTH only.
// Seven columns always fit the width, so at desktop widths the clamp pinned
// every card at its 92px maximum and the board became a fixed 648px tall —
// taller than the space left under the page chrome on a typical laptop
// viewport (528px at 1280x800), so the bottom of the tableau sat below the fold
// and the player had to scroll mid-game. Sizing by the height as well is what
// fixes it.

/** A card's height as a fraction of its width (matches CARD_H above). */
const CARD_RATIO = 1.42;
/**
 * The visible vertical ADVANCE of a fanned card, in card widths: the card's
 * height minus the overlap above it. Note the overlap is a card-WIDTH value
 * while the height is CARD_RATIO widths, so the advance is `CARD_RATIO - overlap`
 * (0.70 face-up, 0.56 face-down) — not `1 - overlap`.
 */
const FACE_UP_ADVANCE = CARD_RATIO - 0.72; // 0.70
const FACE_DOWN_ADVANCE = CARD_RATIO - 0.86; // 0.56

/**
 * Board height in card-widths, worst case. The tallest Klondike column is the
 * seventh one fully face-up (its six face-down cards flipped as play
 * progressed): one full card plus six face-up advances. The board is that
 * column plus the stock/waste/foundations row sitting above it.
 */
const BOARD_CW = (CARD_RATIO + (CARD_RATIO + 6 * FACE_UP_ADVANCE)).toFixed(2); // "7.04"

/**
 * Everything stacked ABOVE the tableau, in rem: the page's top padding, the
 * navigation bar, the header block, the two progress meters and the board's own
 * bordered frame. This is what the height term has to leave room for — the
 * status line, race facts and legend below the tableau are allowed to sit under
 * the fold, because the ask is that the CARDS are visible without scrolling.
 */
const CHROME_REM = "17rem";

export type SolitaireBoardProps = {
  view: SolitaireView | null;
  /** False before GO, once the clock expires, and once a result has landed. */
  interactive: boolean;
  /** A move is in flight. Only the stock keeps responding (queued draws). */
  pending?: boolean;
  onMove: (move: SolitaireMove) => void;
  /** A click that could not become a move — surfaced as an unobtrusive notice. */
  onInvalid?: (message: string) => void;
};

function slotStyle(): CSSProperties {
  return { width: CARD_W, height: CARD_H };
}

/** An empty slot: still a target, so it must look and behave like one. */
function EmptySlot({
  label,
  hint,
  highlighted,
  interactive,
  testId,
  onClick,
}: {
  label: string;
  hint?: string;
  highlighted: boolean;
  interactive: boolean;
  testId: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={!interactive}
      tabIndex={interactive ? 0 : -1}
      onClick={onClick}
      data-testid={testId}
      aria-label={hint || label}
      style={slotStyle()}
      className={`flex select-none flex-col items-center justify-center rounded-[6px] border-2 border-dashed text-white/35 transition ${
        highlighted
          ? "border-[#00e5ff]/80 bg-[#00e5ff]/10 text-[#9beaff] shadow-[0_0_14px_rgba(0,229,255,0.35)]"
          : "border-white/15 bg-white/[0.03]"
      } ${interactive ? "cursor-pointer hover:border-white/30" : "cursor-default"}`}
    >
      <span aria-hidden="true" className="text-[clamp(13px,2vw,22px)] leading-none">
        {label}
      </span>
      {hint && (
        <span className="mt-0.5 text-[9px] font-bold uppercase tracking-wider">{hint}</span>
      )}
    </button>
  );
}

export default function SolitaireBoard({
  view,
  interactive,
  pending = false,
  onMove,
  onInvalid,
}: SolitaireBoardProps) {
  const [selection, setSelection] = useState<BoardSelection | null>(null);

  const board = view ?? null;
  const ply = board?.ply ?? 0;

  // A new authoritative board invalidates the held card: the server has moved
  // (or the opponent's view changed), so what was selected may no longer be
  // where it was. Also drop the selection whenever the board goes inert.
  useEffect(() => {
    setSelection(null);
  }, [ply]);

  useEffect(() => {
    if (!interactive) setSelection(null);
  }, [interactive]);

  // While a move is in flight only the stock stays live (so a rapid stock cycle
  // can be queued); every card interaction waits for the authoritative state.
  const cardsInteractive = interactive && !pending;
  const stockInteractive = interactive && canDraw(board);

  const targets = useMemo(() => dropTargetsFor(board, selection), [board, selection]);

  const click = useCallback(
    (target: BoardTarget) => {
      if (!board) return;
      const result = resolveClick(board, selection, target);
      if (result.type === "select") {
        setSelection(result.selection);
        return;
      }
      if (result.type === "clear") {
        setSelection(null);
        return;
      }
      if (result.type === "move") {
        setSelection(null);
        onMove(result.move);
        return;
      }
      if (result.type === "invalid") {
        setSelection(null);
        onInvalid?.(result.message);
      }
    },
    [board, selection, onMove, onInvalid],
  );

  if (!board) {
    return (
      <div
        data-testid="solitaire-board"
        data-empty="true"
        className="flex h-64 items-center justify-center rounded-2xl border border-white/10 bg-black/30 text-sm text-white/50"
      >
        Waiting for the server&apos;s deal…
      </div>
    );
  }

  const waste = board.waste ?? [];
  const wasteVisible = waste.slice(Math.max(0, waste.length - 3));
  const stockCount = Math.max(0, board.stockCount ?? 0);
  const canRedeal = stockCount === 0 && waste.length > 0;
  const heldLabel = selection
    ? selection.kind === "waste"
      ? "the waste card"
      : selection.kind === "foundation"
        ? "that foundation card"
        : "that run"
    : null;

  return (
    <div
      data-testid="solitaire-board"
      data-ply={board.ply}
      data-stock={stockCount}
      data-selected={selection ? selection.kind : "none"}
      // One variable sizes every card and every fan, so the whole board scales
      // from a single clamp: 34px cards on a phone, up to 92px on a tall
      // desktop. Seven columns always fit the WIDTH, so it is the board's
      // HEIGHT that decides whether the tableau is visible without scrolling.
      //
      // The second term therefore also caps the card by the viewport height.
      // The board is BOARD_CW card-widths tall (see the derivation above), so
      // dividing the height left over after the page chrome by BOARD_CW gives
      // the largest card whose bottom card still clears the fold. `CHROME_REM`
      // is everything above the tableau — page padding, the title, the two
      // progress meters, the board's own frame, the top row, the inter-row gap
      // and the legend below it.
      //
      // On a tall screen `min()` picks the width term and nothing changes; on a
      // short laptop viewport (~768-800px tall, where the width term wanted the
      // full 92px) the cards shrink just enough to stop the tableau scrolling.
      // The 34px floor still governs phones, where the width term is smaller
      // than this one and mobile sizing is untouched.
      style={
        {
          "--cw": `clamp(34px, min(10.4vw, calc((100vh - ${CHROME_REM}) / ${BOARD_CW})), 92px)`,
        } as CSSProperties
      }
      className="w-full touch-manipulation select-none"
    >
      {/* ── Top row: stock · waste · the four foundations ──────────────── */}
      <div className="flex items-start gap-1 sm:gap-2">
        {stockCount > 0 ? (
          <button
            type="button"
            disabled={!stockInteractive}
            tabIndex={stockInteractive ? 0 : -1}
            onClick={() => click({ kind: "stock" })}
            aria-label={`Draw from the stock — ${stockCount} cards left`}
            data-testid="solitaire-stock"
            data-remaining={stockCount}
            style={slotStyle()}
            className={`relative flex select-none items-center justify-center overflow-hidden rounded-[6px] border border-[#1b2a4a] bg-gradient-to-br from-[#1d3a63] via-[#16294a] to-[#0f1d36] transition ${
              stockInteractive ? "cursor-pointer hover:brightness-125" : "cursor-default"
            }`}
          >
            <span
              aria-hidden="true"
              className="h-[62%] w-[62%] rounded-[4px] border border-[#00e5ff]/25 bg-[repeating-linear-gradient(45deg,rgba(0,229,255,0.16)_0_3px,transparent_3px_6px)]"
            />
            <span className="absolute bottom-0.5 right-1 text-[10px] font-black text-white/80">
              {stockCount}
            </span>
          </button>
        ) : (
          <EmptySlot
            label={canRedeal ? "\u21bb" : "\u2014"}
            hint={canRedeal ? "Redeal" : undefined}
            highlighted={false}
            interactive={stockInteractive}
            testId="solitaire-stock"
            onClick={() => click({ kind: "stock" })}
          />
        )}

        {/* Waste: the last three cards, fanned left to right. Only the top one
            is ever movable — the engine's rule, mirrored by the engine's own
            validator through interactions.ts. */}
        <div
          className="relative flex items-start"
          data-testid="solitaire-waste"
          data-count={waste.length}
        >
          {wasteVisible.length === 0 ? (
            <EmptySlot
              label=""
              hint="Waste"
              highlighted={false}
              interactive={false}
              testId="solitaire-waste-empty"
              onClick={() => {}}
            />
          ) : (
            wasteVisible.map((card, index) => {
              const isTop = index === wasteVisible.length - 1;
              const isHeld = isTop && selection?.kind === "waste";
              return (
                <PlayingCard
                  key={`${card.suit}-${card.rank}`}
                  card={card}
                  faceUp
                  interactive={isTop && cardsInteractive}
                  selected={Boolean(isHeld)}
                  label={
                    isTop
                      ? `${cardLabel(card)} — the top of the waste, click to pick it up`
                      : cardLabel(card)
                  }
                  testId={isTop ? "solitaire-waste-top" : undefined}
                  style={{
                    width: CARD_W,
                    height: CARD_H,
                    marginLeft: index === 0 ? 0 : "calc(var(--cw) * -0.52)",
                    zIndex: index,
                  }}
                  onClick={isTop ? () => click({ kind: "waste" }) : undefined}
                />
              );
            })
          )}
        </div>

        {/* Spacer: pushes the foundations to the right edge on wide screens and
            collapses to a gap on narrow ones. */}
        <div aria-hidden="true" className="min-w-1 flex-1" />

        <div className="flex items-start gap-1 sm:gap-2">
          {SUITS.map((suit) => {
            const pile = board.foundations?.[suit] ?? [];
            const top = pile.length > 0 ? pile[pile.length - 1] : null;
            const isHeld = selection?.kind === "foundation" && selection.suit === suit;
            const highlighted = targets.suits.includes(suit);
            if (!top) {
              return (
                <EmptySlot
                  key={suit}
                  label={suitGlyph(suit)}
                  hint="A"
                  highlighted={highlighted}
                  interactive={cardsInteractive}
                  testId={`solitaire-foundation-${suit}`}
                  onClick={() => click({ kind: "foundation", suit })}
                />
              );
            }
            return (
              <span key={suit} data-testid={`solitaire-foundation-${suit}`} data-count={pile.length}>
                <PlayingCard
                  card={top}
                  faceUp
                  interactive={cardsInteractive}
                  selected={Boolean(isHeld)}
                  highlighted={highlighted}
                  label={`${cardLabel(top)} on the ${suit} foundation`}
                  style={slotStyle()}
                  onClick={() => click({ kind: "foundation", suit })}
                />
              </span>
            );
          })}
        </div>
      </div>

      {/* ── Tableau: seven columns, each a fanned stack ─────────────────── */}
      <div className="mt-2 grid grid-cols-7 gap-1 sm:mt-3 sm:gap-2">
        {Array.from({ length: TABLEAU_COLUMNS }, (_, column) => {
          const pile = board.tableau?.[column] ?? [];
          const isHighlighted = targets.columns.includes(column);
          return (
            <div
              key={column}
              data-testid={`solitaire-column-${column}`}
              data-cards={pile.length}
              className="flex flex-col items-center"
            >
              {pile.length === 0 && (
                <EmptySlot
                  label="K"
                  hint="King"
                  highlighted={isHighlighted}
                  interactive={cardsInteractive}
                  testId={`solitaire-column-${column}-empty`}
                  onClick={() => click({ kind: "column", column })}
                />
              )}

              {pile.map((slot, index) => {
                const isTop = index === pile.length - 1;
                const card = slot.faceUp ? slot.card : null;
                // The TOP card of a column doubles as the column's drop slot;
                // any other face-up card picks up the run headed by it.
                const dropsHere =
                  Boolean(selection) &&
                  isHighlighted &&
                  !(selection?.kind === "tableau" && selection.column === column);
                const target: BoardTarget =
                  isTop && dropsHere
                    ? { kind: "column", column }
                    : slot.faceUp && slot.card
                      ? { kind: "tableau", column, card: slot.card }
                      : { kind: "column", column };

                const faceUp = Boolean(slot.faceUp && slot.card);
                const clickable = faceUp ? cardsInteractive : false;
                const isHeld =
                  Boolean(selection) &&
                  selection?.kind === "tableau" &&
                  selection.column === column &&
                  faceUp &&
                  Boolean(slot.card);

                return (
                  <PlayingCard
                    key={`${index}-${slot.card ? `${slot.card.suit}${slot.card.rank}` : "hidden"}`}
                    card={card}
                    faceUp={faceUp}
                    interactive={clickable}
                    selected={Boolean(isHeld)}
                    highlighted={isTop && dropsHere}
                    label={
                      faceUp && slot.card
                        ? `${cardLabel(slot.card)} — column ${column + 1}, position ${index + 1}`
                        : `Face-down card — column ${column + 1}, position ${index + 1}`
                    }
                    testId={`solitaire-card-${column}-${index}`}
                    style={{
                      width: CARD_W,
                      height: CARD_H,
                      marginTop: index === 0 ? 0 : faceUp ? FACE_UP_OVERLAP : FACE_DOWN_OVERLAP,
                      zIndex: index,
                    }}
                    onClick={clickable ? () => click(target) : undefined}
                  />
                );
              })}
            </div>
          );
        })}
      </div>

      {/* A one-line legend instead of a tutorial: it states the only rule a
          Klondike player cannot see from the board itself (the automatic flip)
          and the current hold. */}
      <p className="mt-2 text-center text-[11px] leading-relaxed text-white/45">
        {selection
          ? `Holding ${heldLabel} — click a highlighted pile to place it, or the card again to put it back.`
          : canRedeal
            ? "Stock empty — click the \u21bb slot to turn the waste back over."
            : "Click a card to pick it up, then click where it should go. A face-down card flips by itself when the card above it leaves."}
      </p>
    </div>
  );
}
