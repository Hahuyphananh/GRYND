import { BALL_R, MAX_PULL, POCKETS } from "./constants";
import {
  PotGeometry,
  analyzeShot,
  pocketLabel,
  potGeometry,
  potPull,
} from "./analysis";
import { applyShotPower, isMoving, tickPhysics } from "./physics";
import { evaluateRules } from "./rules";
import { Ball, PlayerTurn, ShotMeta, Team } from "./types";

/**
 * Pool Masters AI shot planning.
 *
 * The AI plays real pots: for every ball it is allowed to hit and every pocket,
 * it solves the ghost-ball contact that sends the ball at the pocket, checks
 * that line with the shared shot analysis (nothing in the cue ball's way,
 * nothing on the object ball's way, enough pace), then plays the surviving
 * candidates through the REAL physics engine head-on. The simulated outcome is
 * ruled by the same `evaluateRules` the match uses, so the AI never plans a
 * shot that fouls, sinks the 8-ball early, or scratches when a legal
 * alternative exists.
 *
 * It also plays position: once a shot is good enough to be worth considering,
 * the table it leaves behind is probed for the best ball still available — its
 * own if it keeps shooting, the opponent's if it does not — and it takes the
 * shot that leaves the better table.
 *
 * What it does not do: exhaustive search. It simulates a bounded number of
 * candidates and weighs position across the best few, so it is a strong club
 * player rather than a perfect one.
 */

export type AiShotPlan = {
  angle: number;
  power: number;
  /** "pot" when the shot is aimed at a pocket, "safety" when it is not. */
  kind: "pot" | "safety";
  /** Object ball the AI is playing at. */
  target: number | null;
  /** Pocket index for a pot, else null. */
  pocket: number | null;
  /** Estimated pot chance for a pot shot (0..1), else null. */
  chance: number | null;
  /**
   * Best pot the AI would be left with if this shot keeps the turn (0..1), or
   * null when the turn passes or the match ends.
   */
  followUp: number | null;
  /** The tier that planned the shot — recorded with the shot in the history. */
  difficulty: AiDifficulty;
};

export type AiDifficulty = "easy" | "normal" | "hard";

export const DEFAULT_AI_DIFFICULTY: AiDifficulty = "normal";

export const isAiDifficulty = (value: unknown): value is AiDifficulty =>
  value === "easy" || value === "normal" || value === "hard";

type DifficultyTier = {
  /** Aim error at the contact point, in table units (a fixed miss, not an angle). */
  aimError: number;
  /** Candidates put through the engine — the AI's search depth. */
  maxSimulations: number;
  /**
   * How careful the tier plays, 0 (bold) to 1 (cautious). It is what "risk
   * tolerance" is made of: a cautious tier demands a better percentage before
   * it will play a pot at all, weights the percentage more heavily against the
   * table a shot leaves behind, and thinks harder about position. Aim error is
   * separate — it is how badly it executes, not how it chooses.
   */
  caution: number;
};

export const AI_DIFFICULTY: Record<AiDifficulty, DifficultyTier> = {
  easy: { aimError: 1.5, maxSimulations: 4, caution: 0.15 },
  normal: { aimError: 0.85, maxSimulations: 8, caution: 0.55 },
  hard: { aimError: 0.3, maxSimulations: 12, caution: 0.9 },
};

/** Ghost-ball cuts thinner than this are not worth planning. */
const MIN_CUT_COS = 0.35;
/** Ball candidates simulated (each one is a full physics rollout). */
const MAX_POT_CANDIDATES = 6;
const MAX_SAFETY_CANDIDATES = 5;
/** A rollout that has not settled by here is not going to. */
const MAX_SIM_TICKS = 900;
/** Outcome candidates given the (expensive) next-shot probe. */
const POSITION_SHORTLIST = 3;

/** Worth of leaving a good own pot when the turn is kept, at full caution. */
const POSITION_OWN_WEIGHT = 35;
/** Cost of leaving the opponent a good pot when the turn is lost, at full caution. */
const POSITION_OPP_WEIGHT = 25;
/**
 * How much a high-percentage shot is preferred over a low-percentage one when
 * the simulated outcome would drop either, at full caution. A cautious tier
 * would rather take the 80% pot and keep the table simple.
 */
