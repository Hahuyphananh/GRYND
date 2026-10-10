/**
 * Barricade — the free-practice opponent.
 *
 * Three tiers on the platform's shared scale (`easy | normal | hard`, see
 * `../aiDifficulty`), all of them playing through the SAME rules engine as the
 * human: every candidate is a `Position`/`WallPlacement` the engine accepts, and
 * whatever this module returns is an action `applyAction` will accept. No rule
 * is re-derived here — movement, jumps, wall conflicts, path preservation and
 * inventory all come from `./rules`.
 *
 * That is why there is no separate "bot rules" surface anywhere: the bot can
 * only ever do what a human could do from the same position.
 *
 * WHAT EACH TIER DOES
 *
 *   * `easy`   — walks the pawn towards the goal (the shortest path through the
 *                current barricades) and only drops a barricade when the
 *                opponent is clearly ahead, never more than a few candidates
 *                deep. It also slips often (see `AI_SKILL`), so a beginner can
 *                beat it.
 *   * `normal` — prices BOTH pawns' shortest paths and uses barricades when the
 *                tempo they buy the opponent costs more than the barricade is
 *                worth. It looks one move ahead, not a sequence.
 *   * `hard`   — searches a BOUNDED tree: its own best few actions, the
 *                opponent's best few answers, scored on path distances, the
 *                barricade reserves and the opponent's threats, with a node
 *                budget and a wall-clock deadline so a turn can never stall the
 *                board. It still slips a little, so it stays beatable.
 *
 * COST / WHY THE UI NEVER FREEZES
 *
 * The expensive call in the engine is `legalWalls` (one breadth-first search per
 * candidate barricade). This module never calls it: it derives a SMALL set of
 * strategically relevant barricade slots from the opponent's own shortest path
 * (so they are the walls that actually matter) and validates each one with
 * `classifyWall`, which is the same authoritative check. A whole hard turn is
 * tens of leaf evaluations over 81 squares — measured in single-digit
 * milliseconds in `tests/barricade-ai.test.mjs`, which asserts the bound.
 *
 * `random` is injectable so a match can be replayed exactly in a test.
 */

import {
  AI_SKILL,
  chooseAiOption,
  coerceAiDifficulty,
  type AiDifficulty,
} from "../aiDifficulty";
import { ACTION_TYPES, ORIENTATIONS, WALL_SLOTS } from "./constants";
import {
  applyAction,
  classifyWall,
  distanceToGoal,
  goalRowFor,
  isStepBlocked,
  isValidPosition,
  legalMoves,
  otherSeat,
  positionKey,
  wallBlocksStep,
  wallKey,
} from "./rules";
import type {
  BarricadeState,
  LegalAction,
  MoveKind,
  Position,
  Seat,
  WallPlacement,
} from "./types";

/** Hard tier's ceiling on evaluated positions per turn (a hard stop, not a target). */
export const AI_MAX_NODES = 320;
/** Hard tier's wall-clock ceiling per turn, in milliseconds. */
export const AI_DEADLINE_MS = 45;
/** How many of its own actions the hard tier will consider. */
const HARD_ROOT_WIDTH = 8;
/** How many answers from the opponent the hard tier will consider. */
const HARD_REPLY_WIDTH = 4;
/** Barricade candidates taken from the opponent's shortest path, per tier. */
const WALL_CANDIDATE_LIMIT = { easy: 4, normal: 12, hard: 12 } as const;
/** What spending one of your own barricades is worth, in "steps of tempo". */
const WALL_COST = { easy: 0, normal: 0.55, hard: 0.4 } as const;
/** How much a barricade still in reserve is worth, per barricade. */
const RESERVE_VALUE = 0.12;

export interface AiTurnOptions {
  /** Injectable randomness — omit for `Math.random`. */
  random?: () => number;
  /** Milliseconds budget for a hard turn (tests lower it to prove the bound). */
  deadlineMs?: number;
}

/* -------------------------------------------------------------------------- *
 * Reading the board (through the engine only)
 * -------------------------------------------------------------------------- */

