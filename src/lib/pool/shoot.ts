// src/lib/pool/shoot.ts
//
// ONE SHOT, SIMULATED AND RULED — the server's side of Pool Masters.
//
// Pool settles coins now, so the table cannot be whatever the shooting client
// last uploaded. The server starts from the same rack it ships to the page
// (`rack.ts`), replays the shot with the same physics the page runs
// (`physics.ts`), and applies the same rulebook (`rules.ts`). Those modules are
// pure functions over `Ball[]`, so this runs unchanged in a route handler: no
// canvas, no React, no clock. `tickPhysics` is a per-tick step, so replaying it
// in a loop reproduces the page's rollout exactly.
//
// WHAT THE CLIENT STILL PICKS: the angle, the pull and the spin, plus where it
// drops the cue ball when it has ball in hand. Those are the player's decisions.
// Everything after the cue is struck — where the balls end up, who keeps the
// turn, which group is whose, who won — is derived here and never read off the
// request body.

import { applyShotPower, isMoving, tickPhysics } from "./physics";
import { evaluateRules } from "./rules";
import { CUE_SPOT, type PoolServerState } from "./rack";
import type { Ball, PlayerTurn, ShotMeta, Team } from "./types";

/** A generous ceiling: a shot that has not stopped after 20s of ticks is stuck. */
const MAX_SHOT_TICKS = 1200;

/** The cue ball may only be re-spotted inside the playing surface. */
const CUE_X_MIN = 60;
const CUE_X_MAX = 840;
const CUE_Y_MIN = 60;
const CUE_Y_MAX = 440;

export interface PoolShotInput {
  /** Direction of the strike, in table radians. */
  angle: number;
  /** How far the cue was pulled back (the page's units, 0–120). */
  pull: number;
  spinX?: number;
  spinY?: number;
  /** Where the shooter placed the cue ball (only meaningful with ball in hand). */
  cueX?: number;
  cueY?: number;
}

export interface PoolShotResult {
  balls: Ball[];
  meta: ShotMeta;
  ticks: number;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const finite = (n: unknown, fallback = 0) =>
  typeof n === "number" && Number.isFinite(n) ? n : fallback;

/** Defence in depth: no NaN, no infinite pull, no strike from outside the table. */
export function normalizeShotInput(raw: unknown): PoolShotInput | null {
  if (!raw || typeof raw !== "object") return null;
  const body = raw as Record<string, unknown>;
  const angle = finite(body.angle, NaN);
  const pull = finite(body.pull, NaN);
  if (!Number.isFinite(angle) || !Number.isFinite(pull)) return null;
  const cueX = finite(body.cueX, NaN);
  const cueY = finite(body.cueY, NaN);
  return {
    angle,
    pull: clamp(pull, 0, 120),
    spinX: clamp(finite(body.spinX), -1, 1),
    spinY: clamp(finite(body.spinY), -1, 1),
    cueX: Number.isFinite(cueX) ? clamp(cueX, CUE_X_MIN, CUE_X_MAX) : undefined,
    cueY: Number.isFinite(cueY) ? clamp(cueY, CUE_Y_MIN, CUE_Y_MAX) : undefined,
  };
}

/**
 * Roll one shot out from `balls` and report where everything came to rest.
 *
 * The input table is copied, so the caller's state is untouched when a shot is
 * rejected later in the request.
 */
export function simulatePoolShot(balls: Ball[], shot: PoolShotInput): PoolShotResult {
  const next: Ball[] = balls.map((b) => ({ ...b, vx: 0, vy: 0 }));
  const cue = next.find((b) => b.number === 0);
  if (!cue) throw new Error("table has no cue ball");

  // A pocketed cue ball is re-spotted before the next stroke (that is what ball
  // in hand means), so a scratch never strands the table.
  if (cue.pocketed || typeof shot.cueX === "number" || typeof shot.cueY === "number") {
    cue.pocketed = false;
    cue.animatingPocket = false;
    cue.opacity = 1;
    cue.scale = 1;
    cue.x = shot.cueX ?? CUE_SPOT.x;
    cue.y = shot.cueY ?? CUE_SPOT.y;
  }

  const speed = applyShotPower(shot.pull);
  cue.vx = Math.cos(shot.angle) * speed;
  cue.vy = Math.sin(shot.angle) * speed;
  cue.spinX = shot.spinX ?? 0;
  cue.spinY = shot.spinY ?? 0;

  const meta: ShotMeta = {
    firstContactNumber: null,
    railAfterContact: false,
    pocketedNumbers: [],
    cueScratch: false,
  };

  let ticks = 0;
  while (isMoving(next) && ticks < MAX_SHOT_TICKS) {
    tickPhysics(next, meta);
    ticks++;
  }

  // Collapse anything still fading into its pocket: the stored table is a
  // settled table, and a half-animated ball must not read as "still rolling".
  for (const b of next) {
    b.vx = 0;
    b.vy = 0;
    if (b.animatingPocket) {
      b.pocketed = true;
      b.animatingPocket = false;
      b.opacity = 0;
      b.scale = 0.2;
    }
  }

  return { balls: next, meta, ticks };
}

/**
 * Apply one shot to the server's match state: simulate it, rule on it, and hand
 * back the state the next shot starts from.
 *
 * The rulebook speaks in the SHOOTER's view (`myTeam`/`oppTeam`); the stored
 * state is keyed by SEAT. The swap below is the boundary between those two, and
 * it is the only place they meet.
 */
export function applyPoolShot(
  state: PoolServerState,
  shot: PoolShotInput,
): { state: PoolServerState; result: PoolShotResult } {
  const shooter: PlayerTurn = state.turn;
  const { balls, meta, ticks } = simulatePoolShot(state.balls, shot);

  const shooterTeam: Team = shooter === 1 ? state.team1 : state.team2;
  const opponentTeam: Team = shooter === 1 ? state.team2 : state.team1;

  const ruling = evaluateRules({
    balls,
    turn: shooter,
    myTurn: shooter,
    myTeam: shooterTeam,
    oppTeam: opponentTeam,
    openTable: state.openTable,
    firstContact: meta.firstContactNumber,
    railAfterContact: meta.railAfterContact,
    pocketed: Array.from(new Set(meta.pocketedNumbers)),
    scratch: meta.cueScratch,
  });

  const nextTeam1 = shooter === 1 ? ruling.assignedMyTeam : ruling.assignedOppTeam;
  const nextTeam2 = shooter === 1 ? ruling.assignedOppTeam : ruling.assignedMyTeam;
  const openTable = !(nextTeam1 && nextTeam2);

  return {
    result: { balls, meta, ticks },
    state: {
      ...state,
      balls,
      turn: ruling.nextTurn,
      team1: nextTeam1,
      team2: nextTeam2,
      openTable,
      ballInHand: ruling.ballInHand,
      winner: ruling.winner,
      version: state.version + 1,
      lastShooter: shooter,
      foul: ruling.foul,
      foulMessage: ruling.foulMessage,
    },
  };
}