const POT_QUALITY_WEIGHT = 90;

type Candidate = {
  angle: number;
  kind: "pot" | "safety";
  target: number;
  pocket: number | null;
  quality: number;
  powers: number[];
  /** Cue ball travel to the contact point — sizes the aim error. */
  contactDist: number;
};

type Outcome = {
  candidate: Candidate;
  power: number;
  /** Score before position is considered. */
  base: number;
  balls: Ball[];
  ruling: ReturnType<typeof evaluateRules>;
};

const isOwnBall = (n: number, team: Team) =>
  team === "solids" ? n >= 1 && n <= 7 : n >= 9 && n <= 15;

/**
 * Pot chance below which a shot is not worth playing at this risk appetite.
 * The band is calibrated against the lines the geometry analysis actually
 * produces (a clean line to a pocket is worth 0.45-0.9 there, and the bottom of
 * that range is what separates the tiers): a bold tier plays anything it can
 * see, a cautious one only takes shots it expects to hold. Exported so the
 * difficulty picker can state the bar each tier plays to.
 */
export const potQualityBar = (caution: number) => 0.3 + 0.3 * caution;

/** Balls the shooter is allowed to hit first, per the rules engine. */
function legalTargets(balls: Ball[], team: Team, openTable: boolean): Ball[] {
  const onTable = balls.filter(
    (b) => b.number > 0 && !b.pocketed && !b.animatingPocket,
  );
  if (openTable || !team) {
    const open = onTable.filter((b) => b.number !== 8);
    // Only the 8 left on an open table: hitting it is unavoidable (and a foul),
    // but standing still is worse.
    return open.length ? open : onTable;
  }

  const groupLeft = onTable.some(
    (b) => b.number !== 8 && isOwnBall(b.number, team),
  );
  return groupLeft
    ? onTable.filter((b) => isOwnBall(b.number, team))
    : onTable.filter((b) => b.number === 8);
}

/**
 * Plays a shot through the real physics engine on a copy of the table and
 * reports what the table looked like when it settled. Exported so callers
 * (and tests) can check a plan against the engine without firing it.
 */
export function simulateShot(
  balls: Ball[],
  angle: number,
  power: number,
): { balls: Ball[]; meta: ShotMeta } {
  const next = balls.map((b) => ({ ...b }));
  const meta: ShotMeta = {
    firstContactNumber: null,
    railAfterContact: false,
    pocketedNumbers: [],
    cueScratch: false,
  };
  const cue = next.find((b) => b.number === 0);
  if (!cue) return { balls: next, meta };

  const speed = applyShotPower(power);
  cue.vx = Math.cos(angle) * speed;
  cue.vy = Math.sin(angle) * speed;
  // The plan is spin-free; the caller fires it spin-free too.
  cue.spinX = 0;
  cue.spinY = 0;

  let ticks = 0;
  while (ticks < MAX_SIM_TICKS && isMoving(next)) {
    tickPhysics(next, meta);
    ticks++;
  }
  return { balls: next, meta };
}

/**
 * Best pot chance still on the table for `team` — the probe behind position
 * play. Returns 0 when there is no pot at all.
 */
export function bestAvailablePot(
  balls: Ball[],
  team: Team,
  openTable: boolean,
): number {
  const cue = balls.find((b) => b.number === 0 && !b.pocketed);
  if (!cue) return 0;

  let best = 0;
  for (const target of legalTargets(balls, team, openTable)) {
    for (const candidate of potCandidates(cue, target, balls, team, openTable, 0)) {
      if (candidate.quality > best) best = candidate.quality;
    }
  }
  return best;
}

/**
 * How good the simulated shot was for the AI, from its own seat. Mirrors the
 * match's own ruling, so "good" always means "legal and useful here".
 */
