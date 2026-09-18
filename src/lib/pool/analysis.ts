import {
  BALL_R,
  FRICTION,
  MAX_PULL,
  POCKET_R,
  POCKETS,
  RAIL,
  TABLE_H,
  TABLE_W,
} from "./constants";
import { CUE_TRANSFER, applyShotPower } from "./physics";
import { findGhostBall } from "./render";
import { firstContactFoul } from "./rules";
import { Ball, Team } from "./types";

/**
 * Shot readout for the aim guide: what the cue ball will hit first, whether
 * that contact is legal, and the best pocket line the contacted ball is on.
 *
 * It is a GEOMETRY ESTIMATE, not a measurement: the pot chance is derived from
 * how squarely the ball lines up with a pocket mouth, how thin the cut is, how
 * far the shot has to travel, and — when the caller passes the pull being
 * charged — whether that pace can actually carry the ball to the pocket. The
 * first-contact verdict, on the other hand, is exact: it comes from the same
 * `firstContactFoul` the rules engine rules with, so the guide can never
 * contradict the foul it warns about.
 */

export type PotLine = {
  /** Number of the ball being potted (the ball the cue ball hits first). */
  ball: number;
  color: string;
  /** Index into `POCKETS`. */
  pocket: number;
  pocketLabel: string;
  /** 0..1 estimated chance. 0 when the line is blocked. */
  chance: number;
  /** Another ball sits on the object ball's path to the pocket. */
  blocked: boolean;
};

export type ShotReadout = {
  /** Ball the cue ball reaches first (null when nothing is in the line). */
  firstContact: number | null;
  /** Foul message for that contact, or null when it is legal. */
  firstContactFoul: string | null;
  /** Best pocket line for the contacted ball, if any. */
  pot: PotLine | null;
  /** The cue ball's own line runs into a pocket before it reaches a ball. */
  scratchRisk: boolean;
};

/** Where the cue ball must be struck from so that `target` leaves for a pocket. */
export type PotGeometry = {
  /** Aim angle (radians) that sends the cue ball at the ghost point. */
  aim: number;
  ghostX: number;
  ghostY: number;
  /** Cue ball travel before contact. */
  cueDist: number;
  /** Object ball travel to the pocket. */
  objDist: number;
  /** cos(cut): 1 is a full-ball hit, 0 a knife-edge. */
  cutCos: number;
};

const clamp = (v: number, min: number, max: number) =>
  Math.max(min, Math.min(max, v));

/** A ball must clear the table's rail line before it can reach a pocket. */
const RAIL_EDGE_X = TABLE_W - RAIL - BALL_R;
const RAIL_EDGE_Y = TABLE_H - RAIL - BALL_R;

/** Speed a rolling ball loses per unit travelled (per-tick friction 0.982). */
const ROLL_LOSS = 1 - FRICTION;
/** Pace kept in reserve so the object ball still has speed at the pocket. */
const POCKET_RESERVE = 20;
const MAX_SHOT_SPEED = applyShotPower(MAX_PULL);

/**
 * Pull (MAX_PULL units) that gets the object ball to its pocket: enough speed
 * at contact to cover the object ball's distance, plus the speed the cue ball
 * spends covering its own. This is the same pace model the pot chance uses, so
 * a planned shot and its readout always agree.
 */
export function potPull(
  cueDist: number,
  objDist: number,
  cutCos: number,
): number {
  const needObj = ROLL_LOSS * (objDist + POCKET_RESERVE);
  const needCue = needObj / Math.max(0.15, cutCos * CUE_TRANSFER);
  // A little over the requirement: rounding the pull to whole units must not
  // land the plan below the pace its own readout is about to judge it by.
  const speed = clamp(
    needCue + ROLL_LOSS * cueDist + 1.5,
    3.5,
    MAX_SHOT_SPEED,
  );
  // Invert applyShotPower: speed = 3 + (pull / MAX_PULL)^1.2 * 22.
  const t = Math.pow(clamp((speed - 3) / 22, 0, 1), 1 / 1.2);
  return clamp(Math.round(t * MAX_PULL), 12, MAX_PULL);
}

/**
 * How much of the pace the object ball needs the shot actually delivers, 0..1.
 * A ball that dies short of the pocket cannot be potted, however well it lines
 * up — this is what makes the readout react to how hard the shot is pulled.
 */
function paceFactor(
  pull: number,
  cueDist: number,
  objDist: number,
  cutCos: number,
): number {
  const atContact = applyShotPower(pull) - ROLL_LOSS * cueDist;
  if (atContact <= 0) return 0;
  const delivered = atContact * cutCos * CUE_TRANSFER;
  const needed = ROLL_LOSS * (objDist + POCKET_RESERVE);
  if (needed <= 0) return 1;
  // Delivered travel is linear in speed, so just short of the requirement the
  // ball stops just short of the pocket.
  return clamp((delivered / needed - 0.88) / 0.12, 0, 1);
}

