// src/lib/solitaire-duel/interactions.ts
//
// The client's click-to-select / click-to-place model, as PURE functions.
//
// Klondike's board is a set of slots (stock, waste, four foundations, seven
// tableau columns) and a card is moved by naming WHERE IT CAME FROM and WHERE
// IT WENT. That is exactly the shape of the server's `SolitaireMove`, so this
// module's whole job is to turn two slot clicks into one move — and to refuse
// the pairs that are not legal Klondike.
//
// ── WHY THE ENGINE IS REUSED RATHER THAN REIMPLEMENTED ─────────────────
//
// The candidate moves below are all built and then checked with the SAME
// `validateMove` the server applies (`./rules.ts`). There is deliberately no
// second ruleset here: `boardForValidation` reconstructs a validation-only
// board from the viewer's projected `SolitaireView` so the engine can run
// client-side. That is what makes "a move the UI offers is a move the server
// accepts" a structural property instead of a hope, and it is why a
// highlighted target can never be a 422.
//
// ── WHAT THIS MODULE IS NOT ────────────────────────────────────────────
//
// It decides NOTHING competitive. It does not compute progress, completion,
// a winner, a score or a rating — those all arrive in the server's snapshot.
// A move returned here is a REQUEST; the server re-validates it against its own
// board and is free to refuse it (stale ply, the clock, an already-finished
// seat). The client never applies it to its own view.

import {
  KING,
  SUITS,
  TABLEAU_COLUMNS,
  VARIANT,
  VARIANT_VERSION,
} from "./constants";
import {
  canPlaceOnTableau,
  failureOf,
  foundationExpects,
  isRedSuit,
  validateMove,
} from "./rules";
import type {
  Card,
  SolitaireMove,
  SolitaireState,
  SolitaireView,
  Suit,
} from "./types";

// ── Slots ─────────────────────────────────────────────────────────────────

/**
 * Every clickable place on the board.
 *
 * `tableau` names the run head BY IDENTITY, exactly like the move vocabulary: a
 * face-down position has no identity in a client's view, so it cannot be
 * addressed, and a card that is not in the view simply cannot be clicked.
 */
export type BoardTarget =
  | { kind: "stock" }
  | { kind: "waste" }
  | { kind: "foundation"; suit: Suit }
  /** The column SLOT (an empty space, or the column's top card as a place). */
  | { kind: "column"; column: number }
  /** One specific face-up card inside a column — the run head. */
  | { kind: "tableau"; column: number; card: Card };

/** A slot a held selection can be laid onto. */
export type DropTarget =
  | { kind: "foundation"; suit: Suit }
  | { kind: "column"; column: number };

/** What the player is currently holding. */
export type BoardSelection =
  | { kind: "waste" }
  | { kind: "foundation"; suit: Suit }
  | { kind: "tableau"; column: number; card: Card; run: Card[] };

export type ClickResult =
  | { type: "select"; selection: BoardSelection }
  | { type: "clear" }
  | { type: "move"; move: SolitaireMove }
  | { type: "invalid"; message: string }
  | { type: "none" };

// ── Reading the projected view ────────────────────────────────────────────

/**
 * A validation-only board built from the viewer's projected view.
 *
 * LOUD WARNING — this object is ONLY ever handed to the engine's validators
 * (`validateMove`, `foundationExpects`). Two of its fields are reconstructed
 * rather than known:
 *
 *   * `stock` holds `stockCount` placeholder cards, because a client is never
 *     told the stock's identities or its order. Only `stock.length` is ever
 *     read by a validator, and nothing here is ever drawn on screen.
 *   * `peakFoundation` is 0 — it is a settlement metric, not a validation one.
 *
 * It must NEVER be passed to `applyMove` (it would move a placeholder card),
 * to `progressOf` (progress is the server's number) or to anything that
 * persists. The client's board is rendered from `SolitaireView` directly.
 */
export function boardForValidation(view: SolitaireView): SolitaireState {
  const stockCount = Math.max(0, Math.trunc(Number(view?.stockCount) || 0));
  return {
    variant: VARIANT,
    variantVersion: VARIANT_VERSION,
    tableau: view?.tableau ?? [],
    stock: Array.from({ length: stockCount }, () => ({ suit: "spades" as Suit, rank: 1 as Card["rank"] })),
    waste: view?.waste ?? [],
    foundations: view?.foundations ?? { spades: [], hearts: [], diamonds: [], clubs: [] },
    ply: Number(view?.ply) || 0,
    peakFoundation: 0,
    completed: Boolean(view?.completed),
    completedAtMs: null,
  };
}

/** True when the server's own rule authority would accept this move. */
export function isLegalMove(view: SolitaireView, move: SolitaireMove): boolean {
  return failureOf(validateMove({ state: boardForValidation(view), move })) === null;
}

