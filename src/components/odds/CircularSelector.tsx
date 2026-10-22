"use client";

// src/components/odds/CircularSelector.tsx
//
// The Odds number wheel: every integer from 1 to 100, clockwise from 12
// o'clock, drawn as an SVG annulus so hit testing is exact and the rendering
// stays crisp at any size.
//
// Three levels of detail (see ZOOM_SPANS):
//   0  ten decade groups — no 100-label soup
//   1  40 individual numbers, each with its own label
//   2  20 numbers, wide arcs for precise boundaries
//
// Interactions: tap a segment, drag around the ring, or drag the min/max
// handles; the wheel, mouse wheel and pinch all change the zoom, and the
// keyboard can move and commit the same selection. A drag from 95 to 5 yields
// 5–95 — the ring never treats a selection as a wrap-around.

import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { OddsPrediction } from "../../lib/odds";
import { isRuledOut, motionSeconds, ZOOM_SECONDS, type ClueWindow } from "./oddsMotion";
import { useReducedMotionSafe } from "./useReducedMotionSafe";
import {
  HANDLE_HIT_RADIUS,
  ODDS_DECADES,
  RING_CENTER,
  RING_HANDLE,
  RING_INNER,
  RING_LABEL,
  RING_OUTER,
  RING_VIEWBOX,
  angleForIndex,
  angleForValue,
  annularSectorPath,
  clampDomain,
  clampZoom,
  exactPrediction,
  polar,
  pointerToValue,
  rangePrediction,
  potentialScore,
  selectionLabel,
  selectionOf,
  selectionWidth,
  spanForZoom,
  valueAtIndex,
  windowStartFor,
  type OddsRange,
  type OddsZoom,
} from "./oddsRing";

export type CircularSelectorProps = {
  value: OddsPrediction | null;
  mode: "exact" | "range";
  zoom: OddsZoom;
  disabled?: boolean;
  /** The window this round's clue admits, for dimming ruled-out values. */
  ruledOut?: ClueWindow | null;
  onChange: (prediction: OddsPrediction | null) => void;
  onZoomChange: (zoom: OddsZoom) => void;
  className?: string;
};

type DragTarget = "min" | "max" | "anchor";

/** Distance between the two active pointers, for pinch detection. */
function pointerDistance(points: Map<number, { x: number; y: number }>): number {
  const [first, second] = [...points.values()];
  if (!first || !second) return 0;
  return Math.hypot(first.x - second.x, first.y - second.y);
}

