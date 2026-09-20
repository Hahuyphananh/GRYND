"use client";

// src/lib/fourInARowAudio.ts
//
// Four-In-A-Row sound effects.
//
// Mirrors the established per-game audio pattern (gameAudio, hexAudio,
// oddsAudio, dotsAndBoxesAudio, precisionAudio): the Web Audio API with no
// external dependency and no file loading, so nothing has to load before a
// sound can play.
//
// Every sound routes through the page-wide AudioContext in
// creator-mode/audioTap.ts, which means:
//   • the global mute gate (lib/audioSettings) silences all of it at once —
//     getSharedAudioContext() returns null while muted, so these functions
//     become no-ops and never even create a context;
//   • Creator Mode recordings capture the effects with no per-game code;
//   • autoplay policy is respected: the context is created lazily and only
//     ever triggered from a real interaction (a click / a landed move), and
//     the first click or key press resumes it.
//
// The sounds are deliberately short and quiet — arcade feedback that
// reinforces the visual action, never a soundtrack:
//   select          the column is committed            ~45 ms
//   land            YOUR disc reaches the board        ~110 ms
//   opponentLand    THE OTHER disc reaches the board   ~110 ms (duller)
//   matchStart      the match actually begins          ~200 ms
//   win             you connected four                 ~500 ms
//   loss            the opponent connected four        ~380 ms
//   draw            the board filled even              ~320 ms
//
// Deduplication is the CALLER's job (each call site keys on the real event —
// the move key, the settled result key), because only the caller knows
// whether a poll/socket echo is a new event or the same one re-sent. This
// module intentionally keeps no global throttle so a genuine second event is
// never swallowed.

import { getSharedAudioContext, getSharedOutputNode } from "./creator-mode/audioTap";

// Single page-wide AudioContext (see creator-mode/audioTap.ts) — every
// game's sounds route through it so Creator Mode recordings capture the
// audio, and mute gating lives in getSharedAudioContext.
function getCtx(): AudioContext | null {
  return getSharedAudioContext();
}

// ── Sound primitives ───────────────────────────────────────────────────

function playTone(
  freq: number,
  duration: number,
  type: OscillatorType = "sine",
  volume = 0.08,
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

function playChime(freq: number, duration: number, volume = 0.06, delay = 0) {
  const harmonics = [1, 2.01, 3.02];
  for (const h of harmonics) {
    playTone(freq * h, duration * (1.1 - h * 0.05), "sine", volume / harmonics.length, delay);
  }
}

/** A short percussive click — gives a landing its "thud" edge. */
function playClick(duration: number, volume = 0.05, cutoff = 1600, delay = 0) {
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

// ── Public API ─────────────────────────────────────────────────────────

/**
 * A playable column has just been committed (click / keyboard select).
 * Fires immediately on the valid interaction, before the request leaves.
 */
export function playFiarSelect() {
  playTone(880, 0.045, "triangle", 0.035);
}

/**
 * A disc reaches the board. `mine` distinguishes YOUR disc from the
 * opponent's — theirs lands duller and lower so the two never read as the
 * same event (matching the visual opponent cue).
 */
export function playFiarLand(mine = true) {
  const freq = mine ? 240 : 178;
  playTone(freq, 0.1, "triangle", mine ? 0.075 : 0.058);
  playClick(0.06, mine ? 0.05 : 0.04, mine ? 1800 : 1200);
}

/** The opponent's disc reaches the board (explicit alias for readability). */
export function playFiarOpponentLand() {
  playFiarLand(false);
}

/** The match has actually started (the matchmaking takeover handed over). */
export function playFiarMatchStart() {
  playTone(587, 0.09, "triangle", 0.06);
  playTone(880, 0.11, "triangle", 0.06, 0.09);
}

/** You connected four — a short ascending arcade fanfare, then it stops. */
export function playFiarWin() {
  const notes = [523, 659, 784];
  notes.forEach((f, i) => playChime(f, 0.3, 0.07, i * 0.09));
}

/** The opponent connected four — clear, descending, and not humiliating. */
export function playFiarLoss() {
  playTone(392, 0.2, "triangle", 0.06);
  playTone(311, 0.24, "triangle", 0.055, 0.14);
}

/** The board filled with no winner — a neutral, unresolved pair. */
export function playFiarDraw() {
  playChime(440, 0.28, 0.05);
  playChime(587, 0.28, 0.05);
}

// ── Resume the AudioContext on the first user interaction ──────────────
// (Same as gameAudio/precisionAudio — browsers start a context suspended
// until a real gesture, so the very first effect must be able to wake it.)

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
