// src/lib/solitaire-duel/rules.ts
//
// The authoritative Solitaire Duel engine. PURE: no I/O, no clock, no
// randomness beyond the deal it is handed.
//
// Two properties matter more than anything else in this file:
//
//   1. A client may only ever say WHICH CARDS IT MEANT AND WHERE. It cannot
//      name a resulting board, a score, a progress figure, a completion or a
//      winner. `normalizeMove` shape-checks the request WITHOUT coercion (the
//      string "3" is not a column, `2.5` is not a rank, a missing field is not
//      a default), and every legality decision is then re-derived from the
//      server's own state.
//
//   2. Invalid moves never mutate anything. `applyMove` re-validates and
//      returns a rejection instead of a state, so there is no code path that
//      applies a half-checked move.
//
// The module is clock-free on purpose: `applyMove` sets `completed` from the
// board but never stamps `completedAtMs`, so the ONE authority for time remains
// the store. That is what keeps this file usable in the browser for optimistic
// rendering while the server stays the sole source of truth.

import { cardKey } from "./deck";
import {
  ACE,
  COMPLETION_DEAD_HEAT_MS,
  DECK_SIZE,
  KING,
  MAX_MOVES_PER_SEAT,
  MOVE_KINDS,
  RED_SUITS,
  RESOLUTION,
  SEAT,
  SUITS,
  TABLEAU_CARDS,
  TABLEAU_COLUMNS,
  VARIANT,
  VARIANT_VERSION,
} from "./constants";
import type {
  Card,
  FoundationPiles,
  MoveCode,
  OpponentProgress,
  PileCard,
  RaceOutcome,
  Seat,
  SeatProgress,
  SeatRace,
  Seats,
  SolitaireDeal,
  SolitaireMove,
  SolitaireState,
  SolitaireView,
  Suit,
  ViewPileCard,
} from "./types";

// ──────────────────────────────────────────────────────────────────────────
// Cards and seats
// ──────────────────────────────────────────────────────────────────────────

export function isRedSuit(suit: unknown): boolean {
  return typeof suit === "string" && (RED_SUITS as readonly string[]).includes(suit);
}

export function isSuit(value: unknown): value is Suit {
  return typeof value === "string" && (SUITS as readonly string[]).includes(value);
}

export function isRank(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= ACE && value <= KING;
}

/** A tableau column index, 0..6. No coercion: `"3"` and `2.5` are rejected. */
export function isColumnIndex(value: unknown): boolean {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value < TABLEAU_COLUMNS
  );
}

/**
 * Strict card shape check.
 *
 * Returns null rather than a coerced card, so a hostile or sloppy payload can
 * never become a card the engine will act on. Extra properties are ignored —
 * they are simply not read.
 */
export function toCard(value: unknown): Card | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as { suit?: unknown; rank?: unknown };
  if (!isSuit(raw.suit) || !isRank(raw.rank)) return null;
  return { suit: raw.suit, rank: raw.rank as Card["rank"] };
}

export function sameCard(a: Card | null | undefined, b: Card | null | undefined): boolean {
  return Boolean(a) && Boolean(b) && a!.suit === b!.suit && a!.rank === b!.rank;
}

export function normalizeSeat(value: unknown): Seat | null {
  return value === SEAT.PLAYER1 || value === SEAT.PLAYER2 ? value : null;
}

export function otherSeat(seat: Seat): Seat {
  return seat === SEAT.PLAYER1 ? SEAT.PLAYER2 : SEAT.PLAYER1;
}

export function seatForUser(seats: Seats, userId: unknown): Seat | null {
  if (typeof userId !== "string" || !userId) return null;
  if (seats.player1Id === userId) return SEAT.PLAYER1;
  if (seats.player2Id === userId) return SEAT.PLAYER2;
  return null;
}

export function userIdForSeat(seats: Seats, seat: Seat | null): string | null {
  if (seat === SEAT.PLAYER1) return seats.player1Id ?? null;
  if (seat === SEAT.PLAYER2) return seats.player2Id ?? null;
  return null;
}

export function hasBothSeats(seats: Seats): boolean {
  return Boolean(seats.player1Id) && Boolean(seats.player2Id);
}

// ──────────────────────────────────────────────────────────────────────────
// Initial state
// ──────────────────────────────────────────────────────────────────────────

function emptyFoundations(): FoundationPiles {
  return { spades: [], hearts: [], diamonds: [], clubs: [] };
}

