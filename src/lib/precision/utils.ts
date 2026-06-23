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
