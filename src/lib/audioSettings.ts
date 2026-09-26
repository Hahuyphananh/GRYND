"use client";

// audioSettings.ts — global game-audio mute store.
//
// Single source of truth for the player's sound preference. Every audio
// library in the app (gameAudio, hexAudio, oddsAudio, dotsAndBoxesAudio,
// precisionAudio) gates its shared AudioContext through
// `isAudioMuted()`, so flipping this flag silences every game at once.
//
// The preference is stored in localStorage and treated as a DEVICE
// preference (like theme / language / cookie consent) — it is not a
// login indicator, so the logout session-cleanup deliberately leaves it
// alone.

const STORAGE_KEY = "grynd_audio_muted";

let muted: boolean | null = null; // null = not yet initialized from storage
const listeners = new Set<() => void>();

function readStorage(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function notify() {
  for (const fn of [...listeners]) fn();
}

/** True when game audio is currently muted. */
export function isAudioMuted(): boolean {
  if (muted === null) muted = readStorage();
  return muted;
}

/** Set the global mute state (persisted to localStorage). */
export function setAudioMuted(value: boolean): void {
  muted = value;
  try {
    if (value) window.localStorage.setItem(STORAGE_KEY, "1");
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // storage unavailable — keep the in-memory state
  }
  notify();
}

/** Flip the global mute state and return the new value. */
export function toggleAudioMuted(): boolean {
  const next = !isAudioMuted();
  setAudioMuted(next);
  return next;
}

/** Subscribe to mute changes; returns an unsubscribe function. */
export function subscribeAudioMuted(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

// Keep multiple open tabs in sync — localStorage fires `storage` on every
// tab except the one that changed.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key !== STORAGE_KEY) return;
    muted = e.newValue === "1";
    notify();
  });
}
