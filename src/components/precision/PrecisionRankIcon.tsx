"use client";

// ── Precision rank icon ─────────────────────────────────────────────────
//
// Maps a Precision rank LABEL to a Tabler icon so the rank badges render
// with the same crisp vector icons as the rest of the app instead of the
// old emoji glyphs (        ). The `emoji` field on
// `PrecisionRank` is kept in `lib/precision/utils.ts` as display data for
// any non-React consumers; this component is the single renderer.

import {
  IconAlertTriangle,
  IconCircleCheck,
  IconDiamond,
  IconFlame,
  IconSparkles,
  IconStar,
  IconTarget,
  IconThumbUp,
  IconX,
} from "@tabler/icons-react";

export function PrecisionRankIcon({
  label,
  size = 14,
  className = "",
}: {
  label: string;
  size?: number;
  className?: string;
}) {
  switch (label) {
    case "PERFECT":
      return <IconSparkles size={size} className={className} />;
    case "LEGENDARY":
      return <IconDiamond size={size} className={className} />;
    case "MASTERFUL":
      return <IconFlame size={size} className={className} />;
    case "EXCELLENT":
      return <IconStar size={size} className={className} />;
    case "GREAT":
      return <IconCircleCheck size={size} className={className} />;
    case "GOOD":
      return <IconThumbUp size={size} className={className} />;
    case "FAIR":
      return <IconTarget size={size} className={className} />;
    case "CLOSE":
      return <IconAlertTriangle size={size} className={className} />;
    case "MISS":
      return <IconX size={size} className={className} />;
    default:
      return null;
  }
}
