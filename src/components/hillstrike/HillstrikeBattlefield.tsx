"use client";

// src/components/hillstrike/HillstrikeBattlefield.tsx
//
// The Hillstrike battlefield: one responsive canvas that fills its frame, draws
// the battlefield the ENGINE handed down, and turns a drag gesture into an aim.
//
// ── TRUST BOUNDARY ────────────────────────────────────────────────────────
// This component owns NO rule. It draws `state.battlefield` (terrain columns,
// tower blocks, both tanks), the engine's own preview path, and the
// authoritative trajectory returned with the accepted action. It never decides a
// collision, HP, a turn or a winner — a drag is reported upward as
// `{ angleDeg, power }` and the page applies it through `applyAction`.
//
// ── THE GESTURE ───────────────────────────────────────────────────────────
// Slingshot: press anywhere on the battlefield, drag away from where you want
// the shot to go, release. The pull vector is converted by the engine's own
// `aimFromDrag`, so the same conversion is used by the page, the preview and
// the shot. A release with a real pull LOCKS the aim (the preview stays, the
// Fire button enables); a tap clears it.
//
// ── THE ANIMATION ─────────────────────────────────────────────────────────
// An action is animated from what the engine resolved:
//   shoot  → flight: the projectile travels the recorded `path`; settle: the
//            post-impact battlefield is drawn, with collapse events tweened,
//            the crater already applied, an impact ring and, for a direct hit,
//            a red flash and the HP it took;
//   move   → the tank rolls from its old spot to its new one.
// The page updates the authoritative state when the flight ends, so HP and the
// turn change at the moment the projectile lands.
//
// ── THE TOWER ─────────────────────────────────────────────────────────────
// The middle tower is drawn as a dark steel wall with integrity pips, so a block
// that has taken a hit is visibly cracked and a lane that has been opened is
// visibly a hole. The board renders it from `state.battlefield.blocks` like any
// other block; it never decides what is breakable.

import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

import {
  BATTLEFIELD_HEIGHT,
  BATTLEFIELD_WIDTH,
  DEFAULT_MAX_PULL,
  MAX_HP,
  PLAYER_RADIUS,
  POWERUP_KINDS,
  POWERUP_RADIUS,
  TERRAIN_COLUMN_WIDTH,
  TERRAIN_COLUMNS,
  TOWER_BLOCK_INTEGRITY,
} from "../../lib/hillstrike/constants";
import { aimFromDrag, directionVector } from "../../lib/hillstrike/physics";
import { buffsOf, hpOf } from "../../lib/hillstrike/rules";
import type { Vec2 } from "../../lib/physics2d/kinematics";
import type {
  ActionRecord,
  Battlefield,
  HillstrikeState,
  Impact,
  PowerUp,
  PowerUpKind,
  Seat,
  ShotEvent,
  ShotInput,
  TowerBlock,
} from "../../lib/hillstrike/types";

