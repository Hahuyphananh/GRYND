"use client";

// src/components/lane-rush/OvalTrack.jsx
//
// The Lane Rush board: a top-down oval circuit drawn entirely in SVG.
//
// THREE CONCENTRIC ROUTE LANES make the route rule visible: Safe Circuit is
// the outer lane, Sprint the middle, Risk the inner — all the same closed
// lap, so a route is a risk/reward choice on one circuit rather than three
// pretend straights. The thin dashed outer ring is the RIVAL GRID: deployed
// opponent cars wait there while their route is still private (the server
// hides it until the round resolves).
//
// Cars are coloured dots — blue = Player 1, red = Player 2 — sized by tier and
// ringed so tiers stay distinguishable. Every position is one normalized lap
// progress value (see ./ovalGeometry.js), and the only animation that leaves the
// grid is `buildRacePlayback(lastResult)`: it re-plays the round the SERVER
// already resolved. Nothing here scores, rolls or decides anything, and a
// reduction in motion simply pins every dot to its confirmed endpoint.

import { useEffect, useMemo, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { ROUTES, TIER_NAMES } from "../../lib/lane-rush/rules";
import {
  LANE_BAND_WIDTH,
  LANE_ORDER,
  RIVAL_RADII,
  ROUTE_COLORS,
  SEAT_COLORS,
  TRACK_CENTER,
  TRACK_VIEWBOX,
  buildRacePlayback,
  directionChevrons,
  dotRadius,
  finishLineSegments,
  gridCars,
  laneLabelAnchors,
  laneRadii,
  pointOnLane,
  pointOnRivalRing,
  tierRingInset,
} from "./ovalGeometry";

const ROUTE_SHORT = {
  safe: "SAFE",
  sprint: "SPRINT",
  risk: "RISK",
};

function easeInOutCubic(p) {
  return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
}

/**
 * Animate one normalized lap progress. `enabled === false` (reduced motion)
 * pins straight to the endpoint, which is always the CONFIRMED position.
 */
function useLapProgress({ from, to, duration, delay = 0, enabled }) {
  const [t, setT] = useState(enabled ? from : to);
  useEffect(() => {
    if (!enabled || !Number.isFinite(duration) || duration <= 0) {
      setT(to);
      return undefined;
    }
    let raf = 0;
    let timer = 0;
    let startedAt = 0;
    const step = (stamp) => {
      if (!startedAt) startedAt = stamp;
      const elapsed = (stamp - startedAt) / 1000 - delay;
      if (elapsed <= 0) {
        raf = requestAnimationFrame(step);
        return;
      }
      const p = Math.min(1, elapsed / duration);
      setT(from + (to - from) * easeInOutCubic(p));
      if (p < 1) raf = requestAnimationFrame(step);
    };
    setT(from);
    timer = window.setTimeout(() => {
      raf = requestAnimationFrame(step);
    }, 40);
    return () => {
      clearTimeout(timer);
      cancelAnimationFrame(raf);
    };
  }, [from, to, duration, delay, enabled]);
  return t;
}

function carAriaLabel(car, { routeHidden = false } = {}) {
  const seatName = car.seat === "player2" ? "Player 2" : "Player 1";
  const tierName = TIER_NAMES[car.tier] || "car";
  const routeName = routeHidden
    ? "route hidden until the race"
    : `${ROUTES[car.route]?.name || "Safe Circuit"}`;
  return `${seatName} ${tierName}, ${routeName}`;
}

/** The dot itself: seat colour, tier size, tier rings, optional glow. */
function CarDot({
  x,
  y,
  tier,
  seat,
  selected = false,
  dim = false,
  children,
}) {
  const radius = dotRadius(tier);
  const colors = SEAT_COLORS[seat] || SEAT_COLORS.player1;
  const inset = tierRingInset(tier);
  return (
    <g transform={`translate(${x} ${y})`} opacity={dim ? 0.55 : 1}>
      {selected && (
        <circle
          r={radius + 7}
          fill="none"
          stroke={colors.dot}
          strokeWidth={1.4}
          strokeDasharray="3 4"
          opacity={0.85}
        />
      )}
      <circle r={radius + 2.5} fill={colors.glow} opacity={selected ? 0.5 : 0.28} />
      <circle
        r={radius}
        fill={colors.dot}
        stroke={colors.edge}
        strokeWidth={1.3}
        strokeOpacity={0.9}
      />
      {inset > 0 && (
        <circle
          r={Math.max(1.2, radius - inset)}
          fill="none"
          stroke={colors.edge}
          strokeWidth={1.1}
          strokeOpacity={0.65}
        />
      )}
      {radius >= 11 && (
        <text
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={7.5}
          fontWeight={900}
          fill="#0b1220"
        >
          {tier}
        </text>
      )}
      {children}
    </g>
  );
}

/** A car parked on the start grid (planning phase). */
function GridDot({ car, selected, reduced }) {
  const progress = useLapProgress({
    from: car.t - 0.028,
    to: car.t,
    duration: 0.5,
    enabled: !reduced,
  });
  const point = car.route
    ? pointOnLane({
        route: car.route,
        seat: car.seat,
        t: progress,
        radialOffset: car.radialOffset,
      })
    : pointOnRivalRing({ seat: car.seat, t: progress });

  return (
    <motion.g
      initial={reduced ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.25 }}
    >
      <CarDot
        x={point.x}
        y={point.y}
        tier={car.tier}
        seat={car.seat}
        selected={selected}
        dim={!car.mine}
      >
        <title>{carAriaLabel(car, { routeHidden: !car.route })}</title>
      </CarDot>
    </motion.g>
  );
}

