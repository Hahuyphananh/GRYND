"use client";

// src/hooks/usePracticeBotHeartbeat.ts
//
// Keeps a PRACTICE BOT moving while the player watches.
//
// Every opponent-bot store in the platform advances the bot on READ: the read
// route plays the moves the bot has earned by now (Solitaire Duel, Mines Duel,
// Speed Typing, Sudoku Duel, Mini Golf…). That is deliberate — the server owns
// the bot, so nothing about its progress depends on a client calling an
// endpoint — but it has one consequence: a match page that syncs purely
// EVENT-DRIVEN (`useMatchSync`) only reads when the player acts, when the socket
// reconnects or when the tab regains focus. A player who stops acting therefore
// leaves the bot standing still mid-board, and a match whose clock or deadline
// is resolved ON READ is left unresolved with it. That is the "the AI is stuck"
// report: the bot is fine on the server, and frozen on the screen.
//
// This hook is the one exception to the no-polling rule, and it is scoped like
// one: it runs ONLY while the caller says a bot still has a board to play, on a
// visible tab, and it tears itself down the moment that stops being true (or the
// component unmounts). Human duels and finished matches pay nothing.
//
// The read it calls must be the page's own authoritative snapshot loader — the
// same one the socket push and `useMatchSync` call — so a heartbeat can never
// invent state, only observe it sooner.

import { useEffect, useRef } from "react";
import { startVisibleInterval } from "./useVisiblePoll";

/**
 * How often a practice match re-reads while its bot is still playing.
 *
 * Matches the Solitaire Duel practice heartbeat, and sits under the stores'
 * per-read action bursts (8-12 moves), so one read per beat keeps the bot at
 * the pace the server already granted it rather than faster.
 */
export const PRACTICE_BOT_HEARTBEAT_MS = 1_500;

/**
 * Re-read `read` on a visible-tab interval while `enabled`.
 *
 * `read` is held in a ref, so a caller may pass an inline closure without
 * restarting the interval on every render.
 */
export function usePracticeBotHeartbeat(
  enabled: boolean,
  read: () => void | Promise<void>,
  intervalMs: number = PRACTICE_BOT_HEARTBEAT_MS,
): void {
  const readRef = useRef(read);
  useEffect(() => {
    readRef.current = read;
  }, [read]);

  useEffect(() => {
    if (!enabled) return undefined;
    return startVisibleInterval(() => readRef.current(), intervalMs);
  }, [enabled, intervalMs]);
}

export default usePracticeBotHeartbeat;
