"use client";

// src/components/mini-golf/MiniGolfCourse.tsx
//
// The Mini Golf course renderer. It draws the EXACT server-generated hole
// (walls, bumpers, sand, water, tee, cup) plus both seats' balls, and turns
// pointer input into an aim direction + shot power.
//
// Trust boundary: this component renders authoritative geometry and reports the
// player's *request* (`{ angle, power }`) upward. It never simulates the ball —
// the trajectory it animates is the `path` the server returned.
//
// Aiming mirrors the Pool Masters table exactly (see
// `src/lib/pool/render.ts` + the pool match view), because that is the
// interaction players already know on this platform:
//
//   phase 1 (unlocked) — moving the pointer pivots the aim; a CLICK locks the
//                        angle in place (the line turns green).
//   phase 2 (locked)   — dragging away from the ball charges power; releasing
//                        launches. A click with no drag unlocks, so the player
//                        can re-aim. There is no shoot button and no slider.
//
// The ball art is likewise the Pool Masters language — a contact shadow, a
// radial gloss gradient, a rim shade and a bold outline — with a golf-specific
// rolling read: the dimple cluster rotates with the distance travelled, a
// fading trail streams behind a moving ball, and the ball shrinks into the cup.

import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { BALL_RADIUS, CUP_RADIUS } from "../../lib/mini-golf/constants";
import type { Hole, Vec2 } from "../../lib/mini-golf/types";
import {
  aimPreviewLength,
  courseScale,
  degreesBetween,
  directionFromAngle,
  distanceBetween,
  powerFromDrag,
  seatColor,
  toCoursePoint,
} from "../../lib/mini-golf/ui";

type Seat = "player1" | "player2";
type BallView = { x: number; y: number; holedOut?: boolean };

export type MiniGolfAim = { angle: number; power: number };

export type MiniGolfCourseProps = {
  /** The hole to draw (already resolved for the authoritative current hole). */
  hole: Hole | null;
  balls: Record<Seat, BallView> | null;
  /** Overrides the animating seat's ball while the server trajectory plays. */
  movingSeat?: Seat | null;
  movingBall?: Vec2 | null;
  /** The local seat's current aim preview (direction + power). */
  aim?: MiniGolfAim | null;
  /** Where the local seat's aim originates (its ball, or the last rest point). */
  aimFrom?: Vec2 | null;
  /** True once the player has clicked to pin the angle (drag now charges power). */
  aimLocked?: boolean;
  /** False while a shot is resolving, the opponent is to shoot, or the hole is done. */
  interactive?: boolean;
  /** Angle-only update while the pointer pivots an UNLOCKED aim. */
  onAim?: (aim: MiniGolfAim) => void;
  /** A click with no drag pinned the angle. */
  onLock?: () => void;
  /** A click while locked released the angle again, so the player can re-aim. */
  onUnlock?: () => void;
  /** A locked power drag was released — this is the shot request. */
  onLaunch?: (aim: MiniGolfAim) => void;
  viewerSeat?: Seat | null;
  className?: string;
};

// ── Palette ───────────────────────────────────────────────────────────────

const FAIRWAY_CORE = "#0e5c33";
const FAIRWAY_MID = "#0b3d24";
const FAIRWAY_EDGE = "#072316";
const WALL_FILL = "#e2e8f0";
const WALL_SHADOW = "#7c8b9c";
const SAND = "#e7c873";
const SAND_EDGE = "#c9a949";
const WATER = "#2f7fd6";
const BUMPER = "#111827";
const BUMPER_EDGE = "#7c8b9c";

/** A drag shorter than this (css px) counts as a click, not a power charge. */
const LOCK_CLICK_EPSILON = 4;
/** How many animated positions the motion trail keeps. */
const TRAIL_LENGTH = 16;
/** Ball fill when a seat has no colour yet. */
const DEFAULT_BALL = "#e5e7eb";

