"use client";

import { useId, type ReactNode } from "react";
import {
  rankForLevel,
  rankForRankKey,
} from "../../lib/playerLevel.js";
import { useTranslation } from "../../hooks/useTranslation";

export type PlayerLevelBadgeSize = "compact" | "standard" | "large";

const SIZE_PX: Record<PlayerLevelBadgeSize, number> = {
  compact: 24,
  standard: 40,
  large: 72,
};

// One shared shield silhouette for all seven tiers. Only the material and the
// inner emblem change, so the set reads as a single collection.
const SHIELD =
  "M32 3 57 12v22.5C57 51 46.2 62.1 32 69 17.8 62.1 7 51 7 34.5V12Z";
const INNER_SHIELD =
  "M32 9 51 16v18.5C51 46.7 42.9 55.9 32 61.9 21.1 55.9 13 46.7 13 34.5V16Z";

function rankTierFor(level: number, rankKey?: string) {
  return rankKey ? rankForRankKey(rankKey) : rankForLevel(level);
}

/** The tier-specific inner emblem. No text, letters, numbers or watermarks. */
function RankEmblemGlyph({
  rankKey,
  metal,
  accent,
}: {
  rankKey: string;
  metal: string;
  accent: string;
}): ReactNode {
  const stroke = { fill: "none", stroke: metal, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

  switch (rankKey) {
    case "rookie":
      return (
        <g {...stroke} strokeWidth="3">
          <path d="M21 35 32 27l11 8" />
          <path d="M21 43 32 35l11 8" opacity="0.8" />
          <path d="M21 51 32 43l11 8" opacity="0.6" />
        </g>
      );
    case "contender":
      return (
        <g>
          <g {...stroke} strokeWidth="3">
            <path d="M20 41 32 26l12 15" />
            <path d="M20 49h24" />
            <path d="M24 54h16" opacity="0.7" />
          </g>
          <circle cx="20" cy="34" r="2.2" fill={accent} />
          <circle cx="44" cy="34" r="2.2" fill={accent} />
        </g>
      );
    case "challenger":
      return (
        <g>
          <path
            d="M32 24l3.6 7.4 8.2 1.2-5.9 5.8 1.4 8.1L32 42.7l-7.3 3.8 1.4-8.1-5.9-5.8 8.2-1.2Z"
            fill={metal}
          />
          <g {...stroke} strokeWidth="2" opacity="0.75">
            <path d="M16 38c-2 5 .4 10 5 12" />
            <path d="M48 38c2 5-.4 10-5 12" />
          </g>
        </g>
      );
    case "elite":
      return (
        <g>
          <path d="M32 21 44 36 32 54 20 36Z" fill="none" stroke={metal} strokeWidth="2.6" strokeLinejoin="round" />
          <path d="M32 27v20M25 36h14" stroke={accent} strokeWidth="1.6" opacity="0.9" />
          <circle cx="32" cy="36" r="2.4" fill={metal} />
          <g {...stroke} strokeWidth="2" opacity="0.7">
            <path d="M15 32 9 36l6 4" />
            <path d="M49 32l6 4-6 4" />
          </g>
        </g>
      );
    case "master":
      return (
        <g>
          <path d="M32 19 46 36 32 55 18 36Z" fill="none" stroke={metal} strokeWidth="2.6" strokeLinejoin="round" />
          <path d="M32 25 40 36l-8 11-8-11Z" fill={accent} opacity="0.85" />
          <path d="M32 25v22M24 36h16" stroke="#061225" strokeWidth="1.2" opacity="0.7" />
          <g {...stroke} strokeWidth="1.8" opacity="0.7">
            <path d="M13 30 6 34l7 6" />
            <path d="M51 30l7 4-7 6" />
          </g>
        </g>
      );
    case "grandmaster":
      return (
        <g>
          <path d="M18 45 20 27l8 7 4-11 4 11 8-7 2 18Z" fill={accent} stroke={metal} strokeWidth="2" strokeLinejoin="round" />
          <circle cx="32" cy="38" r="3.4" fill={metal} />
          <path d="M20 49h24" stroke={metal} strokeWidth="2.4" strokeLinecap="round" />
          <path d="M24 54h16" stroke={accent} strokeWidth="2" strokeLinecap="round" opacity="0.8" />
        </g>
      );
    case "legend":
    default:
      return (
        <g>
          <path d="M32 16 36.8 31.2 52 36l-15.2 4.8L32 56l-4.8-15.2L12 36l15.2-4.8Z" fill={metal} />
          <path d="M32 27 33.8 34.2 41 36l-7.2 1.8L32 45l-1.8-7.2L23 36l7.2-1.8Z" fill={accent} />
          <circle cx="32" cy="36" r="13.5" fill="none" stroke={accent} strokeWidth="1.4" opacity="0.65" />
          <circle cx="32" cy="36" r="17.5" fill="none" stroke={metal} strokeWidth="1" opacity="0.35" strokeDasharray="2 3" />
        </g>
      );
  }
}

/**
 * The original GRYND rank emblem. Local SVG only — no remote images, no text.
 */
export function RankEmblem({
  rankKey,
  size = "standard",
  className = "",
  title,
}: {
  rankKey?: string;
  size?: PlayerLevelBadgeSize;
  className?: string;
  title?: string;
}) {
  const tier = rankKey ? rankForRankKey(rankKey) : rankForLevel(1);
  const rawId = useId();
  const uid = rawId.replace(/[^a-zA-Z0-9_-]/g, "");
  const metalId = `grynd-rank-metal-${uid}`;
  const coreId = `grynd-rank-core-${uid}`;
  const glowId = `grynd-rank-glow-${uid}`;
  const px = SIZE_PX[size] ?? SIZE_PX.standard;

  return (
    <svg
      width={px}
      height={px}
      viewBox="0 0 64 72"
      className={className}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      <defs>
        <linearGradient id={metalId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor={tier.metal} />
          <stop offset="55%" stopColor={tier.accent} />
          <stop offset="100%" stopColor={tier.deep} />
        </linearGradient>
        <linearGradient id={coreId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#0b1c3a" />
          <stop offset="100%" stopColor="#04101f" />
        </linearGradient>
        <radialGradient id={glowId} cx="50%" cy="38%" r="62%">
          <stop offset="0%" stopColor={tier.accent} stopOpacity="0.42" />
          <stop offset="100%" stopColor={tier.accent} stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* Glow */}
      <ellipse cx="32" cy="33" rx="30" ry="33" fill={`url(#${glowId})`} />

      {/* Shield body */}
      <path d={SHIELD} fill="#061225" stroke={tier.accent} strokeWidth="2.4" strokeLinejoin="round" />
      <path d={INNER_SHIELD} fill={`url(#${coreId})`} stroke={`url(#${metalId})`} strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M14 18 32 11l18 7" fill="none" stroke={tier.metal} strokeWidth="1.6" opacity="0.55" strokeLinecap="round" />

      {/* Tier emblem */}
      <RankEmblemGlyph rankKey={tier.key} metal={tier.metal} accent={tier.accent} />

      {/* Bottom material bar */}
      <path d="M22 59h20" stroke={tier.accent} strokeWidth="1.6" strokeLinecap="round" opacity="0.65" />
    </svg>
  );
}

/**
 * Reusable rank badge + accessible label.
 *
 * compact → usernames and leaderboard rows
 * standard → identity cards
 * large → profile progression / level-up celebrations
 */
export default function PlayerLevelBadge({
  level = 1,
  rankKey,
  size = "compact",
  showLabel = false,
  className = "",
}: {
  level?: number;
  rankKey?: string;
  size?: PlayerLevelBadgeSize;
  showLabel?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const tier = rankTierFor(Number(level) || 1, rankKey);
  const rankName = t(`playerLevel.ranks.${tier.key}`);
  const title = t("playerLevel.badgeTitle", {
    rank: rankName,
    level: Number(level) || 1,
  });

  return (
    <span
      role="img"
      aria-label={title}
      title={title}
      className={`inline-flex min-w-0 items-center gap-1.5 align-middle ${className}`}
    >
      <RankEmblem rankKey={tier.key} size={size} />
      {showLabel && (
        <span className="min-w-0 truncate text-[11px] font-semibold text-[#c9f7ff]">
          {rankName}
          <span className="text-[#9dd8ff]/60">
            {" "}
            · {t("playerLevel.levelShort", { level: Number(level) || 1 })}
          </span>
        </span>
      )}
    </span>
  );
}