function scoreOutcome(params: {
  balls: Ball[];
  meta: ShotMeta;
  team: Team;
  oppTeam: Team;
  openTable: boolean;
  seat: PlayerTurn;
  power: number;
}) {
  const { balls, meta, team, oppTeam, openTable, seat, power } = params;
  const potted = [...new Set(meta.pocketedNumbers)];
  const ruling = evaluateRules({
    balls,
    turn: seat,
    // Read from the AI's own seat so keepTurn / winner come back its way.
    myTurn: seat,
    myTeam: team,
    oppTeam,
    openTable,
    firstContact: meta.firstContactNumber,
    railAfterContact: meta.railAfterContact,
    pocketed: potted,
    scratch: meta.cueScratch,
  });

  const group = ruling.assignedMyTeam ?? team;
  const own = group
    ? potted.filter((n) => n > 0 && n !== 8 && isOwnBall(n, group)).length
    : 0;
  const theirs = group
    ? potted.filter((n) => n > 0 && n !== 8 && !isOwnBall(n, group)).length
    : 0;

  let score = 0;
  if (ruling.winner === seat) score += 1000;
  else if (ruling.winner) score -= 1000;
  score += 70 * own;
  score -= 30 * theirs;
  if (ruling.keepTurn) score += 50;
  if (ruling.foul) score -= 60;
  score -= power * 0.02; // all else equal, take the softer shot

  return { score, ruling, potted, own };
}

/**
 * Position value of the table a shot leaves behind: what the AI would be
 * shooting at next if it keeps the turn, or what it would be handing over if it
 * does not. Careful tiers think about it less.
 */
function positionValue(
  outcome: Outcome,
  params: { team: Team; oppTeam: Team; openTable: boolean; caution: number },
): number {
  const { team, oppTeam, caution } = params;
  const { ruling, balls } = outcome;
  if (ruling.winner) return 0; // the match is over; position is moot

  const group = ruling.assignedMyTeam ?? team;
  const oppGroup = ruling.assignedOppTeam ?? oppTeam;
  const openAfter = !(ruling.assignedMyTeam && ruling.assignedOppTeam);

  if (ruling.keepTurn && group) {
    return (
      POSITION_OWN_WEIGHT * caution * bestAvailablePot(balls, group, openAfter)
    );
  }
  if (!ruling.keepTurn && oppGroup) {
    return (
      -POSITION_OPP_WEIGHT *
      caution *
      bestAvailablePot(balls, oppGroup, openAfter)
    );
  }
  return 0;
}

/** Every pocket attempt the AI could play at a given ball. */
function potCandidates(
  cue: Ball,
  target: Ball,
  balls: Ball[],
  team: Team,
  openTable: boolean,
  minChance: number,
): Candidate[] {
  const out: Candidate[] = [];

  for (let pocket = 0; pocket < POCKETS.length; pocket++) {
    const geometry: PotGeometry | null = potGeometry(cue, target, pocket);
    if (!geometry) continue;
    if (geometry.cutCos < MIN_CUT_COS) continue;

    const power = potPull(geometry.cueDist, geometry.objDist, geometry.cutCos);
    // The shared readout validates the line with the pace this shot would use:
    // nothing in front of the cue ball, clear object path, enough speed.
    const readout = analyzeShot({
      balls,
      aim: geometry.aim,
      team,
      openTable,
      pull: power,
    });
    if (readout.firstContact !== target.number) continue;
    if (readout.scratchRisk) continue;
    if (!readout.pot || readout.pot.pocket !== pocket) continue;
    if (readout.pot.blocked || readout.pot.chance <= minChance) continue;

    out.push({
      angle: geometry.aim,
      kind: "pot",
      target: target.number,
      pocket,
      quality: readout.pot.chance,
      contactDist: geometry.cueDist,
      // A shade more pace in case the estimate was optimistic.
      powers: [power, Math.min(MAX_PULL, Math.round(power * 1.5))],
    });
  }

  return out;
}

/**
 * Aim at a legal ball with a clear path — no pot, but a legal contact. Each of
 * the two nearest balls gets three looks: straight at its centre, and a thin
 * clip either side. The clips matter when the direct line is a trap (say the
 * 8-ball sitting right behind the ball): a thin contact sends the ball away on
 * an angle and leaves the cue ball rolling, so a cushion still gets reached.
 */
