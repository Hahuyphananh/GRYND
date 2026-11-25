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
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { useReducedMotion } from "framer-motion";
import { IconArrowsMaximize, IconArrowsMinimize } from "@tabler/icons-react";

import PlayingCard, { cardLabel, suitGlyph } from "./PlayingCard";
import {
  EMPTY_CARD_ANIMATION_PLAN,
  detectCardAnimations,
  tableauSlotKey,
} from "../../lib/solitaire-duel/cardAnimations";
import { playCardPlace } from "../../lib/gameAudio";
import BoardAppearanceDrawer from "../solitaire/BoardAppearanceDrawer";
import { useTranslation } from "../../hooks/useTranslation";
import { useSolitaireBoardTheme } from "../../hooks/useSolitaireBoardTheme";
import { useSolitaireBoardCosmetics } from "../../hooks/useSolitaireBoardCosmetics";
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
 * The felt's floor: the height of a full table, in card widths.
 *
 * Once the last card reaches a foundation the tableau is empty, so the board's
 * content is only the top row. Without a floor the felt collapses under the
 * finish animation (and again when the animation unmounts and the victory panel
 * takes over), pulling the page and the foundations around. This minimum is
 * derived from the same geometry as the height budget, so it scales with the
 * card clamp on every viewport. There is deliberately NO maximum: the felt may
 * still grow past the floor with its content.
 */
const MIN_BOARD_HEIGHT = `calc(var(--cw) * ${BOARD_CW})`;

/**
 * Everything stacked ABOVE the tableau, in rem: the page's top padding, the
 * navigation bar, the header block, the two progress meters and the board's own
 * bordered frame. This is what the height term has to leave room for — the
 * status line, race facts and legend below the tableau are allowed to sit under
 * the fold, because the ask is that the CARDS are visible without scrolling.
 */
const CHROME_REM = "17rem";

/**
 * The board's own footer row, in rem: the legend, the appearance trigger and
 * the full-screen toggle. It is part of the felt, not of the page chrome above
 * it, so the viewport-height floor below has to leave room for it too.
 */
const FOOTER_REM = "3rem";

/**
 * `--cw` on a normal page: as wide as seven columns fit, and never taller than
 * the room left under the page chrome. The width term used to be flat `10.4vw`,
 * which left a phone's cards at ~40px with ~48px of width unused; deriving it
 * from the viewport minus the page/board padding and the six column gaps lets a
 * phone use that width, so the board fills the screen instead of floating in
 * the middle of it.
 */
const BOARD_CARD_SIZE = `clamp(34px, min(calc((100vw - 4.5rem) / 7), calc((100dvh - ${CHROME_REM}) / ${BOARD_CW})), 92px)`;

/**
 * `--cw` while the board owns the screen. Same fit arithmetic, measured against
 * the whole viewport (the page chrome is gone) minus the board's own padding
 * and footer. The 160px ceiling is for tablets and desktops, where full screen
 * still should not produce card-house-sized cards.
 */
const FULLSCREEN_CARD_SIZE = `clamp(34px, min(calc((100vw - 3rem) / 7), calc((100dvh - 4.5rem) / ${BOARD_CW})), 160px)`;

/**
 * `--cw` in a LANDSCAPE full screen, where the top row moves to a side panel.
 *
 * Seven tableau columns plus a two-card panel need nine card-widths, and the
 * tallest column is 5.62 card-widths tall — no foundations row on top of it —
 * so the cards can grow past the portrait cap instead of leaving most of a
 * landscape phone as empty felt. The terms include the root padding, the six
 * column gaps, the panel gap and the panel's own inter-card gap.
 */
const FULLSCREEN_LANDSCAPE_CARD_SIZE = `clamp(34px, min(calc((100vw - 5.5rem) / 9), calc((100dvh - 2.5rem) / 6)), 160px)`;

/**
 * The felt's floor: a full table, and on a phone the rest of the viewport under
 * the page chrome — so the normal (non-full-screen) board almost fills the
 * screen vertically instead of ending just under the top row.
 */
const BOARD_MIN_HEIGHT = `max(${MIN_BOARD_HEIGHT}, calc(100dvh - ${CHROME_REM} - ${FOOTER_REM}))`;

/**
 * The orientation lock is real on Android Chrome but absent from the DOM
types (and from iOS Safari entirely), so it is reached through this narrow,
 * fully optional surface instead of a cast at every call site.
 */
