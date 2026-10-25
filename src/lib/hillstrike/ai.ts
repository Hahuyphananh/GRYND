/**
 * Hillstrike — the practice bot.
 *
 * ── WHAT THE DIFFICULTY CHANGES ────────────────────────────────────────────
 * ONLY the bot's decision: how wide a grid of angles/powers it searches, how
 * finely it refines the best one, how many of its best lines it resolves through
 * the full state transition before committing, and how often the shared skill
 * policy makes it pick a worse line than the best it found.
 *
 * It deliberately does NOT touch:
 *   • the projectile (both seats fire the same spec — see ./constants),
 *   • the physics (it plans with the SAME `simulateShot` the match uses),
 *   • damage, HP, terrain, collapse, drives or the turn rules (all ./rules),
 *   • anything hidden: Hillstrike is perfect information, and the bot reads only
 *     the public match state a human's board renders (see AI_PUBLIC_STATE_KEYS).
 * It never receives extra damage, a stronger projectile or a private sim.
 *
 * ── HOW IT DECIDES ─────────────────────────────────────────────────────────
 * 1. BUILD a deterministic grid of legal shots for its seat's forward arc.
 * 2. VALIDATE each with the engine's own `validateAction` — a candidate the
 *    match would refuse is not an option, ever.
 * 3. SIMULATE each with the engine's `simulateShot`, scoring the result it
 *    resolved: a direct hit on the defender, else a structural hit close to the
 *    defender (breaking cover is how a shielded player becomes hittable), else
 *    ground. Distance to the defender breaks ties toward the useful line.
 * 4. RESOLVE the top few through `applyAction` — the same state transition a
 *    human press of Fire runs — so the bot can see the real outcome: a knockout
 *    is a won match, and a shot that fells its OWN cover while it is low on HP
 *    is scored down, badly, because that cover is what keeps it alive.
 * 5. SPEND THE ACTION WELL when a shot is not: if no line even reaches the
 *    enemy, the bot drives forward (or, when it is hurt, builds cover) instead
 *    of throwing the action away; with two actions in hand it will also drive
 *    first and shoot second rather than take a bare crater in the open.
 * 6. SLIP through the ONE shared tier policy (`chooseAiOption`), which is what
 *    makes a weak tier beatable rather than merely short-sighted. The slip only
 *    applies to the aim — a drive or a build is always the deliberate choice.
 *
 * ── COST ───────────────────────────────────────────────────────────────────
 * Bounded by construction: at most 21 / 70 / 190 grid simulations, plus (hard
 * only) ≤ 63 refinement simulations, plus at most `topK` full shot resolutions,
 * plus at most one probe each for the move/build actions. `aiCandidateBudget`
 * states the ceiling, and the whole plan is synchronous work in the tens of
 * milliseconds.
 */

import { chooseAiOption, type AiDifficulty } from "../aiDifficulty";
import {
  ACTION_TYPES,
  IMPACT_KINDS,
  MATCH_STATUS,
  MAX_HP,
  POWER_MAX,
  SEATS,
} from "./constants";
import {
  damageForDistance,
  normalizeShot,
  otherSeat,
  simulateShot,
} from "./physics";
import {
  applyAction,
  buildPlacementFor,
  hpOf,
  moveTargetFor,
  validateAction,
} from "./rules";
import type {
  HillstrikeAction,
  HillstrikeState,
  Impact,
  Seat,
  ShotInput,
} from "./types";

/** One line per tier, shown under the shared difficulty picker. */
export const HILLSTRIKE_TIER_HINTS: Record<AiDifficulty, string> = {
  easy:
    "Fires a quick, coarse lob — it often misjudges the arc, and rarely finds a shielded gunner.",
  normal:
    "Solves the arc on a fine grid, breaks the cover in front of you, and only sometimes picks a worse line.",
  hard: "Sweeps the whole aim space, breaks your tower down deliberately, resolves its best lines and almost never slips.",
};

/**
 * The public match state a bot is allowed to read.
 *
 * Hillstrike is perfect information: every field below is one a human's board
 * renders or a client is sent (terrain, both towers, both standing positions,
 * both HP pools, the volley counters, the turn, the recorded last action). There
 * is deliberately NO hidden field, and this list is the complete state surface —
 * the bot test fails if the bot ever reads a key that is not declared here, so a
 * future hidden field (a concealed aim, a private modifier) cannot be used by it.
 */