function safetyCandidates(
  cue: Ball,
  targets: Ball[],
  balls: Ball[],
  team: Team,
  openTable: boolean,
): Candidate[] {
  const nearest = targets
    .map((target) => ({
      target,
      dist: Math.hypot(target.x - cue.x, target.y - cue.y),
    }))
    .filter((entry) => entry.dist >= BALL_R * 2)
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 2);

  const out: Candidate[] = [];

  for (const { target, dist } of nearest) {
    const dx = target.x - cue.x;
    const dy = target.y - cue.y;
    const nx = -dy / dist;
    const ny = dx / dist;
    // Enough pace that the object ball reaches a cushion, which is what keeps
    // the shot legal when nothing drops.
    const power = Math.min(
      MAX_PULL,
      Math.max(45, Math.round((dist + 320) / 9)),
    );
    const clipOffset = BALL_R * 2 - 3;

    for (const side of [0, -1, 1]) {
      const aimX = side === 0 ? target.x : target.x + nx * clipOffset * side;
      const aimY = side === 0 ? target.y : target.y + ny * clipOffset * side;
      const aim = Math.atan2(aimY - cue.y, aimX - cue.x);

      const readout = analyzeShot({ balls, aim, team, openTable });
      if (readout.firstContact !== target.number) continue;
      if (readout.scratchRisk) continue;

      out.push({
        angle: aim,
        kind: "safety",
        target: target.number,
        pocket: null,
        quality: 1 / (dist + 1),
        contactDist: dist,
        powers: [side === 0 ? power : Math.max(45, Math.round(power * 0.8))],
      });
    }
  }

  return out;
}

export function planAiShot(params: {
  balls: Ball[];
  /** The AI's group (null while the table is open). */
  team: Team;
  /** The opponent's group. */
  oppTeam: Team;
  openTable: boolean;
  /** The AI's seat, used to rule the simulated outcome from its own side. */
  seat?: PlayerTurn;
  /** How sharp the AI plays: aim error, search depth and risk appetite. */
  difficulty?: AiDifficulty;
  /** Injectable RNG so the plan is deterministic in tests. */
  random?: () => number;
}): AiShotPlan | null {
  const {
    balls,
    team,
    oppTeam,
    openTable,
    seat = 2,
    difficulty = DEFAULT_AI_DIFFICULTY,
    random = Math.random,
  } = params;
  const tier = AI_DIFFICULTY[difficulty] ?? AI_DIFFICULTY[DEFAULT_AI_DIFFICULTY];

  const cue = balls.find((b) => b.number === 0 && !b.pocketed);
  if (!cue) return null;

  const targets = legalTargets(balls, team, openTable);
  if (!targets.length) return null;

  // The risk bar gates what the AI is willing to play: a bold tier plays any
  // line it can see, a cautious one passes on the marginal ones for a safety.
  // The position probe (bestAvailablePot) deliberately uses 0 instead, so
  // "what is left on the table" is measured the same way whatever the appetite.
  const pots: Candidate[] = [];
  for (const target of targets) {
    pots.push(
      ...potCandidates(
        cue,
        target,
        balls,
        team,
        openTable,
        potQualityBar(tier.caution),
      ),
    );
  }
  pots.sort((a, b) => b.quality - a.quality);

  const safeties = safetyCandidates(cue, targets, balls, team, openTable);

  const candidates = [
    ...pots.slice(0, MAX_POT_CANDIDATES),
    ...safeties.slice(0, MAX_SAFETY_CANDIDATES),
  ];

  // The engine settles a shot the same way every time, so a planned pot is not
  // a certainty: the estimated chance is what separates an 80% pot from a 40%
  // one, and a cautious tier has to care about that more.
  const qualityWeight = POT_QUALITY_WEIGHT * (0.35 + tier.caution);

  const outcomes: Outcome[] = [];
  let simulations = 0;
  let winner: Outcome | null = null;

  outer: for (const candidate of candidates) {
    for (const power of candidate.powers) {
      if (simulations >= tier.maxSimulations) break outer;
      simulations++;

      const { balls: after, meta } = simulateShot(balls, candidate.angle, power);
      const { score, ruling } = scoreOutcome({
        balls: after,
        meta,
        team,
        oppTeam,
        openTable,
        seat,
        power,
      });

      const chance = candidate.kind === "pot" ? candidate.quality : 0;
      const outcome: Outcome = {
        candidate,
        power,
        base: score + qualityWeight * chance,
        balls: after,
        ruling,
      };
      outcomes.push(outcome);

      // A win ends the match — nothing about the next shot matters.
      if (ruling.winner === seat) {
        winner = outcome;
        break outer;
      }
    }
  }

  let chosen: Outcome | null = winner;
  if (!chosen) {
    // Weigh the best few by where they leave the table.
    const shortlist = [...outcomes]
      .sort((a, b) => b.base - a.base)
      .slice(0, POSITION_SHORTLIST);

    let bestValue = -Infinity;
    for (const outcome of shortlist) {
      const value =
        outcome.base +
        positionValue(outcome, {
          team,
          oppTeam,
          openTable,
          caution: tier.caution,
        });
      if (value > bestValue) {
        bestValue = value;
        chosen = outcome;
      }
    }
  }

  // Nothing verified: fall back to the classic "hit the nearest legal ball"
  // shot rather than leaving the match hanging.
  const candidate = chosen?.candidate ?? fallbackCandidate(cue, targets);
  if (!candidate) return null;
  const power = chosen?.power ?? candidate.powers[0];

  // Aim error is a fixed miss at the contact point, converted to an angle for
  // the distance in play: the object ball's direction suffers the same either
  // way, which is what a sloppy cue actually does.
  const error = tier.aimError * (candidate.kind === "pot" ? 1 : 1.6);
  const jitter =
    ((random() - 0.5) * error) / Math.max(candidate.contactDist, BALL_R * 4);

  const group = chosen?.ruling.assignedMyTeam ?? team;
  const openAfter = chosen
    ? !(chosen.ruling.assignedMyTeam && chosen.ruling.assignedOppTeam)
    : openTable;
  const followUp =
    chosen && chosen.ruling.keepTurn && !chosen.ruling.winner && group
      ? bestAvailablePot(chosen.balls, group, openAfter)
      : null;

  return {
    angle: candidate.angle + jitter,
    power,
    kind: candidate.kind,
    target: candidate.target,
    pocket: candidate.pocket,
    chance: candidate.kind === "pot" ? candidate.quality : null,
    followUp,
    difficulty,
  };
}

