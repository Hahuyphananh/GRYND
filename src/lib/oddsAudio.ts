"use client";

import { useCallback, useEffect, useRef } from "react";
import { getSharedAudioContext, getSharedOutputNode } from "./creator-mode/audioTap";

// Single page-wide AudioContext (see creator-mode/audioTap.ts) — every
// game's sounds route through it so Creator Mode recordings capture the
// audio. Mute gating lives in getSharedAudioContext.
function getCtx(): AudioContext | null {
  return getSharedAudioContext();
}

// ── Helpers ─────────────────────────────────────────────────────────────

function playTone(
  freq: number,
  duration: number,
  type: OscillatorType = "sine",
  volume = 0.12,
) {
  const ctx = getCtx();
  if (!ctx) return;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(volume, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
  osc.connect(gain).connect(getSharedOutputNode() || ctx.destination);
  osc.start(ctx.currentTime);
  osc.stop(ctx.currentTime + duration);
}

function playChime(freq: number, duration: number, volume = 0.1) {
  const harmonics = [1, 2.01, 3.02];
  for (const h of harmonics) {
    playTone(
      freq * h,
      duration * (1.1 - h * 0.05),
      "sine",
      volume / harmonics.length,
    );
  }
}

function playSweep(
  startFreq: number,
  endFreq: number,
  duration: number,
  volume = 0.1,
) {
  const ctx = getCtx();
  if (!ctx) return;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(startFreq, ctx.currentTime);
  osc.frequency.exponentialRampToValueAtTime(
    endFreq,
    ctx.currentTime + duration,
  );
  gain.gain.setValueAtTime(volume, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
  osc.connect(gain).connect(getSharedOutputNode() || ctx.destination);
  osc.start(ctx.currentTime);
  osc.stop(ctx.currentTime + duration);
}

function playNoise(duration: number, volume = 0.06) {
  const ctx = getCtx();
  if (!ctx) return;
  const bufferSize = ctx.sampleRate * duration;
  const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(volume, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = 2000;
  source.connect(filter).connect(gain).connect(getSharedOutputNode() || ctx.destination);
  source.start(ctx.currentTime);
  source.stop(ctx.currentTime + duration);
}

// ── Hook ────────────────────────────────────────────────────────────────

export interface OddsAudioAPI {
  /** Number submitted / picked */
  playPick: () => void;
  /** Range halved */
  playHalve: () => void;
  /** Game won */
  playVictory: () => void;
  /** Game lost */
  playDefeat: () => void;
  /** Timer running low (< 5s) */
  playTimerUrgent: () => void;
  /** Enabled flag */
  enabled: boolean;
  setEnabled: (v: boolean) => void;
}

export function useOddsAudio(): OddsAudioAPI {
  const enabledRef = useRef(true);

  const setEnabled = useCallback((v: boolean) => {
    enabledRef.current = v;
  }, []);

  const playPick = useCallback(() => {
    if (!enabledRef.current) return;
    playTone(660, 0.08, "triangle", 0.07);
    setTimeout(() => playTone(880, 0.06, "triangle", 0.05), 40);
  }, []);

  const playHalve = useCallback(() => {
    if (!enabledRef.current) return;
    playSweep(600, 300, 0.3, 0.08);
    setTimeout(() => playTone(260, 0.2, "triangle", 0.06), 150);
  }, []);

  const playVictory = useCallback(() => {
    if (!enabledRef.current) return;
    const notes = [523, 659, 784, 1048];
    notes.forEach((f, i) => {
      setTimeout(() => playChime(f, 0.5, 0.1), i * 140);
    });
  }, []);

  const playDefeat = useCallback(() => {
    if (!enabledRef.current) return;
    const notes = [392, 349, 330, 262];
    notes.forEach((f, i) => {
      setTimeout(() => playTone(f, 0.4, "triangle", 0.08), i * 200);
    });
  }, []);

  const playTimerUrgent = useCallback(() => {
    if (!enabledRef.current) return;
    playTone(1000, 0.06, "square", 0.05);
    setTimeout(() => playTone(800, 0.06, "square", 0.05), 200);
  }, []);

  // Resume audio context on first user interaction
  useEffect(() => {
    const resume = () => {
      const ctx = getCtx();
      if (ctx && ctx.state === "suspended") ctx.resume();
      window.removeEventListener("click", resume);
      window.removeEventListener("keydown", resume);
    };
    window.addEventListener("click", resume);
    window.addEventListener("keydown", resume);
    return () => {
      window.removeEventListener("click", resume);
      window.removeEventListener("keydown", resume);
    };
  }, []);

  return {
    playPick,
    playHalve,
    playVictory,
    playDefeat,
    playTimerUrgent,
    get enabled() {
      return enabledRef.current;
    },
    setEnabled,
  };
}