type OrientationLockApi = {
  lock?: (orientation: "landscape") => Promise<void>;
  unlock?: () => void;
};

function orientationApi(): OrientationLockApi | null {
  if (typeof screen === "undefined") return null;
  return (screen.orientation as unknown as OrientationLockApi | undefined) ?? null;
}

export type SolitaireBoardProps = {
  view: SolitaireView | null;
  /** False before GO, once the clock expires, and once a result has landed. */
  interactive: boolean;
  /**
   * Keep the board this tall while the auto-finish cards fly.
   *
   * The finished board has an empty tableau, so it is much shorter than the
   * board the player just finished on. Letting it collapse mid-animation shrinks
   * the page, clamps the scroll and drags the foundations out from under the
   * cards. Holding the measured height keeps the table still until the flight
   * (and the victory panel) is done.
   */
  holdHeight?: number;

  /**
   * Game Review: draw the authoritative position with no play affordance and
   * a review-specific legend. Interaction is already off via `interactive`;
   * this only changes what the table SAYS.
   */
  readOnly?: boolean;

  /**
   * Game Review: animate the card change for THIS commit only.
   *
   * The review page sets this for a single forward step. A timeline jump,
   * Home/End, a rewind or the initial paint leaves it false, so the destination
   * board appears immediately instead of replaying every intermediate move.
   * Ignored outside `readOnly` (normal play already animates accepted moves).
   */
  reviewAnimate?: boolean;

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

// ── Card animation budget ────────────────────────────────────────────────
// These durations are shared with the keyframes in globals.css. They are
// deliberately short: a fast player must never wait for a card to finish
// turning before the next move is accepted, and the animation is purely
// visual (the move is already submitted against the authoritative view).
const REVEAL_MS = 300;
const DRAW_MS = 340;
const REDEAL_MS = 300;
/** Per-card delay for the fly-back, so the stock refills as a riffle, not a slab. */
const REDEAL_STAGGER_MS = 26;
/** At most this many ghosts: the stock is capped at 24 cards in Klondike. */
const REDEAL_MAX_GHOSTS = 12;

/** The one waste card that is travelling from the stock, in viewport offsets. */
type DrawAnimation = { cardKey: string; x: number; y: number };

/** A card-sized, identity-free back flying from the waste to the stock. */
type RedealGhost = {
  key: number;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  width: number;
  height: number;
  delayMs: number;
};

/** A measured card, in viewport coordinates. */
type CardRect = { x: number; y: number; width: number; height: number };


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
        <span className="mt-0.5 text-[11px] font-bold uppercase tracking-wider">{hint}</span>
      )}
    </button>
  );
}

