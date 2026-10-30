"use client";

// src/components/last-run/RunnerArena.tsx
//
// THE ARENA — presentational only.
//
// Two lanes, one shared course, one shared skyline. Everything is SVG: ground
// lines, parallax pylons, the three obstacle silhouettes and the two runners.
// No image assets, no canvas engine, no game library.
//
// ── WHAT IT DOES NOT DO ───────────────────────────────────────────────────
//
// It does not simulate, score or decide anything. Distances, jump heights, duck
// states and alive/dead come from the server snapshot; this component only
// projects them. Between snapshots it advances each DISTANCE on the shared
// speed curve, so a 4 Hz authoritative feed reads as smooth motion — a purely
// visual extrapolation that the next snapshot overwrites exactly.
//
// ── EFFECTS ───────────────────────────────────────────────────────────────
//
// Dust on takeoff/landing, an impact burst on a crash and a red flash are
// triggered by CHANGES IN THE SERVER'S OWN STATE. They are decorative: with
// `prefers-reduced-motion` they are not rendered at all, and no effect can
// move a hitbox or change a tick.
//
// ── RESPONSIVE ────────────────────────────────────────────────────────────
//
// One viewBox with `preserveAspectRatio="meet"`; the wrapper caps height so a
// landscape phone keeps the whole course and the HUD on one screen. `pan-y`
// keeps vertical page scrolling available while stopping pinch/double-tap zoom
// inside the arena.

import { useEffect, useRef, useState } from "react";

import { speedAt } from "../../lib/last-run/engine";
import type { ObstacleKind } from "../../lib/last-run/constants";

export type ArenaSeat = {
  name: string;
  distance: number;
  y: number;
  ducking: boolean;
  alive: boolean;
  accent: "cyan" | "violet";
};

export type ArenaObstacle = {
  id: number;
  kind: ObstacleKind;
  x: number;
  width: number;
  height: number;
  minY: number;
};

type Props = {
  you: ArenaSeat;
  opponent: ArenaSeat;
  obstacles: ArenaObstacle[];
  /** Server-confirmed elapsed race time, ms. */
  elapsedMs: number;
  running: boolean;
  reducedMotion?: boolean;
};

const VIEW_W = 1000;
const VIEW_H = 340;
const RUNNER_SCREEN_X = 168;
const SCALE = 0.5;
const LANE_Y = { player1: 150, player2: 300 } as const;

const ACCENT = {
  cyan: { main: "#22d3ee", soft: "rgba(34,211,238,0.28)", glow: "rgba(34,211,238,0.75)" },
  violet: { main: "#a78bfa", soft: "rgba(167,139,250,0.26)", glow: "rgba(167,139,250,0.7)" },
} as const;

type Burst = {
  id: number;
  lane: "player1" | "player2";
  accent: "cyan" | "violet";
  kind: "dust" | "crash";
  x: number;
  y: number;
  at: number;
};

/**
 * Advance a distance between authoritative snapshots on the shared speed
 * curve. Resets on every new server value and freezes the moment a runner dies.
 */
