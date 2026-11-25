"use client";

// THE RANKED WIN-STREAK BADGE.
//
// One component, two independent game keys. Solitaire Ranked reads
// `solitaire-duel`; Puzzle Ranked reads `solitaire-puzzle`. The caller passes
// the authoritative values from `user_competitive_streaks`; this component
// never fetches, writes, claims or combines the two ladders.
//
// A zero current streak is rendered as an inactive surface with "No active
// streak", while the personal best stays visible. That makes a loss legible
// without making a zero look like a live winning run.

import { IconCards, IconPuzzle } from "@tabler/icons-react";

import { useTranslation } from "../../hooks/useTranslation";
import type { CompetitiveGameKey } from "../../lib/competitiveStreakModel";

export default function CompetitiveStreakBadge({
  gameKey,
  current = 0,
  best = 0,
  className = "",
}: {
  gameKey: CompetitiveGameKey;
  current?: number;
  best?: number;
  className?: string;
}) {
  const { t } = useTranslation();
  const isDuel = gameKey === "solitaire-duel";
  const currentCount = Math.max(0, Math.floor(Number(current) || 0));
  const bestCount = Math.max(currentCount, Math.floor(Number(best) || 0));

  // No row and no wins: nothing to show yet.
  if (currentCount <= 0 && bestCount <= 0) return null;

  const label = isDuel
    ? t("profile.badges.competitiveSolitaire", "Solitaire Ranked")
    : t("profile.badges.competitivePuzzle", "Puzzle Ranked");
  const currentUnit =
    currentCount === 1
      ? t("profile.badges.competitiveWin", "win")
      : t("profile.badges.competitiveWins", "wins");
  const bestUnit =
    bestCount === 1
      ? t("profile.badges.competitiveWin", "win")
      : t("profile.badges.competitiveWins", "wins");
  const currentText =
    currentCount > 0
      ? t("profile.badges.competitiveCurrent", {
          count: currentCount,
          unit: currentUnit,
        })
      : t("profile.badges.competitiveNoCurrent", "No active streak");
  const bestText = t("profile.badges.competitiveBest", {
    count: bestCount,
    unit: bestUnit,
  });
  const aria = t("profile.badges.competitiveAria", {
    game: label,
    current: currentText,
    best: bestText,
  });

  const active = currentCount > 0;
  const palette = active
    ? isDuel
      ? "border-cyan-400/60 bg-cyan-500/10 text-cyan-100"
      : "border-fuchsia-400/60 bg-fuchsia-500/10 text-fuchsia-100"
    : "border-white/15 bg-white/[0.03] text-white/70";
  const iconClass = active
    ? isDuel
      ? "text-cyan-300"
      : "text-fuchsia-300"
    : "text-white/40";
  const Icon = isDuel ? IconCards : IconPuzzle;

  return (
    <span
      data-testid={`competitive-streak-${gameKey}`}
      data-game-key={gameKey}
      role="img"
      aria-label={aria}
      title={aria}
      className={`inline-flex max-w-full items-center gap-2 rounded-lg border px-2.5 py-1.5 align-middle ${palette} ${className}`}
    >
      <Icon size={16} stroke={2} aria-hidden="true" className={`shrink-0 ${iconClass}`} />
      <span className="flex min-w-0 flex-col leading-tight">
        <span className="truncate text-[11px] font-black uppercase tracking-[0.14em]">
          {label}
        </span>
        <span className="flex flex-wrap items-center gap-x-1 text-[11px] font-semibold">
          <span className={active ? "" : "text-white/50"}>{currentText}</span>
          <span aria-hidden="true" className="text-white/25">
            ·
          </span>
          <span>{bestText}</span>
        </span>
      </span>
    </span>
  );
}
