"use client";

// src/hooks/useDailyStreak.ts
//
// The daily streak's client state, shared by the home-page streak card and the
// /rewards milestone card so both surfaces render the same server truth.
//
// READ-ONLY. The server credits a streak day when the player FINISHES A GAME
// (src/lib/streaks/server.ts → updateDailyStreak); this hook only reads
// `GET /api/user/daily-streak`. It never posts, never claims and never derives
// a milestone: the endpoint returns the title, next milestone, remaining days
// and the full milestone list computed by the existing streak-title utility.
//
// A read fires once Clerk has resolved the session, and again when the tab
// regains focus/visibility or a bfcache restore brings the page back — a game
// finished in another tab must be reflected without a reload.

import { useCallback, useEffect, useState } from "react";
import { useUser } from "@clerk/nextjs";

export type StreakMilestone = {
  days: number;
  title: string;
  achieved: boolean;
  isNext: boolean;
};

export type DailyStreakStatus = {
  current: number;
  best: number;
  weeklyCurrent: number;
  weeklyBest: number;
  title: string | null;
  nextMilestone: { days: number; title: string } | null;
  daysRemaining: number;
  progress: number;
  milestones: StreakMilestone[];
  lastCompletedDate: string | null;
  shieldAvailable: boolean;
};

export type UseDailyStreak = {
  /** True once Clerk has resolved the session (signed in OR out). */
  isLoaded: boolean;
  isSignedIn: boolean;
  streak: DailyStreakStatus | null;
  loading: boolean;
  error: string | null;
  /** Re-read the streak from the server. */
  load: () => Promise<void>;
};

export function useDailyStreak(): UseDailyStreak {
  const { isLoaded, isSignedIn } = useUser();
  const [streak, setStreak] = useState<DailyStreakStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // `no-store` is required: the shared CsrfFetchGuard caches GET /api/*
      // responses for two seconds, and a streak read straight after a finished
      // game must show the day that game just credited.
      const res = await fetch("/api/user/daily-streak", { cache: "no-store" });
      const json = await res.json().catch(() => null);
      if (res.ok && json?.success) {
        setStreak(json as DailyStreakStatus);
      } else {
        setError("We couldn't load your streak.");
      }
    } catch {
      setError("We couldn't load your streak.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isLoaded) return;
    if (!isSignedIn) {
      setLoading(false);
      return;
    }
    void load();
  }, [isLoaded, isSignedIn, load]);

  useEffect(() => {
    if (!isLoaded || !isSignedIn) return;

    const refresh = () => {
      void load();
    };
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) refresh();
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") refresh();
    };

    window.addEventListener("pageshow", onPageShow);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [isLoaded, isSignedIn, load]);

  return {
    isLoaded,
    isSignedIn,
    streak,
    loading,
    error,
    load,
  };
}
