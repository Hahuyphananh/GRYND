// src/lib/blackjack-pvp/constants.js
//
// Shared constants + deck + hand-value helpers for the Blackjack PvP
// match system. Built as a parallel reference to
// `src/lib/roulette-pvp/constants.js` so the lobby + match flow is
// recognisably the same shape (stake presets / round timer / status
// enum) while the underlying game logic is blackjack-specific (deck
// builder, hand-value scorer).
//
// The `calcHandValue` mirror is intentionally kept independent from
// the solo-blackjack `src/lib/handEval.ts` so we don't accidentally
// couple the PvP state machine to legacy single-player code paths.

const SUITS = ["♠", "♥", "♦", "♣"];
const VALUES = [
  "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A",
];

// ── Per-round turn window ─────────────────────────────────────────────
// Duration (seconds) of each round's decision window before the
// server-authoritative deadline fires. Stored on the match row so
// future admin tooling can tune it without touching code.
export const ROUND_TIMER_SECONDS = 30;
export const ROUND_DEADLINE_MS = ROUND_TIMER_SECONDS * 1000;

// ── Stake matchmaking constants ───────────────────────────────────────
export const STAKE_PRESETS = [10, 25, 50, 100, 250, 500];
export const MAX_STAKE = 1000000;
export const MIN_STAKE = 1;

// ── House fee (matches roulette-pvp: 2.5%) ────────────────────────────
export const HOUSE_FEE_PCT = 0.025;

// ── Status state machine ─────────────────────────────────────────────
export const MATCH_STATUS = Object.freeze({
  WAITING: "waiting",
  READY: "ready",
  ROUND_1: "round_1",
  ROUND_2: "round_2",
  ROUND_3: "round_3",
  BETWEEN_ROUNDS: "between_rounds",
  FINISHED: "finished",
  CANCELLED: "cancelled",
});

// States where the match hasn't yet reached a terminal outcome. The
// brief `ready` window is included so /status polls surface it.
// `between_rounds` is included so the transition screen waits for
// either the timer or the player's "Continue now" press.
export const ACTIVE_STATES = new Set([
  MATCH_STATUS.READY,
  MATCH_STATUS.ROUND_1,
  MATCH_STATUS.ROUND_2,
  MATCH_STATUS.ROUND_3,
  MATCH_STATUS.BETWEEN_ROUNDS,
]);

// States where hit/stand/swap/hold actions are accepted. `ready` is
// intentionally excluded — it's the brief post-pairing banner before
// round_1 starts. `between_rounds` is excluded — no actions during
// the transition screen, only Continue / auto-advance.
export const PLAYABLE_STATES = new Set([
  MATCH_STATUS.ROUND_1,
  MATCH_STATUS.ROUND_2,
  MATCH_STATUS.ROUND_3,
]);

// Auto-transition window between resolved rounds, before the next
// round's fresh shuffled deck is dealt and round_X status is set.
// Surfaced as a transition screen ("Round X+1 incoming…").
export const BETWEEN_ROUNDS_MS = 3000;

// Auto-advance window between player2 joining and round_1 starting
// (server-authoritative 3-second "Get ready" banner).
export const READY_WINDOW_MS = 3000;

// Best-of-3 ceiling: match ends EARLY when one player reaches
// `score_player = BEST_OF - 1` of 2 (already won 2 rounds). Total
// rounds is up to `TOTAL_ROUNDS`.
export const TOTAL_ROUNDS = 3;

// Seconds/numeric counter used by the transition screen UI to advertise
// the next round. Mirrors `BETWEEN_ROUNDS_MS / 1000` (rounded).
export const BETWEEN_ROUNDS_SECONDS = Math.round(BETWEEN_ROUNDS_MS / 1000);

// Stake-key advisory-lock namespace for `createOrJoin` matchmaking.
// Stable ASCII-pack to keep the global pg_advisory_xact_lock keyspace
// partitioned so other features can't accidentally collide with
// blackjack-pvp matchmaking. ASCII for "BJPV": B=0x42, J=0x4A,
// P=0x50, V=0x56 packed into the upper 28 bits.
export const BLACKJACK_PVP_LOCK_NAMESPACE = 0x424a5056 & 0x7fffffff;

// ── Per-seat round state ──────────────────────────────────────────────
export const PLAYER_STATE = Object.freeze({
  PLAYING: "playing",
  STOOD: "stood",
  BUSTED: "busted",
});

// Sentinel for a busted hand's effective "score" — guarantees a
// busted hand always loses to any non-busted 0..21 score regardless
// of the numeric comparison.
export const BUSTED_SCORE_SENTINEL = -1;

