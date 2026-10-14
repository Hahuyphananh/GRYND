"use client";

// src/components/stats/LineChart.tsx
//
// The dashboard's chart: ONE series, hand-rolled as SVG.
//
// WHY NOT A CHART LIBRARY: the repository has none installed, and these charts
// need exactly four things — a line, a handful of readable y ticks, dated x
// labels and a tooltip. Adding a charting dependency for that would cost more
// bundle than it earns, so the chart is a small, accessible component instead.
//
// READABILITY RULES it keeps:
//   * axes are labelled with real numbers/dates (never a bare sparkline),
//   * the y domain is padded so a flat line never sits on the frame,
//   * every point is reachable — hovering shows the value, and each point is
//     keyboard-focusable (Tab), so the chart is not mouse-only,
//   * `lowerIsBetter` flips the axis for RANK charts (rank 1 at the top), which
//     is labelled on the axis so the direction is never ambiguous,
//   * fewer than two points renders the empty label instead of a fake line.

import { useMemo, useState } from "react";

export type ChartPoint = { at: string; value: number };

const VIEW_W = 640;
const PAD = { top: 14, right: 12, bottom: 26, left: 46 };

function dayLabel(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function fullLabel(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  return new Date(ms).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function niceTicks(min: number, max: number, count = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (min === max) return [min];
  const step = (max - min) / (count - 1);
  return Array.from({ length: count }, (_, i) => min + step * i);
}

export default function LineChart({
  points,
  color = "#00e5ff",
  height = 180,
  lowerIsBetter = false,
  suffix = "",
  axisLabel,
  seriesLabel,
  emptyLabel,
  formatValue = (value: number) => Math.round(value).toLocaleString(),
}: {
  points: ChartPoint[];
  color?: string;
  height?: number;
  /** Rank charts: value 1 belongs at the TOP (lower is better). */
  lowerIsBetter?: boolean;
  suffix?: string;
  /** Shown next to the y axis so the direction is never ambiguous. */
  axisLabel?: string;
  seriesLabel: string;
  emptyLabel: string;
  formatValue?: (value: number) => string;
}) {
  const [active, setActive] = useState<number | null>(null);

  const model = useMemo(() => {
    const usable = points.filter((point) => Number.isFinite(point.value));
    if (usable.length < 2) return null;

    const values = usable.map((point) => point.value);
    let min = Math.min(...values);
    let max = Math.max(...values);
    if (min === max) {
      const pad = Math.max(Math.abs(min) * 0.02, 1);
      min -= pad;
      max += pad;
    } else {
      const pad = (max - min) * 0.08;
      min -= pad;
      max += pad;
    }

    const plotW = VIEW_W - PAD.left - PAD.right;
    const plotH = height - PAD.top - PAD.bottom;
    const x = (index: number) =>
      PAD.left + (usable.length === 1 ? plotW / 2 : (index / (usable.length - 1)) * plotW);
    const y = (value: number) => {
      const ratio = (value - min) / (max - min);
      const normalised = lowerIsBetter ? ratio : 1 - ratio;
      return PAD.top + normalised * plotH;
    };

    const line = usable.map((point, index) => `${index === 0 ? "M" : "L"}${x(index).toFixed(1)},${y(point.value).toFixed(1)}`).join(" ");
    const area = `${line} L${x(usable.length - 1).toFixed(1)},${(PAD.top + plotH).toFixed(1)} L${x(0).toFixed(1)},${(PAD.top + plotH).toFixed(1)} Z`;

    return {
      usable,
      min,
      max,
      x,
      y,
      line,
      area,
      baseline: PAD.top + plotH,
      ticks: niceTicks(min, max),
    };
  }, [points, height, lowerIsBetter]);

  if (!model) {
    return (
      <p className="rounded-lg border border-white/10 bg-white/5 px-4 py-6 text-center text-sm text-[#9dd8ff]/70">
        {emptyLabel}
      </p>
    );
  }

  const first = model.usable[0];
  const last = model.usable[model.usable.length - 1];
  const middle = model.usable[Math.floor(model.usable.length / 2)];
  const activePoint = active !== null ? model.usable[active] : null;

  return (
    <figure className="relative">
      <svg
        viewBox={`0 0 ${VIEW_W} ${height}`}
        className="h-auto w-full touch-none"
        role="img"
        aria-label={`${seriesLabel}: ${formatValue(first.value)}${suffix} on ${fullLabel(first.at)} → ${formatValue(last.value)}${suffix} on ${fullLabel(last.at)}`}
        onMouseLeave={() => setActive(null)}
        onMouseMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          if (!rect.width) return;
          const ratio = (event.clientX - rect.left) / rect.width;
          const index = Math.round(ratio * (model.usable.length - 1));
          setActive(Math.max(0, Math.min(model.usable.length - 1, index)));
        }}
      >
        <title>{seriesLabel}</title>

        {model.ticks.map((tick, index) => (
          <g key={index}>
            <line
              x1={PAD.left}
              x2={VIEW_W - PAD.right}
              y1={model.y(tick)}
              y2={model.y(tick)}
              stroke="#ffffff"
              strokeOpacity="0.08"
              strokeWidth="1"
            />
            <text
              x={PAD.left - 8}
              y={model.y(tick) + 4}
              textAnchor="end"
              className="fill-[#9dd8ff]/70"
              fontSize="11"
            >
              {formatValue(tick)}
            </text>
          </g>
        ))}

        <path d={model.area} fill={color} fillOpacity="0.12" />
        <path d={model.line} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" />

        {[first, middle, last].map((point, index) => (
          <text
            key={index}
            x={model.x(model.usable.indexOf(point))}
            y={height - 6}
            textAnchor={index === 0 ? "start" : index === 2 ? "end" : "middle"}
            className="fill-[#9dd8ff]/70"
            fontSize="11"
          >
            {dayLabel(point.at)}
          </text>
        ))}

        {model.usable.map((point, index) => (
          <circle
            key={`${point.at}-${index}`}
            cx={model.x(index)}
            cy={model.y(point.value)}
            r={active === index ? 5 : 3}
            fill={active === index ? "#ffffff" : color}
            stroke={color}
            strokeWidth="1.5"
            focusable="true"
            tabIndex={0}
            onFocus={() => setActive(index)}
            onBlur={() => setActive(null)}
            role="img"
            aria-label={`${fullLabel(point.at)}: ${formatValue(point.value)}${suffix}`}
          />
        ))}

        {activePoint && (
          <line
            x1={model.x(active as number)}
            x2={model.x(active as number)}
            y1={PAD.top}
            y2={model.baseline}
            stroke="#ffffff"
            strokeOpacity="0.25"
            strokeDasharray="3 3"
          />
        )}
      </svg>

      {axisLabel && (
        <figcaption className="mt-1 text-[11px] uppercase tracking-wider text-[#9dd8ff]/60">
          {axisLabel}
        </figcaption>
      )}

      {activePoint && (
        <div
          className="pointer-events-none absolute -translate-x-1/2 rounded-md border border-[#00e5ff]/40 bg-[#04122b]/95 px-2 py-1 text-[11px] font-semibold text-white shadow-lg"
          style={{
            left: `${(model.x(active as number) / VIEW_W) * 100}%`,
            top: `${(model.y(activePoint.value) / height) * 100}%`,
          }}
        >
          <span className="block text-[#9dd8ff]/80">{fullLabel(activePoint.at)}</span>
          <span className="block">
            {seriesLabel}: {formatValue(activePoint.value)}
            {suffix}
          </span>
        </div>
      )}
    </figure>
  );
}