export const AI_PUBLIC_STATE_KEYS = Object.freeze([
  "fieldVersion",
  "seed",
  "status",
  "openingSeat",
  "turn",
  "turnIndex",
  "actionsRemaining",
  "openingShotPending",
  "hp",
  "battlefield",
  "projectile",
  "winner",
  "terminationReason",
  "lastAction",
] as const);

export interface HillstrikeAiPlan {
  /** Degrees between grid angles. */
  readonly angleStep: number;
  /** The power values sampled at every angle. */
  readonly powers: readonly number[];
  /** True when the tier refines around its best coarse line. */
  readonly refine: boolean;
  /** How many of its best lines it resolves through the full state transition. */
  readonly topK: number;
}

/**
 * The aim grids. Every tier fires the SAME projectile; a coarser grid simply
 * means the bot has fewer lines to choose from, which is what makes it beatable.
 * The refinement (hard only) is extra SEARCH, never a stronger shot.
 */
export const AI_SEARCH_PLANS: Readonly<Record<AiDifficulty, HillstrikeAiPlan>> =
  Object.freeze({
    easy: Object.freeze({ angleStep: 12, powers: Object.freeze([50, 75, 100]), refine: false, topK: 2 }),
    normal: Object.freeze({
      angleStep: 6,
      powers: Object.freeze([45, 60, 75, 90, 100]),
      refine: false,
      topK: 4,
    }),
    hard: Object.freeze({
      angleStep: 3,
      powers: Object.freeze([40, 50, 60, 70, 80, 90, 100]),
      refine: true,
      topK: 6,
    }),
  });

/** Refinement window for a tier that refines (degrees / power points). */
const REFINE = Object.freeze({
  angleRadius: 2,
  angleStep: 0.5,
  powerRadius: 6,
  powerStep: 2,
});

/**
 * The forward arc, defined ONCE for player1 and MIRRORED for player2.
 *
 * This matters for fairness measurement: a hand-written second arc ("94…176")
 * sampled a different set of angles than the mirror of the first, so the two
 * seats were not searching the same game. Deriving one from the other makes
 * `angle(player2) = 180 - angle(player1)` exact, which is the property the
 * fairness sweep relies on.
 */
const ARC_PLAYER1 = Object.freeze({ from: 4, to: 86 });

/** The seat's own search arc, in that seat's absolute angle convention. */
function forwardArc(seat: Seat): { from: number; to: number } {
  return seat === "player1"
    ? ARC_PLAYER1
    : { from: 180 - ARC_PLAYER1.to, to: 180 - ARC_PLAYER1.from };
}

/** The absolute angle that mirrors a player1 angle for the other seat. */
function mirrorAngle(seat: Seat, angle: number): number {
  return seat === "player1" ? angle : 180 - angle;
}

/** The tier plan, with an unknown tier falling back to `normal`. */
function planFor(difficulty: AiDifficulty): HillstrikeAiPlan {
  return AI_SEARCH_PLANS[difficulty] ?? AI_SEARCH_PLANS.normal;
}

/**
 * The tier's deterministic candidate grid, in a stable order (angle ascending,
 * then power ascending). Exported so tests can assert the search is bounded and
 * stays inside the seat's arc.
 */
export function aiAimGrid(difficulty: AiDifficulty, seat: Seat): ShotInput[] {
  const plan = planFor(difficulty);
  const shots: ShotInput[] = [];
  for (let angle = ARC_PLAYER1.from; angle <= ARC_PLAYER1.to; angle += plan.angleStep) {
    const seatAngle = mirrorAngle(seat, angle);
    for (const power of plan.powers) shots.push({ angleDeg: seatAngle, power });
  }
  return shots;
}

/**
 * The most candidate simulations one plan can ever run: the grid, the
 * refinement window (only the tiers that refine), the top-K re-resolutions and
 * the single probe of each non-shoot action.
 */
export function aiCandidateBudget(difficulty: AiDifficulty): number {
  const plan = planFor(difficulty);
  const grid = aiAimGrid(difficulty, "player1").length;
  const refinement = plan.refine ? refinementGridCount("player1") : 0;
  return grid + refinement + plan.topK + 2;
}

/** How many shots a refinement window can produce, measured mid-arc. */
function refinementGridCount(seat: Seat): number {
  const arc = forwardArc(seat);
  return refinementGrid(
    { angleDeg: (arc.from + arc.to) / 2, power: Math.round(POWER_MAX / 2) },
    seat,
  ).length;
}