/** The waste's top card, or null. Only the top card of the waste is movable. */
export function wasteTopCard(view: SolitaireView): Card | null {
  const waste = view?.waste ?? [];
  return waste.length > 0 ? waste[waste.length - 1] : null;
}

/** The foundation's top card, or null. */
export function foundationTopCard(view: SolitaireView, suit: Suit): Card | null {
  const pile = view?.foundations?.[suit] ?? [];
  return pile.length > 0 ? pile[pile.length - 1] : null;
}

/** The top card of a tableau column, or null when it is empty/not playable. */
export function columnTopCard(view: SolitaireView, column: number): Card | null {
  const col = view?.tableau?.[column];
  if (!col || col.length === 0) return null;
  const top = col[col.length - 1];
  return top.faceUp && top.card ? top.card : null;
}

/** True while the stock can be drawn from (or the waste recycled). */
export function canDraw(view: SolitaireView): boolean {
  if (!view) return false;
  return view.stockCount > 0 || (view.waste?.length ?? 0) > 0;
}

/**
 * Whether `card` may be laid on a column.
 *
 * Mirrors the engine exactly on the one point that is easy to get wrong: a
 * column whose TOP card is still face-down is NOT an empty column — it is not
 * playable at all.
 */
export function canDropOnColumn(view: SolitaireView, column: number, card: Card): boolean {
  const col = view?.tableau?.[column];
  if (!col) return false;
  if (col.length === 0) return card.rank === KING;
  const top = col[col.length - 1];
  if (!top.faceUp || !top.card) return false;
  return canPlaceOnTableau(card, top.card);
}

/** Whether `card` may go on the foundation of `suit`. */
export function canDropOnFoundation(view: SolitaireView, suit: Suit, card: Card): boolean {
  if (card.suit !== suit) return false;
  return card.rank === foundationExpects(boardForValidation(view), suit);
}

// ── Selecting ─────────────────────────────────────────────────────────────

/**
 * The run a click on `column`'s face-up `card` would pick up.
 *
 * Returns null when that card is not a legal run head (not face-up, or the
 * cards below it are not a descending alternating-colour sequence) — the same
 * predicate the server uses, so a run head that cannot be lifted is simply not
 * selectable here.
 */
export function movableRun(view: SolitaireView, column: number, card: Card): Card[] | null {
  const col = view?.tableau?.[column];
  if (!col) return null;
  const index = col.findIndex((pile) => pile.faceUp && pile.card && same(pile.card, card));
  if (index < 0) return null;

  const run: Card[] = [];
  for (let i = index; i < col.length; i += 1) {
    const pile = col[i];
    if (!pile.faceUp || !pile.card) return null;
    const previous = run[run.length - 1];
    if (previous) {
      const descends = previous.rank === pile.card.rank + 1;
      const alternates = isRedSuit(previous.suit) !== isRedSuit(pile.card.suit);
      if (!descends || !alternates) return null;
    }
    run.push(pile.card);
  }
  return run;
}

function same(a: Card | null | undefined, b: Card | null | undefined): boolean {
  return Boolean(a) && Boolean(b) && a!.suit === b!.suit && a!.rank === b!.rank;
}

/** Turn a clicked slot into a selection, or null when there is nothing to hold. */
export function selectionFor(view: SolitaireView, target: BoardTarget): BoardSelection | null {
  if (!view || !target) return null;
  if (target.kind === "waste") {
    return wasteTopCard(view) ? { kind: "waste" } : null;
  }
  if (target.kind === "foundation") {
    const card = foundationTopCard(view, target.suit);
    return card ? { kind: "foundation", suit: target.suit } : null;
  }
  if (target.kind === "tableau") {
    const run = movableRun(view, target.column, target.card);
    return run ? { kind: "tableau", column: target.column, card: target.card, run } : null;
  }
  return null;
}

// ── Building the move ─────────────────────────────────────────────────────

/**
 * The move that would lay `selection` onto `target`, or null.
 *
 * Four of Klondike's six move kinds are produced here:
 *   waste → foundation, waste → tableau, tableau → foundation (the column's top
 *   card only — the engine refuses a card with others on top of it),
 *   tableau → tableau (a whole face-up run), foundation → tableau.
 * A card is never moved from one foundation to another: the vocabulary has no
 * such move, and the engine would not accept one.
 */
