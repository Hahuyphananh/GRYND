"use client";

// src/hooks/usePracticePause.ts
//
// The client half of the free-play pause. A vs-AI match page calls this with
// its game key and match id; the hook reads the authoritative pause row, sends
// toggles, and reports `paused` so the page can stop polling, pause its bot
// heartbeat and render the overlay.
//
// The match page must also pass `paused` into every timer/AI effect: the server
// refuses AI work for a paused match, but the UI still has to stop asking.

import { useCallback, useEffect, useRef, useState } from "react";
import type { PracticePauseGame } from "../lib/practicePauseKeys";

type Options = {
  game: PracticePauseGame;
  matchId: string | number | null | undefined;
  /** Only call for a vs-AI match; a PvP page pays nothing. */
  enabled: boolean;
  /**
   * A bot match that lives entirely in the browser (Hex Duel's `/game/ai`).
   * There is no server row to freeze, so the toggle is local and no request
   * leaves the page; stopping the page's own AI loop IS the freeze.
   */
  local?: boolean;
  /** Called after a successful resume, before the page re-reads the board. */
  onResume?: () => void;
  /** Called immediately after a successful pause. */
  onPause?: () => void;
};

export type PracticePause = {
  paused: boolean;
  busy: boolean;
  /** False until the first read lands (or immediately when disabled). */
  ready: boolean;
  /** True on a live vs-AI match page — the control should be rendered. */
  canPause: boolean;
  /** `paused`, readable synchronously inside async handlers and AI timers. */
  pausedRef: React.MutableRefObject<boolean>;
  toggle: () => Promise<void>;
  togglePause: () => Promise<void>;
};

const ENDPOINT = "/api/practice/pause";

export function usePracticePause({
  game,
  matchId,
  enabled,
  local = false,
  onResume,
  onPause,
}: Options): PracticePause {
  const [paused, setPaused] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(!enabled);
  const id = matchId == null ? "" : String(matchId);
  const active = Boolean(enabled && id);
  const serverBacked = active && !local;
  // Read by async handlers/timers that must not wait a render to see a pause.
  const pausedRef = useRef(false);

  const applyPaused = useCallback((next: boolean) => {
    pausedRef.current = next;
    setPaused(next);
  }, []);

  const resumeRef = useRef(onResume);
  const pauseRef = useRef(onPause);
  useEffect(() => {
    resumeRef.current = onResume;
    pauseRef.current = onPause;
  });

  // Reset when the page moves to another match, so one match's pause can never
  // leak into the next one.
  useEffect(() => {
    pausedRef.current = false;
    setPaused(false);
    setBusy(false);
    setReady(local ? active : !active);
  }, [active, game, id, local]);

  const read = useCallback(async () => {
    if (!serverBacked) return;
    try {
      const res = await fetch(
        `${ENDPOINT}?game=${encodeURIComponent(game)}&matchId=${encodeURIComponent(id)}`,
        { cache: "no-store" },
      );
      if (!res.ok) return;
      const data = await res.json().catch(() => ({}));
      applyPaused(Boolean(data?.paused));
    } finally {
      setReady(true);
    }
  }, [serverBacked, game, id, applyPaused]);

  useEffect(() => {
    if (!serverBacked) {
      if (local && active) setReady(true);
      return undefined;
    }
    void read();
    const onVisibility = () => {
      if (document.visibilityState === "visible") void read();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [active, local, read, serverBacked]);

  const toggle = useCallback(async () => {
    if (!active || busy) return;
    if (local) {
      const next = !paused;
      applyPaused(next);
      if (next) pauseRef.current?.();
      else resumeRef.current?.();
      return;
    }
    setBusy(true);
    try {
      const next = !paused;
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ game, matchId: id, paused: next }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) return;
      applyPaused(next);
      if (next) pauseRef.current?.();
      else resumeRef.current?.();
    } finally {
      setBusy(false);
    }
  }, [active, busy, game, id, local, paused, applyPaused]);

  return {
    paused,
    busy,
    ready,
    canPause: active && ready,
    pausedRef,
    toggle,
    togglePause: toggle,
  };
}

export default usePracticePause;