// ── Result string constants ───────────────────────────────────────────
export const RESULT = Object.freeze({
  PLAYER1: "player1",
  PLAYER2: "player2",
  DRAW: "draw",
});

// ── Action vocabulary ─────────────────────────────────────────────────
// Server-side authoritative action strings the client may POST to
// `/api/blackjack-pvp/match/[matchId]/action`. Each action validates
// its own preconditions inside `serverStore.recordAction`.
export const ACTION_TYPE = Object.freeze({
  HIT: "hit",
  STAND: "stand",
  SWAP: "swap",
  HOLD: "hold",
  USE_HELD: "use_held",
  PEEK: "peek",
});

// Per-round usage caps. Each player has ONE swap, ONE hold, and ONE
// peek per round, regardless of how many hits they take.
export const SWAP_LIMIT_PER_ROUND = 1;
export const HOLD_LIMIT_PER_ROUND = 1;
export const PEEK_LIMIT_PER_ROUND = 1;

// Resolution states for a held card. `null` until the player decides
// what to do with their stored card (add to hand or discard). After
// resolution, no further Hold-related mutations are allowed.
export const HELD_RESOLUTION = Object.freeze({
  ADD: "add",
  DISCARD: "discard",
});

// Allowed sub-actions for the USE_HELD endpoint. Anything else is
// rejected so callers can't smuggle arbitrary verbs.
export const USE_HELD_SUBACTIONS = Object.freeze({
  ADD: "add",
  DISCARD: "discard",
});

// ── Deck builder + card helper ───────────────────────────────────────
export function buildDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const value of VALUES) {
      deck.push({ suit, value });
    }
  }
  return shuffle(deck);
}

/** Fisher-Yates shuffle. Pure: returns a new array. */
export function shuffle(arr) {
  const a = Array.isArray(arr) ? [...arr] : [];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Pop N cards from the FRONT of `deck` (mutating). Returns the drawn cards. */
export function drawCards(deck, n) {
  const drawn = [];
  for (let i = 0; i < n && deck.length > 0; i++) {
    drawn.push(deck.shift());
  }
  return drawn;
}

// ── Hand-value scorer ────────────────────────────────────────────────
// Mirrors the solo-blackjack page.tsx scorer: aces count as 11 unless
// that would bust the hand, then they fall back to 1.
export function calcHandValue(cards) {
  if (!Array.isArray(cards) || cards.length === 0) return 0;
  let value = 0;
  let aces = 0;
  for (const c of cards) {
    if (!c || typeof c !== "object") continue;
    if (c.value === "A") {
      aces++;
      value += 11;
    } else if (["K", "Q", "J"].includes(c.value)) {
      value += 10;
    } else {
      const parsed = parseInt(c.value, 10);
      value += Number.isFinite(parsed) ? parsed : 0;
    }
  }
  while (value > 21 && aces > 0) {
    value -= 10;
    aces--;
  }
  return value;
}

/**
 * Effective "score" used for round resolution comparisons.
 *   * Busted hands → `BUSTED_SCORE_SENTINEL` (-1) so a busted hand
 *     always loses to a non-busted 0..21 score.
 *   * Otherwise → `calcHandValue(hand)`.
 */
export function effectiveHandScore(cards, state) {
  if (state === PLAYER_STATE.BUSTED) return BUSTED_SCORE_SENTINEL;
  return calcHandValue(cards);
}

// ── Round-winner decision (closer to 21, no bust) ────────────────────
export function decideRoundWinner({
  p1Cards,
  p1State,
  p2Cards,
  p2State,
}) {
  const p1Score = effectiveHandScore(p1Cards, p1State);
  const p2Score = effectiveHandScore(p2Cards, p2State);

  // Both busted (or both busted-equivalent sentinel) → draw.
  if (p1Score === BUSTED_SCORE_SENTINEL && p2Score === BUSTED_SCORE_SENTINEL) {
    return { winner: RESULT.DRAW, p1Score, p2Score };
  }
  if (p1Score === p2Score) {
    return { winner: RESULT.DRAW, p1Score, p2Score };
  }
  return {
    winner: p1Score > p2Score ? RESULT.PLAYER1 : RESULT.PLAYER2,
    p1Score,
    p2Score,
  };
}

// ── Suit helpers (used by the UI for red/black colouring) ─────────────
export function isRedSuit(suit) {
  return suit === "♥" || suit === "♦";
}

// Re-export suits / values so the client-side UI components can mirror
// the same constants without re-declaring them.
export const SUITS_LIST = SUITS;
export const VALUES_LIST = VALUES;
