"use client";

import { useCallback, useEffect, useRef } from "react";
import { getSharedAudioContext, getSharedOutputNode } from "../../lib/audioContext";

// Single page-wide AudioContext (see audioContext.ts) — every
// game's sounds route through it. Mute gating lives in
// getSharedAudioContext.
function getCtx(): AudioContext | null {
  return getSharedAudioContext();
}

// ── Sound primitives ────────────────────────────────────────────────────

function playTone(
  freq: number,
  duration: number,
  type: OscillatorType = "sine",
  volume = 0.12,
  rampDown = true,
) {
  const ctx = getCtx();
  if (!ctx) return;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(volume, ctx.currentTime);
  if (rampDown)
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
  osc.connect(gain).connect(getSharedOutputNode() || ctx.destination);
  osc.start(ctx.currentTime);
  osc.stop(ctx.currentTime + duration);
}

function playNoise(duration: number, volume = 0.08, lowpass = 3000) {
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
  filter.frequency.value = lowpass;
  source.connect(filter).connect(gain).connect(getSharedOutputNode() || ctx.destination);
  source.start(ctx.currentTime);
  source.stop(ctx.currentTime + duration);
}

function playChime(freq: number, duration: number, volume = 0.1) {
  const ctx = getCtx();
  if (!ctx) return;
  const harmonics = [1, 2.01, 3.02, 4.05];
  for (const h of harmonics) {
    playTone(
      freq * h,
      duration * (1.2 - h * 0.1),
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
  type: OscillatorType = "sine",
) {
  const ctx = getCtx();
  if (!ctx) return;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
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

// ── Hook ────────────────────────────────────────────────────────────────

export interface PokerAudioAPI {
  /** Card flip / deal sound */
  playCardDeal: () => void;
  /** Card sliding across felt */
  playCardSlide: () => void;
  /** Single chip click */
  playChipClick: () => void;
  /** Multiple chips stacking */
  playChipStack: () => void;
  /** Chips pushed into pot */
  playChipPot: () => void;
  /** Timer warning tick (≤10s) */
  playTimerCritical: () => void;
  /** Timer urgent beep (≤5s) */
  playTimerUrgent: () => void;
  /** Action button pressed (fold) */
  playFold: () => void;
  /** Action button pressed (check) */
  playCheck: () => void;
  /** Action button pressed (call) */
  playCall: () => void;
  /** Action button pressed (raise) */
  playRaise: () => void;
  /** Win jingle */
  playWin: () => void;
  /** Lose sound */
  playLose: () => void;
  /** All-in dramatic sound */
  playAllIn: () => void;
  /** Card shuffle */
  playShuffle: () => void;
  /** New hand / round start */
  playNewHand: () => void;
  /** Mute toggle */
  enabled: boolean;
  setEnabled: (v: boolean) => void;
}

export function usePokerAudio(): PokerAudioAPI {
  const enabledRef = useRef(true);

  const setEnabled = useCallback((v: boolean) => {
    enabledRef.current = v;
  }, []);

  // ── Card sounds ───────────────────────────────────────────────────

  const playCardDeal = useCallback(() => {
    if (!enabledRef.current) return;
    // Short crisp flick — like a card being flipped
    playNoise(0.04, 0.06, 8000);
    setTimeout(() => playTone(1200, 0.03, "square", 0.04), 10);
  }, []);

  const playCardSlide = useCallback(() => {
    if (!enabledRef.current) return;
    // Soft sliding noise
    playNoise(0.12, 0.04, 2000);
  }, []);

  // ── Chip sounds ───────────────────────────────────────────────────

  const playChipClick = useCallback(() => {
    if (!enabledRef.current) return;
    playTone(1800, 0.04, "square", 0.05);
    setTimeout(() => playTone(2100, 0.03, "square", 0.03), 20);
  }, []);

  const playChipStack = useCallback(() => {
    if (!enabledRef.current) return;
    [0, 60, 120, 180].forEach((delay) => {
      setTimeout(
        () => playTone(1600 + Math.random() * 400, 0.03, "square", 0.04),
        delay,
      );
    });
  }, []);

  const playChipPot = useCallback(() => {
    if (!enabledRef.current) return;
    playSweep(800, 400, 0.2, 0.08, "triangle");
    playNoise(0.15, 0.05, 4000);
  }, []);

  // ── Timer sounds ──────────────────────────────────────────────────

  const playTimerCritical = useCallback(() => {
    if (!enabledRef.current) return;
    playTone(880, 0.08, "square", 0.08);
  }, []);

  const playTimerUrgent = useCallback(() => {
    if (!enabledRef.current) return;
    playTone(660, 0.06, "square", 0.06);
  }, []);

  // ── Action sounds ─────────────────────────────────────────────────

  const playFold = useCallback(() => {
    if (!enabledRef.current) return;
    playSweep(600, 150, 0.3, 0.08, "sawtooth");
    playNoise(0.15, 0.06, 1500);
  }, []);

  const playCheck = useCallback(() => {
    if (!enabledRef.current) return;
    playTone(1000, 0.06, "triangle", 0.06);
    setTimeout(() => playTone(1200, 0.04, "triangle", 0.04), 40);
  }, []);

  const playCall = useCallback(() => {
    if (!enabledRef.current) return;
    playTone(440, 0.08, "triangle", 0.07);
    setTimeout(() => playTone(554, 0.06, "triangle", 0.05), 50);
    setTimeout(() => playChipClick(), 30);
  }, [playChipClick]);

  const playRaise = useCallback(() => {
    if (!enabledRef.current) return;
    // Ascending dramatic tone
    playSweep(330, 660, 0.25, 0.1, "sine");
    setTimeout(() => playChime(880, 0.15, 0.06), 100);
    setTimeout(() => playChipStack(), 50);
  }, [playChipStack]);

  // ── Game result sounds ────────────────────────────────────────────

  const playWin = useCallback(() => {
    if (!enabledRef.current) return;
    const notes = [523, 659, 784, 1048, 1318];
    notes.forEach((f, i) => {
      setTimeout(() => playChime(f, 0.4, 0.1), i * 120);
    });
    setTimeout(() => playChime(1568, 0.6, 0.08), notes.length * 120);
  }, []);

  const playLose = useCallback(() => {
    if (!enabledRef.current) return;
    const notes = [440, 392, 349, 294, 262];
    notes.forEach((f, i) => {
      setTimeout(() => playTone(f, 0.35, "triangle", 0.08), i * 180);
    });
  }, []);

  const playAllIn = useCallback(() => {
    if (!enabledRef.current) return;
    // Dramatic crescendo
    playSweep(200, 1200, 0.5, 0.12, "sawtooth");
    setTimeout(() => playNoise(0.3, 0.1, 6000), 0);
    setTimeout(() => playChime(1048, 0.5, 0.1), 300);
    setTimeout(() => playChipStack(), 200);
  }, [playChipStack]);

  // ── Other ──────────────────────────────────────────────────────────

  const playShuffle = useCallback(() => {
    if (!enabledRef.current) return;
    // Rapid papery noise bursts
    for (let i = 0; i < 6; i++) {
      setTimeout(() => {
        playNoise(0.08, 0.04, 5000 + Math.random() * 3000);
      }, i * 70);
    }
  }, []);

  const playNewHand = useCallback(() => {
    if (!enabledRef.current) return;
    playTone(330, 0.1, "sine", 0.06);
    setTimeout(() => playTone(440, 0.1, "sine", 0.06), 100);
    setTimeout(() => playTone(554, 0.15, "sine", 0.08), 200);
    setTimeout(() => playChime(660, 0.3, 0.06), 300);
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
    playCardDeal,
    playCardSlide,
    playChipClick,
    playChipStack,
    playChipPot,
    playTimerCritical,
    playTimerUrgent,
    playFold,
    playCheck,
    playCall,
    playRaise,
    playWin,
    playLose,
    playAllIn,
    playShuffle,
    playNewHand,
    get enabled() {
      return enabledRef.current;
    },
    setEnabled,
  };
}