export default function SolitaireBoard({
  view,
  interactive,
  holdHeight,
  readOnly = false,
  reviewAnimate = false,
  onMove,
  onInvalid,
}: SolitaireBoardProps) {
  // Review-only chrome is localized with the rest of the review page. Gameplay
  // keeps its existing copy untouched.
  const { t } = useTranslation();
  // The table this board is played on. Every mode renders THIS component, so
  // reading the shared theme here is what keeps solo, daily, practice and
  // ranked identical; nothing is passed down per route.
  const { theme } = useSolitaireBoardTheme();
  // The card backs and deck skin are site-wide cosmetics, read from the same
  // local-first store the appearance drawer writes. Painting them from custom
  // properties on the board root is what repaints 52 cards in place.
  const { cardBack, deckSkin } = useSolitaireBoardCosmetics();
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


  const [dragGhost, setDragGhost] = useState<DragGhost | null>(null);
  // Full screen: `fullscreen` tracks the browser's real full-screen element
  // (the board itself); `pseudoFullscreen` is the fixed-layer fallback iOS
  // needs. `immersive` is the single flag the layout and the toggle read.
  const [fullscreen, setFullscreen] = useState(false);
  const [pseudoFullscreen, setPseudoFullscreen] = useState(false);
  // The landscape full-screen layout (top row as a side panel) is only correct
  // while the display is actually wider than it is tall.
  const [landscape, setLandscape] = useState(false);
  const immersive = fullscreen || pseudoFullscreen;
  const landscapeBoard = immersive && landscape;

  const board = view ?? null;
  const ply = board?.ply ?? 0;

  // ── Card animation state (presentation only) ─────────────────────────
  // The previous authoritative snapshot is what a reveal/draw/redeal is
  // detected against; it is never rendered. Keeping it in a ref means a
  // re-render with the SAME board cannot re-run an animation.
  const reduceMotion = useReducedMotion();
  const previousViewRef = useRef<SolitaireView | null>(null);
  const wasteRectsRef = useRef<CardRect[]>([]);
  const [drawAnim, setDrawAnim] = useState<DrawAnimation | null>(null);
  const [redealGhosts, setRedealGhosts] = useState<RedealGhost[] | null>(null);

  const animationPlan = useMemo(() => {
    // A review position loads without replaying its history by default. Only
    // the explicit single-step opt-in animates the change from the previous
    // position; reduced motion always shows the final card immediately.
    if (!board || reduceMotion) return EMPTY_CARD_ANIMATION_PLAN;
    if (readOnly && !reviewAnimate) return EMPTY_CARD_ANIMATION_PLAN;
    return detectCardAnimations(previousViewRef.current, board);
  }, [board, readOnly, reviewAnimate, reduceMotion]);

  const revealSlots = useMemo(
    () => new Set(animationPlan.reveals.map((reveal) => reveal.key)),
    [animationPlan],
  );

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
      if (swallowTimerRef.current !== null) clearTimeout(swallowTimerRef.current);
    },
    [],
  );

  // Remember the snapshot the NEXT one will be compared against. This is a
  // passive effect: the layout effect below has already read the old value.
  useEffect(() => {
    previousViewRef.current = board;
  }, [board]);

  /**
   * Measure AFTER the new view is painted into the DOM, BEFORE the browser
   * paints it: the drawn card starts on the stock slot rather than flashing in
   * its final waste position, and a redeal flies its backs home from where the
   * waste cards were one commit ago. The move itself is already in flight —
   * measuring costs no interaction latency.
   */
  useLayoutEffect(() => {
    const el = boardRef.current;
    if (!el) return;

    if (animationPlan.draw) {
      const stock = el.querySelector<HTMLElement>('[data-testid="solitaire-stock"]');
      const wasteTop = el.querySelector<HTMLElement>('[data-testid="solitaire-waste-top"]');
      if (stock && wasteTop) {
        const from = stock.getBoundingClientRect();
        const to = wasteTop.getBoundingClientRect();
        setDrawAnim({
          cardKey: animationPlan.draw.cardKey,
          x: from.left + from.width / 2 - (to.left + to.width / 2),
          y: from.top + from.height / 2 - (to.top + to.height / 2),
        });
      }
    }

    if (animationPlan.redeal) {
      const stock = el.querySelector<HTMLElement>('[data-testid="solitaire-stock"]');
      const previousWaste = wasteRectsRef.current;
      if (stock && previousWaste.length > 0) {
        const to = stock.getBoundingClientRect();
        const toX = to.left + to.width / 2;
        const toY = to.top + to.height / 2;
        setRedealGhosts(
          previousWaste.slice(-REDEAL_MAX_GHOSTS).map((rect, index) => ({
            key: index,
            fromX: rect.x,
            fromY: rect.y,
            toX,
            toY,
            width: rect.width,
            height: rect.height,
            delayMs: index * REDEAL_STAGGER_MS,
          })),
        );
      }
    }

    // Stored for the NEXT redeal: where the waste cards are right now.
    wasteRectsRef.current = Array.from(
      el.querySelectorAll<HTMLElement>('[data-testid="solitaire-waste"] [data-face-up]'),
    ).map((node) => {
      const rect = node.getBoundingClientRect();
      return {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        width: rect.width,
        height: rect.height,
      };
    });
  }, [board, animationPlan]);

  // Let the one-shot animations expire. The cards are already painted at their
  // authoritative positions when these fire; only the visual offset is gone.
  useEffect(() => {
    if (!drawAnim) return undefined;
    const timer = setTimeout(() => setDrawAnim(null), DRAW_MS + 40);
    return () => clearTimeout(timer);
  }, [drawAnim]);

  useEffect(() => {
    if (!redealGhosts) return undefined;
    const last = redealGhosts[redealGhosts.length - 1];
    const timer = setTimeout(
      () => setRedealGhosts(null),
      REDEAL_MS + (last?.delayMs ?? 0) + 60,
    );
    return () => clearTimeout(timer);
  }, [redealGhosts]);

  /** Ignore the click this gesture is about to produce. */
  const swallowNextClick = useCallback(() => {
    swallowClickRef.current = true;
    if (swallowTimerRef.current !== null) clearTimeout(swallowTimerRef.current);
    swallowTimerRef.current = setTimeout(() => {
      swallowTimerRef.current = null;
      swallowClickRef.current = false;
    }, CLICK_SWALLOW_MS);
  }, []);

  // A move in flight never locks the board. The parent draws the player's own
  // move optimistically, so the next gesture is made against the board the
  // player can already see; the server's snapshot replaces it when it lands.
  const cardsInteractive = interactive;
  const stockInteractive = interactive && canDraw(board);

  const targets = useMemo(() => dropTargetsFor(board, selection), [board, selection]);

  /**
   * One quiet placement cue when a card actually lands on a pile.
   *
   * Presentation only, so it hangs off the same three accepted-move seams as
   * the drag/click handling and never off a merely proposed move. The global
   * mute switch silences it centrally (the shared AudioContext returns null),
   * and reduced motion silences the board's sound along with its animations.
   * A draw is a different gesture and is deliberately not a "placement".
   */
  const announceMove = useCallback(
    (move: SolitaireMove) => {
      if (reduceMotion) return;
      if (move.kind !== "draw") playCardPlace();
    },
    [reduceMotion],
  );

  /**
   * An accepted drop is sent the moment it is released. There is deliberately no
   * settle timer in front of the move: the parent draws it optimistically, so
   * the ghost is cleared in the same commit and the card is already on the pile
   * — waiting for a snap animation would only add latency to the click.
   */
  const settleDrop = useCallback(
    (move: SolitaireMove) => {
      announceMove(move);
      setDragGhost(null);
      onMove(move);
    },
    [onMove, announceMove],
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
        announceMove(result.move);
        setSelection(null);
        onMove(result.move);
        return;
      }
      if (result.type === "invalid") {
        setSelection(null);
        onInvalid?.(result.message);
      }
    },
    [board, selection, onMove, onInvalid, announceMove],
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

      // A new gesture cancels a card still flying home from the last one.
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
      // click it goes on to produce is swallowed (see `swallowNextClick`).
      if (board) {
        const decision = resolveClick(board, selection, found.target);
        if (decision.type === "select" || decision.type === "clear") {
          swallowNextClick();
          setSelection(decision.type === "select" ? decision.selection : null);
        } else if (decision.type === "move") {
          // The pile has taken the card: no drag is started from this press,
          // because the move already owns the gesture.
          announceMove(decision.move);
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
    [cardsInteractive, pressAtPointer, board, selection, swallowNextClick, onMove, announceMove],
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
        settleDrop(move);
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

  // A board that fits is the normal case, and `touch-none` on the cards is
  // what makes the drag reliable there. A board that does NOT fit (a very
  // short viewport, or the player's text scaled up) would otherwise trap the
  // page scroll behind the cards, so in that case they yield the vertical
  // gesture and tap-to-move — the equal path — takes over. The 32px slack
  // stops a collapsing browser toolbar from flipping the mode mid-game.
  const [touchScroll, setTouchScroll] = useState(false);
  useEffect(() => {
    const measure = () => {
      const el = boardRef.current;
      if (!el) return;
      setTouchScroll(el.getBoundingClientRect().bottom > window.innerHeight + 32);
    };
    measure();
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    if (observer && boardRef.current) observer.observe(boardRef.current);
    window.addEventListener("resize", measure);
    window.addEventListener("orientationchange", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("orientationchange", measure);
    };
  }, []);

  /**
   * Abandon an in-flight drag when the surface under it changes.
   *
   * `pointercancel` is the normal ending, but it is NOT guaranteed here. The
   * Android activity declares `configChanges` for orientation/screenSize
   * (android/app/src/main/AndroidManifest.xml), so a rotation RESIZES this
   * WebView instead of recreating it — the DOM keeps its pointer bookkeeping
   * and no cancel event has to arrive. Backgrounding the app, losing window
   * focus, or a display resize can strand a captured pointer the same way.
   *
   * Without this, the lifted card's ghost (and the held selection) can stay
   * frozen on screen until the player's next press. The abort is deliberately
   * silent: the board stays on its last AUTHORITATIVE position, no move is
   * proposed, nothing is sent to the server, and no forfeit or rollback is
   * implied. The ghost is removed rather than flown home because its origin
   * was captured in the OLD viewport coordinates, which the rotation just
   * invalidated — animating to them would fly the card to the wrong place.
   */
  useEffect(() => {
    const abort = () => {
      const session = dragRef.current;
      if (!session) return;
      dragRef.current = null;
      try {
        // A press that never crossed the threshold captured nothing.
        boardRef.current?.releasePointerCapture(session.pointerId);
      } catch {
        // Already released, or never captured.
      }
      // A drag already decided this gesture; its synthetic click must not.
      if (session.active) swallowNextClick();
      setSelection(null);
      setDragGhost(null);
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") abort();
    };

    window.addEventListener("orientationchange", abort);
    window.addEventListener("resize", abort);
    window.addEventListener("blur", abort);
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      window.removeEventListener("orientationchange", abort);
      window.removeEventListener("resize", abort);
      window.removeEventListener("blur", abort);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [swallowNextClick]);

  // ── Full screen ──────────────────────────────────────────────────────
  //
  // The toggle puts the board — and only the board — on the whole display and
  // asks the platform for landscape, which is the orientation seven columns
  // want. Android and desktop honour both; iOS Safari allows neither for a
  // div, so the board falls back to a fixed viewport-filling layer and shows a
  // turn-the-phone hint. The same button leaves full screen again.
  useEffect(() => {
    const onChange = () => {
      const active = document.fullscreenElement === boardRef.current;
      setFullscreen(active);
      if (active) return;
      setPseudoFullscreen(false);
      try {
        orientationApi()?.unlock?.();
      } catch {
        // No orientation API on this browser: nothing to unlock.
      }
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  // The fallback layer covers the page, so the page underneath must not scroll.
  // Escape leaves it, exactly as it leaves a real full-screen element.
  useEffect(() => {
    if (!pseudoFullscreen) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPseudoFullscreen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [pseudoFullscreen]);

  useEffect(() => {
    const query = window.matchMedia("(orientation: landscape)");
    const update = () => setLandscape(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  const toggleFullscreen = useCallback(async () => {
    const element = boardRef.current;
    if (!element) return;

    if (immersive) {
      try {
        if (document.fullscreenElement) await document.exitFullscreen();
      } catch {
        // The browser had already left full screen.
      }
      setFullscreen(false);
      setPseudoFullscreen(false);
      try {
        orientationApi()?.unlock?.();
      } catch {
        // No orientation API on this browser: nothing to unlock.
      }
      return;
    }

    let entered = false;
    try {
      if (typeof element.requestFullscreen === "function") {
        await element.requestFullscreen({ navigationUI: "hide" });
        entered = true;
      }
    } catch {
      entered = false;
    }
    // The fallback is the same screen for a browser that refuses the API.
    setFullscreen(entered);
    setPseudoFullscreen(!entered);

    if (entered) {
      try {
        await orientationApi()?.lock?.("landscape");
      } catch {
        // Refused (iOS, or a non-touch display): the board still plays in
        // portrait, and the hint under the controls asks for the turn.
      }
    }
  }, [immersive]);

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
      ? t("solitaireBoard.holdWaste")
      : selection.kind === "foundation"
        ? t("solitaireBoard.holdFoundation")
        : t("solitaireBoard.holdRun")
    : null;

  return (
    <div
      ref={boardRef}
      data-testid="solitaire-board"
      data-ply={board.ply}
      data-stock={stockCount}
      data-selected={selection ? selection.kind : "none"}
      data-dragging={dragGhost ? "true" : "false"}
      data-fullscreen={immersive ? "true" : "false"}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      // One variable sizes every card and every fan. Seven columns always fit
      // the WIDTH, so the width term is "seven columns in the room available"
      // (which is what makes a phone's board fill its screen) and the height
      // term caps the card by the room left under the page chrome — the board
      // is BOARD_CW card-widths tall (see the derivation above). `CHROME_REM`
      // is everything above the tableau; `FOOTER_REM` the row under it.
      //
      // In full screen the page chrome is gone, so the same fit runs against
      // the whole viewport (`FULLSCREEN_CARD_SIZE`).
      style={
        {
          "--cw": immersive
            ? landscapeBoard
              ? FULLSCREEN_LANDSCAPE_CARD_SIZE
              : FULLSCREEN_CARD_SIZE
            : BOARD_CARD_SIZE,
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
          // ── Card cosmetics (lib/solitaire-duel/boardCosmetics) ──
          "--sol-card-back-image": cardBack.background,
          "--sol-card-back-border": cardBack.border,
          "--sol-card-back-emblem": `"${cardBack.emblem}"`,
          "--sol-card-back-animation": cardBack.animation ?? "none",
          "--sol-deck-crest": `"${deckSkin.crest ?? ""}"`,
          // The felt never collapses below a full table, even after the finish
          // animation releases its measured pre-finish height. When that
          // measurement is taller, max() keeps it; there is no maximum, so the
          // board remains free to expand with its content.
          minHeight: immersive
            ? "calc(100dvh - 1rem)"
            : holdHeight && holdHeight > 0
              ? `max(${holdHeight}px, ${BOARD_MIN_HEIGHT})`
              : BOARD_MIN_HEIGHT,
          backgroundImage: theme.felt,
          // The felt's edge is an INSET ring, never a border: a border would add
          // 4px to the height the `--cw` budget above was computed against.
          boxShadow: `inset 0 0 0 2px ${theme.frame}${
            theme.frameExtra ? `, ${theme.frameExtra}` : ""
          }, 0 10px 30px rgba(3, 8, 20, 0.35)`,
        } as CSSProperties
      }
      data-solitaire-theme={theme.key}
      data-card-back={cardBack.key}
      data-deck={deckSkin.key}
      className={`flex w-full touch-manipulation select-none flex-col ${
        immersive
          ? "fixed inset-0 z-[100] overflow-y-auto rounded-none p-2"
          : "rounded-2xl"
      }`}
    >
      {/* In full screen the felt fills the display but the CARDS never do:
          seven columns are as wide as seven cards. Centring a card-width
          column keeps the tableau from stretching across a landscape phone. */}
      <div
        className="mx-auto w-full"
        style={
          landscapeBoard
            ? {
                display: "flex",
                alignItems: "flex-start",
                justifyContent: "center",
                gap: "1rem",
                maxWidth: "none",
              }
            : immersive
              ? { maxWidth: "calc(var(--cw) * 7 + 3rem)" }
              : undefined
        }
      >
      {/* ── Top row: stock · waste · the four foundations ──────────────── */}
      <div
        className="flex items-start gap-1 sm:gap-2"
        style={
          landscapeBoard
            ? {
                // Landscape full screen: this row becomes the right-hand
                // panel, two cards wide, so the tableau owns the full height.
                order: 2,
                width: "calc(var(--cw) * 2 + 0.5rem)",
                flexWrap: "wrap",
                alignContent: "flex-start",
              }
            : undefined
        }
      >
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
            className={`gr-focusable relative flex select-none items-center justify-center overflow-hidden rounded-[6px] border-2 border-[color:var(--gr-outline)] bg-linear-to-br from-panel via-panel to-panel shadow-[0_1px_2px_rgba(3,8,20,0.55)] transition ${
              stockInteractive ? "cursor-pointer hover:brightness-125" : "cursor-default"
            }`}
          >
            <span
              aria-hidden="true"
              className="h-[62%] w-[62%] rounded-[4px] border border-[color:var(--gr-hairline)] bg-[repeating-linear-gradient(45deg,rgba(0,229,255,0.16)_0_3px,transparent_3px_6px)]"
            />
            <span className="absolute bottom-0.5 right-1 text-[11px] font-black text-white/80">
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
                  touchScroll={touchScroll}
                  selected={Boolean(isHeld)}
                  label={
                    isTop
                      ? `${cardLabel(card)} — the top of the waste, click to pick it up`
                      : cardLabel(card)
                  }
                  testId={isTop ? "solitaire-waste-top" : undefined}
                  drawFrom={
                    isTop && drawAnim?.cardKey === `${card.suit}-${card.rank}`
                      ? { x: drawAnim.x, y: drawAnim.y }
                      : null
                  }
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
            collapses to a gap on narrow ones. In the landscape panel it has no
            job — the panel's own width does the placing. */}
        <div
          aria-hidden="true"
          className="min-w-1 flex-1"
          style={landscapeBoard ? { display: "none" } : undefined}
        />

        <div
          className="flex items-start gap-1 sm:gap-2"
          style={landscapeBoard ? { width: "100%", flexWrap: "wrap" } : undefined}
        >
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
                  touchScroll={touchScroll}
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
      <div
        className="mt-2 grid grid-cols-7 gap-1 sm:mt-3 sm:gap-2"
        style={landscapeBoard ? { order: 1, marginTop: 0, flex: "0 0 auto" } : undefined}
      >
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
                    // STABLE SLOT key: a revealed card keeps its element, so it
                    // can flip in place instead of remounting as a new face.
                    key={`slot-${column}-${index}`}
                    card={card}
                    faceUp={faceUp}
                    interactive={clickable}
                    touchScroll={touchScroll}
                    selected={Boolean(isHeld)}
                    highlighted={isTop && dropsHere}
                    label={
                      faceUp && slot.card
                        ? `${cardLabel(slot.card)} — column ${column + 1}, position ${index + 1}`
                        : `Face-down card — column ${column + 1}, position ${index + 1}`
                    }
                    testId={`solitaire-card-${column}-${index}`}
                    reveal={revealSlots.has(tableauSlotKey(column, index))}
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
      </div>

      {/* The card(s) under the pointer while dragging. pointer-events-none, so
          the ghost can never shadow the drop slot `elementFromPoint` finds. It
          snaps onto the slot a card would land on, settles there before an
          accepted move is sent, and eases home when the drop is refused; all
          three are transitions, so the board's layout and its `--cw` fit are
          never touched by a gesture. */}
      {/* Redeal: identity-free card backs fly from where the waste was back
          onto the stock, staggered so the pile refills as a riffle rather than
          one block. The authoritative stock/waste are already correct; this is
          an overlay that unmounts itself. */}
      {redealGhosts?.map((ghost) => (
        <div
          key={ghost.key}
          aria-hidden="true"
          data-testid="solitaire-redeal-ghost"
          className="pointer-events-none fixed z-40 drop-shadow-xl"
          style={
            {
              left: ghost.toX - ghost.width / 2,
              top: ghost.toY - ghost.height / 2,
              width: ghost.width,
              height: ghost.height,
              "--gr-redeal-x": `${ghost.fromX - ghost.toX}px`,
              "--gr-redeal-y": `${ghost.fromY - ghost.toY}px`,
              animation: `gr-card-redeal ${REDEAL_MS}ms cubic-bezier(0.2, 0.7, 0.3, 1) ${ghost.delayMs}ms both`,
            } as CSSProperties
          }
        >
          <PlayingCard card={null} faceUp={false} />
        </div>
      ))}

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
      <div
        className="mt-auto flex flex-wrap items-center justify-between gap-2 pt-2"
        style={
          landscapeBoard
            ? // In the landscape layout the felt's bottom-right corner is empty
              // felt, so the controls dock there and cost the cards no height.
              { position: "absolute", right: 8, bottom: 8, marginTop: 0, paddingTop: 0 }
            : undefined
        }
      >
      {immersive && (
        <p
          data-testid="solitaire-fullscreen-hint"
          className="hidden w-full text-center text-[11px] font-semibold text-white/55 portrait:block"
        >
          {t("solitaireBoard.rotateHint")}
        </p>
      )}
      {/* On a phone the legend takes its own line and the two controls share
          the next one — squeezed beside them it became a six-line column. */}
      <p
        className="w-full text-center text-[11px] leading-relaxed text-[color:var(--sol-legend)] sm:w-auto sm:flex-1"
        style={landscapeBoard ? { display: "none" } : undefined}
      >
        {readOnly
          ? t("solitaireReview.ui.boardNotice")
          : selection
            ? t("solitaireBoard.holding", { held: heldLabel })
            : canRedeal
              ? t("solitaireBoard.stockEmpty")
              : t("solitaireBoard.dragOrClick")}
      </p>
      {!readOnly && (
        <button
          type="button"
          onClick={toggleFullscreen}
          data-testid="solitaire-fullscreen-toggle"
          aria-pressed={immersive}
          aria-label={
            immersive ? t("solitaireBoard.exitFullscreen") : t("solitaireBoard.fullscreen")
          }
          title={
            immersive ? t("solitaireBoard.exitFullscreen") : t("solitaireBoard.fullscreen")
          }
          className="pointer-events-auto inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-white/5 px-2.5 py-1 text-[11px] font-black uppercase tracking-[0.14em] text-white/70 transition hover:bg-white/10 hover:text-white"
        >
          {immersive ? (
            <IconArrowsMinimize size={13} aria-hidden="true" />
          ) : (
            <IconArrowsMaximize size={13} aria-hidden="true" />
          )}
          {immersive
            ? t("solitaireBoard.exitFullscreenShort")
            : t("solitaireBoard.fullscreen")}
        </button>
      )}
      <BoardAppearanceDrawer label={t("solitaireBoard.appearance")} />
      </div>
    </div>
  );
}
