// src/lib/creator-mode/useCreatorRecorder.ts
//
// React binding for CreatorRecorder. Keeps the recorder's mutable state
// in React state so UIs re-render on transitions, and guarantees the
// capture is torn down when the component unmounts (user quits the game
// or navigates away) — automatic recording stop on quit.

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CreatorRecorder, isViewportRecordingSupported } from "./recorder";
import type {
  CaptureDimensions,
  CaptureSourceMode,
  RecordingResult,
  RecordingState,
} from "./types";

export type StartRecordingOptions = {
  container: HTMLElement;
  width: number;
  height: number;
  fps?: number;
};

export type UseCreatorRecorder = {
  supported: boolean;
  state: RecordingState;
  isRecording: boolean;
  dimensions: CaptureDimensions | null;
  error: string | null;
  lastResult: RecordingResult | null;
  /** Which capture path was used for the current/last recording. */
  sourceModeUsed: CaptureSourceMode | null;
  /** Begin in-page capture of the given container. Returns true on success. */
  start: (options: StartRecordingOptions) => Promise<boolean>;
  /** Stop and produce a downloadable recording. */
  stop: () => void;
  /** Stop and auto-download the finished recording (save on leave). */
  stopAndSave: (filenameBase?: string) => string | null;
  /** Save synchronously from the frames already captured (page unload). */
  stopAndSaveSync: (filenameBase?: string) => string | null;
  /** Stop without producing a recording. */
  cancel: () => void;
  /** Delete the finished recording and release its object URL. */
  discard: () => void;
  /** Download the latest recording. Returns the filename or null. */
  download: (filenameBase?: string) => string | null;
};

export function useCreatorRecorder(): UseCreatorRecorder {
  const recorderRef = useRef<CreatorRecorder | null>(null);
  if (recorderRef.current === null) {
    recorderRef.current = new CreatorRecorder();
  }

  const [state, setState] = useState<RecordingState>("idle");
  const [dimensions, setDimensions] = useState<CaptureDimensions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<RecordingResult | null>(null);
  const [sourceModeUsed, setSourceModeUsed] = useState<CaptureSourceMode | null>(null);

  const recorder = recorderRef.current;

  // Wire recorder callbacks once.
  useEffect(() => {
    const rec = recorderRef.current;
    if (!rec) return;
    rec.setOnStateChange((next) => {
      setState(next);
      setDimensions(rec.dimensions);
      setError(rec.error);
      setLastResult(rec.lastResult);
      setSourceModeUsed(rec.sourceModeUsed);
    });
    // Reflect initial values.
    setDimensions(rec.dimensions);
    setError(rec.error);
    setLastResult(rec.lastResult);
    setSourceModeUsed(rec.sourceModeUsed);
  }, []);

  // Truth-poll: the recorder CLASS is the source of truth (it reads the
  // live MediaRecorder directly), while React state is fed by async
  // events. If an event is ever dropped or arrives late (a known hazard
  // with fast game starts), the UI would drift — e.g. show "armed" while
  // the recorder is actually running, leaving the Stop button disabled
  // and clicks appearing to do nothing. Poll the class once a second and
  // push any difference into React so the UI can never drift from the
  // real recorder state.
  const lastSnapshotRef = useRef<string>("");
  useEffect(() => {
    const syncFromRecorder = () => {
      const rec = recorderRef.current;
      if (!rec) return;
      const snapshot = JSON.stringify({
        s: rec.state,
        d: rec.dimensions,
        e: rec.error,
        r: rec.lastResult ? rec.lastResult.url : null,
        m: rec.sourceModeUsed,
      });
      if (snapshot === lastSnapshotRef.current) return;
      lastSnapshotRef.current = snapshot;
      setState(rec.state);
      setDimensions(rec.dimensions);
      setError(rec.error);
      setLastResult(rec.lastResult);
      setSourceModeUsed(rec.sourceModeUsed);
    };
    syncFromRecorder();
    const timer = window.setInterval(syncFromRecorder, 1000);
    // Also re-sync immediately when the tab becomes visible again.
    const onVisible = () => {
      if (document.visibilityState === "visible") syncFromRecorder();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  // Automatic stop on unmount = the user left the game page / quit.
  useEffect(() => {
    const rec = recorderRef.current;
    return () => {
      rec?.dispose();
    };
  }, []);

  const start = useCallback(async (options: StartRecordingOptions) => {
    const ok = await recorderRef.current?.start(options);
    const rec = recorderRef.current;
    if (rec) {
      setState(rec.state);
      setDimensions(rec.dimensions);
      setError(rec.error);
      setLastResult(rec.lastResult);
      setSourceModeUsed(rec.sourceModeUsed);
      // Breadcrumb: capture start outcome — helps diagnose "countdown
      // ran but recording never started" reports (armed forever).
      console.info(
        `[creator] capture start → ok=${ok} state=${rec.state} mode=${rec.sourceModeUsed ?? "-"} error=${rec.error ?? "-"}`,
      );
    }
    return Boolean(ok);
  }, []);

  const stop = useCallback(() => {
    recorderRef.current?.stop();
    const rec = recorderRef.current;
    if (rec) {
      setState(rec.state);
      setDimensions(rec.dimensions);
      setError(rec.error);
      setLastResult(rec.lastResult);
    }
  }, []);

  const stopAndSave = useCallback((filenameBase?: string) => {
    const filename = recorderRef.current?.stopAndSave(filenameBase) ?? null;
    const rec = recorderRef.current;
    if (rec) {
      setState(rec.state);
      setDimensions(rec.dimensions);
      setError(rec.error);
      setLastResult(rec.lastResult);
    }
    return filename;
  }, []);

  const stopAndSaveSync = useCallback((filenameBase?: string) => {
    const filename = recorderRef.current?.stopAndSaveSync(filenameBase) ?? null;
    const rec = recorderRef.current;
    if (rec) {
      setState(rec.state);
      setDimensions(rec.dimensions);
      setError(rec.error);
      setLastResult(rec.lastResult);
    }
    return filename;
  }, []);

  const cancel = useCallback(() => {
    recorderRef.current?.cancel();
    setState("idle");
    setError(null);
    setLastResult(null);
    setSourceModeUsed(null);
  }, []);

  const discard = useCallback(() => {
    recorderRef.current?.discard();
    setState("idle");
    setError(null);
    setLastResult(null);
    setSourceModeUsed(null);
  }, []);

  const download = useCallback((filenameBase?: string) => {
    return recorderRef.current?.download(filenameBase) ?? null;
  }, []);

  const supported = useMemo(() => isViewportRecordingSupported(), []);

  return {
    supported,
    state,
    isRecording: state === "recording",
    dimensions,
    error,
    lastResult,
    sourceModeUsed,
    start,
    stop,
    stopAndSave,
    stopAndSaveSync,
    cancel,
    discard,
    download,
  };
}
