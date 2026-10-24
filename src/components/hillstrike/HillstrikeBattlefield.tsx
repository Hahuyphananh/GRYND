"use client";

// src/components/hillstrike/HillstrikeBattlefield.tsx
//
// The Hillstrike battlefield: one responsive canvas that draws the battlefield
// the ENGINE handed down, and turns a drag gesture into an aim.
//
// ── TRUST BOUNDARY ────────────────────────────────────────────────────────
// This component owns NO rule. It draws `state.battlefield` (terrain columns,
// tower blocks, both players), the engine's own preview path, and the
// authoritative trajectory returned with the accepted shot. It never decides a
// collision, a life, a turn or a winner — a drag is reported upward as
// `{ angleDeg, power }` and the page applies it through `applyShot`.
//
// ── THE GESTURE ───────────────────────────────────────────────────────────
// Slingshot: press anywhere on the battlefield, drag away from where you want
// the shot to go, release. The pull vector is converted by the engine's own
// `aimFromDrag`, so the same conversion is used by the page, the preview and
// the shot. A release with a real pull LOCKS the aim (the preview stays, the
// Fire button enables); a tap clears it.
//
// ── THE ANIMATION ─────────────────────────────────────────────────────────
// A shot is animated from the trajectory the engine resolved:
//   flight  → the projectile travels the recorded `path`;
//   settle  → the post-impact battlefield is drawn, with collapse events
//             tweened, the crater already applied, an impact ring and, for a
//             direct hit, a red flash and a "-1" on the victim.
// The page updates the authoritative state when the flight ends, so lives and
// the turn change at the moment the projectile lands.

import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

import {
  BATTLEFIELD_HEIGHT,
  BATTLEFIELD_WIDTH,
  DEFAULT_MAX_PULL,
  PLAYER_RADIUS,
  TERRAIN_COLUMN_WIDTH,
  TERRAIN_COLUMNS,
} from "../../lib/hillstrike/constants";
import { aimFromDrag, directionVector } from "../../lib/hillstrike/physics";
import type { Vec2 } from "../../lib/physics2d/kinematics";
import type {
  Battlefield,
  HillstrikeState,
  Impact,
  Seat,
  ShotEvent,
  ShotInput,
  ShotRecord,
  TowerBlock,
} from "../../lib/hillstrike/types";

export type HillstrikeAnimation = {
  readonly shot: ShotRecord;
  readonly from: Battlefield;
  readonly to: Battlefield;
  readonly startedAt: number;
  readonly flightMs: number;
  readonly settleMs: number;
};

export type HillstrikePreview = {
  readonly path: readonly Vec2[];
  readonly impact: Impact;
};

export type HillstrikeBattlefieldProps = {
  state: HillstrikeState;
  viewerSeat: Seat;
  preview: HillstrikePreview | null;
  aim: ShotInput | null;
  animation: HillstrikeAnimation | null;
  /** True only while the viewer owns the turn and nothing is resolving. */
  interactive: boolean;
  resolving: boolean;
  onAim: (shot: ShotInput | null) => void;
  onLock: (shot: ShotInput) => void;
  onClear: () => void;
  className?: string;
  /**
   * What the canvas calls the OTHER seat while it is aiming. Free practice says
   * "the bot" (the default); the online match view passes the opponent's name.
   * Presentation only — it never changes what is drawn.
   */
  opponentLabel?: string;
};

// ── Palette ───────────────────────────────────────────────────────────────
// Seat colours are the platform's game tokens (--gr-player-1 / --gr-player-2)
// so Hillstrike matches every other board on the site.
const SEAT_COLOR: Record<Seat, string> = {
  player1: "#00e5ff",
  player2: "#ff4fd8",
};
const SEAT_DARK: Record<Seat, string> = {
  player1: "#063346",
  player2: "#3a0a32",
};
const SKY_TOP = "#04101f";
const SKY_BOTTOM = "#0a214d";
const HILL_TOP = "#1b7a52";
const HILL_BOTTOM = "#052018";
const HILL_EDGE = "rgba(124, 240, 184, 0.55)";
const INK = "#e8fbff";
const OUTLINE = "#05101f";

const worldToCssFont = (size: number) => `${size}px ui-sans-serif, system-ui, sans-serif`;

function terrainSignature(terrain: readonly number[]): number {
  let sum = 0;
  for (const height of terrain) sum += height;
  return sum;
}