/** A scored candidate, and everything the tier needed to score it. */
export interface AiShotScore {
  readonly shot: ShotInput;
  readonly impact: Impact;
  /** Distance from the impact to the defender's body. */
  readonly distance: number;
  readonly score: number;
  /** True when this shot would take the defender's last HP. */
  readonly lethal: boolean;
  /** HP this shot would take off the defender, from the flight distance. */
  readonly damage: number;
  readonly enemyBlocksLost: number;
  readonly ownBlocksLost: number;
}

/**
 * Scoring weights. They are relative preferences, not damage: the engine decides
 * what a hit does, this table only decides which already-legal action the bot
 * prefers. A direct hit always beats breaking cover; breaking cover always beats
 * a bare crater in the open.
 */
const SCORE = Object.freeze({
  DIRECT_HIT: 10_000,
  MATCH_WIN: 100_000,
  BLOCK_HIT: 2_500,
  GROUND_HIT: 1_200,
  MISS: -6_000,
  SELF_HIT: -20_000,
  CLOSENESS_MAX: 600,
  ENEMY_BLOCK_DESTROYED: 220,
  ENEMY_BLOCK_DAMAGED: 70,
  OWN_BLOCK_DESTROYED: -120,
  OWN_BLOCK_DAMAGED: -40,
  /** Felling your own cover while nearly dead is close to losing. */
  OWN_BLOCK_DESTROYED_LOW_HP: -900,
  OWN_BLOCK_DAMAGED_LOW_HP: -300,
});

/** Below this fraction of `MAX_HP` the bot starts valuing its cover. */
const LOW_HP_FRACTION = 0.5;

/** Block seat lookup for one battlefield (ids are stable within a match). */
function seatsById(state: HillstrikeState): Map<number, Seat> {
  const map = new Map<number, Seat>();
  for (const block of state.battlefield.blocks) map.set(block.id, block.seat);
  return map;
}

/**
 * Score one candidate by what the ENGINE resolved for it.
 *
 * Returns `null` when the engine refuses the shot or the simulation throws — a
 * candidate the match would not accept is simply not an option.
 */
export function scoreAiShot({
  state,
  seat,
  shot,
}: {
  state: HillstrikeState;
  seat: Seat;
  shot: ShotInput;
}): AiShotScore | null {
  const verdict = validateAction(state, seat, { type: ACTION_TYPES.SHOOT, ...shot });
  if (!verdict.ok) return null;

  let simulation;
  try {
    simulation = simulateShot({
      battlefield: state.battlefield,
      shooterSeat: seat,
      shot,
      projectile: state.projectile,
    });
  } catch {
    return null;
  }

  const defender = otherSeat(seat);
  const defenderPlayer = state.battlefield.players[defender];
  const defenderHp = hpOf(state, defender);
  const impact = simulation.impact;
  const distance = Math.hypot(impact.x - defenderPlayer.x, impact.y - defenderPlayer.y);
  const closeness = Math.max(0, SCORE.CLOSENESS_MAX - distance);

  // Structural bookkeeping: which side each damaged block belongs to.
  const owner = seatsById(state);
  let enemyBlocksLost = 0;
  let ownBlocksLost = 0;
  let enemyBlocksDamaged = 0;
  let ownBlocksDamaged = 0;
  for (const event of simulation.events) {
    if (event.type !== "block-destroyed" && event.type !== "block-damaged") continue;
    const blockSeat = owner.get(event.blockId);
    if (event.type === "block-destroyed") {
      if (blockSeat === defender) enemyBlocksLost += 1;
      else if (blockSeat === seat) ownBlocksLost += 1;
    } else if (blockSeat === defender) enemyBlocksDamaged += 1;
    else if (blockSeat === seat) ownBlocksDamaged += 1;
  }

  const lowHp = hpOf(state, seat) <= LOW_HP_FRACTION * MAX_HP;
  const ownDamage =
    ownBlocksLost *
      (lowHp ? SCORE.OWN_BLOCK_DESTROYED_LOW_HP : SCORE.OWN_BLOCK_DESTROYED) +
    ownBlocksDamaged *
      (lowHp ? SCORE.OWN_BLOCK_DAMAGED_LOW_HP : SCORE.OWN_BLOCK_DAMAGED);
  const enemyDamage =
    enemyBlocksLost * SCORE.ENEMY_BLOCK_DESTROYED +
    enemyBlocksDamaged * SCORE.ENEMY_BLOCK_DAMAGED;

  let base: number;
  let lethal = false;
  let damage = 0;
  if (impact.kind === IMPACT_KINDS.PLAYER) {
    if (impact.target === defender) {
      // The damage is decided by the engine from the flight distance, not by
      // the impact; the bot only reads it to know whether this line is lethal.
      damage = Math.min(defenderHp, damageForDistance(simulation.distance));
      lethal = damage >= defenderHp;
      base = SCORE.DIRECT_HIT + (lethal ? SCORE.MATCH_WIN : 0);
    } else {
      // Hitting yourself is never a plan.
      base = SCORE.SELF_HIT;
    }
  } else if (impact.kind === IMPACT_KINDS.BLOCK) {
    // Breaking the tower in front of the defender is the structural attack: it
    // opens the line for the next shot, and closer is strictly better.
    base = SCORE.BLOCK_HIT;
  } else if (impact.kind === IMPACT_KINDS.TERRAIN) {
    base = SCORE.GROUND_HIT;
  } else {
    base = SCORE.MISS;
  }

  return {
    shot,
    impact,
    distance,
    score: base + closeness + ownDamage + enemyDamage,
    lethal,
    damage,
    enemyBlocksLost,
    ownBlocksLost,
  };
}

