"use client";

// src/components/last-run/useRunAudio.ts
//
// Cosmetic sound for LAST RUN. Nothing here can affect a match: every cue is a
// short synthesised blip triggered by something the SERVER already said.
//
//   * No autoplay. Sound starts OFF, and the only way on is the visible mute
//     control (a real user gesture, which is also when the AudioContext is
//     allowed to start).
//   * No assets and no requests: two oscillators and a gain envelope.
//   * The preference lives in localStorage; the context is closed on unmount.

import { useCallback, useEffect, useRef, useState } from "react";

const STORAGE_KEY = "grynd:lastRunAudio:v1";

export type RunCue = "jump" | "duck" | "crash" | "tick" | "win" | "loss" | "draw" | "enable";

type Tone = { from: number; to: number; duration: number; type: OscillatorType; gain: number };

const CUES: Record<RunCue, Tone> = {
  jump: { from: 520, to: 780, duration: 0.09, type: "triangle", gain: 0.05 },
  duck: { from: 300, to: 200, duration: 0.07, type: "sine", gain: 0.045 },
  crash: { from: 180, to: 70, duration: 0.28, type: "sawtooth", gain: 0.07 },
  tick: { from: 880, to: 880, duration: 0.05, type: "square", gain: 0.03 },
  win: { from: 620, to: 940, duration: 0.24, type: "triangle", gain: 0.06 },
  loss: { from: 240, to: 140, duration: 0.3, type: "sine", gain: 0.05 },
  draw: { from: 440, to: 440, duration: 0.2, type: "sine", gain: 0.04 },
  enable: { from: 540, to: 720, duration: 0.1, type: "triangle", gain: 0.05 },
};

type AudioWindow = Window & { webkitAudioContext?: typeof AudioContext };

export function useRunAudio() {
  const [enabled, setEnabled] = useState(false);
  const contextRef = useRef<AudioContext | null>(null);

  useEffect(() => {
    try {
      setEnabled(window.localStorage.getItem(STORAGE_KEY) === "1");
    } catch {
      // Storage blocked (private mode): stay muted.
    }
  }, []);

  const ensureContext = useCallback((): AudioContext | null => {
    if (typeof window === "undefined") return null;
    if (contextRef.current) return contextRef.current;
    const Ctor = window.AudioContext ?? (window as AudioWindow).webkitAudioContext;
    if (!Ctor) return null;
    try {
      contextRef.current = new Ctor();
      return contextRef.current;
    } catch {
      return null;
    }
  }, []);

  const playTone = useCallback((tone: Tone) => {
    const context = ensureContext();
    if (!context) return;
    // A context created before a gesture may be suspended; resume it. A failure
    // simply means silence, never an error in the game flow.
    if (context.state === "suspended") void context.resume().catch(() => undefined);
    try {
      const now = context.currentTime;
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = tone.type;
      oscillator.frequency.setValueAtTime(tone.from, now);
      oscillator.frequency.exponentialRampToValueAtTime(Math.max(20, tone.to), now + tone.duration);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(tone.gain, now + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + tone.duration);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(now);
      oscillator.stop(now + tone.duration + 0.02);
    } catch {
      // Ignore: audio is cosmetic.
    }
  }, [ensureContext]);

  const play = useCallback(
    (cue: RunCue) => {
      if (!enabled) return;
      playTone(CUES[cue]);
    },
    [enabled, playTone],
  );

  const toggle = useCallback(() => {
    setEnabled((current) => {
      const next = !current;
      try {
        window.localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
      } catch {
        // Preference is best-effort.
      }
      if (next) {
        const context = ensureContext();
        if (context?.state === "suspended") void context.resume().catch(() => undefined);
        playTone(CUES.enable);
      }
      return next;
    });
  }, [ensureContext, playTone]);

  useEffect(() => {
    return () => {
      const context = contextRef.current;
      contextRef.current = null;
      if (context && context.state !== "closed") void context.close().catch(() => undefined);
    };
  }, []);

  return { enabled, toggle, play };
}

export default useRunAudio;
