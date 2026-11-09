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
// Interaction is DRAG AND DROP, with click-to-select / click-to-place kept as an
// equal path (keyboard play needs it, and so does rapid play): drag a card — or
// a whole face-up run — onto a pile, or click it and then click a highlighted
// target. Both models build their move through the pure, unit-tested
// `lib/solitaire-duel/interactions.ts`, which checks every candidate with the
// SAME rule authority the server uses, so a highlighted (or dropped-on) target
// is never a rejected move.
//
// A move is only ever PROPOSED here (`onMove`); the parent sends it and renders
// the server's answer. Nothing about this board is authoritative.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";

import PlayingCard, { cardLabel, suitGlyph } from "./PlayingCard";
import { useSolitaireBoardTheme } from "../../hooks/useSolitaireBoardTheme";
import { SUITS, TABLEAU_COLUMNS } from "../../lib/solitaire-duel/constants";
import {
  canDraw,
  dropTargetsFor,
  foundationTopCard,
  moveForTarget,
  resolveClick,
  selectionFor,
  wasteTopCard,
  type BoardSelection,
  type BoardTarget,
  type DropTarget,
} from "../../lib/solitaire-duel/interactions";
import type { Card, SolitaireMove, SolitaireView, Suit } from "../../lib/solitaire-duel/types";

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

/**
 * The cards under the pointer while a drag is in flight.
 *
 * `easing` turns a position update into an animation — the snap onto the pile
 * the card would land on, and the flight home when a drop is refused. Free
 * following has to stay pinned to the pointer, so it is only ever true when
 * the target has already been chosen.
 */
type DragGhost = { x: number; y: number; cards: Card[]; easing: boolean };

/** A pointer press that may yet become a drag. */
type DragSession = {
  pointerId: number;
  startX: number;
  startY: number;
  /** Centre of the card that was pressed: where a refused drop flies back to. */
  originX: number;
  originY: number;
  /** True once the pointer has travelled far enough to count as a drag. */
  active: boolean;
  selection: BoardSelection;
  cards: Card[];
};

/** How far a pointer must travel before a press becomes a drag, in CSS pixels. */
const DRAG_THRESHOLD_PX = 6;

/**
 * How long a gesture's own click stays swallowed.
 *
 * A press the board has already decided must not be decided again by the click
 * the browser fires on release. That click normally arrives immediately, so the
 * flag below is cleared by it; this window is only the safety net for a gesture
 * that never produces one at all (a drag released outside the element, a
 * cancelled pointer).
 */
const CLICK_SWALLOW_MS = 500;

/** How long the ghost takes to snap onto a pile, and to fly back home. */
const GHOST_EASE_MS = 150;
const GHOST_RETURN_MS = 190;
/** How long an ACCEPTED drop settles onto its pile before the move is sent. */
const GHOST_SETTLE_MS = 160;

/**
 * Where a held card would come to rest in a slot, in viewport coordinates.
 *
 * A foundation is a single card-sized box, so the ghost sits on it. A tableau
 * column is a FAN: a dropped card lands one overlap BELOW the last card, so the
 * ghost goes there rather than over the middle of the stack — the snap shows
 * where the card will actually be. Everything is measured from the live DOM, so
 * it is right at every card size the board-fit clamp produces.
 */
function landingPoint(slot: HTMLElement): { x: number; y: number } {
  const cards = slot.querySelectorAll<HTMLElement>("[data-face-up]");
  const last = cards.length > 0 ? cards[cards.length - 1] : null;
  const rect = (last ?? slot).getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  if (!last || slot.dataset.dropKind !== "column") return { x, y };

  // One fan step down — the overlap the column applies to the next card.
  const faceUp = last.dataset.faceUp === "true";
  return { x, y: y + (rect.height - (faceUp ? 0.72 : 0.86) * rect.width) };
}