/**
 * The bot's total, deterministic ordering: score first, then the line that lands
 * nearer the defender, then the lower angle, then the higher power. Because it is
 * a total order over distinct `{angleDeg, power}` pairs, the same state always
 * yields the same ranking — reproducible tests, reproducible replays.
 */
export function compareAiScores(a: AiShotScore, b: AiShotScore): number {
  if (b.score !== a.score) return b.score - a.score;
  if (a.distance !== b.distance) return a.distance - b.distance;
  if (a.shot.angleDeg !== b.shot.angleDeg) return a.shot.angleDeg - b.shot.angleDeg;
  return b.shot.power - a.shot.power;
}

/** The refinement window around a coarse line (hard tier only). */
function refinementGrid(best: ShotInput, seat: Seat): ShotInput[] {
  const arc = forwardArc(seat);
  const shots: ShotInput[] = [];
  for (
    let angle = best.angleDeg - REFINE.angleRadius;
    angle <= best.angleDeg + REFINE.angleRadius + 1e-9;
    angle += REFINE.angleStep
  ) {
    for (
      let power = best.power - REFINE.powerRadius;
      power <= best.power + REFINE.powerRadius + 1e-9;
      power += REFINE.powerStep
    ) {
      const roundedPower = Math.round(power);
      if (roundedPower < 0 || roundedPower > POWER_MAX) continue;
      if (angle < arc.from || angle > arc.to) continue;
      shots.push({ angleDeg: Math.round(angle * 2) / 2, power: roundedPower });
    }
  }
  return shots;
}

/**
 * Resolve one already-scored line through the REAL state transition.
 *
 * `applyAction` is the same call a human's press of Fire makes, so the bot sees
 * exactly what the match would do: the HP after the shot, a finished match, the
 * collapsed tower. The adjustment is deliberately small — it can confirm or veto
 * a line, never invent physics.
 */
function applyTransition(state: HillstrikeState, seat: Seat, scored: AiShotScore): AiShotScore {
  let next;
  try {
    next = applyAction(state, seat, {
      type: ACTION_TYPES.SHOOT,
      ...scored.shot,
    }).state;
  } catch {
    return { ...scored, score: scored.score + SCORE.MISS };
  }
  if (next.status === MATCH_STATUS.FINISHED) {
    const won = next.winner === seat;
    return {
      ...scored,
      score: scored.score + (won ? SCORE.MATCH_WIN : -SCORE.MATCH_WIN),
      lethal: won || scored.lethal,
    };
  }
  // A shot that left the defender lower than predicted is better than the raw
  // impact suggested; the reverse is impossible, but be explicit.
  const predicted = scored.lethal ? scored.damage : 0;
  const actual = hpOf(state, otherSeat(seat)) - hpOf(next, otherSeat(seat));
  if (actual !== predicted) {
    return { ...scored, score: scored.score + (actual - predicted) * 40 };
  }
  return scored;
}

/** True when the engine would accept `action` for this seat right now. */
export function isLegalAiAction(
  state: HillstrikeState,
  seat: Seat,
  action: HillstrikeAction,
): boolean {
  return validateAction(state, seat, action).ok;
}