/** One car replaying the round the server resolved. */
function PlaybackDot({ car, reduced, showResults }) {
  const progress = useLapProgress({
    from: car.from,
    to: car.to,
    duration: car.duration,
    delay: car.delay,
    enabled: !reduced,
  });
  const point = pointOnLane({
    route: car.route,
    seat: car.seat,
    t: progress,
    radialOffset: car.radialOffset,
  });
  const finish = pointOnLane({ route: car.route, seat: car.seat, t: 1 });
  const landed = car.outcome === "dnf" && progress >= car.to - 0.002;
  const crossed = car.outcome === "finished" && progress >= 0.995;
  const colors = SEAT_COLORS[car.seat] || SEAT_COLORS.player1;

  return (
    <g>
      {/* Restrained finish flash at the line, only for a confirmed finish. */}
      {car.outcome === "finished" && !reduced && (
        <motion.circle
          cx={finish.x}
          cy={finish.y}
          initial={{ opacity: 0, r: 4 }}
          animate={{ opacity: [0, 0.5, 0], r: [4, 22, 26] }}
          transition={{
            delay: car.delay + car.duration,
            duration: 0.7,
            ease: "easeOut",
          }}
          fill="none"
          stroke={colors.edge}
          strokeWidth={2}
        />
      )}

      <CarDot
        x={point.x}
        y={point.y}
        tier={car.tier}
        seat={car.seat}
        selected={crossed}
      >
        <title>
          {`${carAriaLabel(car)} — ${car.outcome === "dnf" ? "DNF" : `+${car.points} points`}`}
        </title>
      </CarDot>

      {/* A DNF stalls with a single red pulse and a clear label. */}
      {car.outcome === "dnf" && (
        <motion.g
          initial={reduced ? false : { opacity: 0 }}
          animate={{ opacity: landed ? 1 : 0.55 }}
          transition={{ duration: 0.2 }}
        >
          <motion.circle
            cx={point.x}
            cy={point.y}
            r={dotRadius(car.tier) + 5}
            fill="none"
            stroke="#fb7185"
            strokeWidth={1.6}
            strokeDasharray="2 3"
            animate={
              landed && !reduced ? { opacity: [0.9, 0.2, 0.9] } : { opacity: 0.8 }
            }
            transition={{ duration: 0.9, repeat: landed && !reduced ? 1 : 0 }}
          />
          <text
            x={point.x + dotRadius(car.tier) + 8}
            y={point.y + 3}
            fontSize={9}
            fontWeight={900}
            fill="#fda4af"
          >
            DNF
          </text>
        </motion.g>
      )}

      {showResults && car.outcome === "finished" && car.points > 0 && (
        <motion.text
          x={point.x + dotRadius(car.tier) + 8}
          y={point.y + 3}
          fontSize={9}
          fontWeight={900}
          fill="#bbf7d0"
          initial={reduced ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: car.delay + car.duration * 0.55, duration: 0.25 }}
        >
          +{car.points}
        </motion.text>
      )}
    </g>
  );
}

function Checker({ segment }) {
  const cell = segment.width / segment.columns;
  const squares = [];
  const rows = 2;
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < segment.columns; col += 1) {
      const light = (row + col) % 2 === 0;
      squares.push(
        <rect
          key={`${row}-${col}`}
          x={segment.x - segment.width / 2 + col * cell}
          y={segment.y - segment.height / 2 + row * (segment.height / rows)}
          width={cell}
          height={segment.height / rows}
          fill={light ? "#e2e8f0" : "#0f172a"}
          opacity={light ? 0.92 : 0.85}
        />,
      );
    }
  }
  return <g>{squares}</g>;
}