/** "the 8-ball" for the eight, otherwise "the 3" / "the 11". */
const ballName = (n: number) => (n === 8 ? "the 8-ball" : `the ${n}`);

/**
 * One-line description of a plan for the shot history, e.g.
 * "planned the 3 → bottom-right pocket · 73% · next shot 62%". `rotated` names
 * the pockets for the orientation the table is being shown in, and the
 * difficulty is only spelled out when the caller has room for it.
 */
export function describeAiPlan(
  plan: AiShotPlan,
  rotated: boolean,
  options: { withDifficulty?: boolean } = {},
): string {
  const suffix = options.withDifficulty ? ` · ${plan.difficulty}` : "";
  if (plan.kind !== "pot" || plan.target === null) {
    const target = plan.target === null ? "a legal ball" : ballName(plan.target);
    return `planned a safety on ${target}${suffix}`;
  }
  const pocket =
    plan.pocket !== null ? `${pocketLabel(plan.pocket, rotated)} pocket` : "a pocket";
  const chance =
    plan.chance !== null ? ` · ${Math.round(plan.chance * 100)}%` : "";
  const next =
    plan.followUp !== null
      ? ` · next shot ${Math.round(plan.followUp * 100)}%`
      : "";
  return `planned ${ballName(plan.target)} → ${pocket}${chance}${next}${suffix}`;
}

/** Last resort: aim straight at the first legal ball, whatever is in the way. */
function fallbackCandidate(cue: Ball, targets: Ball[]): Candidate | null {
  const nearest = [...targets].sort(
    (a, b) =>
      Math.hypot(a.x - cue.x, a.y - cue.y) - Math.hypot(b.x - cue.x, b.y - cue.y),
  )[0];
  if (!nearest) return null;
  const dist = Math.hypot(nearest.x - cue.x, nearest.y - cue.y);
  return {
    angle: Math.atan2(nearest.y - cue.y, nearest.x - cue.x),
    kind: "safety",
    target: nearest.number,
    pocket: null,
    quality: 0,
    contactDist: dist,
    powers: [Math.min(MAX_PULL, Math.max(72, Math.round(dist / 5.4)))],
  };
}