/**
 * The non-shoot action the bot would rather spend the action on, or `null`.
 *
 * Two situations make a shot the wrong choice:
 *   • no line reaches anything useful (the bot is walled off or out of arc), so
 *     driving forward is strictly better than a wasted shell — and while it is
 *     hurt, throwing up cover is better still;
 *   • the shot is only a crater in the open and the bot still has a second
 *     action, so closing the range first buys real damage on the follow-up.
 */
function preferPositioning(
  state: HillstrikeState,
  seat: Seat,
  best: AiShotScore | null,
): HillstrikeAction | null {
  const hurt = hpOf(state, seat) <= LOW_HP_FRACTION * MAX_HP;
  const forward: HillstrikeAction = { type: ACTION_TYPES.MOVE, direction: "forward" };
  const build: HillstrikeAction = { type: ACTION_TYPES.BUILD };

  const uselessShot = !best || best.impact.kind === IMPACT_KINDS.OUT_OF_BOUNDS;
  if (uselessShot) {
    if (hurt && buildPlacementFor(state, seat) && isLegalAiAction(state, seat, build)) {
      return build;
    }
    if (isLegalAiAction(state, seat, forward)) return forward;
    return null;
  }

  // A bare crater while a second action is still in hand: drive first, then fire.
  const actionsLeft = Number(state.actionsRemaining);
  const groundOnly =
    best.impact.kind === IMPACT_KINDS.TERRAIN && best.score < SCORE.GROUND_HIT + SCORE.CLOSENESS_MAX;
  if (actionsLeft >= 2 && groundOnly && !hurt && isLegalAiAction(state, seat, forward)) {
    return forward;
  }
  return null;
}

export interface ChooseAiActionParams {
  readonly state: HillstrikeState;
  readonly seat: Seat;
  readonly difficulty: AiDifficulty;
  /** Injectable randomness so the bot (and its slips) stay deterministic. */
  readonly random?: () => number;
}

/**
 * Choose the bot's action for the given state.
 *
 * Throws when the state is terminal or it is not `seat`'s turn — the caller is
 * expected to ask only when the bot owns the turn, exactly like a client would.
 */
export function chooseAiAction({
  state,
  seat,
  difficulty,
  random = Math.random,
}: ChooseAiActionParams): HillstrikeAction {
  if (!state || typeof state !== "object") {
    throw new TypeError("hillstrike ai: state is required");
  }
  if (seat !== SEATS[0] && seat !== SEATS[1]) {
    throw new TypeError(`hillstrike ai: invalid seat ${String(seat)}`);
  }
  if (state.status !== MATCH_STATUS.PLAYING) {
    throw new Error("hillstrike ai: the match is already over");
  }
  if (state.turn !== seat) {
    throw new Error("hillstrike ai: it is not this seat's turn");
  }

  const plan = planFor(difficulty);
  const scored: AiShotScore[] = [];
  for (const shot of aiAimGrid(difficulty, seat)) {
    const candidate = scoreAiShot({ state, seat, shot });
    if (candidate) scored.push(candidate);
  }

  // Bounded local refinement around the best coarse line (hard only).
  if (plan.refine && scored.length > 0) {
    const best = scored.reduce((a, b) => (compareAiScores(b, a) < 0 ? b : a));
    for (const shot of refinementGrid(best.shot, seat)) {
      const candidate = scoreAiShot({ state, seat, shot });
      if (candidate) scored.push(candidate);
    }
  }

  // Resolve only the best few through the real transition, then rank for real.
  const ranking = scored.sort(compareAiScores);
  const resolved = ranking
    .slice(0, plan.topK)
    .map((candidate) => applyTransition(state, seat, candidate));
  resolved.sort(compareAiScores);
  const best = resolved[0] ?? null;

  // A knockout line is never passed up for a drive or a build.
  if (!best?.lethal) {
    const positioning = preferPositioning(state, seat, best);
    if (positioning) return positioning;
  }

  if (!best) {
    // Nothing the engine accepts (should not happen): a straight lob.
    return {
      type: ACTION_TYPES.SHOOT,
      ...normalizeShot({ angleDeg: seat === "player1" ? 45 : 135, power: 60 }),
    };
  }

  // The ONE shared tier policy: weaker tiers deliberately pick a worse option,
  // which is what makes them beatable. Scores are not ratio-comparable (a miss is
  // still a large number), so the ratio-based slip cap is opted out of.
  const chosen = chooseAiOption(
    difficulty,
    resolved,
    (candidate) => candidate.score,
    random,
    0,
  );

  return {
    type: ACTION_TYPES.SHOOT,
    ...normalizeShot((chosen ?? best).shot),
  };
}
