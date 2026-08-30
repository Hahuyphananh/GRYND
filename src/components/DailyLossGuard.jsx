"use client";

// src/components/DailyLossGuard.jsx
//
// Responsible-play guard (soft version — warn, never block).
//
// On mount it fetches today's settled bets from /api/get-bet-history?since=…
// (the route's `since` param filters every game table at the SQL level, and
// each bet carries its `tokenDiff` net), sums them, and:
//
//   * over DAILY_LOSS_WARNING_THRESHOLD → shows a warning modal the player
//     must acknowledge once per day ("I understand — keep playing"). The
//     acknowledgment is remembered in localStorage keyed by UTC date, so it
//     doesn't nag every render but re-asks the next day.
//   * over DAILY_LOSS_CHIP_THRESHOLD → shows a subtle "Down X today" chip
//     so the bleed is visible even before the warning level.
//
// It never blocks play — purely informational, per the soft-cap design.

import { useEffect, useState, useCallback } from "react";
import {
  DAILY_LOSS_WARNING_THRESHOLD,
  DAILY_LOSS_CHIP_THRESHOLD,
} from "../lib/games/economy";
import { IconAlertTriangle, IconX } from "@tabler/icons-react";

// The player's own setting (0 = warnings off) wins over the global default.
// Mirrors /api/user/daily-loss-limit semantics: null → global, 0 → off.
const GLOBAL_DEFAULT_LIMIT = DAILY_LOSS_WARNING_THRESHOLD;

function startOfTodayUtcIso() {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

function ackKey() {
  return `daily-loss-ack:${startOfTodayUtcIso().slice(0, 10)}`;
}

/** Rough $ equivalent at the ~1,000 tokens/$ economy anchor. */
function usdValue(tokens) {
  return Math.max(0, Math.floor(tokens / 1000));
}

export default function DailyLossGuard({ children }) {
  const [dailyNet, setDailyNet] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [showWarning, setShowWarning] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Custom per-player limit (may be null/0) + today's net, in parallel.
        const [betsRes, limitRes] = await Promise.all([
          fetch(
            `/api/get-bet-history?since=${encodeURIComponent(startOfTodayUtcIso())}`,
            { cache: "no-store" },
          ),
          fetch("/api/user/daily-loss-limit", { cache: "no-store" }),
        ]);
        const [data, limitData] = await Promise.all([
          betsRes.json(),
          limitRes.json().catch(() => ({ success: false })),
        ]);
        if (cancelled || !data?.success || !Array.isArray(data.bets)) return;

        const customLimit = limitData?.success ? limitData.limit : null;
        // null → global default; 0 → warnings disabled; > 0 → custom.
        const threshold =
          customLimit === 0
            ? Number.POSITIVE_INFINITY
            : typeof customLimit === "number" && customLimit > 0
              ? customLimit
              : GLOBAL_DEFAULT_LIMIT;

        const net = data.bets.reduce(
          (sum, b) => sum + (Number(b?.tokenDiff) || 0),
          0,
        );
        setDailyNet(net);
        setLoaded(true);
        if (net < -threshold) {
          let acked = false;
          try {
            acked = localStorage.getItem(ackKey()) === "1";
          } catch {
            // localStorage unavailable — still warn
          }
          if (!acked) setShowWarning(true);
        }
      } catch {
        // offline / auth failure — guard simply stays quiet
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const acknowledge = useCallback(() => {
    try {
      localStorage.setItem(ackKey(), "1");
    } catch {
      // ignore
    }
    setShowWarning(false);
  }, []);

  const loss = -dailyNet;
  const showChip = loaded && loss > DAILY_LOSS_CHIP_THRESHOLD && !showWarning;

  return (
    <>
      {children}

      {showWarning && (
        <div
          className="fixed inset-0 z-[200] flex items-center justify-center bg-black/80 px-4 py-6 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-label="Responsible play warning"
        >
          <div className="relative w-full max-w-md overflow-hidden rounded-3xl border-2 border-red-500/50 bg-gradient-to-b from-[#16040a] to-[#040d24] p-6 shadow-[0_0_60px_rgba(239,68,68,0.25)]">
            <div className="absolute left-0 top-0 h-[2px] w-full bg-gradient-to-r from-transparent via-red-400 to-transparent" />
            <button
              type="button"
              onClick={acknowledge}
              aria-label="Dismiss warning"
              className="absolute right-3 top-3 flex h-8 w-8 items-center justify-center rounded-full border border-gray-600/40 text-gray-400 transition hover:border-red-400/60 hover:text-white"
            >
              <IconX size={15} />
            </button>

            <div className="flex items-center gap-2 text-red-300">
              <IconAlertTriangle size={22} />
              <h2 className="text-lg font-black uppercase tracking-wider">
                Big loss today
              </h2>
            </div>

            <p className="mt-4 text-sm leading-relaxed text-white/80">
              You're down{" "}
              <span className="font-bold text-red-300">
                {loss.toLocaleString()} tokens
              </span>{" "}
              (≈ ${usdValue(loss)}) today. That's a lot — consider taking a
              break or setting a smaller budget.
            </p>

            <button
              type="button"
              onClick={acknowledge}
              className="mt-5 w-full rounded-xl border-b-4 border-red-800 bg-red-500 px-4 py-2.5 text-sm font-extrabold text-black transition hover:brightness-110"
            >
              I understand — keep playing
            </button>
          </div>
        </div>
      )}

      {showChip && (
        <div className="fixed left-1/2 top-20 z-[150] -translate-x-1/2 rounded-full border border-amber-400/40 bg-black/70 px-4 py-1.5 text-xs font-bold text-amber-300 shadow-[0_0_18px_rgba(245,255,59,0.15)] backdrop-blur-sm">
          Down {loss.toLocaleString()} tokens today
        </div>
      )}
    </>
  );
}
