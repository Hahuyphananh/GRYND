"use client";

// src/lib/uiSounds.ts
//
// The site's interface sounds: a soft click for buttons/links, a two-note
// on/off for toggles, and a very quiet hover on primary calls to action.
//
// ── One context, one mute switch ────────────────────────────────────────────
//
// Everything routes through the shared, mute-aware AudioContext in
// `audioContext.ts`. That means the existing SoundToggle and its persisted
// preference (`grynd_audio_muted`) silence UI sounds and game sounds together —
// there is no second volume setting to drift out of sync.
//
// ── Synthesised, not sampled ────────────────────────────────────────────────
//
// No asset files and no network requests. Each sound is a short oscillator
// envelope, so there is nothing to download and no licence to track. Swap these
// for a designed sample later by replacing the three exported functions; the
// caller and the mute behaviour stay the same.

import { getSharedAudioContext, getSharedOutputNode } from "./audioContext";

const CLICK_VOLUME = 0.018;
const TOGGLE_VOLUME = 0.02;
const HOVER_VOLUME = 0.008;

/** One short, soft tone. */
function tone(
  ctx: AudioContext,
  frequency: number,
  duration: number,
  volume: number,
  delay = 0,
  type: OscillatorType = "sine",
) {
  const start = ctx.currentTime + delay;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.type = type;
  osc.frequency.setValueAtTime(frequency, start);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(volume, start + 0.005);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  osc.connect(gain).connect(getSharedOutputNode() || ctx.destination);
  osc.start(start);
  osc.stop(start + duration + 0.01);
}

/** A short, quiet tick for a press on a button or link. */
export function playUiClick() {
  const ctx = getSharedAudioContext();
  if (!ctx) return;
  tone(ctx, 900, 0.04, CLICK_VOLUME, 0, "triangle");
}

/** A rising pair when a toggle turns on, a falling pair when it turns off. */
export function playUiToggle(nextOn: boolean) {
  const ctx = getSharedAudioContext();
  if (!ctx) return;

  if (nextOn) {
    tone(ctx, 660, 0.07, TOGGLE_VOLUME);
    tone(ctx, 990, 0.08, TOGGLE_VOLUME * 0.8, 0.06);
  } else {
    tone(ctx, 880, 0.07, TOGGLE_VOLUME);
    tone(ctx, 590, 0.08, TOGGLE_VOLUME * 0.8, 0.06);
  }
}

/** The quietest of the three, and rate-limited so a sweep cannot chatter. */
let lastHoverAt = 0;

export function playUiHover() {
  const now = Date.now();
  if (now - lastHoverAt < 90) return;
  lastHoverAt = now;

  const ctx = getSharedAudioContext();
  if (!ctx) return;
  tone(ctx, 1500, 0.025, HOVER_VOLUME);
}
