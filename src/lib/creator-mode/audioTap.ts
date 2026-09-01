"use client";

// src/lib/creator-mode/audioTap.ts
//
// Shared, page-wide Web Audio context + capture tap for Creator Mode.
//
// Every game audio module (gameAudio, hexAudio, oddsAudio, precisionAudio,
// dotsAndBoxesAudio, pokerAudio — plus the inline contexts in keno-pvp and
// four-in-a-row) routes its sounds through this ONE context and connects
// them to the shared output node. The recorder then adds the output node's
// MediaStream track to the recording, so the downloaded video carries the
// game's actual sound effects with zero permission prompts and no
// per-game recording code.
//
//   source ──► [master gain] ──► speakers (still audible)
//                     └───────► [tap] ──► recording stream (captured)
//
// (A MediaStreamAudioDestinationNode has NO outputs, so it can't be
// connected onward to the speakers — instead a plain GainNode is the
// "master out" games connect to, and it feeds both the speakers and the
// tap's input.)
//
// The global mute gate (audioSettings.isAudioMuted) still silences every
// game at once — when muted, getSharedAudioContext() returns null, so no
// context exists and the recording simply has no audio track.

import { isAudioMuted } from "../audioSettings";

let _ctx: AudioContext | null = null;
let _master: GainNode | null = null;
let _tap: MediaStreamAudioDestinationNode | null = null;

/** The page-wide AudioContext every game sound routes through. Returns
 *  null when the global mute gate is on (muted sessions stay silent
 *  everywhere, recordings included). */
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
 *  connects here. It feeds the speakers (players keep hearing the game)
 *  and the recording tap in parallel, so capture never changes what's
 *  audible. Returns null when audio is unavailable/muted. */
export function getSharedOutputNode(): GainNode | null {
  const ctx = getSharedAudioContext();
  if (!ctx) return null;
  if (!_master) {
    try {
      _master = ctx.createGain();
      _master.connect(ctx.destination); // speakers
      _tap = ctx.createMediaStreamDestination();
      _master.connect(_tap); // recording
    } catch {
      _master = null;
      _tap = null;
      return null;
    }
  }
  return _master;
}

/** The audio MediaStream to add to a recording. Contains one track that
 *  carries everything routed through the shared context (all game SFX).
 *  The track is page-wide and shared — consumers must never stop it. */
export function getAudioTapStream(): MediaStream | null {
  if (!getSharedOutputNode()) return null;
  return _tap ? _tap.stream : null;
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
