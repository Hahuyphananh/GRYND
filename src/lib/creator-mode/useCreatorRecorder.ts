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
    cancel,
    discard,
    download,
  };
}
