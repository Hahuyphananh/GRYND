"use client";

// src/components/streaks/StreakProgress.tsx
//
// The one progress bar the streak surfaces share. Presentational: the caller
// passes the server-derived current day and target, so the bar can never
// disagree with the text beside it.

export function StreakProgress({
  current,
  target,
  label,
  className = "",
}: {
  current: number;
  target: number;
  label: string;
  className?: string;
}) {
  const safeTarget = Math.max(1, Number(target) || 1);
  const safeCurrent = Math.min(safeTarget, Math.max(0, Number(current) || 0));
  const percent = Math.round((safeCurrent / safeTarget) * 100);

  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={safeTarget}
      aria-valuenow={safeCurrent}
      className={`h-1.5 w-full overflow-hidden rounded-full bg-[color:var(--border-strong)] ${className}`}
    >
      <div
        className="h-full rounded-full bg-[color:var(--accent-strong)] transition-[width] duration-300"
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}
