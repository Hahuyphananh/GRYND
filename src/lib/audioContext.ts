"use client";

// src/lib/audioContext.ts
//
// Shared, page-wide Web Audio context for the casino games.
//
// Every game audio module (gameAudio, hexAudio, oddsAudio, precisionAudio,
// dotsAndBoxesAudio, fourInARowAudio, pokerAudio — plus the inline context in
// keno-pvp) routes its sounds through this ONE context and connects them to
// the shared output node.
//
//   source ──► [master gain] ──► speakers
//
// The global mute gate (audioSettings.isAudioMuted) still silences every
// game at once — when muted, getSharedAudioContext() returns null, so no
// context exists and nothing plays.

import { isAudioMuted } from "./audioSettings";

let _ctx: AudioContext | null = null;
let _master: GainNode | null = null;

/** The page-wide AudioContext every game sound routes through. Returns
 *  null when the global mute gate is on (muted sessions stay silent
 *  everywhere). */
export function getSharedAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  // Global mute gate — silences every game's sounds at once.
  if (isAudioMuted()) return null;
  if (!_ctx) {
    try {
      _ctx = new (window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext)();
    } catch {
      return null;
    }
  }
  if (_ctx.state === "suspended") _ctx.resume();
  return _ctx;
}

/** The master output node for the shared context. Every game sound
 *  connects here. Returns null when audio is unavailable/muted. */
export function getSharedOutputNode(): GainNode | null {
  const ctx = getSharedAudioContext();
  if (!ctx) return null;
  if (!_master) {
    try {
      _master = ctx.createGain();
      _master.connect(ctx.destination);
    } catch {
      _master = null;
      return null;
    }
  }
  return _master;
}

// Resume the shared context on the first user gesture (browsers block
// audio until then). Mirrors the per-game audio modules' pattern.
if (typeof window !== "undefined") {
  const resume = () => {
    const ctx = getSharedAudioContext();
    if (ctx && ctx.state === "suspended") ctx.resume();
    window.removeEventListener("click", resume);
    window.removeEventListener("keydown", resume);
  };
  window.addEventListener("click", resume);
  window.addEventListener("keydown", resume);
}
