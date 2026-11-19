"use client";

// src/components/streaks/MilestoneRail.tsx
//
// A compact visual overview of every milestone: achieved milestones are filled,
// the next one is highlighted, the rest are muted. The full titles live in the
// accessible text beside it (and on /rewards), so the rail itself is hidden from
// assistive tech rather than announcing fifteen unlabelled segments.

import type { StreakMilestone } from "../../hooks/useDailyStreak";

export function MilestoneRail({
  milestones,
  className = "",
}: {
  milestones: StreakMilestone[];
  className?: string;
}) {
  return (
    <ol aria-hidden="true" className={`flex items-center gap-1 ${className}`}>
      {milestones.map((milestone) => (
        <li
          key={milestone.days}
          title={`Day ${milestone.days} — ${milestone.title}`}
          className={[
            "h-1.5 flex-1 rounded-full",
            milestone.achieved
              ? "bg-[color:var(--accent-strong)]"
              : milestone.isNext
                ? "bg-[color:var(--accent)]"
                : "bg-[color:var(--border-strong)]",
          ].join(" ")}
        />
      ))}
    </ol>
  );
}
