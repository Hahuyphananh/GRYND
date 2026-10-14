"use client";

// src/components/stats/StatTile.tsx
//
// One headline number on the performance dashboard. Deliberately dumb: the
// VALUE is always formatted by the caller from the server payload, so a tile
// can never invent, recompute or round a statistic on its own.

export default function StatTile({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: string;
  value: string;
  hint?: string | null;
  tone?: "default" | "good" | "bad" | "muted";
}) {
  const valueClass =
    tone === "good"
      ? "text-[#00ffa6]"
      : tone === "bad"
        ? "text-red-300/90"
        : tone === "muted"
          ? "text-[#9dd8ff]/70"
          : "text-white";

  return (
    <div className="rounded-xl border border-[#00e5ff]/25 bg-[#04122b]/70 p-4">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-[#9dd8ff]/70">
        {label}
      </p>
      <p className={`mt-1 text-2xl font-black tabular-nums ${valueClass}`}>{value}</p>
      {hint ? <p className="mt-1 text-xs text-[#9dd8ff]/60">{hint}</p> : null}
    </div>
  );
}