export function moveForTarget(
  view: SolitaireView,
  selection: BoardSelection | null,
  target: DropTarget,
): SolitaireMove | null {
  if (!view || !selection || !target) return null;

  if (selection.kind === "waste") {
    const card = wasteTopCard(view);
    if (!card) return null;
    if (target.kind === "foundation") {
      return canDropOnFoundation(view, target.suit, card)
        ? { kind: "waste-to-foundation", suit: target.suit }
        : null;
    }
    return canDropOnColumn(view, target.column, card)
      ? { kind: "waste-to-tableau", toColumn: target.column }
      : null;
  }

  if (selection.kind === "foundation") {
    const card = foundationTopCard(view, selection.suit);
    if (!card || target.kind !== "column") return null;
    return canDropOnColumn(view, target.column, card)
      ? { kind: "foundation-to-tableau", suit: selection.suit, toColumn: target.column }
      : null;
  }

  const run = movableRun(view, selection.column, selection.card);
  if (!run || run.length === 0) return null;
  const head = run[0];

  if (target.kind === "foundation") {
    // Only the column's top card can be lifted out of a column.
    const top = columnTopCard(view, selection.column);
    if (!top || !same(top, head)) return null;
    return canDropOnFoundation(view, target.suit, head)
      ? { kind: "tableau-to-foundation", fromColumn: selection.column, card: head, suit: target.suit }
      : null;
  }

  if (target.column === selection.column) return null;
  return canDropOnColumn(view, target.column, head)
    ? { kind: "tableau-to-tableau", fromColumn: selection.column, card: head, toColumn: target.column }
    : null;
}

/** Every legal move available FROM `selection` — used to highlight targets. */
export function movesForSelection(
  view: SolitaireView,
  selection: BoardSelection | null,
): SolitaireMove[] {
  if (!view || !selection) return [];

  const moves: SolitaireMove[] = [];
  for (let column = 0; column < TABLEAU_COLUMNS; column += 1) {
    const move = moveForTarget(view, selection, { kind: "column", column });
    if (move) moves.push(move);
  }
  for (const suit of SUITS) {
    const move = moveForTarget(view, selection, { kind: "foundation", suit });
    if (move) moves.push(move);
  }
  return moves.filter((move) => isLegalMove(view, move));
}

/**
 * The slots a held selection can legally be laid on, for highlighting.
 *
 * Derived from the same validated candidates, so a lit target is always an
 * accepted move.
 */
export function dropTargetsFor(
  view: SolitaireView,
  selection: BoardSelection | null,
): { columns: number[]; suits: Suit[] } {
  const moves = movesForSelection(view, selection);
  const columns: number[] = [];
  const suits: Suit[] = [];
  for (const move of moves) {
    if (move.kind === "waste-to-tableau" || move.kind === "tableau-to-tableau" || move.kind === "foundation-to-tableau") {
      if (!columns.includes(move.toColumn)) columns.push(move.toColumn);
    }
    if (move.kind === "waste-to-foundation") suits.push(move.suit);
    if (move.kind === "tableau-to-foundation") suits.push(move.suit);
  }
  return { columns, suits };
}

// ── The click ─────────────────────────────────────────────────────────────

/** A short, unobtrusive reason for a refused click. */
function refusalFor(target: BoardTarget): string {
  if (target.kind === "column") return "That run cannot be placed there";
  if (target.kind === "foundation") return "That foundation cannot take that card";
  return "That card cannot move there";
}

/**
 * Resolve one click against the current board and the held selection.
 *
 * The whole interaction model, in one pure function (so it is testable without
 * a browser): a held card is laid on a legal slot, otherwise the clicked slot
 * becomes the new selection, otherwise the click is refused with a reason. A
 * move is only ever PROPOSED — the caller sends it and waits for the server.
 */
export function resolveClick(
  view: SolitaireView,
  selection: BoardSelection | null,
  target: BoardTarget,
): ClickResult {
  if (!view || !target) return { type: "none" };

  if (target.kind === "stock") {
    // Drawing is a move in its own right, not a selection. When the stock is
    // exhausted the engine recycles the waste, so the same move covers both.
    if (!canDraw(view)) return { type: "invalid", message: "The stock and waste are both empty" };
    return { type: "move", move: { kind: "draw" } };
  }

  // Clicking the held card again puts it back down.
  if (selection && sameTarget(selection, target)) return { type: "clear" };

  if (selection && (target.kind === "column" || target.kind === "foundation")) {
    const move = moveForTarget(view, selection, target);
    if (move) {
      return isLegalMove(view, move) ? { type: "move", move } : { type: "invalid", message: refusalFor(target) };
    }
  }

  const next = selectionFor(view, target);
  if (next) return { type: "select", selection: next };

  // Nothing to hold and nothing to lay down: only worth reporting when the
  // slot looked actionable in the first place.
  if (selection && (target.kind === "column" || target.kind === "foundation")) {
    return { type: "invalid", message: refusalFor(target) };
  }
  return { type: "none" };
}

function sameTarget(selection: BoardSelection, target: BoardTarget): boolean {
  if (selection.kind === "waste") return target.kind === "waste";
  if (selection.kind === "foundation") {
    return target.kind === "foundation" && target.suit === selection.suit;
  }
  return (
    target.kind === "tableau" &&
    target.column === selection.column &&
    same(target.card, selection.card)
  );
}