/**
 * The point a ball can actually be rolled at to enter a pocket. Pocket centres
 * sit behind the cushion line (that is where the hole is drawn), so a ball sent
 * at the centre grazes the cushion just short of the jaws and rebounds — the
 * reachable target is the nearest point on the playable side of it, which still
 * sits well inside the pot-capture radius.
 */
export function pocketMouth(index: number): [number, number] {
  const [px, py] = POCKETS[index] ?? [TABLE_W / 2, TABLE_H / 2];
  return [
    clamp(px, RAIL + BALL_R, RAIL_EDGE_X),
    clamp(py, RAIL + BALL_R, RAIL_EDGE_Y),
  ];
}

/**
 * Ghost-point geometry for potting `target` into `pocket` from `cue`.
 * Returns null when the shot does not exist (cut too thin, no room for the
 * cue ball at the contact point).
 */
export function potGeometry(
  cue: Ball,
  target: Ball,
  pocket: number,
): PotGeometry | null {
  if (!POCKETS[pocket]) return null;
  const [px, py] = pocketMouth(pocket);

  const toX = px - target.x;
  const toY = py - target.y;
  const objDist = Math.hypot(toX, toY);
  if (objDist < BALL_R * 2) return null;
  const ux = toX / objDist;
  const uy = toY / objDist;

  // The cue ball's centre at contact sits 2R behind the object ball's centre
  // along the pocket line — and has to fit on the table.
  const ghostX = target.x - ux * BALL_R * 2;
  const ghostY = target.y - uy * BALL_R * 2;
  if (
    ghostX < RAIL + BALL_R ||
    ghostX > RAIL_EDGE_X ||
    ghostY < RAIL + BALL_R ||
    ghostY > RAIL_EDGE_Y
  ) {
    return null;
  }

  const dx = ghostX - cue.x;
  const dy = ghostY - cue.y;
  const cueDist = Math.hypot(dx, dy);
  if (cueDist < BALL_R) return null;
  const cutCos = (dx * ux + dy * uy) / cueDist;
  if (cutCos <= 0.15) return null; // a knife-edge contact moves nothing useful

  return { aim: Math.atan2(dy, dx), ghostX, ghostY, cueDist, objDist, cutCos };
}

/**
 * Pocket name in the orientation the player actually sees. The portrait stage
 * rotates the canvas 90° clockwise, so the canvas' axes swap on screen —
 * "top-middle" on the canvas is the middle of the right rail on a phone.
 */
export function pocketLabel(index: number, rotated: boolean): string {
  const [px, py] = POCKETS[index] ?? [TABLE_W / 2, TABLE_H / 2];
  const screenX = rotated ? TABLE_H - py : px;
  const screenY = rotated ? px : py;
  const boxW = rotated ? TABLE_H : TABLE_W;
  const boxH = rotated ? TABLE_W : TABLE_H;

  const third = (v: number, span: number, low: string, mid: string, high: string) =>
    v < span / 3 ? low : v > (span * 2) / 3 ? high : mid;

  const vertical = third(screenY, boxH, "top", "middle", "bottom");
  const horizontal = third(screenX, boxW, "left", "middle", "right");
  return `${vertical}-${horizontal}`;
}

/** Distance from a ball to a pocket centre, signed along the path direction. */
function pocketAlong(
  fromX: number,
  fromY: number,
  dirX: number,
  dirY: number,
  targetX: number,
  targetY: number,
) {
  const toX = targetX - fromX;
  const toY = targetY - fromY;
  const length = Math.hypot(toX, toY);
  if (length < 1) return null;
  return {
    length,
    along: (dirX * toX + dirY * toY) / length,
    dirToTargetX: toX / length,
    dirToTargetY: toY / length,
  };
}

/**
 * True when another ball sits across the straight line from `ball` to
 * (toX, toY) — the ball would be knocked off line before it arrives.
 */
function pathBlocked(
  balls: Ball[],
  shooting: Ball,
  toX: number,
  toY: number,
): boolean {
  const dx = toX - shooting.x;
  const dy = toY - shooting.y;
  const length = Math.hypot(dx, dy);
  if (length < BALL_R) return false;
  const ux = dx / length;
  const uy = dy / length;

  for (const b of balls) {
    if (b.pocketed || b.animatingPocket) continue;
    if (b.number === shooting.number) continue;
    const t = (b.x - shooting.x) * ux + (b.y - shooting.y) * uy;
    // Ignore balls sitting on top of the shooter or behind it, and anything
    // past the pocket itself.
    if (t <= BALL_R || t > length) continue;
    const perpendicular = Math.abs(
      (b.x - shooting.x) * uy - (b.y - shooting.y) * ux,
    );
    if (perpendicular < BALL_R * 2) return true;
  }
  return false;
}

