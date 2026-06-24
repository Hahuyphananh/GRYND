// ── Shared utilities for the Precision PvP casino game ──────────────────
//
// Pure functions only — no React, no fetch — so they can be imported from
// both client and server contexts. Helpers related to gameplay logic
// should live in `engine.ts` instead.

import {
  DEFAULT_WAGER,
  MAX_WAGER,
  MIN_WAGER,
  RESULT_POPUP_REPLAY_WINDOW_MS,
} from "./constants";
import type {
  PrecisionEndPopupState,
  PrecisionEndReason,
  PrecisionPlayer,
} from "./types";

export function clampWager(value: number): number {
  if (Number.isNaN(value)) return DEFAULT_WAGER;
  return Math.max(MIN_WAGER, Math.min(MAX_WAGER, Math.floor(value)));
}

export function formatTokens(value: number): string {
  return Number(value || 0).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function isPlayerReady(player: PrecisionPlayer | null | undefined): boolean {
  return !!player?.isReady;
}

export function isBothReady(players: PrecisionPlayer[]): boolean {
  return players.length >= 2 && players.every((p) => p.isReady && p.isConnected);
}

/** Returns the seconds remaining on the end-popup replay window. */
export function getReplaySecondsLeft(openedAt: number, now: number = Date.now()): number {
  const remainingMs = openedAt + RESULT_POPUP_REPLAY_WINDOW_MS - now;
  return Math.max(0, Math.ceil(remainingMs / 1000));
}

export function endReasonToLabel(reason: PrecisionEndReason): string {
  switch (reason) {
    case "completed":
      return "Match complete";
    case "resigned":
      return "Resigned";
    case "timeout":
      return "Turn expired";
    case "disconnect":
      return "Opponent disconnected";
    case "forfeit":
      return "Lobby cancelled";
    default:
      return "Match ended";
  }
}

export function makeInitialEndPopupState(
  result: PrecisionEndPopupState["result"],
  reason: PrecisionEndPopupState["reason"],
  payout: number,
  opponentName?: string,
  extras?: Partial<
    Pick<
      PrecisionEndPopupState,
      "winnerName" | "finalScore" | "prizeMultiplier" | "wager"
    >
  >,
): PrecisionEndPopupState {
  return {
    result,
    reason,
    openedAt: Date.now(),
    payout,
    opponentName,
    winnerName: extras?.winnerName ?? null,
    finalScore: extras?.finalScore ?? null,
    prizeMultiplier: extras?.prizeMultiplier,
    wager: extras?.wager,
  };
}

// ── Precision ranking system ──────────────────────────────────────────
//
// Ranks are assigned based on |elapsedMs - targetMs| — how close the
// player landed to the server-rolled target. The thresholds are
// designed so sub-10ms precision sits at the top (PERFECT / LEGENDARY)
// and >100ms is a MISS. Used by both the solo test summary and the
// per-round reveal panel.

export interface PrecisionRank {
  label: string;
  emoji: string;
  color: string;    // Tailwind text color class
  bg: string;        // Tailwind bg color class
  border: string;    // Tailwind border color class
}

/** Ordered highest→lowest — iterate to find the first match. */
export const PRECISION_RANK_ENTRIES: { maxDiffMs: number; rank: PrecisionRank }[] = [
  {
    maxDiffMs: 0,
    rank: { label: "PERFECT", emoji: "🌟", color: "text-yellow-300", bg: "bg-yellow-400/15", border: "border-yellow-400/50" },
  },
  {
    maxDiffMs: 3,
    rank: { label: "LEGENDARY", emoji: "💎", color: "text-purple-300", bg: "bg-purple-500/15", border: "border-purple-400/50" },
  },
  {
    maxDiffMs: 8,
    rank: { label: "MASTERFUL", emoji: "🔥", color: "text-red-300", bg: "bg-red-500/15", border: "border-red-400/50" },
  },
  {
    maxDiffMs: 15,
    rank: { label: "EXCELLENT", emoji: "⭐", color: "text-yellow-400", bg: "bg-yellow-500/15", border: "border-yellow-400/40" },
  },
  {
    maxDiffMs: 25,
    rank: { label: "GREAT", emoji: "✅", color: "text-green-300", bg: "bg-green-500/15", border: "border-green-400/50" },
  },
  {
    maxDiffMs: 40,
    rank: { label: "GOOD", emoji: "👍", color: "text-blue-300", bg: "bg-blue-500/15", border: "border-blue-400/50" },
  },
  {
    maxDiffMs: 60,
    rank: { label: "FAIR", emoji: "🎯", color: "text-cyan-300", bg: "bg-cyan-500/15", border: "border-cyan-400/50" },
  },
  {
    maxDiffMs: 100,
    rank: { label: "CLOSE", emoji: "⚠️", color: "text-orange-300", bg: "bg-orange-500/15", border: "border-orange-400/50" },
  },
  {
    maxDiffMs: Infinity,
    rank: { label: "MISS", emoji: "❌", color: "text-gray-400", bg: "bg-gray-500/15", border: "border-gray-400/40" },
  },
];

/** Map a diff (|elapsedMs - targetMs|) to its rank tier. Never returns null. */
export function diffToRank(diffMs: number): PrecisionRank {
  const entry = PRECISION_RANK_ENTRIES.find((e) => diffMs <= e.maxDiffMs);
  return entry?.rank ?? PRECISION_RANK_ENTRIES[PRECISION_RANK_ENTRIES.length - 1].rank;
}

/** All rank tier labels in display order (best → worst). */
export const RANK_LABELS = PRECISION_RANK_ENTRIES.map((e) => e.rank.label);