/**
 * The starting board for a seat, from the shared deal.
 *
 * The deal already carries the face-up flags, so this is a copy rather than a
 * re-derivation — which is exactly the point: both seats are handed the SAME
 * structure, and no per-seat randomness exists anywhere in the opening position.
 */
export function initialStateFromDeal(deal: SolitaireDeal): SolitaireState {
  return {
    variant: deal.variant,
    variantVersion: deal.variantVersion,
    tableau: deal.tableau.map((column) => column.map((pile) => ({ card: pile.card, faceUp: pile.faceUp }))),
    stock: deal.stock.map((card) => ({ suit: card.suit, rank: card.rank })),
    waste: [],
    foundations: emptyFoundations(),
    ply: 0,
    resetCount: 0,
    peakFoundation: 0,
    completed: false,
    completedAtMs: null,
  };
}

/**
 * A shallow structural check for a state read back from the database.
 *
 * Guards against a legacy or hand-edited row: anything that is not a plausible
 * board is refused rather than fed to the engine.
 */
export function isWellFormedState(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<SolitaireState>;
  if (!Array.isArray(state.tableau) || state.tableau.length !== TABLEAU_COLUMNS) return false;
  if (!Array.isArray(state.stock) || !Array.isArray(state.waste)) return false;
  if (!state.foundations || typeof state.foundations !== "object") return false;
  for (const suit of SUITS) {
    if (!Array.isArray((state.foundations as FoundationPiles)[suit])) return false;
  }
  return typeof state.ply === "number";
}