function easeOut(t: number): number {
  const clamped = Math.max(0, Math.min(1, t));
  return 1 - (1 - clamped) * (1 - clamped);
}

function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

/** Position at `t` (0…1) along a polyline, by uniform point interpolation. */
function pointAlong(path: readonly Vec2[], t: number): Vec2 {
  if (path.length === 0) return { x: 0, y: 0 };
  if (path.length === 1) return { ...path[0] };
  const scaled = Math.max(0, Math.min(1, t)) * (path.length - 1);
  const index = Math.floor(scaled);
  const next = Math.min(path.length - 1, index + 1);
  const fraction = scaled - index;
  return {
    x: path[index].x + (path[next].x - path[index].x) * fraction,
    y: path[index].y + (path[next].y - path[index].y) * fraction,
  };
}

/** The last `count` points before `t`, for the motion trail. */
function trailAlong(path: readonly Vec2[], t: number, count: number): Vec2[] {
  const scaled = Math.max(0, Math.min(1, t)) * (path.length - 1);
  const out: Vec2[] = [];
  for (let step = 1; step <= count; step++) {
    const index = scaled - step;
    if (index < 0) break;
    const lower = Math.floor(index);
    const upper = Math.min(path.length - 1, lower + 1);
    const fraction = index - lower;
    out.push({
      x: path[lower].x + (path[upper].x - path[lower].x) * fraction,
      y: path[lower].y + (path[upper].y - path[lower].y) * fraction,
    });
  }
  return out;
}

