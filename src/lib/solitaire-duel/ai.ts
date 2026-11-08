// src/lib/solitaire-duel/ai.ts
//
// The Solitaire Duel practice bot. PURE: it is handed the server's board and
// returns ONE legal Klondike move, or null when the board is stuck. No
// database, no clock, no I/O.
//
// The bot solves its OWN copy of the shared deal, exactly as a human seat does.
// It is not a turn-based opponent in the usual sense — Solitaire Duel is
// simultaneous — so the store paces it from the server clock (one move every
// `aiMoveDelayMs`) and the store is what guarantees it always plays.
//
// WHY A HEURISTIC RATHER THAN A FULL SOLVER: Klondike's state space is far too
// large for a complete search inside a request, and a bot that took minutes per
// move would be unplayable. Every bot therefore uses this same engine and the
// same visible-information evaluation; the named profiles change how deeply it
// searches, how it weighs structural progress, and how often it deliberately
// takes a worse legal move.
//
// FAIRNESS IS STRUCTURAL: the evaluator never reads a face-down card's identity
// or the order of the stock. It sees the same visible board a human sees, plus
// the stock/waste COUNTS. A draw is scored as "a card may be revealed", never by
// inspecting which card it will be, and lookahead stops at a move that would
// uncover a hidden card (the identity would be new information). This applies to
// Perfect too — it is the strongest fair profile, not a solver with the deal.
//
// THE PROVEN-LINE HELPERS BELOW ARE LEGACY TEST/DEBUG UTILITIES. The server does
// NOT use `planAiSolution` to drive a practice bot: replaying the deal's known
// solution would give the bot future information the human cannot have.

import {
  AI_DIFFICULTY_LABELS,
  coerceAiDifficulty,
  type AiDifficulty,
} from "../aiDifficulty";
import {
  SOLITAIRE_BOT_BY_ID,
  solitaireBotFor,
  type SolitaireBot,
  type SolitaireBotAiProfile,
} from "./bots";
import { SUITS } from "./constants";
import {
  applyMove,
  canPlaceOnTableau,
  faceUpRunFrom,
  foundationExpects,
  sameCard,
  tableauTop,
} from "./rules";
import type { Card, SolitaireMove, SolitaireState, Suit } from "./types";

/**
 * How long each bot waits between accepted moves.
 *
 * Pacing is a presentation choice, not the difficulty. The weak bots are slow
 * AND make weaker decisions; the strong bots think faster AND decide better.
 * Legacy tier keys stay for old callers/tests.
 */
export const AI_MOVE_DELAY_MS = Object.freeze({
  easy: SOLITAIRE_BOT_BY_ID.rookie.ai.moveDelayMs,
  normal: SOLITAIRE_BOT_BY_ID.ace.ai.moveDelayMs,
  hard: SOLITAIRE_BOT_BY_ID.grandmaster.ai.moveDelayMs,
  rookie: SOLITAIRE_BOT_BY_ID.rookie.ai.moveDelayMs,
  felix: SOLITAIRE_BOT_BY_ID.felix.ai.moveDelayMs,
  ace: SOLITAIRE_BOT_BY_ID.ace.ai.moveDelayMs,
  professor: SOLITAIRE_BOT_BY_ID.professor.ai.moveDelayMs,
  grandmaster: SOLITAIRE_BOT_BY_ID.grandmaster.ai.moveDelayMs,
  perfect: SOLITAIRE_BOT_BY_ID.perfect.ai.moveDelayMs,
});

/** The delay for a bot (or a legacy tier), resolved through the roster. */
export function aiMoveDelayMs(difficulty: unknown): number {
  return solitaireBotFor(difficulty).ai.moveDelayMs;
}

/** A bot's delay in seconds, rounded the same way the UI prints it. */
export function aiPaceSeconds(difficulty: unknown): string {
  return (Math.round(aiMoveDelayMs(difficulty) / 100) / 10).toFixed(1);
}

/** A human-readable identity line for a bot. */
export function aiPaceLabel(difficulty: unknown): string {
  const bot = solitaireBotFor(difficulty);
  return `${bot.name} · ${bot.difficultyLabel} · ~${aiPaceSeconds(bot.id)}s a move`;
}

