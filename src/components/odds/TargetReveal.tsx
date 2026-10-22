"use client";

// src/components/odds/TargetReveal.tsx
//
// The reveal for a round the SERVER has already resolved.
//
// It takes a target, a call and the awarded points as props and draws them; it
// cannot invent any of the three. There is no client-side target, no
// client-side scoring, and no animation state feeding the verdict: `points`
// comes from the resolved round and hit/miss is read off it (revealOutcome), so
// the badge can never disagree with the ledger. The sweep is decoration that
// ends exactly on the segment the target occupies.

import { useEffect } from "react";
import { animate, motion, useMotionValue, useTransform } from "framer-motion";
import { TARGET_MAX, TARGET_MIN, type OddsPrediction } from "../../lib/odds";
import {
  REVEAL_SECONDS,
  motionSeconds,
  revealOutcome,
  sweepDegrees,
} from "./oddsMotion";
import {
  angleForIndex,
  edgeAngleForIndex,
  polar,
  selectionLabel,
  selectionOf,
} from "./oddsRing";
import { useReducedMotionSafe } from "./useReducedMotionSafe";

const VIEWBOX = 200;
const CENTER = VIEWBOX / 2;
/** The number band: a stroked arc whose centre line is where the marker rides. */
const BAND_INNER = 62;
const BAND_OUTER = 86;
const BAND_MID = (BAND_INNER + BAND_OUTER) / 2;
const BAND_WIDTH = BAND_OUTER - BAND_INNER;
const TICK_INNER = 88;
const TICK_OUTER = 92;
const LABEL_RADIUS = 94;
const DOMAIN = TARGET_MAX - TARGET_MIN + 1;

export type TargetRevealProps = {
  /** The server's target for a resolved round, or null while it is secret. */
  target: number | null;
  /** The viewer's call for that round. */
  prediction: OddsPrediction | null;
  /** The points the server awarded the viewer. 0 means a miss. */
  points: number | null | undefined;
  className?: string;
};

/** Clockwise arc on a circle, used for the call band. */
function arcPath(startAngle: number, endAngle: number, radius: number): string {
  const from = polar(startAngle, radius, CENTER);
  const to = polar(endAngle, radius, CENTER);
  const sweep = (((endAngle - startAngle) % 360) + 360) % 360;
  const large = sweep > 180 ? 1 : 0;
  return `M ${from.x} ${from.y} A ${radius} ${radius} 0 ${large} 1 ${to.x} ${to.y}`;
}

