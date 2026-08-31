"use client";

// src/lib/creator-mode/CreatorModeProvider.jsx
//
// Shared Creator Mode context for a game page. Owns:
//   • the creator-mode flag passed from the lobby (URL ?creator=1 and/or
//     sessionStorage, so lobby → game → match-page navigations keep it)
//   • the selected recording dimensions (9:16 / 16:9 / 1:1 / custom),
//     stored in Creator Mode state + persisted per user
//   • the dedicated recording viewport: when creator mode is ON the game
//     children render inside a fixed-size frame whose dimensions match
//     the selected output — CSS-scaled to fit the screen while capture
//     runs at full logical size
//   • the 3 → 2 → 1 countdown before recording begins (pure UI — the
//     game stays fully playable, nothing in game logic is touched)
//   • the single in-page viewport recorder + automatic lifecycle:
//     start when the game actually starts (`autoStart`), stop when it
//     ends or the user quits (`autoStop` / unmount)
//
// Games integrate through <CreatorModeHost /> — they never talk to the
// recorder directly, so one implementation serves every game.

import React, {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useUser } from "@clerk/nextjs";
import { useCreatorRecorder } from "./useCreatorRecorder";
import { useCreatorModeAccess } from "./useCreatorModeAccess";
import {
  getStoredCreatorDimensions,
  getStoredCreatorMode,
  isCreatorModeSearch,
  setStoredCreatorDimensions,
  setStoredCreatorMode,
} from "./client";
import {
  DEFAULT_AUTO_STOP_DELAY_MS,
  DEFAULT_CREATOR_DIMENSIONS,
  DIMENSION_PRESETS,
  sanitizeDimensions,
} from "./types";

const CreatorModeContext = createContext({
  // Canonical lifecycle names (see CreatorModeLifecycle in ./types).
  creatorModeEnabled: false,
  recordingDimensions: DEFAULT_CREATOR_DIMENSIONS,
  gameStarted: () => {},
  gameFinished: () => {},
  gameQuit: () => {},
  startCreatorRecording: () => {},
  stopCreatorRecording: () => {},
  // Backwards-compatible aliases used by the overlay.
  isCreatorMode: false,
  enabled: false,
  state: "idle",
  error: null,
  lastResult: null,
  supported: false,
  isRecording: false,
  sourceModeUsed: null,
  countdown: null,
  dimensions: DEFAULT_CREATOR_DIMENSIONS,
  gameEnded: false,
  selectPreset: () => {},
  applyCustomDimensions: () => {},
  start: () => {},
  stop: () => {},
  discard: () => {},
  download: () => null,
});

export function useCreatorMode() {
  return useContext(CreatorModeContext);
}

/**
 * Provider for one game page. Owns the shared Creator Mode lifecycle:
 * recording starts on the REAL game start (autoStart), and when the
 * game reaches its normal completed state (autoStop) recording keeps
 * running for `autoStopDelayMs` so the result/winner animation is
 * captured, then stops. Quitting (unmount) stops immediately.
 *
 * Games integrate through <CreatorModeHost /> — they never talk to the
 * recorder directly, so one implementation serves every game.
 *
 * @param {boolean} autoStart       — flip to true when the actual game starts
 * @param {boolean} autoStop        — flip to true when the game ends (result state)
 * @param {number}  autoStopDelayMs — keep recording this long after the game
 *                                    ends to capture the result/winner animation
 * @param {string}  gameLabel       — used for the downloaded filename
 * @param {React.ReactNode} children
 */