export default function HillstrikeBattlefield({
  state,
  viewerSeat,
  preview,
  aim,
  animation,
  interactive,
  resolving,
  onAim,
  onLock,
  onClear,
  className = "",
  opponentLabel = "the bot",
}: HillstrikeBattlefieldProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
  } | null>(null);
  const [dragging, setDragging] = useState(false);

  // The draw loop reads the latest props through a ref, so a rAF frame never
  // renders a stale battlefield while a shot is animating.
  const propsRef = useRef({
    state,
    viewerSeat,
    preview,
    aim,
    animation,
    interactive,
  });
  propsRef.current = { state, viewerSeat, preview, aim, animation, interactive };

  const drawRef = useRef<() => void>(() => {});
  // Layout is read once per resize, never per animation frame.
  const sizeRef = useRef({ cssWidth: 0, cssHeight: 0, dpr: 1 });

  const applyCanvasSize = useCallback(() => {
    const canvas = canvasRef.current;
    const wrapper = wrapperRef.current;
    if (!canvas || !wrapper) return;
    const cssWidth = wrapper.clientWidth;
    const cssHeight = wrapper.clientHeight;
    if (cssWidth <= 0 || cssHeight <= 0) return;
    const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    const pixelWidth = Math.round(cssWidth * dpr);
    const pixelHeight = Math.round(cssHeight * dpr);
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    sizeRef.current = { cssWidth, cssHeight, dpr };
  }, []);

  drawRef.current = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (sizeRef.current.cssWidth === 0) applyCanvasSize();
    const size = sizeRef.current;
    if (!size.cssWidth || !size.cssHeight) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const {
      state: current,
      viewerSeat: viewer,
      preview: currentPreview,
      aim: currentAim,
      animation: currentAnimation,
      interactive: currentInteractive,
    } = propsRef.current;

    const elapsed = currentAnimation
      ? performance.now() - currentAnimation.startedAt
      : Number.POSITIVE_INFINITY;
    const flying = Boolean(currentAnimation && elapsed < currentAnimation.flightMs);
    const settleT =
      currentAnimation && elapsed >= currentAnimation.flightMs
        ? Math.min(1, (elapsed - currentAnimation.flightMs) / currentAnimation.settleMs)
        : 0;
    const settling = Boolean(
      currentAnimation &&
        elapsed >= currentAnimation.flightMs &&
        elapsed < currentAnimation.flightMs + currentAnimation.settleMs,
    );

    const field: Battlefield =
      flying && currentAnimation ? currentAnimation.from : current.battlefield;

    const scale = Math.min(
      size.cssWidth / BATTLEFIELD_WIDTH,
      size.cssHeight / BATTLEFIELD_HEIGHT,
    );
    const offsetX = (size.cssWidth - BATTLEFIELD_WIDTH * scale) / 2;
    const offsetY = (size.cssHeight - BATTLEFIELD_HEIGHT * scale) / 2;

    ctx.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
    ctx.clearRect(0, 0, size.cssWidth, size.cssHeight);
    ctx.save();
    ctx.translate(offsetX, offsetY);
    ctx.scale(scale, scale);

    // ── Sky ────────────────────────────────────────────────────────────────
    const sky = ctx.createLinearGradient(0, 0, 0, BATTLEFIELD_HEIGHT);
    sky.addColorStop(0, SKY_TOP);
    sky.addColorStop(1, SKY_BOTTOM);
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, BATTLEFIELD_WIDTH, BATTLEFIELD_HEIGHT);

    // A few stars, at fixed positions — decoration only, no randomness.
    ctx.fillStyle = "rgba(255,255,255,0.32)";
    for (let star = 0; star < 26; star++) {
      const x = ((star * 197) % 1240) + 20;
      const y = ((star * 89) % 220) + 24;
      ctx.fillRect(x, y, 2, 2);
    }

    // ── Terrain (one solid step per column) ───────────────────────────────
    ctx.beginPath();
    ctx.moveTo(0, BATTLEFIELD_HEIGHT);
    for (let column = 0; column < TERRAIN_COLUMNS; column++) {
      const x = column * TERRAIN_COLUMN_WIDTH;
      const surface = field.terrain[column];
      ctx.lineTo(x, surface);
      ctx.lineTo(x + TERRAIN_COLUMN_WIDTH, surface);
    }
    ctx.lineTo(BATTLEFIELD_WIDTH, BATTLEFIELD_HEIGHT);
    ctx.closePath();
    const hill = ctx.createLinearGradient(0, 280, 0, BATTLEFIELD_HEIGHT);
    hill.addColorStop(0, HILL_TOP);
    hill.addColorStop(1, HILL_BOTTOM);
    ctx.fillStyle = hill;
    ctx.fill();
    ctx.strokeStyle = HILL_EDGE;
    ctx.lineWidth = 2;
    ctx.stroke();

    // ── Towers ────────────────────────────────────────────────────────────
    const collapseById = new Map<number, Extract<ShotEvent, { type: "collapse" }>>();
    if (currentAnimation && settling) {
      for (const event of currentAnimation.shot.events) {
        if (event.type === "collapse") collapseById.set(event.blockId, event);
      }
    }
    const tween = easeOut(settleT);

    for (const block of field.blocks) {
      const collapse = collapseById.get(block.id);
      const y = collapse ? collapse.fromY + (collapse.y - collapse.fromY) * tween : block.y;
      drawBlock(ctx, { ...block, y });
    }

    // ── Players ───────────────────────────────────────────────────────────
    for (const seat of ["player1", "player2"] as const) {
      const player = field.players[seat];
      const isActive = current.turn === seat && current.status === "playing";
      const displayAim =
        seat === viewer && currentAim
          ? currentAim
          : isActive
            ? { angleDeg: seat === "player1" ? 45 : 135, power: 0 }
            : null;
      drawPlayer(ctx, {
        x: player.x,
        y: player.y,
        seat,
        lives: current.lives[seat],
        active: isActive,
        label: seat === viewer ? "YOU" : "AI",
        aim: displayAim,
        charge: seat === viewer ? currentAim?.power ?? 0 : 0,
      });
    }

    // ── Aim preview (the engine's own resolution of the locked/current aim) ─
    if (currentPreview && currentAim && !flying) {
      drawPreview(ctx, currentPreview, currentAim, viewer);
    }

    // ── Projectile flight ─────────────────────────────────────────────────
    if (flying && currentAnimation) {
      const t = Math.max(0, Math.min(1, elapsed / currentAnimation.flightMs));
      const path = currentAnimation.shot.path;
      const trail = trailAlong(path, t, 10);
      trail.forEach((point, index) => {
        const alpha = ((trail.length - index) / trail.length) * 0.5;
        ctx.beginPath();
        ctx.arc(point.x, point.y, 5, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(245, 255, 59, ${alpha.toFixed(3)})`;
        ctx.fill();
      });
      const position = pointAlong(path, t);
      const glow = ctx.createRadialGradient(position.x, position.y, 1, position.x, position.y, 18);
      glow.addColorStop(0, "rgba(255,255,255,0.95)");
      glow.addColorStop(0.4, "rgba(245,255,59,0.8)");
      glow.addColorStop(1, "rgba(245,255,59,0)");
      ctx.beginPath();
      ctx.arc(position.x, position.y, 18, 0, Math.PI * 2);
      ctx.fillStyle = glow;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(position.x, position.y, 5, 0, Math.PI * 2);
      ctx.fillStyle = "#ffffff";
      ctx.fill();
    }

    // ── Impact feedback ───────────────────────────────────────────────────
    if (currentAnimation && (settling || settleT >= 1)) {
      const impact = currentAnimation.shot.impact;
      const ringT = settling ? easeOut(settleT) : 1;
      if (settling) {
        ctx.beginPath();
        ctx.arc(impact.x, impact.y, 10 + ringT * 70, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(245, 255, 59, ${(1 - ringT) * 0.85})`;
        ctx.lineWidth = 4;
        ctx.stroke();
      }
      if (currentAnimation.shot.livesLost > 0 && impact.target) {
        const victim = current.battlefield.players[impact.target];
        const flash = settling ? 1 - settleT : 0;
        ctx.beginPath();
        ctx.arc(victim.x, victim.y, PLAYER_RADIUS + 18 + ringT * 22, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(248, 113, 113, ${flash})`;
        ctx.lineWidth = 5;
        ctx.stroke();
        ctx.globalAlpha = flash;
        ctx.fillStyle = "#fecaca";
        ctx.font = `900 ${worldToCssFont(30)}`;
        ctx.textAlign = "center";
        ctx.fillText("-1", victim.x, victim.y - 46 - ringT * 26);
        ctx.globalAlpha = 1;
      }
    }

    ctx.restore();
  };

  // Static redraw whenever the props change (new state, new aim, new preview).
  useEffect(() => {
    drawRef.current();
  }, [state, preview, aim, animation, interactive]);

  // Frame loop while a shot animates.
  useEffect(() => {
    if (!animation) {
      drawRef.current();
      return;
    }
    let raf = 0;
    const loop = () => {
      drawRef.current();
      raf = window.requestAnimationFrame(loop);
    };
    raf = window.requestAnimationFrame(loop);
    return () => window.cancelAnimationFrame(raf);
  }, [animation]);

  // Track the wrapper's size, so phones and desktop both fill their column.
  useEffect(() => {
    applyCanvasSize();
    const wrapper = wrapperRef.current;
    if (!wrapper || typeof ResizeObserver === "undefined") {
      drawRef.current();
      return;
    }
    const observer = new ResizeObserver(() => {
      applyCanvasSize();
      drawRef.current();
    });
    observer.observe(wrapper);
    drawRef.current();
    return () => observer.disconnect();
  }, [applyCanvasSize]);

  const pointFor = (event: ReactPointerEvent<HTMLDivElement>) => ({
    x: event.clientX,
    y: event.clientY,
  });

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!interactive) return;
    if (event.button !== undefined && event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = pointFor(event);
    dragRef.current = { pointerId: event.pointerId, startX: point.x, startY: point.y };
    setDragging(true);
    onClear();
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const point = pointFor(event);
    const shot = aimFromDrag({
      fromX: drag.startX,
      fromY: drag.startY,
      toX: point.x,
      toY: point.y,
      maxPull: DEFAULT_MAX_PULL,
    });
    onAim(shot);
  };

  const finishDrag = (event: ReactPointerEvent<HTMLDivElement>, cancelled = false) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    if (cancelled) {
      onClear();
      return;
    }
    const point = pointFor(event);
    const shot = aimFromDrag({
      fromX: drag.startX,
      fromY: drag.startY,
      toX: point.x,
      toY: point.y,
      maxPull: DEFAULT_MAX_PULL,
    });
    if (shot) onLock(shot);
    else onClear();
  };

  const activeName = state.turn === viewerSeat ? "You" : opponentLabel;
  const opponentSeat: Seat = viewerSeat === "player1" ? "player2" : "player1";

  return (
    <div
      ref={wrapperRef}
      data-testid="hillstrike-battlefield"
      data-turn={state.turn}
      data-turn-index={state.turnIndex}
      data-status={state.status}
      data-seed={state.seed}
      data-opening-seat={state.openingSeat}
      data-resolving={resolving ? "1" : "0"}
      data-blocks={state.battlefield.blocks.length}
      data-cracked={
        state.battlefield.blocks.reduce(
          (cracked, block) => cracked + (block.integrity <= 1 ? 1 : 0),
          0,
        )
      }
      data-terrain-signature={terrainSignature(state.battlefield.terrain)}
      data-lives-you={state.lives[viewerSeat]}
      data-lives-ai={state.lives[opponentSeat]}
      data-lives-player1={state.lives.player1}
      data-lives-player2={state.lives.player2}
      data-shots-remaining={state.shotsRemaining}
      data-winner={state.winner ?? ""}
      data-aim-angle={aim ? aim.angleDeg.toFixed(1) : ""}
      data-aim-power={aim ? String(aim.power) : ""}
      data-preview-impact={preview ? preview.impact.kind : ""}
      data-preview-x={preview ? Math.round(preview.impact.x) : ""}
      data-preview-y={preview ? Math.round(preview.impact.y) : ""}
      data-preview-steps={preview ? String(preview.path.length) : ""}
      data-last-seat={state.lastShot?.seat ?? ""}
      data-last-impact={state.lastShot?.impact.kind ?? ""}
      data-last-impact-x={state.lastShot ? Math.round(state.lastShot.impact.x) : ""}
      data-last-impact-y={state.lastShot ? Math.round(state.lastShot.impact.y) : ""}
      data-last-target={state.lastShot?.impact.target ?? ""}
      data-last-lives-lost={state.lastShot ? String(state.lastShot.livesLost) : ""}
      data-last-steps={state.lastShot ? String(state.lastShot.path.length) : ""}
      data-interactive={interactive ? "1" : "0"}
      data-dragging={dragging ? "1" : "0"}
      className={`relative w-full touch-none select-none overflow-hidden rounded-2xl border border-cyan-400/25 bg-[#04101f] shadow-[0_0_30px_rgba(34,211,238,0.12)] ${
        interactive ? "cursor-crosshair" : "cursor-default"
      } ${className}`}
      style={{ aspectRatio: `${BATTLEFIELD_WIDTH} / ${BATTLEFIELD_HEIGHT}` }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={(event) => finishDrag(event)}
      onPointerCancel={(event) => finishDrag(event, true)}
    >
      <canvas
        ref={canvasRef}
        className="block h-full w-full"
        role="img"
        aria-label={`Hillstrike battlefield. ${activeName} to fire. Drag away from your target to aim, then press Fire.`}
      />
      {interactive && (
        <span className="pointer-events-none absolute left-1/2 top-2 -translate-x-1/2 rounded-full border border-cyan-400/40 bg-black/55 px-3 py-1 text-[10px] font-bold uppercase tracking-[0.18em] text-cyan-200">
          Drag to aim
        </span>
      )}
    </div>
  );
}

// ── Layer painters ────────────────────────────────────────────────────────

function drawBlock(
  ctx: CanvasRenderingContext2D,
  block: TowerBlock & { y: number },
): void {
  const color = SEAT_COLOR[block.seat] ?? "#94a3b8";
  ctx.save();
  roundedRect(ctx, block.x + 1, block.y + 1, block.size - 2, block.size - 2, 5);
  ctx.fillStyle = SEAT_DARK[block.seat] ?? "#0d1b2a";
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.stroke();

  // A damaged block shows a crack; a fresh one shows a subtle gloss line.
  if (block.integrity <= 1) {
    ctx.beginPath();
    ctx.moveTo(block.x + block.size * 0.32, block.y + 4);
    ctx.lineTo(block.x + block.size * 0.5, block.y + block.size * 0.45);
    ctx.lineTo(block.x + block.size * 0.4, block.y + block.size * 0.62);
    ctx.lineTo(block.x + block.size * 0.62, block.y + block.size - 5);
    ctx.strokeStyle = "rgba(255,255,255,0.75)";
    ctx.lineWidth = 1.6;
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.moveTo(block.x + 5, block.y + 5);
    ctx.lineTo(block.x + block.size - 5, block.y + 5);
    ctx.strokeStyle = "rgba(255,255,255,0.22)";
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  ctx.restore();
}

function drawPlayer(
  ctx: CanvasRenderingContext2D,
  {
    x,
    y,
    seat,
    lives,
    active,
    label,
    aim,
    charge,
  }: {
    x: number;
    y: number;
    seat: Seat;
    lives: number;
    active: boolean;
    label: string;
    aim: ShotInput | null;
    charge: number;
  },
): void {
  const color = SEAT_COLOR[seat];
  const facing = seat === "player1" ? 1 : -1;
  ctx.save();

  // Barrel first, so the body sits on top of its root.
  if (aim) {
    const direction = directionVector(aim.angleDeg);
    const length = 30 + (charge / 100) * 12;
    ctx.beginPath();
    ctx.moveTo(x, y - 6);
    ctx.lineTo(x + direction.x * length, y - 6 + direction.y * length);
    ctx.strokeStyle = OUTLINE;
    ctx.lineWidth = 9;
    ctx.lineCap = "round";
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x, y - 6);
    ctx.lineTo(x + direction.x * length, y - 6 + direction.y * length);
    ctx.strokeStyle = color;
    ctx.lineWidth = 5;
    ctx.lineCap = "round";
    ctx.stroke();
  }

  // Stance shadow.
  ctx.beginPath();
  ctx.ellipse(x, y + 2, PLAYER_RADIUS + 5, 5, 0, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(0,0,0,0.45)";
  ctx.fill();

  // Body.
  ctx.beginPath();
  ctx.arc(x, y - 4, PLAYER_RADIUS, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = 3;
  ctx.stroke();

  // A small helmet arc, so the two players read as gunners, not discs.
  ctx.beginPath();
  ctx.arc(x, y - 6, PLAYER_RADIUS - 3, Math.PI * 1.15, Math.PI * 1.85);
  ctx.strokeStyle = "rgba(255,255,255,0.85)";
  ctx.lineWidth = 2.4;
  ctx.stroke();

  // An active marker ring.
  if (active) {
    ctx.beginPath();
    ctx.arc(x, y - 4, PLAYER_RADIUS + 6, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(245, 255, 59, 0.9)";
    ctx.lineWidth = 2.4;
    ctx.setLineDash([6, 5]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Lives: filled pips for remaining, hollow for lost.
  const pipStart = x - 14;
  for (let index = 0; index < 3; index++) {
    const px = pipStart + index * 14;
    const py = y - 42;
    ctx.beginPath();
    ctx.arc(px, py, 4.5, 0, Math.PI * 2);
    if (index < lives) {
      ctx.fillStyle = "#f5ff3b";
      ctx.fill();
      ctx.strokeStyle = OUTLINE;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    } else {
      ctx.strokeStyle = "rgba(255,255,255,0.35)";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }

  // Label, on the side away from the enemy so it never sits under a shot line.
  ctx.fillStyle = INK;
  ctx.font = `800 ${worldToCssFont(14)}`;
  ctx.textAlign = facing > 0 ? "left" : "right";
  ctx.fillText(label, x + facing * (PLAYER_RADIUS + 8), y + 4);
  ctx.restore();
}

function drawPreview(
  ctx: CanvasRenderingContext2D,
  preview: HillstrikePreview,
  aim: ShotInput,
  seat: Seat,
): void {
  const color = SEAT_COLOR[seat];
  ctx.save();
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.62;
  ctx.lineWidth = 2.2;
  ctx.setLineDash([7, 7]);
  ctx.beginPath();
  preview.path.forEach((point, index) => {
    if (index === 0) ctx.moveTo(point.x, point.y);
    else ctx.lineTo(point.x, point.y);
  });
  ctx.stroke();
  ctx.setLineDash([]);

  // Impact marker: a ring plus a cross, sized by nothing it does not know.
  ctx.globalAlpha = 0.9;
  ctx.beginPath();
  ctx.arc(preview.impact.x, preview.impact.y, 11, 0, Math.PI * 2);
  ctx.strokeStyle = preview.impact.kind === "player" ? "#f87171" : "#f5ff3b";
  ctx.lineWidth = 2.4;
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(preview.impact.x - 6, preview.impact.y - 6);
  ctx.lineTo(preview.impact.x + 6, preview.impact.y + 6);
  ctx.moveTo(preview.impact.x + 6, preview.impact.y - 6);
  ctx.lineTo(preview.impact.x - 6, preview.impact.y + 6);
  ctx.stroke();

  // Angle/power label near the launcher.
  ctx.globalAlpha = 0.8;
  ctx.fillStyle = color;
  ctx.font = `800 ${worldToCssFont(13)}`;
  ctx.textAlign = "center";
  ctx.fillText(
    `${Math.round(aim.angleDeg)}° · ${aim.power}%`,
    preview.path[0]?.x ?? 0,
    (preview.path[0]?.y ?? 0) - 26,
  );
  ctx.restore();
}
