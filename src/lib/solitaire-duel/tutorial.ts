// src/lib/solitaire-duel/tutorial.ts
//
// THE INTERACTIVE ONBOARDING TUTORIAL — a real deal, played through the REAL
// Klondike engine.
//
// There is no tutorial rules engine and no scripted board. The deal below is
// handed to `initialStateFromDeal`, every move is validated and applied by
// `applyMove` (the same authority the solo game and the duel store use), and
// the board renders `viewForState` — so a tutorial move is exactly as legal (or
// illegal) as it is in a real game. The tutorial never makes a move for the
// player: it only reads the board and shows a hint.
//
// WHY THIS DEAL. The first four columns are arranged so the guided sequence is
// genuinely possible from the opening position:
//
//   column 0: A♥ face up                 → move the Ace to the hearts foundation
//   column 1: 2♥ face up                 → then the 2
//   column 2: 6♠ face down, 7♦ face up   → 7♦ onto 8♣ reveals the 6♠
//   column 3: 8♣ face up
//   stock:    the other 47 cards         → draw one, see how the waste works
//
// The goals are STATE PREDICATES, not move identities. A player who finds a
// different legal route (for example moving a foundation card back) still gets
// credit the moment the board satisfies the goal, and a deviation can never
// leave the tutorial stuck on an impossible script. `runTutorialSequence` is
// executed by tests to prove the canonical path is achievable.
//
// Nothing here touches ranked matchmaking, Elo, trophies, bot difficulty or the
// solo session store: the tutorial owns one in-memory board and nothing else.

import type { GlitchExpression } from "../mascot/glitchAssets";
import { SUITS } from "./constants";
import { applyMove, initialStateFromDeal, normalizeMove } from "./rules";
import type {
  Card,
  SolitaireDeal,
  SolitaireMove,
  SolitaireState,
  Suit,
} from "./types";

const card = (suit: Suit, rank: number): Card => ({ suit, rank: rank as Card["rank"] });

const ACE_HEARTS = card("hearts", 1);
const TWO_HEARTS = card("hearts", 2);
const SEVEN_DIAMONDS = card("diamonds", 7);
const EIGHT_CLUBS = card("clubs", 8);
const SIX_SPADES = card("spades", 6);

const CARD_KEY = (value: Card) => `${value.suit}-${value.rank}`;

/** Every card of a standard deck except the five the tutorial positions. */
function remainingDeck(excluded: readonly Card[]): Card[] {
  const used = new Set(excluded.map(CARD_KEY));
  const deck: Card[] = [];
  for (const suit of SUITS) {
    for (let rank = 1; rank <= 13; rank += 1) {
      const value = card(suit, rank);
      if (!used.has(CARD_KEY(value))) deck.push(value);
    }
  }
  return deck;
}

/**
 * The deterministic tutorial deal. It is NOT a seed-verified match deal and is
 * never persisted or shared; it exists so every new player sees the same,
 * provably solvable first four moves.
 */
export const TUTORIAL_DEAL: SolitaireDeal = {
  variant: "klondike-1",
  variantVersion: 3,
  tableau: [
    [{ card: ACE_HEARTS, faceUp: true }],
    [{ card: TWO_HEARTS, faceUp: true }],
    [
      { card: SIX_SPADES, faceUp: false },
      { card: SEVEN_DIAMONDS, faceUp: true },
    ],
    [{ card: EIGHT_CLUBS, faceUp: true }],
    [],
    [],
    [],
  ],
  stock: remainingDeck([ACE_HEARTS, TWO_HEARTS, SEVEN_DIAMONDS, EIGHT_CLUBS, SIX_SPADES]),
};

export type TutorialStep = {
  /** Stable id, used by the UI and by tests. */
  readonly id: "ace" | "two" | "reveal" | "draw";
  /** Translation key for the instruction line. */
  readonly hintKey: string;
  /** The canonical move for this goal (used only to offer a hint). */
  readonly move: SolitaireMove;
  /** The goal, as a predicate over the real board. */
  readonly done: (state: SolitaireState) => boolean;
  /** Glitch's reaction the moment the goal is reached. */
  readonly reaction: GlitchExpression;
};

/**
 * The four guided goals, in order. Each is checked against the state produced
 * by the real engine — never against "the player clicked the expected card".
 */