const STEP_VECTORS: ReadonlyArray<Position> = [
  { col: 0, row: 1 },
  { col: 0, row: -1 },
  { col: -1, row: 0 },
  { col: 1, row: 0 },
];

/**
 * The squares of a shortest route from `seat`'s pawn to its goal row, or `[]`
 * when the pawn is cut off. Walked with the engine's own groove test
 * (`isStepBlocked`), so "a route" means exactly what the rules mean by it.
 */
export function shortestRoute(state: BarricadeState, seat: Seat): Position[] {
  const goal = goalRowFor(seat);
  const start = state.pawns[seat];
  if (start.row === goal) return [start];
  const previous = new Map<string, Position | null>([[positionKey(start), null]]);
  let frontier: Position[] = [start];
  let goalCell: Position | null = null;
  while (frontier.length > 0 && !goalCell) {
    const next: Position[] = [];
    for (const cell of frontier) {
      for (const step of STEP_VECTORS) {
        const to = { col: cell.col + step.col, row: cell.row + step.row };
        if (!isValidPosition(to)) continue;
        if (isStepBlocked(state.walls, cell, to)) continue;
        const key = positionKey(to);
        if (previous.has(key)) continue;
        previous.set(key, cell);
        if (to.row === goal) {
          goalCell = to;
          break;
        }
        next.push(to);
      }
      if (goalCell) break;
    }
    frontier = next;
  }
  if (!goalCell) return [];
  const route: Position[] = [];
  let cursor: Position | null = goalCell;
  while (cursor) {
    route.push(cursor);
    cursor = previous.get(positionKey(cursor)) ?? null;
  }
  return route.reverse();
}

/**
 * The barricade slots that would block one orthogonal step — at most two, one
 * on either side of the groove the step crosses. Also reachable by scanning all
 * 128 slots, which is what makes this the cheap way to ask the question.
 */
function slotsBlockingStep(from: Position, to: Position): WallPlacement[] {
  const slots: WallPlacement[] = [];
  const pushIfSlot = (col: number, row: number, orientation: WallPlacement["orientation"]) => {
    if (col < 0 || row < 0 || col >= WALL_SLOTS || row >= WALL_SLOTS) return;
    const wall = { col, row, orientation };
    // Only keep it when it really lies across this step (no geometry guessed).
    if (wallBlocksStep(wall, from, to)) slots.push(wall);
  };
  if (from.col !== to.col) {
    const boundary = Math.min(from.col, to.col);
    pushIfSlot(boundary, from.row, ORIENTATIONS[1]);
    pushIfSlot(boundary, from.row - 1, ORIENTATIONS[1]);
  } else {
    const boundary = Math.min(from.row, to.row);
    pushIfSlot(from.col, boundary, ORIENTATIONS[0]);
    pushIfSlot(from.col - 1, boundary, ORIENTATIONS[0]);
  }
  return slots;
}

/**
 * The barricade placements worth considering this turn: the ones that cut the
 * opponent's current route, earliest first (nearest their pawn, so the route has
 * to change soonest), validated by the engine before they are offered.
 */
export function wallCandidates(
  state: BarricadeState,
  seat: Seat,
  limit: number,
): WallPlacement[] {
  if (state.wallsRemaining[seat] <= 0) return [];
  const route = shortestRoute(state, otherSeat(seat));
  const seen = new Set<string>();
  const candidates: WallPlacement[] = [];
  const steps = Math.max(0, route.length - 1);
  for (let index = 0; index < steps && candidates.length < limit; index += 1) {
    for (const wall of slotsBlockingStep(route[index], route[index + 1])) {
      if (candidates.length >= limit) break;
      const key = wallKey(wall);
      if (seen.has(key)) continue;
      seen.add(key);
      // The engine decides whether the placement is legal at all (inventory,
      // overlap, crossing, path preservation) — never a copy of those rules.
      if (!classifyWall(state, seat, wall).ok) continue;
      candidates.push(wall);
    }
  }
  return candidates;
}

