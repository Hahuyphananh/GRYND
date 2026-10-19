"use client";

// src/lib/practiceWinClient.ts
//
// The browser half of the client-settled practice win (see
// src/lib/practiceWin.ts and src/app/api/practice/win/route.ts).
//
// `reportPracticeWin` POSTs the terminal result once, then announces it:
// every mounted daily-reward surface re-reads `/api/rewards/daily`, so the
// corner widget flips from "Win a match to unlock" to "Claim day N" without a
// page reload. `notifyDailyRewardWin` is also exported on its own so a
// server-settled AI result can announce itself without re-posting anything.
//
// The announcement uses two transports on purpose:
//   * a window event, for surfaces mounted in this tab;
//   * a localStorage write, because the browser fires `storage` in the OTHER
//     tabs of the same origin — so a hub page left open while the game ran in a
//     second tab updates too.
// `useDailyReward` also re-reads on `pageshow` (a bfcache restore does not
// remount React) and when the tab regains focus.

import type { ClientSettledPracticeGame } from "./practiceWin";

/** Fired on `window` after an AI/practice win. */
export const DAILY_REWARD_WIN_EVENT = "grynd:daily-reward-win";

/** localStorage key read by the `storage` listener in useDailyReward. */
export const DAILY_REWARD_WIN_STORAGE_KEY = "grynd.dailyReward.win.v1";

export type { ClientSettledPracticeGame };

/**
 * Tell every mounted reward surface to re-read its status. Safe to call from
 * anywhere in the browser; a no-op on the server.
 */
export function notifyDailyRewardWin(): void {
  if (typeof window === "undefined") return;

  try {
    window.dispatchEvent(new Event(DAILY_REWARD_WIN_EVENT));
  } catch {
    // Dispatch unavailable — the next focus/pageshow still re-reads.
  }

  try {
    // A fresh value every time: localStorage does not fire `storage` in other
    // tabs when the value is unchanged.
    window.localStorage.setItem(
      DAILY_REWARD_WIN_STORAGE_KEY,
      `${Date.now()}:${Math.random()}`,
    );
  } catch {
    // Storage unavailable (private mode) — the window event still covers this
    // tab, and focus/pageshow cover a return to the other one.
  }
}

/**
 * Report a terminal win in a client-settled practice mode. Best-effort: a
 * failed request simply leaves today's reward locked, exactly as if the game
 * had not been played, and never throws into the game's result path.
 *
 * Returns true when the server accepted the marker and the refresh was
 * announced. Callers ignore the value; it exists so a future surface can retry.
 */
export async function reportPracticeWin(
  game: ClientSettledPracticeGame,
): Promise<boolean> {
  try {
    const res = await fetch("/api/practice/win", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ game }),
      keepalive: true,
    });
    const json = await res.json().catch(() => null);
    if (res.ok && json?.success === true) {
      notifyDailyRewardWin();
      return true;
    }
  } catch {
    // Network failure — the game is already over and must not be disturbed.
  }
  return false;
}
