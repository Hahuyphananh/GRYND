"use client";

import PlayerLevelBadge from "./PlayerLevelBadge";
import { rankForRankKey } from "../../lib/playerLevel.js";
import { useTranslation } from "../../hooks/useTranslation";

export type PlayerProgression = {
  level: number;
  rankKey: string;
  maxLevel: number;
  complete: boolean;
  currentTrophies: number;
  peakTrophies: number;
  progressTrophies: number;
  protected: boolean;
  currentLevelTrophies: number;
  nextLevelTrophies: number | null;
  trophiesToNext: number;
  progressPercent: number;
};

/**
 * The profile progression section. Every number comes from the server's
 * trophy-derived progression payload — nothing is recomputed from props the
 * client could edit.
 */
export default function PlayerLevelProgressCard({
  progression,
  className = "",
}: {
  progression: PlayerProgression | null | undefined;
  className?: string;
}) {
  const { t, language } = useTranslation();
  if (!progression) return null;

  const locale =
    language === "fr" ? "fr-FR" : language === "es" ? "es-ES" : "en-US";
  const format = (value: number | null | undefined) =>
    Number(value || 0).toLocaleString(locale);
  const tier = rankForRankKey(progression.rankKey);
  const rankName = t(`playerLevel.ranks.${tier.key}`);
  const nextLevel = progression.level + 1;
  const percent = Math.max(0, Math.min(100, Number(progression.progressPercent) || 0));

  return (
    <section
      aria-label={t("playerLevel.progressionTitle")}
      className={`rounded-xl border border-[#00e5ff]/30 bg-[#0b224f]/85 p-5 shadow-[0_0_24px_rgba(0,229,255,0.12)] ${className}`}
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-4">
          <PlayerLevelBadge
            level={progression.level}
            rankKey={progression.rankKey}
            size="large"
            className="shrink-0"
          />
          <div className="min-w-0">
            <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-[#00e5ff]">
              {t("playerLevel.progressionTitle")}
            </p>
            <h2 className="mt-1 text-2xl font-black uppercase tracking-wide text-white">
              {rankName}{" "}
              <span className="text-[#f5ff3b]">
                — {t("playerLevel.level", { level: progression.level })}
              </span>
            </h2>
            <p className="mt-1 text-sm text-[#9dd8ff]">
              {t("playerLevel.currentTrophies", {
                trophies: format(progression.currentTrophies),
              })}
            </p>
          </div>
        </div>
        <div className="text-left sm:text-right">
          <p className="text-3xl font-black tabular-nums text-white">
            {format(progression.peakTrophies)}
          </p>
          <p className="text-[10px] uppercase tracking-[0.18em] text-[#9dd8ff]/70">
            {t("playerLevel.peakTrophies")}
          </p>
        </div>
      </div>

      <div className="mt-5">
        <div className="flex items-end justify-between gap-3 text-xs font-semibold">
          <span className="text-[#c9f7ff]">
            {progression.complete
              ? t("playerLevel.maxLevel")
              : t("playerLevel.progressLabel", { level: nextLevel })}
          </span>
          <span className="tabular-nums text-[#f5ff3b]">{percent}%</span>
        </div>
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          aria-label={
            progression.complete
              ? t("playerLevel.maxLevel")
              : t("playerLevel.progressLabel", { level: nextLevel })
          }
          className="mt-1.5 h-2.5 w-full overflow-hidden rounded-full border border-white/10 bg-black/40"
        >
          <div
            className="h-full rounded-full transition-[width] duration-500"
            style={{
              width: `${percent}%`,
              background: `linear-gradient(90deg, ${tier.deep}, ${tier.accent} 55%, ${tier.metal})`,
              boxShadow: `0 0 12px ${tier.glow}`,
            }}
          />
        </div>
        {progression.complete ? (
          <p className="mt-2 text-xs text-[#9dd8ff]">
            {t("playerLevel.maxLevelBody")}
          </p>
        ) : (
          <>
            <p className="mt-2 text-xs tabular-nums text-[#c9f7ff]">
              {t("playerLevel.progressNumbers", {
                current: format(progression.progressTrophies),
                next: format(progression.nextLevelTrophies),
              })}
            </p>
            <p className="mt-0.5 text-xs font-semibold text-[#f5ff3b]">
              {t("playerLevel.trophiesToNext", {
                trophies: format(progression.trophiesToNext),
                level: nextLevel,
              })}
            </p>
          </>
        )}
        {progression.protected && !progression.complete && (
          <p className="mt-2 rounded-lg border border-emerald-400/25 bg-emerald-500/10 px-3 py-2 text-[11px] text-emerald-200">
            {t("playerLevel.protected", {
              trophies: format(progression.peakTrophies),
            })}
          </p>
        )}
      </div>
    </section>
  );
}
