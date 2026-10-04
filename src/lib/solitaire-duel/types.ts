// src/lib/solitaire-duel/types.ts
//
// The vocabulary shared by the pure engine (`deck.ts`, `rules.ts`), the
// authoritative store (`serverStore.ts`) and the client view projection.
//
// Two shapes here are load-bearing and must never be confused:
//
//   SolitaireState — the SERVER's board. It knows every face-down identity and
//                    the stock order. It is stored in the match row's
//                    `p1_state` / `p2_state` columns and is NEVER sent to a
//                    client.
//   SolitaireView  — what a client may see. Face-down cards carry no identity
//                    and the stock is reduced to a count, so a player cannot
//                    read the deal off the wire (and therefore cannot plan
//                    around cards they have not legitimately exposed).
//
// The projection from one to the other lives in `rules.ts` (`viewForState`) and
// is the single place hidden information could ever leak.

// ── Cards ─────────────────────────────────────────────────────────────────

export type Suit = "spades" | "hearts" | "diamonds" | "clubs";

/** 1 = Ace, 11 = Jack, 12 = Queen, 13 = King. */
export type Rank = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13;

export type Card = { suit: Suit; rank: Rank };

export type Color = "red" | "black";

/** The four foundation piles, keyed by suit. */
export type FoundationPiles = Record<Suit, Card[]>;

// ── Seats ─────────────────────────────────────────────────────────────────

export type Seat = "player1" | "player2";

export type Seats = { player1Id: string; player2Id: string | null };

// ── Board ─────────────────────────────────────────────────────────────────

/**
 * One position in a pile.
 *
 * `card: null` with `faceUp: false` is a HIDDEN position: the server knows the
 * identity (it is in the deal) but a client is never told it. Keeping the flag
 * and the identity on the same object is what makes the projection in
 * `viewForState` a one-liner rather than a second data model.
 */
export type PileCard = { card: Card | null; faceUp: boolean };

/** The authoritative per-seat board (server-only, persisted as JSONB). */
export type SolitaireState = {
  variant: string;
  variantVersion: number;
  /** Exactly `TABLEAU_COLUMNS` columns; index `i` is dealt `i + 1` cards. */
  tableau: PileCard[][];
  /** Bottom→top: the NEXT card drawn is the LAST element. Server-only. */
  stock: Card[];
  /** Bottom→top, all face-up. Movable card is the last element. */
  waste: Card[];
  foundations: FoundationPiles;
  /** Accepted moves by this seat — the per-seat idempotency cursor. */
  ply: number;
  /** High-water mark of cards on the foundations (0..52). Monotone. */
  peakFoundation: number;
  /** True once all four foundations reach King. Stamped by the store. */
  completed: boolean;
  /** Server instant the seat completed, or null. */
  completedAtMs: number | null;
};

/**
 * The ONE deal shared by both seats for a match.
 *
 * Derived deterministically from the match seed (`deriveDealSeed` →
 * `solvableDealFromSeed`, the version-3 verified generator), stored once on the
 * match row, and NEVER regenerated when the second player joins. There is
 * deliberately no per-seat deal anywhere in this game.
 */
export type SolitaireDeal = {
  variant: string;
  variantVersion: number;
  tableau: PileCard[][];
  stock: Card[];
};

// ── Moves (the only client-authored input) ────────────────────────────────

export type DrawMove = { kind: "draw" };
export type WasteToFoundationMove = { kind: "waste-to-foundation"; suit: Suit };
export type WasteToTableauMove = { kind: "waste-to-tableau"; toColumn: number };

/**
 * `card` names the run head BY IDENTITY, never by index.
 *
 * An index could address a face-down position; an identity cannot, because the
 * engine only resolves a card that is face-up at the named source. This is the
 * structural reason a client can never move a card it has not exposed.
 */
export type TableauToFoundationMove = {
  kind: "tableau-to-foundation";
  fromColumn: number;
  card: Card;
  suit: Suit;
};
export type TableauToTableauMove = {
  kind: "tableau-to-tableau";
  fromColumn: number;
  card: Card;
  toColumn: number;
};
export type FoundationToTableauMove = {
  kind: "foundation-to-tableau";
  suit: Suit;
  toColumn: number;
};

export type SolitaireMove =
  | DrawMove
  | WasteToFoundationMove
  | WasteToTableauMove
  | TableauToFoundationMove
  | TableauToTableauMove
  | FoundationToTableauMove;

export type MoveKind = SolitaireMove["kind"];

/** Rejection codes. Business codes are the contract the routes surface. */
export type MoveCode =
  | "MATCH_NOT_PLAYING"
  | "BEFORE_GO"
  | "AFTER_DEADLINE"
  | "STALE_PLY"
  | "ALREADY_COMPLETE"
  | "MOVE_LIMIT_REACHED"
  | "BAD_MOVE"
  | "ILLEGAL_MOVE"
  | "CARD_NOT_FOUND";

// ── Progress ──────────────────────────────────────────────────────────────

/**
 * The competitive metric, in the exact order the server compares it.
 *
 * Primary: cards on the foundations (0..52) — finishing needs all 52.
 * Secondary: cards revealed in the tableau (7..28) — Klondike's hard-won
 * information progress, which foundations alone can miss.
 * An exact tie on both is a draw.
 */
export type SeatProgress = {
  foundationCards: number;
  revealedTableau: number;
  progressPercent: number;
};

/** What a client may know about the opponent: counts and status, never a board. */
export type OpponentProgress = {
  seatKey: Seat;
  foundationCards: number;
  revealedTableau: number;
  progressPercent: number;
  completed: boolean;
  completedAtMs: number | null;
};

// ── Views ─────────────────────────────────────────────────────────────────

export type ViewPileCard = { faceUp: true; card: Card } | { faceUp: false; card: null };

export type SolitaireView = {
  tableau: ViewPileCard[][];
  /** Count only — the order and the identities stay on the server. */
  stockCount: number;
  waste: Card[];
  foundations: FoundationPiles;
  ply: number;
  progress: SeatProgress;
  completed: boolean;
  /** True when a `draw` would recycle the waste (the stock is exhausted). */
  canRedeal: boolean;
};

// ── Race resolution (pure) ────────────────────────────────────────────────

/** The per-seat facts the settlement ladder needs. No board, no cards. */
export type SeatRace = {
  userId: string | null;
  ply: number;
  progress: SeatProgress;
  completedAtMs: number | null;
  forfeited: boolean;
};

export type RaceResult = "player1" | "player2" | "draw";

export type RaceResolution = "finish" | "forfeit" | "draw";

export type RaceOutcome = { result: RaceResult; resolution: RaceResolution };
