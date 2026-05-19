"use client";

import { useCallback, useEffect, useRef } from "react";

// ── Singleton AudioContext (created lazily; one per page) ──────────────

let _ctx: AudioContext | null = null;
function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!_ctx) {
    try {
      _ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    } catch {
      return null;
    }
  }
  if (_ctx.state === "suspended") _ctx.resume();
  return _ctx;
}

// ── Helpers ─────────────────────────────────────────────────────────────

function playTone(
  freq: number,
  duration: number,
  type: OscillatorType = "sine",
  volume = 0.12,
  rampDown = true
) {
  const ctx = getCtx();
  if (!ctx) return;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(volume, ctx.currentTime);
  if (rampDown) gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
  osc.connect(gain).connect(ctx.destination);
  osc.start(ctx.currentTime);
  osc.stop(ctx.currentTime + duration);
}

function playNoise(duration: number, volume = 0.08) {
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
  filter.frequency.value = 3000;

  source.connect(filter).connect(gain).connect(ctx.destination);
  source.start(ctx.currentTime);
  source.stop(ctx.currentTime + duration);
}

function playChime(freq: number, duration: number, volume = 0.1) {
  const ctx = getCtx();
  if (!ctx) return;
  const harmonics = [1, 2.01, 3.02, 4.05];
  for (const h of harmonics) {
    playTone(freq * h, duration * (1.2 - h * 0.1), "sine", volume / harmonics.length);
  }
}

function playSweep(startFreq: number, endFreq: number, duration: number, volume = 0.1, type: OscillatorType = "sine") {
  const ctx = getCtx();
  if (!ctx) return;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(startFreq, ctx.currentTime);
  osc.frequency.exponentialRampToValueAtTime(endFreq, ctx.currentTime + duration);
  gain.gain.setValueAtTime(volume, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
  osc.connect(gain).connect(ctx.destination);
  osc.start(ctx.currentTime);
  osc.stop(ctx.currentTime + duration);
}

// ── Hook ────────────────────────────────────────────────────────────────

export interface HexAudioAPI {
  /** Player selects their unit */
  playSelect: () => void;
  /** Unit moves to a valid hex */
  playMove: () => void;
  /** Neutral hex captured */
  playCapture: () => void;
  /** Enemy unit pushed */
  playPush: () => void;
  /** Power node controlled */
  playPowerNode: () => void;
  /** Turn switches */
  playTurnSwitch: (toPlayer: "player1" | "player2") => void;
  /** Match won */
  playVictory: () => void;
  /** Match lost */
  playDefeat: () => void;
  /** Enabled flag (false = silent) */
  enabled: boolean;
  setEnabled: (v: boolean) => void;
}

export function useHexAudio(): HexAudioAPI {
  const enabledRef = useRef(true);

  const setEnabled = useCallback((v: boolean) => {
    enabledRef.current = v;
  }, []);

  const playSelect = useCallback(() => {
    if (!enabledRef.current) return;
    playTone(880, 0.08, "square", 0.06);
  }, []);

  const playMove = useCallback(() => {
    if (!enabledRef.current) return;
    playTone(440, 0.1, "triangle", 0.08);
    setTimeout(() => playTone(554, 0.06, "triangle", 0.06), 50);
  }, []);

  const playCapture = useCallback(() => {
    if (!enabledRef.current) return;
    playChime(660, 0.35, 0.1);
    setTimeout(() => playChime(880, 0.25, 0.08), 100);
  }, []);

  const playPush = useCallback(() => {
    if (!enabledRef.current) return;
    playNoise(0.2, 0.1);
    playSweep(200, 80, 0.25, 0.08, "sawtooth");
  }, []);

  const playPowerNode = useCallback(() => {
    if (!enabledRef.current) return;
    playChime(1048, 0.4, 0.08);
    setTimeout(() => playChime(1318, 0.3, 0.06), 120);
    setTimeout(() => playChime(1568, 0.2, 0.04), 240);
  }, []);

  const playTurnSwitch = useCallback((toPlayer: "player1" | "player2") => {
    if (!enabledRef.current) return;
    const base = toPlayer === "player1" ? 440 : 330;
    playSweep(base * 1.5, base, 0.25, 0.07, "sine");
  }, []);

  const playVictory = useCallback(() => {
    if (!enabledRef.current) return;
    const notes = [523, 659, 784, 1048];
    notes.forEach((f, i) => {
      setTimeout(() => playChime(f, 0.5, 0.1), i * 150);
    });
  }, []);

  const playDefeat = useCallback(() => {
    if (!enabledRef.current) return;
    const notes = [440, 392, 330, 262];
    notes.forEach((f, i) => {
      setTimeout(() => playTone(f, 0.4, "triangle", 0.08), i * 200);
    });
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
    playSelect,
    playMove,
    playCapture,
    playPush,
    playPowerNode,
    playTurnSwitch,
    playVictory,
    playDefeat,
    get enabled() { return enabledRef.current; },
    setEnabled,
  };
}