export default function OvalTrack({
  myCars = [],
  oppCars = [],
  mySeat = "player1",
  lastResult = null,
  round = null,
  phase = null,
  selectedCarId = null,
  targetScore = 1000,
  myPoints = 0,
  oppPoints = 0,
}) {
  const reduced = Boolean(useReducedMotion());
  // The caller hands a stable object per resolved round; memoizing keeps the
  // "hide the replay after it finishes" timer from being reset by an unrelated
  // re-render (the planning clock ticks four times a second).
  const playback = useMemo(
    () => (lastResult ? buildRacePlayback(lastResult) : null),
    [lastResult],
  );
  // Results stay on the board for a short beat AFTER the animation; the
  // caller keys `lastResult` to the server round, so a poll never replays it.
  const [showResults, setShowResults] = useState(Boolean(playback));
  useEffect(() => {
    if (!playback) {
      setShowResults(false);
      return undefined;
    }
    setShowResults(true);
    const longest = playback.cars.reduce(
      (max, car) => Math.max(max, car.delay + car.duration),
      0,
    );
    const timer = setTimeout(
      () => setShowResults(false),
      reduced ? 900 : (longest + 1.1) * 1000,
    );
    return () => clearTimeout(timer);
  }, [playback, reduced]);

  const racingPlayback = playback && showResults ? playback.cars : [];
  // Cars on the start grid: only while the round is being planned. During a
  // resolved replay the same cars are already back in the garage server-side.
  const grid = phase === "planning" ? gridCars({ myCars, oppCars, mySeat }) : [];
  const chevrons = directionChevrons();
  const labels = laneLabelAnchors();
  const finishSegments = finishLineSegments();
  const infieldRx = laneRadii("risk").rx - LANE_BAND_WIDTH / 2 - 10;
  const infieldRy = laneRadii("risk").ry - LANE_BAND_WIDTH / 2 - 10;

  const aria = [
    "Oval racetrack: three concentric route lanes, Safe outside, Sprint in the middle, Risk inside.",
    "Blue dots are Player 1, red dots Player 2. Travel is clockwise from the start/finish line on the left.",
  ].join(" ");

  return (
    <div className="relative w-full">
      <svg
        viewBox={`0 0 ${TRACK_VIEWBOX.width} ${TRACK_VIEWBOX.height}`}
        className="block h-auto w-full select-none"
        role="img"
        aria-label={aria}
      >
        <defs>
          <radialGradient id="laneRushTarmac" cx="50%" cy="42%" r="72%">
            <stop offset="0%" stopColor="#0d1730" />
            <stop offset="62%" stopColor="#070c1c" />
            <stop offset="100%" stopColor="#03060f" />
          </radialGradient>
          <radialGradient id="laneRushInfield" cx="50%" cy="45%" r="70%">
            <stop offset="0%" stopColor="#12203c" />
            <stop offset="100%" stopColor="#080f20" />
          </radialGradient>
        </defs>

        <rect
          x={0}
          y={0}
          width={TRACK_VIEWBOX.width}
          height={TRACK_VIEWBOX.height}
          rx={26}
          fill="url(#laneRushTarmac)"
        />

        {/* Track markings: a faint outer wall + an inner edge. */}
        <ellipse
          cx={TRACK_CENTER.x}
          cy={TRACK_CENTER.y}
          rx={RIVAL_RADII.rx + 20}
          ry={RIVAL_RADII.ry + 20}
          fill="none"
          stroke="rgba(148,163,184,0.16)"
          strokeWidth={1}
        />
        <ellipse
          cx={TRACK_CENTER.x}
          cy={TRACK_CENTER.y}
          rx={RIVAL_RADII.rx + 8}
          ry={RIVAL_RADII.ry + 8}
          fill="none"
          stroke="rgba(148,163,184,0.22)"
          strokeWidth={2}
          strokeDasharray="2 12"
        />

        {/* The three route bands. */}
        {LANE_ORDER.map((route) => {
          const { rx, ry } = laneRadii(route, "player1");
          const colors = ROUTE_COLORS[route];
          return (
            <g key={`lane-${route}`}>
              <ellipse
                cx={TRACK_CENTER.x}
                cy={TRACK_CENTER.y}
                rx={rx}
                ry={ry}
                fill="none"
                stroke={colors.soft}
                strokeWidth={LANE_BAND_WIDTH}
              />
              <ellipse
                cx={TRACK_CENTER.x}
                cy={TRACK_CENTER.y}
                rx={rx}
                ry={ry}
                fill="none"
                stroke={colors.stroke}
                strokeWidth={1.2}
                strokeOpacity={0.55}
                strokeDasharray="4 12"
              />
            </g>
          );
        })}

        {/* Rival grid ring — purpose-labelled, and never a route lane. */}
        <ellipse
          cx={TRACK_CENTER.x}
          cy={TRACK_CENTER.y}
          rx={RIVAL_RADII.rx}
          ry={RIVAL_RADII.ry}
          fill="none"
          stroke="rgba(251,113,133,0.34)"
          strokeWidth={1.2}
          strokeDasharray="6 8"
        />

        {/* Infield. */}
        <ellipse
          cx={TRACK_CENTER.x}
          cy={TRACK_CENTER.y}
          rx={Math.max(60, infieldRx)}
          ry={Math.max(40, infieldRy)}
          fill="url(#laneRushInfield)"
          stroke="rgba(56,189,248,0.18)"
          strokeWidth={1}
        />
        <text
          x={TRACK_CENTER.x}
          y={TRACK_CENTER.y - 26}
          textAnchor="middle"
          fontSize={10}
          fontWeight={900}
          letterSpacing={3}
          fill="rgba(148,163,184,0.7)"
        >
          ROUND {round || 1}
        </text>
        <text
          x={TRACK_CENTER.x}
          y={TRACK_CENTER.y + 2}
          textAnchor="middle"
          fontSize={22}
          fontWeight={900}
          letterSpacing={1}
          fill="#e2f3ff"
        >
          {Math.min(myPoints, targetScore)} – {Math.min(oppPoints, targetScore)}
        </text>
        <text
          x={TRACK_CENTER.x}
          y={TRACK_CENTER.y + 24}
          textAnchor="middle"
          fontSize={9.5}
          fontWeight={800}
          letterSpacing={2}
          fill="rgba(165,243,252,0.72)"
        >
          FIRST TO {Number(targetScore).toLocaleString()}
        </text>
        {phase === "finished" && (
          <text
            x={TRACK_CENTER.x}
            y={TRACK_CENTER.y + 44}
            textAnchor="middle"
            fontSize={9}
            fontWeight={900}
            letterSpacing={2}
            fill="#fde68a"
          >
            RACE OVER
          </text>
        )}

        {/* Direction of travel. */}
        {chevrons.map((chevron) => (
          <g
            key={chevron.key}
            transform={`translate(${chevron.x} ${chevron.y}) rotate(${chevron.angle})`}
            opacity={0.5}
          >
            <path
              d="M -4 -3.4 L 3 0 L -4 3.4"
              fill="none"
              stroke={ROUTE_COLORS[chevron.route].stroke}
              strokeWidth={1.6}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </g>
        ))}

        {/* Start / finish. */}
        {finishSegments.map((segment) => (
          <Checker key={`finish-${segment.route}`} segment={segment} />
        ))}

        {/* Lane captions (the legends live under the board in HTML). */}
        {labels.map((label) => (
          <text
            key={`label-${label.route}`}
            x={label.x}
            y={label.y}
            textAnchor="middle"
            fontSize={9}
            fontWeight={900}
            letterSpacing={2}
            fill={ROUTE_COLORS[label.route].text}
            opacity={0.85}
          >
            {ROUTE_SHORT[label.route]}
          </text>
        ))}
        <text
          x={TRACK_CENTER.x}
          y={TRACK_CENTER.y + RIVAL_RADII.ry + 2}
          textAnchor="middle"
          fontSize={8.5}
          fontWeight={800}
          letterSpacing={2}
          fill="rgba(251,113,133,0.6)"
        >
          RIVAL GRID · ROUTE HIDDEN
        </text>

        {/* Cars waiting on the grid for the round to resolve. */}
        {grid.map((car) => (
          <GridDot
            key={car.key}
            car={car}
            reduced={reduced}
            selected={Boolean(selectedCarId && car.carId === selectedCarId)}
          />
        ))}

        {/* Confirmed round playback — the only moving cars on this board. */}
        {racingPlayback.map((car) => (
          <PlaybackDot
            key={car.key}
            car={car}
            reduced={reduced}
            showResults={showResults}
          />
        ))}
      </svg>
    </div>
  );
}
