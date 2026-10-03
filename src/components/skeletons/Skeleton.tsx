import type { CSSProperties, ReactNode } from "react";

/**
 * Branded skeleton primitives for IN-PAGE loading states.
 *
 * `PageSkeleton` covers whole-route loading (the splash screen and
 * `app/loading.tsx`); these are the smaller pieces a panel, list or widget
 * needs while it fetches. They all use the shared `.skeleton` surface
 * (navy base + cyan/gold shimmer, reduced-motion aware — see globals.css), so
 * every loader in the app reads as the same product instead of a raw
 * "Loading..." string.
 */

/** A single shimmer block. Radius comes from the `rounded-*` utility you pass. */
export function Skeleton({
  className = "",
  style,
}: {
  className?: string;
  style?: CSSProperties;
}) {
  return <div aria-hidden className={`skeleton ${className}`} style={style} />;
}

/** A few stacked text lines of varying widths. */
export function SkeletonLines({
  count = 2,
  widths = ["w-3/4", "w-1/2"],
  className = "",
}: {
  count?: number;
  widths?: string[];
  className?: string;
}) {
  return (
    <div aria-hidden className={`space-y-2 ${className}`}>
      {Array.from({ length: count }, (_, i) => (
        <Skeleton key={i} className={`h-3 ${widths[i % widths.length]}`} />
      ))}
    </div>
  );
}

/**
 * N list rows in the app's standard row shape (leading disc, two text lines,
 * trailing value). Wrapped in an `aria-busy` region with an optional
 * screen-reader label, so a list that is loading is announced once.
 */
export function SkeletonRows({
  rows = 5,
  className = "",
  label = "Loading",
}: {
  rows?: number;
  className?: string;
  label?: string;
}) {
  return (
    <div role="status" aria-busy="true" aria-label={label} className={className}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3 px-2 py-3">
          <Skeleton className="h-8 w-8 shrink-0 rounded-full" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-3.5 w-2/5" />
            <Skeleton className="h-2.5 w-1/3" />
          </div>
          <Skeleton className="h-4 w-12 shrink-0" />
        </div>
      ))}
    </div>
  );
}

/** N card-shaped placeholders in a responsive grid, for card walls. */
export function SkeletonCards({
  cards = 6,
  className = "",
  gridClassName = "grid gap-4 sm:grid-cols-2 lg:grid-cols-3",
  label = "Loading",
  children,
}: {
  cards?: number;
  className?: string;
  gridClassName?: string;
  label?: string;
  /** Optional custom card body; defaults to a title + two text lines. */
  children?: ReactNode;
}) {
  return (
    <div role="status" aria-busy="true" aria-label={label} className={className}>
      <div className={gridClassName}>
        {Array.from({ length: cards }, (_, i) => (
          <div
            key={i}
            className="rounded-xl border border-[#00e5ff]/15 bg-[#040d24]/70 p-5"
          >
            {children ?? <SkeletonLines count={3} widths={["w-1/3", "w-full", "w-2/3"]} />}
          </div>
        ))}
      </div>
    </div>
  );
}