/** One action, with the state it produces — the unit every tier scores. */
interface Scored {
  action: LegalAction;
  next: BarricadeState;
  /** Steps of tempo won: their distance grows, ours does not. */
  gain: number;
  kind: MoveKind | "wall";
}

/**
 * Apply one action for `actor` and measure what it did to the race:
 * `gain = (their distance after − their distance before) − (our distance after − our distance before)`.
 * Higher is better for `actor`; negative means the action cost more than it won.
 */
function evaluate(state: BarricadeState, actor: Seat, action: LegalAction): Scored {
  const opponent = otherSeat(actor);
  const beforeOpponent = distanceToGoal(state, opponent);
  const beforeSelf = distanceToGoal(state, actor);
  const next = applyAction(state, actor, action);
  const gained = distanceToGoal(next, opponent) - beforeOpponent;
  const lost = distanceToGoal(next, actor) - beforeSelf;
  return {
    action,
    next,
    gain: gained - lost,
    kind: action.type === ACTION_TYPES.WALL ? "wall" : action.kind,
  };
}

/** What a finished match is worth, from the winner's point of view. */
const TERMINAL_VALUE = 1000;
/** What it costs to leave the opponent on the brink of winning with the move. */
const THREAT_PENALTY = 50;

/**
 * Positional value of a state, from `actor`'s point of view: the lead in steps
 * to the goal, plus what its barricade reserve is worth against the opponent's.
 *
 * A finished match is worth everything and a lost one nothing, so no tier can
 * prefer a clever barricade over the move that actually wins the game.
 */
function positionValue(state: BarricadeState, actor: Seat): number {
  if (state.status !== "playing") {
    return state.winner === actor ? TERMINAL_VALUE : -TERMINAL_VALUE;
  }
  const opponent = otherSeat(actor);
  const opponentDistance = distanceToGoal(state, opponent);
  const lead = opponentDistance - distanceToGoal(state, actor);
  const reserves = state.wallsRemaining[actor] - state.wallsRemaining[opponent];
  // If the opponent is on turn and one step from its goal row, this position is
  // about to be lost unless the action that produced it was itself winning — a
  // threat the one-ply tiers have to price, or they race straight into it.
  const threat =
    state.turn === opponent && opponentDistance <= 1 ? -THREAT_PENALTY : 0;
  return lead + reserves * RESERVE_VALUE + threat;
}

/* -------------------------------------------------------------------------- *
 * The turn
 * -------------------------------------------------------------------------- */

/**
 * Choose this turn's action for `seat` at `difficulty`, or `null` when there is
 * nothing to choose — the match is over, or it is not that seat's turn. The
 * result is always one of the actions the rules engine itself would offer for
 * that seat, so `applyAction` accepts it.
 */