/** The legacy tier's display label, kept for callers that still use it. */
export function aiTierLabel(difficulty: unknown): string {
  return AI_DIFFICULTY_LABELS[coerceAiDifficulty(difficulty)];
}

/** Every legal move for `state` (never a move `applyMove` would reject). */
export function legalMoves(state: SolitaireState): SolitaireMove[] {
  const moves: SolitaireMove[] = [];
  if (!state || state.completed) return moves;
  const tableau = state.tableau ?? [];

  // 1. Tableau top → foundation.
  for (let column = 0; column < tableau.length; column += 1) {
    const top = tableauTop(state, column);
    if (!top?.faceUp || !top.card) continue;
    if (top.card.rank === foundationExpects(state, top.card.suit)) {
      moves.push({
        kind: "tableau-to-foundation",
        fromColumn: column,
        card: top.card,
        suit: top.card.suit,
      });
    }
  }

  // 2. Waste top → foundation / tableau.
  const wasteTop = state.waste?.[state.waste.length - 1];
  if (wasteTop) {
    if (wasteTop.rank === foundationExpects(state, wasteTop.suit)) {
      moves.push({ kind: "waste-to-foundation", suit: wasteTop.suit });
    }
    for (let column = 0; column < tableau.length; column += 1) {
      const top = tableauTop(state, column);
      if (top && !top.faceUp) continue;
      if (canPlaceOnTableau(wasteTop, top?.card ?? null)) {
        moves.push({ kind: "waste-to-tableau", toColumn: column });
      }
    }
  }

  // 3. Tableau run → another column.
  for (let from = 0; from < tableau.length; from += 1) {
    const column = tableau[from];
    for (let index = 0; index < column.length; index += 1) {
      const pile = column[index];
      if (!pile.faceUp || !pile.card) continue;
      const run = faceUpRunFrom(state, from, pile.card);
      if (!run) continue;
      for (let to = 0; to < tableau.length; to += 1) {
        if (to === from) continue;
        const top = tableauTop(state, to);
        if (top && !top.faceUp) continue;
        if (canPlaceOnTableau(run[0], top?.card ?? null)) {
          moves.push({
            kind: "tableau-to-tableau",
            fromColumn: from,
            card: pile.card,
            toColumn: to,
          });
        }
      }
    }
  }

  // 4. Foundation → tableau (rarely useful, but legal Klondike).
  for (const suit of SUITS) {
    const pile = state.foundations?.[suit] ?? [];
    const card = pile[pile.length - 1];
    if (!card) continue;
    for (let column = 0; column < tableau.length; column += 1) {
      const top = tableauTop(state, column);
      if (top && !top.faceUp) continue;
      if (canPlaceOnTableau(card, top?.card ?? null)) {
        moves.push({ kind: "foundation-to-tableau", suit, toColumn: column });
      }
    }
  }

  // 5. Draw / redeal — always available while there is anything to turn over.
  if ((state.stock?.length ?? 0) > 0 || (state.waste?.length ?? 0) > 0) {
    moves.push({ kind: "draw" });
  }

  return moves;
}

/** The face-down card directly beneath a movable run head, if any. */
function hiddenCardBelow(state: SolitaireState, column: number, head: Card) {
  const col = state.tableau?.[column];
  if (!col) return null;
  const index = col.findIndex((pile) => pile.faceUp && sameCard(pile.card, head));
  if (index <= 0) return null;
  return col[index - 1];
}

/** True when making `move` would turn over a card the bot cannot currently see. */
function revealsHiddenCard(state: SolitaireState, move: SolitaireMove): boolean {
  if (move.kind === "tableau-to-foundation") {
    const below = hiddenCardBelow(state, move.fromColumn, move.card);
    return Boolean(below && !below.faceUp);
  }
  if (move.kind === "tableau-to-tableau") {
    const column = state.tableau?.[move.fromColumn] ?? [];
    const index = column.findIndex(
      (pile) => pile.faceUp && sameCard(pile.card, move.card),
    );
    return index > 0 && !column[index - 1].faceUp;
  }
  return false;
}