function useSmoothDistance(serverDistance: number, alive: boolean, running: boolean, reduced: boolean): number {
  const [distance, setDistance] = useState(serverDistance);
  const anchor = useRef({ distance: serverDistance, at: Date.now() });

  useEffect(() => {
    anchor.current = { distance: serverDistance, at: Date.now() };
    setDistance(serverDistance);
  }, [serverDistance]);

  useEffect(() => {
    if (!running || !alive || reduced) return undefined;
    let raf = 0;
    let previous = performance.now();
    const step = (nowMs: number) => {
      const dt = Math.min(0.1, (nowMs - previous) / 1000);
      previous = nowMs;
      const elapsed = (Date.now() - anchor.current.at) / 1000;
      const next = anchor.current.distance + speedAt(Math.max(0, elapsed)) * dt;
      setDistance((current) => (next > current ? next : current));
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [alive, reduced, running]);

  return distance;
}

/** The three obstacle silhouettes, drawn to read at a glance and at speed. */
function ObstacleShape({
  kind,
  x,
  width,
  height,
  baseY,
  laneY,
}: {
  kind: ObstacleKind;
  x: number;
  width: number;
  height: number;
  baseY: number;
  laneY: number;
}) {
  const stroke = "rgba(255,255,255,0.5)";
  const fill = kind === "beam" ? "rgba(255,255,255,0.1)" : "rgba(255,255,255,0.16)";

  if (kind === "spike") {
    return (
      <g>
        <path d={`M ${x} ${baseY} L ${x + width / 2} ${baseY - height} L ${x + width} ${baseY} Z`} fill={fill} stroke={stroke} strokeWidth={1.1} strokeLinejoin="round" />
        <path d={`M ${x + width * 0.5} ${baseY} L ${x + width * 0.5} ${baseY - height * 0.62}`} stroke="rgba(248,113,113,0.5)" strokeWidth={0.9} />
      </g>
    );
  }

  if (kind === "beam") {
    return (
      <g>
        <rect x={x} y={baseY - height} width={width} height={height} fill={fill} stroke={stroke} strokeWidth={1.1} rx={1.5} />
        {/* Hazard stripes make "duck under" unmistakable. */}
        {[0.22, 0.5, 0.78].map((ratio) => (
          <line
            key={ratio}
            x1={x + width * ratio - 5}
            y1={baseY - 3}
            x2={x + width * ratio + 6}
            y2={baseY - height + 3}
            stroke="rgba(255,255,255,0.22)"
            strokeWidth={2}
          />
        ))}
        {/* The underside is the part that kills — mark it. */}
        <line x1={x} y1={baseY} x2={x + width} y2={baseY} stroke="rgba(167,139,250,0.55)" strokeWidth={1.4} strokeDasharray="3 3" />
        <line x1={x + width / 2} y1={laneY} x2={x + width / 2} y2={baseY} stroke="rgba(167,139,250,0.13)" strokeWidth={1} />
      </g>
    );
  }

  return (
    <g>
      <rect x={x} y={baseY - height} width={width} height={height} fill={fill} stroke={stroke} strokeWidth={1.1} rx={2} />
      <line x1={x + 3} y1={baseY - 3} x2={x + width - 3} y2={baseY - height + 3} stroke="rgba(255,255,255,0.16)" strokeWidth={1} />
      <line x1={x + width - 3} y1={baseY - 3} x2={x + 3} y2={baseY - height + 3} stroke="rgba(255,255,255,0.16)" strokeWidth={1} />
    </g>
  );
}

/**
 * The runner has three distinct, silhouette-first poses: upright running,
 * a tucked jump, and a stretched duck. Drawn in local coordinates with the
 * feet at (0, 0), scaled from the same body constants the engine uses.
 */
function RunnerFigure({
  alive,
  ducking,
  jumping,
  accent,
}: {
  alive: boolean;
  ducking: boolean;
  jumping: boolean;
  accent: "cyan" | "violet";
}) {
  const fill = alive ? (accent === "cyan" ? "#22d3ee" : "#a78bfa") : "rgba(148,163,184,0.5)";
  const visor = "rgba(7,8,11,0.85)";

  if (!alive) {
    return (
      <g>
        <path d="M 0 0 L 13 0 L 13 -14 L 4 -22 L 0 -18 Z" fill={fill} opacity={0.6} />
        <g stroke="#f87171" strokeWidth={1.8} strokeLinecap="round">
          <line x1={1} y1={-30} x2={12} y2={-19} />
          <line x1={12} y1={-30} x2={1} y2={-19} />
        </g>
      </g>
    );
  }

  if (ducking) {
    return (
      <g>
        {/* Low, long body: unmistakably shorter than standing. */}
        <rect x={0} y={-13} width={17} height={13} rx={5.5} fill={fill} />
        <rect x={13.2} y={-11.4} width={4.6} height={2.4} rx={1} fill={visor} />
        <line x1={-12} y1={-4} x2={-2} y2={-4} stroke={fill} strokeOpacity={0.55} strokeWidth={1.6} strokeLinecap="round" />
        <line x1={-16} y1={-8} x2={-6} y2={-8} stroke={fill} strokeOpacity={0.35} strokeWidth={1.4} strokeLinecap="round" />
      </g>
    );
  }

  if (jumping) {
    return (
      <g>
        {/* Tucked: knees up, slight forward lean, speed lines behind. */}
        <g transform="rotate(-9)">
          <rect x={0} y={-22} width={13} height={17} rx={5} fill={fill} />
          <rect x={8} y={-19.5} width={4.4} height={2.4} rx={1} fill={visor} />
          <path d="M 1 -5 L 7 -5 L 11 -1 L 5 -1 Z" fill={fill} opacity={0.9} />
        </g>
        <line x1={-12} y1={-16} x2={-3} y2={-16} stroke={fill} strokeOpacity={0.5} strokeWidth={1.6} strokeLinecap="round" />
        <line x1={-9} y1={-10} x2={-2} y2={-10} stroke={fill} strokeOpacity={0.3} strokeWidth={1.4} strokeLinecap="round" />
      </g>
    );
  }

  return (
    <g>
      <rect x={0} y={-22} width={13} height={22} rx={4.5} fill={fill} />
      <rect x={8} y={-19} width={4.4} height={2.6} rx={1} fill={visor} />
      <path d="M 2 0 L 5 0 L 5 -3 L 2 -3 Z" fill={fill} opacity={0.65} />
    </g>
  );
}

function Lane({
  seat,
  laneId,
  laneY,
  obstacles,
  reduced,
  running,
  bursts,
  accent,
}: {
  seat: ArenaSeat;
  laneId: "player1" | "player2";
  laneY: number;
  obstacles: ArenaObstacle[];
  reduced: boolean;
  running: boolean;
  bursts: Burst[];
  accent: "cyan" | "violet";
}) {
  const distance = useSmoothDistance(seat.distance, seat.alive, running, reduced);
  const palette = ACCENT[accent];
  const jumping = seat.y > 1;
  const bodyWidth = seat.ducking ? 17 : 13;
  const jump = seat.y * SCALE;

  return (
    <g>
      <rect x={0} y={laneY - 108} width={VIEW_W} height={120} fill={palette.soft} opacity={0.045} />
      <line x1={0} y1={laneY} x2={VIEW_W} y2={laneY} stroke="rgba(255,255,255,0.18)" strokeWidth={1.5} />
      <line x1={0} y1={laneY + 4} x2={VIEW_W} y2={laneY + 4} stroke={palette.main} strokeOpacity={0.3} strokeWidth={1} />

      {/* Ground ticks: the speed cue that survives reduced motion. */}
      {Array.from({ length: 22 }).map((_, index) => {
        const spacing = 46;
        const shift = (distance * SCALE) % spacing;
        const x = index * spacing - shift;
        return (
          <line
            key={`tick-${index}`}
            x1={x}
            y1={laneY + 7}
            x2={x + 14}
            y2={laneY + 7}
            stroke="rgba(255,255,255,0.09)"
            strokeWidth={1}
          />
        );
      })}

      {/* Speed streaks, only while the lane is alive and moving. */}
      {running && seat.alive && !reduced &&
        Array.from({ length: 6 }).map((_, index) => {
          const offset = ((distance * 0.6 + index * 173) % (VIEW_W + 200)) + 80;
          const x = VIEW_W - offset + 40;
          const y = laneY - 14 - (index % 3) * 16;
          return (
            <line key={`streak-${index}`} x1={x} y1={y} x2={x + 44 + (index % 2) * 22} y2={y} stroke={palette.main} strokeOpacity={0.16} strokeWidth={1.4} strokeLinecap="round" />
          );
        })}

      {obstacles.map((obstacle) => {
        const x = RUNNER_SCREEN_X + (obstacle.x - distance) * SCALE;
        if (x < -180 || x > VIEW_W + 100) return null;
        return (
          <ObstacleShape
            key={`${obstacle.id}-${laneId}`}
            kind={obstacle.kind}
            x={x}
            width={obstacle.width * SCALE}
            height={obstacle.height * SCALE}
            baseY={laneY - obstacle.minY * SCALE}
            laneY={laneY}
          />
        );
      })}

      {/* Cosmetic dust / impact. Never rendered with reduced motion. */}
      {!reduced &&
        bursts
          .filter((burst) => burst.lane === laneId)
          .map((burst) =>
            burst.kind === "crash" ? (
              <g key={burst.id}>
                <rect x={0} y={laneY - 118} width={VIEW_W} height={126} fill="#f87171">
                  <animate attributeName="opacity" values="0.24;0" dur="0.45s" fill="freeze" />
                </rect>
                {Array.from({ length: 7 }).map((_, index) => {
                  const angle = (Math.PI * (index + 1)) / 8;
                  const dx = Math.cos(angle) * 26;
                  const dy = Math.sin(angle) * 22;
                  return (
                    <circle key={index} cx={burst.x} cy={burst.y} r={2.4} fill={palette.main}>
                      <animate attributeName="cx" values={`${burst.x};${burst.x + dx}`} dur="0.5s" fill="freeze" />
                      <animate attributeName="cy" values={`${burst.y};${burst.y - dy}`} dur="0.5s" fill="freeze" />
                      <animate attributeName="opacity" values="0.95;0" dur="0.5s" fill="freeze" />
                    </circle>
                  );
                })}
              </g>
            ) : (
              <g key={burst.id}>
                {Array.from({ length: 5 }).map((_, index) => (
                  <circle key={index} cx={burst.x + (index - 2) * 4} cy={burst.y} r={1.8} fill="rgba(255,255,255,0.6)">
                    <animate attributeName="cy" values={`${burst.y};${burst.y - 10 - index}`} dur="0.4s" fill="freeze" />
                    <animate attributeName="opacity" values="0.55;0" dur="0.4s" fill="freeze" />
                  </circle>
                ))}
              </g>
            ),
          )}

      <ellipse
        cx={RUNNER_SCREEN_X + bodyWidth / 2}
        cy={laneY + 3}
        rx={Math.max(6, bodyWidth * 0.85)}
        ry={2.4}
        fill="rgba(0,0,0,0.55)"
        opacity={Math.max(0.14, 1 - jump / 60)}
      />
      <g
        transform={`translate(${RUNNER_SCREEN_X}, ${laneY - jump})`}
        style={{ filter: seat.alive ? `drop-shadow(0 0 7px ${palette.glow})` : "none" }}
      >
        <RunnerFigure alive={seat.alive} ducking={seat.ducking} jumping={jumping} accent={accent} />
      </g>
    </g>
  );
}

export function RunnerArena({ you, opponent, obstacles, elapsedMs, running, reducedMotion = false }: Props) {
  const leaderDistance = Math.max(you.distance, opponent.distance);
  const sceneryShift = (leaderDistance * 0.22) % 220;

  // One cosmetic effect stream, derived from the server's state transitions.
  const [bursts, setBursts] = useState<Burst[]>([]);
  const previous = useRef({
    you: { y: you.y, alive: you.alive, ducking: you.ducking },
    opponent: { y: opponent.y, alive: opponent.alive, ducking: opponent.ducking },
  });
  const burstId = useRef(0);

  useEffect(() => {
    if (reducedMotion) return;
    const lanes: Array<{ key: "you" | "opponent"; seat: ArenaSeat; lane: "player1" | "player2" }> = [
      { key: "you", seat: you, lane: "player1" },
      { key: "opponent", seat: opponent, lane: "player2" },
    ];
    const spawned: Burst[] = [];
    for (const { key, seat, lane } of lanes) {
      const before = previous.current[key];
      const tookOff = before.y <= 1 && seat.y > 1;
      const crashed = before.alive && !seat.alive;
      if (tookOff || crashed) {
        burstId.current += 1;
        spawned.push({
          id: burstId.current,
          lane,
          accent: seat.accent,
          kind: crashed ? "crash" : "dust",
          x: RUNNER_SCREEN_X + 7,
          y: crashed ? LANE_Y[lane] - seat.y * SCALE - 10 : LANE_Y[lane] - 2,
          at: Date.now(),
        });
      }
      previous.current[key] = { y: seat.y, alive: seat.alive, ducking: seat.ducking };
    }
    if (spawned.length === 0) return;
    setBursts((current) => [...current.slice(-5), ...spawned]);
    // Primitive dependencies: `you`/`opponent` are rebuilt on every render, so
    // depending on the objects would re-run this effect (and its state write
    // check) on every frame of the parent clock.
  }, [
    opponent.alive,
    opponent.ducking,
    opponent.y,
    reducedMotion,
    you.alive,
    you.ducking,
    you.y,
  ]);

  useEffect(() => {
    if (bursts.length === 0) return undefined;
    const timer = setTimeout(() => {
      const cutoff = Date.now() - 700;
      setBursts((current) => current.filter((burst) => burst.at > cutoff));
    }, 720);
    return () => clearTimeout(timer);
  }, [bursts]);

  return (
    <div
      className="relative overflow-hidden rounded-2xl border border-white/10 bg-[#07080b] contrast-more:border-white/40"
      style={{
        boxShadow: "inset 0 1px 0 rgba(255,255,255,0.05), 0 24px 60px -32px rgba(34,211,238,0.35)",
        touchAction: "pan-y",
      }}
    >
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-cyan-400/60 to-transparent" />
      <svg
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        preserveAspectRatio="xMidYMid meet"
        className="block h-auto max-h-[min(60vh,440px)] w-full landscape:max-h-[min(56vh,330px)]"
        role="img"
        aria-label={`Last Run arena. ${you.name}: ${you.alive ? "running" : "crashed"}. ${opponent.name}: ${
          opponent.alive ? "running" : "crashed"
        }.`}
      >
        <defs>
          <linearGradient id="last-run-sky" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#0b0d13" />
            <stop offset="100%" stopColor="#07080b" />
          </linearGradient>
        </defs>
        <rect width={VIEW_W} height={VIEW_H} fill="url(#last-run-sky)" />

        {Array.from({ length: 26 }).map((_, index) => {
          const x = (index * 173 + 41) % VIEW_W;
          const y = 18 + ((index * 61) % 210);
          return <circle key={`star-${index}`} cx={x} cy={y} r={index % 5 === 0 ? 1.4 : 0.8} fill="#ffffff" opacity={0.1 + (index % 4) * 0.05} />;
        })}
        {Array.from({ length: 7 }).map((_, index) => {
          const x = ((index * 220 - sceneryShift + VIEW_W * 2) % (VIEW_W + 220)) - 110;
          return (
            <g key={`pylon-${index}`} opacity={0.5}>
              <path d={`M ${x} 190 L ${x + 14} 118 L ${x + 26} 190 Z`} fill="rgba(255,255,255,0.035)" stroke="rgba(255,255,255,0.08)" />
              <circle cx={x + 14} cy={115} r={2} fill="#22d3ee" opacity={0.4} />
            </g>
          );
        })}

        <Lane seat={you} laneId="player1" laneY={LANE_Y.player1} obstacles={obstacles} reduced={reducedMotion} running={running} bursts={bursts} accent={you.accent} />
        <Lane seat={opponent} laneId="player2" laneY={LANE_Y.player2} obstacles={obstacles} reduced={reducedMotion} running={running} bursts={bursts} accent={opponent.accent} />

        <g fontFamily="ui-sans-serif, system-ui" fontSize={11} letterSpacing={2}>
          <text x={18} y={LANE_Y.player1 - 116} fill={ACCENT[you.accent].main} opacity={0.85}>
            YOU
          </text>
          <text x={18} y={LANE_Y.player2 - 116} fill={ACCENT[opponent.accent].main} opacity={0.75}>
            RIVAL
          </text>
          <text x={VIEW_W - 18} y={LANE_Y.player1 - 116} textAnchor="end" fill="rgba(255,255,255,0.45)">
            {Math.round(you.distance)} M
          </text>
          <text x={VIEW_W - 18} y={LANE_Y.player2 - 116} textAnchor="end" fill="rgba(255,255,255,0.35)">
            {Math.round(opponent.distance)} M
          </text>
        </g>

        <text
          x={VIEW_W / 2}
          y={22}
          textAnchor="middle"
          fill="rgba(255,255,255,0.55)"
          fontSize={12}
          letterSpacing={3}
          fontFamily="ui-monospace, SFMono-Regular, monospace"
        >
          {`T+${(elapsedMs / 1000).toFixed(1)}s`}
        </text>
      </svg>
    </div>
  );
}

/** A compact status pill shared by the HUD and the result panel. */
export function SeatBadge({ seat, name, alive, accent, distance }: { seat: string; name: string; alive: boolean; accent: "cyan" | "violet"; distance: number }) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2 rounded-xl border border-white/10 bg-white/[0.02] px-2.5 py-1.5 contrast-more:border-white/35 sm:gap-2.5 sm:px-3 sm:py-2">
      <span
        aria-hidden="true"
        className="h-2 w-2 shrink-0 rounded-full"
        style={{
          background: alive ? (accent === "cyan" ? "#22d3ee" : "#a78bfa") : "#64748b",
          boxShadow: alive ? `0 0 8px ${accent === "cyan" ? "rgba(34,211,238,0.9)" : "rgba(167,139,250,0.85)"}` : "none",
        }}
      />
      <div className="min-w-0">
        <p className="truncate text-[12px] font-bold text-white/90 sm:text-[13px]">{name}</p>
        <p className="truncate text-[9px] font-semibold uppercase tracking-[0.14em] text-white/35 sm:text-[10px] sm:tracking-[0.16em]">
          {seat} · {alive ? "alive" : "crashed"} · {Math.round(distance)}m
        </p>
      </div>
    </div>
  );
}

export default RunnerArena;
