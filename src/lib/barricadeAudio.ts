"use client";

// src/lib/barricadeAudio.ts
//
// Barricade sound effects.
//
// The same shape as the other per-game audio modules (fourInARowAudio,
// hexAudio, dotsAndBoxesAudio, precisionAudio): short, quiet Web Audio cues built
// from oscillators and noise — no files to load, no dependency, and everything
// routed through the page-wide AudioContext in audioContext.ts, so the app's
// global mute setting silences the whole game at once (getSharedAudioContext()
// returns null while muted, and these functions become no-ops).
//
// Deduplication is the caller's job: the page keys each cue on the real event
// (the accepted action, the settled result), because only the caller knows
// whether a re-render is a new event or the same one echoed back.

import { playDefeat, playVictory } from "./gameAudio";
import { getSharedAudioContext, getSharedOutputNode } from "./audioContext";

function getCtx(): AudioContext | null {
  return getSharedAudioContext();
}

function playTone(
  freq: number,
  duration: number,
  type: OscillatorType = "sine",
  volume = 0.07,
  delay = 0,
) {
  const ctx = getCtx();
  if (!ctx) return;
  const t = ctx.currentTime + delay;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.001, t);
  gain.gain.exponentialRampToValueAtTime(volume, t + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.001, t + duration);
  osc.connect(gain).connect(getSharedOutputNode() || ctx.destination);
  osc.start(t);
  osc.stop(t + duration);
}

/** A short filtered-noise knock — the "clack" of a wooden barricade going down. */
function playKnock(duration: number, volume = 0.06, cutoff = 1400, delay = 0) {
  const ctx = getCtx();
  if (!ctx) return;
  const t = ctx.currentTime + delay;
  const size = Math.max(1, Math.floor(ctx.sampleRate * duration));
  const buffer = ctx.createBuffer(1, size, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < size; i += 1) data[i] = Math.random() * 2 - 1;
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = cutoff;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(volume, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + duration);
  source.connect(filter).connect(gain).connect(getSharedOutputNode() || ctx.destination);
  source.start(t);
  source.stop(t + duration);
}

// ── The game's four events ────────────────────────────────────────────────

/** A pawn takes one step. */
export function playBarricadeStep(mine = true) {
  playTone(mine ? 320 : 250, 0.075, "triangle", mine ? 0.06 : 0.045);
  playKnock(0.035, 0.03, 2400);
}

/**
 * A pawn jumps over the opponent — two quick notes, because it is two squares.
 * A diagonal jump gets a slightly higher second note so the two reads differ.
 */
export function playBarricadeJump(diagonal = false, mine = true) {
  playTone(mine ? 420 : 340, 0.06, "triangle", 0.055);
  playTone(diagonal ? 720 : 640, 0.075, "triangle", 0.05, 0.06);
}

/** A barricade lands — a heavier, wooden knock, duller for the opponent's. */
export function playBarricadeWall(mine = true) {
  playKnock(0.12, mine ? 0.08 : 0.06, mine ? 1100 : 800);
  playTone(mine ? 150 : 118, 0.1, "square", mine ? 0.035 : 0.03);
}

/** A placement or a tap the rules refuse. */
export function playBarricadeReject() {
  playTone(170, 0.12, "sawtooth", 0.035);
  playTone(140, 0.14, "sawtooth", 0.03, 0.06);
}

/** The match is over: the shared platform fanfares, so every game sounds alike. */
export function playBarricadeWin() {
  playVictory();
}

/** The bot reaches the far row first. */
export function playBarricadeLoss() {
  playDefeat();
}

/** A fresh board (New Game / restart). */
export function playBarricadeNewGame() {
  playTone(523, 0.08, "triangle", 0.05);
  playTone(784, 0.1, "triangle", 0.05, 0.08);
}

// ── Wake the AudioContext on the first real gesture ───────────────────────
// Browsers start a context suspended; the first click or key press resumes it,
// exactly as every other game module does.

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
