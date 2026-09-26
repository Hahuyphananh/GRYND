"use client";

// ── Precision rank sound effects ──────────────────────────────────────
//
// Mirrors the established per-game audio pattern (gameAudio, hexAudio,
// oddsAudio). Uses the Web Audio API with a singleton
// AudioContext — no external dependencies, no file loading.
//
// Each rank tier gets a distinct sound played via `playRankSound(diffMs)`:
//    PERFECT    — sparkling high chime cascade
//    LEGENDARY  — majestic ascending fifths
//    MASTERFUL  — bold punchy stabs
//    EXCELLENT  — bright upbeat melody
//    GREAT      — solid pleasant chord
//    GOOD       — neutral clear tone
//    FAIR       — simple low tone
//    CLOSE      — warning-like two-tone
//    MISS       — low buzz
//
// Also exports individual functions for each rank so callers can trigger
// specific sounds without recomputing the rank from diffMs.

import { diffToRank } from "./precision/utils";
import { getSharedAudioContext, getSharedOutputNode } from "./audioContext";

// Single page-wide AudioContext (see audioContext.ts) — every
// game's sounds route through it. Mute gating lives in
// getSharedAudioContext.
function getCtx(): AudioContext | null {
  return getSharedAudioContext();
}

// ── Sound primitives ───────────────────────────────────────────────────

function playTone(
  freq: number,
  duration: number,
  type: OscillatorType = "sine",
  volume = 0.1,
  delay = 0,
) {
  const ctx = getCtx();
  if (!ctx) return;
  const t = ctx.currentTime + delay;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(volume, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + duration);
  osc.connect(gain).connect(getSharedOutputNode() || ctx.destination);
  osc.start(t);
  osc.stop(t + duration);
}

function playChime(
  freq: number,
  duration: number,
  volume = 0.08,
  delay = 0,
) {
  const harmonics = [1, 2.01, 3.02];
  for (const h of harmonics) {
    playTone(freq * h, duration * (1.1 - h * 0.05), "sine", volume / harmonics.length, delay);
  }
}

// ── Rank-specific sounds ───────────────────────────────────────────────

/**  PERFECT (0 ms) — sparkling high chime cascade */
export function playRankPerfect() {
  const notes = [1048, 1318, 1568, 2093];
  notes.forEach((f, i) => {
    playChime(f, 0.35, 0.09, i * 0.08);
  });
  // Add a warm sub-bass to ground it
  playTone(262, 0.5, "sine", 0.05, 0);
}

/**  LEGENDARY (1–3 ms) — majestic ascending fifths */
export function playRankLegendary() {
  const notes = [523, 784, 1048];
  notes.forEach((f, i) => {
    playChime(f, 0.3, 0.08, i * 0.1);
  });
  playTone(262, 0.4, "triangle", 0.04, 0);
}

/**  MASTERFUL (4–8 ms) — bold punchy stabs */
export function playRankMasterful() {
  playTone(660, 0.12, "square", 0.07, 0);
  setTimeout(() => {
    playTone(880, 0.1, "square", 0.06);
    playTone(1100, 0.08, "square", 0.05);
  }, 60);
  playTone(330, 0.2, "triangle", 0.04, 0);
}

/**  EXCELLENT (9–15 ms) — bright upbeat melody */
export function playRankExcellent() {
  playChime(660, 0.2, 0.07, 0);
  setTimeout(() => playChime(880, 0.18, 0.06), 100);
  playTone(330, 0.25, "sine", 0.04, 0);
}

/**  GREAT (16–25 ms) — solid pleasant chord */
export function playRankGreat() {
  playChime(523, 0.22, 0.06, 0);
  playTone(262, 0.25, "sine", 0.04, 0);
}

/**  GOOD (26–40 ms) — neutral clear tone */
export function playRankGood() {
  playTone(440, 0.18, "sine", 0.06, 0);
  playTone(554, 0.14, "sine", 0.04, 40);
}

/**  FAIR (41–60 ms) — simple low tone */
export function playRankFair() {
  playTone(330, 0.16, "triangle", 0.06, 0);
}

/**  CLOSE (61–100 ms) — warning-like two-tone */
export function playRankClose() {
  playTone(300, 0.15, "square", 0.04, 0);
  setTimeout(() => playTone(280, 0.15, "square", 0.04), 100);
}

/**  MISS (100+ ms) — low buzz */
export function playRankMiss() {
  playTone(150, 0.25, "sawtooth", 0.04, 0);
  playTone(200, 0.2, "sawtooth", 0.03, 0.05);
}

// ── Main API — resolve diffMs → rank → sound ─────────────────────────

/** Play the rank-appropriate sound for a given diff (|elapsed - target|). */
export function playRankSound(diffMs: number) {
  const rank = diffToRank(diffMs);
  switch (rank.label) {
    case "PERFECT":    playRankPerfect(); break;
    case "LEGENDARY":  playRankLegendary(); break;
    case "MASTERFUL":  playRankMasterful(); break;
    case "EXCELLENT":  playRankExcellent(); break;
    case "GREAT":      playRankGreat(); break;
    case "GOOD":       playRankGood(); break;
    case "FAIR":       playRankFair(); break;
    case "CLOSE":      playRankClose(); break;
    case "MISS":       playRankMiss(); break;
  }
}

/** Play the rank-appropriate sound by label (avoids re-computing diffToRank). */
export function playRankSoundByLabel(label: string) {
  switch (label) {
    case "PERFECT":    playRankPerfect(); break;
    case "LEGENDARY":  playRankLegendary(); break;
    case "MASTERFUL":  playRankMasterful(); break;
    case "EXCELLENT":  playRankExcellent(); break;
    case "GREAT":      playRankGreat(); break;
    case "GOOD":       playRankGood(); break;
    case "FAIR":       playRankFair(); break;
    case "CLOSE":      playRankClose(); break;
    case "MISS":       playRankMiss(); break;
  }
}

// ── Resume AudioContext on first user interaction ──────────────────────

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
