"use client";

// src/components/BattlepassClaimBadge.jsx
//
// Navbar nudge for unclaimed battlepass rewards. Rewards are NEVER
// auto-granted — when the player hits a reward level, this component:
//
//   1. Shows a gold count pill next to the /battlepass nav link, and
//   2. Fires a one-time toast ("Battlepass rewards ready") the first time
//      a NEW claimable level appears, linking to the battlepass page.
//
// The toast uses a localStorage watermark of the highest claimable level
// ever seen, so it fires exactly once per advancement (same pattern as the
// Prestige-unlocked notice) and never re-fires after dismissal until the
// player reaches another reward level.

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { IconX } from "@tabler/icons-react";

const STORAGE_KEY = "grynd.battlepass.rewards-notice.v1";
const POLL_MS = 60 * 1000;

export default function BattlepassClaimBadge() {
  const [count, setCount] = useState(0);
  const [maxLevel, setMaxLevel] = useState(0);
  const [notice, setNotice] = useState(null); // claimable level being celebrated
  const pathname = usePathname();
  const inFlightRef = useRef(null);

  const refresh = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = fetch("/api/battlepass/unclaimed", {
      cache: "no-store",
    })
      .then((res) => res.json())
      .catch(() => null)
      .finally(() => {
        inFlightRef.current = null;
      });
    const data = await inFlightRef.current;
    if (!data || !data.success) return;
    setCount(Math.max(0, Number(data.count) || 0));
    const levels = Array.isArray(data.levels)
      ? data.levels.map(Number).filter(Number.isFinite)
      : [];
    setMaxLevel(levels.length ? Math.max(...levels) : 0);
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, POLL_MS);
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(id);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  // One-time toast per advancement: fire only when a claimable level
  // HIGHER than the watermark appears (and not while on the battlepass
  // page itself, which shows its own "rewards ready" chip).
  useEffect(() => {
    if (!maxLevel || !count) return;
    if (pathname && pathname.startsWith("/battlepass")) return;
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      const seen = raw ? Math.max(0, Number(JSON.parse(raw)) || 0) : 0;
      if (maxLevel > seen) {
        setNotice(maxLevel);
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(maxLevel));
      }
    } catch {
      // Storage unavailable — skip the toast; never crash the navbar.
    }
  }, [maxLevel, count, pathname]);

  return (
    <>
      {/* Count pill — sits inside the /battlepass nav link */}
      {count > 0 && (
        <span className="ml-1.5 inline-flex items-center gap-1 rounded-full border border-[#f5ff3b]/70 bg-[#f5ff3b]/20 px-1.5 py-px text-[10px] font-black leading-tight text-[#f5ff3b]">
          <span className="h-1.5 w-1.5 rounded-full bg-[#f5ff3b] shadow-[0_0_6px_rgba(245,255,59,0.8)]" />
          {count}
        </span>
      )}

      {/* Global toast — fixed position, so it works from anywhere */}
      {notice !== null && (
        <div
          role="status"
          aria-live="polite"
          className="fixed right-4 top-24 z-[95] w-[330px] max-w-[calc(100vw-2rem)] rounded-xl border border-[#f5ff3b]/50 bg-[#0b224f]/95 p-4 shadow-[0_0_40px_rgba(245,255,59,0.35)] backdrop-blur"
        >
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-[#f5ff3b]/60 bg-[#f5ff3b]/15 text-lg">
              🎁
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs uppercase tracking-[0.25em] text-[#f5ff3b]">
                Battlepass rewards ready
              </p>
              <p className="mt-0.5 text-sm text-[#9dd8ff]">
                You reached level {notice} — a reward is waiting. Claim it on
                the battlepass before you keep climbing.
              </p>
              <Link
                href="/battlepass"
                onClick={() => setNotice(null)}
                className="mt-2 inline-flex rounded-lg border border-[#00e5ff]/50 bg-[#00e5ff]/15 px-3 py-1.5 text-xs font-semibold text-[#00e5ff] transition hover:bg-[#00e5ff]/25"
              >
                Go to Battlepass
              </Link>
            </div>
            <button
              type="button"
              aria-label="Dismiss"
              onClick={() => setNotice(null)}
              className="text-white/50 transition hover:text-white"
            >
              <IconX size={16} />
            </button>
          </div>
        </div>
      )}
    </>
  );
}