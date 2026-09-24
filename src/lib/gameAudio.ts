"use client";

// ── Singleton AudioContext (lazy, shared across page) ──────────────────

import { getSharedAudioContext, getSharedOutputNode } from "./audioContext";

// Single page-wide AudioContext (see audioContext.ts) — every
// game's sounds route through it. Mute gating lives in
// getSharedAudioContext.
function getCtx(): AudioContext | null {
  return getSharedAudioContext();
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
  osc.connect(gain).connect(getSharedOutputNode() || ctx.destination);
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

/**
 * A pane of glass giving way.
 *
 * Synthesised rather than sampled (this module ships no audio files): a
 * filtered noise burst for the crack, then a scatter of detuned high partials
 * that glide down as each shard loses energy, over a soft low knock so the hit
 * lands with weight. The partials are randomised per call, so a match full of
 * breaks never sounds like the same sample on loop.
 *
 * `volume` scales the whole gesture — the opponent's break is mixed quieter so
 * a rival's board event can't be mistaken for your own.
 */
export function playGlassBreak(volume = 1) {
  const ctx = getCtx();
  if (!ctx) return;
  const out = getSharedOutputNode() || ctx.destination;
  const now = ctx.currentTime;

  // 1. The crack — a burst of noise, bright and gone in a fifth of a second.
  const length = Math.floor(ctx.sampleRate * 0.28);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) {
    // Shaped noise: full at impact, decaying fast (the glass gives once).
    data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 2.2);
  }
  const noise = ctx.createBufferSource();
  noise.buffer = buffer;
  const highpass = ctx.createBiquadFilter();
  highpass.type = "highpass";
  highpass.frequency.value = 1400;
  const noiseGain = ctx.createGain();
  noiseGain.gain.setValueAtTime(0.22 * volume, now);
  noiseGain.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
  noise.connect(highpass).connect(noiseGain).connect(out);
  noise.start(now);
  noise.stop(now + 0.3);

  // 2. The shards — five ringing partials, each slightly detuned and dropped
  //    in a fraction later than the last, tumbling away from the impact.
  const partials = [1860, 2480, 3120, 3970, 4620];
  partials.forEach((base, i) => {
    const freq = base * (0.94 + Math.random() * 0.12);
    const start = now + i * 0.022 + Math.random() * 0.02;
    const duration = 0.16 + Math.random() * 0.22;
    const osc = ctx.createOscillator();
    const oscGain = ctx.createGain();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(freq, start);
    // A small downward glide reads as a shard losing its ring.
    osc.frequency.exponentialRampToValueAtTime(freq * 0.82, start + duration);
    oscGain.gain.setValueAtTime(0.0001, start);
    oscGain.gain.exponentialRampToValueAtTime(
      Math.max(0.008, (0.05 - i * 0.006) * volume),
      start + 0.008,
    );
    oscGain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    osc.connect(oscGain).connect(out);
    osc.start(start);
    osc.stop(start + duration + 0.05);
  });

  // 3. Body — a soft low knock so the impact has weight under the splinters.
  playTone(150, 0.16, "triangle", 0.05 * volume);
}

/** Play a short low "bad reveal" buzz (mine hit, bad peek) */
export function playBuzz() {
  playTone(180, 0.18, "square", 0.06);
  setTimeout(() => playTone(140, 0.22, "square", 0.06), 90);
}

/** Play a soft positive "good reveal" chime (good peek) */
export function playGoodReveal() {
  playTone(660, 0.09, "sine", 0.07);
  setTimeout(() => playTone(880, 0.12, "sine", 0.07), 70);
}

// ── Player's own gameplay cues ────────────────────────────────────────
// The viewer's half of the same vocabulary the opponent cues use (see
// below): ONE gesture per event, in the player's own bright sine family at
// the player's own volume, so the two seats can never be mistaken for each
// other. They exist so every rung of the feedback hierarchy has a voice —
// the tap acknowledges the press (never claims a result), the safe cue
// confirms a pick that survived, the bank cue locks a run in.
//
// Mute, volume and browser autoplay are handled once, centrally: these all
// route through playTone → getSharedAudioContext(), which returns null while
// the global gate is on and resumes the context on the first gesture.

/** A tile/target was chosen — the quietest rung, deliberately short so
 *  rapid tapping never turns into a rattle */
export function playSelect() {
  playTone(520, 0.05, "sine", 0.04);
}

/** Your pick survived (a safe tile, or a correct flag) — a confident rise,
 *  brighter and slightly louder than the peek reveal it sits above */
export function playSafePick() {
  playTone(587, 0.08, "sine", 0.07);
  setTimeout(() => playTone(784, 0.13, "sine", 0.075), 60);
}

/** Your run is locked in (a bank) — the safe rise, then a warm low body
 *  that reads as "banked", mirroring the opponent's descending lock */
export function playBank() {
  playTone(440, 0.09, "sine", 0.07);
  setTimeout(() => playTone(659, 0.11, "sine", 0.07), 70);
  setTimeout(() => playTone(220, 0.24, "triangle", 0.045), 70);
}

// ── Opponent cues ─────────────────────────────────────────────────────
// The rival's moves get their own quiet, dull family: lower in pitch and
// roughly half the volume of the player's own cues, with a soft triangle
// timbre instead of the player's bright sine / harsh square. The gesture
// still matches the event (safe = rising, bank = lock, bust = falling), so
// the meaning reads instantly — but a rival's play can never be mistaken
// for your own.
//
// Mute is handled once, centrally: getSharedAudioContext() returns null
// while the global audio gate is on, so these are silenced exactly like
// every other game sound.

/** Opponent survived a tile / called a row correctly (soft rising pair) */
export function playOpponentPick() {
  playTone(294, 0.07, "triangle", 0.03);
  setTimeout(() => playTone(349, 0.09, "triangle", 0.025), 55);
}

/** Opponent banked their run (short, warm descending lock) */
export function playOpponentBank() {
  playTone(330, 0.1, "triangle", 0.035);
  setTimeout(() => playTone(247, 0.16, "triangle", 0.03), 70);
}

/** Opponent hit the bad tile (low, dull thud — no bright edge) */
export function playOpponentBust() {
  playTone(150, 0.15, "triangle", 0.045);
  setTimeout(() => playTone(110, 0.2, "triangle", 0.04), 80);
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
