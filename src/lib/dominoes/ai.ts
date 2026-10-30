// src/lib/dominoes/ai.ts
//
// The Dominoes practice bot.
//
// PURE and deterministic under an injected `random`, exactly like the other
// GRYND AIs: the store passes the authoritative state and the bot's seat and
// gets back ONE legal action (play / draw / pass). No database, no I/O — and
// no peeking: the chooser reads only the bot's own hand and the PUBLIC chain,
// never the human's hand or the order of the pile.
//
// IT NEVER RE-IMPLEMENTS A RULE. `legalActions` decides what the turn may be,
// `applyAction` is run on each candidate to score the resulting position, and
// a play only exists in the menu when the engine already accepts it. So the bot
// cannot play a tile it does not hold, cannot skip a playable tile to draw, and
// cannot pass while the pile still has tiles.
//
// TIERS come from the shared scale (src/lib/aiDifficulty.ts). The bot's score
// is a simple, honest heuristic — shed high pips, keep tiles that still fit the
// open ends — and the tier decides how often it settles for a worse option:
//
//   * easy   — blunders often, so a beginner can beat it.
//   * normal — takes the best option most of the time.
//   * hard   — almost never slips (still not perfect, by design).
//
// The draw/pass case is FORCED by the engine, so no tier can choose it.

import { chooseAiOption, coerceAiDifficulty, type AiDifficulty } from "../aiDifficulty";
import { ACTION_TYPES, MATCH_STATUS } from "./constants";
import {
  applyAction,
  legalActions,
  pipsInHand,
  tilePips,
  tileValues,
} from "./rules";
import type { DominoesAction, DominoesState, LegalAction, Seat, TileId } from "./types";

/** A winning play outranks every heuristic difference. */
const WIN_SCORE = 1_000_000;

/** True when `tile` matches at least one of the open values (or the chain is empty). */
function fitsOpenEnds(tile: TileId, open: readonly number[]): boolean {
  if (open.length === 0) return true;
  const [high, low] = tileValues(tile);
  return open.some((value) => value === high || value === low);
}

/**
 * Score ONE candidate play by the position it produces.
 *
 * Higher is better. The three terms are the whole strategy, deliberately:
 *
 *   1. `tilePips * 10`   — shed the heavy tiles: a blocked round pays the
 *                          OPPONENT the pips you are left holding, so the heavy
 *                          tiles are what that payout is made of.
 *   2. `playable * 4`    — keep tiles that still fit the two open ends. A move
 *                          that strands the bot's own hand is worth less even
 *                          if it sheds a high tile.
 *   3. `- pipsLeft`      — between otherwise equal moves, keep the lighter hand
 *                          (and prefer the play that empties it).
 *
 * A play that wins the round on the engine's own verdict (empties the hand, or
 * blocks with the higher pip total) short-circuits to `WIN_SCORE`; one that
 * hands the round to the opponent is refused. The weights are the bot's
 * difficulty, not a second copy of the rule.
 */
function scorePlay(state: DominoesState, seat: Seat, action: LegalAction): number {
  if (action.type !== ACTION_TYPES.PLAY) return 0;

  const next = applyAction(state, seat, action);
  if (next.status === MATCH_STATUS.FINISHED && next.winner === seat) return WIN_SCORE;
  if (next.status === MATCH_STATUS.FINISHED) return -WIN_SCORE;

  const remaining = next.hands[seat] ?? [];
  const open = [next.openEnds.left, next.openEnds.right].filter(
    (value): value is number => value !== null && value !== undefined,
  );
  const playable = remaining.filter((tile) => fitsOpenEnds(tile, open)).length;
  const pipsLeft = pipsInHand(remaining);

  return tilePips(action.tile) * 10 + playable * 4 - pipsLeft;
}

/**
 * Choose the bot's action for the position it is on turn in, or null when the
 * match is over / it is not the bot's turn.
 *
 * `random` is injectable so a test can pin both the deal and the decisions.
 */
export function chooseAiAction({
  state,
  seat,
  difficulty,
  random = Math.random,
}: {
  state: DominoesState | null | undefined;
  seat: Seat;
  difficulty?: unknown;
  random?: () => number;
}): DominoesAction | null {
  if (!state || state.status !== MATCH_STATUS.PLAYING) return null;
  if (state.turn !== seat) return null;

  const options = legalActions(state);
  if (options.length === 0) return null;

  const plays = options.filter((option) => option.type === ACTION_TYPES.PLAY);
  // No legal play: the engine offers exactly one draw (pile not empty) or one
  // pass (pile empty). It is forced — every tier takes it.
  if (plays.length === 0) return options[0];

  const tier: AiDifficulty = coerceAiDifficulty(difficulty);
  return (
    chooseAiOption<LegalAction>(
      tier,
      plays,
      (option) => scorePlay(state, seat, option),
      random,
    ) ?? plays[0]
  );
}