/** True when the move leaves its source tableau column empty. */
function emptiesColumn(state: SolitaireState, move: SolitaireMove): boolean {
  if (move.kind === "tableau-to-foundation") {
    return (state.tableau?.[move.fromColumn]?.length ?? 0) === 1;
  }
  if (move.kind === "tableau-to-tableau") {
    const column = state.tableau?.[move.fromColumn] ?? [];
    const index = column.findIndex(
      (pile) => pile.faceUp && sameCard(pile.card, move.card),
    );
    return index === 0;
  }
  return false;
}

/**
 * The immediate value of a move, using ONLY information a human can see.
 *
 * The profile's weights are what separate the bots: Rookie undervalues
 * foundations/empty columns and overvalues draws, so it drifts; Perfect values
 * every structural gain accurately.
 */
function immediateScore(
  state: SolitaireState,
  move: SolitaireMove,
  profile: SolitaireBotAiProfile,
): number {
  switch (move.kind) {
    case "tableau-to-foundation":
      return (
        1_200 * profile.foundationWeight +
        (revealsHiddenCard(state, move) ? 260 * profile.revealWeight : 0) +
        (emptiesColumn(state, move) ? 180 * profile.emptyColumnWeight : 0)
      );
    case "waste-to-foundation":
      return 1_080 * profile.foundationWeight;
    case "waste-to-tableau": {
      const top = tableauTop(state, move.toColumn);
      return (
        650 * profile.structureWeight +
        (top ? 0 : 90 * profile.emptyColumnWeight)
      );
    }
    case "tableau-to-tableau": {
      const column = state.tableau?.[move.fromColumn] ?? [];
      const index = column.findIndex(
        (pile) => pile.faceUp && sameCard(pile.card, move.card),
      );
      if (index < 0) return 0;
      const targetTop = tableauTop(state, move.toColumn);
      // Moving an entire column onto another empty column changes nothing.
      if (index === 0 && !targetTop) return 0;
      return (
        (revealsHiddenCard(state, move) ? 680 * profile.revealWeight : 0) +
        (emptiesColumn(state, move) ? 560 * profile.emptyColumnWeight : 0) +
        (targetTop ? 40 * profile.structureWeight : 0)
      );
    }
    case "foundation-to-tableau":
      // Pulling a card back off a foundation makes no permanent progress.
      return 0;
    case "draw":
    default: {
      // A draw is valued as an INFORMATION OPPORTUNITY, not by peeking at the
      // stock. The identity of the next card is never read here.
      const stockLeft = state.stock?.length ?? 0;
      return (stockLeft > 0 ? 70 : 12) * profile.drawWeight;
    }
  }
}

/**
 * Search visible moves, never through a hidden reveal or a draw.
 *
 * A move that flips a face-down card is scored on its immediate reveal value and
 * then stops: continuing from the resulting board would let the bot choose based
 * on a card it cannot see yet. A draw likewise stops at its information value.
 * That is the whole fairness rule, enforced in one place.
 */