export type HillstrikeAnimation = {
  readonly action: ActionRecord;
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
  propsRef.current = {
    state,
    viewerSeat,
    preview,
    aim,
    animation,
    interactive,
  };

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

    // ── Power-ups on the middle's ground ──────────────────────────────────
    // Pure presentation: the engine owns which pickup is where and whether it
    // has been collected (a collected one is simply no longer in the field).
    for (const pickup of field.pickups ?? []) {
      drawPickup(ctx, pickup);
    }

    // ── Cover blocks and base roofs ───────────────────────────────────────
    const collapseById = new Map<number, Extract<ShotEvent, { type: "collapse" }>>();
    if (currentAnimation && settling && currentAnimation.action.type === "shoot") {
      for (const event of currentAnimation.action.events) {
        if (event.type === "collapse") collapseById.set(event.blockId, event);
      }
    }
    const tween = easeOut(settleT);

    for (const block of field.blocks) {
      const collapse = collapseById.get(block.id);
      const y = collapse ? collapse.fromY + (collapse.y - collapse.fromY) * tween : block.y;
      drawBlock(ctx, { ...block, y });
    }

    // ── Tanks ─────────────────────────────────────────────────────────────
    for (const seat of ["player1", "player2"] as const) {
      const player = field.players[seat];
      const isActive = current.turn === seat && current.status === "playing";
      // A drive rolls the tank from its old spot to its new one over the settle
      // window, so the two seats see the same relocation the server resolved.
      let tankX = player.x;
      if (
        currentAnimation?.action.type === "move" &&
        currentAnimation.action.seat === seat &&
        settling
      ) {
        const { fromX, toX } = currentAnimation.action;
        tankX = fromX + (toX - fromX) * tween;
      }
      const displayAim =
        seat === viewer && currentAim
          ? currentAim
          : isActive
            ? { angleDeg: seat === "player1" ? 8 : 172, power: 0 }
            : null;
      drawPlayer(ctx, {
        x: tankX,
        y: player.y,
        seat,
        hp: hpOf(current, seat),
        maxHp: MAX_HP,
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
    if (flying && currentAnimation && currentAnimation.action.type === "shoot") {
      const t = Math.max(0, Math.min(1, elapsed / currentAnimation.flightMs));
      const path = currentAnimation.action.path;
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
    if (currentAnimation?.action.type === "shoot" && (settling || settleT >= 1)) {
      const impact = currentAnimation.action.impact;
      const ringT = settling ? easeOut(settleT) : 1;
      if (settling) {
        ctx.beginPath();
        ctx.arc(impact.x, impact.y, 10 + ringT * 70, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(245, 255, 59, ${(1 - ringT) * 0.85})`;
        ctx.lineWidth = 4;
        ctx.stroke();
      }
      if (currentAnimation.action.damage > 0 && impact.target) {
        const victim = current.battlefield.players[impact.target];
        const flash = settling ? 1 - settleT : 0;
        ctx.beginPath();
        ctx.ellipse(
          victim.x,
          victim.y - PLAYER_RADIUS,
          PLAYER_RADIUS + 18 + ringT * 22,
          PLAYER_RADIUS + 12 + ringT * 16,
          0,
          0,
          Math.PI * 2,
        );
        ctx.strokeStyle = `rgba(248, 113, 113, ${flash})`;
        ctx.lineWidth = 5;
        ctx.stroke();
        ctx.globalAlpha = flash;
        ctx.fillStyle = "#fecaca";
        ctx.font = `900 ${worldToCssFont(30)}`;
        ctx.textAlign = "center";
        ctx.fillText(`-${currentAnimation.action.damage}`, victim.x, victim.y - 52 - ringT * 26);
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
  // Test/probe surface: the last action flattened into data attributes so a
  // browser test can assert the server's outcome without decoding the state.
  const lastAction = state.lastAction;
  const lastShot = lastAction?.type === "shoot" ? lastAction : null;

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
      data-tower-blocks={
        state.battlefield.blocks.reduce(
          (count, block) => count + (block.kind === "tower" ? 1 : 0),
          0,
        )
      }
      data-cracked={
        // A block below its own kind's full integrity has taken a hit.
        state.battlefield.blocks.reduce(
          (cracked, block) =>
            cracked +
            (block.integrity < (block.kind === "tower" ? TOWER_BLOCK_INTEGRITY : 1) ? 1 : 0),
          0,
        )
      }
      data-terrain-signature={terrainSignature(state.battlefield.terrain)}
      data-hp-you={hpOf(state, viewerSeat)}
      data-hp-ai={hpOf(state, opponentSeat)}
      data-hp-player1={hpOf(state, "player1")}
      data-hp-player2={hpOf(state, "player2")}
      data-actions-remaining={state.actionsRemaining}
      data-winner={state.winner ?? ""}
      data-aim-angle={aim ? aim.angleDeg.toFixed(1) : ""}
      data-aim-power={aim ? String(aim.power) : ""}
      data-preview-impact={preview ? preview.impact.kind : ""}
      data-preview-x={preview ? Math.round(preview.impact.x) : ""}
      data-preview-y={preview ? Math.round(preview.impact.y) : ""}
      data-preview-steps={preview ? String(preview.path.length) : ""}
      data-last-action={lastAction?.type ?? ""}
      data-last-seat={lastAction?.seat ?? ""}
      data-last-impact={lastShot?.impact.kind ?? ""}
      data-last-impact-x={lastShot ? Math.round(lastShot.impact.x) : ""}
      data-last-impact-y={lastShot ? Math.round(lastShot.impact.y) : ""}
      data-last-target={lastShot?.impact.target ?? ""}
      data-last-damage={lastShot ? String(lastShot.damage) : ""}
      data-last-steps={lastShot ? String(lastShot.path.length) : ""}
      data-last-move-x={lastAction?.type === "move" ? Math.round(lastAction.toX) : ""}
      data-interactive={interactive ? "1" : "0"}
      data-dragging={dragging ? "1" : "0"}
      data-pickups={state.battlefield.pickups?.length ?? 0}
      data-buffs-you={
        (buffsOf(state, viewerSeat).doubleDamage ? "damage " : "") +
        (buffsOf(state, viewerSeat).doubleBlast ? "blast" : "")
      }
      data-roof-blocks={
        state.battlefield.blocks.reduce(
          (count, block) => count + (block.kind === "roof" ? 1 : 0),
          0,
        )
      }
      className={`relative h-full w-full touch-none select-none overflow-hidden bg-[#04101f] ${
        interactive ? "cursor-crosshair" : "cursor-default"
      } ${className}`}
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
  // A base roof is scenery, not cover: steel plating with hazard stripes, so a
  // player can tell at a glance that this ceiling is not going to break.
  if (block.kind === "roof") {
    ctx.save();
    roundedRect(ctx, block.x + 1, block.y + 1, block.size - 2, block.size - 2, 3);
    ctx.fillStyle = "#334155";
    ctx.fill();
    ctx.strokeStyle = "#cbd5e1";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(block.x + 3, block.y + block.size - 4);
    ctx.lineTo(block.x + block.size - 4, block.y + 3);
    ctx.strokeStyle = "rgba(250, 204, 21, 0.75)";
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.restore();
    return;
  }

  // The middle TOWER: a riveted steel wall, owned by nobody, so it is drawn in
  // the map's own slate palette rather than a seat colour. Integrity pips show
  // how many more hits the block takes; a hollow pip is a block already hit.
  if (block.kind === "tower") {
    ctx.save();
    roundedRect(ctx, block.x + 0.5, block.y + 0.5, block.size - 1, block.size - 1, 2);
    ctx.fillStyle = "#3b4a63";
    ctx.fill();
    ctx.strokeStyle = "#8fa6c6";
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Rivets, top-left and bottom-right, so the wall reads as built.
    ctx.fillStyle = "rgba(226, 240, 255, 0.55)";
    for (const [rx, ry] of [
      [block.x + 4, block.y + 4],
      [block.x + block.size - 4, block.y + block.size - 4],
    ] as const) {
      ctx.beginPath();
      ctx.arc(rx, ry, 1.4, 0, Math.PI * 2);
      ctx.fill();
    }

    const pips = Math.max(1, Math.min(TOWER_BLOCK_INTEGRITY, block.integrity));
    for (let pip = 0; pip < TOWER_BLOCK_INTEGRITY; pip++) {
      ctx.beginPath();
      ctx.arc(
        block.x + block.size / 2 + (pip - (TOWER_BLOCK_INTEGRITY - 1) / 2) * 6,
        block.y + block.size / 2,
        2,
        0,
        Math.PI * 2,
      );
      if (pip < pips) {
        ctx.fillStyle = "#7cefff";
        ctx.fill();
      } else {
        ctx.strokeStyle = "rgba(148, 163, 184, 0.7)";
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }

    // A hit block is visibly cracked, so a lane being opened reads at a glance.
    if (block.integrity < TOWER_BLOCK_INTEGRITY) {
      ctx.beginPath();
      ctx.moveTo(block.x + 3, block.y + block.size * 0.7);
      ctx.lineTo(block.x + block.size * 0.45, block.y + block.size * 0.4);
      ctx.lineTo(block.x + block.size * 0.55, block.y + block.size * 0.75);
      ctx.lineTo(block.x + block.size - 3, block.y + block.size * 0.3);
      ctx.strokeStyle = "rgba(255, 214, 102, 0.9)";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    ctx.restore();
    return;
  }

  const color = block.seat ? SEAT_COLOR[block.seat] : "#94a3b8";
  ctx.save();
  roundedRect(ctx, block.x + 1, block.y + 1, block.size - 2, block.size - 2, 5);
  ctx.fillStyle = block.seat ? SEAT_DARK[block.seat] : "#0d1b2a";
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

const PICKUP_COLOR: Record<PowerUpKind, string> = {
  heal: "#4ade80",
  "double-damage": "#f87171",
  "double-blast": "#fbbf24",
};

/** A middle power-up: a glowing ring with its effect's glyph inside. */
function drawPickup(ctx: CanvasRenderingContext2D, pickup: PowerUp): void {
  const color = PICKUP_COLOR[pickup.kind] ?? "#e2e8f0";
  const radius = POWERUP_RADIUS;
  ctx.save();

  const glow = ctx.createRadialGradient(pickup.x, pickup.y, 2, pickup.x, pickup.y, radius * 1.7);
  glow.addColorStop(0, color);
  glow.addColorStop(1, "rgba(0,0,0,0)");
  ctx.globalAlpha = 0.28;
  ctx.beginPath();
  ctx.arc(pickup.x, pickup.y, radius * 1.7, 0, Math.PI * 2);
  ctx.fillStyle = glow;
  ctx.fill();
  ctx.globalAlpha = 1;

  ctx.beginPath();
  ctx.arc(pickup.x, pickup.y, radius, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(3, 10, 20, 0.82)";
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.5;
  ctx.stroke();

  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.lineCap = "round";
  if (pickup.kind === POWERUP_KINDS.HEAL) {
    // A cross.
    ctx.beginPath();
    ctx.moveTo(pickup.x - 6, pickup.y);
    ctx.lineTo(pickup.x + 6, pickup.y);
    ctx.moveTo(pickup.x, pickup.y - 6);
    ctx.lineTo(pickup.x, pickup.y + 6);
    ctx.stroke();
  } else if (pickup.kind === POWERUP_KINDS.DOUBLE_DAMAGE) {
    // Two chevrons: "more of the same, doubled".
    for (const offset of [-4, 2]) {
      ctx.beginPath();
      ctx.moveTo(pickup.x - 6, pickup.y + offset + 4);
      ctx.lineTo(pickup.x, pickup.y + offset - 2);
      ctx.lineTo(pickup.x + 6, pickup.y + offset + 4);
      ctx.stroke();
    }
  } else {
    // A burst.
    for (let spoke = 0; spoke < 8; spoke++) {
      const angle = (spoke / 8) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(pickup.x + Math.cos(angle) * 3, pickup.y + Math.sin(angle) * 3);
      ctx.lineTo(pickup.x + Math.cos(angle) * 8, pickup.y + Math.sin(angle) * 8);
      ctx.stroke();
    }
  }
  ctx.restore();
}

/**
 * One TANK, in side view, standing on its own tracks at `(x, y)`.
 *
 * Geometry is fixed world units, so it scales with the board exactly like a
 * block does: rubber tracks with road wheels on the ground, a hull above them,
 * a turret on the hull with the barrel laid along the current aim (or pointed at
 * the enemy when the tank is idle), and an HP bar floating over the turret.
 * Nothing here reads a rule — `hp` is the server's number, the aim is the
 * viewer's pending input.
 */
function drawPlayer(
  ctx: CanvasRenderingContext2D,
  {
    x,
    y,
    seat,
    hp,
    maxHp,
    active,
    label,
    aim,
    charge,
  }: {
    x: number;
    y: number;
    seat: Seat;
    hp: number;
    maxHp: number;
    active: boolean;
    label: string;
    aim: ShotInput | null;
    charge: number;
  },
): void {
  const color = SEAT_COLOR[seat];
  const dark = SEAT_DARK[seat];
  const facing = seat === "player1" ? 1 : -1;
  const safeMax = Math.max(1, maxHp);
  const ratio = Math.max(0, Math.min(1, hp / safeMax));

  // ── Geometry, bottom-up (all in world units) ──────────────────────────
  const trackHeight = 9;
  const trackWidth = 36;
  const trackTop = y - trackHeight;
  const hullHeight = 8;
  const hullTop = trackTop - hullHeight;
  const hullWidth = 28;
  const turretWidth = 17;
  const turretHeight = 10;
  const turretTop = hullTop - turretHeight + 2;
  const turretCentreY = turretTop + turretHeight / 2;

  ctx.save();

  // Shadow on the ground, so the tank sits on the terrain instead of floating.
  ctx.beginPath();
  ctx.ellipse(x, y + 1.5, trackWidth / 2 + 3, 4, 0, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(0,0,0,0.45)";
  ctx.fill();

  // ── Barrel, drawn first so the turret caps its root ──────────────────
  if (aim) {
    const direction = directionVector(aim.angleDeg);
    const length = 21 + (charge / 100) * 9;
    const tipX = x + direction.x * length;
    const tipY = turretCentreY + direction.y * length;
    ctx.beginPath();
    ctx.moveTo(x, turretCentreY);
    ctx.lineTo(tipX, tipY);
    ctx.strokeStyle = OUTLINE;
    ctx.lineWidth = 7.5;
    ctx.lineCap = "round";
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x, turretCentreY);
    ctx.lineTo(tipX, tipY);
    ctx.strokeStyle = color;
    ctx.lineWidth = 4;
    ctx.stroke();
    // Muzzle brake.
    ctx.beginPath();
    ctx.arc(tipX, tipY, 3.1, 0, Math.PI * 2);
    ctx.fillStyle = OUTLINE;
    ctx.fill();
  }

  // ── Tracks ────────────────────────────────────────────────────────────
  roundedRect(ctx, x - trackWidth / 2, trackTop, trackWidth, trackHeight, 4);
  ctx.fillStyle = "#0a1220";
  ctx.fill();
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = 2;
  ctx.stroke();

  // Road wheels + tread notches: the details that read as "tank", not "disc".
  const wheelCount = 4;
  const wheelRadius = 2.4;
  for (let index = 0; index < wheelCount; index++) {
    const wheelX = x - trackWidth / 2 + 6 + index * ((trackWidth - 12) / (wheelCount - 1));
    ctx.beginPath();
    ctx.arc(wheelX, trackTop + trackHeight / 2, wheelRadius, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,255,255,0.45)";
    ctx.fill();
  }
  ctx.strokeStyle = "rgba(255,255,255,0.18)";
  ctx.lineWidth = 1.2;
  for (let notch = 0; notch < trackWidth; notch += 5) {
    const notchX = x - trackWidth / 2 + notch + 2;
    ctx.beginPath();
    ctx.moveTo(notchX, y - 2.5);
    ctx.lineTo(notchX, y);
    ctx.stroke();
  }

  // ── Hull ──────────────────────────────────────────────────────────────
  const hullGradient = ctx.createLinearGradient(0, hullTop, 0, hullTop + hullHeight);
  hullGradient.addColorStop(0, color);
  hullGradient.addColorStop(1, dark);
  roundedRect(ctx, x - hullWidth / 2, hullTop, hullWidth, hullHeight, 2.5);
  ctx.fillStyle = hullGradient;
  ctx.fill();
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = 2;
  ctx.stroke();

  // Sloped front plate, on the enemy-facing side.
  ctx.beginPath();
  ctx.moveTo(x + facing * (hullWidth / 2), hullTop);
  ctx.lineTo(x + facing * (hullWidth / 2 - 4), hullTop + hullHeight - 1);
  ctx.strokeStyle = "rgba(255,255,255,0.5)";
  ctx.lineWidth = 1.6;
  ctx.stroke();

  // ── Turret ────────────────────────────────────────────────────────────
  const turretX = x - turretWidth / 2 + facing * 1;
  roundedRect(ctx, turretX, turretTop, turretWidth, turretHeight, 4);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = 2;
  ctx.stroke();

  // Hatch, offset toward the rear of the turret.
  ctx.beginPath();
  ctx.arc(x - facing * 3.5, turretTop + 3.2, 2.3, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(255,255,255,0.55)";
  ctx.fill();

  // ── Active marker: a dashed ring around the tracks ────────────────────
  if (active) {
    ctx.beginPath();
    ctx.ellipse(x, y - 3, trackWidth / 2 + 7, 9, 0, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(245, 255, 59, 0.9)";
    ctx.lineWidth = 2.2;
    ctx.setLineDash([6, 5]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // ── HP bar, floating over the turret ──────────────────────────────────
  const barWidth = 38;
  const barHeight = 5;
  const barX = x - barWidth / 2;
  const barY = turretTop - 16;
  roundedRect(ctx, barX, barY, barWidth, barHeight, 2.5);
  ctx.fillStyle = "rgba(3, 10, 20, 0.85)";
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.3)";
  ctx.lineWidth = 1.2;
  ctx.stroke();
  if (ratio > 0) {
    const fill = ratio > 0.5 ? "#4ade80" : ratio > 0.25 ? "#facc15" : "#f87171";
    roundedRect(
      ctx,
      barX + 1,
      barY + 1,
      Math.max(1.5, (barWidth - 2) * ratio),
      barHeight - 2,
      1.5,
    );
    ctx.fillStyle = fill;
    ctx.fill();
  }

  // HP number, right above the bar, with a dark halo so it reads on any sky.
  ctx.font = `800 ${worldToCssFont(11)}`;
  ctx.textAlign = "center";
  ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(3, 10, 20, 0.9)";
  ctx.strokeText(`${Math.max(0, Math.round(hp))} HP`, x, barY - 4);
  ctx.fillStyle = INK;
  ctx.fillText(`${Math.max(0, Math.round(hp))} HP`, x, barY - 4);

  // Label, on the side away from the enemy so it never sits under a shot line.
  ctx.font = `800 ${worldToCssFont(13)}`;
  ctx.textAlign = facing > 0 ? "left" : "right";
  ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(3, 10, 20, 0.9)";
  ctx.strokeText(label, x + facing * (trackWidth / 2 + 6), y - 6);
  ctx.fillStyle = INK;
  ctx.fillText(label, x + facing * (trackWidth / 2 + 6), y - 6);
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