/** Per-seat ball fill: the duotone the scoreboard and aim guide already use. */
function ballColor(seat: Seat): string {
  return seatColor(seat) || DEFAULT_BALL;
}

function roundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export default function MiniGolfCourse({
  hole,
  balls,
  movingSeat = null,
  movingBall = null,
  aim = null,
  aimFrom = null,
  aimLocked = false,
  interactive = false,
  onAim,
  onLock,
  onUnlock,
  onLaunch,
  viewerSeat = null,
  className = "",
}: MiniGolfCourseProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);
  const dragOriginRef = useRef<Vec2 | null>(null);
  const aimLockedRef = useRef(aimLocked);
  const aimRef = useRef(aim);
  const [box, setBox] = useState({ width: 0, height: 0 });
  // Rolling reads: how far the animating ball has travelled, and its recent
  // positions (the motion trail). Refs, not state — they only feed the paint.
  const rollRef = useRef<{ last: Vec2 | null; travelled: number; trail: Vec2[] }>({
    last: null,
    travelled: 0,
    trail: [],
  });

  // Keep the latest props available to the pointer handlers without making
  // them re-create on every aim change (which would drop pointer capture).
  useEffect(() => {
    aimLockedRef.current = aimLocked;
  }, [aimLocked]);
  useEffect(() => {
    aimRef.current = aim;
  }, [aim]);

  // Track the wrapper's CSS box so the canvas can size itself to the available
  // space (never a fixed desktop resolution).
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect) return;
      setBox({ width: Math.max(0, rect.width), height: Math.max(0, rect.height) });
    });
    observer.observe(el);
    setBox({ width: el.clientWidth, height: el.clientHeight });
    return () => observer.disconnect();
  }, []);

  const pointFromEvent = useCallback(
    (
      event: ReactPointerEvent<HTMLCanvasElement>,
    ): { course: Vec2; render: ReturnType<typeof courseScale> } | null => {
      const canvas = canvasRef.current;
      if (!canvas || !hole?.geometry) return null;
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return null;
      const render = courseScale(hole.geometry, rect.width, rect.height);
      const course = toCoursePoint(
        { x: event.clientX - rect.left, y: event.clientY - rect.top },
        render,
      );
      return { course, render };
    },
    [hole],
  );

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      if (!interactive) return;
      const mapped = pointFromEvent(event);
      if (!mapped) return;
      draggingRef.current = true;
      dragOriginRef.current = mapped.course;
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {}
      // Unlocked: the press is the start of a pivot. Locked: it is the start of
      // a power charge.
    },
    [interactive, pointFromEvent],
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      if (!interactive) return;
      const mapped = pointFromEvent(event);
      if (!mapped) return;
      const { course } = mapped;
      const locked = aimLockedRef.current;

      if (!locked) {
        // Phase 1 — the pointer pivots the aim around the ball. Power is left
        // untouched so locking never also charges a shot.
        if (!aimFrom) return;
        onAim?.({
          angle: degreesBetween(aimFrom, course),
          power: aimRef.current?.power ?? 0,
        });
        return;
      }

      // Phase 2 — power is the distance dragged since the charge began.
      const origin = dragOriginRef.current;
      if (!origin || !draggingRef.current) return;
      onAim?.({
        angle: aimRef.current?.angle ?? 0,
        power: powerFromDrag(distanceBetween(origin, course)),
      });
    },
    [interactive, aimFrom, pointFromEvent, onAim],
  );

  const endDrag = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      const hadDrag = draggingRef.current;
      const origin = dragOriginRef.current;
      draggingRef.current = false;
      dragOriginRef.current = null;
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {}
      if (!interactive || !hadDrag) return;

      const locked = aimLockedRef.current;
      if (!locked) {
        // A click pins the angle. (A pivot drag also ends here — the angle it
        // reached is what gets pinned.)
        onLock?.();
        return;
      }

      // Locked: a real power charge launches; a click with no drag unlocks so
      // the player can aim again.
      const mapped = pointFromEvent(event);
      const power = mapped && origin
        ? powerFromDrag(distanceBetween(origin, mapped.course))
        : 0;
      if (power < LOCK_CLICK_EPSILON) {
        onUnlock?.();
        return;
      }
      onLaunch?.({
        angle: aimRef.current?.angle ?? 0,
        power,
      });
    },
    [interactive, pointFromEvent, onLock, onUnlock, onLaunch],
  );

  // ── Painting ────────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const geometry = hole?.geometry;
    if (!geometry) return;

    const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    const cssWidth = box.width;
    const cssHeight = box.height;
    if (cssWidth <= 0 || cssHeight <= 0) return;

    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(cssHeight * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const { scale, offsetX, offsetY } = courseScale(geometry, cssWidth, cssHeight);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);
    ctx.save();
    ctx.translate(offsetX, offsetY);
    ctx.scale(scale, scale);

    const w = geometry.width;
    const h = geometry.height;
    const cup = geometry.cup;
    const cupR = cup.r ?? CUP_RADIUS;

    // ── Fairway: a radial gradient so the green reads as a lit surface rather
    //    than a flat fill (the same trick the pool felt uses).
    const fairway = ctx.createRadialGradient(
      cup.x,
      cup.y,
      40,
      w / 2,
      h / 2,
      Math.max(w, h) * 0.72,
    );
    fairway.addColorStop(0, FAIRWAY_CORE);
    fairway.addColorStop(0.62, FAIRWAY_MID);
    fairway.addColorStop(1, FAIRWAY_EDGE);
    roundedRectPath(ctx, 0, 0, w, h, 22);
    ctx.fillStyle = fairway;
    ctx.fill();
    ctx.strokeStyle = "rgba(16,185,129,0.35)";
    ctx.lineWidth = 2.5;
    ctx.stroke();

    // ── Water hazards (under everything else that sits on the fairway)
    for (const water of geometry.water ?? []) {
      const pond = ctx.createRadialGradient(
        water.x - water.r * 0.3,
        water.y - water.r * 0.3,
        2,
        water.x,
        water.y,
        water.r,
      );
      pond.addColorStop(0, "#7cc0ff");
      pond.addColorStop(1, "#1d4ed8");
      ctx.beginPath();
      ctx.arc(water.x, water.y, water.r, 0, Math.PI * 2);
      ctx.fillStyle = pond;
      ctx.globalAlpha = 0.82;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = "#1d4ed8";
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }

    // ── Sand patches
    for (const patch of geometry.sand ?? []) {
      const bunker = ctx.createRadialGradient(
        patch.x - patch.r * 0.25,
        patch.y - patch.r * 0.25,
        2,
        patch.x,
        patch.y,
        patch.r,
      );
      bunker.addColorStop(0, "#f6e2a6");
      bunker.addColorStop(1, SAND);
      ctx.beginPath();
      ctx.arc(patch.x, patch.y, patch.r, 0, Math.PI * 2);
      ctx.fillStyle = bunker;
      ctx.globalAlpha = 0.92;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = SAND_EDGE;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // ── Interior walls: a soft shadow under a bright rail so they read solid.
    //    The collision treats a wall as a zero-thickness segment whose band is
    //    one ball radius wide, so the rail is drawn centred on it.
    for (const wall of geometry.walls ?? []) {
      ctx.beginPath();
      ctx.moveTo(wall.a.x, wall.a.y);
      ctx.lineTo(wall.b.x, wall.b.y);
      ctx.strokeStyle = WALL_SHADOW;
      ctx.lineWidth = 9;
      ctx.lineCap = "round";
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(wall.a.x, wall.a.y);
      ctx.lineTo(wall.b.x, wall.b.y);
      ctx.strokeStyle = WALL_FILL;
      ctx.lineWidth = 5;
      ctx.stroke();
    }

    // ── Bumpers
    for (const bumper of geometry.bumpers ?? []) {
      const dome = ctx.createRadialGradient(
        bumper.x - bumper.r * 0.35,
        bumper.y - bumper.r * 0.35,
        2,
        bumper.x,
        bumper.y,
        bumper.r,
      );
      dome.addColorStop(0, "#475569");
      dome.addColorStop(0.7, BUMPER);
      dome.addColorStop(1, "#020617");
      ctx.beginPath();
      ctx.arc(bumper.x, bumper.y, bumper.r, 0, Math.PI * 2);
      ctx.fillStyle = dome;
      ctx.fill();
      ctx.strokeStyle = BUMPER_EDGE;
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }

    // ── Tee marker
    ctx.beginPath();
    ctx.arc(geometry.tee.x, geometry.tee.y, 5, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,255,255,0.35)";
    ctx.fill();

    // ── The cup: a shaded hole with a bright lip.
    const holeGrad = ctx.createRadialGradient(
      cup.x - cupR * 0.3,
      cup.y - cupR * 0.3,
      1,
      cup.x,
      cup.y,
      cupR,
    );
    holeGrad.addColorStop(0, "#0b2b1a");
    holeGrad.addColorStop(0.6, "#04140c");
    holeGrad.addColorStop(1, "#000000");
    ctx.beginPath();
    ctx.arc(cup.x, cup.y, cupR, 0, Math.PI * 2);
    ctx.fillStyle = holeGrad;
    ctx.fill();
    ctx.strokeStyle = "#f5ff3b";
    ctx.lineWidth = 2.5;
    ctx.stroke();

    // ── Rolling bookkeeping for the animating seat.
    const rolling = Boolean(movingSeat && movingBall);
    if (rolling && movingBall) {
      const track = rollRef.current;
      if (track.last) {
        track.travelled += distanceBetween(track.last, movingBall);
        track.trail.push({ x: movingBall.x, y: movingBall.y });
        if (track.trail.length > TRAIL_LENGTH) track.trail.shift();
      } else {
        track.trail = [{ x: movingBall.x, y: movingBall.y }];
      }
      track.last = { x: movingBall.x, y: movingBall.y };
    }

    // ── Motion trail: a fading ribbon behind the rolling ball, so a fast shot
    //    reads as fast. Drawn under the balls.
    if (rolling && rollRef.current.trail.length > 1) {
      const trail = rollRef.current.trail;
      ctx.save();
      ctx.lineCap = "round";
      for (let i = 1; i < trail.length; i += 1) {
        const t = i / (trail.length - 1);
        ctx.beginPath();
        ctx.moveTo(trail[i - 1].x, trail[i - 1].y);
        ctx.lineTo(trail[i].x, trail[i].y);
        ctx.strokeStyle = ballColor(movingSeat as Seat);
        ctx.globalAlpha = 0.05 + t * 0.22;
        ctx.lineWidth = BALL_RADIUS * (0.5 + t * 1.1);
        ctx.stroke();
      }
      ctx.restore();
    }

    // ── Aim preview. Unlocked: the Pool Masters dashed white guide. Locked:
    //    the angle is pinned, so the line turns green and a club is drawn
    //    behind the ball, pulled back further the harder the shot.
    if (interactive && aim && aimFrom) {
      const dir = directionFromAngle(aim.angle);
      const power = Math.max(0, Math.min(100, aim.power));
      const length = aimPreviewLength(power);
      const end = { x: aimFrom.x + dir.x * length, y: aimFrom.y + dir.y * length };
      const color = seatColor(viewerSeat);

      ctx.save();

      // The strike line.
      ctx.beginPath();
      ctx.moveTo(aimFrom.x + dir.x * BALL_RADIUS, aimFrom.y + dir.y * BALL_RADIUS);
      ctx.lineTo(end.x, end.y);
      if (aimLocked) {
        ctx.setLineDash([]);
        ctx.strokeStyle = "rgba(74,222,128,.9)";
        ctx.lineWidth = 3;
      } else {
        ctx.setLineDash([7, 6]);
        ctx.strokeStyle = "rgba(255,255,255,.44)";
        ctx.lineWidth = 2.5;
      }
      ctx.lineCap = "round";
      ctx.stroke();
      ctx.setLineDash([]);

      // Arrow head at the aim end.
      const head = 9 + (power / 100) * 8;
      ctx.beginPath();
      ctx.moveTo(end.x, end.y);
      ctx.lineTo(
        end.x - dir.x * head + dir.y * head * 0.55,
        end.y - dir.y * head - dir.x * head * 0.55,
      );
      ctx.lineTo(
        end.x - dir.x * head - dir.y * head * 0.55,
        end.y - dir.y * head + dir.x * head * 0.55,
      );
      ctx.closePath();
      ctx.fillStyle = aimLocked ? "rgba(74,222,128,.9)" : color;
      ctx.fill();

      if (aimLocked) {
        // The club, pulled back by the charge — the same gold shaft gradient
        // the pool cue uses, so "drag to charge" is legible at a glance.
        const pull = (power / 100) * 46;
        const clubGrad = ctx.createLinearGradient(
          aimFrom.x - dir.x * (34 + pull),
          aimFrom.y - dir.y * (34 + pull),
          aimFrom.x - dir.x * 8,
          aimFrom.y - dir.y * 8,
        );
        clubGrad.addColorStop(0, "#540000");
        clubGrad.addColorStop(0.42, "#d7a348");
        clubGrad.addColorStop(0.86, "#ffe283");
        clubGrad.addColorStop(1, "#f9fafb");
        ctx.strokeStyle = clubGrad;
        ctx.lineWidth = 6;
        ctx.beginPath();
        ctx.moveTo(aimFrom.x - dir.x * (38 + pull), aimFrom.y - dir.y * (38 + pull));
        ctx.lineTo(aimFrom.x - dir.x * 10, aimFrom.y - dir.y * 10);
        ctx.stroke();

        // Power arc around the ball: a locked, unmistakable read on the charge.
        ctx.beginPath();
        ctx.arc(
          aimFrom.x,
          aimFrom.y,
          BALL_RADIUS + 6,
          -Math.PI / 2,
          -Math.PI / 2 + (power / 100) * Math.PI * 2,
        );
        ctx.strokeStyle = color;
        ctx.lineWidth = 3;
        ctx.stroke();
      }

      ctx.restore();
    }

    // ── Balls — the animating seat uses the server trajectory position.
    for (const seat of ["player1", "player2"] as const) {
      const ball = balls?.[seat];
      const isMoving = movingSeat === seat && Boolean(movingBall);
      const position = isMoving ? (movingBall as Vec2) : ball;
      if (!position) continue;

      const holed = Boolean(ball?.holedOut) && !isMoving;
      const x = holed ? cup.x : position.x;
      const y = holed ? cup.y : position.y;

      // How far into the cup the ball has sunk. While animating, this tracks
      // how close the ball is to the cup centre, so the sink reads as motion
      // rather than a pop; a holed-out resting ball is drawn fully in.
      let sink = 0;
      if (isMoving) {
        const d = Math.hypot(x - cup.x, y - cup.y);
        if (d < cupR) sink = 1 - d / cupR;
      } else if (holed) {
        sink = 1;
      }
      const radius = BALL_RADIUS * (1 - sink * 0.45);

      // While rolling, the dimple cluster rotates with the distance travelled.
      const roll = rollRef.current.last && isMoving
        ? rollRef.current.travelled / BALL_RADIUS
        : 0;

      ctx.save();

      // ── Contact shadow on the green (skipped once the ball is in the cup).
      if (sink < 1) {
        ctx.fillStyle = `rgba(0,0,0,${0.3 * (1 - sink)})`;
        ctx.beginPath();
        ctx.ellipse(
          x + 3,
          y + 4,
          radius * 0.85,
          radius * 0.45,
          0,
          0,
          Math.PI * 2,
        );
        ctx.fill();
      }

      // Everything below is clipped to the cup while the ball is dropping, so
      // it visually falls in from the lip instead of floating on top.
      ctx.beginPath();
      ctx.arc(x, y, Math.max(0.5, radius), 0, Math.PI * 2);
      ctx.save();
      ctx.clip();

      ctx.translate(x, y);

      const base = ballColor(seat);
      ctx.shadowColor = "rgba(0,0,0,.55)";
      ctx.shadowBlur = 6;
      ctx.shadowOffsetX = 2;
      ctx.shadowOffsetY = 3;
      ctx.fillStyle = base;
      ctx.beginPath();
      ctx.arc(0, 0, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 0;

      // ── Dimples: two rings of small dots, rotated by the roll so a moving
      //    ball visibly turns instead of sliding.
      ctx.save();
      ctx.rotate(roll);
      ctx.fillStyle = "rgba(0,0,0,0.20)";
      for (let i = 0; i < 6; i += 1) {
        const a = (i / 6) * Math.PI * 2;
        ctx.beginPath();
        ctx.arc(
          Math.cos(a) * radius * 0.55,
          Math.sin(a) * radius * 0.55,
          radius * 0.12,
          0,
          Math.PI * 2,
        );
        ctx.fill();
      }
      for (let i = 0; i < 3; i += 1) {
        const a = (i / 3) * Math.PI * 2 + Math.PI / 6;
        ctx.beginPath();
        ctx.arc(
          Math.cos(a) * radius * 0.22,
          Math.sin(a) * radius * 0.22,
          radius * 0.1,
          0,
          Math.PI * 2,
        );
        ctx.fill();
      }
      ctx.restore();

      // ── Gloss: the Pool Masters radial gradient (white highlight top-left,
      //    dark rim bottom-right).
      const gloss = ctx.createRadialGradient(
        -radius * 0.7,
        -radius * 0.85,
        1,
        -radius * 0.3,
        -radius * 0.4,
        radius * 1.35,
      );
      gloss.addColorStop(0, "rgba(255,255,255,.96)");
      gloss.addColorStop(0.22, "rgba(255,255,255,.30)");
      gloss.addColorStop(0.68, "rgba(0,0,0,0)");
      gloss.addColorStop(1, "rgba(0,0,0,.35)");
      ctx.fillStyle = gloss;
      ctx.beginPath();
      ctx.arc(0, 0, radius, 0, Math.PI * 2);
      ctx.fill();

      ctx.restore(); // clip

      // ── Bold outline, drawn outside the clip so the edge stays crisp.
      ctx.beginPath();
      ctx.arc(x, y, Math.max(0.5, radius), 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(255,255,255,0.9)";
      ctx.lineWidth = 1.6;
      ctx.stroke();

      // ── Lip highlight for a ball sitting in the cup.
      if (sink >= 1) {
        ctx.beginPath();
        ctx.arc(cup.x, cup.y, cupR, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(245,255,59,0.5)";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      ctx.restore();
    }

    ctx.restore();
  }, [
    hole,
    balls,
    movingSeat,
    movingBall,
    aim,
    aimFrom,
    aimLocked,
    interactive,
    viewerSeat,
    box,
  ]);

  // Reset the roll/trail bookkeeping whenever a new rollout starts or stops, so
  // a fresh shot never inherits the previous one's rotation.
  useEffect(() => {
    if (!movingSeat || !movingBall) {
      rollRef.current = { last: null, travelled: 0, trail: [] };
    }
  }, [movingSeat, movingBall]);

  const locked = aimLocked && interactive;

  return (
    <div ref={wrapRef} className={`relative h-full w-full ${className}`}>
      <canvas
        ref={canvasRef}
        data-testid="mini-golf-canvas"
        aria-label="Mini Golf course"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onPointerLeave={endDrag}
        style={{
          width: "100%",
          height: "100%",
          display: "block",
          touchAction: "none",
          cursor: interactive ? (locked ? "ns-resize" : "crosshair") : "default",
        }}
      />
    </div>
  );
}