function searchScore(
  state: SolitaireState,
  move: SolitaireMove,
  profile: SolitaireBotAiProfile,
  depth: number,
  budget: { nodes: number; max: number },
): number {
  const base = immediateScore(state, move, profile);
  if (
    depth <= 0 ||
    move.kind === "draw" ||
    revealsHiddenCard(state, move) ||
    budget.nodes >= budget.max
  ) {
    return base;
  }

  const applied = applyMove({ state, move });
  if (!applied.ok) return base;
  const next = applied.state as SolitaireState;
  if (next.completed) return base + 100_000;

  const children = legalMoves(next)
    .filter(
      (candidate) =>
        candidate.kind !== "draw" && !revealsHiddenCard(next, candidate),
    )
    .map((candidate) => ({ move: candidate, score: immediateScore(next, candidate, profile) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, profile.beamWidth));

  let best = 0;
  for (const child of children) {
    budget.nodes += 1;
    if (budget.nodes >= budget.max) break;
    best = Math.max(
      best,
      searchScore(next, child.move, profile, depth - 1, budget),
    );
  }
  return base + profile.planningWeight * best;
}

/**
 * How good a move is under the Perfect weights. Exported for tests and for
 * callers that need a single "objective" score independent of a bot's biases.
 */
export function scoreMove(state: SolitaireState, move: SolitaireMove): number {
  return immediateScore(state, move, SOLITAIRE_BOT_BY_ID.perfect.ai);
}

/**
 * Score a move with a bot's OWN search profile, from a fresh node budget.
 *
 * This is the full decision value — immediate weights plus the visible
 * lookahead that profile can afford — not just its first-ply heuristic. Tests
 * use it with `"perfect"` as the strongest fair objective: Perfect is the bot
 * that maximises exactly this score, and every weaker choice can be measured
 * as regret against it. The information rule is the same one `searchScore`
 * enforces, so evaluating a move here never reveals a hidden card.
 */
export function evaluateMoveForBot(
  state: SolitaireState,
  move: SolitaireMove,
  difficulty: unknown = "perfect",
): number {
  const profile = solitaireBotFor(difficulty).ai;
  return searchScore(state, move, profile, profile.searchDepth, {
    nodes: 0,
    max: profile.searchBudget,
  });
}

/** A monotone "how far along is this board" key, for the stagnation guard. */
function progressKey(state: SolitaireState): number {
  let faceDown = 0;
  for (const column of state.tableau ?? []) {
    for (const pile of column) if (!pile.faceUp) faceDown += 1;
  }
  // Revealed cards count as progress: faceDown only ever shrinks in honest play,
  // so `28 - faceDown` grows as the tableau opens up.
  return foundationCountOf(state) * 1_000 + (28 - faceDown);
}

/** Cards on the foundations, locally (keeps this module free of store deps). */
function foundationCountOf(state: SolitaireState): number {
  const f = state.foundations ?? ({} as SolitaireState["foundations"]);
  return (
    (f.spades?.length ?? 0) +
    (f.hearts?.length ?? 0) +
    (f.diamonds?.length ?? 0) +
    (f.clubs?.length ?? 0)
  );
}

/**
 * The bot's next move, or null when the board has none.
 *
 * `random` is injectable so the tier behaviour is testable. The result is
 * ALWAYS a member of `legalMoves(state)` — a slip only picks a lower-scoring
 * legal move, never an illegal one.
 */
export function chooseAiMove({
  state,
  difficulty = "normal",
  botId,
  random = Math.random,
}: {
  state: SolitaireState;
  /** Legacy tier (`easy|normal|hard`) or a bot id. */
  difficulty?: unknown;
  /** Explicit bot id; wins over `difficulty`. */
  botId?: unknown;
  random?: () => number;
}): SolitaireMove | null {
  const moves = legalMoves(state);
  if (moves.length === 0) return null;

  const bot: SolitaireBot = solitaireBotFor(botId ?? difficulty);
  const profile = bot.ai;
  const budget = { nodes: 0, max: profile.searchBudget };
  const scored = moves
    .map((move) => ({
      move,
      score: searchScore(state, move, profile, profile.searchDepth, budget),
    }))
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (!best) return moves[0];
  // Perfect never rolls: `mistakeRate` 0 makes the first branch unconditional.
  if (profile.mistakeRate <= 0 || random() >= profile.mistakeRate) {
    return best.move;
  }

  // Deliberate, believable slip: fall through to a worse legal move, but only
  // among the profile's top options and never below its quality floor.
  let worse = scored.slice(1, 1 + Math.max(0, profile.slipPool));
  const floor = best.score * profile.slipFloor;
  const usable = worse.filter((option) => option.score >= floor);
  if (usable.length > 0) worse = usable;
  if (worse.length === 0) return best.move;
  return worse[Math.floor(random() * worse.length) % worse.length].move;
}

/**
 * How many moves in a row that change nothing before the planner gives up.
 *
 * A full stock pass is 24 draws; several unproductive passes in a row mean the
 * deal cannot be advanced by this strategy, so the bot stops instead of cycling
 * the same stock for the rest of the match. Generous enough that a genuine but
 * slow rearrangement is never cut short.
 */
export const AI_STAGNATION_LIMIT = 72;

/**
 * Plan the bot's moves from `state`, up to `maxMoves`.
 *
 * This is what the store runs each read: it applies the bot's own heuristic in
 * one pass and returns the sequence — so the store only has to persist the
 * result. The planner stops when the board is solved, when no legal move
 * remains, or when a long run of moves has changed nothing (an un-winnable
 * deal). It never mutates `state`.
 */
export function planAiMoves({
  state,
  difficulty = "normal",
  maxMoves = 64,
  random = Math.random,
}: {
  state: SolitaireState;
  difficulty?: unknown;
  maxMoves?: number;
  random?: () => number;
}): { moves: SolitaireMove[]; state: SolitaireState; completed: boolean; stuck: boolean } {
  const moves: SolitaireMove[] = [];
  let current = state;
  let best = progressKey(current);
  let stagnant = 0;
  const bot = solitaireBotFor(difficulty);
  // `stuck` means the planner stopped because the BOARD has nothing left to
  // give — no legal move at all, or a long run of moves that changed nothing.
  // It deliberately stays false when the loop merely hit `maxMoves`: a bot that
  // is simply behind schedule on the clock is not stuck. The store re-deals a
  // bot board only on `stuck && !completed`.
  let stuck = false;

  while (moves.length < Math.max(1, Math.floor(maxMoves)) && !current.completed) {
    const move = chooseAiMove({ state: current, botId: bot.id, random });
    if (!move) {
      stuck = true;
      break;
    }
    const applied = applyMove({ state: current, move });
    if (!applied.ok) {
      stuck = true;
      break;
    }
    current = applied.state as SolitaireState;
    moves.push(move);

    const key = progressKey(current);
    if (key > best) {
      best = key;
      stagnant = 0;
    } else {
      stagnant += 1;
      if (stagnant >= AI_STAGNATION_LIMIT) {
        stuck = true;
        break;
      }
    }
  }

  return { moves, state: current, completed: Boolean(current.completed), stuck };
}

/**
 * Follow a PROVEN solution line from wherever the bot's board is.
 *
 * `line` is `solveDealLine(deal)` — real engine moves, verified from the deal's
 * opening position. Every applied move is exactly one ply (`applyMove`), so a
 * bot that has always followed the line sits at `state.ply` and the next move is
 * `line[state.ply]`.
 *
 * Returns null — never a guess — when there is no line, the cursor is past its
 * end, or a line move is refused (a board that is off the line, e.g. one the
 * old heuristic played before this existed). The caller then falls back to
 * `planAiMoves`, so a desync can never invent an illegal move.
 */
export function planAiSolution({
  state,
  line,
  maxMoves = 64,
}: {
  state: SolitaireState;
  line: readonly SolitaireMove[] | null | undefined;
  maxMoves?: number;
}): { moves: SolitaireMove[]; state: SolitaireState; completed: boolean; stuck: boolean } | null {
  if (!state || state.completed || !line || line.length === 0) return null;

  const cursor = Math.max(0, Math.trunc(Number(state.ply) || 0));
  if (cursor >= line.length) return null;

  const moves: SolitaireMove[] = [];
  let current = state;
  const end = Math.min(cursor + Math.max(1, Math.floor(maxMoves)), line.length);

  for (let index = cursor; index < end && !current.completed; index += 1) {
    const applied = applyMove({ state: current, move: line[index] });
    // Off the line: report nothing and let the caller use the heuristic from
    // the board it actually has.
    if (!applied.ok) return null;
    current = applied.state as SolitaireState;
    moves.push(line[index]);
  }

  return { moves, state: current, completed: Boolean(current.completed), stuck: false };
}

/** The suit of the top waste card, exposed for tests and diagnostics. */
export function wasteTopSuit(state: SolitaireState): Suit | null {
  const top = state.waste?.[state.waste.length - 1];
  return top ? top.suit : null;
}