export function chooseAiAction(
  state: BarricadeState,
  seat: Seat,
  difficulty: AiDifficulty | string,
  options: AiTurnOptions = {},
): LegalAction | null {
  if (state.status !== "playing" || seat !== state.turn) return null;
  const random = options.random ?? Math.random;
  const tier = coerceAiDifficulty(difficulty);
  const deadline = Date.now() + (options.deadlineMs ?? AI_DEADLINE_MS);

  const moves = legalMoves(state, seat).map((action) => evaluate(state, seat, action));
  const candidates = wallCandidates(state, seat, WALL_CANDIDATE_LIMIT[tier]).map((wall) =>
    evaluate(state, seat, { type: ACTION_TYPES.WALL, wall }),
  );
  const played = moves.concat(candidates);
  if (played.length === 0) return null;

  const skill = AI_SKILL[tier];
  const wallCost = WALL_COST[tier];  if (tier === "easy") {
    // Walk towards the goal; a barricade only when clearly behind and only from
    // the small candidate set that actually cuts the opponent's route.
    const cheapWalls = candidates
      .filter((entry) => entry.gain >= 1)
      .sort((a, b) => b.gain - a.gain || a.next.ply - b.next.ply);
    const behindBy = distanceToGoal(state, otherSeat(seat)) - distanceToGoal(state, seat);
    if (cheapWalls.length > 0 && behindBy <= -2 && state.wallsRemaining[seat] > 3) {
      return cheapWalls[0].action;
    }
    if (moves.length > 0) {
      // Progress: how much closer the pawn is than the opponent's, barricades
      // still in hand, and the win if the move reaches the goal row.
      const scoreOf = (entry: Scored) => positionValue(entry.next, seat);
      return chooseAiOption(tier, moves, scoreOf, random, 0)?.action ?? moves[0].action;
    }
    // Nowhere to walk (boxed in by the opponent and the barricades): the only
    // thing left is to spend one.
    const best = candidates.slice().sort((a, b) => b.gain - a.gain)[0];
    return best ? best.action : null;
  }

  if (tier === "normal") {
    const scoreOf = (entry: Scored) =>
      positionValue(entry.next, seat) - (entry.kind === "wall" ? wallCost : 0);
    const options = played.slice().sort((a, b) => scoreOf(b) - scoreOf(a));
    return chooseAiOption(tier, options, scoreOf, random, 0)?.action ?? options[0]?.action ?? null;
  }

  // ── hard ────────────────────────────────────────────────────────────────
  // Bounded two-ply search: our best few actions, answered by their best few,
  // scored on distances, reserves and the threat their answer creates. Nodes and
  // wall-clock are both capped, so this can never stall a board render.
  let nodes = 0;
  const roots = played
    .slice()
    .sort((a, b) => b.gain - a.gain)
    .slice(0, HARD_ROOT_WIDTH);
  const hardScore = new Map<LegalAction, number>();

  for (const root of roots) {
    let worst = positionValue(root.next, seat) - (root.kind === "wall" ? wallCost : 0);
    // A move that ends the match has no answer to model (and no legal reply).
    const replies = root.next.status === "playing" ? replyMoves(root.next, seat) : [];
    for (const reply of replies) {
      if (nodes >= AI_MAX_NODES || Date.now() > deadline) break;
      nodes += 1;
      const after = applyAction(root.next, otherSeat(seat), reply);
      // The opponent picks what is worst for us; reserve terms still count.
      worst = Math.min(worst, positionValue(after, seat));
    }
    hardScore.set(root.action, worst);
  }

  const scoreOf = (entry: Scored) => hardScore.get(entry.action) ?? positionValue(entry.next, seat);
  // Keep the tier's slip policy (AI_SKILL.hard: a small mistake rate over the top
  // three options) so even the hardest bot is beatable.
  return chooseAiOption(tier, roots, scoreOf, random, 0)?.action ?? roots[0]?.action ?? null;
}

/**
 * The few answers worth modelling for a bounded search: the opponent's moves
 * (their escape from our barricade) plus the one or two barricades that would
 * punish us hardest. Deliberately tiny — this is a sanity check on our plan, not
 * a second full search.
 */
function replyMoves(state: BarricadeState, actor: Seat): LegalAction[] {
  const opponent = otherSeat(actor);
  const moves: LegalAction[] = legalMoves(state, opponent)
    .map((action) => ({ action, gain: evaluate(state, opponent, action).gain }))
    .sort((a, b) => b.gain - a.gain)
    .slice(0, HARD_REPLY_WIDTH - 1)
    .map((entry) => entry.action);
  const punishingWall = wallCandidates(state, opponent, 2)
    .map((wall) => evaluate(state, opponent, { type: ACTION_TYPES.WALL, wall }))
    .filter((entry) => entry.gain > 0)
    .sort((a, b) => b.gain - a.gain)[0];
  return punishingWall ? moves.concat(punishingWall.action) : moves;
}

/** What the picker shows for each tier on the practice page. */
export const BARRICADE_TIER_HINTS: Record<AiDifficulty, string> = {
  easy: "Walks towards the goal and barricades only when it falls behind — it misses things.",
  normal: "Weighs both pawns' shortest paths and spends barricades when they actually slow you down.",
  hard: "Looks a move ahead, prices its barricade reserve and answers your threats. Still slips occasionally.",
};

/** Convenience for tests and for a future server-side bot: is this seat the bot? */
export function isAiSeat(seat: Seat): boolean {
  return seat === "player2";
}