export default function TargetReveal({
  target,
  prediction,
  points,
  className = "",
}: TargetRevealProps) {
  const reduce = useReducedMotionSafe();
  const sweep = target === null ? 0 : sweepDegrees(target);
  const progress = useMotionValue(reduce ? 1 : 0);
  const angle = useTransform(progress, (value) => sweep * value);
  // Translate the marker instead of rotating the group: a CSS transform on an
  // SVG group needs a transform-origin, translation does not.
  const offsetX = useTransform(angle, (value) => polar(value, BAND_MID, CENTER).x - CENTER);
  const offsetY = useTransform(angle, (value) => polar(value, BAND_MID, CENTER).y - CENTER);

  useEffect(() => {
    if (target === null) return undefined;
    if (reduce) {
      progress.set(1);
      return undefined;
    }
    progress.set(0);
    const controls = animate(progress, 1, {
      duration: REVEAL_SECONDS,
      delay: 0.15,
      ease: "easeOut",
    });
    return () => controls.stop();
  }, [target, reduce, progress]);

  if (target === null) return null;

  const selection = selectionOf(prediction);
  const hit = revealOutcome(points) === "hit";
  const awarded = Number(points) > 0 ? Number(points) : 0;
  const bandStart = selection ? edgeAngleForIndex(selection.min - 1, DOMAIN) : 0;
  const bandEnd = selection ? edgeAngleForIndex(selection.max, DOMAIN) : 0;
  const fullCircle = selection !== null && selection.min === TARGET_MIN && selection.max === TARGET_MAX;
  const settleDelay = reduce ? 0 : REVEAL_SECONDS + 0.15;

  const described = `Target ${target}. Your call ${selectionLabel(prediction)} ${
    hit ? `hit for ${awarded} points` : "missed"
  }.`;

  return (
    <div className={`text-center ${className}`}>
      <svg
        viewBox={`0 0 ${VIEWBOX} ${VIEWBOX}`}
        role="img"
        aria-label={described}
        className="mx-auto block h-auto w-full max-w-[190px]"
      >
        {/* Ring frame */}
        <circle
          cx={CENTER}
          cy={CENTER}
          r={BAND_MID}
          fill="none"
          stroke="rgba(0,229,255,0.10)"
          strokeWidth={BAND_WIDTH}
        />
        <circle
          cx={CENTER}
          cy={CENTER}
          r={BAND_INNER - 5}
          fill="none"
          stroke="rgba(0,229,255,0.14)"
          strokeWidth="0.7"
          strokeDasharray="2 4"
        />

        {/* Decade ticks, so the circle reads as 1..100 without 100 labels. */}
        {Array.from({ length: 10 }, (_, index) => {
          // Ten ticks, one per decade boundary: 0°, 36°, … 324°.
          const tick = (index * 360) / 10;
          const from = polar(tick, TICK_INNER, CENTER);
          const to = polar(tick, TICK_OUTER, CENTER);
          return (
            <line
              key={`tick-${index}`}
              x1={from.x}
              y1={from.y}
              x2={to.x}
              y2={to.y}
              stroke="rgba(255,255,255,0.16)"
              strokeWidth="0.8"
            />
          );
        })}
        {[TARGET_MIN, 25, 50, 75, TARGET_MAX].map((value) => {
          const anchor = polar(angleForIndex(value - 1, DOMAIN), LABEL_RADIUS, CENTER);
          return (
            <text
              key={`anchor-${value}`}
              x={anchor.x}
              y={anchor.y}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={6.5}
              className="odds-readout"
              fill="rgba(255,255,255,0.32)"
            >
              {value}
            </text>
          );
        })}

        {/* The player's call, drawn from the values actually submitted. On a
            miss it fades back so the marker is the only bright thing left. */}
        {selection &&
          (fullCircle ? (
            <circle
              cx={CENTER}
              cy={CENTER}
              r={BAND_MID}
              data-odds-reveal="band"
              fill="none"
              stroke="#f5ff3b"
              strokeOpacity={hit ? 0.55 : 0.18}
              strokeWidth={BAND_WIDTH}
              className="transition-[stroke-opacity] duration-300"
            />
          ) : (
            <path
              d={arcPath(bandStart, bandEnd, BAND_MID)}
              data-odds-reveal="band"
              fill="none"
              stroke="#f5ff3b"
              strokeOpacity={hit ? 0.6 : 0.18}
              strokeWidth={BAND_WIDTH}
              strokeLinecap="butt"
              className="transition-[stroke-opacity] duration-300"
            />
          ))}

        {/* Marker: travels from 12 o'clock to the target's own segment. */}
        <motion.g style={{ x: offsetX, y: offsetY }}>
          {!reduce && (
            <motion.circle
              cx={CENTER}
              cy={CENTER}
              r={7}
              data-odds-reveal="pulse"
              fill="none"
              stroke={hit ? "#f5ff3b" : "#ff8a9b"}
              initial={{ opacity: 0, r: 7 }}
              animate={{ opacity: [0, 0.55, 0], r: 15 }}
              transition={{ delay: settleDelay, duration: 0.55, ease: "easeOut" }}
            />
          )}
          <circle
            cx={CENTER}
            cy={CENTER}
            r={6}
            data-odds-reveal="marker"
            fill={hit ? "#f5ff3b" : "#ffffff"}
            stroke="#04142c"
            strokeWidth="2"
            className="drop-shadow-[0_0_6px_rgba(245,255,59,0.6)]"
          />
          <line
            x1={CENTER}
            y1={CENTER}
            x2={CENTER}
            y2={CENTER - BAND_OUTER + 2}
            stroke={hit ? "#f5ff3b" : "rgba(255,255,255,0.7)"}
            strokeWidth="1"
            strokeOpacity="0.5"
          />
        </motion.g>

        {/* Revealed target, in the middle of the ring. */}
        <text
          x={CENTER}
          y={CENTER - 8}
          textAnchor="middle"
          fontSize={7}
          className="odds-label"
          fill="rgba(255,255,255,0.4)"
        >
          target
        </text>
        <motion.text
          x={CENTER}
          y={CENTER + 12}
          textAnchor="middle"
          fontSize={22}
          className="odds-readout"
          fill={hit ? "#f5ff3b" : "#ffffff"}
          initial={reduce ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: motionSeconds(reduce, 0.25), delay: motionSeconds(reduce, 0.35) }}
        >
          {target}
        </motion.text>
      </svg>

      <p className="odds-readout mt-1 text-sm">
        <span className="opacity-50">your call </span>
        <span className="text-white/85">{selectionLabel(prediction)}</span>
      </p>
      <p
        className={`odds-label mt-0.5 ${hit ? "text-[#f5ff3b]" : "text-rose-300/80"}`}
        aria-live="polite"
      >
        {hit ? `hit · +${awarded}` : "miss · target outside your call"}
      </p>
    </div>
  );
}