/**
 * The drop slot under a set of viewport coordinates, and where a card dropped
 * there would come to rest.
 *
 * Read from the DOM rather than tracked in state: the pointer can be over any
 * card, any pile or the gap between columns, and the elements already carry the
 * slot they belong to. The ghost is pointer-events-none, so it can never be the
 * element this finds.
 */
function dropSlotAt(x: number, y: number): { drop: DropTarget; x: number; y: number } | null {
  const element = document.elementFromPoint(x, y);
  const slot = element?.closest?.<HTMLElement>("[data-drop-kind]");
  if (!slot) return null;

  let drop: DropTarget | null = null;
  if (slot.dataset.dropKind === "column") {
    const column = Number(slot.dataset.dropColumn);
    drop = Number.isInteger(column) ? { kind: "column", column } : null;
  } else if (slot.dataset.dropKind === "foundation") {
    const suit = slot.dataset.dropSuit as Suit | undefined;
    drop = suit ? { kind: "foundation", suit } : null;
  }
  if (!drop) return null;

  return { drop, ...landingPoint(slot) };
}

/** An empty slot: still a target, so it must look and behave like one. */
function EmptySlot({
  label,
  hint,
  highlighted,
  interactive,
  testId,
  drop,
  onClick,
}: {
  label: string;
  hint?: string;
  highlighted: boolean;
  interactive: boolean;
  testId: string;
  /** The slot this empty pile accepts a dropped card for. */
  drop?: DropTarget;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={!interactive}
      tabIndex={interactive ? 0 : -1}
      onClick={onClick}
      data-testid={testId}
      data-drop-kind={drop?.kind}
      data-drop-column={drop && drop.kind === "column" ? drop.column : undefined}
      data-drop-suit={drop && drop.kind === "foundation" ? drop.suit : undefined}
      aria-label={hint || label}
      style={slotStyle()}
      className={`gr-focusable flex select-none flex-col items-center justify-center rounded-[6px] border-2 transition ${
        highlighted
          ? // An empty pile that will accept the held card: SOLID edge, while
            // the held card itself wears the dashed selection outline.
            "border-solid border-[color:var(--sol-legal)] bg-[color:var(--sol-slot-active)] text-[color:var(--sol-legal)] shadow-[0_0_12px_var(--sol-legal-glow)]"
          : "border-dashed border-[color:var(--sol-slot-border)] bg-[color:var(--sol-slot)] text-[color:var(--sol-slot-ink)]"
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
  // The table this board is played on. Every mode renders THIS component, so
  // reading the shared theme here is what keeps solo, daily, practice and
  // ranked identical; nothing is passed down per route.
  const { theme } = useSolitaireBoardTheme();
  const [selection, setSelection] = useState<BoardSelection | null>(null);
  const boardRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragSession | null>(null);
  /**
   * One gesture, one decision: a press resolved at `pointerdown` — or a drag that
   * ended — must not also be resolved by the click that follows the release.
   */
  const swallowClickRef = useRef(false);
  const swallowTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const returnTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settleMoveRef = useRef<(() => void) | null>(null);
  const [dragGhost, setDragGhost] = useState<DragGhost | null>(null);

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

  // A ghost still flying home (or settling) when the board unmounts must not
  // call setState on a component that is gone.
  useEffect(
    () => () => {
      if (returnTimerRef.current !== null) clearTimeout(returnTimerRef.current);
      if (settleTimerRef.current !== null) clearTimeout(settleTimerRef.current);
      if (swallowTimerRef.current !== null) clearTimeout(swallowTimerRef.current);
    },
    [],
  );

  /** Ignore the click this gesture is about to produce. */
  const swallowNextClick = useCallback(() => {
    swallowClickRef.current = true;
    if (swallowTimerRef.current !== null) clearTimeout(swallowTimerRef.current);
    swallowTimerRef.current = setTimeout(() => {
      swallowTimerRef.current = null;
      swallowClickRef.current = false;
    }, CLICK_SWALLOW_MS);
  }, []);

  // While a move is in flight only the stock stays live (so a rapid stock cycle
  // can be queued); every card interaction waits for the authoritative state.
  const cardsInteractive = interactive && !pending;
  const stockInteractive = interactive && canDraw(board);

  const targets = useMemo(() => dropTargetsFor(board, selection), [board, selection]);

  /** Land a settling drop now: clear the ghost and send its move. */
  const commitSettle = useCallback(() => {
    const commit = settleMoveRef.current;
    settleMoveRef.current = null;
    if (settleTimerRef.current !== null) {
      clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    }
    setDragGhost(null);
    commit?.();
  }, []);

  /**
   * An accepted drop SETTLES: the ghost eases onto the pile the card is going to
   * and the move is sent only once it has arrived. Committing at the moment of
   * release would flash two copies of the same card.
   */
  const settleDrop = useCallback(
    (session: DragSession, at: { x: number; y: number }, move: SolitaireMove) => {
      setDragGhost({ x: at.x, y: at.y, cards: session.cards, easing: true });
      settleMoveRef.current = () => onMove(move);
      if (settleTimerRef.current !== null) clearTimeout(settleTimerRef.current);
      settleTimerRef.current = setTimeout(() => {
        settleTimerRef.current = null;
        commitSettle();
      }, GHOST_SETTLE_MS);
    },
    [commitSettle, onMove],
  );

  const click = useCallback(
    (target: BoardTarget) => {
      if (!board) return;
      // This gesture was already decided at pointerdown (or by the drag it
      // became) — the trailing click must not decide it a second time.
      if (swallowClickRef.current) {
        swallowClickRef.current = false;
        if (swallowTimerRef.current !== null) {
          clearTimeout(swallowTimerRef.current);
          swallowTimerRef.current = null;
        }
        return;
      }
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

  /**
   * The press a pointerdown would make, read from the card's own `data-drag-*`
   * markers — so the board needs one handler, not one per card. A hidden card
   * carries no markers and can never be lifted; a non-head card inside a run
   * resolves to null through `selectionFor`, exactly as a click would.
   *
   * The TARGET follows the same precedence the render uses: the top card of a
   * lit column IS that column's drop slot, and anything else is the card's own
   * run head. Keeping the two in step is what lets a press be decided at
   * pointerdown without ever disagreeing with the click model.
   *
   * An EMPTY pile has no card to lift but is still a place to lay one down, so a
   * press on an empty slot resolves to that slot's target with nothing to drag.
   * Only the empty-slot BUTTONS qualify: pressing the bare space below a
   * column's cards is not a placement.
   */
  const pressAtPointer = useCallback(
    (
      target: EventTarget | null,
    ): { target: BoardTarget; selection: BoardSelection | null; cards: Card[] } | null => {
      if (!board) return null;
      const element = target instanceof Element ? target : null;
      if (!element) return null;
      const card = element.closest<HTMLElement>("[data-drag-slot]");

      if (!card) {
        const empty = element.closest<HTMLElement>("button[data-drop-kind]");
        if (!empty) return null;
        if (empty.dataset.dropKind === "column") {
          const column = Number(empty.dataset.dropColumn);
          return Number.isInteger(column)
            ? { target: { kind: "column", column }, selection: null, cards: [] }
            : null;
        }
        const suit = empty.dataset.dropSuit as Suit | undefined;
        return suit
          ? { target: { kind: "foundation", suit }, selection: null, cards: [] }
          : null;
      }

      if (card.dataset.dragSlot === "waste") {
        const found = selectionFor(board, { kind: "waste" });
        const top = wasteTopCard(board);
        return found && top
          ? { target: { kind: "waste" }, selection: found, cards: [top] }
          : null;
      }

      if (card.dataset.dragSlot === "foundation") {
        const suit = card.dataset.dragSuit as Suit | undefined;
        if (!suit) return null;
        const found = selectionFor(board, { kind: "foundation", suit });
        const top = foundationTopCard(board, suit);
        return found && top
          ? { target: { kind: "foundation", suit }, selection: found, cards: [top] }
          : null;
      }

      if (card.dataset.dragSlot === "tableau") {
        const column = Number(card.dataset.dragColumn);
        const index = Number(card.dataset.dragIndex);
        const pile = board.tableau?.[column];
        const slot = Number.isInteger(index) ? pile?.[index] : undefined;
        if (!Number.isInteger(column) || !slot?.faceUp || !slot.card) return null;
        const found = selectionFor(board, { kind: "tableau", column, card: slot.card });
        if (found?.kind !== "tableau") return null;
        const isTop = index === pile.length - 1;
        return {
          target:
            isTop && selection && targets.columns.includes(column)
              ? { kind: "column", column }
              : { kind: "tableau", column, card: slot.card },
          selection: found,
          cards: found.run,
        };
      }

      return null;
    },
    [board, selection, targets],
  );

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!cardsInteractive) return;
      if (event.pointerType === "mouse" && event.button !== 0) return;
      const found = pressAtPointer(event.target);
      if (!found) return;
      const source = found.cards.length > 0 && event.target instanceof Element
        ? event.target.closest<HTMLElement>("[data-drag-slot]")
        : null;
      const rect = source?.getBoundingClientRect();

      // A new gesture cancels a card still flying home from the last one, and
      // COMMITS a drop still settling (so its move is never lost).
      const settling = settleMoveRef.current !== null;
      if (settling) commitSettle();
      if (returnTimerRef.current !== null) {
        clearTimeout(returnTimerRef.current);
        returnTimerRef.current = null;
      }
      setDragGhost(null);

      // ── The press IS the decision ───────────────────────────────────────
      // Picking a card up, putting it back down and LAYING IT ON A PILE are all
      // resolved HERE, on the press, instead of on the click that only arrives
      // once the button comes back up. That release can be a full human press
      // away, and it is the whole difference between a board that answers the
      // instant it is touched and one that makes the player wait for their own
      // mouse. A decision this gesture has already made is never made twice: the
      // click it goes on to produce is swallowed (see `swallowNextClick`). A
      // press that lands mid-settle is left to the click, because the board it
      // would be decided against is one move out of date.
      if (!settling) {
        const decision = resolveClick(board, selection, found.target);
        if (decision.type === "select" || decision.type === "clear") {
          swallowNextClick();
          setSelection(decision.type === "select" ? decision.selection : null);
        } else if (decision.type === "move") {
          // The pile has taken the card: no drag is started from this press,
          // because the move already owns the gesture.
          swallowNextClick();
          setSelection(null);
          onMove(decision.move);
          return;
        }
      }

      // An empty pile is a place to lay a card, not a card to lift.
      if (found.cards.length === 0) return;

      dragRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        originX: rect ? rect.left + rect.width / 2 : event.clientX,
        originY: rect ? rect.top + rect.height / 2 : event.clientY,
        active: false,
        selection: found.selection,
        cards: found.cards,
      };
    },
    [cardsInteractive, pressAtPointer, commitSettle, board, selection, swallowNextClick, onMove],
  );

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const session = dragRef.current;
    if (!session || session.pointerId !== event.pointerId) return;

    if (!session.active) {
      const travelled = Math.hypot(
        event.clientX - session.startX,
        event.clientY - session.startY,
      );
      if (travelled < DRAG_THRESHOLD_PX) return;
      session.active = true;
      // The dragged card drives the SAME target highlighting as click-to-place.
      setSelection(session.selection);
      try {
        boardRef.current?.setPointerCapture(event.pointerId);
      } catch {
        // A capture can be refused if the pointer already ended; the drop still
        // resolves from the coordinates.
      }
    }

    event.preventDefault();
    // Snap the ghost onto a pile only when that pile would actually ACCEPT the
    // card, so it never promises a drop the engine would refuse. Everything
    // else follows the pointer exactly.
    const slot = dropSlotAt(event.clientX, event.clientY);
    const accepted = slot && board ? moveForTarget(board, session.selection, slot.drop) : null;
    setDragGhost(
      slot && accepted
        ? { x: slot.x, y: slot.y, cards: session.cards, easing: true }
        : { x: event.clientX, y: event.clientY, cards: session.cards, easing: false },
    );
  }, [board]);

  /** Fly the ghost back to the card it was lifted from, then let it go. */
  const flyHome = useCallback((session: DragSession) => {
    setDragGhost({
      x: session.originX,
      y: session.originY,
      cards: session.cards,
      easing: true,
    });
    if (returnTimerRef.current !== null) clearTimeout(returnTimerRef.current);
    returnTimerRef.current = setTimeout(() => {
      returnTimerRef.current = null;
      setDragGhost(null);
    }, GHOST_RETURN_MS);
  }, []);

  const finishDrag = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>, cancelled: boolean) => {
      const session = dragRef.current;
      if (!session || session.pointerId !== event.pointerId) return;
      dragRef.current = null;

      // A press that never moved is a click: leave it to the click model.
      if (!session.active) return;

      // The drag has decided this gesture; its release must not also click.
      swallowNextClick();
      try {
        boardRef.current?.releasePointerCapture(event.pointerId);
      } catch {
        // Already released.
      }

      if (cancelled || !board) {
        setSelection(null);
        flyHome(session);
        return;
      }

      const slot = dropSlotAt(event.clientX, event.clientY);
      const move = slot ? moveForTarget(board, session.selection, slot.drop) : null;
      setSelection(null);

      if (move && slot) {
        settleDrop(session, slot, move);
        return;
      }
      // Refused (or dropped on nothing at all): the card flies back to where it
      // came from, so the gesture always ends with the card where it started.
      flyHome(session);
      if (slot) onInvalid?.("That card cannot be placed there");
    },
    [board, onInvalid, flyHome, settleDrop, swallowNextClick],
  );

  const onPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => finishDrag(event, false),
    [finishDrag],
  );
  const onPointerCancel = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => finishDrag(event, true),
    [finishDrag],
  );

  if (!board) {
    return (
      <div
        data-testid="solitaire-board"
        data-empty="true"
        className="flex h-64 items-center justify-center rounded-2xl border border-[color:var(--gr-hairline)] bg-black/30 text-sm text-white/50"
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
      ref={boardRef}
      data-testid="solitaire-board"
      data-ply={board.ply}
      data-stock={stockCount}
      data-selected={selection ? selection.kind : "none"}
      data-dragging={dragGhost ? "true" : "false"}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
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
          // ── The table (lib/solitaire-duel/boardThemes) ──────────────────
          // One set of custom properties on the board root is what the empty
          // piles and the legend below read. A theme change therefore repaints
          // in place: no card, no column and no geometry is re-measured.
          "--sol-slot": theme.slot.fill,
          "--sol-slot-border": theme.slot.border,
          "--sol-slot-ink": theme.slot.ink,
          "--sol-slot-active": theme.slot.activeFill,
          "--sol-legal": theme.legal.ink,
          "--sol-legal-glow": theme.legal.glow,
          "--sol-legend": theme.legend,
          backgroundImage: theme.felt,
          // The felt's edge is an INSET ring, never a border: a border would add
          // 4px to the height the `--cw` budget above was computed against.
          boxShadow: `inset 0 0 0 2px ${theme.frame}, 0 10px 30px rgba(3, 8, 20, 0.35)`,
        } as CSSProperties
      }
      data-solitaire-theme={theme.key}
      className="w-full touch-manipulation select-none rounded-2xl"
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
            className={`gr-focusable relative flex select-none items-center justify-center overflow-hidden rounded-[6px] border-2 border-[color:var(--gr-outline)] bg-linear-to-br from-[#1d3a63] via-[#16294a] to-[#0f1d36] shadow-[0_1px_2px_rgba(3,8,20,0.55)] transition ${
              stockInteractive ? "cursor-pointer hover:brightness-125" : "cursor-default"
            }`}
          >
            <span
              aria-hidden="true"
              className="h-[62%] w-[62%] rounded-[4px] border border-[color:var(--gr-hairline)] bg-[repeating-linear-gradient(45deg,rgba(0,229,255,0.16)_0_3px,transparent_3px_6px)]"
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
                  dataAttrs={isTop ? { "data-drag-slot": "waste" } : undefined}
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
                  drop={{ kind: "foundation", suit }}
                  onClick={() => click({ kind: "foundation", suit })}
                />
              );
            }
            return (
              <span
                key={suit}
                data-testid={`solitaire-foundation-${suit}`}
                data-count={pile.length}
                data-drop-kind="foundation"
                data-drop-suit={suit}
              >
                <PlayingCard
                  card={top}
                  faceUp
                  interactive={cardsInteractive}
                  selected={Boolean(isHeld)}
                  highlighted={highlighted}
                  label={`${cardLabel(top)} on the ${suit} foundation`}
                  dataAttrs={{ "data-drag-slot": "foundation", "data-drag-suit": suit }}
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
              data-drop-kind="column"
              data-drop-column={column}
              className="flex flex-col items-center"
            >
              {pile.length === 0 && (
                <EmptySlot
                  label="K"
                  hint="King"
                  highlighted={isHighlighted}
                  interactive={cardsInteractive}
                  testId={`solitaire-column-${column}-empty`}
                  drop={{ kind: "column", column }}
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
                    dataAttrs={
                      faceUp
                        ? {
                            "data-drag-slot": "tableau",
                            "data-drag-column": String(column),
                            "data-drag-index": String(index),
                          }
                        : undefined
                    }
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

      {/* The card(s) under the pointer while dragging. pointer-events-none, so
          the ghost can never shadow the drop slot `elementFromPoint` finds. It
          snaps onto the slot a card would land on, settles there before an
          accepted move is sent, and eases home when the drop is refused; all
          three are transitions, so the board's layout and its `--cw` fit are
          never touched by a gesture. */}
      {dragGhost ? (
        <div
          aria-hidden="true"
          data-testid="solitaire-drag-ghost"
          data-snapped={dragGhost.easing ? "true" : "false"}
          className="pointer-events-none fixed z-50 -translate-x-1/2 -translate-y-1/2 drop-shadow-2xl"
          style={{
            left: dragGhost.x,
            top: dragGhost.y,
            // Free following must not lag behind the pointer; a snap or a
            // flight home must be animated, so only those ease.
            transition: dragGhost.easing
              ? `left ${GHOST_EASE_MS}ms ease-out, top ${GHOST_EASE_MS}ms ease-out`
              : "none",
          }}
        >
          {dragGhost.cards.map((card, index) => (
            <PlayingCard
              key={`${card.suit}-${card.rank}`}
              card={card}
              faceUp
              interactive={false}
              style={{
                width: CARD_W,
                height: CARD_H,
                marginTop: index === 0 ? 0 : FACE_UP_OVERLAP,
              }}
            />
          ))}
        </div>
      ) : null}

      {/* A one-line legend instead of a tutorial: it states the only rule a
          Klondike player cannot see from the board itself (the automatic flip)
          and the current hold. */}
      <p className="mt-2 text-center text-[11px] leading-relaxed text-[color:var(--sol-legend)]">
        {selection
          ? `Holding ${heldLabel} — drop it on a highlighted pile, or click one to place it.`
          : canRedeal
            ? "Stock empty — click the \u21bb slot to turn the waste back over."
            : "Drag a card (or a face-up run) onto a pile — or click it, then click where it should go. A face-down card flips by itself when the card above it leaves."}
      </p>
    </div>
  );
}