/** A copy of a state, so the engine never mutates the caller's object graph. */
export function cloneState(state: SolitaireState): SolitaireState {
  return {
    variant: state.variant,
    variantVersion: state.variantVersion,
    tableau: state.tableau.map((column) => column.map((pile) => ({ card: pile.card, faceUp: pile.faceUp }))),
    stock: state.stock.map((card) => ({ suit: card.suit, rank: card.rank })),
    waste: state.waste.map((card) => ({ suit: card.suit, rank: card.rank })),
    foundations: {
      spades: (state.foundations?.spades ?? []).map((c) => ({ suit: c.suit, rank: c.rank })),
      hearts: (state.foundations?.hearts ?? []).map((c) => ({ suit: c.suit, rank: c.rank })),
      diamonds: (state.foundations?.diamonds ?? []).map((c) => ({ suit: c.suit, rank: c.rank })),
      clubs: (state.foundations?.clubs ?? []).map((c) => ({ suit: c.suit, rank: c.rank })),
    },
    ply: state.ply,
    resetCount: state.resetCount ?? 0,
    peakFoundation: state.peakFoundation,
    completed: state.completed,
    completedAtMs: state.completedAtMs,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Progress — the competitive metric
// ──────────────────────────────────────────────────────────────────────────

/** Cards currently on the foundations: 0..52. */
export function foundationCount(state: SolitaireState): number {
  return SUITS.reduce(
    (total, suit) => total + (state.foundations?.[suit]?.length ?? 0),
    0,
  );
}

/**
 * Tableau cards that are face-up, measured as "not still hidden".
 *
 * `TABLEAU_CARDS - faceDown` counts every card that has EVER been turned over,
 * including ones since moved to a foundation, so it is a genuine information
 * metric and it is MONOTONE: a card is never turned face-down again. That
 * monotonicity is what lets it be a tiebreak without being gameable.
 */
export function revealedTableauCount(state: SolitaireState): number {
  let faceDown = 0;
  for (const column of state.tableau ?? []) {
    for (const pile of column) {
      if (!pile.faceUp) faceDown += 1;
    }
  }
  return TABLEAU_CARDS - faceDown;
}

/** The progress triple, with the percentage the UI bar renders. */
export function progressOf(state: SolitaireState): SeatProgress {
  const foundationCards = foundationCount(state);
  return {
    foundationCards,
    revealedTableau: revealedTableauCount(state),
    progressPercent: Math.round((foundationCards / DECK_SIZE) * 100),
  };
}

/**
 * The settlement ladder, in order: foundations, then revealed tableau.
 *
 * Returns > 0 when `a` is ahead, < 0 when `b` is ahead, 0 on an exact tie (a
 * draw). There is deliberately NO efficiency tiebreak: with both seats level on
 * progress, "fewer moves wins" would hand the match to a player who did nothing
 * over one who cycled the stock, which is not a competitive signal worth rating.
 */
export function compareProgress(
  a: Pick<SeatProgress, "foundationCards" | "revealedTableau">,
  b: Pick<SeatProgress, "foundationCards" | "revealedTableau">,
): number {
  if ((a.foundationCards ?? 0) !== (b.foundationCards ?? 0)) {
    return (a.foundationCards ?? 0) > (b.foundationCards ?? 0) ? 1 : -1;
  }
  if ((a.revealedTableau ?? 0) !== (b.revealedTableau ?? 0)) {
    return (a.revealedTableau ?? 0) > (b.revealedTableau ?? 0) ? 1 : -1;
  }
  return 0;
}

/** All 52 cards are on the foundations: the puzzle is solved. */
export function isComplete(state: SolitaireState): boolean {
  return foundationCount(state) === DECK_SIZE;
}

// ──────────────────────────────────────────────────────────────────────────
// Move shape-checking (strict, no coercion)
// ──────────────────────────────────────────────────────────────────────────

function reject(code: MoveCode, error: string) {
  return { ok: false as const, code, error };
}

/**
 * Read the failure fields off a result union, or null for a success.
 *
 * Needed because this repo compiles with `strict: false`, where a boolean
 * discriminant does not narrow a union: `if (!result.ok)` leaves `result.code`
 * unreachable to the compiler. This helper performs that narrowing once,
 * explicitly, so every caller can stay readable.
 */
export function failureOf<T extends { ok: boolean }>(
  result: T,
): { code: MoveCode; error: string } | null {
  if (!result || result.ok) return null;
  const failure = result as unknown as { code?: MoveCode; error?: string };
  return {
    code: failure.code ?? "ILLEGAL_MOVE",
    error: failure.error ?? "Invalid move",
  };
}

/**
 * Turn an untrusted payload into a typed move, or refuse it.
 *
 * Every field is type- and range-checked as-is. Nothing is coerced, nothing is
 * defaulted, and unknown properties are ignored rather than merged. A move that
 * fails here never reaches the state at all.
 */
export function normalizeMove(
  raw: unknown,
): { ok: true; move: SolitaireMove } | { ok: false; code: MoveCode; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return reject("BAD_MOVE", "A move must be an object");
  }
  const value = raw as Record<string, unknown>;
  const kind = value.kind;
  if (typeof kind !== "string" || !(MOVE_KINDS as readonly string[]).includes(kind)) {
    return reject("BAD_MOVE", "Unknown move kind");
  }

  switch (kind) {
    case "draw":
      return { ok: true, move: { kind: "draw" } };

    case "waste-to-foundation": {
      if (!isSuit(value.suit)) return reject("BAD_MOVE", "A target suit is required");
      return { ok: true, move: { kind: "waste-to-foundation", suit: value.suit } };
    }

    case "waste-to-tableau": {
      if (!isColumnIndex(value.toColumn)) return reject("BAD_MOVE", "A target column is required");
      return { ok: true, move: { kind: "waste-to-tableau", toColumn: value.toColumn as number } };
    }

    case "tableau-to-foundation": {
      const card = toCard(value.card);
      if (!isColumnIndex(value.fromColumn)) return reject("BAD_MOVE", "A source column is required");
      if (!card) return reject("BAD_MOVE", "A card identity is required");
      if (!isSuit(value.suit)) return reject("BAD_MOVE", "A target suit is required");
      return {
        ok: true,
        move: {
          kind: "tableau-to-foundation",
          fromColumn: value.fromColumn as number,
          card,
          suit: value.suit,
        },
      };
    }

    case "tableau-to-tableau": {
      const card = toCard(value.card);
      if (!isColumnIndex(value.fromColumn)) return reject("BAD_MOVE", "A source column is required");
      if (!card) return reject("BAD_MOVE", "A card identity is required");
      if (!isColumnIndex(value.toColumn)) return reject("BAD_MOVE", "A target column is required");
      if (value.fromColumn === value.toColumn) {
        return reject("ILLEGAL_MOVE", "A column cannot move onto itself");
      }
      return {
        ok: true,
        move: {
          kind: "tableau-to-tableau",
          fromColumn: value.fromColumn as number,
          card,
          toColumn: value.toColumn as number,
        },
      };
    }

    case "foundation-to-tableau": {
      if (!isSuit(value.suit)) return reject("BAD_MOVE", "A source suit is required");
      if (!isColumnIndex(value.toColumn)) return reject("BAD_MOVE", "A target column is required");
      return {
        ok: true,
        move: { kind: "foundation-to-tableau", suit: value.suit, toColumn: value.toColumn as number },
      };
    }

    default:
      return reject("BAD_MOVE", "Unknown move kind");
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Legality
// ──────────────────────────────────────────────────────────────────────────

/** The next rank a foundation for `state.foundations[suit]` will accept. */
export function foundationExpects(state: SolitaireState, suit: Suit): number {
  const pile = state.foundations?.[suit] ?? [];
  if (pile.length === 0) return ACE;
  return pile[pile.length - 1].rank + 1;
}

/**
 * Whether `card` may be laid on a tableau column whose top card is `top`.
 *
 * Empty column: Kings only. Otherwise strictly one rank lower and the opposite
 * colour — the descending alternating-colour rule.
 */
export function canPlaceOnTableau(card: Card, top: Card | null | undefined): boolean {
  if (!top) return card.rank === KING;
  return isRedSuit(card.suit) !== isRedSuit(top.suit) && card.rank === top.rank - 1;
}

/** The last position of a column, or null for an empty column. */
export function tableauTop(state: SolitaireState, column: number): PileCard | null {
  const col = state.tableau?.[column];
  if (!col || col.length === 0) return null;
  return col[col.length - 1];
}

/**
 * The movable run headed by the face-up `head`, or null when there is none.
 *
 * Every position from the head to the end of the column must be face-up and
 * must form a descending alternating-colour sequence. This is also the reason a
 * face-down card can never be addressed: a hidden head is simply not found.
 */
export function faceUpRunFrom(
  state: SolitaireState,
  column: number,
  head: Card,
): Card[] | null {
  const col = state.tableau?.[column];
  if (!col) return null;
  const index = col.findIndex((pile) => pile.faceUp && sameCard(pile.card, head));
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

// `code`/`error` are declared optional on the SUCCESS branch as well, so the
// union stays readable under `strict: false` (see `failureOf`).
export type MoveValidation =
  | { ok: true; code?: MoveCode; error?: string }
  | { ok: false; code: MoveCode; error: string };

/**
 * Validate a legal-Klondike move against the server's board.
 *
 * This is the game's only rule authority. `applyMove` calls it, the store calls
 * `applyMove`, and the client calls `applyMove` for optimistic rendering — so a
 * move the UI draws as accepted is a move the server will accept, without a
 * second implementation to drift.
 */
export function validateMove({
  state,
  move,
}: {
  state: SolitaireState;
  move: SolitaireMove;
}): MoveValidation {
  if (!state || !isWellFormedState(state)) {
    return { ok: false, code: "ILLEGAL_MOVE", error: "The seat has no valid board" };
  }
  if (state.completed) {
    return { ok: false, code: "ALREADY_COMPLETE", error: "The puzzle is already complete" };
  }
  if (state.ply >= MAX_MOVES_PER_SEAT) {
    return { ok: false, code: "MOVE_LIMIT_REACHED", error: "Move limit reached" };
  }

  switch (move.kind) {
    case "draw": {
      if ((state.stock?.length ?? 0) > 0) return { ok: true };
      if ((state.waste?.length ?? 0) > 0) return { ok: true };
      return { ok: false, code: "ILLEGAL_MOVE", error: "The stock and waste are both empty" };
    }

    case "waste-to-foundation": {
      const card = state.waste?.[state.waste.length - 1];
      if (!card) return { ok: false, code: "CARD_NOT_FOUND", error: "The waste is empty" };
      if (card.suit !== move.suit) {
        return { ok: false, code: "ILLEGAL_MOVE", error: "That foundation belongs to another suit" };
      }
      if (card.rank !== foundationExpects(state, move.suit)) {
        return { ok: false, code: "ILLEGAL_MOVE", error: "The foundation does not accept that card" };
      }
      return { ok: true };
    }

    case "waste-to-tableau": {
      const card = state.waste?.[state.waste.length - 1];
      if (!card) return { ok: false, code: "CARD_NOT_FOUND", error: "The waste is empty" };
      const top = tableauTop(state, move.toColumn);
      if (top && !top.faceUp) {
        return { ok: false, code: "ILLEGAL_MOVE", error: "The target column is not playable" };
      }
      if (!canPlaceOnTableau(card, top?.card ?? null)) {
        return { ok: false, code: "ILLEGAL_MOVE", error: "That card cannot be placed there" };
      }
      return { ok: true };
    }

    case "tableau-to-foundation": {
      const top = tableauTop(state, move.fromColumn);
      if (!top || !top.faceUp || !top.card) {
        return { ok: false, code: "CARD_NOT_FOUND", error: "No face-up card there" };
      }
      // Only the column's top card can go to a foundation: a card with others on
      // top of it cannot be lifted out of the middle of a column.
      if (!sameCard(top.card, move.card)) {
        return { ok: false, code: "ILLEGAL_MOVE", error: "Only the top card of a column can be moved" };
      }
      if (move.card.suit !== move.suit) {
        return { ok: false, code: "ILLEGAL_MOVE", error: "That foundation belongs to another suit" };
      }
      if (move.card.rank !== foundationExpects(state, move.suit)) {
        return { ok: false, code: "ILLEGAL_MOVE", error: "The foundation does not accept that card" };
      }
      return { ok: true };
    }

    case "tableau-to-tableau": {
      const run = faceUpRunFrom(state, move.fromColumn, move.card);
      if (!run) {
        return {
          ok: false,
          code: "CARD_NOT_FOUND",
          error: "No face-up run headed by that card",
        };
      }
      const top = tableauTop(state, move.toColumn);
      if (top && !top.faceUp) {
        return { ok: false, code: "ILLEGAL_MOVE", error: "The target column is not playable" };
      }
      if (!canPlaceOnTableau(run[0], top?.card ?? null)) {
        return { ok: false, code: "ILLEGAL_MOVE", error: "That run cannot be placed there" };
      }
      return { ok: true };
    }

    case "foundation-to-tableau": {
      const pile = state.foundations?.[move.suit] ?? [];
      const card = pile[pile.length - 1];
      if (!card) return { ok: false, code: "CARD_NOT_FOUND", error: "That foundation is empty" };
      const top = tableauTop(state, move.toColumn);
      if (top && !top.faceUp) {
        return { ok: false, code: "ILLEGAL_MOVE", error: "The target column is not playable" };
      }
      if (!canPlaceOnTableau(card, top?.card ?? null)) {
        return { ok: false, code: "ILLEGAL_MOVE", error: "That card cannot be placed there" };
      }
      return { ok: true };
    }

    default:
      return { ok: false, code: "BAD_MOVE", error: "Unknown move kind" };
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Applying a move
// ──────────────────────────────────────────────────────────────────────────

export type AppliedMove =
  | { ok: true; state: SolitaireState; revealed: Card[]; code?: MoveCode; error?: string }
  | {
      ok: false;
      code: MoveCode;
      error: string;
      state?: SolitaireState;
      revealed?: Card[];
    };

/**
 * Apply one legally-validated move and return the NEXT board.
 *
 * Re-validates internally, so an unvalidated move can never reach the state.
 * The returned `revealed` list is the cards this move turned face-up: the
 * client needs it to render the flip, since a face-down identity is not in its
 * view until the server says so.
 */
export function applyMove({
  state,
  move,
}: {
  state: SolitaireState;
  move: SolitaireMove;
}): AppliedMove {
  const invalid = failureOf(validateMove({ state, move }));
  if (invalid) return { ok: false, ...invalid };

  const next = cloneState(state);
  const revealed: Card[] = [];

  /**
   * Turn the newly exposed bottom card of a column face-up, and report it.
   *
   * This is the ONLY place a face-down identity leaves the server, and it does
   * so exactly when a legitimate move exposed it.
   */
  const exposeBottom = (column: number) => {
    const col = next.tableau[column];
    const bottom = col[col.length - 1];
    if (bottom && !bottom.faceUp && bottom.card) {
      bottom.faceUp = true;
      revealed.push(bottom.card);
    }
  };

  switch (move.kind) {
    case "draw": {
      if (next.stock.length > 0) {
        const card = next.stock.pop();
        if (card) next.waste.push(card);
      } else {
        // Redeal: turn the waste over. The waste's bottom card (the first one
        // drawn) becomes the new top of the stock, so the array is reversed.
        next.stock = next.waste.slice().reverse();
        next.waste = [];
      }
      break;
    }

    case "waste-to-foundation": {
      const card = next.waste.pop();
      if (card) next.foundations[move.suit].push(card);
      break;
    }

    case "waste-to-tableau": {
      const card = next.waste.pop();
      if (card) next.tableau[move.toColumn].push({ card, faceUp: true });
      break;
    }

    case "tableau-to-foundation": {
      const source = next.tableau[move.fromColumn];
      const card = source.pop();
      if (card?.card) next.foundations[move.suit].push(card.card);
      exposeBottom(move.fromColumn);
      break;
    }

    case "tableau-to-tableau": {
      const source = next.tableau[move.fromColumn];
      const headIndex = source.findIndex((pile) => pile.faceUp && sameCard(pile.card, move.card));
      const moving = source.splice(headIndex);
      for (const pile of moving) {
        next.tableau[move.toColumn].push({ card: pile.card, faceUp: true });
      }
      exposeBottom(move.fromColumn);
      break;
    }

    case "foundation-to-tableau": {
      const card = next.foundations[move.suit].pop();
      if (card) next.tableau[move.toColumn].push({ card, faceUp: true });
      break;
    }

    default:
      return { ok: false, code: "BAD_MOVE", error: "Unknown move kind" };
  }

  next.ply = state.ply + 1;
  // Monotone high-water mark: taking a card back OFF a foundation can never
  // lower it, which is what makes the metric comparable at any instant and
  // un-farmable by putting a card down twice.
  next.peakFoundation = Math.max(state.peakFoundation ?? 0, foundationCount(next));
  // Derived from the board; the completion INSTANT is stamped by the store.
  next.completed = foundationCount(next) === DECK_SIZE;

  return { ok: true, state: next, revealed };
}

// ──────────────────────────────────────────────────────────────────────────
// View projection — the single place hidden information could leak
// ──────────────────────────────────────────────────────────────────────────

/** Strip a board down to what its OWNER may see. */
export function viewForState(state: SolitaireState): SolitaireView {
  const tableau = (state.tableau ?? []).map((column) =>
    column.map((pile): ViewPileCard => {
      if (pile.faceUp && pile.card) return { faceUp: true, card: pile.card };
      // A hidden position carries NO identity — not a masked card, not a
      // placeholder suit. There is nothing here to read.
      return { faceUp: false, card: null };
    }),
  );

  return {
    tableau,
    // Count only: the stock's order is a secret the client must not hold, or a
    // player could plan around cards they have never legitimately exposed.
    stockCount: state.stock?.length ?? 0,
    waste: (state.waste ?? []).map((card) => ({ suit: card.suit, rank: card.rank })),
    foundations: {
      spades: (state.foundations?.spades ?? []).map((c) => ({ suit: c.suit, rank: c.rank })),
      hearts: (state.foundations?.hearts ?? []).map((c) => ({ suit: c.suit, rank: c.rank })),
      diamonds: (state.foundations?.diamonds ?? []).map((c) => ({ suit: c.suit, rank: c.rank })),
      clubs: (state.foundations?.clubs ?? []).map((c) => ({ suit: c.suit, rank: c.rank })),
    },
    ply: state.ply ?? 0,
    resetCount: state.resetCount ?? 0,
    progress: progressOf(state),
    completed: Boolean(state.completed),
    canRedeal: (state.stock?.length ?? 0) === 0 && (state.waste?.length ?? 0) > 0,
  };
}

/**
 * The closed opponent shape.
 *
 * Counts and status, deliberately nothing else: no tableau layout, no stock or
 * waste contents, no face-down identities, no move list. The information is
 * insufficient to reconstruct a board, so it cannot be used to copy a move.
 */
export function opponentProgressFor(seat: Seat, state: SolitaireState): OpponentProgress {
  const progress = progressOf(state);
  return {
    seatKey: seat,
    foundationCards: progress.foundationCards,
    revealedTableau: progress.revealedTableau,
    progressPercent: progress.progressPercent,
    completed: Boolean(state.completed),
    completedAtMs: state.completedAtMs ?? null,
  };
}

/** The viewer's own outcome, for the result screen. */
export function outcomeFor(
  seat: Seat | null,
  result: unknown,
): "win" | "loss" | "draw" | null {
  if (!seat || typeof result !== "string") return null;
  if (result === "draw") return "draw";
  if (result === SEAT.PLAYER1 || result === SEAT.PLAYER2) {
    return result === seat ? "win" : "loss";
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────────
// Race resolution — the tie-break ladder, pure and testable
// ──────────────────────────────────────────────────────────────────────────

/** Build the per-seat race facts the ladder reads. */
export function raceFromState({
  userId,
  seat,
  state,
  forfeited = false,
}: {
  userId: string | null;
  seat: Seat;
  state: SolitaireState | null | undefined;
  forfeited?: boolean;
}): SeatRace {
  const progress = state
    ? progressOf(state)
    : { foundationCards: 0, revealedTableau: 0, progressPercent: 0 };
  return {
    userId,
    ply: state?.ply ?? 0,
    progress,
    // The completion INSTANT is what decides a photo finish, so it is read from
    // the stored state (stamped by the store), never re-derived here.
    completedAtMs:
      state && (state.completed || state.completedAtMs != null)
        ? (state.completedAtMs ?? null)
        : null,
    forfeited,
  };
}

/**
 * Decide the match from the two seats' race facts.
 *
 * Returns null while the match is still live (nobody has completed and nobody
 * has forfeited), so the store can call it on every transition and only act
 * when there is a verdict. There is no match clock: a match ends on a
 * completion or a forfeit (a concession, a disconnect, or the inactivity rule).
 *
 * Order:
 *   1. a forfeit decides the match for the opponent; two forfeits are a draw
 *   2. a completed seat wins — immediately, which satisfies "first to solve it
 *      wins"; two completions inside `COMPLETION_DEAD_HEAT_MS` are a draw
 */
export function resolveRace({
  player1,
  player2,
}: {
  player1: SeatRace;
  player2: SeatRace;
}): RaceOutcome | null {
  if (player1.forfeited && player2.forfeited) {
    return { result: "draw", resolution: RESOLUTION.DRAW };
  }
  if (player1.forfeited) return { result: SEAT.PLAYER2, resolution: RESOLUTION.FORFEIT };
  if (player2.forfeited) return { result: SEAT.PLAYER1, resolution: RESOLUTION.FORFEIT };

  const done1 = player1.completedAtMs;
  const done2 = player2.completedAtMs;
  if (done1 != null && done2 != null) {
    if (Math.abs(done1 - done2) <= COMPLETION_DEAD_HEAT_MS) {
      return { result: "draw", resolution: RESOLUTION.DRAW };
    }
    return done1 < done2
      ? { result: SEAT.PLAYER1, resolution: RESOLUTION.FINISH }
      : { result: SEAT.PLAYER2, resolution: RESOLUTION.FINISH };
  }
  if (done1 != null) return { result: SEAT.PLAYER1, resolution: RESOLUTION.FINISH };
  if (done2 != null) return { result: SEAT.PLAYER2, resolution: RESOLUTION.FINISH };

  return null;
}

/** The settlement token the shared rating/trophy writers accept. */
export function settlementResultFor(result: RaceOutcome["result"]): "win" | "draw" {
  return result === "draw" ? "draw" : "win";
}

// ──────────────────────────────────────────────────────────────────────────
// Replay — the audit path
// ──────────────────────────────────────────────────────────────────────────

/**
 * Rebuild a board by replaying its accepted moves from the shared deal.
 *
 * The move log is the authoritative record, so a match can be reproduced from
 * (deal, moves) alone — which is what makes the stored JSONB board a cache
 * rather than the only evidence, and what lets a finished match be audited
 * without trusting any persisted state.
 */
export function replayMoves({
  deal,
  moves,
}: {
  deal: SolitaireDeal;
  moves: { kind: string; move: unknown }[];
}): { ok: boolean; state: SolitaireState; rejectedAt: number | null } {
  let state = initialStateFromDeal(deal);
  for (let index = 0; index < moves.length; index += 1) {
    const entry = moves[index];
    const normalized = normalizeMove(entry?.move);
    if (!normalized.ok || normalized.move.kind !== entry?.kind) {
      return { ok: false, state, rejectedAt: index };
    }
    const applied = applyMove({ state, move: normalized.move });
    if (!applied.ok) return { ok: false, state, rejectedAt: index };
    state = applied.state;
  }
  return { ok: true, state, rejectedAt: null };
}

/** Re-exported so routes and tests can assert shape without a second import. */
export { cardKey };
export const RULES_VARIANT = Object.freeze({ variant: VARIANT, variantVersion: VARIANT_VERSION });
