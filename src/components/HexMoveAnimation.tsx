"use client";

// src/components/HexMoveAnimation.tsx
//
// The troop-movement overlay: dots leave the source, defenders converge, a
// clash flashes, and the surviving dots settle — all driven by a
// `TroopMoveEvent` the engine built from the PRE-action state and the
// authoritative result.
//
// It is presentation only: it renders no game state, dispatches nothing and
// never decides a survivor count. The authoritative tiles are already updated
// underneath; the board hides their dot layers for the two participating tiles
// while this plays, so the reveal at the end is the real formation.

import * as React from "react";
import {
  actorColor,
  buildTroopAnimationPlan,
  clamp01,
  dotFormationPoint,
  easeOut,
  travelPoint,
  type Point,
  type TroopMoveEvent,
} from "../lib/hexTroopAnimation";

interface HexMoveAnimationProps {
  event: TroopMoveEvent;
  /** Source tile centre, in the board frame's layout pixels. */
  from: Point;
  /** Destination tile centre. */
  to: Point;
  /** Half the tile width — scales dots, clash and sparks. */
  radius: number;
  /** Called once when the timeline finishes (or immediately when skipped). */
  onDone: () => void;
}

export default function HexMoveAnimation({
  event,
  from,
  to,
  radius,
  onDone,
}: HexMoveAnimationProps) {
  const plan = React.useMemo(() => buildTroopAnimationPlan(event), [event]);
  const [elapsed, setElapsed] = React.useState(0);
  const doneRef = React.useRef(false);

  React.useEffect(() => {
    if (plan.skipped || plan.durationMs <= 0) {
      onDone();
      return;
    }
    let raf = 0;
    const startedAt = performance.now();
    const tick = (now: number) => {
      const next = now - startedAt;
      setElapsed(next);
      if (next < plan.durationMs) {
        raf = requestAnimationFrame(tick);
      } else if (!doneRef.current) {
        doneRef.current = true;
        onDone();
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [plan.skipped, plan.durationMs, onDone]);

  const t = plan.durationMs > 0 ? clamp01(elapsed / plan.durationMs) : 1;
  const dotRadius = Math.max(2, radius * 0.075);
  const spacing = dotRadius * 2.3;
  const attackColor = actorColor(event.actor);
  const defenderColor = event.preOwner ? actorColor(event.preOwner) : "#94a3b8";
  const isAttack = event.kind === "attack";
  const travelEnd = isAttack ? 0.55 : 0.82;
  const clashAt = plan.clashAt;

  // ── Attacking dots ──────────────────────────────────────────────────
  const attackers = Array.from({ length: plan.attackerDots }, (_, i) => {
    const stagger = (i % 10) * 0.012 + Math.floor(i / 10) * 0.01;
    const progress = clamp01((t - stagger) / Math.max(0.01, travelEnd));
    const start = dotFormationPoint(i, plan.attackerDots, from.x, from.y, spacing);
    const end = dotFormationPoint(
      i,
      plan.attackerDots,
      to.x,
      to.y,
      spacing * 0.6,
    );
    const arc = ((i % 5) - 2) * spacing * 0.85;
    const pos = travelPoint(start, end, easeOut(progress), arc);

    const survives = i < plan.survivorDots;
    let opacity = 1;
    if (progress >= 1) {
      if (isAttack) {
        opacity = survives
          ? t < 0.96
            ? 1
            : clamp01((1 - t) / 0.04)
          : clamp01(1 - (t - travelEnd) / 0.12);
      } else {
        opacity = clamp01((0.94 - t) / 0.06);
      }
    }

    return (
      <circle
        key={`attacker-${i}`}
        cx={pos.x}
        cy={pos.y}
        r={dotRadius}
        fill={attackColor}
        opacity={opacity}
      />
    );
  });

  // ── Defending dots (attacks only) ───────────────────────────────────
  const defenderDots =
    isAttack && plan.defenderDots > 0
      ? Array.from({ length: plan.defenderDots }, (_, i) => {
          const start = dotFormationPoint(i, plan.defenderDots, to.x, to.y, spacing);
          const converge = clamp01(t / 0.34);
          const toward: Point = {
            x: start.x + (from.x - to.x) * 0.2 * converge,
            y: start.y + (from.y - to.y) * 0.2 * converge,
          };
          const pos = travelPoint(start, toward, converge);
          const postCount = Math.min(
            plan.defenderDots,
            Math.max(0, event.defenderAfter),
          );
          const holdsGround = event.postOwner === event.preOwner;
          const survives = holdsGround && i < postCount;
          let opacity = 1;
          if (t > clashAt) {
            opacity = survives
              ? t < 0.96
                ? 1
                : clamp01((1 - t) / 0.04)
              : clamp01(1 - (t - clashAt) / 0.16);
          }
          return (
            <circle
              key={`defender-${i}`}
              cx={pos.x}
              cy={pos.y}
              r={dotRadius}
              fill={defenderColor}
              opacity={opacity}
            />
          );
        })
      : null;

  // ── Floating loss/gain readout ─────────────────────────────────────
  // Reports the authoritative numbers only: survivors when the tile is taken,
  // the troops lost when the attack fails, and troops delivered on a
  // displacement. It fades in after the clash and drifts up, then the overlay
  // clears so the real formation is unobstructed.
  const readout = isAttack
    ? event.conquered
      ? { text: `+${event.survivors}`, color: attackColor }
      : event.outcome === "tie"
        ? { text: "0", color: "#e2e8f0" }
        : { text: `\u2212${event.sent}`, color: attackColor }
    : { text: `+${event.sent}`, color: attackColor };
  const readoutWindow = clamp01((t - (clashAt - 0.06)) / 0.34);
  const readoutOpacity = readoutWindow <= 0 ? 0 : Math.sin(Math.PI * readoutWindow);
  const readoutY = to.y - radius * (0.45 + 0.9 * readoutWindow);

  // ── Clash flash + a few sparks (never particle-heavy) ───────────────
  const envelope = isAttack
    ? Math.max(0, 1 - Math.abs(t - clashAt) / 0.12)
    : Math.max(0, 1 - Math.abs(t - clashAt) / 0.1);
  const flareRadius = radius * (0.35 + 0.75 * envelope);
  const sparks = Array.from({ length: isAttack ? 6 : 4 }, (_, i) => {
    const angle = (Math.PI * 2 * i) / (isAttack ? 6 : 4) + 0.4;
    const length = radius * 0.6 * envelope;
    return (
      <line
        key={`spark-${i}`}
        x1={to.x + Math.cos(angle) * flareRadius * 0.4}
        y1={to.y + Math.sin(angle) * flareRadius * 0.4}
        x2={to.x + Math.cos(angle) * (flareRadius * 0.4 + length)}
        y2={to.y + Math.sin(angle) * (flareRadius * 0.4 + length)}
        stroke={isAttack ? "#fde68a" : attackColor}
        strokeWidth={2}
        strokeLinecap="round"
        opacity={envelope}
      />
    );
  });

  return (
    <div
      data-hex-move-animation={event.kind}
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-20"
    >
      <svg className="pointer-events-none h-full w-full">
        {envelope > 0 && (
          <>
            <circle
              cx={to.x}
              cy={to.y}
              r={flareRadius}
              fill={isAttack ? "#fde68a" : attackColor}
              opacity={0.18 * envelope}
            />
            <circle
              cx={to.x}
              cy={to.y}
              r={flareRadius * 0.45}
              fill="#f8fafc"
              opacity={0.35 * envelope}
            />
            {sparks}
          </>
        )}
        {defenderDots}
        {attackers}
        {readoutOpacity > 0 && (
          <text
            data-hex-move-readout=""
            x={to.x}
            y={readoutY}
            textAnchor="middle"
            fill={readout.color}
            fontSize={Math.max(11, radius * 0.42)}
            fontWeight={900}
            opacity={readoutOpacity}
            style={{ paintOrder: "stroke", stroke: "#020617", strokeWidth: 3 }}
          >
            {readout.text}
          </text>
        )}
      </svg>
    </div>
  );
}
