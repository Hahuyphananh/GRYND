"use client";

// THE DAILY STREAK RECORD BADGE.
//
// One dynamic badge, not a cosmetic per day and not another progression track.
// The number is always `user_streaks.longest_streak` (the canonical best UTC
// play streak), which `advanceStreak` only ever raises. The caller passes that
// value in; this component never writes, claims or fetches ownership rows, so
// logging out and back in cannot lose the record and a reset of the current
// streak cannot lower it.
//
// Deliberately separate from PlayerLevelBadge: that component is the trophy
// rank shield, while this is an amber flame record pill.

import FlameMark from "../FlameMark";
import { useTranslation } from "../../hooks/useTranslation";

export default function DailyStreakRecordBadge({
  bestStreak,
  className = "",
}: {
  bestStreak: number;
  className?: string;
}) {
  const { t } = useTranslation();
  const best = Math.max(0, Math.floor(Number(bestStreak) || 0));

  // No record yet: render nothing rather than a zero-day badge.
  if (best <= 0) return null;

  const unit =
    best === 1
      ? t("profile.info.unitDay", "day")
      : t("profile.info.unitDays", "days");
  const label = t("profile.badges.dailyStreakRecord", "Daily Streak Record");
  const aria = t("profile.badges.dailyStreakRecordAria", {
    count: best,
    unit,
  });

  return (
    <span
      data-testid="daily-streak-record-badge"
      role="img"
      aria-label={aria}
      title={aria}
      className={`inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-full border border-amber-400/60 bg-amber-500/10 px-2.5 py-1 align-middle text-xs font-semibold text-amber-200 ${className}`}
    >
      <FlameMark size={18} />
      <span className="truncate">{label}</span>
      <span aria-hidden="true" className="text-amber-300/60">
        ·
      </span>
      <span className="shrink-0 tabular-nums text-amber-300">{best}</span>
      <span className="shrink-0 text-amber-200/80">{unit}</span>
    </span>
  );
}
