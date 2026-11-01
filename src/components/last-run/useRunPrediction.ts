"use client";

// src/components/last-run/useRunPrediction.ts
//
// 60 Hz LOCAL PREDICTION FOR LAST RUN.
//
// ── WHY ───────────────────────────────────────────────────────────────────
//
// The match is authoritative and HTTP-read (~8 Hz while racing). Replaying
// that read verbatim is what made the arena feel broken: a 0.58 s jump contains
// two snapshots, so a takeoff, an apex and a landing arrived as three teleports,
// and a duck or a crash only showed up a quarter of a second after it happened.
//
// So the arena runs the SAME deterministic engine the server runs
// (src/lib/last-run/engine.ts is pure: same seed, same inputs, same ticks), at
// the server's own tick rate, on the server's own clock.
//
//   * YOUR lane advances on your own held input, the moment you press it. No
//     round trip sits between the key and the body.
//   * YOUR RIVAL's lane cannot be predicted from inputs we do not have, so each
//     snapshot re-anchors its exact (y, vy) and the loop integrates the arc from
//     there — airborne motion is pure gravity, so the arc is exact.
//
// ── AUTHORITY IS UNCHANGED ────────────────────────────────────────────────
//
// This hook renders only. It steps with NO obstacles, so it can never invent or
// avoid a collision; `alive`, survival times and the result come from the
// server's snapshot and are adopted verbatim. Every value published here is
// overwritten by the next snapshot, and a real divergence (a dropped input, a
// throttled tab) is corrected rather than accumulated.

import { useEffect, useRef, useState } from "react";

import { DT, TICK_MS } from "../../lib/last-run/constants";
import {
  createRunner,
  stepRunner,
  type Obstacle,
  type RunnerInput,
  type RunnerState,
} from "../../lib/last-run/engine";
import type { MatchSnapshot, SnapshotSeat } from "../../lib/last-run/matchRegistry";

/** What the arena draws: the four fields a lane's pose is made of. */
export type PredictedSeat = {
  distance: number;
  y: number;
  ducking: boolean;
  alive: boolean;
};

export type PredictedRun = { you: PredictedSeat; rival: PredictedSeat };

/**
 * No obstacles are passed while predicting: collisions are the server's alone,
 * and a locally invented death would end a run the server never ended.
 */
const NO_OBSTACLES: readonly Obstacle[] = [];

/** A stalled tab must not replay minutes of simulation inside one frame. */
const MAX_CATCHUP_TICKS = 120;

/**
 * Local distance further than this from the server's is a real desync (dropped
 * input, socket stall), not the constant few-pixel offset of a clock estimate,
 * so it is worth a visible correction.
 */
const RESYNC_PX = 48;

type Lane = { runner: RunnerState; tick: number };

function runnerFromSeat(seat: SnapshotSeat): RunnerState {
  return {
    distance: seat.distance,
    y: seat.y,
    vy: seat.vy,
    onGround: seat.onGround,
    ducking: seat.ducking,
    jumpHeld: false,
    alive: seat.alive,
    crashedAtTick: seat.crashedAtTick,
  };
}

function toSeat(runner: RunnerState): PredictedSeat {
  return {
    distance: runner.distance,
    y: runner.y,
    ducking: runner.ducking,
    alive: runner.alive,
  };
}

/** The server's tick for the current server instant, clamped to the course. */
function tickAt(serverNow: number, startsAt: number, durationSeconds: number): number {
  const lastTick = Math.ceil((durationSeconds * 1000) / TICK_MS);
  const tick = Math.floor((serverNow - startsAt) / TICK_MS);
  return Math.max(0, Math.min(lastTick, tick));
}

/** Step one lane forward to `target`, holding `input` for every tick. */
function stepLane(lane: Lane, target: number, input: () => RunnerInput): void {
  if (!lane.runner.alive) return;
  if (lane.tick < target - MAX_CATCHUP_TICKS) lane.tick = target - MAX_CATCHUP_TICKS;
  while (lane.tick < target && lane.runner.alive) {
    lane.runner = stepRunner(lane.runner, input(), lane.tick, DT, NO_OBSTACLES);
    lane.tick += 1;
  }
}

/**
 * The predicted pose of both lanes, or `null` when the match is not racing (the
 * arena then shows the snapshot's own values).
 */
export function useRunPrediction({
  snapshot,
  serverNow,
  held,
  active,
}: {
  snapshot: MatchSnapshot | null;
  serverNow: () => number;
  held: RunnerInput;
  active: boolean;
}): PredictedRun | null {
  const [run, setRun] = useState<PredictedRun | null>(null);

  const snapshotRef = useRef<MatchSnapshot | null>(snapshot);
  const serverNowRef = useRef(serverNow);
  const heldRef = useRef(held);
  const lanes = useRef({
    you: { runner: createRunner(), tick: 0 } as Lane,
    rival: { runner: createRunner(), tick: 0 } as Lane,
    rivalDuck: false,
    seeded: false,
  });

  useEffect(() => {
    serverNowRef.current = serverNow;
  }, [serverNow]);

  useEffect(() => {
    heldRef.current = held;
  }, [held]);

  // ── Re-anchor on every authoritative read ──────────────────────────────
  useEffect(() => {
    snapshotRef.current = snapshot;
    const lane = lanes.current;
    if (!snapshot) {
      lane.seeded = false;
      return;
    }

    const tick = snapshot.tick;
    if (!lane.seeded) {
      lane.you = { runner: runnerFromSeat(snapshot.you), tick };
      lane.rival = { runner: runnerFromSeat(snapshot.opponent), tick };
      lane.rivalDuck = snapshot.opponent.ducking;
      lane.seeded = true;
      return;
    }

    // The rival is re-anchored outright: we have no input log for it, and its
    // exact pose at the captured tick is all we need to continue the arc.
    lane.rival = { runner: runnerFromSeat(snapshot.opponent), tick };
    lane.rivalDuck = snapshot.opponent.ducking;

    // Your lane keeps the jump it already started. A snapshot captured before
    // the server saw the press would otherwise snap the body back to the
    // ground and re-fire the jump — the exact stutter this hook exists to fix.
    if (!snapshot.you.alive) {
      lane.you = { runner: runnerFromSeat(snapshot.you), tick: Math.max(lane.you.tick, tick) };
      return;
    }
    if (snapshot.you.onGround && lane.you.runner.onGround) {
      lane.you.runner = { ...lane.you.runner, y: 0, vy: 0, onGround: true };
    }
    if (Math.abs(snapshot.you.distance - lane.you.runner.distance) > RESYNC_PX) {
      lane.you.runner = { ...lane.you.runner, distance: snapshot.you.distance };
    }
  }, [snapshot]);

  // ── The 60 Hz clock ────────────────────────────────────────────────────
  useEffect(() => {
    if (!active) {
      setRun(null);
      return undefined;
    }

    let raf = 0;
    const frame = () => {
      const snapshotNow = snapshotRef.current;
      const lane = lanes.current;
      if (snapshotNow && lane.seeded) {
        const target = tickAt(
          serverNowRef.current(),
          snapshotNow.startsAt,
          snapshotNow.course.duration,
        );
        // The rival's held duck is the only state we cannot derive from
        // physics; the snapshot supplies it and it is re-read next read.
        stepLane(lane.rival, target, () => ({ jump: false, duck: lane.rivalDuck }));
        stepLane(lane.you, target, () => heldRef.current);
        setRun({ you: toSeat(lane.you.runner), rival: toSeat(lane.rival.runner) });
      }
      raf = requestAnimationFrame(frame);
    };

    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [active]);

  return run;
}

export default useRunPrediction;