/** How far a ray travels before the cue ball would reach a cushion. */
function distanceToRail(fromX: number, fromY: number, dirX: number, dirY: number) {
  const limits: number[] = [];
  if (dirX > 0.0001) limits.push((RAIL_EDGE_X - fromX) / dirX);
  else if (dirX < -0.0001) limits.push((RAIL + BALL_R - fromX) / dirX);
  if (dirY > 0.0001) limits.push((RAIL_EDGE_Y - fromY) / dirY);
  else if (dirY < -0.0001) limits.push((RAIL + BALL_R - fromY) / dirY);
  const positive = limits.filter((t) => t > 0);
  return positive.length ? Math.min(...positive) : 0;
}

/**
 * True when a path of `length` along the ray passes over a pocket mouth. The
 * closest approach is clamped to the path itself: pocket centres sit ~25 units
 * beyond the cushion line, so a ball rolling along a cushion into a corner is
 * over the mouth right where the rail would stop it.
 */
function pathOverPocket(
  fromX: number,
  fromY: number,
  dirX: number,
  dirY: number,
  length: number,
) {
  for (const [px, py] of POCKETS) {
    const along = clamp((px - fromX) * dirX + (py - fromY) * dirY, 0, length);
    const closestX = fromX + dirX * along;
    const closestY = fromY + dirY * along;
    if (Math.hypot(px - closestX, py - closestY) < POCKET_R) return true;
  }
  return false;
}

export function analyzeShot(params: {
  balls: Ball[];
  aim: number;
  /** The shooter's group (null while the table is open). */
  team: Team;
  openTable: boolean;
  /** True when the table is displayed rotated 90° (portrait stage). */
  rotated?: boolean;
  /**
   * Draw strength (MAX_PULL units) the shot would be played with. When given,
   * a shot without the pace to carry the object ball to the pocket reads
   * lower. Omit it while the player is still aiming and has not charged a shot.
   */
  pull?: number;
}): ShotReadout {
  const { balls, aim, team, openTable, rotated = false, pull } = params;
  const cue = balls.find((b) => b.number === 0 && !b.pocketed);
  const empty: ShotReadout = {
    firstContact: null,
    firstContactFoul: null,
    pot: null,
    scratchRisk: false,
  };
  if (!cue) return empty;

  const dirX = Math.cos(aim);
  const dirY = Math.sin(aim);

  // The canvas guide already casts this ray to place its ghost ball, so the
  // readout reads the exact same contact the player sees drawn.
  const hit = findGhostBall(cue, aim, balls);
  const firstContact = hit ? hit.objBall.number : null;

  const cueTravel = hit
    ? Math.hypot(hit.ghostX - cue.x, hit.ghostY - cue.y)
    : distanceToRail(cue.x, cue.y, dirX, dirY);

  const scratchRisk = pathOverPocket(cue.x, cue.y, dirX, dirY, cueTravel);

  if (!hit) {
    return {
      firstContact: null,
      firstContactFoul: firstContactFoul({
        balls,
        team,
        openTable,
        firstContact: null,
      }),
      pot: null,
      scratchRisk,
    };
  }

  const { ghostX, ghostY, objBall } = hit;
  // The contact normal — the direction the object ball is driven — is the line
  // from the ghost cue ball through the object ball's centre. Physics agrees:
  // the impulse pushes the ball along exactly this normal.
  const departLength = Math.hypot(objBall.x - ghostX, objBall.y - ghostY) || 1;
  const ux = (objBall.x - ghostX) / departLength;
  const uy = (objBall.y - ghostY) / departLength;
  const cutCos = clamp(dirX * ux + dirY * uy, 0, 1);

  let best: PotLine | null = null;
  for (let i = 0; i < POCKETS.length; i++) {
    const [px, py] = pocketMouth(i);
    const line = pocketAlong(objBall.x, objBall.y, ux, uy, px, py);
    if (!line) continue;

    // How far the departure line is from the pocket centre, against how far it
    // may stray and still pass over the mouth at that distance.
    const deviation = Math.acos(clamp(line.along, -1, 1));
    const tolerance = Math.atan2(POCKET_R, line.length);
    const alignment = clamp(1 - deviation / tolerance, 0, 1);
    if (alignment <= 0) continue;

    const blocked = pathBlocked(balls, objBall, px, py);
    // Short shots with a full ball hit are the easy ones; thin, long shots over
    // two cushions' worth of travel are not.
    const reach = clamp(1 - (cueTravel + line.length) / 2600, 0.12, 1);
    const cut = Math.pow(cutCos, 0.6);
    const pace =
      pull === undefined || pull <= 0
        ? 1
        : paceFactor(pull, cueTravel, line.length, cutCos);
    const chance = blocked ? 0 : alignment * cut * reach * pace;

    if (!best || chance > best.chance) {
      best = {
        ball: objBall.number,
        color: objBall.color,
        pocket: i,
        pocketLabel: pocketLabel(i, rotated),
        chance,
        blocked,
      };
    }
  }

  return {
    firstContact,
    firstContactFoul: firstContactFoul({
      balls,
      team,
      openTable,
      firstContact,
    }),
    pot: best,
    scratchRisk,
  };
}