export default function CircularSelector({
  value,
  mode,
  zoom,
  disabled = false,
  ruledOut = null,
  onChange,
  onZoomChange,
  className = "",
}: CircularSelectorProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const valueRef = useRef(value);
  valueRef.current = value;
  const reduce = useReducedMotionSafe();

  const [hover, setHover] = useState<number | null>(null);
  const [hoverHandle, setHoverHandle] = useState<"min" | "max" | null>(null);
  const [pressed, setPressed] = useState(false);
  const [focused, setFocused] = useState(false);
  const [focusValue, setFocusValue] = useState<number>(
    () => selectionOf(value)?.min ?? 50,
  );
  // The half-finished range: first tap records it, the next tap extends it.
  const [pending, setPending] = useState<OddsRange | null>(null);

  const dragRef = useRef<DragTarget | null>(null);
  const anchorRef = useRef<OddsRange | null>(null);
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const pinchRef = useRef<{ distance: number } | null>(null);

  const selection = selectionOf(value);
  const span = spanForZoom(zoom, selection);
  const grouped = span >= 100;
  const step = 360 / span;
  const centerValue = selection
    ? Math.round((selection.min + selection.max) / 2)
    : focusValue;
  const start = windowStartFor(centerValue, span);
  const gap = Math.min(0.9, step * 0.16);

  const emit = useCallback(
    (next: OddsPrediction | null) => onChange(next),
    [onChange],
  );

  // A half-finished range (tap, then tap again) only survives while the value
  // it recorded is still the value on the board. Anything else — a preset, a
  // typed number, a handle drag — clears it.
  useEffect(() => {
    if (dragRef.current) return;
    if (pending === null) return;
    const current = selectionOf(value);
    if (
      !current ||
      current.min !== pending.min ||
      current.max !== pending.max
    ) {
      setPending(null);
    }
  }, [value, pending]);

  // Keep the keyboard cursor inside the selection once one exists.
  useEffect(() => {
    const current = selectionOf(value);
    if (!current) return;
    if (focusValue < current.min || focusValue > current.max) {
      setFocusValue(current.min);
    }
  }, [value, focusValue]);

  // A pointer released outside the wheel (or lost by the browser) must not
  // leave the pressed styling stuck on.
  useEffect(() => {
    const release = () => setPressed(false);
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    return () => {
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
    };
  }, []);

  // Mouse-wheel zoom. Registered natively because React's synthetic wheel
  // listener is passive and cannot preventDefault the page scroll.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || disabled) return undefined;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      onZoomChange(clampZoom(zoom + (event.deltaY < 0 ? 1 : -1)));
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [disabled, onZoomChange, zoom]);

  const svgPoint = useCallback(
    (event: React.PointerEvent): { x: number; y: number } | null => {
      const svg = svgRef.current;
      if (!svg) return null;
      const rect = svg.getBoundingClientRect();
      const size = Math.min(rect.width, rect.height);
      if (!size) return null;
      const left = rect.left + (rect.width - size) / 2;
      const top = rect.top + (rect.height - size) / 2;
      return {
        x: ((event.clientX - left) / size) * RING_VIEWBOX,
        y: ((event.clientY - top) / size) * RING_VIEWBOX,
      };
    },
    [],
  );

  const hitHandle = useCallback(
    (point: { x: number; y: number }): "min" | "max" | null => {
      const current = selectionOf(valueRef.current);
      if (!current || current.min === current.max) return null;
      const near = (angle: number | null) => {
        if (angle === null) return false;
        const handle = polar(angle, RING_HANDLE);
        return (
          Math.hypot(point.x - handle.x, point.y - handle.y) <= HANDLE_HIT_RADIUS
        );
      };
      if (near(angleForValue(start, span, current.min))) return "min";
      if (near(angleForValue(start, span, current.max))) return "max";
      return null;
    },
    [span, start],
  );

  const handlePointerDown = (event: React.PointerEvent<SVGSVGElement>) => {
    if (disabled) return;
    const point = svgPoint(event);
    if (!point) return;
    setPressed(true);

    pointersRef.current.set(event.pointerId, point);
    if (pointersRef.current.size === 2) {
      pinchRef.current = { distance: pointerDistance(pointersRef.current) };
      dragRef.current = null;
      return;
    }
    if (pointersRef.current.size > 2) return;

    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture is an enhancement; dragging still works without it.
    }

    const tapped = pointerToValue(point.x, point.y, start, span);
    if (tapped === null) return;

    // Zoomed out, a tap means the whole decade it landed on — that is what
    // makes 1–10 … 91–100 selectable as intervals rather than 100 slivers.
    const decade = grouped
      ? ODDS_DECADES.find((entry) => tapped >= entry.min && tapped <= entry.max)
      : undefined;
    const target: OddsRange = decade
      ? { min: decade.min, max: decade.max }
      : { min: tapped, max: tapped };

    if (mode === "exact") {
      // An exact call is one number, so a group tap zooms in instead of
      // picking a value on the player's behalf.
      setPending(null);
      dragRef.current = null;
      if (decade) {
        setFocusValue(tapped);
        onZoomChange(clampZoom(zoom + 1));
        return;
      }
      emit(exactPrediction(tapped));
      return;
    }

    const handle = hitHandle(point);
    if (handle) {
      setPending(null);
      anchorRef.current = null;
      dragRef.current = handle;
      return;
    }

    if (pending !== null) {
      const range: OddsRange = {
        min: Math.min(pending.min, target.min),
        max: Math.max(pending.max, target.max),
      };
      setPending(null);
      anchorRef.current = null;
      emit(rangePrediction(range));
      // Continue the gesture from the end just tapped, so a drag refines it.
      dragRef.current = target.min > pending.max ? "max" : "min";
      return;
    }

    setPending(target);
    anchorRef.current = target;
    emit(rangePrediction(target));
    dragRef.current = "anchor";
  };

  const handlePointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    if (disabled) return;
    const point = svgPoint(event);
    if (!point) return;
    if (pointersRef.current.has(event.pointerId)) {
      pointersRef.current.set(event.pointerId, point);
    }

    // Pinch: two pointers, distance ratio drives the zoom step.
    if (pointersRef.current.size === 2) {
      const distance = pointerDistance(pointersRef.current);
      const base = pinchRef.current?.distance ?? distance;
      if (base > 0 && distance > base * 1.35) {
        onZoomChange(clampZoom(zoom + 1));
        pinchRef.current = { distance };
      } else if (base > 0 && distance < base * 0.74) {
        onZoomChange(clampZoom(zoom - 1));
        pinchRef.current = { distance };
      }
      return;
    }

    const target = dragRef.current;
    if (target) {
      const current = selectionOf(valueRef.current);
      if (!current) return;
      const moved = pointerToValue(point.x, point.y, start, span);
      if (moved === null) return;
      if (target === "min") {
        emit(rangePrediction({ min: Math.min(moved, current.max), max: current.max }));
      } else if (target === "max") {
        emit(rangePrediction({ min: current.min, max: Math.max(moved, current.min) }));
      } else if (anchorRef.current !== null) {
        const anchor = anchorRef.current;
        emit(
          rangePrediction({
            min: Math.min(anchor.min, moved),
            max: Math.max(anchor.max, moved),
          }),
        );
      }
      return;
    }

    const hovered = hitHandle(point);
    setHoverHandle(hovered);
    setHover(hovered ? null : pointerToValue(point.x, point.y, start, span));
  };

  const endGesture = (event: React.PointerEvent<SVGSVGElement>) => {
    setPressed(false);
    setHoverHandle(null);
    pointersRef.current.delete(event.pointerId);
    if (pointersRef.current.size < 2) pinchRef.current = null;

    if (dragRef.current === "anchor" && anchorRef.current !== null) {
      const current = selectionOf(valueRef.current);
      const anchor = anchorRef.current;
      const dragged =
        current !== null &&
        (current.min !== anchor.min || current.max !== anchor.max);
      // A tap leaves the anchor open for the second tap; a drag committed.
      if (dragged) setPending(null);
    }
    dragRef.current = null;
    anchorRef.current = null;

    const svg = svgRef.current;
    if (svg?.hasPointerCapture?.(event.pointerId)) {
      try {
        svg.releasePointerCapture(event.pointerId);
      } catch {
        // Already released.
      }
    }
  };

  const commitValue = (candidate: number) => {
    if (disabled) return;
    if (mode === "exact") {
      setPending(null);
      emit(exactPrediction(candidate));
      return;
    }
    const target: OddsRange = { min: candidate, max: candidate };
    if (pending !== null) {
      setPending(null);
      emit(
        rangePrediction({
          min: Math.min(pending.min, target.min),
          max: Math.max(pending.max, target.max),
        }),
      );
      return;
    }
    setPending(target);
    emit(rangePrediction(target));
  };

  const handleKeyDown = (event: React.KeyboardEvent<SVGSVGElement>) => {
    if (disabled) return;
    const stride = event.shiftKey ? 10 : 1;

    if (event.key === "Escape") {
      event.preventDefault();
      setPending(null);
      emit(null);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      commitValue(focusValue);
      return;
    }

    let next: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowUp") {
      next = focusValue + stride;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
      next = focusValue - stride;
    } else if (event.key === "Home") {
      next = 1;
    } else if (event.key === "End") {
      next = 100;
    }
    if (next === null) return;

    event.preventDefault();
    const candidate = clampDomain(next);
    setFocusValue(candidate);
    // With an open range the cursor moves its far end, so the wheel previews
    // the growing interval while the keyboard walks it.
    if (mode === "range" && pending !== null) {
      emit(
        rangePrediction({
          min: Math.min(pending.min, candidate),
          max: Math.max(pending.max, candidate),
        }),
      );
    }
  };

  const currentLabel = selection ? selectionLabel(value) : "—";
  const width = selection ? selectionWidth(value) : 0;
  // The engine's own scorer against a target inside the call — never a second
  // copy of the paytable.
  const outcome = potentialScore(value);

  const segmentProps = (from: number, to: number) => {
    const inSelection = selection !== null && from >= selection.min && to <= selection.max;
    const overlaps = selection !== null && from <= selection.max && to >= selection.min;
    const isBoundary =
      selection !== null &&
      selection.min !== selection.max &&
      (selection.min === from || selection.max === to);
    const isHovered =
      hover !== null && hover >= from && hover <= to;
    // A value is dimmed only when the clue rules the WHOLE cell out. A group
    // the clue straddles keeps full strength, so the ring never claims the
    // clue said more than it did.
    const ruledOutHere = ruledOut !== null && (to < ruledOut.min || from > ruledOut.max);

    if (isBoundary) {
      return {
        fill: "#f5ff3b",
        fillOpacity: 0.9,
        stroke: "#00e5ff",
        strokeWidth: 1.6,
        strokeOpacity: 1,
      };
    }
    if (inSelection) {
      return {
        fill: "#f5ff3b",
        fillOpacity: 0.86,
        stroke: "#f5ff3b",
        strokeWidth: 0.6,
        strokeOpacity: 0.7,
      };
    }
    if (overlaps) {
      return {
        fill: "#f5ff3b",
        fillOpacity: 0.3,
        stroke: "rgba(245,255,59,0.45)",
        strokeWidth: 0.6,
        strokeOpacity: 1,
      };
    }
    if (isHovered) {
      return {
        fill: "#00e5ff",
        fillOpacity: ruledOutHere ? 0.14 : 0.34,
        stroke: "rgba(0,229,255,0.55)",
        strokeWidth: 0.6,
        strokeOpacity: ruledOutHere ? 0.3 : 1,
      };
    }
    if (ruledOutHere) {
      return {
        fill: "#00e5ff",
        fillOpacity: 0.03,
        stroke: "rgba(0,229,255,0.12)",
        strokeWidth: 0.5,
        strokeOpacity: 1,
      };
    }
    return {
      fill: "#00e5ff",
      fillOpacity: 0.12,
      stroke: "rgba(0,229,255,0.22)",
      strokeWidth: 0.5,
      strokeOpacity: 1,
    };
  };

  const blocks = grouped
    ? ODDS_DECADES.map((preset, index) => ({
        key: `decade-${preset.id}`,
        from: preset.min,
        to: preset.max,
        label: preset.label,
        fromAngle: index * step + gap / 2,
        toAngle: (index + 1) * step - gap / 2,
      }))
    : Array.from({ length: span }, (_, index) => {
        const parsed = valueAtIndex(start, span, index);
        return {
          key: `value-${index}-${parsed}`,
          from: parsed,
          to: parsed,
          label: String(parsed),
          fromAngle: index * step + gap / 2,
          toAngle: (index + 1) * step - gap / 2,
        };
      });

  const focusAngle = focused
    ? angleForValue(start, span, focusValue)
    : null;
  const minAngle = selection ? angleForValue(start, span, selection.min) : null;
  const maxAngle = selection ? angleForValue(start, span, selection.max) : null;

  // Zoom levels cross-fade rather than pop. Keyed by the LEVEL (not the span),
  // so a selection that widens the window mid-drag updates in place instead of
  // remounting the ring under the pointer.
  const ringKey = grouped ? "decades" : `zoom-${zoom}`;
  // Boundaries follow the pointer exactly while dragging; only non-drag moves
  // (a preset, a typed number, an arrow key) get the eased glide.
  const handleSeconds = motionSeconds(reduce, dragRef.current ? 0 : 0.18);
  const minPoint = minAngle === null ? null : polar(minAngle, RING_HANDLE);
  const maxPoint = maxAngle === null ? null : polar(maxAngle, RING_HANDLE);
  const focusPoint = focusAngle === null ? null : polar(focusAngle, RING_INNER - 14);

  return (
    <div className={`relative mx-auto w-full ${className}`}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${RING_VIEWBOX} ${RING_VIEWBOX}`}
        className={`mx-auto block h-auto w-full max-w-[360px] touch-none select-none rounded-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#f5ff3b]/70 ${
          disabled ? "cursor-default opacity-60" : "cursor-pointer"
        }`}
        role="group"
        tabIndex={disabled ? -1 : 0}
        aria-label={`Number wheel, 1 to 100. ${
          selection
            ? `${selectionLabel(value)} selected, width ${width}, about ${outcome} possible points.`
            : "Nothing selected."
        }${ruledOut ? ` The clue limits this to ${ruledOut.min}–${ruledOut.max}.` : ""} Arrow keys move, Enter selects, Escape clears.`}
        aria-describedby="odds-wheel-help"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endGesture}
        onPointerCancel={endGesture}
        onPointerLeave={() => {
          if (!dragRef.current) {
            setHover(null);
            setHoverHandle(null);
            setPressed(false);
          }
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={handleKeyDown}
      >
        <defs>
          <radialGradient id="odds-wheel-ground" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#04142c" stopOpacity="0.9" />
            <stop offset="100%" stopColor="#01060f" stopOpacity="0.98" />
          </radialGradient>
        </defs>

        <circle
          cx={RING_CENTER}
          cy={RING_CENTER}
          r={RING_OUTER + 12}
          fill="url(#odds-wheel-ground)"
          stroke={pressed ? "rgba(0,229,255,0.3)" : "rgba(0,229,255,0.16)"}
          strokeWidth="0.7"
          className="transition-[stroke] duration-100"
        />
        <circle
          cx={RING_CENTER}
          cy={RING_CENTER}
          r={RING_INNER - 6}
          fill="none"
          stroke="rgba(0,229,255,0.14)"
          strokeWidth="0.7"
          strokeDasharray="2 4"
        />

        <AnimatePresence initial={false}>
          <motion.g
            key={ringKey}
            data-odds-ring={ringKey}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            // The outgoing level clears quickly, so two sets of labels are
            // never both legible at once while the new level fades in.
            exit={{ opacity: 0, transition: { duration: motionSeconds(reduce, 0.08) } }}
            transition={{ duration: motionSeconds(reduce, ZOOM_SECONDS) }}
          >
        {blocks.map((block) => {
          const paint = segmentProps(block.from, block.to);
          return (
            <path
              key={block.key}
              d={annularSectorPath(block.fromAngle, block.toAngle)}
              fill={paint.fill}
              fillOpacity={paint.fillOpacity}
              stroke={paint.stroke}
              strokeWidth={paint.strokeWidth}
              strokeOpacity={paint.strokeOpacity}
              className="transition-[fill-opacity,stroke-opacity] duration-150"
            />
          );
        })}

        {/* Individual labels: everything at medium, wider type when zoomed in. */}
        {!grouped &&
          blocks.map((block, index) => {
            const angle = angleForIndex(index, span);
            const point = polar(angle, RING_LABEL);
            const inSelection =
              selection !== null &&
              block.from >= selection.min &&
              block.from <= selection.max;
            const isBoundary =
              selection !== null && selection.min !== selection.max
                ? block.from === selection.min || block.from === selection.max
                : selection !== null && block.from === selection.min;
            return (
              <text
                key={`label-${block.key}`}
                x={point.x}
                y={point.y}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={span > 20 ? 7.5 : 10}
                fontWeight={isBoundary ? 800 : inSelection ? 700 : 500}
                className="odds-readout pointer-events-none"
                fill={
                  isBoundary
                    ? "#00e5ff"
                    : inSelection
                      ? "#f5ff3b"
                      : isRuledOut(block.from, ruledOut)
                        ? "rgba(255,255,255,0.16)"
                        : "rgba(255,255,255,0.45)"
                }
              >
                {block.label}
              </text>
            );
          })}

        {/* Decade labels at the zoomed-out level. */}
        {grouped &&
          blocks.map((block) => {
            const angle = (block.fromAngle + block.toAngle) / 2;
            const point = polar(angle, RING_LABEL);
            const inSelection =
              selection !== null &&
              block.from >= selection.min &&
              block.to <= selection.max;
            const overlaps =
              selection !== null &&
              block.from <= selection.max &&
              block.to >= selection.min;
            return (
              <text
                key={`group-label-${block.key}`}
                x={point.x}
                y={point.y}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={8.5}
                fontWeight={inSelection ? 800 : 600}
                className="odds-label pointer-events-none"
                fill={
                  inSelection
                    ? "#f5ff3b"
                    : overlaps
                      ? "rgba(245,255,59,0.75)"
                      : ruledOut !== null &&
                          (block.to < ruledOut.min || block.from > ruledOut.max)
                        ? "rgba(255,255,255,0.2)"
                        : "rgba(255,255,255,0.5)"
                }
              >
                {block.label}
              </text>
            );
          })}
          </motion.g>
        </AnimatePresence>

        {/* Min / max handles — the grabbable ends of the range. */}
        {selection && selection.min !== selection.max && minPoint && (
          <motion.g
            initial={false}
            animate={{ x: minPoint.x - RING_CENTER, y: minPoint.y - RING_CENTER }}
            transition={{ duration: handleSeconds, ease: "easeOut" }}
            className="cursor-grab"
            data-odds-handle="min"
          >
            <circle
              cx={RING_CENTER}
              cy={RING_CENTER}
              r={hoverHandle === "min" ? 8 : 7}
              fill="#04142c"
              stroke="#00e5ff"
              strokeWidth="2"
            />
            <circle cx={RING_CENTER} cy={RING_CENTER} r={2.4} fill="#00e5ff" />
          </motion.g>
        )}
        {selection && selection.min !== selection.max && maxPoint && (
          <motion.g
            initial={false}
            animate={{ x: maxPoint.x - RING_CENTER, y: maxPoint.y - RING_CENTER }}
            transition={{ duration: handleSeconds, ease: "easeOut" }}
            className="cursor-grab"
            data-odds-handle="max"
          >
            <circle
              cx={RING_CENTER}
              cy={RING_CENTER}
              r={hoverHandle === "max" ? 8 : 7}
              fill="#04142c"
              stroke="#00e5ff"
              strokeWidth="2"
            />
            <circle cx={RING_CENTER} cy={RING_CENTER} r={2.4} fill="#00e5ff" />
          </motion.g>
        )}

        {/* Single marker for a one-number call. */}
        {selection && selection.min === selection.max && minPoint && (
          <motion.g
            initial={false}
            animate={{ x: minPoint.x - RING_CENTER, y: minPoint.y - RING_CENTER }}
            transition={{ duration: handleSeconds, ease: "easeOut" }}
            data-odds-marker="exact"
          >
            <circle
              cx={RING_CENTER}
              cy={RING_CENTER}
              r={pressed ? 6 : 5.5}
              fill="#f5ff3b"
              stroke="#00e5ff"
              strokeWidth="1.4"
            />
          </motion.g>
        )}

        {/* Keyboard cursor. */}
        {focusPoint && (
          <motion.g
            initial={false}
            animate={{ x: focusPoint.x - RING_CENTER, y: focusPoint.y - RING_CENTER }}
            transition={{ duration: handleSeconds, ease: "easeOut" }}
          >
            <circle cx={RING_CENTER} cy={RING_CENTER} r={3.2} fill="#f5ff3b" />
          </motion.g>
        )}
      </svg>

      {/* HUD readout in the middle of the wheel. */}
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
        <span className="odds-label text-white/30">
          {mode === "exact" ? "exact" : "range"}
        </span>
        <span
          className={`odds-readout mt-1 text-2xl ${
            selection ? "text-[#f5ff3b]" : "text-white/25"
          }`}
        >
          {currentLabel}
        </span>
        <span className="odds-label mt-1 text-white/35">
          {selection ? `${width} wide` : "no call"}
        </span>
        {pending !== null && (
          <span className="odds-label mt-1 text-cyan-300">tap the other end</span>
        )}
      </div>

      <p id="odds-wheel-help" className="sr-only">
        Tap a number to start a range, tap another to close it, or drag around
        the ring. Drag the cyan handles to move either boundary. Arrow keys move
        one number, Shift moves ten, Enter selects, Escape clears. Zoom with the
        mouse wheel, a pinch, or the plus and minus controls.
      </p>
    </div>
  );
}