export const TUTORIAL_STEPS: readonly TutorialStep[] = [
  {
    id: "ace",
    hintKey: "onboarding.solitaire.tutorial.step.ace",
    move: { kind: "tableau-to-foundation", fromColumn: 0, card: ACE_HEARTS, suit: "hearts" },
    done: (state) => (state.foundations?.hearts?.length ?? 0) >= 1,
    reaction: "victory",
  },
  {
    id: "two",
    hintKey: "onboarding.solitaire.tutorial.step.two",
    move: { kind: "tableau-to-foundation", fromColumn: 1, card: TWO_HEARTS, suit: "hearts" },
    done: (state) => (state.foundations?.hearts?.length ?? 0) >= 2,
    reaction: "wink",
  },
  {
    id: "reveal",
    hintKey: "onboarding.solitaire.tutorial.step.reveal",
    move: { kind: "tableau-to-tableau", fromColumn: 2, card: SEVEN_DIAMONDS, toColumn: 3 },
    done: (state) =>
      (state.tableau?.[2]?.length ?? 0) === 1 && state.tableau[2][0].faceUp === true,
    reaction: "surprised",
  },
  {
    id: "draw",
    hintKey: "onboarding.solitaire.tutorial.step.draw",
    move: { kind: "draw" },
    done: (state) => (state.waste?.length ?? 0) >= 1,
    reaction: "wink",
  },
];

export const TUTORIAL_STEP_COUNT = TUTORIAL_STEPS.length;

/** A fresh tutorial board. */
export function tutorialInitialState(): SolitaireState {
  return initialStateFromDeal(TUTORIAL_DEAL);
}

/** The first goal not yet met; `TUTORIAL_STEP_COUNT` once the tutorial is done. */
export function tutorialStepIndex(state: SolitaireState): number {
  const index = TUTORIAL_STEPS.findIndex((step) => !step.done(state));
  return index === -1 ? TUTORIAL_STEP_COUNT : index;
}

export function tutorialComplete(state: SolitaireState): boolean {
  return tutorialStepIndex(state) >= TUTORIAL_STEP_COUNT;
}

/** The current goal, or null when the tutorial is complete. */
export function currentTutorialStep(state: SolitaireState): TutorialStep | null {
  return TUTORIAL_STEPS[tutorialStepIndex(state)] ?? null;
}

/**
 * The canonical move for the current goal, but ONLY while it is still legal on
 * this board. A deviation can therefore never produce a hint that names an
 * illegal move — the caller falls back to a generic nudge instead.
 */
export function tutorialHintMove(state: SolitaireState): SolitaireMove | null {
  const step = currentTutorialStep(state);
  if (!step) return null;
  return applyMove({ state, move: step.move }).ok ? step.move : null;
}

export type TutorialMoveOutcome =
  | {
      ok: true;
      state: SolitaireState;
      revealed: Card[];
      stepBefore: number;
      stepAfter: number;
      advanced: boolean;
      complete: boolean;
    }
  | { ok: false; error: string };

/**
 * Validate + apply ONE player move through the real engine.
 *
 * The caller (the tutorial UI) passes the move the board proposed; this never
 * invents a move, never retries, and never advances the tutorial without the
 * engine accepting the input.
 */
export function applyTutorialMove({
  state,
  move,
}: {
  state: SolitaireState;
  move: unknown;
}): TutorialMoveOutcome {
  // `normalizeMove`'s union is narrowed on the move itself rather than on a
  // possibly-widened boolean, so an invalid proposal can never reach applyMove.
  const normalized = normalizeMove(move);
  if (!("move" in normalized)) {
    return {
      ok: false,
      error: "error" in normalized ? normalized.error : "Invalid move.",
    };
  }

  const stepBefore = tutorialStepIndex(state);
  const applied = applyMove({ state, move: normalized.move });
  if (!applied.ok) return { ok: false, error: applied.error };

  const stepAfter = tutorialStepIndex(applied.state);
  return {
    ok: true,
    state: applied.state,
    revealed: applied.revealed ?? [],
    stepBefore,
    stepAfter,
    advanced: stepAfter > stepBefore,
    complete: stepAfter >= TUTORIAL_STEP_COUNT,
  };
}

/**
 * Play the canonical sequence through the engine.
 *
 * Exported for tests: it is the proof that the deal and the guided goals agree,
 * i.e. that the tutorial is genuinely achievable rather than a mocked script.
 */
export function runTutorialSequence(): {
  ok: boolean;
  trace: { id: string; stepIndex: number; legal: boolean; error?: string }[];
  state: SolitaireState;
} {
  let state = tutorialInitialState();
  const trace: { id: string; stepIndex: number; legal: boolean; error?: string }[] = [];
  let ok = true;

  for (const step of TUTORIAL_STEPS) {
    const applied = applyMove({ state, move: step.move });
    if (!applied.ok) {
      trace.push({ id: step.id, stepIndex: tutorialStepIndex(state), legal: false, error: applied.error });
      ok = false;
      break;
    }
    state = applied.state;
    const stepIndex = tutorialStepIndex(state);
    trace.push({ id: step.id, stepIndex, legal: true });
    if (stepIndex === 0) ok = false;
  }

  return { ok: ok && tutorialComplete(state), trace, state };
}
