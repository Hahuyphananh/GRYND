"use client";

// ── Singleton AudioContext (lazy, shared across page) ──────────────────

import { isAudioMuted } from "./audioSettings";

let _ctx: AudioContext | null = null;
function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  // Global mute gate — silences every game's sounds at once.
  if (isAudioMuted()) return null;
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

// ── Helpers ────────────────────────────────────────────────────────────

function playTone(
  freq: number,
  duration: number,
  type: OscillatorType = "sine",
  volume = 0.1,
) {
  const ctx = getCtx();
  if (!ctx) return;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(volume, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
  osc.connect(gain).connect(ctx.destination);
  osc.start(ctx.currentTime);
  osc.stop(ctx.currentTime + duration);
}

function playChime(freq: number, duration: number, volume = 0.08) {
  const harmonics = [1, 2.01, 3.02];
  for (const h of harmonics) {
    playTone(freq * h, duration * (1.1 - h * 0.05), "sine", volume / harmonics.length);
  }
}

// ── Public API ─────────────────────────────────────────────────────────

/** Play a card being dealt/placed sound */
export function playCardPlace() {
  playTone(660, 0.08, "triangle", 0.06);
  setTimeout(() => playTone(880, 0.05, "triangle", 0.05), 40);
}

/** Play a card being drawn sound */
export function playCardDraw() {
  playTone(440, 0.06, "sine", 0.05);
  setTimeout(() => playTone(554, 0.06, "sine", 0.05), 30);
}

/** Play a turn switch notification */
export function playTurnSwitch(myTurn: boolean) {
  const freq = myTurn ? 660 : 440;
  playTone(freq, 0.12, "sine", 0.07);
  setTimeout(() => playTone(freq * 1.25, 0.08, "sine", 0.05), 80);
}

/** Play a victory fanfare */
export function playVictory() {
  const notes = [523, 659, 784, 1048];
  notes.forEach((f, i) => {
    setTimeout(() => playChime(f, 0.4, 0.08), i * 120);
  });
}

/** Play a defeat/draw sound */
export function playDefeat() {
  playTone(330, 0.3, "triangle", 0.07);
  setTimeout(() => playTone(262, 0.4, "triangle", 0.06), 200);
}

/** Play a countdown tick */
export function playTick() {
  playTone(800, 0.03, "square", 0.04);
}

/** Play a countdown final */
export function playCountdownGo() {
  playTone(1048, 0.15, "square", 0.1);
}

/** Play a crash / explosion sweep (descending rumble) */
export function playCrash() {
  playTone(220, 0.5, "sawtooth", 0.08);
  setTimeout(() => playTone(110, 0.6, "sawtooth", 0.08), 60);
  setTimeout(() => playTone(55, 0.7, "square", 0.06), 160);
}

/** Play a short low "bad reveal" buzz (mine hit, bad peek) */
export function playBuzz() {
  playTone(180, 0.18, "square", 0.06);
  setTimeout(() => playTone(140, 0.22, "square", 0.06), 90);
}

/** Play a soft positive "good reveal" chime (safe pick, good peek) */
export function playGoodReveal() {
  playTone(660, 0.09, "sine", 0.07);
  setTimeout(() => playTone(880, 0.12, "sine", 0.07), 70);
}

// Resume audio context on first user interaction
if (typeof window !== "undefined") {
  const resume = () => {
    const ctx = getCtx();
    if (ctx && ctx.state === "suspended") ctx.resume();
    window.removeEventListener("click", resume);
    window.removeEventListener("keydown", resume);
  };
  window.addEventListener("click", resume);
  window.addEventListener("keydown", resume);
}
