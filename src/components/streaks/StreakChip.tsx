"use client";

// THE STREAK CHIP — the compact `🔥 N` indicator, with the UTC countdown and
// the next cosmetic milestone in its tooltip.
//
// It reads one endpoint (`/api/streaks/me`), which is the server's own state:
// the chip never advances a streak and never decides an unlock. When the account
// has unlocked something the tab has not celebrated yet, it dispatches the
// celebration event the modal listens for — the completion routes do not have to
// know this component exists.

import { useCallback, useEffect, useRef, useState } from "react";
import { useUser } from "@clerk/nextjs";

type StreakPayload = {
  success?: boolean;
  signedIn: boolean;
  streak?: {
    currentStreak: number;
    longestStreak: number;
    prestigePips: number;
    lastCompletedUtcDate: string | null;
    proTrialExpiresAt: string | null;
    unlocks: string[];
    nextMilestone: { day: number; items: string[] } | null;
  };
};

const SEEN_KEY = "grynd.streak.celebrated.v1";

function readSeen(): string[] {
  try {
    const raw = window.localStorage.getItem(SEEN_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function countdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

export default function StreakChip() {
  const { isLoaded, isSignedIn } = useUser();
  const [data, setData] = useState<StreakPayload | null>(null);
  const [open, setOpen] = useState(false);
  const [msLeft, setMsLeft] = useState<number | null>(null);
  const seenRef = useRef<string[] | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/streaks/me", {
        credentials: "same-origin",
        cache: "no-store",
      });
      const body = (await response.json().catch(() => null)) as StreakPayload | null;
      if (body?.success) setData(body);
      const unlocks = body?.streak?.unlocks;
      if (body?.streak && Array.isArray(unlocks)) {
        if (seenRef.current === null) seenRef.current = readSeen();
        const fresh = unlocks.filter((item) => !seenRef.current!.includes(item));
        if (fresh.length > 0) {
          window.dispatchEvent(
            new CustomEvent("grynd:streak-unlocked", {
              detail: { items: fresh, currentStreak: body.streak.currentStreak },
            }),
          );
          seenRef.current = [...seenRef.current, ...fresh];
          try {
            window.localStorage.setItem(SEEN_KEY, JSON.stringify(seenRef.current));
          } catch {
            // Celebration is decoration; storage being full must not break it.
          }
        }
      }
    } catch {
      // Offline: the chip simply keeps its last value.
    }
  }, []);

  useEffect(() => {
    if (!isLoaded || !isSignedIn) return;
    void load();
    const timer = window.setInterval(() => void load(), 60_000);
    const onUpdate = () => void load();
    window.addEventListener("grynd:streak-updated", onUpdate);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("grynd:streak-updated", onUpdate);
    };
  }, [isLoaded, isSignedIn, load]);

  useEffect(() => {
    if (!isSignedIn) return;
    const tick = () => {
      const now = new Date();
      const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
      setMsLeft(Math.max(0, next - now.getTime()));
    };
    tick();
    const timer = window.setInterval(tick, 30_000);
    return () => window.clearInterval(timer);
  }, [isSignedIn]);

  if (!isLoaded || !isSignedIn || !data?.signedIn) return null;
  const streak = data.streak;
  if (!streak) return null;

  const next = streak.nextMilestone;
  const tooltip = [
    `${streak.currentStreak}-day UTC streak`,
    msLeft === null ? "" : `Next credit resets in ${countdown(msLeft)}`,
    next
      ? `Next milestone: Day ${next.day} (${Math.max(0, next.day - streak.currentStreak)} days)`
      : "All bespoke milestones unlocked",
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="relative" data-testid="streak-chip">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        aria-label={tooltip}
        title={tooltip}
        className="flex items-center gap-1 rounded-full border border-amber-300/35 bg-amber-400/10 px-2.5 py-1 text-[11px] font-black text-amber-100 transition hover:bg-amber-400/20"
      >
        <span aria-hidden="true">🔥</span>
        <span>{streak.currentStreak}</span>
        {streak.prestigePips > 0 && (
          <span className="text-[10px] text-amber-200/80">★{streak.prestigePips}</span>
        )}
      </button>

      {open && (
        <div
          role="tooltip"
          className="absolute right-0 top-full z-50 mt-1 w-64 rounded-xl border border-white/12 bg-[#06101f] p-3 text-left text-[11px] leading-relaxed text-white/70 shadow-xl"
        >
          <p className="font-black text-white">{streak.currentStreak}-day UTC streak</p>
          <p className="mt-1 text-white/50">
            Best {streak.longestStreak} · resets 00:00 UTC
            {msLeft === null ? "" : ` · ${countdown(msLeft)} left`}
          </p>
          <p className="mt-2">
            {next
              ? `Next unlock at Day ${next.day} — ${Math.max(0, next.day - streak.currentStreak)} more day(s).`
              : "Every bespoke milestone is unlocked. 30-day loops add prestige pips."}
          </p>
          {streak.proTrialExpiresAt && (
            <p className="mt-1 text-[#f5ff3b]">PRO trial active until {new Date(streak.proTrialExpiresAt).toLocaleString()}</p>
          )}
        </div>
      )}
    </div>
  );
}
