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
 *    enemy, the bot drives forward instead of throwing the action away; with
 *    two actions in hand it will also drive first and shoot second rather than
 *    take a bare crater in the open. On the HARD tier an unarmed bot also walks
 *    to the nearest power-up on its own side before it fires again, so the
 *    middle is contested for the whole match instead of the bot camping the
 *    spawn it was given.
 * 6. SLIP through the ONE shared tier policy (`chooseAiOption`), which is what
 *    makes a weak tier beatable rather than merely short-sighted. The slip only
 *    applies to the aim — a drive is always the deliberate choice.
 *
 * THE TOWER IS AN OBSTACLE, NOT AN OWNER'S COVER. Its blocks belong to nobody, so
 * a tower hit is scored as progress for whichever seat fired, never as "own
 * cover" damage — otherwise one seat would refuse to open the map.
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
  MOVE_STEP,
  POWER_MAX,
  POWERUP_CHASE_DRIVES,
  POWERUP_KINDS,
  POWERUP_SPRINT_DRIVES,
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
  buffsOf,
  hpOf,
  moveTargetFor,
  validateAction,
} from "./rules";
import type {
  HillstrikeAction,
  HillstrikeState,
  Impact,
  PowerUp,
  Seat,
  ShotInput,
} from "./types";

/** One line per tier, shown under the shared difficulty picker. */
export const HILLSTRIKE_TIER_HINTS: Record<AiDifficulty, string> = {
  easy:
    "Fires a quick, coarse lob — it often misjudges the arc, and rarely finds a shielded gunner.",
  normal:
    "Solves the arc on a fine grid, breaks the cover in front of you, and only sometimes picks a worse line.",
  hard: "Sweeps the whole aim space, breaks your cover down deliberately, and takes the middle power-ups whenever a shell is not the better action.",
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
  "buffs",
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
  /** A middle-tower block: the wall, owned by nobody, always worth opening. */
  TOWER_HIT: 2_800,
  GROUND_HIT: 1_200,
  /** A shell stopped by an indestructible base roof: no structural progress. */
  ROOF_HIT: 700,
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

/**
 * Block ownership lookup for one battlefield (ids are stable within a match).
 *
 * A middle-tower block is deliberately absent: it belongs to neither seat, so
 * breaking one is structural progress for whoever fired, never "own cover".
 */
function seatsById(state: HillstrikeState): Map<number, Seat> {
  const map = new Map<number, Seat>();
  for (const block of state.battlefield.blocks) {
    if (block.kind === "tower") continue;
    map.set(block.id, block.seat);
  }
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

  // Plan with the buffs the shot would actually spend, so a lethal line is a
  // lethal line and a doubled crater is scored as the doubled crater it is.
  const armed = buffsOf(state, seat);

  let simulation;
  try {
    simulation = simulateShot({
      battlefield: state.battlefield,
      shooterSeat: seat,
      shot,
      projectile: state.projectile,
      blastScale: armed.doubleBlast ? 2 : 1,
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
      // The damage is decided by the engine from the flight distance (doubled
      // while `double-damage` is armed), not by the impact; the bot only reads
      // it to know whether this line is lethal.
      damage = Math.min(
        defenderHp,
        Math.round(damageForDistance(simulation.distance) * (armed.doubleDamage ? 2 : 1)),
      );
      lethal = damage >= defenderHp;
      base = SCORE.DIRECT_HIT + (lethal ? SCORE.MATCH_WIN : 0);
    } else {
      // Hitting yourself is never a plan.
      base = SCORE.SELF_HIT;
    }
  } else if (impact.kind === IMPACT_KINDS.BLOCK) {
    // Breaking the ENEMY's cover is the structural attack: it opens a line for
    // the next shot. Meeting your OWN roof or cover is not an attack at all — a
    // roof is indestructible, so a bot that scored that as "a block hit" would
    // happily fire into its own ceiling forever instead of climbing out.
    // A ROOF is indestructible, so hitting one makes no structural progress at
    // all: it is scored below a crater, which is what makes the bot climb out of
    // its own base instead of shelling the enemy's ceiling forever.
    const struckBlock =
      impact.blockId === null
        ? null
        : state.battlefield.blocks.find((block) => block.id === impact.blockId) ?? null;
    if (struckBlock?.kind === "roof") base = SCORE.ROOF_HIT;
    else if (struckBlock?.kind === "tower") base = SCORE.TOWER_HIT;
    else if (impact.blockId !== null && owner.get(impact.blockId) === seat) base = SCORE.SELF_HIT;
    else base = SCORE.BLOCK_HIT;
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
 * The nearest pickup worth a drive, or `null`.
 *
 * A heal on a full bar is not worth an action, and a buff the bot is already
 * carrying cannot be stacked — the engine would only re-arm what is armed — so
 * those are skipped rather than chased. Ties go to the lower id, keeping the
 * choice deterministic.
 */
function aiPickupTarget(
  state: HillstrikeState,
  seat: Seat,
): { pickup: PowerUp; distance: number } | null {
  const player = state.battlefield.players[seat];
  if (!player) return null;
  const pickups = Array.isArray(state.battlefield.pickups) ? state.battlefield.pickups : [];
  if (pickups.length === 0) return null;

  const armed = buffsOf(state, seat);
  const hp = hpOf(state, seat);
  let best: { pickup: PowerUp; distance: number } | null = null;
  for (const pickup of pickups) {
    if (pickup.kind === POWERUP_KINDS.HEAL && hp >= MAX_HP) continue;
    if (pickup.kind === POWERUP_KINDS.DOUBLE_DAMAGE && armed.doubleDamage) continue;
    if (pickup.kind === POWERUP_KINDS.DOUBLE_BLAST && armed.doubleBlast) continue;
    const distance = Math.abs(pickup.x - player.x);
    const better =
      !best ||
      distance < best.distance ||
      (distance === best.distance && pickup.id < best.pickup.id);
    if (better) best = { pickup, distance };
  }
  return best;
}

/** The one-step drive that closes on a pickup, when the engine accepts it. */
function driveToPickup(
  state: HillstrikeState,
  seat: Seat,
  pickup: PowerUp,
): HillstrikeAction | null {
  const player = state.battlefield.players[seat];
  if (!player) return null;
  const forwardSign = seat === "player1" ? 1 : -1;
  const direction = Math.sign(pickup.x - player.x) === forwardSign ? "forward" : "back";
  const action: HillstrikeAction = { type: ACTION_TYPES.MOVE, direction };
  return isLegalAiAction(state, seat, action) ? action : null;
}

/**
 * A drive toward the nearest middle power-up.
 *
 * The middle is the only source of a buff, so a bot that ignores it would lose
 * the trade the whole map is built around. It only ever asks for a legal drive.
 */
function aiPickupDrive(
  state: HillstrikeState,
  seat: Seat,
): HillstrikeAction | null {
  const target = aiPickupTarget(state, seat);
  return target ? driveToPickup(state, seat, target.pickup) : null;
}

/**
 * The hard tier's middle play: an unarmed bot takes the power-ups.
 *
 * Sitting in the spawn and trading shells is exactly what the roofs and the hills
 * were added to stop being the whole game: the buff lanes are what a match is
 * won on, and a bot that never contests them teaches the wrong lesson. So while
 * it is ARMED its shot is worth more than a drive and it fires; the moment the
 * buff is spent it will walk to the nearest lane it can actually reach.
 *
 * A walk replaces a shell, so it is only taken when that shell is not buying
 * anything: the bot is behind on HP (the buff is the comeback), its best line
 * is not a direct hit, or the lane is a short detour. Measured over fifteen
 * seeds, an unconditional walk cost more damage than the buff returned and made
 * hard lose to normal, which is the whole reason for the condition.
 *
 * It never trades a knockout for a drive (the caller checks `lethal` first), it
 * refuses a chase longer than `POWERUP_CHASE_DRIVES`, and it never leaves a heal
 * behind while it is hurt.
 */
function aiMiddlePlay(
  state: HillstrikeState,
  seat: Seat,
  best: AiShotScore | null,
): HillstrikeAction | null {
  if (!best || best.lethal) return null;
  const armed = buffsOf(state, seat);
  // A buff in hand is spent by a shot, not stacked by another drive.
  if (armed.doubleDamage || armed.doubleBlast) return null;

  const target = aiPickupTarget(state, seat);
  if (!target) return null;
  if (target.distance > POWERUP_CHASE_DRIVES * MOVE_STEP) return null;

  // A lane is worth walking to when the shot it replaces is not buying anything:
  // the bot is behind on HP (the buff is the comeback), its best line is not a
  // direct hit, or the lane is close enough to be a detour. Ahead AND hitting, it
  // keeps firing — a walk there would hand the lead straight back.
  const nearby = target.distance <= POWERUP_SPRINT_DRIVES * MOVE_STEP;
  const behind = hpOf(state, seat) <= hpOf(state, otherSeat(seat));
  const shotIsPoor = best.impact.kind !== IMPACT_KINDS.PLAYER;
  if (!nearby && !behind && !shotIsPoor) return null;

  // A long approach costs NO damage: only the first action of a two-action turn
  // is spent on it, so the second still fires. The LAST few steps are a SPRINT
  // (both actions of the turn), so a lane it has already walked to is actually
  // taken instead of being abandoned one step short when the match ends.
  if (!nearby && Number(state.actionsRemaining) < 2) return null;
  return driveToPickup(state, seat, target.pickup);
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
  const pickupDrive = aiPickupDrive(state, seat);

  // A miss, a shot into your own base roof, or a bare crater scores below a
  // plain ground hit: the action is worth more as a drive out of the base.
  const uselessShot =
    !best ||
    best.impact.kind === IMPACT_KINDS.OUT_OF_BOUNDS ||
    best.score < SCORE.GROUND_HIT;
  if (uselessShot) {
    if (pickupDrive) return pickupDrive;
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

  // A mediocre line with plenty of turns left: go and take the middle instead.
  if (actionsLeft >= 2 && groundOnly && pickupDrive) return pickupDrive;
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
    // Hard plays the map: an unarmed hard bot takes the middle before it takes
    // another spawn-to-spawn shell. Weaker tiers keep their simple plan.
    if (difficulty === "hard") {
      const middle = aiMiddlePlay(state, seat, best);
      if (middle) return middle;
    }
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
