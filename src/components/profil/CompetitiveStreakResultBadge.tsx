"use client";

// Post-result adapter for the profile badge. It reads the settled competitive
// streak after the result opens. A failed/slow read renders nothing — the
// result screen itself is never blocked, animated or reordered by this chip.

import { useEffect, useState } from "react";

import CompetitiveStreakBadge from "./CompetitiveStreakBadge";
import type { CompetitiveGameKey } from "../../lib/competitiveStreakModel";

export default function CompetitiveStreakResultBadge({
  gameKey,
  enabled = true,
}: {
  gameKey: CompetitiveGameKey;
  enabled?: boolean;
}) {
  const [streak, setStreak] = useState<{ current: number; best: number } | null>(
    null,
  );

  useEffect(() => {
    if (!enabled) {
      setStreak(null);
      return;
    }

    let cancelled = false;
    fetch("/api/streaks/competitive", {
      cache: "no-store",
      credentials: "include",
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => {
        if (cancelled) return;
        const value = body?.streaks?.[gameKey];
        setStreak({
          current: Math.max(0, Number(value?.current) || 0),
          best: Math.max(0, Number(value?.best) || 0),
        });
      })
      .catch(() => {
        // The result stays complete without this optional chip.
      });

    return () => {
      cancelled = true;
    };
  }, [enabled, gameKey]);

  if (!enabled || !streak) return null;

  return (
    <CompetitiveStreakBadge
      gameKey={gameKey}
      current={streak.current}
      best={streak.best}
    />
  );
}
