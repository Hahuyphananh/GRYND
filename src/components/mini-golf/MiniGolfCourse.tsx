"use client";

// src/components/mini-golf/MiniGolfCourse.tsx
//
// The Mini Golf course renderer. It draws the EXACT server-generated hole
// (walls, bumpers, sand, water, tee, cup) plus both seats' balls, and turns
// pointer drags (mouse, pen or touch) into an aim direction + shot power.
//
// Trust boundary: this component renders authoritative geometry and reports the
// player's *request* (`{ angle, power }`) upward. It never simulates the ball —
// the trajectory it animates is the `path` the server returned.

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
  /** False while a shot is resolving, the opponent is to shoot, or the hole is done. */
  interactive?: boolean;
  onAim?: (aim: MiniGolfAim) => void;
  viewerSeat?: Seat | null;
  className?: string;
};

const FAIRWAY = "#0b3d24";
const FAIRWAY_EDGE = "#0a2e1b";
const WALL_FILL = "#e2e8f0";
const WALL_SHADOW = "#94a3b8";
const SAND = "#e7c873";
const WATER = "#2f7fd6";
const BUMPER = "#1e293b";
const BUMPER_EDGE = "#64748b";

export default function MiniGolfCourse({
  hole,
  balls,
  movingSeat = null,
  movingBall = null,
  aim = null,
  aimFrom = null,
  interactive = false,
  onAim,
  viewerSeat = null,
  className = "",
}: MiniGolfCourseProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);
  const [box, setBox] = useState({ width: 0, height: 0 });

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
    (event: ReactPointerEvent<HTMLCanvasElement>): { course: Vec2; render: ReturnType<typeof courseScale> } | null => {
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

  const reportAim = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      if (!interactive || !onAim) return;
      const from = aimFrom;
      if (!from) return;
      const mapped = pointFromEvent(event);
      if (!mapped) return;
      const { course } = mapped;
      onAim({
        angle: degreesBetween(from, course),
        power: powerFromDrag(distanceBetween(from, course)),
      });
    },
    [interactive, onAim, aimFrom, pointFromEvent],
  );

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      if (!interactive) return;
      draggingRef.current = true;
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {}
      reportAim(event);
    },
    [interactive, reportAim],
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      if (!draggingRef.current) return;
      reportAim(event);
    },
    [reportAim],
  );

  const endDrag = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    draggingRef.current = false;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {}
  }, []);

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

    // Fairway
    const radius = 22;
    ctx.beginPath();
    ctx.moveTo(radius, 0);
    ctx.lineTo(w - radius, 0);
    ctx.quadraticCurveTo(w, 0, w, radius);
    ctx.lineTo(w, h - radius);
    ctx.quadraticCurveTo(w, h, w - radius, h);
    ctx.lineTo(radius, h);
    ctx.quadraticCurveTo(0, h, 0, h - radius);
    ctx.lineTo(0, radius);
    ctx.quadraticCurveTo(0, 0, radius, 0);
    ctx.closePath();
    ctx.fillStyle = FAIRWAY;
    ctx.fill();
    ctx.strokeStyle = FAIRWAY_EDGE;
    ctx.lineWidth = 4;
    ctx.stroke();

    // Water hazards (under everything else that sits on the fairway)
    for (const water of geometry.water ?? []) {
      ctx.beginPath();
      ctx.arc(water.x, water.y, water.r, 0, Math.PI * 2);
      ctx.fillStyle = WATER;
      ctx.globalAlpha = 0.75;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = "#1d4ed8";
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }

    // Sand patches
    for (const patch of geometry.sand ?? []) {
      ctx.beginPath();
      ctx.arc(patch.x, patch.y, patch.r, 0, Math.PI * 2);
      ctx.fillStyle = SAND;
      ctx.globalAlpha = 0.85;
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    // Walls: a soft shadow under a bright rail so they read as solid.
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

    // Bumpers
    for (const bumper of geometry.bumpers ?? []) {
      ctx.beginPath();
      ctx.arc(bumper.x, bumper.y, bumper.r, 0, Math.PI * 2);
      ctx.fillStyle = BUMPER;
      ctx.fill();
      ctx.strokeStyle = BUMPER_EDGE;
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }

    // Tee marker
    ctx.beginPath();
    ctx.arc(geometry.tee.x, geometry.tee.y, 5, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,255,255,0.35)";
    ctx.fill();

    // The cup
    ctx.beginPath();
    ctx.arc(geometry.cup.x, geometry.cup.y, geometry.cup.r ?? CUP_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = "#04140c";
    ctx.fill();
    ctx.strokeStyle = "#f5ff3b";
    ctx.lineWidth = 2.5;
    ctx.stroke();

    // Aim preview — always drawn in the viewer's own colour.
    if (interactive && aim && aimFrom) {
      const dir = directionFromAngle(aim.angle);
      const length = aimPreviewLength(aim.power);
      const end = { x: aimFrom.x + dir.x * length, y: aimFrom.y + dir.y * length };
      const color = seatColor(viewerSeat);

      ctx.save();
      ctx.setLineDash([7, 6]);
      ctx.beginPath();
      ctx.moveTo(aimFrom.x, aimFrom.y);
      ctx.lineTo(end.x, end.y);
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.9;
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;

      // Arrow head
      const head = 10 + (aim.power / 100) * 8;
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
      ctx.fillStyle = color;
      ctx.fill();
      ctx.restore();
    }

    // Balls — the animating seat uses the server trajectory position.
    for (const seat of ["player1", "player2"] as const) {
      const ball = balls?.[seat];
      const isMoving = movingSeat === seat && movingBall;
      const position = isMoving ? movingBall : ball;
      if (!position) continue;
      // A holed-out ball that is not animating is drawn inside the cup.
      const holed = Boolean(ball?.holedOut) && !isMoving;
      const x = holed ? geometry.cup.x : position.x;
      const y = holed ? geometry.cup.y : position.y;
      const r = holed ? BALL_RADIUS * 0.7 : BALL_RADIUS;

      ctx.beginPath();
      ctx.arc(x, y + 1.5, r, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(0,0,0,0.35)";
      ctx.fill();

      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = seatColor(seat);
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.85)";
      ctx.lineWidth = 1.6;
      ctx.stroke();
    }

    ctx.restore();
  }, [hole, balls, movingSeat, movingBall, aim, aimFrom, interactive, viewerSeat, box]);

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
          cursor: interactive ? "crosshair" : "default",
        }}
      />
    </div>
  );
}
