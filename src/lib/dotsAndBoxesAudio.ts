"use client";

// ── Dots & Boxes: turn-timer audio cues ────────────────────────────────
//
// Mirrors the project's established per-game audio convention
// (precisionAudio.ts, gameAudio.ts, pokerAudio.ts, hexAudio.ts): one
// lazy-initialised singleton AudioContext per page, Web Audio API only,
// no asset loading. Exports two thin helpers:
//   - playTimerUrgent() — three-second "almost up" beep. Fired once
//     per turn by the match page when remainingSeconds first drops to
//     3, only on the local player's turn.
//   - playTimerExpired() — distinct tone (lower pitch, slightly longer)
//     played when the deadline passes. Currently unused but exported
//     so the match view can fire it if the auto-move engine fails to
//     settle a turn cleanly after the deadline.
//
// All calls are no-ops when the AudioContext is unavailable (SSR,
// privacy mode, audio blocked) so the rest of the UI behaves
// identically regardless of audio support.

// ── Singleton AudioContext (lazy, shared across page) ──────────────────

let _ctx: AudioContext | null = null;
function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!_ctx) {
    try {
      _ctx = new (window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext)();
    } catch {
      return null;
    }
  }
  // Browsers gate audio until a user gesture has fired. The shared
  // click/keydown handler at the bottom of this file nudges it live.
  if (_ctx.state === "suspended") _ctx.resume();
  return _ctx;
}

// ── Tone primitive ─────────────────────────────────────────────────────

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
  osc.connect(gain).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + duration);
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Three-second "almost up" alert. A short, mid-pitch square-wave beep
 * (~580 Hz, ~280 ms) — punchy enough to cut through a quiet room, soft
 * enough not to startle. Plays once per turn; the caller is
 * responsible for dedupe (the match page uses a `useRef` keyed on
 * `moveDeadlineAt`).
 */
export function playTimerUrgent() {
  // Two stacked tones (square + a low triangle) keep the cue from
  // sounding too "buzzy" while still feeling distinct from the
  // existing in-game action sound effects.
  playTone(580, 0.18, "square", 0.07, 0);
  playTone(290, 0.28, "triangle", 0.05, 0);
}

/**
 * Deadline-expired tone. Lower pitch and slightly longer than the
 * urgent cue so the two are immediately distinguishable. Triggered
 * when remainingMs goes ≤ 0 while the game is still in progress.
 */
export function playTimerExpired() {
  playTone(220, 0.45, "sawtooth", 0.06, 0);
  playTone(165, 0.6, "triangle", 0.04, 0.05);
}

// ── Resume AudioContext on first user interaction ──────────────────────
//
// Match the precisionAudio / gameAudio / pokerAudio / hexAudio pattern:
// Browsers block AudioContext until the user has interacted with the
// page. Register click + keydown once at module load so the first
// gesture unlocks audio for the rest of the session.

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