export default function CreatorModeProvider({
  autoStart = false,
  autoStop = false,
  autoStopDelayMs = DEFAULT_AUTO_STOP_DELAY_MS,
  gameLabel = "game",
  children,
}) {
  const { user } = useUser();
  const recorder = useCreatorRecorder();
  // Server-backed access gate: even a hand-crafted ?creator=1 URL never
  // activates creator mode UI for a user the server doesn't grant access
  // to (admin today, approved creators later).
  const { canUseCreatorMode, loading: accessLoading } = useCreatorModeAccess();

  // ── Mode flag (URL param canonical, sessionStorage fallback) ─────
  const [enabled, setEnabled] = useState(false);
  const resolvedRef = useRef(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (accessLoading) return;
    if (resolvedRef.current) return;
    resolvedRef.current = true;
    if (!canUseCreatorMode) return;
    const fromUrl = isCreatorModeSearch(window.location.search);
    const fromStorage = getStoredCreatorMode(user?.id);
    const on = fromUrl || fromStorage;
    setEnabled(on);
    if (on && fromUrl) {
      setStoredCreatorMode(user?.id, true);
    }
  }, [user?.id, canUseCreatorMode, accessLoading]);

  // ── Recording output dimensions (Creator Mode state) ─────────────
  const [dimensions, setDimensionsState] = useState(DEFAULT_CREATOR_DIMENSIONS);
  const dimensionsResolvedRef = useRef(false);

  useEffect(() => {
    if (typeof window === "undefined" || dimensionsResolvedRef.current) return;
    dimensionsResolvedRef.current = true;
    setDimensionsState(getStoredCreatorDimensions(user?.id));
  }, [user?.id]);

  const selectPreset = (preset) => {
    if (!["9:16", "16:9", "1:1"].includes(preset)) return;
    const p = DIMENSION_PRESETS[preset];
    const next = { preset, width: p.width, height: p.height };
    setDimensionsState(next);
    setStoredCreatorDimensions(user?.id, next);
  };

  const applyCustomDimensions = (width, height) => {
    const { width: w, height: h } = sanitizeDimensions(width, height);
    if (w <= 0 || h <= 0) return;
    const next = { preset: "custom", width: w, height: h };
    setDimensionsState(next);
    setStoredCreatorDimensions(user?.id, next);
  };

  // ── Recording viewport frame (scaled to fit the screen) ──────────
  const frameRef = useRef(null);
  const [scale, setScale] = useState(1);

  useLayoutEffect(() => {
    if (!enabled) return;
    const compute = () => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const s = Math.min(1, (vw - 48) / dimensions.width, (vh - 220) / dimensions.height);
      setScale(Math.max(0.15, s));
    };
    compute();
    window.addEventListener("resize", compute);
    return () => window.removeEventListener("resize", compute);
  }, [enabled, dimensions.width, dimensions.height]);

  // Stop recording if creator mode gets disabled mid-game.
  useEffect(() => {
    if (!enabled && recorder.isRecording) stopCreatorRecording();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, recorder.isRecording]);

  // ── 3 → 2 → 1 countdown, then capture ────────────────────────────
  // True once the game reached its completed/result state (autoStop).
  // Lets the result panel decide whether "Record another game" should
  // start capturing immediately (game still live) or just re-arm for the
  // next match (game over).
  const [gameEnded, setGameEnded] = useState(false);

  const [countdown, setCountdown] = useState(null);
  const countdownTimerRef = useRef(null);
  const dimensionsRef = useRef(dimensions);
  useEffect(() => {
    dimensionsRef.current = dimensions;
  }, [dimensions]);

  const cancelCountdown = () => {
    if (countdownTimerRef.current) {
      clearInterval(countdownTimerRef.current);
      countdownTimerRef.current = null;
    }
    setCountdown(null);
  };

  useEffect(() => {
    return () => cancelCountdown();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Begin the recording flow: 3→2→1 countdown, then in-page capture. */
  const start = () => {
    if (!enabled || recorder.isRecording) return;
    // A fresh game/session is starting — the previous one has ended, so
    // cancel any stop (pending OR already-scheduled) from the previous
    // session so it can't cut the new recording short.
    setGameEnded(false);
    pendingStopRef.current = null;
    cancelScheduledStop();
    cancelCountdown();
    const dims = dimensionsRef.current;
    setCountdown(3);
    let n = 3;
    countdownTimerRef.current = setInterval(() => {
      n -= 1;
      if (n <= 0) {
        cancelCountdown();
        const container = frameRef.current;
        if (container) {
          // Capture begins after the probe resolves (async). If the game
          // already reached its result while the countdown was running
          // (a fast game — gameFinished() stored a pending stop because
          // recording hadn't begun yet), apply that stopped delay now so
          // the just-started recording still auto-stops. This prevents a
          // recording from running forever on a game that ends very
          // quickly / resolves during the countdown.
          recorder.start({
            container,
            width: dims.width,
            height: dims.height,
          }).then((ok) => {
            if (ok && pendingStopRef.current != null) {
              const delay = pendingStopRef.current;
              pendingStopRef.current = null;
              scheduleStop(delay);
            }
          });
        } else {
          recorder.cancel();
        }
      } else {
        setCountdown(n);
      }
    }, 1000);
  };

  // ── Canonical lifecycle API (see CreatorModeLifecycle in types.ts) ─
  //
  // gameStarted / startCreatorRecording → countdown, then capture.
  // gameFinished → keep recording briefly (autoStopDelayMs) so the
  //   result/winner animation is captured, then stop.
  // gameQuit / stopCreatorRecording → stop NOW (user quit / manual).

  // Pending delayed stop scheduled by gameFinished(). Cancelled if the
  // game somehow starts again, the user quits, or the page unmounts.
  const stopTimerRef = useRef(null);
  const cancelScheduledStop = () => {
    if (stopTimerRef.current) {
      clearTimeout(stopTimerRef.current);
      stopTimerRef.current = null;
    }
  };

  /** Schedule the delayed auto-stop once recording is actually running. */
  const scheduleStop = (delayMs) => {
    cancelScheduledStop();
    const delay = Math.max(0, Number.isFinite(delayMs) ? delayMs : 0);
    stopTimerRef.current = setTimeout(() => {
      stopTimerRef.current = null;
      if (recorder.isRecording) recorder.stop();
    }, delay);
  };

  // If the game reaches its result BEFORE capture actually begins (e.g.
  // it ends during the 3s countdown, or the page loads already ended), we
  // can't schedule the recorder timeout yet (nothing is recording). Stash
  // the desired stop delay here and apply it in `start()` once capture
  // `recorder.start()` resolves, so a fast game never records forever.
  const pendingStopRef = useRef(null);

  const stopCreatorRecording = () => {
    cancelCountdown();
    cancelScheduledStop();
    pendingStopRef.current = null;
    if (recorder.isRecording) recorder.stop();
  };

  /** Game reached its completed/result state — grace, then stop. */
  const gameFinished = (delayMs = autoStopDelayMs) => {
    cancelCountdown();
    cancelScheduledStop();
    const delay = Math.max(0, Number.isFinite(delayMs) ? delayMs : 0);
    if (recorder.isRecording) {
      // Already capturing — just keep recording a bit longer, then stop.
      scheduleStop(delay);
    } else {
      // Not capturing yet (e.g. ended during the 3s countdown). Remember
      // so the recording stops as soon as capture actually begins.
      pendingStopRef.current = delay;
    }
  };

  // Canonical aliases so games/hooks use one consistent vocabulary.
  const startCreatorRecording = start;
  const gameStarted = start;
  const gameQuit = stopCreatorRecording;

  // ── Automatic recording lifecycle ────────────────────────────────
  // Start when the actual game starts (autoStart flips true). A 3-2-1
  // countdown precedes capture so the creator sees what will be
  // recorded; the game remains fully playable throughout.
  const autoStartRef = useRef(false);
  useEffect(() => {
    if (!autoStart || autoStartRef.current) return;
    autoStartRef.current = true;
    if (enabled) start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart, enabled]);

  // Stop when the game reaches its completed/result state (autoStop flips
  // true). Recording keeps running for the grace period so the result /
  // winner animation is captured, then stops and becomes downloadable.
  const autoStopRef = useRef(false);
  useEffect(() => {
    if (!autoStop || autoStopRef.current) return;
    autoStopRef.current = true;
    setGameEnded(true);
    gameFinished();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStop, recorder.isRecording]);

  // User quit / navigated away: stop and release the capture. The
  // recorder hook's own unmount cleanup does the same, but stopping here
  // first lets the chunks flush if the page is merely being replaced.
  const isRecordingRef = useRef(recorder.isRecording);
  useEffect(() => {
    isRecordingRef.current = recorder.isRecording;
  }, [recorder.isRecording]);
  useEffect(() => {
    return () => {
      // User quit / navigated away: stop NOW (no grace period) and
      // release the capture. The recorder hook's own unmount cleanup
      // does the same, but stopping here first lets the chunks flush if
      // the page is merely being replaced.
      cancelScheduledStop();
      if (isRecordingRef.current) recorder.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const value = useMemo(
    () => ({
      // Mode flag + output dimensions (canonical lifecycle names).
      enabled,
      isCreatorMode: enabled,
      creatorModeEnabled: enabled,
      dimensions,
      recordingDimensions: dimensions,
      // Recorder state for UI.
      state: recorder.state,
      error: recorder.error,
      lastResult: recorder.lastResult,
      supported: recorder.supported,
      isRecording: recorder.isRecording,
      sourceModeUsed: recorder.sourceModeUsed,
      countdown,
      // Canonical lifecycle API.
      gameStarted,
      gameFinished,
      gameQuit,
      startCreatorRecording,
      stopCreatorRecording,
      // Result/UX state.
      gameEnded,
      discard: recorder.discard,
      // Backwards-compatible aliases.
      selectPreset,
      applyCustomDimensions,
      start,
      stop: stopCreatorRecording,
      download: (base) => recorder.download(base || `grynd-${gameLabel}`),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      enabled,
      recorder.state,
      recorder.error,
      recorder.lastResult,
      recorder.supported,
      recorder.isRecording,
      recorder.sourceModeUsed,
      recorder.start,
      recorder.stop,
      recorder.download,
      countdown,
      dimensions,
      gameEnded,
      gameLabel,
    ],
  );

  return (
    <CreatorModeContext.Provider value={value}>
      {enabled ? (
        <div className="flex justify-center" data-creator-mode-active>
          <div
            style={{
              width: dimensions.width * scale,
              height: dimensions.height * scale,
            }}
          >
            <div
              ref={frameRef}
              data-creator-recording
              aria-hidden="false"
              style={{
                width: dimensions.width,
                height: dimensions.height,
                overflow: "hidden",
                background: "#000000",
                transform: `scale(${scale})`,
                transformOrigin: "top left",
                position: "relative",
              }}
            >
              {children}
            </div>
          </div>
        </div>
      ) : (
        children
      )}
    </CreatorModeContext.Provider>
  );
}
