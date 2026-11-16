// src/lib/dailyRewardCycle.ts
//
// The SHAPE of the daily-reward curve, as pure functions — no database, no
// request context, so both the server reward lib and the tests can use it.
//
// Two facts the UI and the payout must agree on:
//
//   * `dailyRewardCycleDay` — which of the 14 curated amounts a streak day is
//     worth. Day 15 is day 1 of the curve again: the fortnight repeats.
//   * `dailyRewardWindow` — the 14 ABSOLUTE streak days the popup shows. On a
//     streak of 16 those are 15–28, not 1–14: the board must name the days the
//     player is actually on, or a long streak looks like it was reset.
//
// Both are functions of the streak day alone, so the read and the claim can
// never disagree about either the amount or the label.

import { DAILY_REWARD_CYCLE } from "./games/economy";

/** Days in one reward cycle. The curve repeats after this many days. */
export const DAILY_REWARD_CYCLE_DAYS = DAILY_REWARD_CYCLE.length;

/**
 * Which day of the 14-day cycle a streak day lands on (1-based). A streak of 1
 * is cycle day 1; a streak of 15 starts the curve over at cycle day 1 — which
 * is the "14 days completed, the 15th day is day 1 again" rule. A non-positive
 * or non-finite streak day is treated as day 1, so a claim can never index the
 * curve out of bounds.
 */
export function dailyRewardCycleDay(streakDay: number): number {
  const day = Math.floor(Number(streakDay));
  if (!Number.isFinite(day) || day < 1) return 1;
  return ((day - 1) % DAILY_REWARD_CYCLE_DAYS) + 1;
}

/**
 * The first ABSOLUTE streak day of the window that contains `streakDay`:
 * 1 for days 1–14, 15 for days 15–28, 29 for days 29–42, and so on.
 */
export function dailyRewardWindowStart(streakDay: number): number {
  const day = Math.floor(Number(streakDay));
  const safe = Number.isFinite(day) && day >= 1 ? day : 1;
  return Math.floor((safe - 1) / DAILY_REWARD_CYCLE_DAYS) * DAILY_REWARD_CYCLE_DAYS + 1;
}

export type DailyRewardWindowDay = {
  /** The absolute streak day (15, 16, … 28). */
  day: number;
  /** What that day pays, from the curated curve. */
  amount: number;
};

/**
 * The 14 days the popup shows for a player on `streakDay`, numbered absolutely
 * and paired with the amount each one pays. The amounts come straight from the
 * curated curve; nothing here invents a payout.
 */
export function dailyRewardWindow(streakDay: number): DailyRewardWindowDay[] {
  const start = dailyRewardWindowStart(streakDay);
  return DAILY_REWARD_CYCLE.map((amount, index) => ({
    day: start + index,
    amount,
  }));
}
